/**
 * Cifra Trevo -- camada criptográfica AUTORAL do projeto (contribuição
 * original do TCC). Opera sobre bytes, não sobre letras: qualquer texto é
 * convertido para UTF-8 antes, então acentos, "ç", maiúsculas e números
 * passam sem perda.
 *
 * O nome vem das três "folhas" do trevo, três etapas controladas pela mesma
 * chave de 32 bytes:
 *
 *   1. Substituição -- a chave embaralha os 256 valores possíveis de um byte
 *      numa tabela (S-box); cada byte é trocado pelo seu par na tabela.
 *      Princípio de CONFUSÃO de Shannon: esconde a relação entre texto e
 *      chave.
 *   2. Deslocamento por posição -- cada byte é somado (módulo 256) ao byte
 *      da chave correspondente à sua posição, como uma Vigenère aplicada a
 *      bytes. O mesmo caractere passa a sair diferente em posições
 *      diferentes, o que achata a frequência dos bytes.
 *   3. Transposição -- os bytes são escritos numa grade, linha por linha, e
 *      lidos coluna por coluna, numa ordem de colunas definida pela chave.
 *      Princípio de DIFUSÃO de Shannon: espalha os bytes pela saída.
 *
 * Para decifrar, as três folhas são desfeitas na ordem inversa (3 → 2 → 1).
 *
 * LIMITAÇÕES CONHECIDAS (analisadas no TCC, e o motivo de o AES-256-GCM
 * continuar por fora desta camada -- ver lib/field-encryption.ts):
 *   - É determinística: o mesmo texto com a mesma chave sempre gera a mesma
 *     saída (não há IV/nonce).
 *   - A folha 2 repete a chave a cada 32 bytes; textos longos permitem
 *     ataques clássicos contra Vigenère (ex.: método de Kasiski).
 *   - Não tem autenticação: uma alteração no texto cifrado não é detectada.
 *   - Não passou por criptoanálise independente -- nunca deve ser usada
 *     sozinha para proteger dados reais.
 */

export const TREVO_KEY_LENGTH = 32;

const BYTE_VALUES = 256;
const MIN_COLUMNS = 3;
const COLUMN_RANGE = 5; // número de colunas da transposição: 3 a 7

function assertKey(key: Uint8Array): void {
  if (key.length !== TREVO_KEY_LENGTH) {
    throw new Error(
      `A chave da Cifra Trevo precisa ter ${TREVO_KEY_LENGTH} bytes (recebeu ${key.length}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Folha 1 -- substituição
// ---------------------------------------------------------------------------

/**
 * Gera a S-box (tabela de substituição) a partir da chave: começa com a
 * identidade [0, 1, ..., 255] e embaralha com o algoritmo de Fisher-Yates,
 * usando os bytes da chave no lugar de números aleatórios. Como a mesma
 * chave sempre produz o mesmo embaralhamento, quem tem a chave consegue
 * reconstruir a tabela para decifrar.
 */
export function buildSubstitutionBox(key: Uint8Array): Uint8Array {
  assertKey(key);

  const box = new Uint8Array(BYTE_VALUES);
  for (let value = 0; value < BYTE_VALUES; value++) {
    box[value] = value;
  }

  // `mix` acumula os bytes da chave já usados, para que cada troca dependa
  // de toda a chave lida até aqui, e não só de um byte isolado.
  let mix = 0;
  for (let i = BYTE_VALUES - 1; i > 0; i--) {
    mix = (mix + key[i % TREVO_KEY_LENGTH] + box[i]) % BYTE_VALUES;
    const j = mix % (i + 1);
    const swap = box[i];
    box[i] = box[j];
    box[j] = swap;
  }

  return box;
}

/** Tabela inversa: se box[x] = y, então inverse[y] = x. */
export function invertSubstitutionBox(box: Uint8Array): Uint8Array {
  const inverse = new Uint8Array(BYTE_VALUES);
  for (let value = 0; value < BYTE_VALUES; value++) {
    inverse[box[value]] = value;
  }
  return inverse;
}

export function substitute(data: Uint8Array, box: Uint8Array): Uint8Array {
  return data.map((byte) => box[byte]);
}

// ---------------------------------------------------------------------------
// Folha 2 -- deslocamento por posição
// ---------------------------------------------------------------------------

export function shiftByPosition(data: Uint8Array, key: Uint8Array): Uint8Array {
  return data.map((byte, i) => (byte + key[i % TREVO_KEY_LENGTH]) % BYTE_VALUES);
}

export function unshiftByPosition(data: Uint8Array, key: Uint8Array): Uint8Array {
  // "+ BYTE_VALUES" evita resultado negativo antes do módulo.
  return data.map(
    (byte, i) => (byte - key[i % TREVO_KEY_LENGTH] + BYTE_VALUES) % BYTE_VALUES
  );
}

// ---------------------------------------------------------------------------
// Folha 3 -- transposição por colunas
// ---------------------------------------------------------------------------

/**
 * Quantidade de colunas (3 a 7) e a ordem em que são lidas, ambas vindas da
 * chave. A ordem ordena os índices das colunas pelo byte de chave associado
 * a cada uma (desempate pelo próprio índice, para a ordem ser sempre a
 * mesma).
 */
export function buildColumnOrder(key: Uint8Array): number[] {
  assertKey(key);

  const columns = MIN_COLUMNS + (key[0] % COLUMN_RANGE);
  const indices = Array.from({ length: columns }, (_, i) => i);

  return indices.sort((a, b) => key[1 + a] - key[1 + b] || a - b);
}

/**
 * Tamanho de cada coluna da grade. Com `length` bytes em `columns` colunas,
 * a última linha pode ficar incompleta: as primeiras `length % columns`
 * colunas têm uma linha a mais que as demais.
 */
function columnLengths(length: number, columns: number): number[] {
  const fullRows = Math.floor(length / columns);
  const remainder = length % columns;
  return Array.from({ length: columns }, (_, column) =>
    fullRows + (column < remainder ? 1 : 0)
  );
}

export function transpose(data: Uint8Array, order: number[]): Uint8Array {
  const columns = order.length;
  const output = new Uint8Array(data.length);
  let out = 0;

  // Lê a grade coluna por coluna, na ordem da chave. O byte na linha `row`,
  // coluna `column` está na posição row * columns + column do texto.
  for (const column of order) {
    for (let index = column; index < data.length; index += columns) {
      output[out++] = data[index];
    }
  }

  return output;
}

export function untranspose(data: Uint8Array, order: number[]): Uint8Array {
  const columns = order.length;
  const lengths = columnLengths(data.length, columns);
  const output = new Uint8Array(data.length);
  let read = 0;

  // Refaz o caminho inverso: cada trecho do texto cifrado é uma coluna
  // inteira (na ordem da chave), que volta para as suas posições na grade.
  for (const column of order) {
    for (let row = 0; row < lengths[column]; row++) {
      output[row * columns + column] = data[read++];
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Cifra completa
// ---------------------------------------------------------------------------

export function trevoEncrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const box = buildSubstitutionBox(key);
  const order = buildColumnOrder(key);

  const leaf1 = substitute(plaintext, box);
  const leaf2 = shiftByPosition(leaf1, key);
  return transpose(leaf2, order);
}

export function trevoDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const inverseBox = invertSubstitutionBox(buildSubstitutionBox(key));
  const order = buildColumnOrder(key);

  const leaf2 = untranspose(ciphertext, order);
  const leaf1 = unshiftByPosition(leaf2, key);
  return substitute(leaf1, inverseBox);
}

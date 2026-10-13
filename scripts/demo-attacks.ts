import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { aesGcmDecrypt, aesGcmEncrypt } from "@/lib/aes-gcm";
import { decryptField, encryptField } from "@/lib/field-encryption";
import {
  buildColumnOrder,
  buildSubstitutionBox,
  substitute,
  transpose,
  trevoDecrypt,
  trevoEncrypt,
} from "@/lib/trevo-cipher";
import {
  REFERENCE_TEXT,
  TARGET_TEXT,
  accuracy,
  bruteForceTransposition,
  byteCounts,
  frequencyAttackMap,
  frequencyRanking,
  indexOfCoincidence,
  utf8,
} from "@/scripts/cryptanalysis";

// Demonstrações de ataque contra as duas camadas de criptografia, com saída
// organizada para virar figura no capítulo de Resultados do TCC.
//
// Roda só em memória, sem banco de dados, com uma chave mestra aleatória
// gerada a cada execução (nunca a chave real do .env). Por isso os textos
// cifrados mudam de uma execução para outra, mas as conclusões não.
//
//   npm run demo:attacks
process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const LINE = "=".repeat(78);
const percent = (value: number) => `${(value * 100).toFixed(1).replace(".", ",")}%`;
const decimal = (value: number) => value.toFixed(4).replace(".", ",");

function section(title: string) {
  console.log(`\n${LINE}\n${title}\n${LINE}`);
}

function preview(bytes: Uint8Array, length = 70): string {
  // Bytes que não formam texto válido aparecem como "·", para o print
  // mostrar a diferença entre texto legível e lixo sem quebrar o terminal.
  return Buffer.from(bytes)
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, "·")
    .slice(0, length);
}

function errorMessage(action: () => unknown): string {
  try {
    action();
    return "nenhum erro (inesperado)";
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Ferramentas de criptoanálise
// ---------------------------------------------------------------------------

function topFrequencies(data: Uint8Array, count: number): string {
  const counts = byteCounts(data);
  return frequencyRanking(data)
    .slice(0, count)
    .map((byte) => percent(counts[byte] / data.length))
    .join("  ");
}

// ---------------------------------------------------------------------------
// Demonstrações
// ---------------------------------------------------------------------------

function demoWhatTheDatabaseSees() {
  section("1. O QUE FICA GRAVADO NO BANCO DE DADOS");

  const owner = "usuario-demo-1";
  const phone = "62991112233";
  const address = "Rua dos Girassóis, 15 - Residencial Buena Vista";

  console.log(`Telefone digitado:     ${phone}`);
  console.log(`Gravado no banco:      ${encryptField(phone, "familyProfile.phone", owner)}`);
  console.log(`Mesmo telefone de novo: ${encryptField(phone, "familyProfile.phone", owner)}`);
  console.log("  → o IV aleatório faz o mesmo valor gerar textos cifrados diferentes.\n");
  console.log(`Endereço digitado:     ${address}`);
  console.log(`Gravado no banco:      ${encryptField(address, "familyProfile.address", owner)}`);
}

function demoFrequencyAttack() {
  section("2. ANÁLISE DE FREQUÊNCIA CONTRA A CIFRA TREVO (camada 1, sem o AES)");
  console.log(
    "Cenário: o atacante obteve o texto da camada 1 (por exemplo, roubando a chave\n" +
      "do AES), mas não a chave K1 da Cifra Trevo. Ele conhece só a frequência típica\n" +
      "de cada byte em português, tirada de um texto qualquer, sem relação com o alvo.\n"
  );

  const key = randomBytes(32);
  const box = buildSubstitutionBox(key);
  const order = buildColumnOrder(key);
  const plaintext = utf8(TARGET_TEXT);
  const reference = utf8(REFERENCE_TEXT);

  const variants = [
    { name: "Só folha 1 (substituição)", ciphertext: substitute(plaintext, box), transposed: false },
    {
      name: "Folhas 1 + 3 (substituição + transposição)",
      ciphertext: transpose(substitute(plaintext, box), order),
      transposed: true,
    },
    { name: "Cifra Trevo completa (folhas 1 + 2 + 3)", ciphertext: trevoEncrypt(plaintext, key), transposed: true },
  ];

  console.log("Distribuição de frequência (5 bytes mais comuns) e índice de coincidência:\n");
  console.log(`${"".padEnd(44)}${"5 mais frequentes".padEnd(40)}Índice`);
  console.log(
    `${"Texto original".padEnd(44)}${topFrequencies(plaintext, 5).padEnd(40)}${decimal(indexOfCoincidence(plaintext))}`
  );
  for (const { name, ciphertext } of variants) {
    console.log(
      `${name.padEnd(44)}${topFrequencies(ciphertext, 5).padEnd(40)}${decimal(indexOfCoincidence(ciphertext))}`
    );
  }
  console.log(`${"Bytes perfeitamente embaralhados".padEnd(84)}${decimal(1 / 256)}`);
  console.log(
    "\n  → substituição e transposição não mudam a distribuição de frequência, só trocam\n" +
      "    os rótulos e as posições. A folha 2 achata a distribuição.\n"
  );

  console.log("Resultado do ataque (frequência + teste de todas as ordens de colunas):\n");
  for (const { name, ciphertext, transposed } of variants) {
    const guess = frequencyAttackMap(ciphertext, reference);
    const attack = transposed
      ? bruteForceTransposition(ciphertext, guess)
      : { candidate: substitute(ciphertext, guess), tried: 0 };

    console.log(`${name}`);
    if (transposed) {
      console.log(`  ordens de colunas testadas: ${attack.tried.toLocaleString("pt-BR")}`);
    }
    console.log(`  bytes recuperados corretamente: ${percent(accuracy(attack.candidate, plaintext))}`);
    console.log(`  texto obtido pelo atacante: "${preview(attack.candidate)}"\n`);
  }

  console.log(`Texto original:              "${TARGET_TEXT.slice(0, 70)}"`);
  console.log(
    "\n  → sem a folha 2, a cifra cai para análise de frequência. Com ela, o mesmo\n" +
      "    ataque não funciona. Limitação conhecida: a chave da folha 2 se repete a\n" +
      "    cada 32 bytes, então com textos muito maiores o atacante pode separar os\n" +
      "    bytes por posição (método de Kasiski) e repetir o ataque em cada grupo."
  );
}

function demoDeterminism() {
  section("3. DETERMINISMO: A CIFRA TREVO SOZINHA REVELA VALORES REPETIDOS");

  const key = randomBytes(32);
  const phone = "62991112233";
  const trevoA = Buffer.from(trevoEncrypt(utf8(phone), key)).toString("hex");
  const trevoB = Buffer.from(trevoEncrypt(utf8(phone), key)).toString("hex");

  console.log("Dois usuários diferentes com o mesmo telefone:\n");
  console.log(`Só Cifra Trevo, usuário A: ${trevoA}`);
  console.log(`Só Cifra Trevo, usuário B: ${trevoB}`);
  console.log(`  → iguais? ${trevoA === trevoB ? "SIM: quem lê o banco descobre que os dois têm o mesmo telefone" : "não"}\n`);

  const fullA = encryptField(phone, "familyProfile.phone", "usuario-A");
  const fullB = encryptField(phone, "familyProfile.phone", "usuario-B");
  console.log(`Duas camadas, usuário A:   ${fullA}`);
  console.log(`Duas camadas, usuário B:   ${fullB}`);
  console.log(`  → iguais? ${fullA === fullB ? "sim" : "NÃO: o AES-256-GCM, com IV aleatório, esconde a repetição"}`);
}

function demoTampering() {
  section("4. ADULTERAÇÃO DO DADO CIFRADO NO BANCO (tag do AES-256-GCM)");

  const owner = "usuario-demo-1";
  const stored = encryptField("62991112233", "familyProfile.phone", owner);
  const [version, iv, ciphertext, tag] = stored.split(":");
  const bytes = Buffer.from(ciphertext, "base64url");
  bytes[0] ^= 0x01; // troca um único bit
  const tampered = [version, iv, bytes.toString("base64url"), tag].join(":");

  console.log(`Valor original no banco: ${stored}`);
  console.log(`Valor adulterado (1 bit): ${tampered}\n`);
  console.log(`Decifrando o original:   ${decryptField(stored, "familyProfile.phone", owner)}`);
  console.log(
    `Decifrando o adulterado: ERRO → "${errorMessage(() => decryptField(tampered, "familyProfile.phone", owner))}"`
  );
  console.log("  → a alteração é detectada; o sistema nunca exibe um dado corrompido.");
}

function demoSwapBetweenUsers() {
  section("5. CÓPIA DO DADO CIFRADO PARA OUTRO USUÁRIO OU CAMPO (AAD)");

  const stored = encryptField("62991112233", "familyProfile.phone", "usuario-A");

  console.log("Telefone cifrado do usuário A, copiado no banco para outros lugares:\n");
  console.log(`Lido como telefone do usuário A: ${decryptField(stored, "familyProfile.phone", "usuario-A")}`);
  console.log(
    `Lido como telefone do usuário B: ERRO → "${errorMessage(() => decryptField(stored, "familyProfile.phone", "usuario-B"))}"`
  );
  console.log(
    `Lido como endereço do usuário A: ERRO → "${errorMessage(() => decryptField(stored, "familyProfile.address", "usuario-A"))}"`
  );
  console.log("  → cada valor só decifra no campo e no usuário de onde veio.");
}

function demoWrongKey() {
  section("6. TENTATIVA DE DECIFRAR SEM A CHAVE CORRETA");

  const phone = "62991112233";
  const realKey = randomBytes(32);
  const wrongKey = randomBytes(32);
  const aad = utf8("trevo:familyProfile.phone:usuario-A");

  const layer1 = trevoEncrypt(utf8(phone), realKey);
  const payload = aesGcmEncrypt(layer1, realKey, aad);

  console.log("Camada 2 (AES-256-GCM) com a chave errada:");
  console.log(`  ERRO → "${errorMessage(() => aesGcmDecrypt(payload, wrongKey, aad))}"\n`);
  console.log("Camada 1 (Cifra Trevo) com a chave errada:");
  console.log(`  resultado: "${preview(trevoDecrypt(layer1, wrongKey))}" (lixo, não o telefone)`);
  console.log(`Camada 1 com a chave certa:  "${preview(trevoDecrypt(layer1, realKey))}"`);
}

function demoPerformance() {
  section("7. DESEMPENHO");

  const iterations = 5_000;
  const phone = "62991112233";
  const address = "Rua dos Girassóis, 15 - Residencial Buena Vista";
  const key = randomBytes(32);
  const aad = utf8("trevo:familyProfile.phone:usuario-A");

  const measure = (action: () => void) => {
    for (let i = 0; i < 200; i++) action(); // aquecimento
    const start = performance.now();
    for (let i = 0; i < iterations; i++) action();
    return ((performance.now() - start) * 1000) / iterations; // microssegundos
  };

  const rows = [
    { name: "Cifra Trevo (cifrar + decifrar)", value: phone, run: (v: string) => trevoDecrypt(trevoEncrypt(utf8(v), key), key) },
    {
      name: "AES-256-GCM (cifrar + decifrar)",
      value: phone,
      run: (v: string) => aesGcmDecrypt(aesGcmEncrypt(utf8(v), key, aad), key, aad),
    },
    {
      name: "Duas camadas, telefone",
      value: phone,
      run: (v: string) => decryptField(encryptField(v, "familyProfile.phone", "u"), "familyProfile.phone", "u"),
    },
    {
      name: "Duas camadas, endereço",
      value: address,
      run: (v: string) => decryptField(encryptField(v, "familyProfile.address", "u"), "familyProfile.address", "u"),
    },
  ];

  console.log(`Média de ${iterations.toLocaleString("pt-BR")} repetições de cada operação:\n`);
  console.log(`${"Operação".padEnd(36)}${"Tempo médio".padEnd(18)}Operações por segundo`);
  for (const { name, value, run } of rows) {
    const micros = measure(() => run(value));
    console.log(
      `${name.padEnd(36)}${`${micros.toFixed(1).replace(".", ",")} µs`.padEnd(18)}${Math.round(1_000_000 / micros).toLocaleString("pt-BR")}`
    );
  }
  console.log("\n  → 1 µs = 0,001 ms. O custo da criptografia é desprezível perto de uma consulta ao banco.");
}

console.log("DEMONSTRAÇÕES DE ATAQUE -- CRIPTOGRAFIA EM DUAS CAMADAS DO TREVO");
console.log("(chaves aleatórias geradas nesta execução; nenhum dado real é usado)");

demoWhatTheDatabaseSees();
demoFrequencyAttack();
demoDeterminism();
demoTampering();
demoSwapBetweenUsers();
demoWrongKey();
demoPerformance();
console.log("");

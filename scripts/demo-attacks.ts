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
  untranspose,
} from "@/lib/trevo-cipher";

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
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const percent = (value: number) => `${(value * 100).toFixed(1).replace(".", ",")}%`;
const decimal = (value: number) => value.toFixed(4).replace(".", ",");

function section(title: string) {
  console.log(`\n${LINE}\n${title}\n${LINE}`);
}

function preview(bytes: Uint8Array, length = 110): string {
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
// Textos usados no ataque de frequência
// ---------------------------------------------------------------------------

// O alvo: um texto parecido com o que uma família escreveria no perfil.
const TARGET_TEXT =
  "Minha mãe tem oitenta e dois anos e mora conosco desde o ano passado. Ela tem " +
  "diabetes e pressão alta, toma remédios três vezes ao dia e precisa de ajuda " +
  "para tomar banho e para se vestir. Durante a semana nós trabalhamos fora, então " +
  "procuramos uma pessoa de confiança que fique com ela de segunda a sexta, das " +
  "oito da manhã até as seis da tarde. É importante que a cuidadora tenha paciência, " +
  "porque a minha mãe às vezes fica confusa e repete as mesmas perguntas. Ela gosta " +
  "de conversar, de ouvir música antiga e de caminhar um pouco no quintal depois do " +
  "almoço. A pessoa também precisa controlar os horários dos remédios, preparar " +
  "refeições leves e com pouco sal, e avisar a família se notar qualquer mudança no " +
  "humor ou na saúde dela. Já tivemos uma experiência ruim com uma cuidadora que " +
  "faltava muito, por isso queremos alguém pontual e que tenha referências de outros " +
  "trabalhos. Moramos perto do centro, a casa é tranquila e tem um quarto separado " +
  "para descanso. Podemos conversar sobre o valor da hora e sobre os detalhes da " +
  "rotina antes de começar. O mais importante para nós é que a minha mãe se sinta " +
  "segura, respeitada e bem cuidada enquanto estamos no trabalho.";

// O "conhecimento do atacante": um texto qualquer em português, sem relação
// com o alvo, de onde ele tira a frequência típica de cada byte na língua.
const REFERENCE_TEXT =
  "A cidade amanheceu com chuva fina e o trânsito ficou lento desde cedo. Nas " +
  "padarias do bairro, as pessoas comentavam a previsão do tempo para o fim de " +
  "semana e a festa da escola, que estava marcada para o sábado à tarde. Os " +
  "professores passaram a semana preparando as apresentações dos alunos, com " +
  "músicas, danças e uma pequena peça de teatro sobre a história da cidade. No " +
  "mercado, os preços das frutas subiram um pouco por causa da chuva, mas o " +
  "movimento continuou grande, porque muita gente aproveita a manhã para fazer as " +
  "compras da semana. Na praça, um grupo de idosos se reúne todos os dias para " +
  "jogar dominó e conversar sobre futebol, política e os acontecimentos do bairro. " +
  "Eles dizem que a praça mudou muito nos últimos anos, que antes havia mais " +
  "árvores e menos carros, e que as crianças brincavam na rua até a noite. Alguns " +
  "moradores pediram à prefeitura que instale mais bancos e uma cobertura para os " +
  "dias de sol forte. A resposta ainda não veio, mas eles continuam se encontrando " +
  "ali, com chuva ou com sol, porque a conversa da manhã já faz parte da rotina de " +
  "todos e ninguém quer abrir mão desse costume tão antigo.";

// ---------------------------------------------------------------------------
// Ferramentas de criptoanálise
// ---------------------------------------------------------------------------

function byteCounts(data: Uint8Array): number[] {
  const counts = new Array<number>(256).fill(0);
  for (const byte of data) counts[byte]++;
  return counts;
}

/** Bytes ordenados do mais para o menos frequente. */
function frequencyRanking(data: Uint8Array): number[] {
  const counts = byteCounts(data);
  return counts
    .map((count, byte) => ({ byte, count }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || a.byte - b.byte)
    .map(({ byte }) => byte);
}

/**
 * Índice de coincidência (Friedman): probabilidade de dois bytes sorteados
 * do texto serem iguais. Texto em linguagem natural tem índice alto, porque
 * poucos símbolos se repetem muito; um texto bem embaralhado tende a
 * 1/256 ≈ 0,0039.
 */
function indexOfCoincidence(data: Uint8Array): number {
  const n = data.length;
  const sum = byteCounts(data).reduce((total, count) => total + count * (count - 1), 0);
  return sum / (n * (n - 1));
}

function topFrequencies(data: Uint8Array, count: number): string {
  const counts = byteCounts(data);
  return frequencyRanking(data)
    .slice(0, count)
    .map((byte) => percent(counts[byte] / data.length))
    .join("  ");
}

/**
 * Ataque clássico de análise de frequência contra substituição: o byte mais
 * frequente do texto cifrado é trocado pelo byte mais frequente da língua, o
 * segundo pelo segundo, e assim por diante.
 */
function frequencyAttackMap(ciphertext: Uint8Array, reference: Uint8Array): Uint8Array {
  const cipherRanking = frequencyRanking(ciphertext);
  const languageRanking = frequencyRanking(reference);
  const guess = new Uint8Array(256);
  cipherRanking.forEach((byte, rank) => {
    guess[byte] = languageRanking[rank] ?? 0x3f; // "?" quando faltar referência
  });
  return guess;
}

const COMMON_WORDS = [" de ", " que ", " e ", " o ", " a ", " do ", " da ", " para ", " com ", " se "];

/** Pontua um candidato pela quantidade de palavras comuns do português. */
function portugueseScore(candidate: Uint8Array): number {
  const text = Buffer.from(candidate).toString("latin1");
  return COMMON_WORDS.reduce((score, word) => score + text.split(word).length - 1, 0);
}

function* permutations(size: number): Generator<number[]> {
  if (size === 1) {
    yield [0];
    return;
  }
  for (const smaller of permutations(size - 1)) {
    for (let position = 0; position <= smaller.length; position++) {
      yield [...smaller.slice(0, position), size - 1, ...smaller.slice(position)];
    }
  }
}

/**
 * A folha 3 tem de 3 a 7 colunas, então existem só 3! + 4! + ... + 7! =
 * 5.910 ordens possíveis: o atacante testa todas e fica com a que gera o
 * texto com mais cara de português.
 */
function bruteForceTransposition(ciphertext: Uint8Array, guess: Uint8Array) {
  let best = { candidate: ciphertext, score: -1 };
  let tried = 0;

  for (let columns = 3; columns <= 7; columns++) {
    for (const order of permutations(columns)) {
      tried++;
      const candidate = substitute(untranspose(ciphertext, order), guess);
      const score = portugueseScore(candidate);
      if (score > best.score) {
        best = { candidate, score };
      }
    }
  }

  return { candidate: best.candidate, tried };
}

function accuracy(recovered: Uint8Array, original: Uint8Array): number {
  let hits = 0;
  for (let i = 0; i < original.length; i++) {
    if (recovered[i] === original[i]) hits++;
  }
  return hits / original.length;
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

  console.log(`Texto original:             "${TARGET_TEXT.slice(0, 110)}"`);
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

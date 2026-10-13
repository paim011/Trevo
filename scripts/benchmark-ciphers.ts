import { execSync } from "node:child_process";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { AesGcmPayload, aesGcmDecrypt, aesGcmEncrypt } from "@/lib/aes-gcm";
import { trevoDecrypt, trevoEncrypt } from "@/lib/trevo-cipher";
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

// Benchmark comparativo dos três cenários do experimento do TCC:
//
//   C1 -- Cifra Trevo sozinha
//   C2 -- AES-256-GCM sozinho
//   C3 -- combinação usada na aplicação (Trevo por dentro, GCM por fora)
//
// As hipóteses e os critérios de cada medida estão em
// docs/hipoteses-e-criterios.md, escritos antes da execução oficial. A
// numeração das seções (H1 a H9) segue esse documento.
//
// Sem banco de dados. Chaves, entradas e posições alteradas vêm de um gerador
// determinístico com semente; só os IVs do AES são aleatórios, como na
// aplicação. Os resultados vão para resultados/benchmark-<data>/ em CSV
// (separador ";" e vírgula decimal, para abrir direto no Excel em português).
//
//   npm run benchmark                     execução oficial
//   npm run benchmark -- --quick          execução rápida, só para conferir o script
//   npm run benchmark -- --seed=outra     outra semente

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const SEED = args.find((arg) => arg.startsWith("--seed="))?.slice("--seed=".length) || "trevo-tcc";

const ROUNDS = QUICK ? 5 : 30;
const TARGET_BATCH_MS = QUICK ? 1 : 10;
const TRIALS = QUICK ? 200 : 1_000;
const ATTACK_TRIALS = QUICK ? 1 : 5;
const PERFORMANCE_SIZES = [16, 64, 256, 1_024, 4_096, 16_384, 65_536];
const SIGNIFICANCE = 0.01;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ---------------------------------------------------------------------------
// Gerador determinístico
// ---------------------------------------------------------------------------

/**
 * Gera bytes a partir de SHA-256(semente:rótulo:contador). Não é usado para
 * nada secreto: só garante que, com a mesma semente, chaves e entradas do
 * experimento se repetem entre execuções.
 */
class SeededRandom {
  private pool = Buffer.alloc(0);
  private counter = 0;

  constructor(private readonly label: string) {}

  bytes(length: number): Uint8Array {
    while (this.pool.length < length) {
      const block = createHash("sha256").update(`${SEED}:${this.label}:${this.counter++}`).digest();
      this.pool = Buffer.concat([this.pool, block]);
    }
    const out = new Uint8Array(this.pool.subarray(0, length));
    this.pool = this.pool.subarray(length);
    return out;
  }

  /** Inteiro em [0, max). O viés do módulo é desprezível para max pequeno. */
  int(max: number): number {
    return Buffer.from(this.bytes(4)).readUInt32BE() % max;
  }
}

// ---------------------------------------------------------------------------
// Chaves e cenários
// ---------------------------------------------------------------------------

// Mesmos rótulos de lib/field-encryption.ts: K1 e K2 são derivadas da chave
// mestra exatamente como na aplicação.
const HKDF_SALT = "trevo-field-encryption";
const K1_INFO = "trevo-cipher-k1";
const K2_INFO = "aes-256-gcm-k2";
const AAD = utf8("trevo:benchmark:usuario-1");

type Keys = { k1: Uint8Array; k2: Uint8Array };

function deriveKeys(masterKey: Uint8Array): Keys {
  return {
    k1: new Uint8Array(hkdfSync("sha256", masterKey, HKDF_SALT, K1_INFO, 32)),
    k2: new Uint8Array(hkdfSync("sha256", masterKey, HKDF_SALT, K2_INFO, 32)),
  };
}

type ScenarioId = "C1" | "C2" | "C3";

type Scenario = {
  id: ScenarioId;
  name: string;
  /** Saída como seria armazenada: para C2 e C3, IV + texto cifrado + tag. */
  encrypt: (plaintext: Uint8Array) => Uint8Array;
  /** Lança erro quando a camada detecta problema (só C2 e C3 detectam). */
  decrypt: (stored: Uint8Array) => Uint8Array;
};

function serialize({ iv, ciphertext, tag }: AesGcmPayload): Uint8Array {
  return new Uint8Array(Buffer.concat([iv, ciphertext, tag]));
}

function parse(stored: Uint8Array): AesGcmPayload {
  if (stored.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Valor cifrado curto demais.");
  }
  const bytes = Buffer.from(stored);
  return {
    iv: bytes.subarray(0, IV_LENGTH),
    ciphertext: bytes.subarray(IV_LENGTH, bytes.length - TAG_LENGTH),
    tag: bytes.subarray(bytes.length - TAG_LENGTH),
  };
}

function buildScenarios({ k1, k2 }: Keys): Scenario[] {
  return [
    {
      id: "C1",
      name: "Cifra Trevo sozinha",
      encrypt: (p) => trevoEncrypt(p, k1),
      decrypt: (c) => trevoDecrypt(c, k1),
    },
    {
      id: "C2",
      name: "AES-256-GCM sozinho",
      encrypt: (p) => serialize(aesGcmEncrypt(p, k2, AAD)),
      decrypt: (c) => new Uint8Array(aesGcmDecrypt(parse(c), k2, AAD)),
    },
    {
      id: "C3",
      name: "Combinação (Trevo + GCM)",
      encrypt: (p) => serialize(aesGcmEncrypt(trevoEncrypt(p, k1), k2, AAD)),
      decrypt: (c) => trevoDecrypt(new Uint8Array(aesGcmDecrypt(parse(c), k2, AAD)), k1),
    },
  ];
}

/**
 * GCM com IV escolhido pelo chamador. Usado SÓ na medida de difusão (H8),
 * para comparar duas cifrações sem o IV aleatório mascarar o efeito. Na
 * aplicação o IV nunca é fixo nem repetido.
 */
function gcmWithFixedIv(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { body: new Uint8Array(body), tag: new Uint8Array(cipher.getAuthTag()) };
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function flipBit(data: Uint8Array, bit: number): Uint8Array {
  const copy = new Uint8Array(data);
  copy[bit >> 3] ^= 1 << (bit & 7);
  return copy;
}

function differingBits(a: Uint8Array, b: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

function differingBytes(a: Uint8Array, b: Uint8Array): number {
  let count = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) count++;
  }
  return count;
}

type Outcome = "erro" | "saida_incorreta" | "saida_correta";

function tryDecrypt(scenario: Scenario, stored: Uint8Array, expected: Uint8Array): Outcome {
  try {
    return equalBytes(scenario.decrypt(stored), expected) ? "saida_correta" : "saida_incorreta";
  } catch {
    return "erro";
  }
}

// ---------------------------------------------------------------------------
// Estatística
// ---------------------------------------------------------------------------

type Summary = { mean: number; sd: number; median: number; min: number; max: number; ci95: number };

/** Quantil 97,5% da distribuição t de Student (expansão de Cornish-Fisher). */
function tQuantile975(df: number): number {
  const z = 1.959964;
  return (
    z +
    (z ** 3 + z) / (4 * df) +
    (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) +
    (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3)
  );
}

function summarize(samples: number[]): Summary {
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((total, value) => total + value, 0) / n;
  const sd = n > 1 ? Math.sqrt(samples.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)) : 0;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const ci95 = n > 1 ? (tQuantile975(n - 1) * sd) / Math.sqrt(n) : 0;
  return { mean, sd, median, min: sorted[0], max: sorted[n - 1], ci95 };
}

/** Entropia de Shannon em bits por byte (máximo 8). */
function shannonEntropy(data: Uint8Array): number {
  return byteCounts(data).reduce((total, count) => {
    if (!count) return total;
    const p = count / data.length;
    return total - p * Math.log2(p);
  }, 0);
}

/** Função erro (Abramowitz e Stegun 7.1.26, erro máximo de 1,5e-7). */
function erf(x: number): number {
  const sign = Math.sign(x);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/**
 * Qui-quadrado de uniformidade dos 256 valores de byte, com p-valor pela
 * aproximação de Wilson-Hilferty (precisa para 255 graus de liberdade).
 */
function chiSquareUniformity(data: Uint8Array) {
  const expected = data.length / 256;
  const statistic = byteCounts(data).reduce((total, count) => total + (count - expected) ** 2 / expected, 0);
  const k = 255;
  const z = (Math.cbrt(statistic / k) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  const pValue = 1 - 0.5 * (1 + erf(z / Math.SQRT2));
  return { statistic, pValue, expectedPerValue: expected };
}

// ---------------------------------------------------------------------------
// Saída (console + CSV)
// ---------------------------------------------------------------------------

type Row = Record<string, string | number | boolean>;

const formatCell = (value: string | number | boolean) =>
  typeof value === "number"
    ? Number.isInteger(value)
      ? String(value)
      : String(Number(value.toFixed(6))).replace(".", ",")
    : typeof value === "boolean"
      ? value
        ? "sim"
        : "nao"
      : value;

const files: Record<string, Row[]> = {};

function saveCsv(name: string, rows: Row[]) {
  files[name] = rows;
}

const LINE = "=".repeat(78);
const pct = (value: number) => `${(value * 100).toFixed(2).replace(".", ",")}%`;
const num = (value: number, digits = 2) => value.toFixed(digits).replace(".", ",");
const verdicts: string[] = [];

function section(title: string) {
  console.log(`\n${LINE}\n${title}\n${LINE}`);
}

function verdict(hypothesis: string, confirmed: boolean, detail: string) {
  const line = `${hypothesis}: ${confirmed ? "CONFIRMADA" : "REFUTADA"} -- ${detail}`;
  verdicts.push(line);
  console.log(`\n  → ${line}`);
}

function table(headers: string[], rows: (string | number)[][], widths: number[]) {
  const render = (cells: (string | number)[]) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join("");
  console.log(render(headers));
  for (const row of rows) console.log(render(row));
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

const keys = deriveKeys(new SeededRandom("chave-mestra").bytes(32));
const wrongKeys = deriveKeys(new SeededRandom("chave-mestra-errada").bytes(32));
const scenarios = buildScenarios(keys);
const wrongKeyScenarios = buildScenarios(wrongKeys);

const portugueseBytes = utf8(`${TARGET_TEXT} ${REFERENCE_TEXT}`);

function textInput(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = portugueseBytes[i % portugueseBytes.length];
  return out;
}

// ---------------------------------------------------------------------------
// H1 -- correção
// ---------------------------------------------------------------------------

function testCorrectness() {
  section("H1. CORREÇÃO (a entrada é recuperada exatamente?)");

  const sizes = [...Array.from({ length: 301 }, (_, i) => i), 1_024, 4_096, 16_384, 65_536];
  const random = new SeededRandom("h1");
  const inputTypes: { type: string; make: (length: number) => Uint8Array }[] = [
    { type: "bytes aleatorios", make: (length) => random.bytes(length) },
    { type: "texto UTF-8", make: textInput },
    { type: "bytes zerados", make: (length) => new Uint8Array(length) },
  ];

  const rows: Row[] = [];
  let totalFailures = 0;
  for (const scenario of scenarios) {
    for (const { type, make } of inputTypes) {
      let failures = 0;
      for (const size of sizes) {
        const input = make(size);
        if (tryDecrypt(scenario, scenario.encrypt(input), input) !== "saida_correta") failures++;
      }
      totalFailures += failures;
      rows.push({ cenario: scenario.id, tipo_entrada: type, tamanhos_testados: sizes.length, falhas: failures });
    }
  }

  table(
    ["Cenário", "Tipo de entrada", "Tamanhos testados", "Falhas"],
    rows.map((r) => [r.cenario as string, r.tipo_entrada as string, r.tamanhos_testados as number, r.falhas as number]),
    [10, 20, 20, 8]
  );
  saveCsv("h1-correcao", rows);
  verdict("H1", totalFailures === 0, `${totalFailures} falha(s) no total`);
}

// ---------------------------------------------------------------------------
// H2 -- desempenho
// ---------------------------------------------------------------------------

type Measured = { wall: number[]; cpu: number[]; batch: number };

function testPerformance() {
  section("H2. DESEMPENHO (microssegundos por operação)");
  console.log(
    `${ROUNDS} rodadas por medida; em cada rodada os três cenários se alternam na ordem\n` +
      `para não favorecer nenhum. Cada amostra é a média de um lote de ~${TARGET_BATCH_MS} ms.\n`
  );

  const operations = ["cifrar", "decifrar"] as const;
  const rows: Row[] = [];
  const medians = new Map<string, Summary>();

  for (const size of PERFORMANCE_SIZES) {
    const input = new SeededRandom(`h2:${size}`).bytes(size);
    const stored = new Map(scenarios.map((s) => [s.id, s.encrypt(input)]));
    const actions = new Map<string, () => void>();
    for (const scenario of scenarios) {
      const ciphertext = stored.get(scenario.id)!;
      actions.set(`${scenario.id}:cifrar`, () => scenario.encrypt(input));
      actions.set(`${scenario.id}:decifrar`, () => scenario.decrypt(ciphertext));
    }

    // Aquecimento e calibração: cada lote dura ~TARGET_BATCH_MS, para a
    // resolução do relógio não pesar em operações muito curtas.
    const measured = new Map<string, Measured>();
    for (const [key, action] of actions) {
      for (let i = 0; i < 20; i++) action();
      const start = performance.now();
      let calls = 0;
      while (performance.now() - start < TARGET_BATCH_MS) {
        action();
        calls++;
      }
      measured.set(key, { wall: [], cpu: [], batch: Math.max(1, calls) });
    }

    for (let round = 0; round < ROUNDS; round++) {
      const order = scenarios.map((_, i) => scenarios[(i + round) % scenarios.length]);
      for (const scenario of order) {
        for (const operation of operations) {
          const key = `${scenario.id}:${operation}`;
          const action = actions.get(key)!;
          const sample = measured.get(key)!;
          const cpuStart = process.cpuUsage();
          const start = performance.now();
          for (let i = 0; i < sample.batch; i++) action();
          const wallMicros = (performance.now() - start) * 1000;
          const cpu = process.cpuUsage(cpuStart);
          sample.wall.push(wallMicros / sample.batch);
          sample.cpu.push((cpu.user + cpu.system) / sample.batch);
        }
      }
    }

    for (const scenario of scenarios) {
      for (const operation of operations) {
        const sample = measured.get(`${scenario.id}:${operation}`)!;
        const wall = summarize(sample.wall);
        const cpu = summarize(sample.cpu);
        medians.set(`${scenario.id}:${operation}:${size}`, wall);
        rows.push({
          cenario: scenario.id,
          operacao: operation,
          tamanho_bytes: size,
          rodadas: ROUNDS,
          operacoes_por_lote: sample.batch,
          media_us: wall.mean,
          desvio_padrao_us: wall.sd,
          mediana_us: wall.median,
          minimo_us: wall.min,
          maximo_us: wall.max,
          ic95_inferior_us: wall.mean - wall.ci95,
          ic95_superior_us: wall.mean + wall.ci95,
          cpu_media_us: cpu.mean,
          cpu_desvio_padrao_us: cpu.sd,
          vazao_mb_por_s: size / wall.median, // bytes/µs = MB/s
        });
      }
    }
  }

  for (const operation of operations) {
    console.log(`Mediana para ${operation} (µs) e razão C3/C2:\n`);
    table(
      ["Tamanho", "C1", "C2", "C3", "C3/C2", "C3/C1"],
      PERFORMANCE_SIZES.map((size) => {
        const [c1, c2, c3] = (["C1", "C2", "C3"] as const).map(
          (id) => medians.get(`${id}:${operation}:${size}`)!.median
        );
        return [`${size} B`, num(c1), num(c2), num(c3), `${num(c3 / c2)}x`, `${num(c3 / c1)}x`];
      }),
      [12, 14, 14, 14, 10, 10]
    );
    console.log("");
  }
  saveCsv("h2-desempenho", rows);

  // Critério (a): IC95 de C3 inteiramente acima do IC95 de C2.
  let slowerEverywhere = true;
  for (const size of PERFORMANCE_SIZES) {
    for (const operation of operations) {
      const c2 = medians.get(`C2:${operation}:${size}`)!;
      const c3 = medians.get(`C3:${operation}:${size}`)!;
      if (c3.mean - c3.ci95 <= c2.mean + c2.ci95) slowerEverywhere = false;
    }
  }
  verdict(
    "H2(a)",
    slowerEverywhere,
    slowerEverywhere
      ? "C3 mais lenta que C2 em todos os tamanhos, sem sobreposição dos IC95"
      : "em pelo menos um tamanho os IC95 de C2 e C3 se sobrepõem ou C3 foi mais rápida"
  );

  // Critério (b): mediana de C3 < 1 ms até 1 KiB.
  const worst = Math.max(
    ...PERFORMANCE_SIZES.filter((size) => size <= 1_024).flatMap((size) =>
      operations.map((operation) => medians.get(`C3:${operation}:${size}`)!.median)
    )
  );
  verdict("H2(b)", worst < 1_000, `pior mediana de C3 até 1.024 bytes: ${num(worst)} µs (limite 1.000 µs)`);
}

// ---------------------------------------------------------------------------
// H3 -- expansão
// ---------------------------------------------------------------------------

function testExpansion() {
  section("H3. EXPANSÃO DO DADO (bytes a mais na saída)");

  const sizes = [0, 1, 11, 16, 64, 256, 1_024, 4_096];
  const random = new SeededRandom("h3");
  const rows: Row[] = [];
  let matches = true;

  for (const size of sizes) {
    const input = random.bytes(size);
    for (const scenario of scenarios) {
      const output = scenario.encrypt(input);
      const extra = output.length - size;
      const predicted = scenario.id === "C1" ? 0 : IV_LENGTH + TAG_LENGTH;
      if (extra !== predicted) matches = false;

      // Formato realmente gravado no banco pela aplicação (só C3 existe lá).
      const payload = scenario.id === "C3" ? parse(output) : null;
      const storedFormat = payload
        ? `v1:${payload.iv.toString("base64url")}:${payload.ciphertext.toString("base64url")}:${payload.tag.toString("base64url")}`.length
        : "";

      rows.push({
        cenario: scenario.id,
        tamanho_entrada_bytes: size,
        tamanho_saida_bytes: output.length,
        bytes_extras: extra,
        previsto: predicted,
        tamanho_no_banco_caracteres: storedFormat,
      });
    }
  }

  table(
    ["Entrada", "C1 extra", "C2 extra", "C3 extra", "C3 no banco (caracteres)"],
    sizes.map((size) => {
      const bySize = rows.filter((r) => r.tamanho_entrada_bytes === size);
      const extra = (id: string) => bySize.find((r) => r.cenario === id)!.bytes_extras as number;
      return [`${size} B`, extra("C1"), extra("C2"), extra("C3"), bySize.find((r) => r.cenario === "C3")!.tamanho_no_banco_caracteres as number];
    }),
    [12, 12, 12, 12, 26]
  );
  saveCsv("h3-expansao", rows);
  verdict("H3", matches, "C1 com 0 byte extra; C2 e C3 com 28 bytes extras em todos os tamanhos");
}

// ---------------------------------------------------------------------------
// H4 -- adulteração e H5 -- entradas inválidas
// ---------------------------------------------------------------------------

function testTampering() {
  section(`H4. ADULTERAÇÃO (1 bit invertido na saída armazenada, ${TRIALS} tentativas)`);

  const rows: Row[] = [];
  const detectionRate = new Map<ScenarioId, number>();

  for (const scenario of scenarios) {
    const random = new SeededRandom(`h4:${scenario.id}`);
    const counts: Record<Outcome, number> = { erro: 0, saida_incorreta: 0, saida_correta: 0 };
    const bytesChanged: number[] = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const input = random.bytes(256);
      const stored = scenario.encrypt(input);
      const tampered = flipBit(stored, random.int(stored.length * 8));
      const outcome = tryDecrypt(scenario, tampered, input);
      counts[outcome]++;
      if (outcome === "saida_incorreta") {
        bytesChanged.push(differingBytes(scenario.decrypt(tampered), input));
      }
    }

    detectionRate.set(scenario.id, counts.erro / TRIALS);
    rows.push({
      cenario: scenario.id,
      tentativas: TRIALS,
      detectadas: counts.erro,
      nao_detectadas_texto_alterado: counts.saida_incorreta,
      nao_detectadas_texto_intacto: counts.saida_correta,
      taxa_deteccao: counts.erro / TRIALS,
      media_bytes_alterados_sem_aviso: bytesChanged.length ? summarize(bytesChanged).mean : 0,
    });
  }

  table(
    ["Cenário", "Detectadas", "Sem aviso, texto alterado", "Bytes alterados (média)"],
    rows.map((r) => [
      r.cenario as string,
      pct(r.taxa_deteccao as number),
      r.nao_detectadas_texto_alterado as number,
      num(r.media_bytes_alterados_sem_aviso as number),
    ]),
    [10, 14, 28, 24]
  );
  saveCsv("h4-adulteracao", rows);
  verdict(
    "H4",
    detectionRate.get("C1") === 0 && detectionRate.get("C2") === 1 && detectionRate.get("C3") === 1,
    `detecção C1 ${pct(detectionRate.get("C1")!)}, C2 ${pct(detectionRate.get("C2")!)}, C3 ${pct(detectionRate.get("C3")!)}`
  );
}

function testInvalidInputs() {
  section("H5. ENTRADAS INVÁLIDAS");

  const cases = Math.min(TRIALS, 100);
  const rows: Row[] = [];
  let confirmed = true;

  for (const [index, scenario] of scenarios.entries()) {
    const random = new SeededRandom(`h5:${scenario.id}`);
    const tests: { caso: string; run: () => Outcome }[] = [
      {
        caso: "chave errada",
        run: () => {
          const input = random.bytes(64);
          return tryDecrypt(wrongKeyScenarios[index], scenario.encrypt(input), input);
        },
      },
      {
        caso: "texto cifrado truncado em 1 byte",
        run: () => {
          const input = random.bytes(64);
          return tryDecrypt(scenario, scenario.encrypt(input).slice(0, -1), input);
        },
      },
      {
        caso: "texto cifrado vazio",
        run: () => tryDecrypt(scenario, new Uint8Array(0), random.bytes(64)),
      },
    ];

    for (const { caso, run } of tests) {
      const counts: Record<Outcome, number> = { erro: 0, saida_incorreta: 0, saida_correta: 0 };
      for (let i = 0; i < cases; i++) counts[run()]++;
      const expectsError = scenario.id !== "C1";
      if (expectsError ? counts.erro !== cases : counts.erro !== 0 || counts.saida_correta !== 0) {
        confirmed = false;
      }
      rows.push({
        cenario: scenario.id,
        caso,
        tentativas: cases,
        lancou_erro: counts.erro,
        saida_incorreta_sem_aviso: counts.saida_incorreta,
        saida_correta: counts.saida_correta,
      });
    }
  }

  table(
    ["Cenário", "Caso", "Lançou erro", "Saída incorreta sem aviso"],
    rows.map((r) => [
      r.cenario as string,
      r.caso as string,
      `${r.lancou_erro}/${r.tentativas}`,
      `${r.saida_incorreta_sem_aviso}/${r.tentativas}`,
    ]),
    [10, 36, 14, 26]
  );
  saveCsv("h5-entradas-invalidas", rows);
  verdict("H5", confirmed, "C2 e C3 recusam toda entrada inválida; C1 devolve dado errado sem aviso");
}

// ---------------------------------------------------------------------------
// H6 -- determinismo
// ---------------------------------------------------------------------------

function testDeterminism() {
  section(`H6. DETERMINISMO (o mesmo telefone cifrado ${TRIALS} vezes)`);

  const phone = utf8("62991112233");
  const rows: Row[] = [];
  const distinct = new Map<ScenarioId, number>();

  for (const scenario of scenarios) {
    const outputs = new Set<string>();
    for (let i = 0; i < TRIALS; i++) outputs.add(Buffer.from(scenario.encrypt(phone)).toString("hex"));
    distinct.set(scenario.id, outputs.size);
    rows.push({ cenario: scenario.id, cifracoes: TRIALS, saidas_distintas: outputs.size });
  }

  table(
    ["Cenário", "Cifrações", "Saídas distintas"],
    rows.map((r) => [r.cenario as string, r.cifracoes as number, r.saidas_distintas as number]),
    [10, 12, 18]
  );
  saveCsv("h6-determinismo", rows);
  verdict(
    "H6",
    distinct.get("C1") === 1 && distinct.get("C2") === TRIALS && distinct.get("C3") === TRIALS,
    `saídas distintas: C1 ${distinct.get("C1")}, C2 ${distinct.get("C2")}, C3 ${distinct.get("C3")}`
  );
}

// ---------------------------------------------------------------------------
// H7 -- propriedades estatísticas
// ---------------------------------------------------------------------------

function testStatistics() {
  section(`H7. PROPRIEDADES ESTATÍSTICAS (texto em português, ${portugueseBytes.length} bytes)`);

  const subjects = [
    { cenario: "texto puro", data: portugueseBytes },
    ...scenarios.map((scenario) => ({ cenario: scenario.id, data: scenario.encrypt(portugueseBytes) })),
  ];

  const rows: Row[] = subjects.map(({ cenario, data }) => {
    const chi = chiSquareUniformity(data);
    return {
      cenario,
      bytes: data.length,
      entropia_bits_por_byte: shannonEntropy(data),
      indice_coincidencia: indexOfCoincidence(data),
      qui_quadrado: chi.statistic,
      p_valor: chi.pValue,
      rejeita_uniformidade: chi.pValue < SIGNIFICANCE,
    };
  });

  table(
    ["", "Entropia", "Índice coinc.", "Qui-quadrado", "p-valor", "Rejeita uniformidade?"],
    rows.map((r) => [
      r.cenario as string,
      num(r.entropia_bits_por_byte as number, 4),
      num(r.indice_coincidencia as number, 4),
      num(r.qui_quadrado as number, 1),
      (r.p_valor as number) < 1e-4 ? "< 0,0001" : num(r.p_valor as number, 4),
      r.rejeita_uniformidade ? "sim" : "não",
    ]),
    [14, 12, 16, 16, 12, 22]
  );
  console.log(`\nReferência: dado aleatório tem entropia ≈ 8 e índice ≈ ${num(1 / 256, 4)}. Nível de significância: ${SIGNIFICANCE}.`);
  saveCsv("h7-estatistica", rows);

  const rejects = (cenario: string) => rows.find((r) => r.cenario === cenario)!.rejeita_uniformidade;
  verdict(
    "H7",
    rejects("texto puro") === true && rejects("C1") === true && rejects("C2") === false && rejects("C3") === false,
    `rejeita uniformidade: texto puro ${rejects("texto puro") ? "sim" : "não"}, C1 ${rejects("C1") ? "sim" : "não"}, ` +
      `C2 ${rejects("C2") ? "sim" : "não"}, C3 ${rejects("C3") ? "sim" : "não"}`
  );
}

// ---------------------------------------------------------------------------
// H8 -- difusão (efeito avalanche)
// ---------------------------------------------------------------------------

function testAvalanche() {
  section(`H8. DIFUSÃO / EFEITO AVALANCHE (${TRIALS} tentativas, entradas de 64 bytes)`);
  console.log("Porcentagem dos bits da saída que mudam. IV fixo só nesta medida.\n");

  const size = 64;
  const rows: Row[] = [];
  type Sample = { body: number[]; tag: number[] };
  const results = new Map<string, Sample>();

  const record = (label: string, body: number, tag?: number) => {
    const sample = results.get(label) ?? { body: [], tag: [] };
    sample.body.push(body);
    if (tag !== undefined) sample.tag.push(tag);
    results.set(label, sample);
  };

  const flipKey = (key: Uint8Array, random: SeededRandom) => flipBit(key, random.int(key.length * 8));

  const random = new SeededRandom("h8");
  for (let trial = 0; trial < TRIALS; trial++) {
    const input = random.bytes(size);
    const changed = flipBit(input, random.int(size * 8));
    const iv = random.bytes(IV_LENGTH);
    const bits = size * 8;
    const tagBits = TAG_LENGTH * 8;

    // Alteração de 1 bit da entrada.
    record("C1|entrada", differingBits(trevoEncrypt(input, keys.k1), trevoEncrypt(changed, keys.k1)) / bits);

    const c2a = gcmWithFixedIv(input, keys.k2, iv);
    const c2b = gcmWithFixedIv(changed, keys.k2, iv);
    record("C2|entrada", differingBits(c2a.body, c2b.body) / bits, differingBits(c2a.tag, c2b.tag) / tagBits);

    const c3a = gcmWithFixedIv(trevoEncrypt(input, keys.k1), keys.k2, iv);
    const c3b = gcmWithFixedIv(trevoEncrypt(changed, keys.k1), keys.k2, iv);
    record("C3|entrada", differingBits(c3a.body, c3b.body) / bits, differingBits(c3a.tag, c3b.tag) / tagBits);

    // Alteração de 1 bit da chave.
    const k1b = flipKey(keys.k1, random);
    const k2b = flipKey(keys.k2, random);
    record("C1|chave K1", differingBits(trevoEncrypt(input, keys.k1), trevoEncrypt(input, k1b)) / bits);

    const c2k = gcmWithFixedIv(input, k2b, iv);
    record("C2|chave K2", differingBits(c2a.body, c2k.body) / bits, differingBits(c2a.tag, c2k.tag) / tagBits);

    const c3k1 = gcmWithFixedIv(trevoEncrypt(input, k1b), keys.k2, iv);
    record("C3|chave K1", differingBits(c3a.body, c3k1.body) / bits, differingBits(c3a.tag, c3k1.tag) / tagBits);

    const c3k2 = gcmWithFixedIv(trevoEncrypt(input, keys.k1), k2b, iv);
    record("C3|chave K2", differingBits(c3a.body, c3k2.body) / bits, differingBits(c3a.tag, c3k2.tag) / tagBits);
  }

  for (const [label, sample] of results) {
    const [cenario, alteracao] = label.split("|");
    for (const [parte, values] of [
      ["corpo cifrado", sample.body],
      ["tag", sample.tag],
    ] as const) {
      if (!values.length) continue;
      const s = summarize(values);
      rows.push({
        cenario,
        bit_alterado_em: alteracao,
        parte_da_saida: parte,
        tentativas: values.length,
        media_bits_alterados: s.mean,
        desvio_padrao: s.sd,
        minimo: s.min,
        maximo: s.max,
      });
    }
  }

  table(
    ["Cenário", "Bit alterado em", "Parte", "Média", "Mínimo", "Máximo"],
    rows.map((r) => [
      r.cenario as string,
      r.bit_alterado_em as string,
      r.parte_da_saida as string,
      pct(r.media_bits_alterados as number),
      pct(r.minimo as number),
      pct(r.maximo as number),
    ]),
    [10, 18, 16, 10, 10, 10]
  );
  console.log("\nReferência: uma cifra com difusão ideal muda ≈ 50% dos bits.");
  saveCsv("h8-avalanche", rows);

  const bodyMeans = rows.filter((r) => r.bit_alterado_em === "entrada" && r.parte_da_saida === "corpo cifrado");
  const allBelow = bodyMeans.every((r) => (r.media_bits_alterados as number) < 0.05);
  verdict(
    "H8",
    allBelow,
    "com 1 bit da entrada alterado, nenhum cenário muda mais de 5% do corpo cifrado: " +
      bodyMeans.map((r) => `${r.cenario} ${pct(r.media_bits_alterados as number)}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// H9 -- ataque de frequência
// ---------------------------------------------------------------------------

function testFrequencyAttack() {
  section("H9. ATAQUE DE FREQUÊNCIA (ranking + força bruta das 5.910 ordens de colunas)");

  const plaintext = utf8(TARGET_TEXT);
  const reference = utf8(REFERENCE_TEXT);

  // Base de comparação: chutar o byte mais comum do português em toda posição.
  const mostCommon = frequencyRanking(reference)[0];
  const trivial = accuracy(new Uint8Array(plaintext.length).fill(mostCommon), plaintext);

  const rows: Row[] = [{ cenario: "chute trivial", tentativas: 1, media_acerto: trivial, minimo: trivial, maximo: trivial }];

  for (const scenario of scenarios) {
    // C1 é determinística: repetir o ataque daria sempre o mesmo resultado.
    const trials = scenario.id === "C1" ? 1 : ATTACK_TRIALS;
    const hits: number[] = [];
    for (let i = 0; i < trials; i++) {
      const output = scenario.encrypt(plaintext);
      // O atacante ataca o corpo cifrado, que tem o mesmo tamanho do texto.
      const body = scenario.id === "C1" ? output : new Uint8Array(parse(output).ciphertext);
      const attack = bruteForceTransposition(body, frequencyAttackMap(body, reference));
      hits.push(accuracy(attack.candidate, plaintext));
    }
    const s = summarize(hits);
    rows.push({ cenario: scenario.id, tentativas: trials, media_acerto: s.mean, minimo: s.min, maximo: s.max });
  }

  table(
    ["", "Tentativas", "Acerto médio", "Mínimo", "Máximo"],
    rows.map((r) => [
      r.cenario as string,
      r.tentativas as number,
      pct(r.media_acerto as number),
      pct(r.minimo as number),
      pct(r.maximo as number),
    ]),
    [16, 12, 14, 10, 10]
  );
  saveCsv("h9-ataque-frequencia", rows);

  const beatTrivial = rows.filter((r) => r.cenario !== "chute trivial" && (r.media_acerto as number) > trivial);
  verdict(
    "H9",
    beatTrivial.length === 0,
    beatTrivial.length === 0
      ? `nenhum cenário supera o chute trivial (${pct(trivial)})`
      : `superam o chute trivial (${pct(trivial)}): ${beatTrivial.map((r) => r.cenario).join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

function gitInfo() {
  try {
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    // A própria pasta de resultados não conta: execuções anteriores ainda
    // não commitadas não mudam o código que está sendo medido.
    const dirty =
      execSync('git status --porcelain -- . ":(exclude)resultados"', { encoding: "utf8" }).trim().length > 0;
    return { commit, alteracoes_nao_commitadas: dirty };
  } catch {
    return { commit: "desconhecido", alteracoes_nao_commitadas: null };
  }
}

function writeResults(startedAt: Date, durationSeconds: number) {
  const stamp = startedAt.toISOString().slice(0, 19).replace(/:/g, "-");
  const directory = path.join(process.cwd(), "resultados", `benchmark-${stamp}${QUICK ? "-rapido" : ""}`);
  mkdirSync(directory, { recursive: true });

  for (const [name, rows] of Object.entries(files)) {
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(";"), ...rows.map((row) => headers.map((h) => formatCell(row[h])).join(";"))];
    // BOM no início para o Excel reconhecer UTF-8 (acentos).
    writeFileSync(path.join(directory, `${name}.csv`), `﻿${lines.join("\r\n")}\r\n`, "utf8");
  }

  const environment = {
    data: startedAt.toISOString(),
    duracao_segundos: Math.round(durationSeconds),
    modo: QUICK ? "rapido (não usar como resultado oficial)" : "oficial",
    semente: SEED,
    rodadas_desempenho: ROUNDS,
    lote_alvo_ms: TARGET_BATCH_MS,
    tentativas: TRIALS,
    tentativas_ataque: ATTACK_TRIALS,
    node: process.version,
    sistema: `${platform()} ${release()}`,
    processador: cpus()[0]?.model ?? "desconhecido",
    nucleos: cpus().length,
    memoria_gb: Math.round(totalmem() / 1024 ** 3),
    ...gitInfo(),
    veredictos: verdicts,
  };
  writeFileSync(path.join(directory, "ambiente.json"), `${JSON.stringify(environment, null, 2)}\n`, "utf8");
  return directory;
}

function main() {
  const startedAt = new Date();
  const start = performance.now();

  console.log("BENCHMARK -- CIFRA TREVO (C1) x AES-256-GCM (C2) x COMBINAÇÃO (C3)");
  console.log(`Semente: ${SEED}${QUICK ? "   (modo rápido -- não usar como resultado oficial)" : ""}`);
  console.log("Hipóteses e critérios: docs/hipoteses-e-criterios.md");

  testCorrectness();
  testExpansion();
  testDeterminism();
  testTampering();
  testInvalidInputs();
  testStatistics();
  testAvalanche();
  testFrequencyAttack();
  testPerformance();

  const directory = writeResults(startedAt, (performance.now() - start) / 1000);

  section("RESUMO");
  for (const line of verdicts) console.log(line);
  console.log(`\nResultados gravados em ${path.relative(process.cwd(), directory)}`);
}

main();

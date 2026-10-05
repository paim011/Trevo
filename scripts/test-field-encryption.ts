import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  decryptField,
  encryptField,
  isEncryptedField,
  tryDecryptField,
} from "@/lib/field-encryption";
import {
  buildColumnOrder,
  buildSubstitutionBox,
  trevoDecrypt,
  trevoEncrypt,
} from "@/lib/trevo-cipher";

// Testes das duas camadas de criptografia (Cifra Trevo + AES-256-GCM).
// Não usa banco de dados: tudo roda em memória, com uma chave mestra
// aleatória gerada só para esta execução -- nunca a chave real do .env.
process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");

let failures = 0;

function check(description: string, test: () => void) {
  try {
    test();
    console.log(`  ✓ ${description}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${description}`);
    console.log(`    ${(error as Error).message}`);
  }
}

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

const SAMPLES = [
  "",
  "6",
  "62999330000",
  "Rua dos Girassóis, 15 - Residencial Buena Vista",
  "AÇÃO, ação, Ação: maiúsculas, minúsculas e acentos",
  "x".repeat(200),
];

function testTrevoCipher() {
  console.log("\nCamada 1 -- Cifra Trevo (autoral)");
  const key = randomBytes(32);

  check("ida e volta preserva o texto (acentos, ç, maiúsculas, vazio, longo)", () => {
    for (const sample of SAMPLES) {
      assert.equal(text(trevoDecrypt(trevoEncrypt(utf8(sample), key), key)), sample);
    }
  });

  check("ida e volta funciona para bytes aleatórios de 0 a 64 bytes", () => {
    for (let length = 0; length <= 64; length++) {
      const data = randomBytes(length);
      assert.deepEqual(
        Buffer.from(trevoDecrypt(trevoEncrypt(data, key), key)),
        data
      );
    }
  });

  check("folha 1: a S-box é uma permutação dos 256 valores de byte", () => {
    const box = buildSubstitutionBox(key);
    assert.equal(new Set(box).size, 256);
  });

  check("folha 3: a ordem tem de 3 a 7 colunas, cada uma uma única vez", () => {
    const order = buildColumnOrder(key);
    assert.ok(order.length >= 3 && order.length <= 7);
    assert.deepEqual([...order].sort((a, b) => a - b), order.map((_, i) => i));
  });

  check("texto cifrado é diferente do texto original", () => {
    const sample = utf8("62999330000");
    assert.notDeepEqual(trevoEncrypt(sample, key), sample);
  });

  check("folha 2: o mesmo byte repetido não sai sempre igual", () => {
    const output = trevoEncrypt(utf8("a".repeat(32)), key);
    assert.ok(new Set(output).size > 1);
  });

  check("é determinística: mesma entrada e chave geram a mesma saída (limitação conhecida)", () => {
    const sample = utf8("62999330000");
    assert.deepEqual(trevoEncrypt(sample, key), trevoEncrypt(sample, key));
  });

  check("chave errada não recupera o texto", () => {
    const sample = "62999330000";
    const ciphertext = trevoEncrypt(utf8(sample), key);
    assert.notEqual(text(trevoDecrypt(ciphertext, randomBytes(32))), sample);
  });
}

function testFieldEncryption() {
  console.log("\nCamadas 1 + 2 -- Cifra Trevo + AES-256-GCM");
  const owner = "user-dono-123";

  check("ida e volta preserva o valor", () => {
    for (const sample of SAMPLES) {
      const stored = encryptField(sample, "familyProfile.address", owner);
      assert.equal(decryptField(stored, "familyProfile.address", owner), sample);
    }
  });

  check("formato gravado é v1:<iv>:<texto cifrado>:<tag>", () => {
    const stored = encryptField("62999330000", "caregiverProfile.phone", owner);
    assert.ok(isEncryptedField(stored));
    assert.equal(stored.split(":").length, 4);
    assert.ok(!stored.includes("62999330000"));
  });

  check("o mesmo valor cifrado duas vezes gera saídas diferentes (IV aleatório)", () => {
    const a = encryptField("62999330000", "caregiverProfile.phone", owner);
    const b = encryptField("62999330000", "caregiverProfile.phone", owner);
    assert.notEqual(a, b);
  });

  check("adulterar um byte do texto cifrado faz a decifração falhar (tag do GCM)", () => {
    const stored = encryptField("62999330000", "caregiverProfile.phone", owner);
    const [version, iv, ciphertext, tag] = stored.split(":");
    const bytes = Buffer.from(ciphertext, "base64url");
    bytes[0] ^= 0x01;
    const tampered = [version, iv, bytes.toString("base64url"), tag].join(":");
    assert.throws(() => decryptField(tampered, "caregiverProfile.phone", owner));
  });

  check("copiar o valor para outro usuário faz a decifração falhar (AAD)", () => {
    const stored = encryptField("62999330000", "familyProfile.phone", owner);
    assert.throws(() => decryptField(stored, "familyProfile.phone", "outro-usuario"));
  });

  check("copiar o valor para outro campo faz a decifração falhar (AAD)", () => {
    const stored = encryptField("62999330000", "familyProfile.phone", owner);
    assert.throws(() => decryptField(stored, "familyProfile.address", owner));
  });

  check("texto puro (não cifrado) é recusado", () => {
    assert.ok(!isEncryptedField("62999330000"));
    assert.throws(() => decryptField("62999330000", "familyProfile.phone", owner));
  });

  check("tryDecryptField devolve null em vez de lançar erro", () => {
    const stored = encryptField("62999330000", "familyProfile.phone", owner);
    assert.equal(tryDecryptField(stored, "familyProfile.phone", "outro-usuario"), null);
    assert.equal(tryDecryptField(null, "familyProfile.phone", owner), null);
  });
}

testTrevoCipher();
testFieldEncryption();

console.log(failures === 0 ? "\nTodos os testes passaram." : `\n${failures} teste(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);

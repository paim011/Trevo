import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM -- camada criptográfica PADRÃO do projeto, via `node:crypto`
 * (implementação embutida no Node.js, não uma biblioteca de terceiros). O
 * algoritmo em si não é modificado: a adaptação ao domínio do Trevo está em
 * COMO ele é aplicado (chave própria derivada por HKDF e AAD amarrando cada
 * valor ao seu dono -- ver lib/field-encryption.ts).
 *
 * - AES-256: cifra de bloco simétrica padronizada pelo NIST (FIPS 197),
 *   chave de 256 bits.
 * - GCM (Galois/Counter Mode, NIST SP 800-38D): modo que cifra E autentica.
 *   Além do texto cifrado, gera uma "tag" de 16 bytes; se qualquer byte do
 *   texto cifrado, do IV ou da AAD for alterado, a decifração falha em vez
 *   de devolver dado corrompido.
 * - IV (vetor de inicialização) de 12 bytes, aleatório a cada cifração:
 *   o mesmo texto cifrado duas vezes gera saídas diferentes. Nunca pode se
 *   repetir com a mesma chave -- por isso vem de randomBytes, não de um
 *   contador ou valor fixo.
 * - AAD (dados associados autenticados): informação que não é cifrada, mas
 *   entra no cálculo da tag. Decifrar com uma AAD diferente da usada na
 *   cifração falha.
 *
 * Só pode ser importado em código server-side (Route Handlers, Server
 * Components, scripts) -- `node:crypto` não existe no navegador, e a chave
 * nunca deve sair do servidor.
 */

export const AES_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

export type AesGcmPayload = {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

export function aesGcmEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array
): AesGcmPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

/**
 * Lança erro se a tag não bater -- ou seja, se o texto cifrado, o IV ou a
 * AAD tiverem sido alterados, ou se a chave estiver errada.
 */
export function aesGcmDecrypt(
  payload: AesGcmPayload,
  key: Uint8Array,
  aad: Uint8Array
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(payload.tag);

  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

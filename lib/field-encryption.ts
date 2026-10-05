import { hkdfSync } from "node:crypto";

import { AES_KEY_LENGTH, aesGcmDecrypt, aesGcmEncrypt } from "@/lib/aes-gcm";
import { TREVO_KEY_LENGTH, trevoDecrypt, trevoEncrypt } from "@/lib/trevo-cipher";

/**
 * Criptografia em duas camadas dos dados sensíveis, aplicada campo a campo
 * antes de gravar no banco:
 *
 *   texto → Camada 1: Cifra Trevo (autoral, chave K1)
 *         → Camada 2: AES-256-GCM (padrão, chave K2, IV aleatório, AAD)
 *         → banco: "v1:<iv>:<texto cifrado>:<tag>"
 *
 * A Cifra Trevo fica POR DENTRO de propósito: o GCM, por fora, autentica o
 * resultado inteiro, então qualquer adulteração é detectada antes mesmo de
 * a camada autoral ser desfeita. A segurança real do sistema vem do AES; a
 * Cifra Trevo é a contribuição de estudo (ver lib/trevo-cipher.ts).
 *
 * Só pode ser importado em código server-side -- ver lib/aes-gcm.ts.
 */

/**
 * Campos cifrados hoje. O nome entra na AAD, então o mesmo valor cifrado
 * para um campo não decifra se for copiado para outro (ex.: telefone
 * colado na coluna de endereço).
 */
export type SensitiveField =
  | "familyProfile.phone"
  | "familyProfile.address"
  | "caregiverProfile.phone";

const FORMAT_VERSION = "v1";
const MASTER_KEY_ENV = "FIELD_ENCRYPTION_KEY";
const MASTER_KEY_LENGTH = 32;

// Rótulos do HKDF: a partir de uma única chave mestra, derivam duas chaves
// independentes. Conhecer K1 não revela nada sobre K2 (e vice-versa), então
// quebrar a camada autoral não entrega a camada do AES.
const HKDF_SALT = "trevo-field-encryption";
const K1_INFO = "trevo-cipher-k1";
const K2_INFO = "aes-256-gcm-k2";

type DerivedKeys = { trevoKey: Uint8Array; aesKey: Uint8Array };

let cachedKeys: DerivedKeys | null = null;

function loadKeys(): DerivedKeys {
  if (cachedKeys) {
    return cachedKeys;
  }

  const encoded = process.env[MASTER_KEY_ENV];
  if (!encoded) {
    throw new Error(
      `${MASTER_KEY_ENV} não está definida. Gere uma com: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  const masterKey = Buffer.from(encoded, "base64");
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new Error(
      `${MASTER_KEY_ENV} precisa ter ${MASTER_KEY_LENGTH} bytes em base64 (tem ${masterKey.length}).`
    );
  }

  cachedKeys = {
    trevoKey: new Uint8Array(
      hkdfSync("sha256", masterKey, HKDF_SALT, K1_INFO, TREVO_KEY_LENGTH)
    ),
    aesKey: new Uint8Array(
      hkdfSync("sha256", masterKey, HKDF_SALT, K2_INFO, AES_KEY_LENGTH)
    ),
  };
  return cachedKeys;
}

/**
 * AAD = campo + dono (`User.id`). Amarra o valor cifrado ao lugar de onde
 * veio: copiar o telefone cifrado de um usuário para a linha de outro, no
 * banco, faz a decifração falhar.
 */
function buildAad(field: SensitiveField, ownerUserId: string): Buffer {
  return Buffer.from(`trevo:${field}:${ownerUserId}`, "utf8");
}

export function encryptField(
  value: string,
  field: SensitiveField,
  ownerUserId: string
): string {
  const { trevoKey, aesKey } = loadKeys();

  const layer1 = trevoEncrypt(Buffer.from(value, "utf8"), trevoKey);
  const { iv, ciphertext, tag } = aesGcmEncrypt(
    layer1,
    aesKey,
    buildAad(field, ownerUserId)
  );

  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

/**
 * Versão estrita: lança erro se o valor não estiver no formato esperado,
 * tiver sido adulterado, pertencer a outro dono/campo, ou se a chave
 * estiver errada.
 */
export function decryptField(
  stored: string,
  field: SensitiveField,
  ownerUserId: string
): string {
  const parts = stored.split(":");
  const [version, iv, ciphertext, tag] = parts;

  // O texto cifrado pode ser vazio (cifrar "" gera 0 bytes), então só IV e
  // tag precisam ter conteúdo -- os quatro pedaços precisam existir.
  if (parts.length !== 4 || version !== FORMAT_VERSION || !iv || !tag) {
    throw new Error("Valor cifrado em formato inválido.");
  }

  const { trevoKey, aesKey } = loadKeys();

  const layer1 = aesGcmDecrypt(
    {
      iv: Buffer.from(iv, "base64url"),
      ciphertext: Buffer.from(ciphertext, "base64url"),
      tag: Buffer.from(tag, "base64url"),
    },
    aesKey,
    buildAad(field, ownerUserId)
  );

  return Buffer.from(trevoDecrypt(layer1, trevoKey)).toString("utf8");
}

/** Cifra um valor opcional: `null`/`undefined` passam adiante sem mudança. */
export function encryptOptionalField<T extends string | null | undefined>(
  value: T,
  field: SensitiveField,
  ownerUserId: string
): string | Exclude<T, string> {
  if (typeof value !== "string") {
    return value as Exclude<T, string>;
  }
  return encryptField(value, field, ownerUserId);
}

/**
 * Versão tolerante, para as telas: devolve `null` em vez de derrubar a
 * página quando o valor não decifra. A falha é registrada no log só com
 * campo e dono -- nunca com o valor cifrado ou decifrado.
 */
export function tryDecryptField(
  stored: string | null | undefined,
  field: SensitiveField,
  ownerUserId: string
): string | null {
  if (!stored) {
    return null;
  }

  try {
    return decryptField(stored, field, ownerUserId);
  } catch {
    console.error("[field-encryption] falha ao decifrar", { field, ownerUserId });
    return null;
  }
}

/** Distingue um valor já cifrado de um texto puro antigo (usado na migração). */
export function isEncryptedField(stored: string): boolean {
  return stored.startsWith(`${FORMAT_VERSION}:`);
}

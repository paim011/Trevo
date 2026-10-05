import {
  encryptField,
  isEncryptedField,
  SensitiveField,
} from "@/lib/field-encryption";
import { prisma } from "@/lib/prisma";

// Cifra os telefones e endereços que já estavam salvos em texto puro antes
// da criptografia em duas camadas existir (ver lib/field-encryption.ts).
//
// Roda contra o MESMO banco de produção (não há staging -- ver CLAUDE.md,
// "Deploy"), então por padrão só SIMULA e mostra quantos valores seriam
// cifrados. Para gravar de verdade:
//
//   npm run encrypt:existing -- --apply
//
// É idempotente: valores que já começam com "v1:" são pulados, então rodar
// de novo não cifra nada duas vezes. Nunca imprime os valores em si, só
// contagens.
const apply = process.argv.includes("--apply");

function needsEncryption(value: string | null): value is string {
  return value !== null && value !== "" && !isEncryptedField(value);
}

function encryptIfNeeded(
  value: string | null,
  field: SensitiveField,
  ownerUserId: string
): string | undefined {
  return needsEncryption(value) ? encryptField(value, field, ownerUserId) : undefined;
}

async function encryptFamilies() {
  const profiles = await prisma.familyProfile.findMany({
    select: { userId: true, phone: true, address: true },
  });

  let updated = 0;
  for (const profile of profiles) {
    const phone = encryptIfNeeded(profile.phone, "familyProfile.phone", profile.userId);
    const address = encryptIfNeeded(
      profile.address,
      "familyProfile.address",
      profile.userId
    );

    if (phone === undefined && address === undefined) {
      continue;
    }

    updated++;
    if (apply) {
      await prisma.familyProfile.update({
        where: { userId: profile.userId },
        data: { phone, address },
      });
    }
  }

  return { total: profiles.length, updated };
}

async function encryptCaregivers() {
  const profiles = await prisma.caregiverProfile.findMany({
    select: { userId: true, phone: true },
  });

  let updated = 0;
  for (const profile of profiles) {
    const phone = encryptIfNeeded(profile.phone, "caregiverProfile.phone", profile.userId);

    if (phone === undefined) {
      continue;
    }

    updated++;
    if (apply) {
      await prisma.caregiverProfile.update({
        where: { userId: profile.userId },
        data: { phone },
      });
    }
  }

  return { total: profiles.length, updated };
}

async function main() {
  console.log(apply ? "Modo: GRAVANDO no banco.\n" : "Modo: simulação (nada é gravado). Use --apply para gravar.\n");

  const families = await encryptFamilies();
  const caregivers = await encryptCaregivers();
  const verb = apply ? "cifrados" : "seriam cifrados";

  console.log(`Famílias:   ${families.updated} de ${families.total} perfis ${verb}`);
  console.log(`Cuidadores: ${caregivers.updated} de ${caregivers.total} perfis ${verb}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

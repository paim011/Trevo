import { prisma } from "@/lib/prisma";
import { roundCoordinate } from "@/lib/location-privacy";

// Arredonda as coordenadas gravadas antes de lib/geocoding.ts passar a
// guardar só a localização aproximada (ver lib/location-privacy.ts e
// docs/lgpd.md, lacuna 1).
//
// Roda contra o MESMO banco de produção (não há staging -- ver CLAUDE.md,
// "Deploy"), então por padrão só SIMULA e mostra quantos perfis seriam
// alterados. Para gravar de verdade:
//
//   npm run round:coordinates -- --apply
//
// Idempotente: coordenadas já arredondadas não mudam. Nunca imprime as
// coordenadas, só contagens.
const apply = process.argv.includes("--apply");

type Located = { userId: string; latitude: number | null; longitude: number | null };

function roundedOrNull({ latitude, longitude }: Located) {
  if (latitude === null || longitude === null) {
    return null;
  }

  const rounded = { latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) };
  return rounded.latitude === latitude && rounded.longitude === longitude ? null : rounded;
}

async function main() {
  const select = { userId: true, latitude: true, longitude: true } as const;
  const [families, caregivers] = await Promise.all([
    prisma.familyProfile.findMany({ select }),
    prisma.caregiverProfile.findMany({ select }),
  ]);

  let familiesUpdated = 0;
  for (const profile of families) {
    const rounded = roundedOrNull(profile);
    if (!rounded) continue;
    familiesUpdated++;
    if (apply) {
      await prisma.familyProfile.update({ where: { userId: profile.userId }, data: rounded });
    }
  }

  let caregiversUpdated = 0;
  for (const profile of caregivers) {
    const rounded = roundedOrNull(profile);
    if (!rounded) continue;
    caregiversUpdated++;
    if (apply) {
      await prisma.caregiverProfile.update({ where: { userId: profile.userId }, data: rounded });
    }
  }

  const verb = apply ? "arredondados" : "seriam arredondados (simulação)";
  console.log(`Famílias: ${familiesUpdated} de ${families.length} perfis ${verb}.`);
  console.log(`Cuidadores: ${caregiversUpdated} de ${caregivers.length} perfis ${verb}.`);
  if (!apply) {
    console.log("\nNada foi gravado. Para aplicar: npm run round:coordinates -- --apply");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

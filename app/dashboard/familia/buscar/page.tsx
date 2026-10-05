import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BackLink } from "@/app/dashboard/_components/back-link";
import { CaregiverResults } from "@/app/dashboard/familia/buscar/_components/caregiver-results";
import { authOptions } from "@/lib/auth";
import { tryDecryptField } from "@/lib/field-encryption";
import { rankCaregiversForFamily } from "@/lib/matching";
import { matchingConfig } from "@/lib/matching-config";
import { prisma } from "@/lib/prisma";
import { errorTextClass, primaryButtonClass } from "@/lib/ui";

const CARE_TYPE_LABELS: Record<string, string> = {
  ELDERLY: "Idosos",
  CHILD: "Crianças",
  SPECIAL_NEEDS: "Necessidades especiais",
};

export default async function BuscarCuidadoresPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  const familyProfile = await prisma.familyProfile.findUnique({
    where: { userId: session.user.id },
  });

  const missingLocation =
    !familyProfile ||
    familyProfile.latitude === null ||
    familyProfile.longitude === null;

  const missingCareTypes =
    familyProfile !== null &&
    !missingLocation &&
    familyProfile.neededCareTypes.length === 0;

  const ranked =
    !missingLocation && !missingCareTypes
      ? await rankCaregiversForFamily(familyProfile)
      : [];

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <BackLink href="/dashboard/familia" />

        <h1 className="mb-6 font-display text-3xl font-semibold text-ink">
          Buscar cuidadores
        </h1>

        {missingLocation && (
          <p className={errorTextClass}>
            Complete seu endereço no perfil para buscar cuidadores próximos.
          </p>
        )}

        {missingCareTypes && (
          <div className="rounded-card border border-primary/20 bg-primary-light p-6 text-center">
            <p className="text-sm text-ink">
              Complete seu perfil com os tipos de cuidado que você procura
              antes de buscar cuidadores.
            </p>
            <Link
              href="/dashboard/familia/perfil"
              className={`${primaryButtonClass} mt-4 inline-block w-auto px-6`}
            >
              Completar perfil
            </Link>
          </div>
        )}

        {!missingLocation && !missingCareTypes && familyProfile && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-muted/20 bg-white px-4 py-3 text-sm text-ink">
            <span>
              {familyProfile.neededCareTypes
                .map((type) => CARE_TYPE_LABELS[type] ?? type)
                .join(", ")}
              {" · "}
              {[
                tryDecryptField(
                  familyProfile.address,
                  "familyProfile.address",
                  session.user.id
                ),
                familyProfile.city,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
            <Link
              href="/dashboard/familia/perfil"
              className="font-medium text-primary hover:underline"
            >
              Editar perfil
            </Link>
          </div>
        )}

        {!missingLocation && !missingCareTypes && ranked.length === 0 && (
          <p className="text-sm text-muted">
            Nenhum cuidador encontrado a até {matchingConfig.maxDistanceKm}km
            com os tipos de cuidado que você procura.
          </p>
        )}

        {ranked.length > 0 && familyProfile && (
          <CaregiverResults
            results={ranked}
            familyNeededCareTypes={familyProfile.neededCareTypes}
          />
        )}
      </div>
    </main>
  );
}

import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BackLink } from "@/app/dashboard/_components/back-link";
import { FamilyResults } from "@/app/dashboard/cuidador/buscar/_components/family-results";
import { authOptions } from "@/lib/auth";
import { rankFamiliesForCaregiver, toFamilySearchResult } from "@/lib/matching";
import { matchingConfig } from "@/lib/matching-config";
import { prisma } from "@/lib/prisma";
import { errorTextClass, primaryButtonClass } from "@/lib/ui";

const CARE_TYPE_LABELS: Record<string, string> = {
  ELDERLY: "Idosos",
  CHILD: "Crianças",
  SPECIAL_NEEDS: "Necessidades especiais",
};

export default async function BuscarFamiliasPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  const caregiverProfile = await prisma.caregiverProfile.findUnique({
    where: { userId: session.user.id },
  });

  const missingLocation =
    !caregiverProfile ||
    caregiverProfile.latitude === null ||
    caregiverProfile.longitude === null;

  const missingCareTypes =
    caregiverProfile !== null &&
    !missingLocation &&
    caregiverProfile.careTypes.length === 0;

  const ranked =
    !missingLocation && !missingCareTypes
      ? await rankFamiliesForCaregiver(caregiverProfile)
      : [];

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <BackLink href="/dashboard/cuidador" />

        <h1 className="mb-6 font-display text-3xl font-semibold text-ink">
          Buscar famílias
        </h1>

        {missingLocation && (
          <p className={errorTextClass}>
            Complete seu endereço no perfil para buscar famílias próximas.
          </p>
        )}

        {missingCareTypes && (
          <div className="rounded-card border border-primary/20 bg-primary-light p-6 text-center">
            <p className="text-sm text-ink">
              Complete seu perfil com os tipos de cuidado que você oferece
              antes de buscar famílias.
            </p>
            <Link
              href="/dashboard/cuidador/perfil"
              className={`${primaryButtonClass} mt-4 inline-block w-auto px-6`}
            >
              Completar perfil
            </Link>
          </div>
        )}

        {!missingLocation && !missingCareTypes && caregiverProfile && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-muted/20 bg-white px-4 py-3 text-sm text-ink">
            <span>
              {caregiverProfile.careTypes
                .map((type) => CARE_TYPE_LABELS[type] ?? type)
                .join(", ")}
              {" · "}
              {[caregiverProfile.city, caregiverProfile.state]
                .filter(Boolean)
                .join(", ")}
            </span>
            <Link
              href="/dashboard/cuidador/perfil"
              className="font-medium text-primary hover:underline"
            >
              Editar perfil
            </Link>
          </div>
        )}

        {!missingLocation && !missingCareTypes && ranked.length === 0 && (
          <p className="text-sm text-muted">
            Nenhuma família encontrada a até {matchingConfig.maxDistanceKm}km
            com os tipos de cuidado que você oferece.
          </p>
        )}

        {ranked.length > 0 && caregiverProfile && (
          <FamilyResults
            results={ranked.map(toFamilySearchResult)}
            caregiverCareTypes={caregiverProfile.careTypes}
          />
        )}
      </div>
    </main>
  );
}

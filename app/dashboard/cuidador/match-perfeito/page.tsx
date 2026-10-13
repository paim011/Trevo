import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BackLink } from "@/app/dashboard/_components/back-link";
import { AvatarPlaceholder } from "@/app/dashboard/familia/_components/avatar-placeholder";
import { ConnectionLine } from "@/app/dashboard/familia/_components/connection-line";
import { InteresseButton } from "@/app/dashboard/cuidador/_components/interesse-button";
import { authOptions } from "@/lib/auth";
import { CARE_TYPE_LABELS, formatCareTypes } from "@/lib/care-types";
import { formatDistanceBand } from "@/lib/location-privacy";
import { findMatchedFamiliesForCaregiver } from "@/lib/matching";

// Mesmo raciocínio do STABLE_MATCH_VISUAL_SCORE de
// /dashboard/familia/match-recomendado: o Gale-Shapley não produz um score
// de compatibilidade 0-1, então o ConnectionLine recebe um valor fixo e
// razoavelmente tenso em vez de um valor fabricado -- um match estável é,
// por construção, o melhor par disponível, então uma linha quase reta
// reflete isso honestamente.
const STABLE_MATCH_VISUAL_SCORE = 0.9;

export default async function MatchPerfeitoPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  const families = await findMatchedFamiliesForCaregiver(session.user.id);

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <BackLink href="/dashboard/cuidador" />

        <h1 className="mb-1 font-display text-3xl font-semibold text-ink">
          Match perfeito
        </h1>
        <p className="mb-6 text-sm text-muted">
          As famílias mais compatíveis com o seu perfil, considerando todas
          as famílias e cuidadores disponíveis no momento.
        </p>

        {families.length === 0 && (
          <p className="text-sm text-muted">
            Nenhuma família foi designada a você nesta rodada de matching.
          </p>
        )}

        <div className="space-y-5">
          {families.map((family) => (
            <div
              key={family.familyId}
              className="rounded-card border border-muted/20 bg-white p-6 shadow-sm sm:p-8"
            >
              <div className="flex items-start gap-4">
                <AvatarPlaceholder name={family.name} />
                <div>
                  <h2 className="font-display text-xl font-semibold text-ink">
                    <Link
                      href={`/dashboard/profile/family/${family.familyId}`}
                      className="hover:underline"
                    >
                      {family.name ?? "Família"}
                    </Link>
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    {[family.city, family.state].filter(Boolean).join(", ")}
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    Busca cuidado para{" "}
                    {family.neededCareTypes
                      .map((type) => CARE_TYPE_LABELS[type] ?? type)
                      .join(", ")}
                  </p>
                  <p className="mt-2 font-mono text-xs text-ink/80">
                    {family.distanceBand !== null
                      ? `${formatDistanceBand(family.distanceBand)} de distância`
                      : "Distância não disponível"}
                    {family.sharedCareTypes.length > 0 &&
                      ` · Busca cuidado para ${formatCareTypes(family.sharedCareTypes)}`}
                  </p>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <ConnectionLine matchScore={STABLE_MATCH_VISUAL_SCORE} />
                <InteresseButton
                  familyUserId={family.familyId}
                  sharedCareTypes={family.sharedCareTypes}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

import { HireStatus } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { StarRating } from "@/app/components/star-rating";
import { BackLink } from "@/app/dashboard/_components/back-link";
import { CopyPhoneButton } from "@/app/dashboard/hires/[id]/_components/copy-phone-button";
import { authOptions } from "@/lib/auth";
import { CARE_TYPE_LABELS } from "@/lib/care-types";
import { formatDuration } from "@/lib/duration";
import { tryDecryptField } from "@/lib/field-encryption";
import { getHireDirectionLabel, HIRE_STATUS_LABELS } from "@/lib/hire-labels";
import { buildWhatsAppUrl, formatPhoneForDisplay } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { formatRelativeTime } from "@/lib/relative-time";
import { secondaryButtonClass } from "@/lib/ui";

function formatTimelineEntry(date: Date): string {
  return `${date.toLocaleString("pt-BR")} (${formatRelativeTime(date)})`;
}

// Compartilhada pelos dois lados de um Hire (família e cuidador) --
// diferente de /dashboard/familia/contratacoes e
// /dashboard/cuidador/solicitacoes, que cada uma só consulta os próprios
// Hires do usuário logado, esta página recebe um id arbitrário da URL e
// precisa verificar a participação por conta própria.
export default async function HireDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  const { id } = await params;

  const hire = await prisma.hire.findUnique({
    where: { id },
    include: {
      family: {
        select: {
          name: true,
          email: true,
          familyProfile: { select: { phone: true } },
        },
      },
      caregiver: {
        select: {
          name: true,
          email: true,
          caregiverProfile: { select: { phone: true } },
        },
      },
      review: { include: { author: { select: { name: true } } } },
    },
  });

  const isFamily = hire?.familyId === session.user.id;
  const isCaregiver = hire?.caregiverId === session.user.id;

  // Unificado num único 404 tanto para "não existe" quanto para "não é
  // participante" -- diferenciar os dois (403 vs 404) vazaria para um
  // estranho logado a informação de que um determinado id de Hire existe,
  // mesmo que ele não possa ver o conteúdo.
  if (!hire || (!isFamily && !isCaregiver)) {
    notFound();
  }

  const otherParty = isFamily ? hire.caregiver : hire.family;
  const otherPartyProfileHref = isFamily
    ? `/dashboard/profile/caregiver/${hire.caregiverId}`
    : `/dashboard/profile/family/${hire.familyId}`;
  const backHref = isFamily
    ? "/dashboard/familia/contratacoes"
    : "/dashboard/cuidador/solicitacoes";

  // A informação de contato só aparece depois que o acordo está confirmado
  // (ACCEPTED/COMPLETED) -- nunca enquanto ainda PENDING (não há nada para
  // contatar ainda) nem depois de REJECTED/CANCELLED (a relação nunca se
  // concretizou).
  const canShowContact =
    hire.status === HireStatus.ACCEPTED || hire.status === HireStatus.COMPLETED;

  // O telefone fica cifrado no banco (ver lib/field-encryption.ts) e só é
  // decifrado aqui, DEPOIS da checagem de status: enquanto a contratação
  // não foi aceita, a decifração nem chega a acontecer.
  const otherPartyPhone = !canShowContact
    ? null
    : isFamily
      ? tryDecryptField(
          hire.caregiver.caregiverProfile?.phone,
          "caregiverProfile.phone",
          hire.caregiverId
        )
      : tryDecryptField(
          hire.family.familyProfile?.phone,
          "familyProfile.phone",
          hire.familyId
        );

  const durationLabel =
    hire.acceptedAt && hire.completedAt
      ? formatDuration(hire.completedAt.getTime() - hire.acceptedAt.getTime())
      : "Duração não disponível";

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <BackLink href={backHref} />

        <div className="rounded-card border border-muted/20 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-2xl font-semibold text-ink">
                <Link href={otherPartyProfileHref} className="hover:underline">
                  {otherParty.name ?? otherParty.email}
                </Link>
              </h1>
              <span className="mt-1 inline-block rounded-full border border-muted/30 px-2 py-0.5 text-xs text-muted">
                {getHireDirectionLabel(hire.initiatedBy, session.user.role)}
              </span>
              <p className="mt-2 text-sm text-ink/80">
                Tipo de cuidado:{" "}
                {hire.careType
                  ? (CARE_TYPE_LABELS[hire.careType] ?? hire.careType)
                  : "Tipo não especificado"}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-primary-light px-3 py-1 text-sm font-medium text-primary">
              {HIRE_STATUS_LABELS[hire.status]}
            </span>
          </div>

          {canShowContact && otherPartyPhone && (
            <div className="mt-6">
              <h2 className="text-xs font-medium uppercase text-muted">
                Contato
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm font-medium text-ink">
                  {formatPhoneForDisplay(otherPartyPhone)}
                </span>
                <CopyPhoneButton phone={formatPhoneForDisplay(otherPartyPhone)} />
                <a
                  href={buildWhatsAppUrl(otherPartyPhone)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={secondaryButtonClass}
                >
                  WhatsApp
                </a>
              </div>
            </div>
          )}

          {hire.message && (
            <div className="mt-6">
              <h2 className="text-xs font-medium uppercase text-muted">
                Mensagem original
              </h2>
              <p className="mt-1 text-sm text-ink/80">{hire.message}</p>
            </div>
          )}

          <div className="mt-6">
            <h2 className="text-xs font-medium uppercase text-muted">
              Linha do tempo
            </h2>
            <dl className="mt-2 space-y-2">
              <div>
                <dt className="text-xs text-muted">Criado em</dt>
                <dd className="text-sm text-ink/80">
                  {formatTimelineEntry(hire.createdAt)}
                </dd>
              </div>
              {hire.acceptedAt && (
                <div>
                  <dt className="text-xs text-muted">Aceito em</dt>
                  <dd className="text-sm text-ink/80">
                    {formatTimelineEntry(hire.acceptedAt)}
                  </dd>
                </div>
              )}
              {hire.completedAt && (
                <div>
                  <dt className="text-xs text-muted">Concluído em</dt>
                  <dd className="text-sm text-ink/80">
                    {formatTimelineEntry(hire.completedAt)}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <div className="mt-6">
            <h2 className="text-xs font-medium uppercase text-muted">
              Duração do serviço
            </h2>
            <p className="mt-1 text-sm text-ink/80">{durationLabel}</p>
          </div>

          {hire.review && (
            <div className="mt-6 border-t border-muted/20 pt-6">
              <h2 className="text-xs font-medium uppercase text-muted">
                Avaliação
              </h2>
              <div className="mt-2 flex items-center justify-between gap-4">
                {/* review.authorId é sempre o User.id de uma família -- ver CLAUDE.md "Sistema de Review" */}
                <Link
                  href={`/dashboard/profile/family/${hire.review.authorId}`}
                  className="text-sm text-ink/80 hover:underline"
                >
                  {hire.review.author.name ?? "Família"}
                </Link>
                <StarRating value={hire.review.rating} readOnly />
              </div>
              {hire.review.comment && (
                <p className="mt-2 text-sm text-ink/80">{hire.review.comment}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

import { Hire, HireInitiator, HireStatus, Role } from "@prisma/client";

import { tryDecryptField } from "@/lib/field-encryption";
import { prisma } from "@/lib/prisma";

// Direitos do titular da LGPD (art. 18) que dependem do próprio sistema:
// acesso e portabilidade (exportação) e eliminação (exclusão da conta).
// Só server-side: decifra telefone e endereço (ver lib/field-encryption.ts).

/**
 * Todos os dados pessoais da conta, em formato estruturado (JSON), com
 * telefone e endereço já decifrados -- o titular tem direito ao dado, não ao
 * valor cifrado. Arquivos de documentos não entram, só os metadados.
 */
export async function buildAccountExport(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      familyProfile: true,
      caregiverProfile: {
        include: {
          documents: { select: { type: true, status: true, uploadedAt: true, reviewedAt: true } },
        },
      },
      hiresAsFamily: { include: { caregiver: { select: { name: true } } } },
      hiresAsCaregiver: { include: { family: { select: { name: true } } } },
      reviewsWritten: { select: { rating: true, comment: true, createdAt: true } },
      reviewsReceived: { select: { rating: true, comment: true, createdAt: true } },
    },
  });

  if (!user) {
    return null;
  }

  const { familyProfile, caregiverProfile } = user;

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      name: user.name,
      email: user.email,
      birthDate: user.birthDate,
      role: user.role,
      createdAt: user.createdAt,
      privacyAcceptedAt: user.privacyAcceptedAt,
    },
    familyProfile: familyProfile && {
      ...familyProfile,
      phone: tryDecryptField(familyProfile.phone, "familyProfile.phone", user.id),
      address: tryDecryptField(familyProfile.address, "familyProfile.address", user.id),
    },
    caregiverProfile: caregiverProfile && {
      ...caregiverProfile,
      phone: tryDecryptField(caregiverProfile.phone, "caregiverProfile.phone", user.id),
    },
    hires: [
      ...user.hiresAsFamily.map((hire) => exportHire(hire, hire.caregiver.name)),
      ...user.hiresAsCaregiver.map((hire) => exportHire(hire, hire.family.name)),
    ],
    reviewsWritten: user.reviewsWritten,
    reviewsReceived: user.reviewsReceived,
  };
}

// Campos de uma contratação que interessam ao titular; activeHireKey é
// controle interno de unicidade, sem significado para ele.
function exportHire(hire: Hire, otherPartyName: string | null) {
  return {
    id: hire.id,
    status: hire.status,
    initiatedBy: hire.initiatedBy,
    careType: hire.careType,
    message: hire.message,
    createdAt: hire.createdAt,
    acceptedAt: hire.acceptedAt,
    completedAt: hire.completedAt,
    otherPartyName,
  };
}

export const DELETED_ACCOUNT_NAME = "Conta excluída";

/**
 * Exclui a conta: apaga o que é só do titular e anonimiza o que também
 * pertence ao histórico de outra pessoa. Contratações e notas de avaliação
 * continuam existindo (são parte do histórico da outra parte), mas sem o
 * nome, o e-mail ou os textos escritos pelo titular. Devolve os caminhos dos
 * documentos no Storage, que o chamador remove depois da transação -- uma
 * chamada de rede não deve segurar a transação aberta (mesmo motivo da
 * geocodificação no cadastro).
 */
export async function deleteAccount(userId: string, role: Role): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const documents = await tx.document.findMany({
      where: { caregiver: { userId } },
      select: { fileUrl: true },
    });

    // Contratações em andamento não podem continuar com uma parte que não
    // existe mais.
    await tx.hire.updateMany({
      where: {
        OR: [{ familyId: userId }, { caregiverId: userId }],
        status: { in: [HireStatus.PENDING, HireStatus.ACCEPTED] },
      },
      data: { status: HireStatus.CANCELLED, activeHireKey: null },
    });

    // A mensagem inicial foi escrita por quem iniciou a contratação.
    const initiatedBy = role === Role.FAMILY ? HireInitiator.FAMILY : HireInitiator.CAREGIVER;
    await tx.hire.updateMany({
      where: {
        OR: [{ familyId: userId }, { caregiverId: userId }],
        initiatedBy,
      },
      data: { message: null },
    });

    // Comentários escritos pelo titular saem; a nota fica, para não alterar
    // a reputação que o cuidador avaliado construiu.
    await tx.review.updateMany({ where: { authorId: userId }, data: { comment: null } });
    // Avaliações recebidas são sobre um perfil que deixa de existir.
    await tx.review.deleteMany({ where: { targetId: userId } });

    // Documentos são apagados em cascata junto com o perfil do cuidador.
    await tx.familyProfile.deleteMany({ where: { userId } });
    await tx.caregiverProfile.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });

    // O registro de User fica (as contratações apontam para ele), mas sem
    // nenhum dado pessoal e sem senha -- não é mais possível entrar nele.
    await tx.user.update({
      where: { id: userId },
      data: {
        name: DELETED_ACCOUNT_NAME,
        email: `excluida-${userId}@conta-excluida.invalid`,
        password: null,
        image: null,
        birthDate: null,
        emailVerified: null,
        privacyAcceptedAt: null,
      },
    });

    return documents.map((document) => document.fileUrl);
  });
}

import { HireStatus, Prisma, Role } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateAverageRating } from "@/lib/reviews";

const createReviewSchema = z.object({
  hireId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  if (session.user.role !== Role.FAMILY) {
    return NextResponse.json(
      { error: "Acesso restrito a famílias" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const parsed = createReviewSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { hireId, rating, comment } = parsed.data;

  const hire = await prisma.hire.findUnique({ where: { id: hireId } });

  if (!hire) {
    return NextResponse.json(
      { error: "Contratação não encontrada" },
      { status: 404 }
    );
  }

  if (hire.familyId !== session.user.id) {
    return NextResponse.json(
      { error: "Você não participa desta contratação" },
      { status: 403 }
    );
  }

  if (hire.status !== HireStatus.COMPLETED) {
    return NextResponse.json(
      { error: "Só é possível avaliar contratações concluídas" },
      { status: 400 }
    );
  }

  try {
    const review = await prisma.review.create({
      data: {
        hireId,
        authorId: session.user.id,
        targetId: hire.caregiverId,
        rating,
        comment,
      },
    });

    return NextResponse.json({ review }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Rede de segurança contra race condition: duas requisições
      // concorrentes passaram nas checagens de status/propriedade acima
      // antes que qualquer uma delas tivesse confirmado uma linha.
      return NextResponse.json(
        { error: "Essa contratação já foi avaliada" },
        { status: 409 }
      );
    }

    throw error;
  }
}

// Exige login (era pública): sem isso, um visitante anônimo descobria o
// nome de quem contratou cada cuidador e o comentário que essa pessoa
// escreveu (ver docs/lgpd.md, lacuna 8). A resposta também deixou de
// devolver os registros inteiros -- ids de contratação e de autor não têm
// utilidade para quem só quer ler as avaliações.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const caregiverId = searchParams.get("caregiverId");

  if (!caregiverId) {
    return NextResponse.json(
      { error: "Parâmetro caregiverId é obrigatório" },
      { status: 400 }
    );
  }

  const reviews = await prisma.review.findMany({
    where: { targetId: caregiverId },
    select: {
      id: true,
      rating: true,
      comment: true,
      createdAt: true,
      author: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const { average, total } = calculateAverageRating(
    reviews.map((review) => review.rating)
  );

  return NextResponse.json({
    reviews: reviews.map(({ author, ...review }) => ({
      ...review,
      authorFirstName: author.name?.trim().split(/\s+/)[0] ?? null,
    })),
    average,
    total,
  });
}

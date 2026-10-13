import { Role } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { formatDistanceBand } from "@/lib/location-privacy";
import { rankFamiliesForCaregiver, toFamilySearchResult } from "@/lib/matching";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  if (session.user.role !== Role.CAREGIVER) {
    return NextResponse.json(
      { error: "Acesso restrito a cuidadores" },
      { status: 403 }
    );
  }

  const caregiverProfile = await prisma.caregiverProfile.findUnique({
    where: { userId: session.user.id },
  });

  if (!caregiverProfile) {
    return NextResponse.json(
      { error: "Perfil não encontrado" },
      { status: 404 }
    );
  }

  if (caregiverProfile.latitude === null || caregiverProfile.longitude === null) {
    return NextResponse.json(
      {
        error:
          "Complete seu endereço no perfil para buscar famílias próximas.",
      },
      { status: 400 }
    );
  }

  if (caregiverProfile.careTypes.length === 0) {
    // Mesma distinção "perfil incompleto, não um problema da requisição"
    // de GET /api/search/caregivers -- `reason` permite que uma UI futura
    // mostre um CTA "complete seu perfil" em vez de uma mensagem genérica.
    return NextResponse.json(
      {
        error:
          "Complete seu perfil com os tipos de cuidado que você oferece antes de buscar famílias.",
        reason: "incomplete_profile",
      },
      { status: 400 }
    );
  }

  const ranked = await rankFamiliesForCaregiver(caregiverProfile);

  // Sem `address`, coordenadas nem distância exata -- ver FamilySearchResult
  // em lib/matching.ts.
  const results = ranked.map(toFamilySearchResult).map(({ family, distanceBand, matchScore }) => ({
    familyId: family.userId,
    name: family.name,
    city: family.city,
    state: family.state,
    neededCareTypes: family.neededCareTypes,
    distance: formatDistanceBand(distanceBand),
    matchScore: Math.round(matchScore * 1000) / 1000,
  }));

  return NextResponse.json({ results });
}

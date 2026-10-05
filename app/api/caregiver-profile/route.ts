import {
  CaregiverAvailability,
  CaregiverProfile,
  CareType,
  Prisma,
  Role,
} from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { encryptOptionalField, tryDecryptField } from "@/lib/field-encryption";
import { buildGeocodeQuery, geocodeAddress } from "@/lib/geocoding";
import { PHONE_INVALID_MESSAGE, PHONE_REGEX } from "@/lib/phone";
import { prisma } from "@/lib/prisma";

const updateSchema = z.object({
  phone: z.string().regex(PHONE_REGEX, PHONE_INVALID_MESSAGE).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  bio: z.string().optional(),
  hourlyRate: z.number().positive().optional(),
  experienceYears: z.number().int().nonnegative().optional(),
  careTypes: z.array(z.nativeEnum(CareType)).optional(),
  visibleToFamilies: z.boolean().optional(),
  availabilityStatus: z.nativeEnum(CaregiverAvailability).optional(),
});

// O telefone fica cifrado no banco (ver lib/field-encryption.ts); a resposta
// para o próprio dono do perfil devolve o valor decifrado.
function decryptProfile(profile: CaregiverProfile) {
  return {
    ...profile,
    phone: tryDecryptField(profile.phone, "caregiverProfile.phone", profile.userId),
  };
}

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

  const profile = await prisma.caregiverProfile.findUnique({
    where: { userId: session.user.id },
  });

  return NextResponse.json({ profile: profile ? decryptProfile(profile) : null });
}

export async function PATCH(request: Request) {
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

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const current = await prisma.caregiverProfile.findUnique({
    where: { userId: session.user.id },
  });

  if (!current) {
    return NextResponse.json(
      { error: "Perfil não encontrado" },
      { status: 404 }
    );
  }

  const userId = session.user.id;
  const { phone, ...data } = parsed.data;

  const addressChanged =
    (data.city !== undefined && data.city !== current.city) ||
    (data.state !== undefined && data.state !== current.state);

  let geocodedFields: { latitude: number | null; longitude: number | null } | undefined;

  if (addressChanged) {
    const nextCity = data.city !== undefined ? data.city : current.city;
    const nextState = data.state !== undefined ? data.state : current.state;
    const addressQuery = buildGeocodeQuery([nextCity, nextState]);
    const geocoded = addressQuery ? await geocodeAddress(addressQuery) : null;

    geocodedFields = {
      latitude: geocoded?.latitude ?? null,
      longitude: geocoded?.longitude ?? null,
    };
  }

  try {
    const profile = await prisma.caregiverProfile.update({
      where: { userId },
      data: {
        ...data,
        // `undefined` (campo não enviado) continua significando "não alterar".
        phone: encryptOptionalField(phone, "caregiverProfile.phone", userId),
        ...geocodedFields,
      },
    });

    return NextResponse.json({ profile: decryptProfile(profile) });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Perfil não encontrado" },
        { status: 404 }
      );
    }

    throw error;
  }
}

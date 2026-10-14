import { Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { encryptField } from "@/lib/field-encryption";
import { buildGeocodeQuery, geocodeAddress } from "@/lib/geocoding";
import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/lib/register-schema";

const BCRYPT_SALT_ROUNDS = 12;

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;
  const hashedPassword = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);

  // Geocodifica antes de abrir a transação do Prisma: o Nominatim tem limite
  // de 1 requisição/seg e pode demorar para responder, e uma transação
  // interativa tem um timeout curto — uma chamada HTTP externa dentro dela
  // arrisca abortar todo o cadastro por causa de uma requisição de
  // geocodificação lenta.
  const addressQuery =
    data.role === Role.FAMILY
      ? buildGeocodeQuery([data.address, data.city, data.state])
      : buildGeocodeQuery([data.city, data.state]);

  const geocoded = addressQuery ? await geocodeAddress(addressQuery) : null;

  try {
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: data.email,
          name: data.name,
          birthDate: data.birthDate,
          password: hashedPassword,
          role: data.role,
          privacyAcceptedAt: new Date(),
        },
      });

      // Telefone e endereço são cifrados aqui dentro, e não antes da
      // transação, porque a AAD da criptografia usa o id do usuário -- que
      // só existe depois do `user.create` acima (ver lib/field-encryption.ts).
      // A geocodificação já usou o endereço em texto puro antes, em memória.
      if (data.role === Role.FAMILY) {
        await tx.familyProfile.create({
          data: {
            userId: createdUser.id,
            phone: encryptField(data.phone, "familyProfile.phone", createdUser.id),
            city: data.city,
            state: data.state,
            address: encryptField(data.address, "familyProfile.address", createdUser.id),
            bio: data.bio?.trim() || null,
            healthDataConsentAt: data.healthDataConsent ? new Date() : null,
            hourlyBudget: data.hourlyBudget,
            neededCareTypes: data.neededCareTypes ?? [],
            visibleToCaregivers: data.visibleToCaregivers,
            latitude: geocoded?.latitude,
            longitude: geocoded?.longitude,
          },
        });
      } else {
        await tx.caregiverProfile.create({
          data: {
            userId: createdUser.id,
            phone: encryptField(data.phone, "caregiverProfile.phone", createdUser.id),
            city: data.city,
            state: data.state,
            bio: data.bio,
            hourlyRate: data.hourlyRate,
            experienceYears: data.experienceYears,
            careTypes: data.careTypes ?? [],
            latitude: geocoded?.latitude,
            longitude: geocoded?.longitude,
          },
        });
      }

      return createdUser;
    }, { timeout: 15000 });

    return NextResponse.json(
      { id: user.id, email: user.email, role: user.role },
      { status: 201 }
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Este email já está cadastrado" },
        { status: 409 }
      );
    }

    throw error;
  }
}

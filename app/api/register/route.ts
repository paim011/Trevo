import { CareType, Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isAdult,
  isBirthDateInFuture,
  isBirthDateTooOld,
  MIN_BIRTH_YEAR,
  MIN_REGISTRATION_AGE,
} from "@/lib/age";
import { BR_STATE_UFS } from "@/lib/br-states";
import { encryptField } from "@/lib/field-encryption";
import { buildGeocodeQuery, geocodeAddress } from "@/lib/geocoding";
import { PHONE_INVALID_MESSAGE, PHONE_REGEX } from "@/lib/phone";
import { prisma } from "@/lib/prisma";

const BCRYPT_SALT_ROUNDS = 12;

// Compartilhado pelos dois branches: name/birthDate/phone/city/state são
// obrigatórios para todos. `address` é só da família abaixo --
// CaregiverProfile não tem coluna de endereço (ver CLAUDE.md
// "Geolocalização"), então não há o que exigir para cuidadores.
const baseFields = {
  email: z.string().email("Email inválido"),
  password: z.string().min(8, "A senha deve ter pelo menos 8 caracteres"),
  name: z.string().min(1, "Nome é obrigatório"),
  // A ordem importa: uma data absurda (ex.: um ano digitado errado, sem
  // limite) deve aparecer como um erro de intervalo, não como a mensagem
  // confusa "você precisa ter 18+".
  birthDate: z.coerce
    .date()
    .refine((date) => !isBirthDateInFuture(date), {
      message: "Data de nascimento não pode ser no futuro",
    })
    .refine((date) => !isBirthDateTooOld(date), {
      message: `Data de nascimento não pode ser anterior a ${MIN_BIRTH_YEAR}`,
    })
    .refine(isAdult, {
      message: `Você precisa ter pelo menos ${MIN_REGISTRATION_AGE} anos para se cadastrar`,
    }),
  phone: z.string().regex(PHONE_REGEX, PHONE_INVALID_MESSAGE),
  city: z.string().min(1, "Cidade é obrigatória"),
  state: z.enum(BR_STATE_UFS, { message: "Selecione um estado válido" }),
  // Registrado em User.privacyAcceptedAt. `literal(true)`: sem o aceite não
  // há cadastro (ver app/privacidade/page.tsx).
  acceptPrivacyPolicy: z.literal(true, {
    message: "É preciso aceitar a política de privacidade",
  }),
};

const familySchema = z.object({
  ...baseFields,
  role: z.literal(Role.FAMILY),
  address: z.string().min(1, "Endereço é obrigatório"),
  bio: z.string().optional(),
  healthDataConsent: z.boolean().optional(),
  hourlyBudget: z.number().positive().optional(),
  neededCareTypes: z.array(z.nativeEnum(CareType)).optional(),
  visibleToCaregivers: z.boolean().optional(),
}).refine((data) => !data.bio?.trim() || data.healthDataConsent === true, {
  // Mesma regra de PATCH /api/family-profile: a descrição pode conter
  // informações de saúde (dado sensível, LGPD art. 11, I), então só é
  // gravada com consentimento específico.
  message: "Para incluir uma descrição, autorize o tratamento das informações de saúde",
  path: ["healthDataConsent"],
});

const caregiverSchema = z.object({
  ...baseFields,
  role: z.literal(Role.CAREGIVER),
  bio: z.string().optional(),
  hourlyRate: z.number().positive().optional(),
  experienceYears: z.number().int().nonnegative().optional(),
  careTypes: z.array(z.nativeEnum(CareType)).optional(),
});

const registerSchema = z.discriminatedUnion("role", [
  familySchema,
  caregiverSchema,
]);

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

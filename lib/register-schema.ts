import { CareType, Role } from "@prisma/client";
import { z } from "zod";

import {
  isAdult,
  isBirthDateInFuture,
  isBirthDateTooOld,
  MIN_BIRTH_YEAR,
  MIN_REGISTRATION_AGE,
} from "@/lib/age";
import { BR_STATE_UFS } from "@/lib/br-states";
import { PHONE_INVALID_MESSAGE, PHONE_REGEX } from "@/lib/phone";

// Validação do cadastro público (POST /api/register). Fica fora do arquivo da
// rota porque um route handler do Next.js só pode exportar os métodos HTTP, e
// o schema também é usado por scripts/test-security.ts para provar que o papel
// ADMIN é recusado sem precisar enviar uma requisição ao servidor.

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

export const registerSchema = z.discriminatedUnion("role", [
  familySchema,
  caregiverSchema,
]);

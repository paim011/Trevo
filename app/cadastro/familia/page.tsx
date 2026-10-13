"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { BirthDateInput } from "@/app/components/birth-date-input";
import {
  HealthDataConsentCheckbox,
  PrivacyPolicyCheckbox,
} from "@/app/components/consent-checkboxes";
import { LocationFields } from "@/app/components/location-fields";
import { PhoneInput } from "@/app/components/phone-input";
import { RequiredMark } from "@/app/components/required-mark";
import {
  formatDateInputValue,
  isAdult,
  isBirthDateInFuture,
  isBirthDateTooOld,
  MIN_BIRTH_DATE,
  MIN_REGISTRATION_AGE,
  parseBirthDateInput,
} from "@/lib/age";
import { firstApiErrorMessage } from "@/lib/api-error";
import { isCompletePhone, PHONE_INVALID_MESSAGE } from "@/lib/phone";
import {
  blurOnWheel,
  cardClass,
  errorTextClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/lib/ui";

const CARE_TYPES = [
  { value: "ELDERLY", label: "Idosos" },
  { value: "CHILD", label: "Crianças" },
  { value: "SPECIAL_NEEDS", label: "Pessoas com necessidades especiais" },
] as const;

const INITIAL_FORM = {
  name: "",
  email: "",
  password: "",
  phone: "",
  birthDate: "",
  city: "",
  state: "",
  address: "",
  bio: "",
  hourlyBudget: "",
};

export default function CadastroFamiliaPage() {
  const router = useRouter();
  const [form, setForm] = useState(INITIAL_FORM);
  const [neededCareTypes, setNeededCareTypes] = useState<string[]>([]);
  const [visibleToCaregivers, setVisibleToCaregivers] = useState(true);
  const [healthDataConsent, setHealthDataConsent] = useState(false);
  const [acceptPrivacyPolicy, setAcceptPrivacyPolicy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleNeededCareType(value: string) {
    setNeededCareTypes((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Checagens no cliente para feedback instantâneo -- o servidor (app/api
    // /register/route.ts) revalida tudo isso de forma autoritativa via os
    // mesmos helpers de lib/age.ts/lib/phone.ts, então nada disso pode ser
    // contornado pulando a UI. parseBirthDateInput rejeita tanto entrada
    // incompleta (menos de 8 dígitos digitados) quanto datas
    // calendário-impossíveis (ex.: 31/02) de antemão.
    if (!isCompletePhone(form.phone)) {
      setError(PHONE_INVALID_MESSAGE);
      return;
    }

    const birthDateValue = parseBirthDateInput(form.birthDate);
    if (!birthDateValue) {
      setError("Data de nascimento inválida ou incompleta.");
      return;
    }
    if (isBirthDateInFuture(birthDateValue)) {
      setError("Data de nascimento não pode ser no futuro.");
      return;
    }
    if (isBirthDateTooOld(birthDateValue)) {
      setError(`Data de nascimento não pode ser anterior a ${MIN_BIRTH_DATE.getFullYear()}.`);
      return;
    }
    if (!isAdult(birthDateValue)) {
      setError(
        `Você precisa ter pelo menos ${MIN_REGISTRATION_AGE} anos para se cadastrar.`
      );
      return;
    }

    if (form.bio.trim() && !healthDataConsent) {
      setError(
        "Para incluir uma descrição, autorize o tratamento das informações de saúde (ou deixe a descrição em branco)."
      );
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          password: form.password,
          role: "FAMILY",
          phone: form.phone,
          birthDate: formatDateInputValue(birthDateValue),
          city: form.city,
          state: form.state,
          address: form.address,
          bio: form.bio || undefined,
          hourlyBudget: form.hourlyBudget ? Number(form.hourlyBudget) : undefined,
          neededCareTypes,
          visibleToCaregivers,
          healthDataConsent,
          acceptPrivacyPolicy,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(firstApiErrorMessage(data, "Não foi possível concluir o cadastro."));
        setLoading(false);
        return;
      }

      const result = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      });

      if (!result || result.error) {
        setError(
          "Cadastro concluído, mas não foi possível entrar automaticamente. Tente fazer login."
        );
        setLoading(false);
        return;
      }

      router.push("/dashboard/familia");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className={cardClass}>
        <Link
          href="/cadastro"
          className={`${secondaryButtonClass} mb-6 inline-block`}
        >
          ← Voltar
        </Link>

        <h1 className="mb-1 font-display text-2xl font-semibold text-ink">
          Cadastro de família
        </h1>
        <p className="mb-6 text-sm text-muted">
          Crie sua conta para encontrar um cuidador.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className={labelClass}>
              Nome completo
              <RequiredMark />
            </label>
            <input
              id="name"
              type="text"
              required
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
              <RequiredMark />
            </label>
            <input
              id="email"
              type="email"
              required
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>
              Senha
              <RequiredMark />
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(event) => update("password", event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="phone" className={labelClass}>
              Telefone
              <RequiredMark />
            </label>
            <PhoneInput
              id="phone"
              value={form.phone}
              onChange={(value) => update("phone", value)}
            />
          </div>
          <div>
            <label htmlFor="birthDate" className={labelClass}>
              Data de nascimento
              <RequiredMark />
            </label>
            <BirthDateInput
              id="birthDate"
              required
              value={form.birthDate}
              onChange={(value) => update("birthDate", value)}
            />
          </div>
          <LocationFields
            state={form.state}
            city={form.city}
            onStateChange={(value) =>
              setForm((prev) => ({ ...prev, state: value, city: "" }))
            }
            onCityChange={(value) => update("city", value)}
            required
          />
          <div>
            <label htmlFor="address" className={labelClass}>
              Endereço
              <RequiredMark />
            </label>
            <input
              id="address"
              type="text"
              required
              value={form.address}
              onChange={(event) => update("address", event.target.value)}
              className={inputClass}
            />
          </div>
          <fieldset>
            <legend className={labelClass}>Que tipo de cuidado você procura?</legend>
            <div className="space-y-2">
              {CARE_TYPES.map((type) => (
                <label key={type.value} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={neededCareTypes.includes(type.value)}
                    onChange={() => toggleNeededCareType(type.value)}
                    className="h-4 w-4 rounded border-muted/40 text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                  {type.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="hourlyBudget" className={labelClass}>
              Quanto você pode pagar por hora (R$)
            </label>
            <input
              id="hourlyBudget"
              type="number"
              min="0"
              step="0.01"
              value={form.hourlyBudget}
              onChange={(event) => update("hourlyBudget", event.target.value)}
              onWheel={blurOnWheel}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="bio" className={labelClass}>
              Sobre você
            </label>
            <textarea
              id="bio"
              rows={3}
              value={form.bio}
              onChange={(event) => update("bio", event.target.value)}
              className={inputClass}
            />
          </div>
          <HealthDataConsentCheckbox
            checked={healthDataConsent}
            onChange={setHealthDataConsent}
          />
          <div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={visibleToCaregivers}
                onChange={(event) => setVisibleToCaregivers(event.target.checked)}
                className="h-4 w-4 rounded border-muted/40 text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
              Permitir que cuidadores me encontrem e demonstrem interesse
            </label>
            <p className="mt-1 text-xs text-muted">
              Se desativado, seu perfil não aparece nas buscas nem no match
              perfeito de nenhum cuidador -- você ainda pode buscar e
              contratar cuidadores normalmente.
            </p>
          </div>

          <PrivacyPolicyCheckbox
            checked={acceptPrivacyPolicy}
            onChange={setAcceptPrivacyPolicy}
          />

          {error && <p className={errorTextClass}>{error}</p>}

          <button type="submit" disabled={loading} className={primaryButtonClass}>
            {loading ? "Criando conta..." : "Criar conta"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-muted">
          Já tem conta?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Entrar
          </Link>
        </p>
      </div>
    </main>
  );
}

import { FileCheck, Lock, ShieldCheck, Star, UserPlus, Users } from "lucide-react";
import Link from "next/link";

import { ConnectionLine } from "@/app/dashboard/familia/_components/connection-line";
import { TrevoLogo } from "@/app/components/trevo-logo";
import { siteConfig } from "@/lib/site-config";
import { contentCardClass, heroButtonClass, heroOutlineButtonClass } from "@/lib/ui";

const STEPS = [
  {
    icon: UserPlus,
    title: "Crie seu perfil",
    description: "Família ou cuidador, o cadastro leva poucos minutos.",
  },
  {
    icon: Users,
    title: "Encontre o match ideal",
    description:
      "Buscamos por proximidade, tipo de cuidado, avaliação e preço.",
  },
  {
    icon: ShieldCheck,
    title: "Contrate com segurança",
    description: "Combine os detalhes e acompanhe tudo pelo próprio Trevo.",
  },
];

const TRUST_POINTS = [
  {
    icon: Lock,
    title: "Dados protegidos",
    description: "Senhas armazenadas com criptografia, nunca em texto puro.",
  },
  {
    icon: FileCheck,
    title: "Documentos verificados",
    description: "Cuidadores enviam documentos para análise antes de atender.",
  },
  {
    icon: Star,
    title: "Avaliações reais",
    description: "Famílias avaliam cuidadores após cada contratação concluída.",
  },
];

function HeroCtas() {
  return (
    <div className="mx-auto mt-8 flex max-w-md flex-col gap-4 sm:max-w-none sm:flex-row sm:justify-center">
      <Link href="/cadastro/familia" className={heroButtonClass}>
        Sou família, buscar cuidador
      </Link>
      <Link href="/cadastro/cuidador" className={heroOutlineButtonClass}>
        Sou cuidador, quero atender
      </Link>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="flex-1">
      {/* HERO */}
      <section className="px-4 pb-20 pt-8 text-center sm:pb-28 sm:pt-10">
        <TrevoLogo className="mx-auto h-24 w-24 sm:h-28 sm:w-28" />
        <h1 className="mt-4 font-display text-5xl font-bold text-ink sm:text-6xl">
          {siteConfig.name}
        </h1>
        <p className="mt-3 font-display text-xl font-semibold text-primary sm:text-2xl">
          {siteConfig.tagline}
        </p>
        <p className="mx-auto mt-6 max-w-xl text-base text-muted sm:text-lg">
          Um marketplace para encontrar cuidadores de confiança para idosos,
          crianças e pessoas com necessidades especiais, e para cuidadores
          encontrarem famílias que precisam deles.
        </p>
        <HeroCtas />
      </section>

      {/* COMO FUNCIONA */}
      <section id="como-funciona" className="bg-white px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-display text-3xl font-semibold text-ink">
            Como funciona
          </h2>
          <div className="mt-12 flex flex-col items-center gap-6 sm:flex-row sm:items-stretch sm:justify-center sm:gap-2">
            {STEPS.map((step, index) => (
              <div key={step.title} className="flex items-center sm:contents">
                <div
                  className={`${contentCardClass} flex w-full max-w-xs flex-col items-center gap-3 text-center sm:w-60`}
                >
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
                    <step.icon aria-hidden="true" className="h-7 w-7" />
                  </span>
                  <h3 className="font-display text-lg font-semibold text-ink">
                    {step.title}
                  </h3>
                  <p className="text-sm text-muted">{step.description}</p>
                </div>
                {index < STEPS.length - 1 && (
                  <div className="hidden shrink-0 self-center px-1 sm:block">
                    <ConnectionLine matchScore={0.8} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* POR QUE CONFIAR */}
      <section className="px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-display text-3xl font-semibold text-ink">
            Por que confiar
          </h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {TRUST_POINTS.map((point) => (
              <div
                key={point.title}
                className={`${contentCardClass} flex flex-col items-center gap-3 text-center`}
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
                  <point.icon aria-hidden="true" className="h-7 w-7" />
                </span>
                <h3 className="font-display text-lg font-semibold text-ink">
                  {point.title}
                </h3>
                <p className="text-sm text-muted">{point.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA FINAL */}
      <section className="bg-primary-light px-4 py-16 text-center sm:py-20">
        <h2 className="font-display text-2xl font-semibold text-ink sm:text-3xl">
          Pronto(a) para começar?
        </h2>
        <HeroCtas />
      </section>

      {/* RODAPÉ */}
      <footer className="flex items-center justify-center gap-2 border-t border-muted/20 px-4 py-8 text-center text-sm text-muted">
        <TrevoLogo className="h-5 w-5" />
        <span>
          <span className="font-display font-semibold text-ink">
            {siteConfig.name}
          </span>{" "}
          © {new Date().getFullYear()}
        </span>
        <span aria-hidden="true">·</span>
        <Link href="/privacidade" className="hover:text-ink hover:underline">
          Política de privacidade
        </Link>
      </footer>
    </main>
  );
}

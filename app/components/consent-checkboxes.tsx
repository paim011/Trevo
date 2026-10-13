import Link from "next/link";

// Caixas de consentimento usadas no cadastro e na edição do perfil. O
// servidor revalida as duas regras (app/api/register/route.ts e
// app/api/family-profile/route.ts); aqui é só a interface.

const checkboxClass =
  "mt-0.5 h-4 w-4 shrink-0 rounded border-muted/40 text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function PrivacyPolicyCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink">
      <input
        type="checkbox"
        required
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className={checkboxClass}
      />
      <span>
        Li e aceito a{" "}
        <Link
          href="/privacidade"
          target="_blank"
          className="font-medium text-primary hover:underline"
        >
          política de privacidade
        </Link>
        <span className="text-red-600" aria-hidden="true">
          {" "}
          *
        </span>
      </span>
    </label>
  );
}

/**
 * Consentimento específico e destacado (LGPD, art. 11, I) para as
 * informações de saúde que a descrição livre da família pode conter. Fica
 * em destaque, separado do aceite geral da política, como a lei exige.
 */
export function HealthDataConsentCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary-light px-3 py-3">
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className={checkboxClass}
        />
        <span>
          Autorizo o tratamento das informações de saúde que eu incluir na
          descrição, para que cuidadores entendam o cuidado necessário.
        </span>
      </label>
      <p className="mt-2 text-xs text-muted">
        Sem esta autorização a descrição não é salva. Se você retirá-la depois,
        a descrição é apagada. Evite nomes, diagnósticos detalhados e números
        de documentos.
      </p>
    </div>
  );
}

"use client";

import { signOut } from "next-auth/react";
import { useState, type FormEvent } from "react";

import {
  cardClass,
  errorTextClass,
  inputClass,
  labelClass,
  secondaryButtonClass,
} from "@/lib/ui";

// Exportação e exclusão da conta (LGPD, art. 18), abaixo do formulário de
// editar perfil nas duas telas. A regra de negócio está em lib/account.ts;
// aqui é só a interface.
export function AccountDataSection() {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error ?? "Não foi possível excluir a conta.");
        setLoading(false);
        return;
      }

      // A conta não existe mais: encerra a sessão e volta para a home.
      await signOut({ callbackUrl: "/" });
    } catch {
      setError("Erro de conexão. Tente novamente.");
      setLoading(false);
    }
  }

  return (
    <section className={`${cardClass} mt-6`}>
      <h2 className="mb-1 font-display text-xl font-semibold text-ink">Seus dados</h2>
      <p className="mb-4 text-sm text-muted">
        Baixe uma cópia de tudo o que guardamos sobre você ou exclua sua conta.
        Veja a{" "}
        <a href="/privacidade" className="font-medium text-primary hover:underline">
          política de privacidade
        </a>
        .
      </p>

      <a
        href="/api/account/export"
        download
        className={`${secondaryButtonClass} inline-block`}
      >
        Baixar meus dados (JSON)
      </a>

      <div className="mt-6 border-t border-muted/20 pt-4">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-sm font-medium text-red-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Excluir minha conta
          </button>
        ) : (
          <form onSubmit={handleDelete} className="space-y-3">
            <p className="text-sm text-ink">
              Seu perfil, telefone, endereço, descrição e documentos serão
              apagados. Contratações antigas continuam no histórico da outra
              parte, sem o seu nome. Isso não pode ser desfeito.
            </p>
            <div>
              <label htmlFor="delete-password" className={labelClass}>
                Confirme sua senha
              </label>
              <input
                id="delete-password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
              />
            </div>

            {error && <p className={errorTextClass}>{error}</p>}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-800 disabled:opacity-60 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {loading ? "Excluindo..." : "Excluir definitivamente"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setPassword("");
                  setError(null);
                }}
                className={secondaryButtonClass}
              >
                Cancelar
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

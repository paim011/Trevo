"use client";

import { useEffect, useState } from "react";

type IbgeMunicipio = { id: number; nome: string };

type UseIbgeCitiesResult = {
  cities: string[];
  loading: boolean;
  error: string | null;
};

// Resultado da última busca, guardado junto com a UF a que se refere: assim,
// "carregando" é derivado (a UF pedida ainda não tem resultado) em vez de ser
// um estado ligado e desligado dentro do efeito.
type FetchResult = { uf: string; cities: string[]; error: string | null };

const LOAD_ERROR_MESSAGE =
  "Não foi possível carregar a lista de cidades agora. Digite o nome da cidade manualmente.";

// Busca a lista de cidades de um estado brasileiro na API pública do IBGE.
// Uma falha de rede/API nunca lança erro -- ela aparece como `error` para
// que os chamadores possam recair num input de texto simples em vez de
// deixar o <select> de cidade travado bloqueando o resto do formulário.
export function useIbgeCities(uf: string): UseIbgeCitiesResult {
  const [result, setResult] = useState<FetchResult | null>(null);

  useEffect(() => {
    if (!uf) return;

    let cancelled = false;

    fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`IBGE respondeu ${response.status}`);
        }
        return response.json() as Promise<IbgeMunicipio[]>;
      })
      .then((municipios) => {
        if (cancelled) return;
        const names = municipios
          .map((municipio) => municipio.nome)
          .sort((a, b) => a.localeCompare(b, "pt-BR"));
        setResult({ uf, cities: names, error: null });
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ uf, cities: [], error: LOAD_ERROR_MESSAGE });
      });

    return () => {
      cancelled = true;
    };
  }, [uf]);

  if (!uf) return { cities: [], loading: false, error: null };

  const current = result?.uf === uf ? result : null;
  return {
    cities: current?.cities ?? [],
    loading: current === null,
    error: current?.error ?? null,
  };
}

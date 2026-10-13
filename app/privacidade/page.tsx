import type { Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/lib/site-config";

export const metadata: Metadata = {
  title: `Política de privacidade · ${siteConfig.name}`,
};

// Política de privacidade aceita no cadastro (User.privacyAcceptedAt). O
// texto acompanha docs/lgpd.md: qualquer mudança no que é coletado, em quem
// vê cada dado ou nos serviços externos usados precisa ser refletida aqui.

const DATA_ROWS: { data: string; purpose: string; whoSees: string }[] = [
  {
    data: "Nome",
    purpose: "Identificar você para a outra parte",
    whoSees: "Usuários logados",
  },
  {
    data: "E-mail e senha",
    purpose: "Entrar na sua conta. A senha é guardada só como hash (bcrypt)",
    whoSees: "Ninguém além de você",
  },
  {
    data: "Data de nascimento",
    purpose: "Confirmar que você tem 18 anos ou mais",
    whoSees: "Ninguém (nunca é exibida)",
  },
  {
    data: "Telefone",
    purpose: "Contato depois que uma contratação é aceita. Guardado cifrado",
    whoSees: "A outra parte, só com a contratação aceita ou concluída",
  },
  {
    data: "Endereço (famílias)",
    purpose: "Calcular a distância até os cuidadores. Guardado cifrado",
    whoSees: "Ninguém além de você",
  },
  {
    data: "Localização aproximada",
    purpose: "Busca por raio. Guardada com precisão de cerca de 1 km",
    whoSees: "Ninguém; cuidadores veem só uma faixa de distância",
  },
  {
    data: "Cidade, estado, tipos de cuidado, valor por hora",
    purpose: "Busca e compatibilidade",
    whoSees: "Usuários logados",
  },
  {
    data: "Descrição do perfil",
    purpose: "Apresentação. Pode conter informações de saúde (dado sensível)",
    whoSees: "Usuários logados",
  },
  {
    data: "Documentos (cuidadores)",
    purpose: "Verificação de identidade e de antecedentes",
    whoSees: "Ninguém além de você (armazenamento privado)",
  },
  {
    data: "Contratações e avaliações",
    purpose: "Histórico do serviço e reputação do cuidador",
    whoSees: "As duas partes; avaliações, usuários logados",
  },
];

const sectionTitleClass = "mt-8 mb-2 font-display text-xl font-semibold text-ink";
const paragraphClass = "mb-3 text-sm leading-relaxed text-ink/80";

export default function PrivacidadePage() {
  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <article className="mx-auto max-w-2xl">
        <h1 className="mb-2 font-display text-3xl font-semibold text-ink">
          Política de privacidade
        </h1>
        <p className="mb-6 text-sm text-muted">
          O {siteConfig.name} é um projeto acadêmico (Trabalho de Conclusão de
          Curso, UNIP). Esta política descreve como os dados pessoais são
          tratados, nos termos da Lei nº 13.709/2018 (LGPD).
        </p>

        <h2 className={sectionTitleClass}>Quais dados coletamos e por quê</h2>
        <div className="overflow-x-auto rounded-card border border-muted/20 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-muted/20 text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Dado</th>
                <th className="px-4 py-2 font-medium">Para quê</th>
                <th className="px-4 py-2 font-medium">Quem vê</th>
              </tr>
            </thead>
            <tbody>
              {DATA_ROWS.map((row) => (
                <tr key={row.data} className="border-b border-muted/10 last:border-0">
                  <td className="px-4 py-2 align-top font-medium text-ink">{row.data}</td>
                  <td className="px-4 py-2 align-top text-ink/80">{row.purpose}</td>
                  <td className="px-4 py-2 align-top text-ink/80">{row.whoSees}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className={sectionTitleClass}>Informações de saúde</h2>
        <p className={paragraphClass}>
          A descrição do perfil da família costuma mencionar a saúde da pessoa
          cuidada, o que a LGPD trata como dado pessoal sensível (art. 5º, II).
          Por isso a descrição só é gravada com o seu consentimento específico
          (art. 11, I), pedido em uma caixa separada no cadastro e na edição do
          perfil. Se você retirar o consentimento, a descrição é apagada.
          Evite incluir nomes, diagnósticos detalhados ou documentos.
        </p>

        <h2 className={sectionTitleClass}>Serviços de terceiros</h2>
        <p className={paragraphClass}>
          Os dados ficam em um banco PostgreSQL no Supabase e a aplicação roda
          na Vercel, que atuam como operadores. Para calcular a localização, o
          endereço informado é enviado ao Nominatim (OpenStreetMap), serviço
          mantido fora do Brasil (transferência internacional, art. 33). A lista
          de cidades vem da API pública do IBGE, sem nenhum dado seu.
        </p>

        <h2 className={sectionTitleClass}>Como protegemos os dados</h2>
        <p className={paragraphClass}>
          Senhas com bcrypt; telefone e endereço cifrados em duas camadas
          (uma cifra autoral e o AES-256-GCM); sessão em token cifrado;
          comunicação por HTTPS; controle de acesso em cada tela e rota. Nenhuma
          dessas medidas, sozinha, garante a conformidade com a LGPD.
        </p>

        <h2 className={sectionTitleClass}>Seus direitos</h2>
        <p className={paragraphClass}>
          Na tela de edição do perfil você pode consultar e corrigir seus
          dados, baixar uma cópia deles em formato estruturado (portabilidade e
          acesso, art. 18, II e V), retirar o consentimento para informações
          de saúde e excluir a sua conta (art. 18, VI). Na exclusão, os dados
          pessoais são apagados ou anonimizados; contratações antigas
          permanecem, sem o seu nome, para não apagar o histórico da outra
          parte.
        </p>

        <p className="mt-10 text-sm text-muted">
          <Link href="/" className="font-medium text-primary hover:underline">
            Voltar ao início
          </Link>
        </p>
      </article>
    </main>
  );
}

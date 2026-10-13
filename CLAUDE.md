# CLAUDE.md

## Sobre o projeto

Site de contratação de cuidadores: um marketplace de dois lados conectando:

- **Famílias** buscando cuidadores (idosos, crianças, pessoas com necessidades especiais, etc.)
- **Cuidadores** oferecendo seus serviços

## Stack

- **Frontend + Backend**: Next.js com TypeScript (App Router)
- **Banco de dados**: PostgreSQL + Prisma como ORM
- **Autenticação**: NextAuth.js (Auth.js)
- **Estilo**: Tailwind CSS
- **Hospedagem planejada**: Vercel (aplicação) + Supabase ou Railway (banco de dados)

## Contexto do desenvolvedor

- Nível intermediário em desenvolvimento web, já fez projetos pequenos.
- Experiência prévia em JavaScript/TypeScript (React, Node).
- Prioridade é aprender enquanto constrói: explique decisões técnicas importantes
  ao longo do caminho, não apenas implemente silenciosamente. Antes de tomar decisões
  arquiteturais relevantes (ex.: modelagem do banco, estrutura de rotas, estratégia de
  autenticação), explique o raciocínio e as alternativas consideradas.

## Convenções de código

- TypeScript em todo o projeto — nada de JavaScript puro.
- Código (nomes de variáveis, funções, componentes, tipos, arquivos) permanece
  em inglês. Comentários (`//` e `/** */`, incluindo JSDoc) são em português —
  convenção trocada depois que todo o histórico de comentários do projeto foi
  traduzido de inglês para português. Explicações no chat podem ser em
  português.

## Notas para trabalho futuro

- Por ser um marketplace de dois lados, considerar desde cedo: cadastro/perfis distintos
  para famílias e cuidadores, busca/filtros, avaliações e algum fluxo de contato ou contratação.
- Dados sensíveis provavelmente envolvidos (documentos, verificação de identidade/antecedentes,
  informações de saúde) — levar em conta requisitos de privacidade e segurança nas decisões futuras.

## Requisito acadêmico (TCC)

Este projeto também é o TCC do desenvolvedor, na UNIP. A UNIP exige uma
"intervenção" de uma disciplina do curso como assunto principal do
trabalho; a escolhida, por indicação do orientador, é **criptografia e
cibersegurança**. Requisitos específicos:

- **Criptografia (assunto principal)**: hash de senhas com bcrypt (cost
  factor 12) e criptografia em duas camadas dos dados sensíveis, sendo uma
  delas uma cifra autoral obrigatória — ver "Criptografia em duas camadas"
  abaixo.
- **Grafos (opcional, mantido)**: não é mais obrigatório, mas continua no
  app. O marketplace modela a relação família-cuidador como um 
  grafo bipartido ponderado (arestas = elegibilidade + peso combinando 
  distância via Haversine, tipo de cuidado, avaliação, preço). Além da busca 
  simples (ordenar arestas por peso), implementar o algoritmo de Gale-Shapley 
  para matching estável entre famílias e cuidadores, como diferencial de 
  fundamentação teórica da banca.

## Autenticação (NextAuth / Auth.js)

Implementado em `lib/auth.ts` (`authOptions`) e `app/api/auth/[...nextauth]/route.ts`:

- **Estratégia de sessão: JWT** (não Database sessions) — escolhido porque o
  `middleware.ts` roda no edge runtime, onde acesso direto ao Postgres via
  Prisma não é viável, e porque evita round-trip ao banco a cada requisição.
- **Provider: `CredentialsProvider`** (email + senha), sem OAuth nesta versão.
  `authorize()` busca o `User` por email e compara a senha com `bcrypt.compare`.
- Callbacks `jwt` e `session` propagam `id` e `role` do usuário para o token
  e para `session.user` — necessário porque o NextAuth não expõe campos
  customizados por padrão (tipagem estendida em `types/next-auth.d.ts`).
- **Cadastro (`POST /api/register`) bloqueia criação de `ADMIN`**: o schema
  Zod usado na validação só aceita `role: "FAMILY" | "CAREGIVER"` como
  discriminated union — mesmo o enum `Role` no Prisma tendo `ADMIN`, esse
  valor nunca é aceito vindo de uma requisição pública. Contas admin
  precisam ser criadas por outro caminho (seed manual, painel interno).
- `User` + `FamilyProfile`/`CaregiverProfile` são sempre criados na mesma
  `prisma.$transaction` — nunca em passos separados, para não deixar um
  `User` órfão sem profile.
- Duplicidade de email: sem checagem prévia — o `@unique` do Postgres barra
  e a API captura o erro `P2002`, retornando 409. Evita condição de corrida
  entre duas requisições simultâneas com o mesmo email.

## Cadastro: campos obrigatórios, maioridade e localização

Campos obrigatórios em `POST /api/register` (schema Zod em
`app/api/register/route.ts`), para os dois branches (`FAMILY` e
`CAREGIVER`): `name`, `birthDate`, `phone`, `city`, `state`. `address` é
obrigatório **só no branch `FAMILY`** — `CaregiverProfile` não tem coluna de
endereço (ver "Geolocalização" abaixo), então não há o que validar como
obrigatório ali; isso não era explícito no pedido original, mas é a única
leitura consistente com o schema atual sem adicionar uma coluna nova.

- **Maioridade (18+)**: `lib/age.ts` (`calculateAge`/`isAdult`,
  `MIN_REGISTRATION_AGE = 18`) é a fonte única da regra, usada tanto no
  `.refine()` do Zod (autoritativo, `app/api/register/route.ts`) quanto nos
  dois formulários de cadastro (`app/cadastro/familia/page.tsx`,
  `app/cadastro/cuidador/page.tsx`) para feedback instantâneo antes mesmo do
  submit — igual ao padrão já usado em `lib/hire-transitions.ts`. Calcula
  idade em anos completos (considera se o aniversário deste ano já passou),
  não uma subtração ingênua de anos.
- **Limites de `birthDate` (1900–hoje)**: além da checagem de 18+, `lib/age.ts`
  (`MIN_BIRTH_DATE`, `isBirthDateInFuture`, `isBirthDateTooOld`,
  `formatDateInputValue`, `parseBirthDateInput` — ver "Sistema de design"
  abaixo para o campo em si) rejeita datas futuras ou anteriores a 1900.
  Aplicado em duas camadas: a checagem client-side antes do submit (mesma
  função, feedback instantâneo) e o `.refine()` autoritativo no Zod
  (`app/api/register/route.ts`) — a ordem dos três `.refine()` encadeados
  ali importa: futuro/muito antigo é checado *antes* da regra de maioridade,
  senão uma data absurda mostra a mensagem confusa "menor de idade" em vez
  de apontar o problema real na data. Antes de virar o campo mascarado
  descrito em "Sistema de design", essa validação também dependia dos
  atributos `min`/`max` de um `<input type="date">` nativo; hoje o campo é
  texto puro, então toda a responsabilidade de bloquear datas fora da faixa
  está nessas duas camadas de código (client + servidor).
- **`User.name`/`User.birthDate`**: `name` já existia no schema mas nunca
  era enviado pelos formulários de cadastro; `birthDate` é campo novo
  (`DateTime?`, migration `add_user_birthdate`). Nenhum dos dois foi
  adicionado às telas de edição de perfil (`profile-form.tsx`) — só ao
  cadastro. As rotas `PATCH /api/caregiver-profile` e
  `PATCH /api/family-profile` continuam sem tocar no model `User`.
- **Mensagem de erro no cliente**: `lib/api-error.ts`
  (`firstApiErrorMessage`) extrai a primeira mensagem de
  `issues.fieldErrors`/`formErrors` da resposta 400 da API — antes disso, o
  formulário só mostrava o texto genérico "Dados inválidos", nunca a
  mensagem específica de qual campo falhou (idade mínima, campo vazio,
  etc.), mesmo a API já retornando isso em `issues`.
- **`hourlyBudget` (só branch `FAMILY`, opcional)**: "Quanto você pode
  pagar por hora (R$)" — mesmo padrão de campo do `hourlyRate` do cuidador
  (`input type="number"`, `min="0"`, `step="0.01"`, `onWheel={blurOnWheel}`,
  ver `lib/ui.ts`), inclusive o mesmo `z.number().positive().optional()`
  no Zod. Alimenta o componente de preço do matching quando preenchido —
  ver `computePriceScore` em "Algoritmo de matching".

## Estado e cidade (combobox com busca, não select nem texto livre)

- `lib/br-states.ts`: lista fixa das 27 UFs (sigla + nome), usada tanto para
  popular as opções de "Estado" quanto para validar server-side
  (`z.enum(BR_STATE_UFS, ...)` em `app/api/register/route.ts`) — uma sigla
  fora da lista nunca é aceita.
- `lib/use-ibge-cities.ts`: hook que busca as cidades do estado escolhido na
  API pública do IBGE
  (`https://servicodados.ibge.gov.br/api/v1/localidades/estados/{UF}/municipios`).
  Falha de rede nunca quebra o formulário — em vez do combobox de cidade,
  o campo cai para um `<input>` de texto livre com um aviso, então o
  cadastro continua possível mesmo com o IBGE fora do ar.
- **`app/components/combobox.tsx`**: combobox acessível genérico (padrão ARIA
  1.2 "combobox with list autocomplete" — `role="combobox"`,
  `aria-expanded`, `aria-controls`, `aria-activedescendant`, listbox com
  `role="option"`/`aria-selected`), navegável por teclado (setas, Enter
  confirma, Escape fecha revertendo). Filtro por substring,
  case-insensitive e **sem sensibilidade a acento** (normaliza via
  `.normalize("NFD")` + `\p{Diacritic}`, então "goias" encontra "Goiás").
  Diferença crucial em relação a um `<input>` comum: o `value` que chega ao
  `onChange` só pode ser um dos `options` — texto digitado que não bate
  com nenhuma opção (exata, após normalização) é descartado no blur,
  revertendo pro último valor válido selecionado. Estilizado com os mesmos
  tokens de `lib/ui.ts` (o dropdown reaproveita `bg-white`/`border-muted`/
  `primary`/`primary-light` do tema).
- `app/components/location-fields.tsx`: componente compartilhado (Estado +
  Cidade, cada um um `Combobox`) usado nos 4 formulários que coletam
  endereço (cadastro e edição de perfil, família e cuidador) — evita
  duplicar a lógica de reset da cidade toda vez que o estado muda. Recebe um
  prop `required` porque cadastro exige os dois campos mas edição de perfil
  não (validação do PATCH continua opcional, só a UI ganhou o combobox).
- Perfis salvos **antes** dessa mudança guardam cidade como texto livre
  (ex.: variações de capitalização/grafia); se o valor salvo não bater
  exatamente com um nome retornado pelo IBGE, o combobox de cidade abre
  vazio na tela de edição — o usuário só precisa reselecionar. Não há
  migração de dados para normalizar isso retroativamente.
- **Histórico**: a versão anterior usava `<select>` nativo do navegador
  (que já bloqueia texto livre por definição — testado e confirmado antes
  desta mudança, digitar no campo não alterava o valor). Um bug de "Estado/
  Cidade aceitando texto livre" foi relatado depois dessa versão ir ao ar,
  mas não foi possível reproduzi-lo rodando o código local — a explicação
  mais provável é teste contra uma versão em cache do navegador ou contra o
  deploy de produção antes dele terminar de atualizar após o último push.
  A troca para combobox com busca (pedida separadamente, ver acima) resolve
  a preocupação de qualquer forma, independente da causa do relato original.

## Proteção de rotas (middleware.ts)

- Sem sessão em qualquer rota de `/dashboard/*` (incluindo o próprio
  `/dashboard`, o despachante — ver "Navegação" abaixo) → redireciona para
  `/login?callbackUrl=<rota original>`.
- `role !== FAMILY` em `/dashboard/familia/*` → redireciona para `/`.
- `role !== CAREGIVER` em `/dashboard/cuidador/*` → redireciona para `/`.
- Usa `getToken` (não o helper `withAuth`) para ter controle fino por
  prefixo de rota.
- Nota: o Next.js 16 sinaliza depreciação de `middleware.ts` em favor de
  `proxy.ts` — ainda não migrado, é só aviso, não quebra nada por enquanto.

## Navegação (site-header.tsx + back-link.tsx)

**Redirecionamento pós-login: por que saiu da home e virou `/dashboard`**.
Antes, `app/page.tsx` (a home) fazia `getServerSession` + `redirect` pro
dashboard do `role` do usuário — ou seja, a home nunca era *vista* por quem
já estava logado, só existia como uma tela pública, e a barra do cabeçalho
(ver abaixo) escondia a si mesma nessa rota justamente por causa disso. Essa
combinação (home some pra quem já tem conta + header some só na home) parava
de fazer sentido no momento em que o header precisou de um estado "logado"
próprio (item abaixo) — a home passa a ser uma página normal, sempre
visível, e `app/dashboard/page.tsx` é um **despachante** dedicado
(Server Component, só `getServerSession` + `redirect` pro
`/dashboard/familia` ou `/dashboard/cuidador` do `role`) que existe
especificamente pra ser o alvo estável de qualquer link que precise "me leve
pro meu painel" sem saber de antemão qual é o `role` (o menu de conta do
header, o formulário de login quando não há `callbackUrl` na URL). O
`middleware.ts` precisou ganhar `"/dashboard"` (sem `:path*`) no `matcher`
pra continuar protegendo essa rota nova antes mesmo dela renderizar.

`app/components/site-header.tsx` é a barra fina persistente no topo do
site (logo + "Trevo" dentro de um `<Link href="/">`), presente em
**todas** as páginas agora, incluindo a home — antes ela se escondia em
`/` via `usePathname()` num Client Component, mas isso deixou de ser
necessário (e de fazer sentido) quando a home virou uma página que
usuários logados também visitam normalmente. O lado direito do header é
**sensível à sessão**:
- **Sem sessão**: link "Entrar" (`/login`).
- **Com sessão**: `app/components/account-menu.tsx`, um botão com ícone de
  conta (`CircleUserRound`, `lucide-react`) que abre um dropdown com
  "Painel de controle" (`/dashboard`, o despachante acima) e "Sair"
  (`signOut` do NextAuth).

**Decisão técnica — Server Component + um Client Component pequeno, não o
header inteiro em `useSession()`**: `site-header.tsx` voltou a ser um
Server Component (perdeu o `"use client"`/`usePathname()` de quando
precisava se esconder na home) e resolve a sessão com `getServerSession`
— que, na estratégia JWT deste projeto (ver "Autenticação"), só decodifica
o cookie, sem round-trip ao banco, então repetir essa chamada aqui (além
das páginas que já a chamam) é barato. Isso evita o "flash" de estado
deslogado que `useSession()` causaria no primeiro render (client precisa
buscar `/api/auth/session` antes de saber se há sessão). Só a parte
genuinamente interativa — abrir/fechar o dropdown, fechar ao clicar fora
ou apertar Escape — precisa de estado de cliente, por isso só o
`AccountMenu` é `"use client"`, não o header inteiro. Efeito colateral
aceito: páginas que antes eram estáticas no build (`/`, `/login`,
`/cadastro/*`) agora renderizam dinamicamente (ƒ) porque o header em
`app/layout.tsx` chama `getServerSession` em toda requisição — custo
pequeno e esperado pra um header que precisa saber quem está logado em
qualquer rota.

Renderizado no `app/layout.tsx` (raiz), antes de `{children}` — convive
sem conflito com o `BackLink` de cada página de dashboard: o header fica
fixo no topo da página inteira, o `BackLink` fica no topo do conteúdo
específico da tela, logo abaixo dele.

`app/dashboard/_components/back-link.tsx` é o **padrão oficial** para
qualquer página de dashboard voltar pro dashboard do próprio `role`
(`/dashboard/familia` ou `/dashboard/cuidador`). Existe porque a primeira
leva de páginas foi ao ar sem nenhum link de volta em várias telas
(perfil, busca, match-recomendado, contratações, solicitações, documentos)
— cada uma teria exigido adicionar um botão manualmente, o que já causou
essa inconsistência uma vez.

- **Toda página nova sob `/dashboard/**` deve incluir `<BackLink href="..." />`
  como o primeiro elemento do conteúdo, antes do `<h1>`** — não é opcional,
  é a checklist mínima pra uma página de dashboard ser considerada completa.
- `href` é passado explicitamente pela página chamadora (não é
  auto-detectado a partir da sessão) — toda página de dashboard já roda
  `getServerSession` server-side e sabe o `role` em escopo, então não faz
  sentido o componente refazer esse trabalho num hook client-side
  (`useSession`) só para descobrir o que a página já sabe.
- Estilizado com `secondaryButtonClass` (não `primaryButtonClass`) de
  propósito — nunca deve competir visualmente com o botão de ação principal
  da tela (`Salvar`, `Contratar`, etc.), mesmo padrão visual do "← Voltar"
  já usado em `/cadastro/familia` e `/cadastro/cuidador`.
- Nas duas telas de editar perfil (`app/dashboard/familia/perfil/page.tsx`,
  `app/dashboard/cuidador/perfil/page.tsx`), o `<main>` é `flex items-center
  justify-center` (card único centralizado) — o `BackLink` fica dentro de um
  `<div className="w-full max-w-md">` que envolve `BackLink` + `ProfileForm`
  juntos, pra ele ficar centralizado como uma unidade acima do card, em vez
  de precisar reestruturar o layout centralizado existente. Como o
  `BackLink` está no `page.tsx` (Server Component) e não dentro do
  `ProfileForm` (Client Component), ele nunca desaparece durante o
  salvamento — continua visível e clicável antes, durante, e depois de
  salvar as alterações.

## Banco de dados

- Hospedado no **Supabase** (decisão final — não Railway).
- `datasource db` usa **duas connection strings**: `url` (via connection
  pooler, porta 6543, usada em runtime pela aplicação) e `directUrl`
  (conexão direta, porta 5432, usada só pelo Prisma CLI para migrations).
  Sem isso, `prisma migrate` falha ou trava contra o pooler do Supabase.

## Perfis editáveis

- `app/api/caregiver-profile/route.ts` e `app/api/family-profile/route.ts`
  (GET + PATCH): sempre exigem sessão (401) e checam que o `role` da sessão
  bate com o tipo de perfil (403 caso contrário). `userId` sempre vem da
  sessão, nunca do corpo da requisição.
- O campo `verified` do `CaregiverProfile` **nunca** é editável via essa
  rota — o schema Zod de update não o declara, e o Zod descarta por padrão
  (modo "strip") qualquer campo não declarado enviado no corpo.
- Páginas: `app/dashboard/cuidador/perfil/page.tsx` e
  `app/dashboard/familia/perfil/page.tsx`, cada uma com Server Component
  (busca via Prisma direto) + Client Component (formulário).
- **`FamilyProfile.hourlyBudget`**: campo opcional no formulário de edição
  (`profile-form.tsx` da família), mesmo padrão de "Quanto você pode pagar
  por hora (R$)" já usado no cadastro (ver "Cadastro" abaixo) — `input
  type="number"`, sem setinhas (`blurOnWheel`, `lib/ui.ts`), sem vírgula
  como separador decimal. Segue a mesma convenção "vazio = não alterar" já
  usada pelos outros campos opcionais desse formulário
  (`form.hourlyBudget ? Number(form.hourlyBudget) : undefined` no corpo do
  `PATCH`). Ver "Algoritmo de matching" para o que esse campo alimenta.

## Geolocalização

- Campos `latitude`/`longitude` (`Float?`, opcionais) em `FamilyProfile` e
  `CaregiverProfile`.
- `lib/geocoding.ts`: `geocodeAddress()` chama o **Nominatim** (OpenStreetMap,
  gratuito), com `User-Agent` identificando a aplicação e uma fila que
  serializa chamadas com no mínimo 1s de intervalo entre elas (throttle em
  memória, por processo — não coordena entre múltiplas instâncias caso o
  app rode serverless/multi-processo no futuro).
- Geocodificação roda **sempre fora de qualquer transação Prisma** (nunca
  dentro de `$transaction`) — chamada de rede não deve seguir lock de banco.
- Falha de geocodificação (endereço não encontrado, erro de rede) nunca
  bloqueia cadastro/edição — apenas deixa `latitude`/`longitude` como `null`.
- Nos endpoints de edição de perfil, só re-geocodifica se o endereço
  (`city`/`state`/`address`) realmente mudou em relação ao valor salvo —
  evita chamadas desnecessárias ao Nominatim.

## Algoritmo de matching (núcleo acadêmico do TCC)

- `FamilyProfile.neededCareTypes: CareType[]` — tipos de cuidado que a
  família procura (mesmo enum `CareType` já usado em `CaregiverProfile.careTypes`).
- `FamilyProfile.hourlyBudget: Decimal? @db.Decimal(10,2)` — quanto a
  família pode pagar por hora, mesmo tipo/precisão de
  `CaregiverProfile.hourlyRate` (migration `add_family_hourly_budget`).
  Opcional: uma família pode nunca preencher esse campo, e o componente de
  preço do matching (`computePriceScore`, abaixo) foi desenhado desde o
  início para funcionar sem ele.
- `lib/matching-config.ts`: pesos configuráveis (`distance`,
  `careTypeCompatibility`, `rating`, `price` — devem somar 1.0),
  `maxDistanceKm` (raio de elegibilidade, hoje 50km),
  `defaultRatingWhenNoReviews` (0.5, para não penalizar cuidadores novos sem
  reviews), `caregiverCapacity` (3, usado pelo Gale-Shapley).
- `lib/haversine.ts`: distância em linha reta entre duas coordenadas.
- `lib/matching.ts`:
  - `findCandidateCaregivers` / `findCandidateFamilies` / `isEligiblePair`:
    filtra por raio máximo + overlap de `careTypes`/`neededCareTypes`.
    `findCandidateFamilies` é genérica (`<F extends FamilyForMatching>`) pra
    funcionar tanto com o `FamilyCandidate` mínimo (Gale-Shapley só precisa
    do `userId` de volta) quanto com o `FamilyForDisplay` mais rico (busca
    do cuidador, que também precisa mostrar nome/cidade/estado).
    `getSharedCareTypes(caregiverCareTypes, familyNeededCareTypes)`
    (`lib/care-types.ts`) é o filtro de interseção em si — extraído de três
    cópias inline duplicadas dentro deste arquivo (`computeMatchScore`,
    `findMatchedCaregiverForFamily`, `findMatchedFamiliesForCaregiver`) no
    momento em que o mesmo cálculo passou a ser necessário também fora de
    `lib/matching.ts`, pra validar `Hire.careType` em `POST /api/hires`
    (ver "Tipo de cuidado do Hire").
  - `computeMatchScore`: soma ponderada (*weighted sum model*) dos 4
    critérios normalizados para 0-1 cada.
  - **`computePriceScore(caregiverRate, familyBudget, candidateRatesForFallback?)`**
    — extraída de dentro de `computeMatchScore` (era uma função interna sem
    conhecimento de `hourlyBudget`) para materializar as **três camadas de
    fallback** do componente de preço, em ordem de prioridade:
    1. **Orçamento real declarado** (`familyBudget !== null`): compara o
       `hourlyRate` do cuidador contra o `hourlyBudget` da família —
       `rate <= budget` pontua 1.0 (cabe no orçamento); acima do orçamento,
       decai linearmente e satura em 0 quando `rate` é o dobro do `budget`
       (`rate - budget >= budget`). É a única camada que reflete uma
       preferência real informada pela família, não uma comparação relativa
       entre cuidadores.
    2. **Normalização relativa** (sem orçamento, mas com um pool de
       `candidateRatesForFallback` fornecido pelo chamador): comportamento
       original do projeto — min/max entre as tarifas dos candidatos
       elegíveis, cuidador mais barato do grupo pontua 1.0, mais caro
       pontua 0.
    3. **Neutro** (nem orçamento nem pool): reaproveita
       `matchingConfig.defaultRatingWhenNoReviews` (0.5) em vez de um novo
       "magic number" — mesmo significado estrutural do rating sem reviews:
       "sem dado, não pontuar nem penalizar".
    `caregiverRate === null` (cuidador sem `hourlyRate` cadastrado) também
    cai direto no neutro, independente de qual camada se aplicaria
    normalmente — não há tarifa para comparar contra nada.
    **As duas direções do grafo usam camadas diferentes de propósito**:
    `rankCaregiversAgainstList` (família buscando cuidadores) passa o pool
    de candidatos como fallback, então uma família sem orçamento declarado
    ainda vê preços relativos entre os cuidadores disponíveis.
    `rankFamiliesAgainstList` (cuidador buscando famílias) **não** passa
    esse pool — comparar o preço de um cuidador contra o de *outros*
    cuidadores não faz sentido do ponto de vista de uma família olhando
    esse cuidador, então sem orçamento declarado o score cai direto pra
    neutro, camada 3.
  - `rankCaregiversForFamily`: busca real usada em `GET /api/search/caregivers`.
  - `rankFamiliesForCaregiver`: o mesmo do outro lado do grafo, busca real
    usada em `GET /api/search/families` (ver "Busca de famílias pelo
    cuidador" abaixo). Por baixo, tanto essa função quanto
    `buildCaregiverPreferences` (Gale-Shapley) chamam o mesmo núcleo
    síncrono `rankFamiliesAgainstList` — extraído de dentro do loop de
    `buildCaregiverPreferences`, que antes tinha essa lógica inline
    duplicada em relação ao que a busca do cuidador precisava, espelhando
    o par `rankCaregiversAgainstList`/`rankCaregiversForFamily` que já
    existia do lado família. Deixou de receber `allCaregivers` como
    parâmetro (e `rankFamiliesForCaregiver` deixou de buscar
    `fetchAllCaregiversForMatching()`) no momento em que
    `computePriceScore` ganhou a camada de orçamento — esse parâmetro só
    existia pra alimentar a normalização relativa (camada 2), que este
    lado do grafo deliberadamente não usa mais (ver acima); mantê-lo sem
    uso seria um parâmetro morto.
  - `buildFamilyPreferences` / `buildCaregiverPreferences`: listas de
    preferência para o Gale-Shapley, reaproveitando a mesma fórmula de
    score nos dois sentidos. Consequência, do lado do cuidador
    (`buildCaregiverPreferences`): `rating` continua sempre constante entre
    as famílias candidatas de um mesmo cuidador (é uma propriedade do
    cuidador, não da família); `price`, desde o `hourlyBudget`, só
    permanece constante quando nenhuma das famílias candidatas declarou
    orçamento — uma família com `hourlyBudget` produz uma comparação real
    que varia por família. Distância e compatibilidade de tipo de cuidado
    sempre variam e continuam sendo o principal fator de desempate nesse
    lado.
- `lib/gale-shapley.ts`: `stableMatching()` genérica, implementando a
  variante **hospital-residents** (capacidade > 1 do lado que recebe —
  o mesmo tipo usado em alocação de residência médica), não o problema
  clássico 1-para-1. Resultado é **proposer-optimal** (cada família recebe o
  melhor cuidador possível entre todos os matchings estáveis existentes).
- `GET /api/matching/stable-match`: roda o matching global e retorna o
  resultado da família logada. Comentário no código aponta que recalcular
  tudo a cada requisição não escala — candidato a cache/job assíncrono se o
  volume de usuários crescer.
- `GET /api/matching/stable-match/caregiver`: mesma ideia, lado cuidador —
  rota separada (não um parâmetro na rota existente) pra manter o
  comportamento já testado do lado família intocado. Roda o mesmo
  `runStableMatchingForAllFamilies()` e devolve `matchesByCaregiver.get(<id
  do cuidador logado>)`. Diferença importante em relação ao lado família:
  como `caregiverCapacity` é 3, a resposta é uma lista de **0 a 3**
  famílias, não um resultado único. Mesma decisão de não inventar
  `distanceKm`/`matchScore` que o lado família já toma (Gale-Shapley não
  produz um score 0-1 comparável — ver "Changelog de decisões" abaixo) e
  mesmo formato limitado por privacidade da busca (sem `address`, ver a
  seguir).
- Scripts de teste permanentes: `scripts/test-matching.ts` e
  `scripts/test-gale-shapley.ts` (rodam com `tsx`, criam dados fictícios,
  imprimem resultado para inspeção manual, limpam ao final). O de
  Gale-Shapley inclui um verificador de pares bloqueantes independente, que
  re-deriva estabilidade a partir das listas de preferência brutas em vez de
  confiar no bookkeeping interno do algoritmo. `test-matching.ts` ganhou
  duas checagens específicas do `computePriceScore` com `hourlyBudget`: uma
  bateria pura (`testComputePriceScore`, sem banco) cobrindo as três
  camadas de fallback com valores esperados fechados, e um cenário
  ponta-a-ponta (`seedBudgetScenario`) — uma família com `hourlyBudget`
  real e dois cuidadores nas mesmas coordenadas/tipo/avaliação (só o
  `hourlyRate` difere), provando que o campo realmente flui do Prisma até
  o `matchScore` final via `rankCaregiversForFamily`, não só em isolamento.
  Esse cenário é limpo (`cleanup()`) **antes** do cenário original rodar —
  os dois reaproveitam as mesmas coordenadas fictícias, então deixar os
  cuidadores do cenário de orçamento no banco vazaria como candidatos
  espúrios na segunda busca (erro pego rodando o script depois de
  escrevê-lo, corrigido antes de virar prática recomendada).

## Busca de famílias pelo cuidador

`GET /api/search/families` (`app/api/search/families/route.ts`) é o
espelho de `GET /api/search/caregivers` do outro lado do marketplace —
mesma estrutura (401 sem sessão, 403 se `role !== CAREGIVER`, 400 com
`reason: "incomplete_profile"` se o cuidador não tiver
`latitude`/`longitude` ou `careTypes` vazio), usando `rankFamiliesForCaregiver`
(`lib/matching.ts`) por baixo.

**Limitado por privacidade, de propósito**: o tipo `FamilyForDisplay`
(`lib/matching.ts`) — a forma de `family` dentro do `RankedFamily` que
`rankFamiliesForCaregiver` retorna — carrega só `userId`, `name` (de
`User`), `city`, `state`, `latitude`/`longitude` (usadas para calcular
`distanceKm`, nunca devolvidas cruas) e `neededCareTypes`, mas **nunca
`address`** (o endereço completo da família, armazenado em
`FamilyProfile.address`). Isso não é um descuido nem um esquecimento de
campo: `FamilyForDisplay` simplesmente não carrega `address` nenhuma — não
tem como um consumidor futuro vazar esse dado por engano, porque o tipo não
o expõe. `GET /api/search/families` monta a resposta final a partir disso
(`familyId`, `name`, `city`, `state`, `neededCareTypes`, mais `distanceKm`/
`matchScore` calculados por `rankFamiliesForCaregiver`).
`GET /api/matching/stable-match/caregiver` usa o mesmo subconjunto de
campos privacy-safe, mas busca os perfis direto via Prisma (não passa por
`rankFamiliesForCaregiver`) e por isso **não** inclui `distanceKm`/
`matchScore` — mesma razão já documentada para o lado família em
`GET /api/matching/stable-match`: Gale-Shapley não produz um score 0-1
comparável, então não há o que calcular ali. Diferente do lado família (que
já vê o cuidador por inteiro, já que cuidador não tem endereço de casa
armazenado — ver "Geolocalização"), a família tem um endereço residencial
real, e o cuidador só precisa saber cidade/estado/distância pra decidir se
quer se candidatar — não o endereço exato antes de qualquer contato ter
sido aceito.

`findMatchedFamiliesForCaregiver` (`lib/matching.ts`) espelha
`findMatchedCaregiverForFamily` do outro lado: extrai o lookup "quais
famílias esse cuidador recebeu no Gale-Shapley" pra um só lugar,
compartilhado por `GET /api/matching/stable-match/caregiver` e por
`/dashboard/cuidador/match-perfeito` (Fase 2, abaixo) — nenhum dos dois
reimplementa a busca em `matchesByCaregiver`.

## Controles de privacidade e disponibilidade

Três campos novos, um de cada lado do grafo mais um puramente informativo:

- **`FamilyProfile.visibleToCaregivers` (`Boolean @default(true)`)**: se
  `false`, a família some de toda busca/matching *do ponto de vista do
  cuidador* — `GET /api/search/families`, `buildCaregiverPreferences`
  (Gale-Shapley) e, por consequência, `/dashboard/cuidador/match-perfeito`.
  **Nunca** afeta a própria busca dessa família por cuidadores — visibilidade
  é direcional, não um "modo oculto" geral da conta.
- **`CaregiverProfile.visibleToFamilies` (`Boolean @default(true)`)**: o
  espelho exato do campo acima, do outro lado — afeta
  `GET /api/search/caregivers`, `buildFamilyPreferences` e
  `/dashboard/familia/match-recomendado`, nunca a própria busca do cuidador
  por famílias.
- **`CaregiverProfile.availabilityStatus` (enum `CaregiverAvailability`:
  `AVAILABLE` | `BUSY` | `UNAVAILABLE`, `@default(AVAILABLE)`)**:
  puramente informativo — nunca filtra nem reordena nenhum resultado de
  busca/matching (diferente de `visibleToFamilies`, que remove o cuidador
  por completo). Um cuidador `BUSY`/`UNAVAILABLE` continua aparecendo
  normalmente na busca da família e no Gale-Shapley, só com um selo
  diferente — a intenção é sinalizar "não aceito mais serviços agora" sem
  esconder o perfil, que são decisões distintas (por isso dois campos
  separados, não um único enum com um valor "invisível").

**Onde a filtragem realmente acontece (`lib/matching.ts`)**: os dois campos
de visibilidade foram adicionados a `FamilyForMatching`/`CaregiverForMatching`,
mas a checagem **não** vive em `isEligiblePair` — essa função recebe um lado
"fixo" (quem está buscando) e um lado "candidato" (a lista sendo filtrada), e
qual argumento é qual se inverte conforme a direção da busca. Colocar a
checagem ali filtraria incorretamente com base na *própria* visibilidade de
quem está buscando. Em vez disso, a checagem vive nos dois wrappers que
filtram exclusivamente a lista de candidatos: `findCandidateCaregivers`
(`caregiver.visibleToFamilies`) e `findCandidateFamilies`
(`familyProfile.visibleToCaregivers`) — cada um só olha o campo do lado que
está sendo filtrado, nunca o do lado fixo. Isso garante a simetria exigida:
a visibilidade de um lado nunca vaza pra busca desse mesmo lado.
`availabilityStatus` não entra nesse filtro em nenhum ponto — só é
carregado através de `CaregiverForMatching` até as respostas de busca
(`GET /api/search/caregivers`) e a página `/dashboard/familia/buscar` para
exibição.

**Efeito colateral automático no Gale-Shapley, sem código extra**: um
cuidador invisível nunca entra na lista de preferências de nenhuma família
(`buildFamilyPreferences` usa `findCandidateCaregivers` por baixo), então
nenhuma família jamais propõe a ele — `stableMatching`
(`lib/gale-shapley.ts`) já trata "receptor nunca listado no meu preference
list" como cenário normal (proposta segue pra próxima opção), sem precisar
de nenhuma checagem de visibilidade dentro do algoritmo em si. O mesmo vale
no sentido inverso para uma família invisível: ela ainda propõe
normalmente (sua própria lista de preferências não é afetada pela própria
visibilidade), mas nenhum cuidador a aceita, porque ela nunca aparece nas
listas de preferência deles (`buildCaregiverPreferences` usa
`findCandidateFamilies`).

**UI**:
- Checkbox "Permitir que cuidadores me encontrem e demonstrem interesse"
  (marcado por padrão) em `app/cadastro/familia/page.tsx` e no
  `profile-form.tsx` da família — mesmo padrão visual dos checkboxes de
  tipo de cuidado já existentes nesses formulários.
- Checkbox espelhado "Permitir que famílias me encontrem" só no
  `profile-form.tsx` do cuidador (não no cadastro do cuidador — assimetria
  intencional, escopo definido explicitamente na tarefa que introduziu
  esses campos).
- `app/dashboard/cuidador/_components/availability-control.tsx`
  (`AvailabilityControl`, Client Component): controle rápido de
  `availabilityStatus`, deliberadamente fora de "Editar perfil" — fica logo
  abaixo da saudação em `app/dashboard/cuidador/page.tsx`, salva via
  `PATCH /api/caregiver-profile` a cada clique (sem precisar abrir a tela
  de edição completa). Reaproveita o mesmo estilo de pílula ativa/inativa
  já usado pelas pílulas de ordenação de `/buscar`
  (`bg-accent-light`/`text-accent` ativa, borda neutra inativa) em vez de
  inventar um novo padrão de toggle.
- `app/components/availability-badge.tsx` (`AvailabilityBadge`): selo
  somente-leitura, usado em `/dashboard/familia/buscar`
  (`caregiver-results.tsx`, ao lado do nome) e em
  `/dashboard/profile/caregiver/[id]` — os dois únicos lugares pedidos
  explicitamente para mostrar o status a uma família. `AVAILABLE` reaproveita
  o mesmo par `bg-primary-light`/`text-primary` de `CareTypeTags`; `BUSY`
  reaproveita o mesmo tratamento visual "chama atenção"
  (`border-accent/40`/`bg-accent-light`) já usado no card "Solicitações" do
  dashboard do cuidador quando há pendências — não uma cor nova, já que a
  paleta é deliberadamente monocromática (ver "Sistema de design");
  `UNAVAILABLE` usa o mesmo tom apagado (`border-muted/30`/`text-muted`) já
  usado pelo pill "Recebido" de `getHireDirectionLabel`.
- `lib/availability.ts`: `AVAILABILITY_LABELS` (mesmo padrão de
  `CARE_TYPE_LABELS` em `lib/care-types.ts`) e `AVAILABILITY_OPTIONS` (ordem
  de exibição do controle do dashboard), fonte única compartilhada pelo
  badge e pelo controle.

## Telas do cuidador — busca e match perfeito (Fase 2)

Duas páginas novas, espelhando as equivalentes do lado família tela por
tela (mesma estrutura, mesmos componentes reaproveitados de
`app/dashboard/familia/_components/` — `AvatarPlaceholder`,
`MatchScoreRing`, `ConnectionLine` — importados de lá em vez de movidos,
mesmo padrão já usado pela home page, ver "Identidade do site"):

- **`/dashboard/cuidador/buscar`** (`app/dashboard/cuidador/buscar/page.tsx`)
  espelha `/dashboard/familia/buscar`: Server Component chamando
  `rankFamiliesForCaregiver`, barra-resumo somente-leitura (tipos de
  cuidado que o cuidador atende + cidade/estado, com link "Editar perfil"),
  aviso de perfil incompleto (endereço ou `careTypes` vazio) igual ao
  padrão já usado do outro lado. A lista de resultados
  (`app/dashboard/cuidador/buscar/_components/family-results.tsx`,
  `FamilyResults`, Client Component) é o par de `CaregiverResults`, mas
  com **só 2 pílulas de ordenação** ("Mais próximo", "Mais compatível") em
  vez de 3 — `FamilyForDisplay` não carrega nenhuma nota de avaliação
  (famílias não são avaliadas nesta versão, ver "Sistema de Review"), então
  uma pílula "Melhor avaliação" não teria um campo real pra ordenar;
  inventar um valor pra preencher essa lacuna quebraria a mesma regra que
  já vale para `MatchScoreRing`/`ConnectionLine` ("nunca fabricar um número
  que pareça real sem ser"). Cada card mostra `MatchScoreRing` com o
  `matchScore` real, o nome como link pro perfil (ver "Nome da outra parte
  é sempre link" abaixo), cidade/estado (nunca `address` — a família não
  tem esse campo exposto aqui, ver "Busca de famílias pelo cuidador"
  acima), os tipos de cuidado como `CareTypeTags` (tags compactas, não mais
  a frase "Busca cuidado para {tipos}" — ver "Card de busca de famílias:
  tags em vez de frase redundante"), o `hourlyBudget` formatado como "Até R$
  X/h" (ou "Orçamento não informado" se ausente) e, se a família tiver
  `bio`, um bloco rotulado "O que a família procura" com o texto truncado
  em 120 caracteres (`BIO_PREVIEW_LENGTH`, local ao componente — texto
  completo só na página de perfil). `FamilyForDisplay` (`lib/matching.ts`)
  ganhou `bio` e `hourlyBudget` especificamente pra alimentar esse card. O
  botão **`InteresseButton`**
  (`app/dashboard/cuidador/_components/interesse-button.tsx`) fica no lugar
  do `ContratarButton` do lado família — mesmo `POST /api/hires`, mas com
  `{ familyId, careType }` no corpo (não `{ caregiverId, careType }`) e o
  texto "Tenho interesse" em vez de "Contratar", já que aqui é o cuidador
  se oferecendo, não sendo contratado (ver "Tipo de cuidado do Hire" para o
  `careType`). Trata 409 com a mesma mensagem clara de solicitação
  já em andamento, adaptada pro contexto ("...com essa família").
- **`/dashboard/cuidador/match-perfeito`**
  (`app/dashboard/cuidador/match-perfeito/page.tsx`) espelha
  `/dashboard/familia/match-recomendado`, usando
  `findMatchedFamiliesForCaregiver`. Diferença estrutural importante: como
  `caregiverCapacity` é 3, a tela lista **0 a 3 cards** de família (um
  `.map`), não um card único condicional como do lado família (capacidade
  1). Cada card mostra o nome como link pro perfil, `ConnectionLine` com
  `STABLE_MATCH_VISUAL_SCORE = 0.9` fixo (**sem** `MatchScoreRing`, mesma
  razão já documentada: Gale-Shapley não produz um score 0-1 comparável) e
  uma linha "X km de distância · Busca cuidado para {tipos em comum}" no
  lugar do badge de texto original (ver "Match perfeito / recomendado:
  badge textual → linha com dado real" e "Correção de texto: Atende vs.
  Busca" abaixo). Também tem `InteresseButton` em cada card, para o
  cuidador poder agir direto a partir do match sugerido (mesmo padrão do
  `ContratarButton` em `/match-recomendado`).
- **Links no dashboard** (`app/dashboard/cuidador/page.tsx`): "Buscar
  famílias" (`heroAccentButtonClass`, mesmo destaque que "Buscar
  cuidadores" tem no dashboard da família) e "Match perfeito"
  (`heroOutlineButtonClass`) lado a lado, acima dos cards de resumo
  existentes — mesmo par filled+outline já usado no hero da home
  (`heroButtonClass`/`heroOutlineButtonClass` — aqui com a variante accent
  no lugar de primary, já que "Buscar famílias" é a ação mais importante
  da tela, mesmo papel que `heroAccentButtonClass` já tem documentado em
  `lib/ui.ts`), não um filled+filled: `heroAccentButtonClass` existe
  especificamente para a *uma* ação que deve se destacar de tudo mais na
  tela, então dar a mesma cor de destaque às duas competiria com esse
  propósito.

## Changelog de decisões

- **Resolvido**: `GET /api/search/caregivers` retornava lista vazia sem
  explicação quando `FamilyProfile.neededCareTypes` da família logada estava
  vazio (sem overlap possível com conjunto vazio). Agora detecta esse caso
  *antes* de rodar `rankCaregiversForFamily` e retorna 400 com
  `{ error, reason: "incomplete_profile" }` — o campo `reason` existe
  especificamente para a UI (ou qualquer outro consumidor futuro) diferenciar
  isso de um erro de validação de entrada, já que o problema está no perfil
  salvo, não no que foi enviado na requisição. `app/dashboard/familia/buscar/page.tsx`
  trata o mesmo caso (replicando a checagem, já que a página chama
  `rankCaregiversForFamily` direto via Prisma, sem passar pela API) mostrando
  um card com link para `/dashboard/familia/perfil`, em vez do texto genérico
  de "nenhum resultado".
- **Intencional**: a menção textual ao algoritmo "Gale-Shapley" foi removida
  de `app/dashboard/familia/match-recomendado/page.tsx` — nome de algoritmo é
  detalhe de implementação interna, não deveria vazar pra UI que a família
  vê. A explicação do algoritmo permanece como comentário técnico no próprio
  código (perto de `STABLE_MATCH_VISUAL_SCORE`), só o texto visível na tela
  mudou.

## Match perfeito / recomendado: badge textual → linha com dado real

O badge genérico "Recomendado"/"Match estável" (texto fixo, sem dado real
por trás) foi substituído, nas duas telas de match
(`/dashboard/familia/match-recomendado`, `/dashboard/cuidador/match-perfeito`),
por uma linha explicativa com fatos reais sobre o par família-cuidador —
ex. "15.4 km de distância · Atende Idosos" do lado família (mostrando um
cuidador) ou "15.4 km de distância · Busca cuidado para Idosos" do lado
cuidador (mostrando uma família) — ver "Correção de texto: Atende vs.
Busca" abaixo para o porquê da frase mudar conforme quem está sendo
mostrado. Mesma regra de "nunca fabricar um número que pareça real" que já
vale para `MatchScoreRing`/`ConnectionLine` (ver "Sistema de design"): como
Gale-Shapley não produz um `matchScore` 0-1, a linha nunca mostra uma
porcentagem de compatibilidade — só os dois fatores reais que já existiam
nos profiles envolvidos (distância via Haversine, tipos de cuidado em
comum).

`findMatchedCaregiverForFamily` e `findMatchedFamiliesForCaregiver`
(`lib/matching.ts`) ganharam `distanceKm`/`sharedCareTypes` no retorno:
- `findMatchedCaregiverForFamily` mudou de assinatura — antes retornava só
  `string | null` (o `caregiverUserId`), agora retorna
  `MatchedCaregiverForFamily | null` (`{ caregiverUserId, distanceKm,
  sharedCareTypes }`). Único consumidor é
  `/dashboard/familia/match-recomendado` (confirmado via busca no código
  antes da mudança — `GET /api/matching/stable-match` reimplementa esse
  lookup inline e não foi tocada), então a troca de assinatura não teve
  blast radius além dessa página.
- `MatchedFamilyForCaregiver` (retorno de `findMatchedFamiliesForCaregiver`)
  ganhou os dois campos como adição — não quebra
  `GET /api/matching/stable-match/caregiver`, que só repassa o array como
  JSON.
- Ambas as funções agora também buscam o profile do lado "fixo" da consulta
  (o cuidador logado em `findMatchedFamiliesForCaregiver`; a família logada
  + o cuidador designado em `findMatchedCaregiverForFamily`) para poder
  calcular `distanceKm` (Haversine, via `distanceKmOrNull` — wrapper
  null-safe novo em `lib/matching.ts`) e a interseção de
  `careTypes`/`neededCareTypes`. Na prática essas coordenadas e listas de
  tipo sempre existem e o par sempre tem overlap para qualquer resultado
  real do Gale-Shapley (`isEligiblePair` já exige isso pro par ser sequer
  elegível), mas os tipos ficam `number | null`/`CareType[]` (nunca
  assumindo non-null) porque essas funções buscam os profiles de novo, sem
  reaproveitar essa garantia de outro lugar do código.

`lib/care-types.ts` (novo): `CARE_TYPE_LABELS` + `formatCareTypes()` —
extrai a constante que antes era um `Record` local duplicado em 6 arquivos
(as duas páginas de busca, seus componentes de resultado, e as duas
páginas de match). Só os arquivos tocados nesta tarefa (as duas páginas de
match, as duas páginas de perfil somente-leitura, `contratacoes`,
`solicitacoes`, `trabalhos-ativos` — ver seções abaixo) foram migrados
para importar dali; os 6 arquivos anteriores continuam com sua cópia local
intacta, fora do escopo do que motivou esse novo arquivo.

## Correção de texto: Atende vs. Busca

Qualquer trecho de UI que lista tipos de cuidado precisa deixar claro *de
qual lado do par* está falando — "Atende Idosos" descreve um cuidador
(o que ele oferece), "Busca cuidado para Idosos" descreve uma família
(o que ela precisa). Usar o texto errado do lado errado (ex. "Atende" numa
tela que mostra uma família) inverte o sentido da frase. Regra aplicada
em toda a base:

- **Telas que mostram um cuidador** (família olhando cuidadores) — mantêm
  **"Atende {tipos}"**: `/dashboard/familia/buscar` (`caregiver-results.tsx`,
  lista sem prefixo verbal, só os tipos) e
  `/dashboard/familia/match-recomendado` (`Atende {tipos}` explícito na
  linha de distância/compatibilidade).
- **Telas que mostram uma família** (cuidador olhando famílias) — usam
  **"Busca cuidado para {tipos}"**: `/dashboard/cuidador/match-perfeito`,
  corrigido nesta tarefa — antes reaproveitava "Atende {tipos}" (herdado
  por ter sido escrito espelhando a versão família do outro lado sem
  revisar a semântica), o que descrevia incorretamente uma família como se
  ela "atendesse" um tipo de cuidado. `/dashboard/cuidador/buscar`
  (`family-results.tsx`) **também** mostrava essa frase até a limpeza de
  redundância visual (ver "Card de busca de famílias: tags em vez de
  frase" abaixo) — hoje esse card não usa nenhum verbo, só tags, então a
  ambiguidade Atende/Busca não se aplica mais ali.
- Listas que só exibem os tipos sem nenhum prefixo verbal (`contratacoes`,
  `solicitacoes`, `trabalhos-ativos`, a barra-resumo de `/buscar`, e agora
  também o card de busca de famílias) não precisam de correção — a
  ambiguidade só existe quando um verbo é adicionado à frase.

## Card de busca de famílias: tags em vez de frase redundante

`/dashboard/cuidador/buscar` (`family-results.tsx`) mostrava "Busca cuidado
para {tipos}" como frase corrida logo acima do bloco de bio ("O que a
família procura") — como a bio frequentemente já menciona em prosa o que a
família procura ("Buscamos cuidador(a) para nossa mãe idosa..."), a frase e
a bio diziam a mesma coisa duas vezes, uma como texto genérico e outra como
texto da própria família. Substituída por **`CareTypeTags`**
(`app/components/care-type-tags.tsx`, novo) — tags compactas
(`rounded-full bg-primary-light ... text-primary`, o mesmo par de cores já
usado em badges de status/recomendação por toda a base, não uma cor nova
inventada pra isso), posicionadas logo abaixo de nome/cidade e antes da
bio. Ordem final do card: nome/cidade → tags de tipo de cuidado → bio →
distância/orçamento → botão. Retorna `null` sem renderizar nada se a lista
de tipos vier vazia, em vez de um container vazio.

## Nome da outra parte é sempre link para o perfil

**Convenção geral, válida para qualquer tela nova do dashboard**: sempre
que uma tela renderiza o nome de uma família ou cuidador que não é a
própria sessão logada (`family.user.name`, `caregiver.user.name`,
`hire.family.name`, `review.author.name`, ou equivalente), esse nome deve
ser um `<Link>` para `/dashboard/profile/family/[id]` ou
`/dashboard/profile/caregiver/[id]` (`[id]` = `User.id` da pessoa — ver
"Página de perfil somente-leitura" abaixo), estilizado com `hover:underline`
sobre a cor de texto já usada no lugar (nunca um botão ou card inteiro
clicável quando já existe outro link/botão de ação por perto — ver "Tela
de detalhe de um Hire" sobre não aninhar elementos clicáveis).

Auditoria completa feita ao introduzir essa convenção (toda ocorrência de
`.name`/`user.name` renderizada em `app/`, uma por uma):

| Local | Antes | Depois |
|---|---|---|
| `/dashboard/hires/[id]` (nome da outra parte, topo) | já era link | já era link |
| `/dashboard/hires/[id]` (`review.author.name`) | texto simples | **link** |
| `/dashboard/familia/contratacoes` | já era link | já era link |
| `/dashboard/cuidador/solicitacoes` | já era link | já era link |
| `/dashboard/familia/trabalhos-ativos` | card inteiro linkava pro `Hire`, nome não linkava pro perfil | **reestruturado**: nome vira link pro perfil, "Ver detalhes" separado linka pro `Hire` (mesmo padrão de `contratacoes`) |
| `/dashboard/cuidador/trabalhos-ativos` | idem acima | idem acima |
| `/dashboard/familia/match-recomendado` | texto simples | **link** |
| `/dashboard/cuidador/match-perfeito` | texto simples | **link** |
| `/dashboard/familia/buscar` (`caregiver-results.tsx`) | texto simples | **link** |
| `/dashboard/cuidador/buscar` (`family-results.tsx`) | texto simples | **link** |
| `/dashboard/cuidador/avaliacoes` (`review.author.name`) | texto simples | **link** |
| `/dashboard/profile/family/[id]`, `/dashboard/profile/caregiver/[id]` | nome é o dono da própria página (self) | não aplicável — não há pra onde linkar |
| `/dashboard/familia`, `/dashboard/cuidador` (saudação "Bem-vindo(a)") | `session.user.name`, é a própria pessoa logada (self) | não aplicável |
| `GET /api/matching/stable-match*` | resposta JSON de API, não é UI renderizada | não aplicável |

Dois casos usam `review.authorId` em vez de `hire.familyId`/`hire.caregiverId`
diretamente: `/dashboard/hires/[id]` e `/dashboard/cuidador/avaliacoes`
linkam a `Review` pra `/dashboard/profile/family/${review.authorId}` — hoje
`authorId` é sempre uma família (só famílias avaliam, ver "Sistema de
Review"), então o link sempre resolve pra um perfil de família real, mas o
código usa o id do autor da review, não assume `hire.familyId`, pro caso
de essa regra de negócio mudar no futuro.

## Página de perfil somente-leitura

`app/dashboard/profile/family/[id]/page.tsx` e
`app/dashboard/profile/caregiver/[id]/page.tsx` (novas): "quem é essa
pessoa" — nome, cidade/estado, bio, tipos de cuidado (`neededCareTypes` ou
`careTypes`, conforme o lado), o `hourlyBudget` da família (formatado como
"Até R$ X/h" ou "Orçamento não informado") e, só no lado cuidador,
avaliação média (`calculateAverageRating`). `[id]` é sempre o `User.id` (o
mesmo identificador já usado como `caregiverUserId`/`familyUserId` em
`ContratarButton`/`InteresseButton`/`Hire.caregiverId`/`Hire.familyId`),
não o `id` interno de `FamilyProfile`/`CaregiverProfile` — consistente com
o resto do app, onde "a pessoa" é sempre identificada pelo `User.id`.

- **Acesso**: exige sessão (qualquer role), mas **não** exige um `Hire`
  prévio entre as duas partes — é a mesma informação que já aparece nos
  cards de `/buscar` e das telas de match, só reorganizada como página
  própria, então não há razão pra restringir mais do que a busca já
  restringe. Perfil inexistente (`id` sem `FamilyProfile`/`CaregiverProfile`
  correspondente) → `notFound()`.
- **Nunca mostra `address` nem `phone`** — separação deliberada de
  responsabilidade em relação a `/dashboard/hires/[id]`: esta página
  responde "quem é essa pessoa" (dado disponível pra qualquer usuário
  logado, sem relação com nenhum `Hire` específico); a tela de detalhe do
  `Hire` responde "qual é o meu relacionamento com essa pessoa e como eu a
  contato" (dado condicionado ao `status` daquele `Hire` — ver "Exposição
  condicional de telefone"). Misturar os dois faria o telefone vazar
  independente de status, quebrando a regra já existente ali.
- `BackLink` aponta pra `/dashboard` (o despachante, ver "Navegação") em
  vez de uma rota fixa de família/cuidador — diferente das outras páginas
  de dashboard, esta pode ser aberta a partir de vários pontos diferentes
  (detalhe de um `Hire`, lista de contratações/solicitações), então não há
  uma única origem "correta" pra voltar; `/dashboard` sempre resolve pro
  painel de quem está vendo, seja qual for o `role`.

Ver "Nome da outra parte é sempre link para o perfil" acima para a
convenção que aponta pra essas duas páginas em toda tela do dashboard.

## Trabalhos ativos

`app/dashboard/familia/trabalhos-ativos/page.tsx` e
`app/dashboard/cuidador/trabalhos-ativos/page.tsx` (novas): lista filtrada
de `Hire`s só com `status === ACCEPTED` — um subconjunto do que já aparece
em `/contratacoes`/`/solicitacoes`, isolado numa página própria porque "o
que está em andamento agora" é uma pergunta diferente de "todo o histórico
de solicitações" (que mistura `PENDING`/`REJECTED`/`COMPLETED`/`CANCELLED`
junto). Cada card não reimplementa botões de ação, contato, nem review —
tudo isso já vive na tela de detalhe. **Estrutura do card revisada** após a
convenção "nome sempre link pro perfil" (ver acima): originalmente o card
inteiro era um único `<Link>` pra `/dashboard/hires/[id]`, mas isso não
deixava o nome linkável pro perfil sem aninhar um `<a>` dentro de outro
(HTML inválido); hoje o card é uma `<div>` simples com o nome como `<Link>`
pro perfil e um "Ver detalhes" separado (mesmo padrão visual de
`/contratacoes`/`/solicitacoes`) linkando pro `Hire`. Ordenado por
`acceptedAt desc`.

Cada dashboard (`app/dashboard/familia/page.tsx`,
`app/dashboard/cuidador/page.tsx`) ganhou um card "Trabalhos ativos"
(contagem de `ACCEPTED`) — ver "Dashboards" para onde cada um entra no
grid de cada lado.

## Fluxo de contratação (Hire)

Implementado como uma máquina de estados sobre o model `Hire` já existente no 
schema (`prisma/schema.prisma`), com as regras centralizadas em 
`lib/hire-transitions.ts` (única fonte de verdade, usada tanto pela API quanto 
pelas páginas do dashboard, pra evitar que as duas divirjam).

**Marketplace bidirecional**: originalmente só a família podia iniciar um 
`Hire` (o cuidador só respondia). Agora os dois lados podem iniciar contato 
— a família "contrata", o cuidador demonstra "tenho interesse". 
`Hire.initiatedBy` (`HireInitiator`: `FAMILY` | `CAREGIVER`, novo enum) 
registra quem deu o primeiro passo; linhas criadas antes desse campo 
existir têm `@default(FAMILY)` na migration (única leitura possível, já 
que só famílias podiam iniciar até então). Implementado em duas fases: 
**Fase 1** só o backend (schema, `lib/hire-transitions.ts`, 
`POST /api/hires` aceitando os dois papéis, `GET /api/search/families`, 
`GET /api/matching/stable-match/caregiver`); **Fase 2** as telas do lado 
cuidador que usam essa API (ver "Telas do cuidador — busca e match 
perfeito" abaixo) e os ajustes nas duas telas de Hire já existentes para 
não confundir quem iniciou o quê (ver final desta seção).

**Quem pode agir em cada transição depende de quem iniciou**: o lado que 
propôs o `Hire` é quem pode desistir dele enquanto ainda está `PENDING`; o 
outro lado (quem recebeu o convite) é quem decide aceitar ou recusar. Uma 
vez `ACCEPTED`, as regras voltam a ser fixas — independem de quem iniciou, 
porque nesse ponto os papéis já são naturais: o cuidador é sempre quem 
presta o serviço (só ele confirma conclusão) e a família é sempre quem 
recebe o cuidado (só ela pode recuar de um `ACCEPTED`).

| Transição | Iniciado pela família | Iniciado pelo cuidador |
|---|---|---|
| `PENDING → ACCEPTED` | só o cuidador (responde) | só a família (responde) |
| `PENDING → REJECTED` | só o cuidador (responde) | só a família (responde) |
| `PENDING → CANCELLED` | só a família (desiste) | só o cuidador (desiste) |
| `ACCEPTED → COMPLETED` | só o cuidador | só o cuidador |
| `ACCEPTED → CANCELLED` | só a família | só a família |

Qualquer outra transição é rejeitada pela API (`PATCH /api/hires/[id]`) com 
400. `VALID_HIRE_TRANSITIONS` em `lib/hire-transitions.ts` é literalmente 
essa tabela (uma entrada por `HireInitiator`, com as duas últimas linhas — 
que não variam — compartilhando o mesmo objeto `ACCEPTED_TRANSITIONS` em 
vez de duplicado, pra não divergirem por acidente); `isValidHireTransition` 
e `getAvailableActions` ganharam um parâmetro `initiatedBy` a mais.

**Timestamps reais de transição**: `Hire.acceptedAt`/`Hire.completedAt`
(`DateTime?`, migration `add_hire_accepted_completed_at`) registram o
momento exato em que o `PATCH /api/hires/[id]` move o `Hire` para
`ACCEPTED`/`COMPLETED` respectivamente — nenhuma outra transição toca
nesses campos. Não há como reconstruir esses valores retroativamente, então
`Hire`s criados antes dessa mudança ficam com os dois `null` para sempre;
`/dashboard/hires/[id]` (abaixo) trata isso explicitamente, mostrando
"Duração não disponível" em vez de calcular com dado ausente.

**`POST /api/hires` aceita os dois papéis como iniciador** — o corpo da 
requisição muda de acordo com a `session.user.role`, não com um campo 
explícito: família manda `{ caregiverId, careType }` (cria com `initiatedBy: FAMILY`, 
como sempre foi), cuidador manda `{ familyId, careType }` (cria com 
`initiatedBy: CAREGIVER`, novo). Os dois caminhos convergem pra uma única 
função interna (`createHire`) que faz a checagem de solicitação ativa + o 
`prisma.hire.create` — evita duplicar essa lógica entre os dois branches.
`careType` é obrigatório nos dois corpos e validado contra a interseção real
entre os dois perfis antes de chegar em `createHire` — ver "Tipo de cuidado
do Hire" logo abaixo.

**Regra de uma solicitação ativa por par família-cuidador**: não pode existir 
mais de um `Hire` com status `PENDING` ou `ACCEPTED` entre a mesma família e o 
mesmo cuidador simultaneamente. Isso é garantido em duas camadas: uma checagem 
prévia na API (`POST /api/hires`) e, como rede de segurança contra race 
condition, uma constraint `UNIQUE` real no banco sobre o campo 
`Hire.activeHireKey` (`"<familyId>:<caregiverId>"` enquanto ativo, `null` 
quando o Hire chega num estado terminal — Postgres trata múltiplos `NULL` 
como não-conflitantes, então isso permite um novo `Hire` depois que o anterior 
termina). A chave continua montada só a partir do par família+cuidador, 
**independente de quem iniciou** — a regra de "uma solicitação ativa por vez" 
vale igual nos dois sentidos.

Este `Hire` é o pré-requisito do sistema de `Review` que vem a seguir: só faz 
sentido uma família avaliar um cuidador (ou vice-versa) depois de um `Hire` 
`COMPLETED` entre os dois — o schema já modela isso (`Review.hireId` único, 
referenciando um `Hire` específico).

**Tempo relativo (Fase 2)**: `lib/relative-time.ts` (`formatRelativeTime`)
substitui a data absoluta ("Solicitado em DD/MM/AAAA") por texto em
português — "agora mesmo", "há 5 minutos", "há 2 horas", "há 3 dias", "há 2
semanas", "há 3 meses", "há 1 ano" — nos cards de
`/dashboard/familia/contratacoes` e `/dashboard/cuidador/solicitacoes`. A
data absoluta não desapareceu: fica no atributo `title` do `<span>` (tooltip
no hover), então a informação exata continua acessível sem competir
visualmente com o texto relativo. Estilizado com o novo `metaTextClass`
(`lib/ui.ts`) — texto pequeno e `muted`, deliberadamente **sem**
`font-mono`: diferente de um dado verificado (preço, distância, nota), uma
frase relativa ("há 5 minutos") é prosa, não um valor numérico redisplay,
então a convenção de `font-mono` do design system não se aplica aqui.

**Badge de direção (Fase 2)**: como agora um `Hire` pode ter sido iniciado
por qualquer um dos dois lados, uma mesma lista (`/contratacoes` ou
`/solicitacoes`) pode misturar solicitações que a pessoa logada enviou com
solicitações que ela recebeu — sem indicação visual, isso confundiria quem
está vendo a tela. `getHireDirectionLabel(initiatedBy, viewerRole)`
(`lib/hire-labels.ts`) resolve isso do ponto de vista de quem está olhando,
não do dado bruto: retorna **"Você enviou"** se `initiatedBy` bate com o
role de quem está logado, **"Recebido"** caso contrário. Renderizado como
um pill pequeno e discreto (`border-muted/30`, `text-xs`) ao lado do tempo
relativo em cada card, nas duas telas. Título de
`/dashboard/cuidador/solicitacoes` mudou de "Solicitações recebidas" para
**"Minhas solicitações"** pela mesma razão — o nome antigo pressupunha que
a lista só continha pedidos recebidos, o que não é mais verdade.
`/dashboard/familia/contratacoes` manteve "Minhas contratações": o nome já
era neutro o suficiente (não dizia "enviadas" nem "recebidas"), então não
precisou mudar.

Os botões de ação de cada card (incluindo "Cancelar", disponível quando a
pessoa logada é quem propôs um `Hire` ainda `PENDING`) continuam vindo
inteiramente de `getAvailableActions` (`lib/hire-transitions.ts`, já
parametrizada por `initiatedBy` desde a Fase 1) — nenhuma das duas páginas
reimplementa essa lógica, só passam `hire.initiatedBy` adiante.

## Tipo de cuidado do Hire (Hire.careType)

`Hire.careType CareType?` (nullable, migration `add_hire_care_type`) —
qual necessidade específica motivou aquela contratação/interesse, quando
tanto o cuidador quanto a família atendem/precisam mais de um tipo. Não
retroativo: `Hire`s criados antes dessa migration ficam com `careType: null`
para sempre, mesmo padrão de não-reconstrução já usado em
`acceptedAt`/`completedAt`/`activeHireKey`.

**Escolhido no momento de contratar/demonstrar interesse, não depois**: o
`careType` é obrigatório em `POST /api/hires` — não existe um `Hire` sem
tipo definido a partir de agora (só os antigos, via migration). O valor
disponível pra escolher nunca é "qualquer um dos dois enums" — é sempre a
**interseção real** entre `CaregiverProfile.careTypes` e
`FamilyProfile.neededCareTypes` daquele par específico, via
`getSharedCareTypes` (`lib/care-types.ts`, novo — extrai o filtro que antes
vivia duplicado três vezes dentro de `lib/matching.ts`, ver "Algoritmo de
matching").

- **`HireActionWithCareType`** (`app/dashboard/_components/hire-action-with-care-type.tsx`,
  novo): componente compartilhado usado tanto por `ContratarButton`
  (`app/dashboard/familia/_components/`) quanto por `InteresseButton`
  (`app/dashboard/cuidador/_components/`) — os dois já eram espelhos quase
  idênticos um do outro (ver comentário em `interesse-button.tsx`), então a
  lógica nova de escolha de tipo entrou uma vez só aqui, não duplicada nos
  dois. Cada botão continua existindo como seu próprio arquivo (label,
  mensagens de sucesso/erro/conflito e o `fetch` em si diferem — corpo
  `{ caregiverId, careType }` vs. `{ familyId, careType }`), só delegando a
  parte de UI/estado pro componente compartilhado via um `onConfirm(careType)`
  passado como prop.
  - **1 tipo em comum**: clicar já envia o `Hire` direto com esse tipo —
    sem etapa extra, já que não há escolha real a fazer.
  - **Mais de 1**: clicar expande inline um `role="radiogroup"` com um
    `<input type="radio">` nativo por tipo (roving focus/seleção de graça,
    como qualquer grupo de radio nativo) + botão "Confirmar" (desabilitado
    até selecionar um) e "Cancelar" (volta pro botão original sem enviar
    nada). Só o clique em "Confirmar" dispara o `POST`.
  - **0 em comum**: não deveria acontecer com nenhum caller real de hoje
    (toda tela que renderiza esses botões já filtrou o par por
    `isEligiblePair`, que exige overlap — ver "Algoritmo de matching"), mas
    o componente não assume isso: o botão fica desabilitado com uma
    mensagem explicando por quê, em vez de tentar enviar um `POST` que o
    servidor rejeitaria de qualquer forma.
- **Os 4 call sites** (as duas telas de busca, as duas telas de match)
  cada um já tinha, ou passou a ter, os dois lados dos tipos de cuidado em
  escopo pra calcular `sharedCareTypes` e passar como prop:
  `match-recomendado`/`match-perfeito` reaproveitam o `sharedCareTypes` que
  `findMatchedCaregiverForFamily`/`findMatchedFamiliesForCaregiver` já
  calculavam (ver "Match perfeito / recomendado: badge textual → linha com
  dado real"); as duas páginas de busca (`familia/buscar`,
  `cuidador/buscar`) passaram a repassar `neededCareTypes`/`careTypes` do
  perfil da sessão como prop nova pros componentes de resultado
  (`CaregiverResults`/`FamilyResults`), que chamam `getSharedCareTypes`
  por resultado.
- **Validação server-side em `POST /api/hires`, não só confiada no
  dropdown do cliente**: os dois branches (família/cuidador iniciando)
  buscam o perfil do outro lado E o próprio perfil da sessão, recomputam
  `getSharedCareTypes` entre os dois, e retornam 400 com mensagem clara se
  o `careType` enviado não estiver nessa lista — uma requisição direta à
  API (fora da UI) não consegue criar um `Hire` com um tipo que o par não
  compartilha de verdade, mesmo que a lista que a UI mostrou tivesse sido
  manipulada ou ficado desatualizada no cliente.

**Exibição**: só em `/dashboard/hires/[id]` — uma linha "Tipo de cuidado:
{tipo}" logo abaixo do badge de direção, usando `CARE_TYPE_LABELS`
(`lib/care-types.ts`); `Hire`s sem `careType` mostram "Tipo não
especificado" em vez de omitir a linha (deixa claro que é dado ausente, não
um tipo "nenhum"). **Deliberadamente fora dos cards de lista**
(`/contratacoes`, `/solicitacoes`, `/trabalhos-ativos`): esses cards já
mostram uma lista de tipos de cuidado com outro significado — os tipos que
o cuidador atende no geral, ou os que a família procura no geral (ver
"Parte 3" nesses cards) — não os desse `Hire` específico. Colocar as duas
informações lado a lado no mesmo card ("Idosos, Crianças" do perfil geral
+ "Tipo: Idosos" desse Hire específico) confundiria mais do que ajudaria;
quem quiser o tipo específico já tem "Ver detalhes" ali do lado.

`scripts/test-hire-care-type.ts` (novo, mesmo padrão de
`scripts/test-matching.ts`/`test-gale-shapley.ts` — dados fictícios com
prefixo de email próprio, limpos ao final): cobre um par com só 1 tipo em
comum, um par com múltiplos, a mesma checagem `sharedCareTypes.includes(careType)`
que o servidor roda contra um tipo fora da interseção, um `Hire` real
criado com `careType` e recarregado do banco, e um `Hire` criado sem
`careType` (simulando uma linha pré-migration) pra confirmar que fica
`null` sem quebrar nada.

## Sistema de Review

Implementado sobre o model `Review` já existente no schema 
(`app/api/reviews/route.ts`), com as seguintes regras:

- **Só a família avalia o cuidador** (não o contrário, nesta versão) — 
  `authorId` é sempre a família da sessão, `targetId` é sempre o 
  `caregiverId` do `Hire`.
- **Só depois do `Hire` estar `COMPLETED`** — tentar avaliar um `Hire` 
  `PENDING`/`ACCEPTED`/`REJECTED`/`CANCELLED` retorna 400.
- **Uma review por `Hire`**, garantido pelo `@unique` já existente em 
  `Review.hireId` no schema — a segunda tentativa de review pro mesmo `Hire` 
  é barrada tanto por uma checagem prévia (implícita, já que o `Hire` só 
  pode ter uma `Review`) quanto pela constraint do banco como rede de 
  segurança contra race condition (mesmo padrão usado no cadastro de email 
  duplicado e no fluxo de `Hire`).
- **Sem edição nem remoção nesta versão** — uma vez criada, a review é 
  permanente. Se isso mudar no futuro, precisa de uma decisão explícita 
  sobre quem pode editar/remover e até quando.
- `GET /api/reviews?caregiverId=...` é uma rota pública (sem exigir sessão) 
  — visitantes não autenticados podem ver as avaliações de um cuidador antes 
  de se cadastrar.

**`StarRating`** (`app/components/star-rating.tsx`): substitui o
`<select>` de "Nota" em `review-form.tsx` por 5 estrelas clicáveis.
Controlado (`value`/`onChange`, mesmo padrão de qualquer input controlado
do projeto), sem estado de validação próprio — a regra "1 a 5, obrigatório"
continua garantida estruturalmente (só existem botões de 1 a 5, nunca um
valor fora desse intervalo ou vazio) e autoritativamente pelo Zod em
`POST /api/reviews`, inalterado. Implementa o padrão ARIA "radio group"
(https://www.w3.org/WAI/ARIA/apg/patterns/radio/): cada estrela é um
`<button role="radio" aria-checked={...}>` com `aria-label` do tipo
"Avaliar com N estrelas", dentro de um container `role="radiogroup"`.
Roving `tabIndex` (só a estrela selecionada tem `tabIndex={0}`, as outras
`-1`) — Tab entra/sai do grupo como uma parada só; dentro dele, as setas
movem o foco *e* selecionam ao mesmo tempo (mesmo comportamento nativo de
um `<input type="radio">` em grupo), e Enter/Espaço confirmam a estrela
focada — de graça, por serem `<button>` nativos, sem handler extra
necessário. O hover é só uma pré-visualização: um estado local
(`hoverValue`) preenche as estrelas até o ponteiro sem chamar `onChange`;
o valor efetivamente selecionado (por clique ou seta) é o que persiste
quando o mouse sai do grupo. Colorido com `fill="currentColor"` +
`text-primary`/`text-muted` — o mesmo truque de `currentColor` já usado por
`ConnectionLine`/`MatchScoreRing`, não a utility `fill-primary` do
Tailwind (nunca testada em produção neste projeto).

**Modo `readOnly`**: usado para mostrar a nota de uma review já existente
(a de outra pessoa, nunca editável ali) — em
`/dashboard/cuidador/avaliacoes` e em `/dashboard/hires/[id]`. `StarRating`
é tipado como união discriminada (`onChange` obrigatório quando
`readOnly` não é `true`; ausente quando é) pra impedir na compilação passar
`onChange` sem sentido num uso somente-leitura. Internamente isso vira dois
componentes internos separados (`InteractiveStarRating` /
`ReadOnlyStarRating`), não um componente só com um `if (readOnly) return`
antes das chamadas de `useState`/`useRef` — isso violaria as Rules of
Hooks (hooks passariam a ser condicionais). O modo somente-leitura também
troca a semântica ARIA: em vez de `role="radiogroup"` com radios
desabilitados (o que sugeriria a um leitor de tela que há um input ali pra
operar), é um `role="img"` estático com `aria-label` tipo "Avaliação: 4 de
5 estrelas".

## Tela de avaliações do cuidador

`/dashboard/cuidador/avaliacoes` (`app/dashboard/cuidador/avaliacoes/page.tsx`):
lista todas as `Review` onde `targetId` é o cuidador logado (`prisma.review.findMany`
com `include: { author: { select: { name: true } } }`, ordenadas por
`createdAt` decrescente). Para cada uma: nome de quem avaliou, nota
(`StarRating readOnly`), comentário (ou "Sem comentário" se vazio/null,
nunca deixado em branco silenciosamente) e tempo relativo
(`formatRelativeTime`, mesmo padrão de `metaTextClass` já usado nas listas
de `Hire`). Subtítulo mostra a média + total via `calculateAverageRating`
(mesma função já usada no dashboard do cuidador) — como `average` é `null`
sem nenhuma review, a mesma condição já cobre a mensagem clara pedida
("Você ainda não recebeu avaliações."), sem precisar de um segundo check
`reviews.length === 0` redundante. O card "Sua avaliação" no dashboard do
cuidador (`app/dashboard/cuidador/page.tsx`) virou um link pra essa página
(era só um `<div>`, mesmo padrão hover dos outros cards do grid).

## Tela de detalhe de um Hire (compartilhada)

`/dashboard/hires/[id]` (`app/dashboard/hires/[id]/page.tsx`) é a única
página do app que não vive sob `/dashboard/familia/*` nem
`/dashboard/cuidador/*` — faz sentido, já que o mesmo `Hire` pertence aos
dois lados, e ambos precisam poder abrir o mesmo detalhe (`BackLink` volta
pra `/dashboard/familia/contratacoes` ou `/dashboard/cuidador/solicitacoes`
dependendo de qual lado é o usuário logado). Linkada como "Ver detalhes"
em cada card das duas listas de `Hire` — deliberadamente um link dentro do
card, não o card inteiro clicável, já que o card já tem botões de ação
(Aceitar/Recusar/Cancelar) que não podem ficar aninhados dentro de outro
elemento clicável (`<a>` dentro de `<a>`/`<button>` é HTML inválido e
quebra o comportamento de clique).

**Verificação de participante — 404 unificado, não 403 separado**: a
página busca o `Hire` pelo `id` da URL e confirma que `familyId` ou
`caregiverId` bate com `session.user.id`; se o `Hire` não existir OU o
usuário logado não for participante, os dois casos caem no mesmo
`notFound()` do Next.js (`next/navigation`) — ao contrário das rotas de
API (que retornam 401/403/404 distintos em JSON), aqui um 403 dedicado
vazaria pra um estranho logado que aquele `id` de `Hire` existe, mesmo que
ele não veja o conteúdo. Colapsar os dois em 404 evita esse vazamento de
existência, um padrão comum em apps que levam a sério não revelar
recursos que não pertencem a quem pergunta.

Conteúdo mostrado: nome da outra parte (`caregiver` se o logado é a
família, `family` caso contrário), status atual, o mesmo badge de direção
de `getHireDirectionLabel` já usado nas listas, mensagem original
(`Hire.message`, se houver), linha do tempo (criado em / aceito em / concluído
em — cada uma com data absoluta *e* relativa, via um `formatTimelineEntry`
local que combina `toLocaleString("pt-BR")` com `formatRelativeTime`), e a
`Review` associada (se existir: nota via `StarRating readOnly`, comentário,
nome de quem avaliou via `review.author`, não assumido como sempre sendo a
família mesmo sabendo que hoje só a família avalia — ver "Sistema de
Review").

**Duração do serviço**: `lib/duration.ts` (`formatDuration`) converte
`completedAt - acceptedAt` (em ms) numa frase de unidade única ("3 dias",
"5 horas") — mesma lógica de "maior unidade aplicável" de
`lib/relative-time.ts`, mas sem o prefixo "há" (aqui é a duração de um
intervalo fixo, não "quanto tempo atrás") e arredondando em vez de
truncando (o intervalo já é fixo quando calculado, então arredondar pro
mais próximo é mais preciso que sempre truncar pra baixo). Se
`acceptedAt` ou `completedAt` estiver ausente (`Hire` antigo de antes da
migration, ou ainda não chegou nesse ponto do fluxo), mostra "Duração não
disponível" em vez de tentar calcular com dado faltando.

**Exposição condicional de telefone**: o telefone da outra parte só
aparece depois que a relação está confirmada — `ACCEPTED` ou `COMPLETED`
— nunca em `PENDING` (ainda não houve aceite, não faz sentido dar contato
antes disso) nem em `REJECTED`/`CANCELLED` (a relação não se concretizou).
`lib/phone.ts` tem dois helpers só de formatação/URI (nenhuma validação
nova — isso continua em `isCompletePhone`/`PHONE_REGEX`, já existentes):
`formatPhoneForDisplay` (dígitos crus → `"(XX) XXXXX-XXXX"`, mesma máscara
visual de `PhoneInput`, mas sem a dependência do react-number-format já
que aqui é só leitura, nunca edição) e `buildWhatsAppUrl`
(`https://wa.me/55<dígitos>`, com um strip defensivo de qualquer caractere
não-numérico antes de montar a URL, mesmo o telefone já sendo salvo só em
dígitos).
- **Como o telefone mora em `FamilyProfile`/`CaregiverProfile`, não em
  `User`** (ver "Autenticação"), as duas relações de `Hire` (`family`,
  `caregiver` — ambas apontam pra `User`) precisaram de um `select`
  aninhado (`familyProfile: { select: { phone: true } }` /
  `caregiverProfile: { select: { phone: true } }`) em todo lugar que
  precisa mostrar telefone — hoje só `/dashboard/hires/[id]` (ver abaixo).
- **`/dashboard/hires/[id]`, seção "Contato" — redesenhada, sem link `tel:`
  como ação principal**: o número aparece como texto simples
  (`formatPhoneForDisplay`, não mais um `<a href="tel:...">`), ao lado de
  um botão **"Copiar número"**
  (`app/dashboard/hires/[id]/_components/copy-phone-button.tsx`, Client
  Component — usa `navigator.clipboard.writeText`, com o próprio botão
  trocando o texto para "Copiado!" por 2 segundos via `setTimeout` antes de
  reverter) e o botão de WhatsApp já existente (`target="_blank"`).
  Motivo do link `tel:` ter saído: em desktop (o uso mais comum dessa tela)
  um link `tel:` só funciona se o navegador tiver um discador configurado,
  então na prática ele quase nunca fazia algo útil — copiar o número (para
  colar num app de telefone/mensagens) e abrir o WhatsApp direto cobrem os
  dois caminhos reais que alguém segue a partir daqui. `buildTelUri`
  (`lib/phone.ts`) foi removido depois dessa mudança — era o único
  consumidor que restava.
  Continua renderizada só quando `canShowContact` (`status === ACCEPTED ||
  status === COMPLETED`) **e** o telefone da outra parte existir — perfis
  antigos ou incompletos sem telefone salvo simplesmente não mostram a
  seção.
- **`/dashboard/familia/contratacoes` e `/dashboard/cuidador/solicitacoes`
  perderam o link rápido "Contato"** que existia ao lado dos botões de ação
  quando `status === ACCEPTED` — duplicava (com pior UX, só `tel:`, sem
  copiar/WhatsApp) o que a seção "Contato" de `/dashboard/hires/[id]` já
  resolve melhor; "Ver detalhes" já leva pra lá. A condição do bloco de
  botões de ação voltou a ser só `actions.length > 0` (antes tinha virado
  `actions.length > 0 || showContact` quando o link de contato existia).

## Dashboards

`app/dashboard/familia/page.tsx` e `app/dashboard/cuidador/page.tsx` eram só
uma lista de links — agora mostram cards de resumo (grid responsivo com
`contentCardClass`) além dos links de navegação já existentes, que
continuam intactos abaixo dos cards. Sem rotas de API novas: os dois já são
Server Components com `getServerSession`, então os dados são buscados via
Prisma direto ali, junto com a sessão.

- **Dashboard da família**: simplificado para ficar simétrico ao do
  cuidador (abaixo) — dois botões lado a lado no topo, "Buscar cuidadores"
  (`heroAccentButtonClass`) e "Match recomendado" (`heroOutlineButtonClass`,
  mesmo par filled+outline já usado em "Buscar famílias"/"Match perfeito"
  do cuidador). O card "Match recomendado" que existia antes no grid
  (mostrando o nome do cuidador recomendado direto na tela, via
  `findMatchedCaregiverForFamily`) foi removido — nenhum dos dois botões
  revela informação antes da pessoa clicar e navegar até a página de
  destino, só o link em si. `findMatchedCaregiverForFamily`
  (`lib/matching.ts`) continua existindo e em uso — só não é mais chamada
  aqui, `/dashboard/familia/match-recomendado` (a página de destino) é
  quem ainda a usa.
  - Card "Contratações": `prisma.hire.count` para `PENDING` e `ACCEPTED` da
    família logada (duas queries via `Promise.all`, não uma só com
    `groupBy` — mais simples de ler para só dois status). Fica num grid de
    2 colunas ao lado do card "Trabalhos ativos" (ver "Trabalhos ativos"
    abaixo) — reaproveita o mesmo `acceptedCount` já buscado aqui, nenhuma
    query nova neste lado.
  - Banner de perfil incompleto: reaproveita o mesmo card
    (`border-primary/20 bg-primary-light`) e texto/link já usados em
    `/dashboard/familia/buscar` para o caso de `neededCareTypes` vazio, em
    vez de inventar um estilo novo para o mesmo aviso.
- **Dashboard do cuidador**: ganhou os links "Buscar famílias"/"Match
  perfeito" acima dos cards na Fase 2 do marketplace bidirecional — ver
  "Telas do cuidador — busca e match perfeito" para os detalhes.
  - Card "Solicitações": `prisma.hire.count` de `PENDING` recebidos. Com
    pelo menos 1 pendente, o card troca para `border-accent`/`bg-accent-light`
    (chamando atenção de que precisa de ação); com zero, é um
    `contentCardClass` normal.
  - Card "Trabalhos ativos": `prisma.hire.count` de `ACCEPTED` — query nova
    neste lado (o dashboard do cuidador antes só buscava `pendingCount`; o
    da família já buscava `acceptedCount` para o texto do card
    "Contratações", então não precisou de query nova). Ver "Trabalhos
    ativos" abaixo.
  - Card "Sua avaliação": média + total via `calculateAverageRating`, nova
    função em `lib/reviews.ts` — antes esse cálculo (reduce + divisão) vivia
    duplicado em `GET /api/reviews` e em `lib/matching.ts`
    (`toCaregiverForMatching`); os dois agora importam a mesma função em vez
    de recalcular. Sem nenhuma review, mostra "Sem avaliações ainda" em vez
    de "0" (que pareceria uma nota real, não ausência de dado). O card é um
    link para `/dashboard/cuidador/avaliacoes` (ver "Tela de avaliações do
    cuidador" abaixo) — antes não linkava a lugar nenhum porque essa
    página não existia.
  - Card "Documentos": `prisma.document.count` por `caregiverId` do
    `CaregiverProfile` da sessão. Com zero documentos, o texto é um convite
    ("envie para começar a ser verificado(a)"), não um aviso de erro — só o
    card "Solicitações" usa a cor de alerta (`accent`), porque só ali "zero"
    seria uma notícia ruim; aqui zero documentos é só o estado inicial
    normal de uma conta nova.

## Sistema de design

Aplicado em todo o site: tema global, `/login`, `/cadastro` (+ `/familia` +
`/cuidador`), `/dashboard/familia/buscar`, `/dashboard/familia` e
`/dashboard/cuidador` (telas iniciais), perfis (`/dashboard/familia/perfil`,
`/dashboard/cuidador/perfil`), contratações/solicitações
(`/dashboard/familia/contratacoes`, `/dashboard/cuidador/solicitacoes`,
incluindo `hire-action-button.tsx` e `review-form.tsx`), e
`/dashboard/familia/match-recomendado` (que também ganhou o `ConnectionLine`,
com `matchScore` fixo em 0.9 já que o Gale-Shapley não produz um score 0-1
como a busca — documentado no código). Único ajuste visual pontual: o
badge de compatibilidade em `match-recomendado` é texto ("Recomendado"),
não uma porcentagem, pela mesma razão. Centralizado em `lib/ui.ts` (classes
reutilizáveis) e `app/globals.css` (tokens do tema, via `@theme inline` — ver
nota sobre Tailwind v4 abaixo).

**Direção visual — histórico**: o site já passou por três paletas. A
original era verde-petróleo/âmbar. Depois veio "Editorial de Confiança"
(preto quase-puro + bordô sobre papel quente, importada de uma exploração
no Claude Design com esse nome), aplicada em duas fases — **Fase A** só a
base (tokens de cor, tipografia de display, hierarquia dos CTAs do hero) e
**Fase B** os componentes específicos que dependiam dela (`MatchScoreRing`,
o placeholder de foto com listras, a barra-resumo e as pílulas de
ordenação de `/buscar`, os links de navegação do header — ver "Componentes
da Fase B" abaixo). A paleta **atual, monocromática oliva sobre creme**,
substitui o preto+bordô da "Editorial de Confiança": `accent` deixou de ser
uma segunda cor de destaque e passou a ser exatamente a mesma cor de
`primary` (ver tabela abaixo) — o site inteiro passou a usar um hue só. Só
os *valores* de cor mudaram nessa última troca; tipografia (Source Serif 4/
Work Sans/JetBrains Mono) e a hierarquia dos CTAs (preenchido vs.
contornado) do hero, ambas decididas na Fase A, continuam as mesmas.

**Paleta** (`app/globals.css`): tons claros/escuros de `primary` são
derivados em HSL a partir do mesmo hue/saturation da cor base, variando só
a lightness — não são valores escolhidos à mão, pra formar uma família
consistente. `accent`/`accent-dark`/`accent-light` não são mais valores
próprios: são `var(--color-primary)`/`var(--color-primary-dark)`/
`var(--color-primary-light)`, uma referência direta, não um literal
duplicado — de propósito, já que essa paleta é monocromática por decisão
(não há uma segunda cor de destaque nesta direção). O token continua
existindo separado porque vários componentes já foram escritos contra
`accent` especificamente (`MatchScoreRing`, a pílula ativa de ordenação,
"Entrar", `accentButtonClass`) — eles continuam funcionando sem alteração
de código, só passam a renderizar na mesma cor de `primary`.

| Token Tailwind | Hex/HSL | Uso |
|---|---|---|
| `primary` | `#5F6E3D` / `hsl(78 29% 34%)` | botão preenchido principal, "Entrar", fundo da seção final "Pronto para começar" |
| `primary-dark` | `hsl(78 29% 26%)` | hover/active de botões primários |
| `primary-light` | `hsl(78 29% 92%)` | tints sutis (badges, avatar placeholder) |
| `accent` | `var(--color-primary)` (mesmo `#5F6E3D`) | idêntico a `primary` — direção monocromática, sem segunda cor de destaque |
| `accent-dark` | `var(--color-primary-dark)` | idem |
| `accent-light` | `var(--color-primary-light)` | idem |
| `background` | `#F8F3E9` | fundo geral (creme) |
| `ink` | `#1C1712` | texto principal (quase-preto, tom quente) |
| `muted` | `#6B645C` | texto secundário, labels, bordas |

**Nota de nomenclatura**: o spec original chamava a cor de texto principal/
secundário de "text-primary"/"text-secondary", mas isso colidiria com o
token `primary` (a cor de marca) — `bg-primary` e `text-primary` teriam
significados diferentes e incompatíveis (marca vs. texto). Renomeados para
`ink`/`muted` pra eliminar a ambiguidade; os valores hex são exatamente os
pedidos em cada direção visual.

**Contraste**: `ink`/`muted` não mudaram nesta troca — o novo `background`
(`#F8F3E9`) é quase idêntico em luminosidade ao anterior (`#F7F3EC`), então
o contraste do texto de corpo continuou adequado sem precisar de ajuste.
`accentButtonClass`/`heroAccentButtonClass` (`lib/ui.ts`) usam `text-white`
sobre `bg-accent` desde a fase "Editorial de Confiança" (quando isso foi
necessário pra corrigir um contraste quebrado contra o bordô escuro daquela
direção — ver histórico no commit) — com `accent` agora igual a `primary`
(`hsl(78 29% 34%)`), o contraste ficou em ~5.5:1, então `text-white`
continua correto sem precisar de outro ajuste.

**A logo mantém cores próprias, independentes do tema**: `app/components/trevo-logo.tsx`
e `app/icon.svg` têm `fill` fixo por `<path>` (mão em `#D9A576`, trevo em
`#2F7A4D` — ver "Identidade do site" abaixo) desde a tarefa que os tirou de
`currentColor`. Nenhuma troca de paleta do restante do site (incluindo
esta) afeta essas duas cores — elas não usam nenhum token de
`app/globals.css`.

**Tipografia**, via `next/font/google` em `app/layout.tsx` (self-hosted — 
baixadas em build time, servidas pelo próprio domínio, sem request pro CDN do 
Google em runtime):
- `font-display` (Source Serif 4, peso 600-700): títulos/headings — trocada
  da Fraunces original nesta mudança de direção, por ser uma serif mais
  "clássica de jornal", mais alinhada à referência editorial
- `font-sans` (Work Sans): corpo, labels, botões — é a fonte padrão do `body`
- `font-mono` (JetBrains Mono): dados/números *exibidos* (preço, distância, 
  nota, % de match) — não usada em campos de formulário, só em valores já 
  computados/verificados sendo mostrados de volta pro usuário (ex.: cards de 
  `/buscar`), que é a leitura mais literal de "dado verificado" do spec.

**Radius de card**: token `--radius-card: 0.875rem` (14px, dentro da faixa 
12-16px pedida) → classe `rounded-card`.

**Foco de teclado**: todo elemento interativo tocado usa 
`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary` 
em vez do outline default do navegador — nunca `outline-none` sem substituto.

**Movimento**: toda `transition` adicionada tem `motion-reduce:transition-none` 
ao lado, respeitando `prefers-reduced-motion`.

**Elemento de assinatura — linha de conexão**: `app/dashboard/familia/_components/connection-line.tsx`, 
um SVG simples (curva + dois pontos) representando família↔cuidador. A
curvatura varia com o `matchScore`: score alto → linha mais reta ("tensa"),
score baixo → linha mais solta. É só decorativo (`aria-hidden`), posicionado
sem competir com nome/match score/preço, que são o foco real do card. Desde
a Fase B (abaixo), só continua em uso em `/dashboard/familia/match-recomendado`
(com a constante `STABLE_MATCH_VISUAL_SCORE = 0.9`, documentada no código) e
no "Como funciona" da home — em `/buscar`, onde existe um score real, foi
substituída pelo `MatchScoreRing`.

**Componentes da Fase B** (`app/dashboard/familia/_components/` e
`app/dashboard/familia/buscar/_components/`), aplicados só onde a regra de
"nunca fabricar um número que pareça real sem ser" permite:

- **`match-score-ring.tsx`** (`MatchScoreRing`): anel de progresso SVG
  (`stroke` em `accent`, trilho em `accent-light`) com a porcentagem
  (`matchScore * 100`, arredondada) no centro. Usado **só** em `/buscar`,
  que tem um `matchScore` 0-1 real vindo de `computeMatchScore`
  (`rankCaregiversForFamily`). **Deliberadamente não usado** em
  `/match-recomendado`: o Gale-Shapley não produz um score 0-1 comparável
  (é um resultado categórico — "este é seu cuidador designado"), então essa
  tela continua com `ConnectionLine` + o badge de texto "Recomendado" em vez
  de inventar um número. Substitui o antigo badge percentual
  (`{Math.round(matchScore * 100)}%` num pill de texto) que existia em
  `/buscar` antes da Fase B — mostrar os dois ao mesmo tempo seria
  redundante.
- **`avatar-placeholder.tsx`** (`AvatarPlaceholder`): substitui o círculo de
  iniciais com fundo sólido (`bg-primary-light`) por um padrão de listras
  diagonais sutil (`repeating-linear-gradient` inline, alternando
  `accent-light` e transparente sobre `bg-white`), com a inicial do nome
  ainda sobreposta no centro — mantém a distinção visual entre cards em uma
  lista, só que com a textura da nova direção em vez de uma cor chapada.
  Usado em `/buscar` e `/match-recomendado`; não tocado em nenhum outro
  lugar (ex.: o card "Match recomendado" do dashboard da família não tem
  avatar, só texto).
- **Barra-resumo de `/buscar`** (`app/dashboard/familia/buscar/page.tsx`):
  chip somente-leitura mostrando os critérios já salvos no perfil da família
  (`neededCareTypes` + `address`/`city`) com um link "Editar perfil" ao
  lado — deliberadamente **não** é um campo de busca por texto livre, porque
  o sistema não tem esse conceito: a busca sempre roda sobre o perfil salvo
  (`neededCareTypes` + localização geocodificada), nunca sobre uma query
  digitada. Só aparece quando a busca de fato rodou (perfil com localização
  e tipos de cuidado completos).
- **Pílulas de ordenação de `/buscar`** (`app/dashboard/familia/buscar/_components/caregiver-results.tsx`,
  `CaregiverResults`, Client Component): "Mais próximo" (por `distanceKm`
  crescente), "Melhor avaliação" (por `averageRating` decrescente, com
  cuidadores sem review nenhum ordenados por último em vez de primeiro —
  tratar "sem dado" como "pior nota" seria enganoso) e "Mais compatível"
  (por `matchScore` decrescente — o padrão inicial, já é como a API retorna
  a lista). Reordena a lista já carregada no cliente (`distanceKm`/
  `averageRating`/`matchScore` já vêm todos na resposta de
  `rankCaregiversForFamily`) — nenhuma chamada nova ao servidor. Essa
  necessidade de interatividade é o motivo de `/buscar` ter ganhado esse
  Client Component: o `page.tsx` continua um Server Component (sessão +
  Prisma), só a lista de resultados (que agora precisa de estado de
  ordenação) foi extraída. Pílula ativa: `bg-accent-light`/`text-accent`;
  inativas: borda neutra com `bg-white`.

**Navegação do header** (`app/components/site-header.tsx`): ganhou uma
`<nav>` com três links — "Para famílias" (`/cadastro/familia`), "Para
cuidadores" (`/cadastro/cuidador`), "Como funciona" (`/#como-funciona`, a
seção já existente na home, que ganhou esse `id`) — visível só em `md:`
pra cima (`hidden md:flex`); em mobile esses links ainda não têm um menu
próprio, fica só a marca + "Entrar"/conta. O link "Entrar" (estado sem
sessão) trocou de `secondaryButtonClass` para `accentButtonClass` — botão
preenchido em bordô, não mais um botão neutro contornado.

**Espaçamento do hero da home**: a seção do hero (`app/page.tsx`) usava
`py-20 sm:py-28` simétrico; o topo ficou `pt-8 sm:pt-10` (o `pb-20 sm:pb-28`
embaixo não mudou) — o cabeçalho fixo já ocupa espaço próprio no topo da
página, então o padding vertical idêntico dos dois lados deixava uma faixa
vazia grande demais entre ele e o logo/tagline do hero.

**Máscara de telefone**: `app/components/phone-input.tsx` envolve o
`PatternFormat` da biblioteca **react-number-format** para aplicar o formato
`(XX) XXXXX-XXXX` em todo campo `phone` do site (cadastro de família,
cadastro de cuidador, edição de perfil de ambos) — escolhida em vez de uma
máscara escrita à mão porque já lida corretamente com posição do cursor,
backspace sobre caracteres da máscara e colagem de texto, e declara suporte
oficial a React 19 (`peerDependencies` inclui `^19.0.0`). O valor propagado
pelo `onChange` do componente é sempre o dígitos-puros (`values.value`), não
a string formatada.

**Validação de telefone completo**: a máscara acima só formata visualmente —
sozinha, ela não impede submissão de um número incompleto (ex.: "(62)
99333-445", 10 dígitos em vez dos 11 de um celular brasileiro válido: 2 do
DDD + 9 do número). `lib/phone.ts` (`PHONE_REGEX`, `isCompletePhone`,
`PHONE_INVALID_MESSAGE = "Telefone inválido — informe DDD + 9 dígitos"`) é a
fonte única dessa regra — mesmo padrão de `lib/age.ts` para a idade mínima:
um só lugar validando, reaproveitado no client e no servidor, pra nunca
divergir.
- **Servidor (autoritativo)**: `phone: z.string().regex(PHONE_REGEX, ...)`
  em `app/api/register/route.ts` (ambos os branches, `FAMILY` e
  `CAREGIVER`, já que `phone` está em `baseFields`, compartilhado pelos
  dois) e `.regex(PHONE_REGEX, ...).optional()` em `app/api/family-profile/route.ts`
  e `app/api/caregiver-profile/route.ts` — nessas duas o campo continua
  opcional (edição de perfil não obriga alterar o telefone), mas *se*
  enviado, precisa bater os 11 dígitos; não há mais como um PATCH salvar um
  telefone incompleto.
- **Cliente (feedback instantâneo)**: os 4 formulários que usam
  `PhoneInput` (`app/cadastro/familia/page.tsx`,
  `app/cadastro/cuidador/page.tsx`, e os dois `profile-form.tsx` de edição
  de perfil) chamam `isCompletePhone` antes do submit, mesmo padrão já
  usado para a data de nascimento. Nos dois formulários de cadastro, onde
  telefone é obrigatório, a checagem dispara sempre que o campo não tem 11
  dígitos. Nos dois formulários de edição de perfil, onde telefone é
  opcional, a checagem só dispara se o campo não estiver vazio
  (`form.phone && !isCompletePhone(form.phone)`) — campo vazio continua
  significando "não alterar o telefone salvo" (`form.phone || undefined`
  no corpo da requisição), não "telefone inválido".

**Máscara de data de nascimento**: `app/components/birth-date-input.tsx`
segue exatamente o mesmo padrão do `phone-input.tsx` acima — `PatternFormat`
com formato `##/##/####` e placeholder `dd/mm/aaaa`, em vez do
`<input type="date">` nativo usado originalmente. Motivo da troca: o destaque
em bloco azul que o navegador desenha nos segmentos (dia/mês/ano) de um
input de data nativo **não é estilizável via CSS** — não dá pra fazer esse
destaque seguir a paleta do tema (`primary`, etc.), então o campo nunca
ficaria visualmente consistente com o resto do formulário. Com o campo
sendo texto puro, `lib/age.ts` (`parseBirthDateInput`) ganhou a
responsabilidade de converter "DD/MM/AAAA" digitado em `Date` antes de
qualquer validação — a parte não óbvia ali é a técnica de "round-trip" para
pegar datas impossíveis: `new Date(ano, mes, dia)` do JavaScript nunca
lança erro para um dia inválido (ex.: `new Date(2020, 1, 31)`, 31 de
fevereiro) — ele "rola" silenciosamente pra frente (vira 2 ou 3 de março).
`parseBirthDateInput` reconstrói a data a partir dos três números digitados
e compara `getFullYear()`/`getMonth()`/`getDate()` do resultado contra o que
foi digitado; se não bater exatamente, a data é rejeitada como impossível
em vez de silenciosamente virar uma data diferente da que o usuário quis.

**Bloquear scroll em inputs numéricos**: convenção do projeto, não específica
de nenhum campo — todo `<input type="number">` novo deve receber
`onWheel={(e) => e.currentTarget.blur()}` (centralizado como `blurOnWheel`
em `lib/ui.ts`, para não repetir a lógica em cada input). Motivo: navegadores
alteram o valor de um input numérico focado ao rolar o scroll do mouse sobre
ele — um comportamento nativo *separado* das setinhas de incremento/
decremento (que já são escondidas via CSS em `app/globals.css`) e que
`preventDefault()` sozinho no evento `wheel` não bloqueia de forma
confiável em todos os navegadores. Tirar o foco do campo ao detectar
`wheel` é o jeito simples e confiável de resolver isso, e não interfere na
rolagem normal da página. Aplicado hoje em `hourlyRate` e `experienceYears`
(cadastro e edição de perfil de cuidador).

**Nota técnica — Tailwind v4**: este projeto não tem `tailwind.config.ts` — o 
Tailwind v4 usa config CSS-first via `@theme` dentro de `app/globals.css`, 
não um arquivo JS/TS separado. Os tokens de cor/fonte/radius viram utilities 
automaticamente (`--color-primary` → `bg-primary`/`text-primary`/etc., 
`--radius-card` → `rounded-card`).

## Verificação de documentos

Upload de documentos do cuidador (`Document` model, já existente no schema) 
para o Supabase Storage, **sem fluxo de aprovação/rejeição implementado**:

- **Bucket privado + signed URLs**: `caregiver-documents` é um bucket privado 
  no Supabase (não público), porque documento de identidade/antecedentes 
  criminais é dado sensível. `Document.fileUrl` guarda só o *caminho* do 
  arquivo no bucket (`{caregiverProfileId}/{uuid}-{nome}`), nunca uma URL 
  pública. Toda visualização passa por `createSignedUrls` 
  (`lib/documents.ts`), gerando links temporários (5 minutos) sob demanda — 
  ninguém acessa o arquivo sem antes provar que é o dono (ou, no futuro, um 
  admin autorizado).
- **`lib/supabase-admin.ts`** usa a `SUPABASE_SERVICE_ROLE_KEY`, que ignora 
  Row Level Security e tem acesso total ao projeto Supabase inteiro — client 
  **só pode ser importado em código server-side** (Route Handlers, Server 
  Components). Nunca num Client Component; isso vazaria a service_role key 
  pro navegador.
- **Validação de upload**: só PDF/JPG/PNG (`ALLOWED_MIME_TYPES` em 
  `app/api/documents/route.ts`), até 5MB. Se o insert no banco falhar depois 
  do upload pro Storage já ter dado certo, o arquivo é removido do bucket 
  (evita órfão).
- **Remoção só com `status: PENDING`**: a checagem já existe em 
  `DELETE /api/documents/[id]` mesmo sem nenhum caminho no código que mude 
  esse status hoje — é preparação deliberada para quando o fluxo de análise 
  existir (todo documento fica `PENDING` para sempre, por enquanto).
- **Fora do escopo atual (extensão futura deliberada)**: fluxo de 
  aprovação/rejeição por um admin (mudar `Document.status` para `APPROVED`/
  `REJECTED`, preencher `reviewedAt`, e provavelmente atualizar 
  `CaregiverProfile.verified`). A estrutura de dados 
  (`Document.status: VerificationStatus`, `reviewedAt: DateTime?`) já 
  suporta isso — só falta o painel/rota que faz a análise, que não existe 
  ainda porque não há papel de `ADMIN` operacional no app hoje.

## Criptografia em duas camadas (núcleo do TCC)

Telefone (`FamilyProfile.phone`, `CaregiverProfile.phone`) e endereço
(`FamilyProfile.address`) ficam cifrados no banco, em duas camadas:

```
texto → Camada 1: Cifra Trevo (autoral, chave K1)
      → Camada 2: AES-256-GCM (padrão, chave K2, IV aleatório, AAD)
      → banco: "v1:<iv>:<texto cifrado>:<tag>" (base64url)
```

- **`lib/trevo-cipher.ts` — Cifra Trevo (camada autoral, obrigatória pelo
  requisito do TCC)**: opera sobre bytes UTF-8, três "folhas" controladas
  por uma chave de 32 bytes: (1) substituição por uma S-box gerada da chave
  com Fisher-Yates; (2) deslocamento por posição, somando o byte da chave
  da posição (Vigenère sobre bytes); (3) transposição por colunas (3 a 7
  colunas, ordem vinda da chave). Decifra na ordem inversa. **Limitações
  conhecidas, documentadas no próprio arquivo e parte da análise do TCC**:
  determinística (sem IV), chave da folha 2 se repete a cada 32 bytes, sem
  autenticação. Por isso nunca é usada sozinha.
- **`lib/aes-gcm.ts` — camada padrão**: AES-256-GCM do `node:crypto`, sem
  modificação no algoritmo. IV aleatório de 12 bytes por cifração, tag de
  16 bytes (detecta adulteração).
- **`lib/field-encryption.ts` — junta as duas**: `encryptField`/
  `decryptField` (estrita, lança erro), `tryDecryptField` (para telas:
  devolve `null` e registra no log só campo + dono, nunca o valor),
  `encryptOptionalField` (preserva `undefined` = "não alterar" nos PATCH),
  `isEncryptedField`. A adaptação do AES ao domínio está aqui: as chaves K1
  e K2 são derivadas com HKDF-SHA256 de uma única chave mestra
  (`FIELD_ENCRYPTION_KEY`, 32 bytes em base64 no `.env`/Vercel) com rótulos
  diferentes — independentes entre si — e a **AAD** é
  `trevo:<campo>:<User.id do dono>`, então um valor copiado para outro
  usuário ou outro campo não decifra.
- **Ordem das camadas é deliberada**: a Cifra Trevo fica por dentro, para o
  GCM autenticar o resultado inteiro. A segurança real vem do AES; a cifra
  autoral é a contribuição de estudo.
- **Onde se cifra**: `POST /api/register` (dentro da transação, depois do
  `user.create`, porque a AAD precisa do `User.id`; a geocodificação usa o
  endereço em texto puro antes, só em memória), os `PATCH` de
  `/api/family-profile` e `/api/caregiver-profile`, e
  `scripts/seed-demo.ts` (cria o perfil e depois atualiza com os campos
  cifrados, pelo mesmo motivo do id).
- **Onde se decifra**: só no servidor e só para quem pode ver — o próprio
  dono (telas de editar perfil, `GET`/`PATCH` dos perfis, barra-resumo de
  `/dashboard/familia/buscar`) e a outra parte de um `Hire`, em
  `/dashboard/hires/[id]`, onde a decifração só acontece **depois** da
  checagem `canShowContact` (status `ACCEPTED`/`COMPLETED`).
- **Dados antigos**: `scripts/encrypt-existing-data.ts`
  (`npm run encrypt:existing`) cifra os valores ainda em texto puro.
  Simula por padrão; só grava com `-- --apply`. Idempotente (pula o que já
  começa com `v1:`). Precisa rodar uma vez em cada banco depois de
  configurar `FIELD_ENCRYPTION_KEY` — sem isso, os valores antigos não
  decifram e as telas mostram o campo vazio.
- **Chave**: se `FIELD_ENCRYPTION_KEY` for perdida ou trocada, os dados
  cifrados ficam ilegíveis. Precisa ser a mesma no `.env` local e na Vercel
  (o banco é compartilhado).
- **Testes**: `scripts/test-field-encryption.ts` (`npm run
  test:encryption`), sem banco, com chave aleatória: ida e volta (acentos,
  ç, vazio, bytes aleatórios de 0 a 64), S-box como permutação, ordem de
  colunas, determinismo, chave errada, IV aleatório, adulteração detectada
  pela tag, troca de dono/campo barrada pela AAD, texto puro recusado.
- **Demonstrações de ataque para o capítulo de Resultados**:
  `scripts/demo-attacks.ts` (`npm run demo:attacks`), sem banco, chaves
  aleatórias a cada execução, saída formatada para print. Sete seções: o
  que o banco grava; análise de frequência contra a Cifra Trevo (só folha
  1, folhas 1+3 com força bruta das 5.910 ordens de colunas, e cifra
  completa — com índice de coincidência de Friedman); determinismo da cifra
  sozinha vs. IV aleatório do AES; adulteração detectada pela tag; troca de
  dono/campo barrada pela AAD; chave errada; desempenho. Resultado típico:
  sem a folha 2 o ataque recupera ~70% dos bytes, com ela ~1%; o índice de
  coincidência cai de ~0,075 para ~0,006 (aleatório = 0,0039). Os números
  variam um pouco por execução, já que as chaves são aleatórias.
- **Benchmark dos três cenários (experimento do TCC)**:
  `scripts/benchmark-ciphers.ts` (`npm run benchmark`) compara C1 (Trevo
  sozinha), C2 (AES-256-GCM sozinho) e C3 (a combinação da aplicação) com os
  mesmos testes: correção, desempenho (30 rodadas, cenários alternados,
  IC95), expansão, adulteração, entradas inválidas, determinismo,
  estatística (entropia, índice de coincidência, qui-quadrado), avalanche e
  ataque de frequência contra um chute trivial. **As hipóteses e critérios
  ficam em `docs/hipoteses-e-criterios.md`, escritos antes da execução
  oficial** — não editar esse arquivo para combinar com resultados; mudanças
  vão em commit novo e justificadas no texto do TCC. Chaves e entradas vêm de
  um gerador com semente (`--seed`, padrão `trevo-tcc`); só os IVs são
  aleatórios. Grava CSV (`;` e vírgula decimal, para o Excel em português) e
  `ambiente.json` (máquina, commit, semente, vereditos) em
  `resultados/benchmark-<data>/`. `--quick` serve só para conferir o script
  (pasta `-rapido`, ignorada pelo Git). As ferramentas de criptoanálise
  ficam em `scripts/cryptanalysis.ts`, compartilhadas com
  `demo-attacks.ts`. Achado das execuções rápidas: no Node 24 com
  OpenSSL 3, só criar o contexto do AES-GCM (`createCipheriv`) custa
  ~55 µs, então em campos curtos o custo fixo do AES domina e a Trevo é mais
  rápida que o AES.
- **LGPD**: `docs/lgpd.md` é o rascunho da seção da monografia — inventário
  de dados, dados sensíveis, medidas adotadas e as lacunas encontradas
  (coordenadas em texto puro apesar do endereço cifrado, distância com
  0,1 km permitindo triangulação, `GET /api/reviews` público expondo nome do
  autor, sem exclusão/exportação de conta, bio com dados de saúde em texto
  puro, envio do endereço ao Nominatim). Corrigir uma dessas lacunas no
  código deve atualizar esse arquivo.

## Identidade do site

Nome: **Trevo**. Tagline: **"Cuidado que conecta"**. Esses dois valores 
vivem centralizados em `lib/site-config.ts` (`siteConfig.name` / 
`siteConfig.tagline`) — nunca hardcoded direto numa página. Hoje são usados 
em `app/layout.tsx` (título/descrição da página) e `app/page.tsx` (hero e 
rodapé); qualquer lugar novo que precisar do nome/tagline do site (emails 
transacionais, outras páginas de marketing) deve importar dali, não repetir 
a string. O `<title>` da aba (`metadata.title` em `app/layout.tsx`) é só
`siteConfig.name` ("Trevo") — era `"${siteConfig.name} — ${siteConfig.tagline}"`
("Trevo — Cuidado que conecta"); a tagline continua no `<meta description>`
e visível no hero da home, só saiu do texto da aba do navegador.

**Logo**: `app/components/trevo-logo.tsx` — componente React do SVG (ícone de
mão segurando um trevo de três folhas). **Cores fixas por parte, não mais
`currentColor`**: o primeiro `<path>` do arquivo (a mão) tem
`fill="#D9A576"` (tom de pele neutro) e os outros 5 `<path>` (as três
folhas do trevo) têm `fill="#2F7A4D"` (verde), cada um declarado
individualmente no próprio elemento — o `<svg>` raiz não tem mais
`fill="currentColor"`, já que não há mais nada para herdar. Antes disso a
logo era monocromática, herdando cor via Tailwind (`className="text-primary"`
no `<svg>`); os três lugares que passavam essa classe (`app/page.tsx` no
hero e no rodapé, `app/components/site-header.tsx`) tiveram o `text-primary`
removido do `className` por não ter mais efeito nenhum sobre o desenho.
Usado no hero da home (`h-24 w-24`/`h-28 w-28` responsivo — aumentado a
partir de `h-16`/`h-20`, que ficava pequeno demais em relação ao `h1`
"Trevo" logo abaixo), no rodapé (`h-5 w-5`, sem alteração) e no header
(`h-9 w-9`, aumentado de `h-6 w-6`, acompanhado do texto "Trevo" indo de
`text-base` para `text-xl` — os dois cresceram juntos pra manter o
alinhamento vertical entre ícone e texto). `app/icon.svg` é uma cópia do mesmo
desenho com o mesmo esquema de duas cores (favicons não herdam contexto de
CSS, então não há como usar `currentColor`/Tailwind ali) — detectado
automaticamente pelo App Router como favicon, sem config extra em
`layout.tsx`. O `favicon.ico` original do `create-next-app` foi mantido
como fallback para navegadores sem suporte a favicon SVG.

**Home page (`app/page.tsx`)**: pública e **sempre visível**, mesmo pra quem
já está logado — não redireciona mais ninguém (ver "Navegação" acima para o
porquê e onde esse redirecionamento pós-login foi parar). Estrutura, de
cima para baixo:
- **Hero**: logo + nome + tagline + frase curta de proposta + os dois CTAs
  lado a lado (`/cadastro/familia` e `/cadastro/cuidador`). **Reversão da
  decisão original**: os dois CTAs tinham hierarquia visual idêntica (mesmo
  estilo/cor/tamanho, nenhum "mais importante" que o outro) — a direção
  "Editorial de Confiança" (Fase A, ver "Sistema de design") pediu
  explicitamente um botão preenchido ("Sou família, buscar cuidador",
  `heroButtonClass`) e um só contornado ("Sou cuidador, quero atender",
  `heroOutlineButtonClass`, novo em `lib/ui.ts`), priorizando famílias como
  a ação principal do hero. O mesmo par se repete no CTA final da página. O
  hover do botão contornado usa `bg-ink/5` (não `bg-primary-light`) porque
  ele aparece tanto sobre o `background` da página quanto dentro da seção
  final, que já é `bg-primary-light` — um tint de hover igual ao fundo
  ficaria invisível ali. A frase curta de proposta usa vírgula em vez de
  travessão antes de "e para cuidadores encontrarem famílias" — mudança
  puramente de pontuação, mesmo sentido.
- **Como funciona**: 3 passos com ícone (`lucide-react`), conectados 
  visualmente pelo mesmo `ConnectionLine` já usado em `/buscar` e 
  `/match-recomendado` (reforça a metáfora de "conexão" da tagline). O 
  componente continua fisicamente em 
  `app/dashboard/familia/_components/connection-line.tsx` — a home importa 
  de lá em vez de mover o arquivo, pra não mexer nos imports das outras 
  páginas que já o usam.
- **Por que confiar**: 3 pontos (senha criptografada, documentos verificados, 
  avaliações reais).
- **CTA final**: repete os dois botões do hero antes do rodapé.
- **Rodapé**: logo pequena + nome do site + ano calculado via
  `new Date().getFullYear()` (nunca um ano fixo).

Dois novos tokens em `lib/ui.ts` pra isso: `heroButtonClass` (CTA grande, 
full-width no mobile / lado a lado em telas maiores — `primaryButtonClass` 
já existente é dimensionado pra botão de formulário, pequeno demais pra 
hero) e `contentCardClass` (card de conteúdo genérico pra grid, mesma 
linguagem visual do `cardClass` mas sem a largura máxima fixa).

## Deploy (Vercel)

Aplicação publicada na Vercel, conectada ao repositório GitHub
(`github.com/joaovictorpt/cuidadores-app`) via integração nativa — todo push
na branch `main` dispara um deploy automático de produção, sem passo manual.

- **`"build": "prisma generate && next build"`** — o script `build` chama
  `prisma generate` explicitamente antes do `next build`, em vez de confiar
  só no `postinstall` (que também existe, como rede de segurança redundante,
  ver abaixo). Motivo: um deploy quebrou em produção com o erro "Property
  `birthDate` does not exist" logo depois da migration que adicionou esse
  campo — o `schema.prisma` já tinha a coluna nova, mas o `@prisma/client`
  gerado (que fica em `node_modules/.prisma/client`, incluído no cache de
  dependências da Vercel entre builds) ainda era da versão anterior do
  schema. **Causa raiz real, não só teórica**: ao investigar, o
  `"postinstall": "prisma generate"` mencionado neste documento nunca tinha
  sido efetivamente adicionado ao `package.json` (só existia aqui na
  documentação) — então não havia *nenhum* passo garantindo Prisma Client
  atualizado no build, cache ou não. Isso já foi corrigido (`postinstall`
  agora existe de verdade, ver abaixo), mas o `prisma generate` explícito no
  `build` fica como proteção adicional independente disso: mesmo se o
  `postinstall` for pulado (a Vercel pode reaproveitar `node_modules` do
  cache sem rodar hooks de instalação quando nenhuma dependência declarada
  mudou — só o schema, que não é uma dependência do npm), o `build` gera o
  client de novo de qualquer forma. As duas entradas coexistem de propósito:
  redundância segura, não conflito.
- **`package.json` também tem `"postinstall": "prisma generate"`** —
  mesma necessidade (Prisma Client sincronizado com o schema), só que
  disparado em qualquer `npm install` (local ou CI), não só no `build` da
  Vercel.
- **Banco de dados**: mesma instância do Supabase usada em desenvolvimento
  (não há ambiente de staging/produção separado — decisão consciente de
  simplicidade para o escopo de TCC, não recomendada para um produto real
  com usuários de verdade).
- **Variáveis de ambiente configuradas nas Environment Variables do projeto
  na Vercel** (mesmos nomes do `.env` local): `DATABASE_URL`, `DIRECT_URL`,
  `NEXTAUTH_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, e
  `NEXTAUTH_URL` (**esta precisa ser o domínio de produção real,
  `https://cuidadores-app.vercel.app` — não `localhost`**; sem isso o login
  falha em produção).
- Domínio de produção estável: `cuidadores-app.vercel.app` (a Vercel também
  gera uma URL única por deploy, com hash, que não deve ser usada em nenhuma
  variável de ambiente por não ser permanente).

## Dados de demonstração

`scripts/seed-demo.ts` gera dados fictícios (**15 cuidadores, 15 famílias**,
contratações e avaliações) para usar ao vivo na apresentação do TCC. Roda com
`npm run seed:demo`. Escala original era 5 cuidadores/3 famílias — aumentada
para 15/15 para que busca e matching tenham volume suficiente pra produzir
resultados interessantes (várias páginas de resultado, scores/distâncias
variados, Gale-Shapley com rejeições/deslocamentos reais em vez de um caso
trivial de poucos pares).

- **Idempotente**: apaga todo dado de demonstração anterior antes de inserir
  qualquer coisa (identificado pelo domínio de email exclusivo
  `@demo.trevo.app`) — pode rodar de novo a qualquer momento sem duplicar
  registros nem acumular lixo de execuções passadas.
- **Roda contra o mesmo banco Supabase de produção** (não há staging
  separado — mesma decisão já registrada na seção "Deploy (Vercel)"). Por
  isso o script nunca deve ser executado sem confirmação explícita antes.
- Endereços reais na região metropolitana de Goiânia, espalhados por **seis
  cidades** — Goiânia, Aparecida de Goiânia, Trindade e Senador Canedo (já
  usadas na escala original 5/3) mais **Goianira** e **Bela Vista de
  Goiás** (adicionadas na expansão pra 15/15, pra variar ainda mais a
  distância nos resultados de busca) — geocodificados de verdade via
  `lib/geocoding.ts`, não há latitude/longitude hardcoded.
- Todos os usuários demo (família e cuidador) compartilham a senha
  `Demo@2026`, hasheada com bcrypt como qualquer outro usuário. Ao final da
  execução, o script imprime uma tabela com email/senha/role de cada
  conta criada, para consulta rápida durante a apresentação.
- `scripts/cleanup-demo.ts` (`npm run cleanup:demo`) remove os dados de
  demonstração **sem recriá-los** — útil para simplesmente limpar o banco
  depois da apresentação, sem rodar o seed completo (e sem esperar a
  geocodificação) de novo. Reaproveita a mesma função `cleanup()` exportada
  de `scripts/seed-demo.ts` em vez de duplicar a lógica; `seed-demo.ts` só
  executa seu próprio `main()` quando rodado diretamente (`require.main ===
  module`), então importar `cleanup` dali não dispara um seed completo como
  efeito colateral.
- **`careTypes`/`neededCareTypes` variados entre os 15+15**: mistura de
  combinações de 1, 2 e os 3 tipos (`CareType`) tanto do lado cuidador
  quanto família, pra que a interseção usada por `isEligiblePair`/
  `computeMatchScore` produza resultados desiguais entre os pares em vez de
  todo mundo compatível com todo mundo.
- **`hourlyRate` (cuidadores) espalhado entre R$18 e R$70** e
  **`experienceYears` entre 0 e 20 anos** — cobrindo os extremos da faixa
  pedida, não só o miolo, pra que `computeMatchScore`/`computePriceScore`
  tenham variação real de sinal entre os candidatos.
- **`hourlyBudget` em 7 das 15 `FamilySeed`** (as outras 8 ficam sem,
  exercitando a camada 2/3 de fallback de `computePriceScore` — normalização
  relativa ou neutro, nunca a comparação real de orçamento): valores
  espalhados de R$15 a R$80, deliberadamente cobrindo tanto orçamentos
  baixos (abaixo do que a maioria dos cuidadores compatíveis cobra) quanto
  altos (acima). O caminho "com orçamento" também continua coberto
  isoladamente pelo cenário `seedBudgetScenario` em
  `scripts/test-matching.ts` (família fictícia própria, criada e limpa à
  parte do dataset de demo).
- **`visibleToCaregivers: false` em 3 das 15 famílias** (Souza, Correia,
  Peixoto) — demonstra o controle de visibilidade da família funcionando:
  cada uma some da busca e do match perfeito de qualquer cuidador, mas
  continua enxergando cuidadores normalmente na própria busca dela.
- **`visibleToFamilies: false` em 3 dos 15 cuidadores** (Elisa, Eduardo,
  Camilla) — o espelho do ponto acima do outro lado: cada um some da
  busca/match de qualquer família, mas continua enxergando famílias
  normalmente na própria busca dele. Elisa e Camilla também estão
  `UNAVAILABLE`, uma combinação narrativamente coerente (indisponível *e*
  fora de busca).
- **`availabilityStatus` variado entre os 15 cuidadores**, cobrindo bem os
  três valores do enum (não concentrado em `AVAILABLE`): 6 `AVAILABLE`, 5
  `BUSY`, 4 `UNAVAILABLE`.
- **`HIRE_SEEDS` expandido de 4 para 8 registros**, cobrindo agora os 5
  status possíveis (os 4 originais já tinham `PENDING`/`ACCEPTED`/
  `COMPLETED`; os 4 novos acrescentam o primeiro `REJECTED` e o primeiro
  `CANCELLED` do dataset de demo) e variando `initiatedBy` entre `FAMILY` e
  `CAREGIVER`. **Deliberadamente concentrado** nas 3 famílias e nos 3
  cuidadores originais da escala 5/3 (Pereira/Souza/Ribeiro e Ana Paula/
  Bruno/Diego) em vez de espalhado pelos 15+15 — essas 6 contas viram
  "vitrine" com 2-3 `Hire`s cada (ex.: Pereira e Diego aparecem em 3
  cada, incluindo uma segunda interação **Pereira×Ana Paula** que já tinha
  sido `REJECTED` antes da que terminou `COMPLETED` — válido porque os
  dois são status terminais, então `activeHireKey` fica `null` nos dois e a
  constraint `UNIQUE` nunca conflita), enquanto os outros 12 famílias e 12
  cuidadores adicionados na expansão não têm nenhum `Hire` — eles existem
  pra povoar busca/matching, não as telas de contratações/solicitações.
  Todos os 8 continuam com `careType` real dentro da interseção do par (ver
  "Tipo de cuidado do Hire") e nenhum fica com `careType: null`.

# Proteção de dados pessoais e LGPD (rascunho para a monografia)

Rascunho da seção de LGPD do TCC. A análise foi feita sobre o commit
`d917a88`; a seção 8 registra as correções feitas depois dela. Os números de artigo se referem à Lei nº 13.709/2018
(LGPD) e devem ser conferidos no texto oficial
(planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm) antes de
entrar na versão final. Este texto é análise técnica de um protótipo
acadêmico, não um parecer jurídico.

## 1. Enquadramento

O Trevo trata **dados pessoais** (art. 5º, I) de dois grupos de titulares:
famílias que procuram cuidado e cuidadores que oferecem o serviço. Como o
cuidado envolve idosos, crianças e pessoas com deficiência, parte das
informações descreve a saúde de terceiros, o que pode configurar **dado
pessoal sensível** (art. 5º, II). Na hipótese de operação real, o
responsável pela plataforma seria o **controlador** (art. 5º, VI) e os
provedores de infraestrutura (Supabase, Vercel) seriam **operadores**
(art. 5º, VII).

Os princípios do art. 6º orientam a análise. Os mais relevantes para as
decisões técnicas do projeto são:

- **finalidade** (I) e **adequação** (II): cada dado coletado deve ter um
  propósito declarado e compatível com o serviço;
- **necessidade** (III): coletar o mínimo necessário para essa finalidade;
- **transparência** (VI): o titular deve saber o que é coletado e por quê;
- **segurança** (VII) e **prevenção** (VIII): medidas técnicas para evitar
  acesso não autorizado e danos;
- **responsabilização e prestação de contas** (X): demonstrar que as
  medidas foram adotadas e são eficazes.

O último princípio é o elo com o experimento deste trabalho: o benchmark e
as hipóteses registradas antes da execução (`docs/hipoteses-e-criterios.md`)
são uma forma de **demonstrar** a eficácia de uma medida de segurança, e não
apenas afirmá-la.

## 2. Inventário dos dados tratados

| Dado | Titular | Finalidade | Necessário? | Proteção no banco | Quem vê |
|---|---|---|---|---|---|
| E-mail | ambos | login e identificação da conta | sim | texto puro | só o próprio titular |
| Senha | ambos | autenticação | sim | hash bcrypt, custo 12 | ninguém |
| Nome | ambos | identificação para a outra parte | sim | texto puro | qualquer usuário logado; **visitantes, no caso das avaliações** (seção 5) |
| Data de nascimento | ambos | confirmar maioridade (18+) | **só a maioridade**, não a data | texto puro | ninguém (nunca exibida) |
| Telefone | ambos | contato depois do aceite | sim | **duas camadas** (Trevo + AES-256-GCM) | a outra parte, só com `Hire` aceito ou concluído |
| Endereço | família | calcular distância | só a localização aproximada | **duas camadas** | só o próprio titular |
| Latitude e longitude | ambos | busca por raio e distância | sim, mas não com precisão de rua | **texto puro** | ninguém diretamente; a distância derivada é exibida |
| Cidade e estado | ambos | busca e exibição | sim | texto puro | qualquer usuário logado |
| Bio (texto livre) | ambos | apresentação | sim | texto puro | qualquer usuário logado |
| Tipos de cuidado | ambos | compatibilidade | sim | texto puro | qualquer usuário logado |
| Valor/orçamento por hora | ambos | componente de preço do matching | não (opcional) | texto puro | qualquer usuário logado |
| Documentos (identidade, antecedentes, certificados) | cuidador | verificação futura | depende do fluxo de verificação, que não existe | bucket privado, links temporários de 5 min | só o próprio cuidador |
| Mensagem do `Hire` | ambos | primeiro contato | sim | texto puro | as duas partes |
| Avaliação (nota e comentário) | família (autora) e cuidador (alvo) | reputação | sim | texto puro | **público, sem login** |

A sessão não fica no banco: é um JWT em cookie, com `id` e `role`. Os logs
de falha de decifração registram apenas o nome do campo e o id do dono,
nunca o valor.

## 3. Dados sensíveis

Três pontos do inventário merecem tratamento à parte:

1. **Saúde em texto livre.** A bio e a mensagem do `Hire` são campos
   abertos, e a finalidade deles leva naturalmente a descrever a saúde da
   pessoa cuidada. O próprio texto de exemplo usado nos testes deste
   trabalho menciona "diabetes e pressão alta". Esse conteúdo é dado
   sensível (art. 5º, II) e hoje fica em texto puro, visível a qualquer
   usuário logado. Para dado sensível, a base legal mais segura no contexto
   da plataforma é o **consentimento específico e destacado** (art. 11, I),
   que o cadastro atual não coleta.
2. **Tipo de cuidado "necessidades especiais".** Não descreve uma condição
   específica, mas permite inferir que alguém da família tem deficiência.
   É um dado sensível por inferência.
3. **Dados de terceiros e de crianças.** A pessoa cuidada não é usuária da
   plataforma, mas seus dados aparecem no perfil da família. Quando é uma
   criança, aplica-se o art. 14, que exige tratamento no melhor interesse
   dela e consentimento de um dos pais ou responsável. O titular da conta
   costuma ser exatamente esse responsável, o que ajuda, mas o cadastro não
   registra esse consentimento.

A certidão de **antecedentes criminais** não aparece no rol do art. 5º, II,
mas tem alto potencial de dano e discriminação. A exigência dela de quem
cuida de idosos, crianças ou pessoas com deficiência tem respaldo na
jurisprudência trabalhista (TST, incidente de recursos repetitivos sobre
exigência de antecedentes, 2017; **conferir a referência exata**), desde que
justificada pela natureza da atividade. No protótipo, o arquivo é guardado,
mas nenhum fluxo o analisa, o que contraria o princípio da necessidade: o
documento é coletado sem que a finalidade declarada (verificação) aconteça.

## 4. Medidas técnicas adotadas

| Medida | Princípio / artigo | Onde |
|---|---|---|
| Senhas com bcrypt, custo 12 | segurança (art. 6º, VII; art. 46) | `lib/auth.ts`, `POST /api/register` |
| Telefone e endereço em duas camadas, com AAD ligando o valor ao dono e ao campo | segurança; ver seção 6 | `lib/field-encryption.ts` |
| Telefone liberado só depois do aceite | necessidade, prevenção | `/dashboard/hires/[id]` |
| Endereço nunca exibido a terceiros (o tipo usado na busca nem carrega o campo) | necessidade | `FamilyForDisplay` em `lib/matching.ts` |
| Controle de visibilidade por lado do marketplace | autodeterminação informativa, transparência | `visibleToCaregivers`, `visibleToFamilies` |
| Controle de acesso por papel e 404 que não revela se o recurso existe | segurança | `middleware.ts`, `/dashboard/hires/[id]` |
| Validação de entrada (Zod) e consultas parametrizadas (Prisma) | segurança, prevenção | rotas de API |
| Documentos em bucket privado, com links temporários | segurança | `lib/documents.ts` |
| Bloqueio de cadastro de menores de 18 anos | adequação | `lib/age.ts` |
| Dados de demonstração fictícios, com domínio de e-mail próprio | necessidade (sem dados reais no teste) | `scripts/seed-demo.ts` |

## 5. Lacunas encontradas (limitações do protótipo)

Esta análise encontrou as lacunas abaixo. Elas devem aparecer no texto como
limitações, e as mais simples podem virar trabalhos futuros ou correções
antes da defesa.

**Lacunas técnicas que enfraquecem a própria criptografia:**

1. **Coordenadas em texto puro.** O endereço é cifrado, mas a latitude e a
   longitude obtidas dele ficam abertas no banco, com precisão de rua.
   Quem lê o banco (o atacante A1 do modelo de ameaça) recupera a
   localização da casa sem precisar quebrar nenhuma cifra. A busca usa um
   raio de 50 km, então arredondar as coordenadas para 2 casas decimais
   (cerca de 1 km) não prejudica o matching.
2. **Triangulação pela distância exibida.** A busca do cuidador mostra a
   distância até a família com precisão de 0,1 km. A localização do
   cuidador vem da cidade que ele informa. Trocando de cidade algumas vezes
   e anotando as distâncias, um cuidador mal-intencionado consegue estimar
   onde a família mora. Exibir faixas ("até 5 km", "5 a 15 km") reduz esse
   risco.
3. **Geocodificação em serviço externo.** O endereço completo é enviado, em
   texto puro, ao Nominatim (OpenStreetMap), um serviço de terceiros fora
   do Brasil. É um compartilhamento de dado pessoal com transferência
   internacional (art. 33) que precisa ser informado ao titular.

**Lacunas de direitos do titular (art. 18):**

4. **Sem exclusão de conta.** Não há rota para o titular eliminar os
   próprios dados. Além disso, `Hire` e `Review` referenciam `User` sem
   exclusão em cascata, então excluir um usuário com histórico falharia no
   banco. A solução exige decidir o que acontece com o histórico da outra
   parte (por exemplo, anonimizar em vez de apagar).
5. **Sem exportação** (portabilidade e acesso).
6. **Correção parcial.** Nome e data de nascimento não podem ser editados
   depois do cadastro.

**Lacunas de transparência e governança:**

7. **Sem política de privacidade nem registro de consentimento**, o que
   inclui o consentimento destacado para dados sensíveis.
8. **Avaliações públicas.** `GET /api/reviews` não exige login e devolve o
   nome da família que avaliou, o comentário e identificadores internos. Um
   visitante anônimo descobre quem contratou qual cuidador.
9. **Data de nascimento guardada sem necessidade.** A finalidade é só
   confirmar a maioridade; a data completa nunca volta a ser usada.
10. **Sem política de retenção** (art. 16): perfis, documentos e históricos
    ficam guardados indefinidamente.
11. **Mesmo banco para desenvolvimento e produção**, decisão de escopo
    registrada no projeto, inadequada para dados reais.

## 6. O papel da criptografia diante da LGPD

A criptografia é uma das medidas do art. 46, mas **não garante conformidade
sozinha**, por três motivos:

- **Dado cifrado continua sendo dado pessoal.** O controlador tem a chave e
  pode reverter a cifra a qualquer momento. Por isso o dado cifrado não é
  anonimizado (art. 12); no máximo se aproxima da pseudonimização
  (art. 13, § 4º).
- **A criptografia só cobre o que cifra.** As lacunas 1 e 2 mostram que
  proteger o endereço não adianta se um dado derivado dele (as coordenadas)
  continua exposto. A proteção vale para o conjunto dos dados, não para um
  campo isolado.
- **A criptografia não substitui finalidade, necessidade e direitos.** Um
  dado desnecessário cifrado continua desnecessário.

Onde a criptografia pesa juridicamente é no **incidente de segurança**. Ao
avaliar a gravidade de um incidente, considera-se se os dados afetados
estavam ininteligíveis para terceiros não autorizados (art. 48, § 3º). Num
vazamento do banco do Trevo, telefone e endereço estariam nessa condição.
Os resultados do benchmark sustentam essa afirmação para a camada AES:
adulterações (H4) e entradas inválidas, incluindo chave errada (H5), foram
100% detectadas. A cópia de um valor cifrado para outro usuário ou campo é
barrada pela AAD (`npm run demo:attacks`, seção 5). Essa proteção depende do sigilo da chave mestra: como as duas camadas
derivam da mesma chave, um vazamento dela compromete ambas.

## 7. Recomendações, em ordem de custo

1. Exigir login em `GET /api/reviews` e devolver só o primeiro nome do
   autor (baixo custo).
2. Arredondar latitude e longitude e exibir a distância em faixas (baixo
   custo, fecha as lacunas 1 e 2).
3. Aviso no campo de bio para não incluir informações de saúde
   identificáveis, mais um consentimento destacado no cadastro (baixo
   custo).
4. Guardar só a confirmação de maioridade, não a data de nascimento
   (médio: exige migração).
5. Política de privacidade descrevendo dados, finalidades, operadores e o
   envio ao Nominatim (médio: é texto, não código).
6. Exclusão de conta com anonimização do histórico e exportação dos dados
   (alto).
7. Política de retenção e um fluxo real de verificação de documentos, ou
   deixar de coletá-los enquanto ele não existir (alto).

## 8. Correções feitas depois da análise

A análise das seções 2 a 7 descreve o sistema como estava no commit
`d917a88`. Depois dela foram feitas as correções abaixo. Ao implementar a
correção das lacunas 1 e 2 apareceu uma exposição mais grave, que a análise
não tinha visto (item A).

| Lacuna | Situação | Onde |
|---|---|---|
| **A (nova).** A busca do cuidador enviava ao navegador as coordenadas exatas de cada família: a página passava a um Client Component o objeto completo da família, e tudo que vai como prop é serializado no HTML | **Corrigida.** O navegador do cuidador recebe só nome, cidade, estado, descrição, tipos de cuidado, orçamento e a faixa de distância | `FamilySearchResult` em `lib/matching.ts` |
| 1. Coordenadas com precisão de rua | **Corrigida.** Guardadas com 2 casas decimais (~1 km). Os dados antigos precisam do script `npm run round:coordinates -- --apply` | `lib/location-privacy.ts`, `lib/geocoding.ts` |
| 2. Triangulação pela distância | **Corrigida.** O cuidador vê faixas (até 5 km, 5 a 10, 10 a 20, 20 a 50); a API de busca de famílias e o match perfeito também | `formatDistanceBand` |
| 3. Endereço enviado ao Nominatim | **Mitigada.** Informada na política de privacidade; o envio continua | `app/privacidade/page.tsx` |
| 4. Sem exclusão de conta | **Corrigida.** Exclusão com confirmação de senha: apaga perfil, contatos, descrição e documentos; anonimiza o usuário; cancela contratações em andamento; mantém o histórico da outra parte sem o nome | `lib/account.ts`, `DELETE /api/account` |
| 5. Sem exportação | **Corrigida.** Download em JSON com telefone e endereço decifrados | `GET /api/account/export` |
| 6. Correção parcial | Pendente | — |
| 7. Sem política nem consentimento | **Corrigida.** Página `/privacidade`; aceite obrigatório no cadastro (`User.privacyAcceptedAt`); consentimento separado e destacado para dados de saúde, sem o qual a descrição da família não é gravada, e cuja revogação apaga a descrição (`FamilyProfile.healthDataConsentAt`) | `app/components/consent-checkboxes.tsx` |
| 8. Avaliações públicas | **Corrigida.** Exige login e devolve só o primeiro nome do autor | `GET /api/reviews` |
| 9. Data de nascimento guardada | Pendente | — |
| 10. Sem política de retenção | Pendente | — |
| 11. Mesmo banco em desenvolvimento e produção | **Corrigida.** Na publicação nas contas próprias, a produção passou a um projeto Supabase separado em São Paulo, e o desenvolvimento usa um PostgreSQL local; as conexões de produção exigem TLS (`sslmode=require`) | `.env.producao`, variáveis da Vercel |

Contas criadas antes dessas mudanças não têm o aceite da política nem o
consentimento para dados de saúde registrados. As descrições antigas
continuam gravadas até a família editar o perfil; tratar esse legado (pedir
o consentimento no próximo acesso ou apagar as descrições) fica como
trabalho futuro.

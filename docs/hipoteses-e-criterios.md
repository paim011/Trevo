# Hipóteses e critérios de avaliação do experimento

Este documento registra as perguntas, as previsões e os critérios de
aceitação do experimento **antes** da execução oficial do benchmark
(`npm run benchmark`). O commit que o introduz serve como registro de data:
qualquer mudança posterior nas hipóteses deve ser feita em um novo commit e
justificada no texto do TCC, nunca editando silenciosamente este arquivo para
combinar com os resultados.

## 1. Cenários comparados

| Cenário | O que é | Chave | Implementação |
|---|---|---|---|
| **C1** | Cifra Trevo sozinha | K1 (32 bytes) | `lib/trevo-cipher.ts` |
| **C2** | AES-256-GCM sozinho | K2 (32 bytes), IV aleatório de 12 bytes, AAD | `lib/aes-gcm.ts` (`node:crypto`) |
| **C3** | Combinação usada na aplicação: Trevo por dentro, GCM por fora | K1 e K2 | as duas acima, na ordem de `lib/field-encryption.ts` |

K1 e K2 são derivadas por HKDF-SHA256 da mesma chave mestra, como na
aplicação. C1 usa a mesma K1 de C3 e C2 usa a mesma K2 de C3, para que as
diferenças observadas venham só da composição.

Os três cenários operam sobre bytes. A formatação de armazenamento
(`v1:<iv>:<texto>:<tag>` em base64url) fica fora das medidas de tempo, porque
C1 e C2 não têm um formato equivalente; o tamanho desse formato é informado à
parte.

## 2. Modelo de ameaça

Considerado:

- **A1, leitura do banco**: o atacante obtém uma cópia do banco (vazamento,
  backup exposto, injeção de SQL), mas não a chave mestra.
- **A2, escrita no banco**: o atacante altera bytes de um valor cifrado ou
  copia o valor cifrado de um usuário para outro usuário ou outro campo.
- **A3, conhecimento de contexto**: o atacante conhece a língua dos dados
  (português) e o formato dos campos (telefone com 11 dígitos, endereço).

Fora do escopo:

- Comprometimento do servidor ou da variável `FIELD_ENCRYPTION_KEY`. Como K1
  e K2 vêm da mesma chave mestra, vazar a chave mestra quebra **as duas
  camadas ao mesmo tempo**. A camada Trevo só protege num cenário em que K2
  vaza e a chave mestra não, ou em que o próprio AES seja quebrado.
- Ataques de canal lateral (tempo, cache, consumo de energia).
- Segurança do transporte (HTTPS) e das sessões, tratadas por mecanismos
  consolidados da aplicação e não comparadas aqui.

## 3. Pergunta central

**A combinação (C3) apresenta alguma vantagem mensurável sobre o AES-256-GCM
sozinho (C2), dentro do modelo de ameaça acima, e a que custo?**

Previsão registrada: **não**. Espera-se que C2 já satisfaça todos os
critérios de segurança medidos, que C3 os satisfaça igualmente (sem piorar) e
que C3 seja mais lenta. Se a previsão se confirmar, a contribuição da camada
Trevo é didática e de defesa em profundidade contra cenários fora do modelo,
não um ganho de segurança demonstrado.

## 4. Hipóteses e critérios

Cada hipótese tem um critério decidido agora. "Confirmada" e "refutada" se
referem a esse critério, não à impressão geral dos números.

### H1. Correção

Os três cenários recuperam exatamente a entrada original.

- Entradas: todos os tamanhos de 0 a 300 bytes, mais 1, 4, 16 e 64 KiB; três
  tipos (bytes aleatórios, texto UTF-8 com acentos, bytes zerados).
- Critério: **0 falhas** em cada cenário.

### H2. Desempenho

C3 é mais lenta que C2 em todos os tamanhos, mas continua viável para campos
de cadastro.

- Medida: tempo por operação de cifrar e de decifrar, separados; tamanhos 16,
  64, 256, 1.024, 4.096, 16.384 e 65.536 bytes; 30 rodadas, cenários
  alternados dentro de cada rodada; média, desvio padrão, mediana, mínimo,
  máximo e intervalo de confiança de 95% da média. Também o tempo de CPU.
- Critério (a): C3 mais lenta que C2 quando os intervalos de confiança de 95%
  **não se sobrepõem**.
- Critério (b), viabilidade: mediana de C3 **abaixo de 1 ms** para cifrar e
  para decifrar entradas de até 1.024 bytes. O limite de 1 ms é da mesma
  ordem de uma consulta ao banco, então um custo abaixo dele não é o gargalo
  de uma requisição.
- Sem previsão firme sobre C1 vs. C2: C1 é TypeScript puro e recria a S-box a
  cada chamada; C2 é código nativo. Espera-se C1 mais lenta em entradas
  grandes, mas isso é observado, não testado.

### H3. Expansão do dado

- Previsão: C1 não aumenta o tamanho (0 byte extra). C2 e C3 acrescentam
  exatamente 28 bytes (IV de 12 + tag de 16), independentemente do tamanho.
- Critério: os valores medidos são iguais aos previstos.

### H4. Detecção de adulteração (A2)

- Medida: 1.000 tentativas por cenário, cada uma invertendo um bit aleatório
  da saída armazenada (para C2 e C3, IV + texto cifrado + tag).
- Critério: C2 e C3 detectam (lançam erro) em **100%** das tentativas. C1
  detecta em **0%**, e o texto devolvido sai alterado sem aviso.

### H5. Entradas inválidas (A2)

Três casos: chave errada, texto cifrado truncado em 1 byte e texto cifrado
vazio.

- Critério: C2 e C3 lançam erro em **100%** dos casos. C1 não lança erro e
  devolve dados incorretos sem aviso.

### H6. Determinismo (A1)

- Medida: o mesmo texto (um telefone) cifrado 1.000 vezes com a mesma chave.
- Critério: C1 gera **1** saída distinta (revela valores repetidos no banco).
  C2 e C3 geram **1.000** saídas distintas.

### H7. Propriedades estatísticas da saída

- Entrada: texto em português de 2.363 bytes (os dois textos de
  `scripts/cryptanalysis.ts` juntos). Para C2 e C3 o resultado varia um pouco
  entre execuções, por causa do IV aleatório; com nível de 1%, espera-se que
  cerca de 1 em cada 100 execuções rejeite a uniformidade por acaso.
- Medidas: entropia de Shannon por byte (máximo 8 bits), índice de
  coincidência (aleatório ≈ 0,0039) e teste qui-quadrado de uniformidade (255
  graus de liberdade, nível de significância de 1%).
- Critério: o texto puro e C1 **rejeitam** a uniformidade. C2 e C3 **não
  rejeitam**.
- Ressalva: passar em testes estatísticos é condição necessária, não
  suficiente. Uma cifra fraca pode produzir saída de aparência uniforme. Este
  teste só pode **refutar** segurança, nunca prová-la.

### H8. Difusão (efeito avalanche)

- Medida: 1.000 tentativas com entradas de 64 bytes. Para alteração de
  **1 bit da entrada**, porcentagem de bits da saída que mudam. Para C2 e C3
  o IV é fixado **só nesta medida**, senão o IV aleatório mascara o efeito;
  na aplicação o IV nunca é fixo. O corpo cifrado e a tag são medidos à parte.
- Também alteração de **1 bit da chave**: K para C1 e C2; K1 e K2
  separadamente para C3.
- Previsão para alteração da entrada: nenhum cenário passa de **5%** dos bits
  do corpo cifrado. C1 muda cerca de 1 byte (folha 1 e folha 2 atuam byte a
  byte). C2 muda exatamente 1 bit, porque o GCM cifra em modo contador. C3
  muda cerca de 1 byte, porque herda o comportamento de C1. Só a tag do GCM
  deve chegar perto de 50%. Em outras palavras: **a combinação não acrescenta
  difusão**.
- Previsão para alteração da chave: C2 e C3 (K2) perto de 50%. Para C1 e C3
  (K1), sem previsão firme.

### H9. Ataque de frequência (A1 + A3)

- Medida: o mesmo ataque da demonstração (`npm run demo:attacks`), aplicado
  aos três cenários: mapeamento por ranking de frequência usando um texto de
  referência em português, mais força bruta das 5.910 ordens de colunas.
  Comparado com um **chute trivial**, que preenche toda posição com o byte
  mais comum do português (o espaço). Sem essa base, uma taxa de acerto de
  poucos por cento pareceria significativa quando não é.
- Critério: nenhum cenário supera o chute trivial.
- Transparência: o resultado de C1 neste ataque já foi observado na
  demonstração (commit `ae1fc29`, cerca de 1% de acerto), então H9 **não é
  uma previsão cega** para C1. É um teste fraco: um ataque específico contra
  a repetição da chave a cada 32 bytes (método de Kasiski) não foi
  implementado e fica registrado como limitação.

## 5. O que este experimento não permite concluir

- Que a Cifra Trevo é segura. Nenhum dos testes acima prova resistência
  criptográfica; eles só podem expor fraquezas.
- Que C3 é mais segura que C2 por ter duas camadas. Uma vantagem só existe se
  algum critério de segurança separar C3 de C2, e a previsão é de que nenhum
  separa.
- Nada sobre ataques fora do modelo de ameaça (seção 2).

## 6. Reprodutibilidade

- Chaves, entradas e posições alteradas vêm de um gerador determinístico com
  semente (`--seed`, padrão `trevo-tcc`). Só os IVs do AES são aleatórios,
  como na aplicação. Com a mesma semente, todos os resultados, exceto os
  tempos e o que depende do IV, se repetem.
- Cada execução grava os CSVs e um `ambiente.json` (versão do Node, sistema
  operacional, processador, commit, semente e parâmetros) em
  `resultados/benchmark-<data>/`.
- A execução oficial deve rodar com o computador ligado na tomada e sem
  outros programas pesados abertos. O ideal é repetir em três execuções e
  verificar se as conclusões se mantêm.

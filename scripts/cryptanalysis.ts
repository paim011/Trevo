import { substitute, untranspose } from "@/lib/trevo-cipher";

// Ferramentas de criptoanálise compartilhadas por scripts/demo-attacks.ts e
// scripts/benchmark-ciphers.ts. Só código de análise -- nada daqui é usado
// pela aplicação.

export const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

// ---------------------------------------------------------------------------
// Textos usados no ataque de frequência e nas medidas estatísticas
// ---------------------------------------------------------------------------

// O alvo: um texto parecido com o que uma família escreveria no perfil.
export const TARGET_TEXT =
  "Minha mãe tem oitenta e dois anos e mora conosco desde o ano passado. Ela tem " +
  "diabetes e pressão alta, toma remédios três vezes ao dia e precisa de ajuda " +
  "para tomar banho e para se vestir. Durante a semana nós trabalhamos fora, então " +
  "procuramos uma pessoa de confiança que fique com ela de segunda a sexta, das " +
  "oito da manhã até as seis da tarde. É importante que a cuidadora tenha paciência, " +
  "porque a minha mãe às vezes fica confusa e repete as mesmas perguntas. Ela gosta " +
  "de conversar, de ouvir música antiga e de caminhar um pouco no quintal depois do " +
  "almoço. A pessoa também precisa controlar os horários dos remédios, preparar " +
  "refeições leves e com pouco sal, e avisar a família se notar qualquer mudança no " +
  "humor ou na saúde dela. Já tivemos uma experiência ruim com uma cuidadora que " +
  "faltava muito, por isso queremos alguém pontual e que tenha referências de outros " +
  "trabalhos. Moramos perto do centro, a casa é tranquila e tem um quarto separado " +
  "para descanso. Podemos conversar sobre o valor da hora e sobre os detalhes da " +
  "rotina antes de começar. O mais importante para nós é que a minha mãe se sinta " +
  "segura, respeitada e bem cuidada enquanto estamos no trabalho.";

// O "conhecimento do atacante": um texto qualquer em português, sem relação
// com o alvo, de onde ele tira a frequência típica de cada byte na língua.
export const REFERENCE_TEXT =
  "A cidade amanheceu com chuva fina e o trânsito ficou lento desde cedo. Nas " +
  "padarias do bairro, as pessoas comentavam a previsão do tempo para o fim de " +
  "semana e a festa da escola, que estava marcada para o sábado à tarde. Os " +
  "professores passaram a semana preparando as apresentações dos alunos, com " +
  "músicas, danças e uma pequena peça de teatro sobre a história da cidade. No " +
  "mercado, os preços das frutas subiram um pouco por causa da chuva, mas o " +
  "movimento continuou grande, porque muita gente aproveita a manhã para fazer as " +
  "compras da semana. Na praça, um grupo de idosos se reúne todos os dias para " +
  "jogar dominó e conversar sobre futebol, política e os acontecimentos do bairro. " +
  "Eles dizem que a praça mudou muito nos últimos anos, que antes havia mais " +
  "árvores e menos carros, e que as crianças brincavam na rua até a noite. Alguns " +
  "moradores pediram à prefeitura que instale mais bancos e uma cobertura para os " +
  "dias de sol forte. A resposta ainda não veio, mas eles continuam se encontrando " +
  "ali, com chuva ou com sol, porque a conversa da manhã já faz parte da rotina de " +
  "todos e ninguém quer abrir mão desse costume tão antigo.";

// ---------------------------------------------------------------------------
// Frequência de bytes
// ---------------------------------------------------------------------------

export function byteCounts(data: Uint8Array): number[] {
  const counts = new Array<number>(256).fill(0);
  for (const byte of data) counts[byte]++;
  return counts;
}

/** Bytes ordenados do mais para o menos frequente. */
export function frequencyRanking(data: Uint8Array): number[] {
  const counts = byteCounts(data);
  return counts
    .map((count, byte) => ({ byte, count }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || a.byte - b.byte)
    .map(({ byte }) => byte);
}

/**
 * Índice de coincidência (Friedman): probabilidade de dois bytes sorteados
 * do texto serem iguais. Texto em linguagem natural tem índice alto, porque
 * poucos símbolos se repetem muito; um texto bem embaralhado tende a
 * 1/256 ≈ 0,0039.
 */
export function indexOfCoincidence(data: Uint8Array): number {
  const n = data.length;
  const sum = byteCounts(data).reduce((total, count) => total + count * (count - 1), 0);
  return sum / (n * (n - 1));
}

// ---------------------------------------------------------------------------
// Ataque de frequência
// ---------------------------------------------------------------------------

/**
 * Ataque clássico de análise de frequência contra substituição: o byte mais
 * frequente do texto cifrado é trocado pelo byte mais frequente da língua, o
 * segundo pelo segundo, e assim por diante.
 */
export function frequencyAttackMap(ciphertext: Uint8Array, reference: Uint8Array): Uint8Array {
  const cipherRanking = frequencyRanking(ciphertext);
  const languageRanking = frequencyRanking(reference);
  const guess = new Uint8Array(256);
  cipherRanking.forEach((byte, rank) => {
    guess[byte] = languageRanking[rank] ?? 0x3f; // "?" quando faltar referência
  });
  return guess;
}

/** Fração de posições em que o texto recuperado acerta o byte original. */
export function accuracy(recovered: Uint8Array, original: Uint8Array): number {
  let hits = 0;
  for (let i = 0; i < original.length; i++) {
    if (recovered[i] === original[i]) hits++;
  }
  return hits / original.length;
}

const COMMON_WORDS = [" de ", " que ", " e ", " o ", " a ", " do ", " da ", " para ", " com ", " se "];

/** Pontua um candidato pela quantidade de palavras comuns do português. */
export function portugueseScore(candidate: Uint8Array): number {
  const text = Buffer.from(candidate).toString("latin1");
  return COMMON_WORDS.reduce((score, word) => score + text.split(word).length - 1, 0);
}

function* permutations(size: number): Generator<number[]> {
  if (size === 1) {
    yield [0];
    return;
  }
  for (const smaller of permutations(size - 1)) {
    for (let position = 0; position <= smaller.length; position++) {
      yield [...smaller.slice(0, position), size - 1, ...smaller.slice(position)];
    }
  }
}

/**
 * A folha 3 tem de 3 a 7 colunas, então existem só 3! + 4! + ... + 7! =
 * 5.910 ordens possíveis: o atacante testa todas e fica com a que gera o
 * texto com mais cara de português.
 */
export function bruteForceTransposition(ciphertext: Uint8Array, guess: Uint8Array) {
  let best = { candidate: ciphertext, score: -1 };
  let tried = 0;

  for (let columns = 3; columns <= 7; columns++) {
    for (const order of permutations(columns)) {
      tried++;
      const candidate = substitute(untranspose(ciphertext, order), guess);
      const score = portugueseScore(candidate);
      if (score > best.score) {
        best = { candidate, score };
      }
    }
  }

  return { candidate: best.candidate, tried };
}

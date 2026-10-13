import {
  CareType,
  CaregiverAvailability,
  CaregiverProfile,
  FamilyProfile,
} from "@prisma/client";

import { getSharedCareTypes } from "@/lib/care-types";
import { stableMatching } from "@/lib/gale-shapley";
import { haversineDistanceKm } from "@/lib/haversine";
import { distanceBand } from "@/lib/location-privacy";
import { matchingConfig } from "@/lib/matching-config";
import { prisma } from "@/lib/prisma";
import { calculateAverageRating } from "@/lib/reviews";

export type CaregiverForMatching = {
  id: string;
  userId: string;
  name: string | null;
  bio: string | null;
  hourlyRate: number | null;
  careTypes: CareType[];
  latitude: number | null;
  longitude: number | null;
  averageRating: number | null;
  reviewCount: number;
  // Se este cuidador deve aparecer quando uma família busca/faz matching --
  // aplicado em findCandidateCaregivers, nunca em isEligiblePair (ver o
  // comentário dessa função para o porquê: o argumento `caregiver` de
  // isEligiblePair assume papéis diferentes -- buscador fixo vs. candidato --
  // dependendo de qual direção do grafo está chamando).
  visibleToFamilies: boolean;
  // Puramente informativo -- carregado através dos resultados de busca/matching
  // para exibição, nunca lido por isEligiblePair/computeMatchScore.
  availabilityStatus: CaregiverAvailability;
};

export type FamilyForMatching = {
  latitude: number | null;
  longitude: number | null;
  neededCareTypes: CareType[];
  hourlyBudget: number | null;
  // Espelha CaregiverForMatching.visibleToFamilies do outro lado do
  // grafo -- aplicado em findCandidateFamilies.
  visibleToCaregivers: boolean;
};

// Igual a FamilyForMatching, mas carregando uma identidade (o id do User) para
// que possa ser usado como chave de preferência de proposer/receiver.
// rankCaregiversForFamily não precisa disso (só lida com uma família por vez),
// mas as funções de construção de preferências abaixo ranqueiam várias
// famílias umas contra as outras, então precisam de algo para distingui-las.
export type FamilyCandidate = FamilyForMatching & {
  userId: string;
};

export type RankedCaregiver = {
  caregiver: CaregiverForMatching;
  distanceKm: number;
  matchScore: number;
};

// FamilyCandidate mais os campos necessários para de fato mostrar uma família
// a um cuidador (rankFamiliesForCaregiver / GET /api/search/families). Falta
// notável: `address` -- o endereço completo nunca é exposto a um cuidador
// navegando/com match entre famílias, só cidade/estado (ver CLAUDE.md
// "Busca de famílias pelo cuidador").
export type FamilyForDisplay = FamilyCandidate & {
  name: string | null;
  city: string | null;
  state: string | null;
  bio: string | null;
};

export type RankedFamily<F extends FamilyCandidate = FamilyCandidate> = {
  family: F;
  distanceKm: number;
  matchScore: number;
};

// O que o navegador de um cuidador recebe de cada família da busca. Tudo que
// um Server Component passa como prop a um Client Component é serializado no
// HTML da página, então RankedFamily<FamilyForDisplay> não pode sair do
// servidor: ele carrega latitude/longitude da família (a localização da
// casa) e a distância exata (que permite triangular a casa). Aqui ficam só
// os campos de exibição e a faixa de distância -- ver lib/location-privacy.ts.
export type FamilySearchResult = {
  family: {
    userId: string;
    name: string | null;
    city: string | null;
    state: string | null;
    bio: string | null;
    neededCareTypes: CareType[];
    hourlyBudget: number | null;
  };
  distanceBand: number;
  matchScore: number;
};

export function toFamilySearchResult({
  family,
  distanceKm,
  matchScore,
}: RankedFamily<FamilyForDisplay>): FamilySearchResult {
  return {
    family: {
      userId: family.userId,
      name: family.name,
      city: family.city,
      state: family.state,
      bio: family.bio,
      neededCareTypes: family.neededCareTypes,
      hourlyBudget: family.hourlyBudget,
    },
    distanceBand: distanceBand(distanceKm),
    matchScore,
  };
}

// Wrapper de Haversine null-safe -- coordenadas são sempre opcionais (Float?)
// nos dois models de profile, então qualquer chamador trabalhando com um
// registro Prisma bruto (em vez de um candidato de matching já validado)
// precisa dessa proteção. Usado pelas buscas de "par com match" abaixo, cujo
// distanceKm é somente para exibição e por isso pode ser "não disponível" em
// vez de lançar erro.
function distanceKmOrNull(
  aLat: number | null | undefined,
  aLon: number | null | undefined,
  bLat: number | null | undefined,
  bLon: number | null | undefined
): number | null {
  if (aLat == null || aLon == null || bLat == null || bLon == null) {
    return null;
  }

  return haversineDistanceKm(aLat, aLon, bLat, bLon);
}

// Regra de elegibilidade compartilhada, usada tanto quando uma família está
// procurando cuidadores quanto quando um cuidador está procurando famílias:
// as duas direções do grafo bipartido precisam concordar sobre quais arestas
// existem, senão as listas de preferência dos dois lados nem estariam
// falando do mesmo conjunto de pares possíveis.
//
// Deliberadamente NÃO checa visibleToFamilies/visibleToCaregivers aqui,
// mesmo que os dois argumentos carreguem essas flags: esta função é chamada
// com o PRÓPRIO profile do lado que está buscando como um argumento e um
// candidato de uma lista como o outro (ver findCandidateCaregivers/
// findCandidateFamilies abaixo), e qual argumento é "o buscador" vs. "o
// candidato" se inverte conforme a direção. Checar uma flag aqui filtraria
// incorretamente com base na própria configuração de visibilidade do
// buscador, em uma das duas direções. As checagens de visibilidade vivem,
// em vez disso, nas duas funções wrapper, onde só a lista de candidatos
// (nunca o buscador fixo) é filtrada.
function isEligiblePair(
  familyProfile: FamilyForMatching,
  caregiver: CaregiverForMatching
): boolean {
  if (
    familyProfile.latitude === null ||
    familyProfile.longitude === null ||
    caregiver.latitude === null ||
    caregiver.longitude === null
  ) {
    return false;
  }

  const distanceKm = haversineDistanceKm(
    familyProfile.latitude,
    familyProfile.longitude,
    caregiver.latitude,
    caregiver.longitude
  );

  if (distanceKm > matchingConfig.maxDistanceKm) {
    return false;
  }

  return caregiver.careTypes.some((type) =>
    familyProfile.neededCareTypes.includes(type)
  );
}

export function findCandidateCaregivers(
  familyProfile: FamilyForMatching,
  allCaregivers: CaregiverForMatching[]
): CaregiverForMatching[] {
  return allCaregivers.filter(
    (caregiver) =>
      caregiver.visibleToFamilies && isEligiblePair(familyProfile, caregiver)
  );
}

// Genérica sobre F para funcionar tanto com o FamilyCandidate mínimo
// (construção de preferências do Gale-Shapley, que só precisa do userId de
// volta) quanto com formas mais ricas orientadas a exibição como
// FamilyForDisplay (rankFamiliesForCaregiver, que também precisa mostrar
// name/city/state) -- o filtro preserva qualquer forma que receber.
export function findCandidateFamilies<F extends FamilyForMatching>(
  caregiver: CaregiverForMatching,
  allFamilies: F[]
): F[] {
  return allFamilies.filter(
    (familyProfile) =>
      familyProfile.visibleToCaregivers && isEligiblePair(familyProfile, caregiver)
  );
}

// Fallback de três camadas, em ordem de prioridade:
//  1. A família declarou um `hourlyBudget` real -- compara a tarifa real do
//     cuidador contra ele. Dentro do orçamento ou abaixo pontua um 1.0
//     perfeito; acima do orçamento decai linearmente e satura em 0 quando a
//     tarifa é o dobro do orçamento (rate - budget >= budget). Esta é a
//     única camada que reflete o que a família de fato disse que pode pagar.
//  2. Sem orçamento declarado, mas o chamador forneceu um pool de tarifas de
//     outros candidatos -- volta ao comportamento anterior (normalização
//     relativa min/max dentro desse pool), então o price score de um
//     cuidador ainda diz *alguma coisa* ("barato em relação às
//     alternativas") mesmo sem um orçamento declarado.
//  3. Nenhum dos dois -- nada contra o que comparar, então o componente de
//     preço não consegue discriminar nada. Reaproveita
//     matchingConfig.defaultRatingWhenNoReviews em vez de uma constante
//     mágica separada, já que significa a mesma coisa estruturalmente:
//     "sem dado, então não penalizar nem premiar, ficar neutro."
export function computePriceScore(
  caregiverRate: number | null,
  familyBudget: number | null,
  candidateRatesForFallback?: number[]
): number {
  if (caregiverRate === null) {
    return matchingConfig.defaultRatingWhenNoReviews;
  }

  if (familyBudget !== null) {
    if (caregiverRate <= familyBudget) {
      return 1;
    }

    return Math.max(0, 1 - (caregiverRate - familyBudget) / familyBudget);
  }

  if (candidateRatesForFallback !== undefined) {
    const rates = candidateRatesForFallback;

    if (rates.length <= 1) {
      return matchingConfig.defaultRatingWhenNoReviews;
    }

    const min = Math.min(...rates);
    const max = Math.max(...rates);

    if (max === min) {
      return matchingConfig.defaultRatingWhenNoReviews;
    }

    return 1 - (caregiverRate - min) / (max - min);
  }

  return matchingConfig.defaultRatingWhenNoReviews;
}

// `allCandidates` é opcional e, quando fornecido, só alimenta o fallback da
// camada 2 do computePriceScore (normalização relativa de tarifa) -- ver o
// comentário dessa função para quando cada camada se aplica. Passá-lo ou não
// é uma decisão de cada chamador: rankCaregiversAgainstList (família
// buscando cuidadores) passa, rankFamiliesAgainstList (cuidador buscando
// famílias) deliberadamente não passa, para que os dois lados do grafo
// possam ter comportamento de fallback diferente quando nenhum orçamento é
// declarado.
export function computeMatchScore(
  familyProfile: FamilyForMatching,
  caregiver: CaregiverForMatching,
  allCandidates?: CaregiverForMatching[]
): number {
  const distanceKm = haversineDistanceKm(
    familyProfile.latitude!,
    familyProfile.longitude!,
    caregiver.latitude!,
    caregiver.longitude!
  );
  const distanceScore = Math.max(
    0,
    1 - distanceKm / matchingConfig.maxDistanceKm
  );

  const sharedCareTypeCount = getSharedCareTypes(
    caregiver.careTypes,
    familyProfile.neededCareTypes
  ).length;
  const careTypeScore =
    familyProfile.neededCareTypes.length > 0
      ? sharedCareTypeCount / familyProfile.neededCareTypes.length
      : 0;

  const ratingScore =
    caregiver.averageRating !== null
      ? caregiver.averageRating / 5
      : matchingConfig.defaultRatingWhenNoReviews;

  const candidateRates = allCandidates
    ?.map((candidate) => candidate.hourlyRate)
    .filter((rate): rate is number => rate !== null);

  const priceScore = computePriceScore(
    caregiver.hourlyRate,
    familyProfile.hourlyBudget,
    candidateRates
  );

  const { weights } = matchingConfig;

  return (
    weights.distance * distanceScore +
    weights.careTypeCompatibility * careTypeScore +
    weights.rating * ratingScore +
    weights.price * priceScore
  );
}

// Núcleo puro e síncrono compartilhado por rankCaregiversForFamily (uma
// única família, busca seus próprios dados do Prisma) e
// buildFamilyPreferences (várias famílias, cuidadores já buscados uma vez
// pelo chamador).
function rankCaregiversAgainstList(
  familyProfile: FamilyForMatching,
  allCaregivers: CaregiverForMatching[]
): RankedCaregiver[] {
  const candidates = findCandidateCaregivers(familyProfile, allCaregivers);

  const ranked = candidates.map((caregiver) => {
    const distanceKm = haversineDistanceKm(
      familyProfile.latitude!,
      familyProfile.longitude!,
      caregiver.latitude!,
      caregiver.longitude!
    );
    const matchScore = computeMatchScore(familyProfile, caregiver, candidates);

    return { caregiver, distanceKm, matchScore };
  });

  ranked.sort((a, b) => b.matchScore - a.matchScore);

  return ranked;
}

// Espelha o papel de rankCaregiversAgainstList, mas para a outra direção do
// grafo bipartido: núcleo puro e síncrono compartilhado por
// buildCaregiverPreferences (vários cuidadores, ranqueando cada um contra
// todas as famílias para as listas de preferência do Gale-Shapley) e
// rankFamiliesForCaregiver (um único cuidador, busca seus próprios dados do
// Prisma). Genérica sobre F para que os chamadores possam passar tanto o
// FamilyCandidate mínimo (Gale-Shapley só precisa do userId de volta) quanto
// o FamilyForDisplay mais rico (a busca também precisa de name/city/state) e
// obter essa mesma forma de volta em `family`.
function rankFamiliesAgainstList<F extends FamilyCandidate>(
  caregiver: CaregiverForMatching,
  allFamilies: F[]
): RankedFamily<F>[] {
  const eligibleFamilies = findCandidateFamilies(caregiver, allFamilies);

  const ranked = eligibleFamilies.map((family) => {
    const distanceKm = haversineDistanceKm(
      family.latitude!,
      family.longitude!,
      caregiver.latitude!,
      caregiver.longitude!
    );
    // candidateRatesForFallback deliberadamente não é passado aqui --
    // diferente do lado família (rankCaregiversAgainstList), esta direção
    // nunca recorre à normalização relativa de tarifa contra outros
    // cuidadores quando uma família não declarou orçamento; simplesmente vai
    // para o neutro. Ver o comentário de computePriceScore para a ordem
    // completa de fallback.
    const matchScore = computeMatchScore(family, caregiver);

    return { family, distanceKm, matchScore };
  });

  ranked.sort((a, b) => b.matchScore - a.matchScore);

  return ranked;
}

function toCaregiverForMatching(profile: {
  id: string;
  userId: string;
  bio: string | null;
  hourlyRate: unknown;
  careTypes: CareType[];
  latitude: number | null;
  longitude: number | null;
  visibleToFamilies: boolean;
  availabilityStatus: CaregiverAvailability;
  user: { name: string | null; reviewsReceived: { rating: number }[] };
}): CaregiverForMatching {
  const ratings = profile.user.reviewsReceived.map((review) => review.rating);
  const { average: averageRating, total: reviewCount } =
    calculateAverageRating(ratings);

  return {
    id: profile.id,
    userId: profile.userId,
    name: profile.user.name,
    bio: profile.bio,
    hourlyRate: profile.hourlyRate ? Number(profile.hourlyRate) : null,
    careTypes: profile.careTypes,
    latitude: profile.latitude,
    longitude: profile.longitude,
    averageRating,
    reviewCount,
    visibleToFamilies: profile.visibleToFamilies,
    availabilityStatus: profile.availabilityStatus,
  };
}

async function fetchAllCaregiversForMatching(): Promise<CaregiverForMatching[]> {
  const caregiverProfiles = await prisma.caregiverProfile.findMany({
    include: {
      user: {
        select: {
          name: true,
          reviewsReceived: { select: { rating: true } },
        },
      },
    },
  });

  return caregiverProfiles.map(toCaregiverForMatching);
}

export async function rankCaregiversForFamily(
  familyProfile: FamilyProfile
): Promise<RankedCaregiver[]> {
  const family: FamilyForMatching = {
    latitude: familyProfile.latitude,
    longitude: familyProfile.longitude,
    neededCareTypes: familyProfile.neededCareTypes,
    hourlyBudget: familyProfile.hourlyBudget
      ? Number(familyProfile.hourlyBudget)
      : null,
    // Irrelevante para esta direção (a própria visibilidade de uma família
    // nunca afeta a busca dela por cuidadores -- ver findCandidateCaregivers),
    // mas ainda exigido pelo tipo. Carregado fielmente de qualquer forma.
    visibleToCaregivers: familyProfile.visibleToCaregivers,
  };

  const allCaregivers = await fetchAllCaregiversForMatching();

  return rankCaregiversAgainstList(family, allCaregivers);
}

async function fetchAllFamiliesForDisplay(): Promise<FamilyForDisplay[]> {
  const familyProfiles = await prisma.familyProfile.findMany({
    include: { user: { select: { name: true } } },
  });

  return familyProfiles.map((profile) => ({
    userId: profile.userId,
    name: profile.user.name,
    city: profile.city,
    state: profile.state,
    bio: profile.bio,
    latitude: profile.latitude,
    longitude: profile.longitude,
    neededCareTypes: profile.neededCareTypes,
    hourlyBudget: profile.hourlyBudget ? Number(profile.hourlyBudget) : null,
    visibleToCaregivers: profile.visibleToCaregivers,
  }));
}

// Espelha rankCaregiversForFamily do outro lado do grafo: a busca usada por
// GET /api/search/families. Retorna FamilyForDisplay (sem `address`, ver o
// comentário desse tipo) -- um cuidador navegando por famílias nunca recebe
// o endereço completo de uma família, só cidade/estado, distância e o que
// ela procura.
export async function rankFamiliesForCaregiver(
  caregiverProfile: CaregiverProfile
): Promise<RankedFamily<FamilyForDisplay>[]> {
  const user = await prisma.user.findUnique({
    where: { id: caregiverProfile.userId },
    select: { name: true, reviewsReceived: { select: { rating: true } } },
  });

  const ratings = user?.reviewsReceived.map((review) => review.rating) ?? [];
  const { average: averageRating, total: reviewCount } =
    calculateAverageRating(ratings);

  const caregiver: CaregiverForMatching = {
    id: caregiverProfile.id,
    userId: caregiverProfile.userId,
    name: user?.name ?? null,
    bio: caregiverProfile.bio,
    hourlyRate: caregiverProfile.hourlyRate
      ? Number(caregiverProfile.hourlyRate)
      : null,
    careTypes: caregiverProfile.careTypes,
    latitude: caregiverProfile.latitude,
    longitude: caregiverProfile.longitude,
    averageRating,
    reviewCount,
    // Irrelevante para esta direção (a própria visibilidade de um cuidador
    // nunca afeta a busca dele por famílias -- ver findCandidateFamilies),
    // mas ainda exigido pelo tipo. Carregado fielmente de qualquer forma.
    visibleToFamilies: caregiverProfile.visibleToFamilies,
    availabilityStatus: caregiverProfile.availabilityStatus,
  };

  const allFamilies = await fetchAllFamiliesForDisplay();

  return rankFamiliesAgainstList(caregiver, allFamilies);
}

// Para cada família, os cuidadores elegíveis para ela ranqueados por
// computeMatchScore -- isso é exatamente o que rankCaregiversForFamily
// calcula para uma família, reaproveitado aqui (como um helper síncrono, já
// que a lista de cuidadores já foi buscada uma vez para todas as famílias em
// vez de reconsultar o Prisma por família).
export function buildFamilyPreferences(
  families: FamilyCandidate[],
  caregivers: CaregiverForMatching[]
): Map<string, string[]> {
  const preferences = new Map<string, string[]>();

  for (const family of families) {
    const ranked = rankCaregiversAgainstList(family, caregivers);
    preferences.set(
      family.userId,
      ranked.map((entry) => entry.caregiver.userId)
    );
  }

  return preferences;
}

// Para cada cuidador, as famílias elegíveis para ele ranqueadas pela MESMA
// fórmula de computeMatchScore, só com os papéis de "qual lado varia"
// trocados. Observação: como o cuidador fica fixo enquanto se percorre as
// famílias, o componente de rating do score é constante entre todas as
// famílias candidatas desse cuidador (é uma propriedade do cuidador, não da
// família). O preço, desde que hourlyBudget foi adicionado, não é mais
// sempre constante aqui: uma família com orçamento declarado produz uma
// comparação real orçamento-vs-tarifa que varia por família, enquanto uma
// família sem orçamento cai no score neutro (ver computePriceScore) -- então
// o preço só permanece constante entre os candidatos quando nenhum deles
// declarou orçamento. Distância e compatibilidade de tipo de cuidado sempre
// variam e conduzem o ranqueamento de qualquer forma. Essa é uma
// consequência direta e honesta de reaproveitar a mesma fórmula de peso de
// aresta nas duas direções em vez de inventar uma fórmula separada do lado
// do cuidador, exatamente como especificado.
export function buildCaregiverPreferences(
  caregivers: CaregiverForMatching[],
  families: FamilyCandidate[]
): Map<string, string[]> {
  const preferences = new Map<string, string[]>();

  for (const caregiver of caregivers) {
    const ranked = rankFamiliesAgainstList(caregiver, families);

    preferences.set(
      caregiver.userId,
      ranked.map((entry) => entry.family.userId)
    );
  }

  return preferences;
}

export async function runStableMatchingForAllFamilies(): Promise<
  Map<string, string[]>
> {
  const [familyProfiles, caregivers] = await Promise.all([
    prisma.familyProfile.findMany(),
    fetchAllCaregiversForMatching(),
  ]);

  // Não existe uma flag "active" em User/FamilyProfile/CaregiverProfile no
  // schema hoje, então "famílias e cuidadores ativos" é interpretado aqui
  // como simplesmente todo profile que existe atualmente.
  const families: FamilyCandidate[] = familyProfiles.map((profile) => ({
    userId: profile.userId,
    latitude: profile.latitude,
    longitude: profile.longitude,
    neededCareTypes: profile.neededCareTypes,
    hourlyBudget: profile.hourlyBudget ? Number(profile.hourlyBudget) : null,
    visibleToCaregivers: profile.visibleToCaregivers,
  }));

  const proposerPreferences = buildFamilyPreferences(families, caregivers);
  const receiverPreferences = buildCaregiverPreferences(caregivers, families);

  return stableMatching({
    proposers: families.map((family) => family.userId),
    receivers: caregivers.map((caregiver) => caregiver.userId),
    proposerPreferences,
    receiverPreferences,
    receiverCapacity: matchingConfig.caregiverCapacity,
  });
}

// Roda o matching estável global e extrai só o resultado que uma única
// família tem interesse -- compartilhado por
// /dashboard/familia/match-recomendado e pelo card de resumo do dashboard da
// família, para que a busca "com qual cuidador eu fiquei" viva num só lugar.
//
// distanceKm/sharedCareTypes são extras só para exibição (não usados pelo
// algoritmo de matching em si, que já rodou até este ponto ser calculado) --
// adicionados para que match-recomendado possa mostrar um fato real em vez
// de um badge "Recomendado" fabricado. Os dois são efetivamente garantidos
// non-null/non-vazio para um match estável real (isEligiblePair já exigia
// coordenadas non-null e tipos de cuidado sobrepostos para esse par ser
// elegível), mas tipados de forma frouxa já que isso busca os profiles de
// novo em vez de reaproveitar essa garantia.
export type MatchedCaregiverForFamily = {
  caregiverUserId: string;
  distanceKm: number | null;
  sharedCareTypes: CareType[];
};

export async function findMatchedCaregiverForFamily(
  familyUserId: string
): Promise<MatchedCaregiverForFamily | null> {
  const matchesByCaregiver = await runStableMatchingForAllFamilies();

  let matchedCaregiverUserId: string | null = null;
  for (const [caregiverUserId, familyUserIds] of matchesByCaregiver) {
    if (familyUserIds.includes(familyUserId)) {
      matchedCaregiverUserId = caregiverUserId;
      break;
    }
  }

  if (!matchedCaregiverUserId) {
    return null;
  }

  const [familyProfile, caregiverProfile] = await Promise.all([
    prisma.familyProfile.findUnique({
      where: { userId: familyUserId },
      select: { latitude: true, longitude: true, neededCareTypes: true },
    }),
    prisma.caregiverProfile.findUnique({
      where: { userId: matchedCaregiverUserId },
      select: { latitude: true, longitude: true, careTypes: true },
    }),
  ]);

  const distanceKm = distanceKmOrNull(
    familyProfile?.latitude,
    familyProfile?.longitude,
    caregiverProfile?.latitude,
    caregiverProfile?.longitude
  );

  const sharedCareTypes =
    familyProfile && caregiverProfile
      ? getSharedCareTypes(caregiverProfile.careTypes, familyProfile.neededCareTypes)
      : [];

  return { caregiverUserId: matchedCaregiverUserId, distanceKm, sharedCareTypes };
}

// Forma limitada por privacidade para uma família com match a um cuidador
// via matching estável -- mesmo conjunto de campos de
// GET /api/search/families (sem `address`, ver FamilyForDisplay), mas sem um
// `matchScore` 0-1 já que o Gale-Shapley não produz um da forma que a busca
// ponderada produz (mesmo raciocínio da rota stable-match do lado família).
// sharedCareTypes é o mesmo extra só para exibição de
// MatchedCaregiverForFamily acima. A distância vai como faixa, não em km:
// quem recebe esta forma é um cuidador, e a distância exata até a família
// permite triangular a casa dela (ver lib/location-privacy.ts).
export type MatchedFamilyForCaregiver = {
  familyId: string;
  name: string | null;
  city: string | null;
  state: string | null;
  neededCareTypes: CareType[];
  distanceBand: number | null;
  sharedCareTypes: CareType[];
};

// Espelha findMatchedCaregiverForFamily do outro lado do grafo --
// compartilhada por GET /api/matching/stable-match/caregiver e
// /dashboard/cuidador/match-perfeito, para que a busca "com quais famílias eu
// fiquei" viva num só lugar. Diferente do lado família (capacidade 1), um
// cuidador pode segurar até matchingConfig.caregiverCapacity famílias ao
// mesmo tempo, então isso retorna de 0 até essa quantidade de entradas.
export async function findMatchedFamiliesForCaregiver(
  caregiverUserId: string
): Promise<MatchedFamilyForCaregiver[]> {
  const matchesByCaregiver = await runStableMatchingForAllFamilies();
  const matchedFamilyUserIds = matchesByCaregiver.get(caregiverUserId) ?? [];

  if (matchedFamilyUserIds.length === 0) {
    return [];
  }

  const [caregiverProfile, familyProfiles] = await Promise.all([
    prisma.caregiverProfile.findUnique({
      where: { userId: caregiverUserId },
      select: { latitude: true, longitude: true, careTypes: true },
    }),
    prisma.familyProfile.findMany({
      where: { userId: { in: matchedFamilyUserIds } },
      include: { user: { select: { name: true } } },
    }),
  ]);

  return familyProfiles.map((profile) => {
    const distanceKm = distanceKmOrNull(
      profile.latitude,
      profile.longitude,
      caregiverProfile?.latitude,
      caregiverProfile?.longitude
    );

    const sharedCareTypes = caregiverProfile
      ? getSharedCareTypes(caregiverProfile.careTypes, profile.neededCareTypes)
      : [];

    return {
      familyId: profile.userId,
      name: profile.user.name,
      city: profile.city,
      state: profile.state,
      neededCareTypes: profile.neededCareTypes,
      distanceBand: distanceKm === null ? null : distanceBand(distanceKm),
      sharedCareTypes,
    };
  });
}

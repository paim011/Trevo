// Regras de privacidade da localização (ver docs/lgpd.md, lacunas 1 e 2).
//
// O endereço da família é cifrado em duas camadas, mas as coordenadas
// derivadas dele precisam ficar legíveis para o matching calcular
// distâncias. Para que elas não entreguem a casa da família a quem lê o
// banco, guardamos só a localização aproximada; e, para que um cuidador não
// consiga triangular a casa trocando de cidade e anotando distâncias, a
// distância mostrada a ele é uma faixa, nunca o valor exato.

/**
 * Casas decimais guardadas em latitude/longitude. 2 casas ≈ 1,1 km de
 * latitude (e um pouco menos de longitude nas latitudes do Brasil) --
 * precisão de bairro, não de rua. O raio de busca é de 50 km, então o
 * erro não muda quem é elegível de forma relevante.
 */
export const COORDINATE_DECIMALS = 2;

export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** Limites superiores (km) das faixas de distância mostradas ao cuidador. */
export const DISTANCE_BAND_LIMITS_KM = [5, 10, 20, 50] as const;

/**
 * Índice da faixa (0 = mais perto). Usado também para ordenar por
 * proximidade sem expor a distância exata ao navegador.
 */
export function distanceBand(distanceKm: number): number {
  const index = DISTANCE_BAND_LIMITS_KM.findIndex((limit) => distanceKm <= limit);
  return index === -1 ? DISTANCE_BAND_LIMITS_KM.length : index;
}

export function formatDistanceBand(band: number): string {
  if (band === 0) {
    return `até ${DISTANCE_BAND_LIMITS_KM[0]} km`;
  }
  if (band >= DISTANCE_BAND_LIMITS_KM.length) {
    return `mais de ${DISTANCE_BAND_LIMITS_KM[DISTANCE_BAND_LIMITS_KM.length - 1]} km`;
  }
  return `${DISTANCE_BAND_LIMITS_KM[band - 1]} a ${DISTANCE_BAND_LIMITS_KM[band]} km`;
}

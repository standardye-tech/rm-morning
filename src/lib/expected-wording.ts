/**
 * Expected GMV — mise en mots des seuils et de la fiabilité.
 *
 * PRÉSENTATION SEULE : les seuils sont lus de la configuration, les indices de
 * `expected-reliability-view`. Module pur, sans JSX, pour que les harnais
 * `verify-*` éprouvent directement ce que l'écran écrit.
 */

import { EXPECTED_CHALLENGE, FORECAST_CHALLENGE } from "./config";
import { RELIABILITY } from "./expected-reliability";

const pctOf = (p: number) => `${Math.round(p * 100)} %`;

/**
 * La fourchette des « à challenger » d'Expected, bornes dites telles que le code
 * les applique : 15 % exclu, 25 % inclus (`expectedChallengers`).
 */
export function expectedChallengeRange(): string {
  return `plus de ${pctOf(EXPECTED_CHALLENGE.minProbability)} et jusqu'à ${pctOf(FORECAST_CHALLENGE.minProbability)} inclus`;
}

export function expectedChallengeAside(count: number): string {
  const n = count > 1 ? `${count} affaires` : `${count} affaire`;
  return `${n} à ${expectedChallengeRange()} · au-delà de ${pctOf(FORECAST_CHALLENGE.minProbability)} : Forecast`;
}

export function expectedChallengeEmpty(): string {
  return `Aucune affaire supplémentaire à ${expectedChallengeRange()} aujourd'hui.`;
}

export type ReliabilityHorizonFacts = {
  reliability: number | null;
  reliableIn: { days: number; date: string } | null;
};

const DDMM = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Seconde ligne d'un horizon de fiabilité.
 *
 * Le seuil est atteint à `RELIABILITY.target` ou plus (`daysUntilReliable`
 * compare en ≥) : l'écran dit « 90 % ou plus », jamais « plus de 90 % ».
 * Sans indice mesuré à cet horizon, « non atteint historiquement » serait une
 * affirmation sans données : rien n'est écrit (null).
 */
export function reliabilityHorizonText(h: ReliabilityHorizonFacts): string | null {
  const target = `${RELIABILITY.target} %`;
  if (!h.reliableIn) return h.reliability == null ? null : `${target} non atteint historiquement`;
  if (h.reliableIn.days === 0) return `Déjà à ${target} ou plus à ce stade, historiquement`;
  const d = h.reliableIn.days;
  return `Fiabilité de ${target} ou plus estimée dans ${d} jour${d > 1 ? "s" : ""} (le ${DDMM(h.reliableIn.date)})`;
}

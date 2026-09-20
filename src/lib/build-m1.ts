/**
 * « Construire M+1 » — assemblage, sans nouveau moteur.
 *
 * Ce module ne calcule AUCUNE prévision. Il compose des chiffres que les moteurs
 * existants produisent déjà, chacun avec sa source :
 *
 *   Objectif M+1                 monthly_objective (saisi dans Données)
 *   Déclaratif commerciaux M+1   Projection Kanban de M+1        (forecast-board)
 *   Perspective ajustée M+1      classeur manuel de la Région    (adjusted-perspective)
 *   Prévision RM Morning M+1     projection régionale C8.1       (expected-m1)
 *
 * La couverture et le manque à construire ne se calculent QUE si l'objectif est
 * renseigné ET que la prévision RM Morning existe : sinon rien n'est inventé.
 *
 * ATTENTION — la prévision M+1 n'est PAS la somme des affaires listées. Elle part
 * du niveau historique de l'équipe, ajusté selon la force du pipe, et intègre une
 * composante statistique d'affaires qui n'existent pas encore (`FUTURE_SHARE_M1`
 * du GMV d'un mois M+1, mesuré historiquement). Aucune ventilation « pipe identifié
 * / GMV futur » n'est exposée par le moteur : aucune n'est fabriquée ici.
 */

import { loadAdjustedPerspective, type AdjustedResult } from "./adjusted-perspective";
import { businessMonth } from "./business-time";
import { CHALLENGE_LABEL } from "./forecast-labels";
import { buildForecastV2, type ForecastV2Board } from "./forecast-v2";
import { getObjective } from "./objective-store";
import type { ExpectedM1Snapshot } from "./expected-m1";

/**
 * Part du GMV du mois suivant venue d'affaires pas encore créées, RECALCULÉE en
 * C8.1 sur la vérité officielle Travaux (46 % pour M+1, 61 % pour M+2). Mesure
 * historique, pas une ventilation de la prévision du jour.
 */
export const FUTURE_SHARE_M1 = "46 %";
export const FUTURE_SHARE_M2 = "61 %";

export type Coverage = {
  /** Prévision RM Morning M+1 / objectif, en fraction (0,62 = 62 %). */
  ratio: number;
  /** Manque à construire : max(0, objectif − prévision). 0 = objectif couvert. */
  missing: number;
  /** Excédent : max(0, prévision − objectif). */
  surplus: number;
};

/**
 * Couverture de l'objectif par la prévision RM Morning. Pur.
 * Rend null si l'objectif n'est pas renseigné ou si la prévision manque : aucune
 * couverture, aucun déficit n'est alors inventé.
 */
export function coverageOf(objective: number | null, forecast: number | null): Coverage | null {
  if (objective == null || !(objective > 0) || forecast == null || !Number.isFinite(forecast)) return null;
  return {
    ratio: forecast / objective,
    missing: Math.max(0, objective - forecast),
    surplus: Math.max(0, forecast - objective),
  };
}

export type M1Deal = {
  opportunityId: string;
  owner: string;
  ownerFirstName: string;
  client: string;
  gmv: number;
  stage: string | null;
  /** Projection Kanban de l'affaire (« AAAA-MM »). */
  kanbanMonth: string | null;
  /** Déclarée par le commercial sur M+1 (sinon : suggérée par RM Morning). */
  declaredOnM1: boolean;
  /** Probabilité de signer sur M+1, telle que produite par la projection M+1. */
  probability: number | null;
  /** GMV probable (GMV × probabilité), pour information. */
  expectedGmv: number | null;
  /** Signal de challenge éventuel, en français. */
  challenge: string | null;
};

export type ConstruireM1 = {
  month: string;
  monthLabel: string;
  objective: { amount: number; updatedAt: string } | null;
  declared: { gmv: number; count: number };
  adjusted: AdjustedResult;
  forecast: {
    projection: number;
    rangeLo: number;
    rangeHi: number;
    confidence: string;
    generatedAt: string;
  } | null;
  forecastUnavailableReason: string | null;
  coverage: Coverage | null;
  deals: M1Deal[];
  /** Total des affaires identifiées : jamais présenté comme la prévision. */
  identified: { count: number; gmv: number };
  futureShare: string;
  issues: string[];
};

/**
 * Les affaires qui construisent M+1 : celles que les commerciaux projettent sur
 * M+1 (Kanban) et celles que RM Morning suggère (lignes jaunes M+1). Les affaires
 * signées ou sans montant n'y figurent pas. Tri : GMV décroissante.
 */
export function m1Deals(board: ForecastV2Board): M1Deal[] {
  const challenge = new Map(board.examine.map((e) => [e.row.opportunityId, e]));
  const out: M1Deal[] = [];
  for (const sp of board.salespeople) {
    for (const r of sp.opportunities) {
      if (r.isSignedRow || !(r.gmv && r.gmv > 0)) continue;
      const declared = r.kanbanMonth === board.month;
      const c = challenge.get(r.opportunityId);
      if (!declared && !c) continue;
      out.push({
        opportunityId: r.opportunityId,
        owner: r.owner,
        ownerFirstName: sp.firstName,
        client: r.client,
        gmv: r.gmv,
        stage: r.stage,
        kanbanMonth: r.kanbanMonth,
        declaredOnM1: declared,
        probability: r.expectedProbability,
        expectedGmv: r.expectedGmv,
        challenge: c ? `${CHALLENGE_LABEL[c.kind]} — ${c.reason}` : null,
      });
    }
  }
  return out.sort((a, b) => b.gmv - a.gmv || a.client.localeCompare(b.client, "fr"));
}

/** Assemble le bloc « Construire M+1 » à partir des moteurs existants. */
export async function buildConstruireM1(now: Date = new Date()): Promise<ConstruireM1> {
  const board = buildForecastV2(1, null, now);
  const month = board.month;
  const adjusted = await loadAdjustedPerspective(month, true);
  const m1: ExpectedM1Snapshot | null = board.expectedM1;
  const objective = getObjective(month);
  const forecast = m1
    ? { projection: m1.projection, rangeLo: m1.rangeLo, rangeHi: m1.rangeHi, confidence: m1.confidence, generatedAt: m1.generatedAt }
    : null;
  const deals = m1Deals(board);
  return {
    month,
    monthLabel: board.monthLabel,
    objective: objective ? { amount: objective.amount, updatedAt: objective.updatedAt } : null,
    declared: { gmv: board.region.kanbanGmv, count: board.region.count },
    adjusted,
    forecast,
    forecastUnavailableReason: forecast ? null : board.expectedUnavailableReason,
    coverage: coverageOf(objective?.amount ?? null, forecast?.projection ?? null),
    deals,
    identified: { count: deals.length, gmv: deals.reduce((t, d) => t + d.gmv, 0) },
    futureShare: FUTURE_SHARE_M1,
    issues: board.issues,
  };
}

/** Mois M+1 de l'instant `now` (Paris). */
export const nextBusinessMonth = (now: Date = new Date()) => businessMonth(now, 1);

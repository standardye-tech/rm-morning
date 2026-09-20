/**
 * Plan du jour — règles de sélection, PURES.
 *
 * Le Plan répond à : « quelles sont les 5 à 7 situations managériales qui
 * méritent mon attention aujourd'hui ? ». Ce module porte ce qui rend la liste
 * courte et lisible, sans jamais toucher à la base :
 *
 *   — le motif managérial d'une affaire (sans lui, une grosse affaire qui avance
 *     normalement chez un commercial autonome n'est pas une situation) ;
 *   — la sélection : score décroissant, au plus N situations par commercial,
 *     jamais la même affaire deux fois, plafond global absolu ;
 *   — les absences de signal, lues dans `attention.ts` (mêmes règles, mêmes
 *     seuils que « Ma semaine »).
 *
 * Aucune persistance ici : le Plan est recalculé chaque fois depuis l'état
 * courant. Un plafond dépassé ne crée ni tâche ni backlog, la situation en trop
 * est simplement absente jusqu'au prochain calcul.
 */

import { ATTENTION, MORNING_PLAN } from "./config";
import { evaluateReasons, type AttentionInput, type AttentionReason } from "./attention";
import type { MorningAction } from "./morning-types";

// --- Motif managérial ---------------------------------------------------------

export type MotiveInput = {
  /** Le commercial déclare l'affaire sur le mois mais RM Morning la met à challenger. */
  inChallenge: boolean;
  /** Aucun changement d'étape ni activité depuis `ATTENTION.stagnantDays` jours. */
  stalled: boolean;
  /** Le client a écrit et le message n'est pas encore acquitté. */
  clientSpoke: boolean;
};

/**
 * Une affaire lourde n'est une situation managériale que si quelque chose
 * appelle le manager : elle est à challenger, ou figée, ou le client parle.
 * Une grosse affaire qui avance normalement chez un commercial autonome n'a pas
 * besoin de Sami aujourd'hui — elle vit dans Forecast, pas dans le Plan.
 */
export function hasManagerialMotive(m: MotiveInput): boolean {
  return m.inChallenge || m.stalled || m.clientSpoke;
}

// --- Sélection ----------------------------------------------------------------

export type SelectionRules = {
  max: number;
  perOwner: number;
  /** Plafond par famille née d'un mail. */
  perMailFamily: { chaud: number; attente: number };
};

/** Familles nées d'un message client : elles se limitent pour laisser place aux autres. */
const isMailBorn = (a: MorningAction): a is MorningAction & { category: "chaud" | "attente" } =>
  a.category === "chaud" || a.category === "attente";

/** Clé de regroupement : les situations sans commercial forment un groupe à part. */
const ownerKey = (a: MorningAction) => a.owner ?? "";

/**
 * Les N meilleures situations, sous contraintes.
 *
 * Ordre : score décroissant, puis clé pour un résultat reproductible. On
 * parcourt une seule fois : une situation est écartée si son commercial a déjà
 * `perOwner` situations retenues, si sa famille née d'un mail (client motivé,
 * client qui attend) a déjà atteint son plafond, ou si l'une de ses affaires figure déjà dans une situation
 * retenue (le meilleur score gagne). Le plafond global est absolu.
 */
export function selectSituations(
  candidates: MorningAction[],
  rules: SelectionRules = {
    max: MORNING_PLAN.maxSituations,
    perOwner: MORNING_PLAN.maxPerOwner,
    perMailFamily: { chaud: MORNING_PLAN.maxPerMailFamily, attente: MORNING_PLAN.maxPerMailFamily },
  },
): MorningAction[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const taken: MorningAction[] = [];
  const perOwner = new Map<string, number>();
  const usedOpportunities = new Set<string>();
  const usedKeys = new Set<string>();
  const fromMail = { chaud: 0, attente: 0 };

  for (const a of sorted) {
    if (taken.length >= rules.max) break;
    if (usedKeys.has(a.key)) continue;
    if (isMailBorn(a) && fromMail[a.category] >= rules.perMailFamily[a.category]) continue;
    if ((perOwner.get(ownerKey(a)) ?? 0) >= rules.perOwner) continue;
    if (a.opportunityIds.some((id) => usedOpportunities.has(id))) continue;
    taken.push(a);
    if (isMailBorn(a)) fromMail[a.category] += 1;
    usedKeys.add(a.key);
    perOwner.set(ownerKey(a), (perOwner.get(ownerKey(a)) ?? 0) + 1);
    for (const id of a.opportunityIds) usedOpportunities.add(id);
  }
  return taken;
}

/** GMV distinct concerné par une liste de situations (une affaire n'est jamais comptée deux fois). */
export function concernedGmv(actions: MorningAction[]): number {
  return actions.reduce((t, a) => t + (a.gmv ?? 0), 0);
}

// --- Absences de signal -------------------------------------------------------

export type AbsenceSignals = {
  pipe: AttentionReason | null;
  frozen: AttentionReason | null;
};

/**
 * Les deux absences de signal que le Plan reprend d'`attention.ts` : « pipe
 * faible » et « affaires sans évolution ». Les règles ne sont PAS recopiées :
 * on appelle `evaluateReasons` avec les champs utiles et des valeurs neutres
 * pour tout le reste, puis on ne retient que ces deux raisons. Un seuil modifié
 * dans `ATTENTION` change donc le Plan et Ma semaine ensemble.
 */
export function absenceSignals(
  input: Pick<
    AttentionInput,
    "salesperson" | "firstName" | "activeCount" | "activeGmv" | "staleCount" | "stagnant"
  >,
  rules = ATTENTION,
): AbsenceSignals {
  const reasons = evaluateReasons(
    {
      ...input,
      performanceScore: null,
      withoutProjectionCount: 0,
      monitoringState: null,
      newExceptions: 0,
      clientWaiting: 0,
      divergence: null,
      expectedRemaining: 0,
      kanbanRemaining: 0,
      nearSignature: { count: 0, gmv: 0, examples: [] },
    },
    rules,
  );
  return {
    pipe: reasons.find((r) => r.key === "pipe_faible") ?? null,
    frozen: reasons.find((r) => r.key === "affaires_figees") ?? null,
  };
}

/** « 54 k€ · Estimation envoyée · … » : les morceaux vides disparaissent. */
export function joinDetail(parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");
}

/**
 * Plan du jour — règles de sélection des AFFAIRES, PURES.
 *
 * Le Plan répond à : « quelles sont les 7 affaires sur lesquelles une évolution
 * peut modifier le plus fortement la GMV de M — ou faire basculer une affaire
 * importante de M+1 vers M ? ». L'unité est l'affaire, jamais le commercial :
 *
 *   1. PORTES d'éligibilité (GMV minimale, stand-by, crédibilité, signal dur) ;
 *   2. FAMILLE (A à E) : pourquoi l'affaire peut faire bouger l'atterrissage ;
 *   3. IMPACT : une formule d'une ligne par famille, voir `MORNING_PLAN` ;
 *   4. SÉLECTION : impact décroissant, au plus N affaires, jamais de remplissage.
 *
 * Aucun accès base ici : `morning-priority.ts` assemble les entrées, ce module
 * juge. Il est donc contrôlable sur des entrées synthétiques.
 *
 * Aucune persistance : le Plan est recalculé chaque fois depuis l'état courant.
 */

import { ATTENTION, MORNING_PLAN } from "./config";
import { evaluateReasons, type AttentionInput, type AttentionReason } from "./attention";
import type { MorningReason } from "./morning-types";
import { kEur } from "./vocabulary";

const DAY = 864e5;

// --- Signal dur ----------------------------------------------------------------

export type HardSignal =
  | { kind: "message"; label: string }
  | { kind: "visite"; label: string };

/**
 * Signaux durs RÉCENTS d'une affaire — les seules preuves qui peuvent, à elles
 * seules, remonter une affaire hors forecast ou réactiver une affaire en stand-by :
 *
 *   — un message entrant du client, reçu depuis moins de `hardSignalDays` jours ;
 *   — une visite / un RDV créé, planifié ou réalisé dans la même fenêtre.
 *
 * Volontairement ABSENTS : devis envoyé, estimation envoyée, simple changement
 * d'étape, changement de montant, changement de date de signature. Ce sont des
 * mouvements ordinaires du pipe (le stade passe à « Examen devis » quand le
 * devis part) : ils ne contournent jamais un seuil de crédibilité. Amount et
 * CloseDate pourront servir plus tard de signaux de RISQUE.
 *
 * L'« événement contractuel vérifiable » attendu par la doctrine n'a aujourd'hui
 * aucune source sur une affaire encore ouverte (le journal de signatures et les
 * lignes Travaux ne portent que des affaires signées) : il n'est donc pas relevé,
 * et l'ajouter plus tard ne demandera qu'une entrée de plus ici.
 */
export function hardSignals(
  input: { lastInboundAt: string | null; nextVisitAt: string | null },
  now: Date,
  days: number = MORNING_PLAN.hardSignalDays,
): HardSignal[] {
  const out: HardSignal[] = [];
  if (input.lastInboundAt) {
    const ago = (now.getTime() - new Date(input.lastInboundAt).getTime()) / DAY;
    if (ago >= -0.01 && ago <= days) {
      out.push({
        kind: "message",
        label: ago <= 1 ? "client actif aujourd'hui" : ago <= 2 ? "client actif hier" : `message client il y a ${Math.floor(ago)} j`,
      });
    }
  }
  if (input.nextVisitAt) {
    const delta = (new Date(input.nextVisitAt).getTime() - now.getTime()) / DAY; // > 0 : futur
    if (delta >= -days && delta <= days) {
      const d = new Date(input.nextVisitAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
      out.push({ kind: "visite", label: delta > 0 ? `visite planifiée le ${d}` : `visite réalisée le ${d}` });
    }
  }
  return out;
}

// --- Éligibilité, famille, impact ----------------------------------------------

export type AffaireInput = {
  opportunityId: string;
  client: string;
  owner: string;
  gmv: number;
  stage: string | null;
  /** Probabilité de signer avant la fin du mois, telle que produite par le service Expected. */
  pMonthEnd: number;
  /**
   * Vrai si le service Expected a réellement scoré l'affaire. Une affaire non
   * scorée n'a pas « 0 % de chance » : sa probabilité est INCONNUE, et elle ne peut
   * donc pas fabriquer une divergence Forecast / RM Morning.
   */
  scored: boolean;
  /** Annoncée sur M par le commercial (Projection Kanban ou Perspective de M). */
  declaredOnM: boolean;
  /** Mois de la Projection Kanban « AAAA-MM », ou null. */
  kanbanMonth: string | null;
  /** Nature du challenge de Forecast (`ChallengeKind`), quand l'affaire y figure. */
  challengeKind: string | null;
  /** Aucun changement d'étape ni activité depuis `ATTENTION.stagnantDays` jours. */
  stalled: boolean;
  /** Jours d'immobilité PROUVÉS (borne basse), quand `stalled`. */
  stalledDays: number | null;
  /** Jours sans activité Salesforce. Null si jamais. */
  daysSinceActivity: number | null;
  standby: boolean;
  /** Stand-by qui court au-delà de la fin du mois. */
  frozenMonthEnd: boolean;
  hard: HardSignal[];
};

export type Verdict =
  | {
      eligible: true;
      family: MorningReason;
      /** Coefficient de la famille (voir `MORNING_PLAN.coefficient`). */
      coefficient: number;
      /** GMV prise en compte dans le score : plafonnée. La GMV réelle n'est pas touchée. */
      cappedGmv: number;
      /** Impact en euros : le score de tri. */
      impact: number;
      /** `down` : GMV annoncé en risque. `up` : upside à aller chercher. */
      direction: "down" | "up";
      /** Les raisons, dans l'ordre d'affichage : « GMV · stade · raison ». */
      reasons: string[];
    }
  | { eligible: false; why: string };

const pct = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0).replace(".", ",")} %`;

/**
 * Juge une affaire : éligible (et pourquoi) ou écartée (et pourquoi). Chaque
 * écart porte sa raison, pour qu'une absence du Plan reste explicable.
 */
export function evaluateAffaire(a: AffaireInput, rules = MORNING_PLAN): Verdict {
  if (a.gmv < rules.minGmv) return { eligible: false, why: `GMV ${kEur(a.gmv)} sous le plancher de ${kEur(rules.minGmv)}` };
  if ((a.standby || a.frozenMonthEnd) && a.hard.length === 0) {
    return { eligible: false, why: "stand-by sans signal de réactivation" };
  }
  const cappedGmv = Math.min(a.gmv, rules.scoreGmvCap);
  const hardLabels = a.hard.map((h) => h.label);
  const movement = a.stalled && a.stalledDays != null ? `aucun mouvement depuis au moins ${a.stalledDays} j` : null;
  const ok = (
    family: MorningReason,
    coefficient: number,
    impact: number,
    direction: "down" | "up",
    reasons: (string | null)[],
  ): Verdict => ({
    eligible: true,
    family,
    coefficient,
    cappedGmv,
    impact,
    direction,
    reasons: [...reasons.filter((r): r is string => !!r), ...hardLabels],
  });

  if (a.declaredOnM) {
    // A — annoncée sur M, RM Morning la juge fragile ou bloquée : GMV annoncé en risque.
    if (a.stalled || a.challengeKind === "declaree_fragile") {
      return ok("securiser", rules.coefficient.securiser, cappedGmv * rules.coefficient.securiser * (1 - a.pMonthEnd), "down", [
        `annoncée sur M, RM Morning à ${pct(a.pMonthEnd)}`,
        movement,
      ]);
    }
    // E — annoncée sur M, RM Morning nettement en dessous : divergence Forecast / RM Morning.
    if (a.scored && a.pMonthEnd < rules.divergenceMaxP) {
      return ok("divergence", rules.coefficient.securiser, cappedGmv * rules.coefficient.securiser * (1 - a.pMonthEnd), "down", [
        `annoncée sur M, RM Morning ne l'attend qu'à ${pct(a.pMonthEnd)}`,
      ]);
    }
    return { eligible: false, why: a.scored ? "annoncée sur M, jugée crédible par RM Morning et en mouvement" : "annoncée sur M, non scorée par RM Morning : aucune divergence mesurable" };
  }

  const credible = a.pMonthEnd >= rules.minPUpside;
  // B — prévue M+1, peut signer sur M. Porte de crédibilité : pMonthEnd ≥ 10 % OU signal dur.
  if (a.challengeKind === "prevue_mois_suivant") {
    if (!credible && a.hard.length === 0) {
      return { eligible: false, why: `M+1 → M mais pMonthEnd ${pct(a.pMonthEnd)} < ${pct(rules.minPUpside)} sans signal dur` };
    }
    return ok("basculer", rules.coefficient.basculer, cappedGmv * rules.coefficient.basculer, "up", ["prévu M+1", "pourrait signer M"]);
  }
  // C — gros GMV bloqué : montant significatif, immobile, pas mort, pMonthEnd ≥ 3 %.
  if (a.gmv >= rules.bigGmv && a.stalled) {
    if (a.daysSinceActivity != null && a.daysSinceActivity > rules.deadDays) {
      return { eligible: false, why: `gros dossier sans activité depuis ${a.daysSinceActivity} j (mort)` };
    }
    if (a.pMonthEnd < rules.minPBlocked) {
      return { eligible: false, why: `gros dossier bloqué mais pMonthEnd ${pct(a.pMonthEnd)} < ${pct(rules.minPBlocked)}` };
    }
    return ok("bloque", rules.coefficient.bloque, cappedGmv * rules.coefficient.bloque, "up", [
      movement,
      a.kanbanMonth ? "prévu plus tard" : "hors prévision",
    ]);
  }
  // D — hors forecast crédible : RM Morning attend une signature malgré l'absence de
  // prévision (`absente_du_mois`) ou pMonthEnd ≥ 10 %, ET (pMonthEnd ≥ 10 % OU signal dur).
  if (a.challengeKind === "absente_du_mois" || credible) {
    if (!credible && a.hard.length === 0) {
      return { eligible: false, why: `hors forecast, pMonthEnd ${pct(a.pMonthEnd)} < ${pct(rules.minPUpside)} sans signal dur` };
    }
    return ok("upside", rules.coefficient.upside, cappedGmv * rules.coefficient.upside, "up", [
      "hors prévision",
      credible ? `RM Morning à ${pct(a.pMonthEnd)}` : null,
    ]);
  }
  return { eligible: false, why: "aucune famille : ni annoncée à risque, ni M+1 → M, ni gros dossier bloqué, ni upside crédible" };
}

/** « 826 k€ · Examen devis · … » : les morceaux vides disparaissent. */
export function joinDetail(parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");
}

// --- Sélection ----------------------------------------------------------------

export type Ranked = { key: string; impact: number; gmv: number };

/**
 * Les N meilleures affaires : impact décroissant, puis GMV réelle décroissante,
 * puis clé (résultat reproductible). AUCUN plafond par commercial : si les quatre
 * affaires les plus impactantes sont au même commercial, elles apparaissent
 * toutes les quatre. AUCUN remplissage : au plus `max`, et moins s'il y en a
 * moins. Une affaire n'apparaît qu'une fois.
 */
export function selectAffaires<T extends Ranked>(candidates: T[], max: number = MORNING_PLAN.maxSituations): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of [...candidates].sort((a, b) => b.impact - a.impact || b.gmv - a.gmv || a.key.localeCompare(b.key))) {
    if (out.length >= Math.max(0, max)) break;
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

// --- Absences de signal par commercial (conservées pour Performance) ------------

export type AbsenceSignals = {
  pipe: AttentionReason | null;
  frozen: AttentionReason | null;
};

/**
 * Les deux absences de signal PAR COMMERCIAL d'`attention.ts` : « pipe faible » et
 * « affaires sans évolution ». Elles ne sont plus des lignes du Plan du jour
 * (ce ne sont pas des affaires) mais leurs règles restent la source unique pour
 * « Ma semaine » et pour la future évolution de Performance. Les règles ne sont
 * PAS recopiées : on appelle `evaluateReasons` avec les champs utiles.
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

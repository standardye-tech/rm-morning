/**
 * Moteur d'attention managériale — « Ma semaine ».
 *
 * PUR : aucune lecture de base ici. `week.ts` assemble les entrées à partir des
 * calculs existants (Performance, Forecast V2, Monitoring, métriques de pipe,
 * snapshots) et ce module ne fait que juger. Il est donc contrôlable sur des
 * entrées synthétiques, et chaque verdict est explicable par ses raisons.
 *
 * Deux verdicts par Expert Travaux, jamais confondus :
 *   — Performance : vert / neutre / orange, paliers de la page Performance ;
 *   — Attention : vert / orange / rouge, niveau d'intervention recommandé.
 *
 * Aucun score opaque sur 100. Des règles nommées, un poids chacune, un verdict
 * qui découle du nombre et du poids des raisons allumées. Les seuils vivent
 * dans `config.ts` (`ATTENTION`).
 */

import { ATTENTION, BIG_DEALS, THRESHOLDS } from "./config";
import type { DivergenceLevel } from "./forecast-v2";
import { kEur } from "./vocabulary";

export type AttentionLevel = "vert" | "orange" | "rouge";
export type PerformanceLevel = "vert" | "neutre" | "orange";
export type ReasonWeight = "fort" | "modere";

export type ReasonKey =
  | "forecast_retard"
  | "anomalies_suivi"
  | "clients_attente"
  | "affaires_figees"
  | "gros_dossier_signature"
  | "pipe_faible"
  | "donnees_obsoletes";

/** Ordre de dominance : la première raison allumée dicte la recommandation. */
export const REASON_ORDER: ReasonKey[] = [
  "forecast_retard",
  "anomalies_suivi",
  "clients_attente",
  "affaires_figees",
  "gros_dossier_signature",
  "pipe_faible",
  "donnees_obsoletes",
];

export type AttentionReason = {
  key: ReasonKey;
  weight: ReasonWeight;
  /** Titre court : « Forecast en retard ». */
  label: string;
  /** Le chiffre qui le prouve : « 3 affaires sans évolution depuis au moins 12 jours ». */
  detail: string;
};

/** Heure / Avec qui / Regarder où / Rechercher quoi / Obtenir quoi. */
export type Recommendation = {
  minutes: number;
  action: string;
  lookWhere: string;
  lookFor: string;
  obtain: string;
};

export type AttentionInput = {
  salesperson: string;
  firstName: string;
  /** Score /100 de la page Performance, ou null si non classé. */
  performanceScore: number | null;
  activeCount: number;
  activeGmv: number;
  /** Affaires actives sans activité depuis plus de `THRESHOLDS.staleDays`. */
  staleCount: number;
  /** Affaires actives sans aucune Projection Kanban. */
  withoutProjectionCount: number;
  /** Verdict du Monitoring Opportunités, ou null si non calculé. */
  monitoringState: "sain" | "à surveiller" | "action requise" | null;
  newExceptions: number;
  /** Affaires où le client attend une réponse. */
  clientWaiting: number;
  /** Forecast du mois : null quand l'Expected n'est pas disponible. */
  divergence: DivergenceLevel | null;
  /** Expected restant du mois et Kanban restant déclaré, en euros. */
  expectedRemaining: number;
  kanbanRemaining: number;
  /** Affaires sans évolution : ni changement d'étape observé, ni activité. */
  stagnant: { count: number; minProvenDays: number; examples: string[] };
  /** Dossiers ≥ BIG_DEALS.minGmv en phase avancée. */
  nearSignature: { count: number; gmv: number; examples: string[] };
};

export type AttentionVerdict = {
  salesperson: string;
  firstName: string;
  performance: { level: PerformanceLevel; score: number | null };
  attention: { level: AttentionLevel; strong: number; total: number };
  reasons: AttentionReason[];
  primary: ReasonKey | null;
  recommendation: Recommendation | null;
  /** « Forecast en retard + affaires figées », ou « Aucune intervention recommandée ». */
  summary: string;
};

export const PERFORMANCE_LABEL: Record<PerformanceLevel, string> = {
  vert: "Bonne",
  neutre: "Dans la moyenne",
  orange: "En retrait",
};

export const ATTENTION_LABEL: Record<AttentionLevel, string> = {
  vert: "Aucune intervention recommandée",
  orange: "Intervention utile",
  rouge: "Intervention prioritaire",
};

/** Paliers de la page Performance, repris tels quels. Jamais de rouge. */
export function assessPerformance(score: number | null): PerformanceLevel {
  if (score == null) return "neutre";
  if (score >= ATTENTION.performance.green) return "vert";
  if (score >= ATTENTION.performance.neutral) return "neutre";
  return "orange";
}

const RECOMMENDATION: Record<ReasonKey, Omit<Recommendation, "minutes">> = {
  forecast_retard: {
    action: "Reprendre la Perspective affaire par affaire",
    lookWhere: "Forecast, mois en cours, ligne du commercial",
    lookFor: "Les affaires déclarées que RM Morning n'attend pas ce mois",
    obtain: "Une Perspective corrigée et une prochaine action datée par affaire",
  },
  anomalies_suivi: {
    action: "Remettre les relances à jour",
    lookWhere: "Monitoring, vue Opportunités",
    lookFor: "Estimations et devis envoyés sans relance, stand-by expirés",
    obtain: "Chaque exception traitée ou planifiée dans la semaine",
  },
  clients_attente: {
    action: "Faire répondre les clients en attente",
    lookWhere: "Monitoring, clients en attente",
    lookFor: "Les messages clients restés sans réponse",
    obtain: "Une réponse envoyée à chaque client sous 48 h",
  },
  affaires_figees: {
    action: "Challenger les prochaines étapes",
    lookWhere: "Salesforce, opportunités actives",
    lookFor: "Pourquoi les dossiers n'avancent pas",
    obtain: "Deux prochaines actions datées par affaire",
  },
  gros_dossier_signature: {
    action: "Aider à closer",
    lookWhere: "Forecast, dossiers en Examen devis et Signature",
    lookFor: "Ce qui sépare encore le dossier de la signature",
    obtain: "Une date de signature visée et le prochain contact client",
  },
  pipe_faible: {
    action: "Reconstituer le pipe",
    lookWhere: "Monitoring, vue Pistes",
    lookFor: "Pistes non converties et sources d'affaires nouvelles",
    obtain: "Un plan de prospection sur deux semaines",
  },
  donnees_obsoletes: {
    action: "Remettre Salesforce à jour",
    lookWhere: "Salesforce, activités et Projection Kanban",
    lookFor: "Affaires sans activité récente et sans mois de signature",
    obtain: "Un Salesforce à jour avant le point suivant",
  },
};

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Les règles, une par raison. Chacune rend null si elle ne s'allume pas. */
export function evaluateReasons(input: AttentionInput, rules = ATTENTION): AttentionReason[] {
  const reasons: AttentionReason[] = [];

  // 1. Forecast en retard — l'Expected restant est nettement sous le déclaré.
  if (input.divergence === "fort" && input.kanbanRemaining > 0 && input.expectedRemaining < input.kanbanRemaining) {
    reasons.push({
      key: "forecast_retard",
      weight: "fort",
      label: "Forecast en retard",
      detail: `RM Morning attend ${kEur(input.expectedRemaining)} sur ${kEur(input.kanbanRemaining)} déclarés ce mois`,
    });
  } else if (input.divergence === "prudent" && input.kanbanRemaining > 0 && input.expectedRemaining < input.kanbanRemaining) {
    reasons.push({
      key: "forecast_retard",
      weight: "modere",
      label: "Forecast à confronter",
      detail: `RM Morning attend ${kEur(input.expectedRemaining)} sur ${kEur(input.kanbanRemaining)} déclarés ce mois`,
    });
  }

  // 2. Anomalies de suivi — verdict du Monitoring, repris sans le recalculer.
  if (input.monitoringState === "action requise") {
    reasons.push({
      key: "anomalies_suivi",
      weight: "fort",
      label: "Suivi des jalons en défaut",
      detail: `${input.newExceptions} ${plural(input.newExceptions, "exception nouvelle", "exceptions nouvelles")} sur ${input.activeCount} affaires`,
    });
  } else if (input.monitoringState === "à surveiller" && input.newExceptions >= rules.watchMinExceptions) {
    reasons.push({
      key: "anomalies_suivi",
      weight: "modere",
      label: "Jalons à surveiller",
      detail: `${input.newExceptions} ${plural(input.newExceptions, "exception nouvelle", "exceptions nouvelles")} sur ${input.activeCount} affaires`,
    });
  }

  // 3. Clients en attente — signal positif (le client a écrit), donc fort.
  if (input.clientWaiting >= rules.clientWaitingStrong) {
    reasons.push({
      key: "clients_attente",
      weight: "fort",
      label: "Clients en attente de réponse",
      detail: `${input.clientWaiting} clients attendent une réponse`,
    });
  }

  // 4. Affaires figées — borne basse prouvée par les snapshots, jamais plus.
  const stagnantShare = input.activeCount > 0 ? input.stagnant.count / input.activeCount : 0;
  if (input.stagnant.count >= rules.stagnantMinCount && stagnantShare >= rules.stagnantShare) {
    reasons.push({
      key: "affaires_figees",
      weight: "modere",
      label: "Affaires sans évolution",
      detail: `${input.stagnant.count} affaires sans évolution depuis au moins ${input.stagnant.minProvenDays} jours`,
    });
  }

  // 5. Gros dossier proche de signature — une aide à apporter, pas un reproche.
  if (input.nearSignature.count >= 1) {
    reasons.push({
      key: "gros_dossier_signature",
      weight: "modere",
      label: "Gros dossier proche de signature",
      detail: `${input.nearSignature.count} ${plural(input.nearSignature.count, "dossier", "dossiers")} ≥ ${kEur(BIG_DEALS.minGmv)} en phase avancée (${kEur(input.nearSignature.gmv)})`,
    });
  }

  // 6. Pipe faible — même seuil que l'alerte Morning.
  if (input.activeGmv < rules.lowPipeGmv) {
    reasons.push({
      key: "pipe_faible",
      weight: "modere",
      label: "Pipe faible",
      detail: `${kEur(input.activeGmv)} de pipe actif, sous ${kEur(rules.lowPipeGmv)}`,
    });
  }

  // 7. Données insuffisamment à jour — le point porte d'abord sur l'outil.
  const staleShare = input.activeCount > 0 ? input.staleCount / input.activeCount : 0;
  const noProjection = input.activeCount > 0 && input.withoutProjectionCount === input.activeCount;
  if ((input.activeCount >= 5 && staleShare > rules.staleShare) || noProjection) {
    reasons.push({
      key: "donnees_obsoletes",
      weight: "modere",
      label: "Données Salesforce insuffisamment à jour",
      detail: noProjection
        ? `aucune des ${input.activeCount} affaires actives ne porte de Projection Kanban`
        : `${input.staleCount} affaires sur ${input.activeCount} sans activité depuis plus de ${THRESHOLDS.staleDays} jours`,
    });
  }

  return reasons.sort((a, b) => {
    if (a.weight !== b.weight) return a.weight === "fort" ? -1 : 1;
    return REASON_ORDER.indexOf(a.key) - REASON_ORDER.indexOf(b.key);
  });
}

/** Verdict à partir des raisons allumées. Règle unique, lisible. */
export function levelFromReasons(reasons: AttentionReason[], rules = ATTENTION): AttentionLevel {
  const strong = reasons.filter((r) => r.weight === "fort").length;
  const total = reasons.length;
  if (strong >= rules.verdict.redStrongAlone) return "rouge";
  if (strong >= rules.verdict.redStrongWithOther && total >= rules.verdict.redMinReasons) return "rouge";
  if (strong >= 1) return "orange";
  if (total >= rules.verdict.orangeMinModerate) return "orange";
  return "vert";
}

export function assessAttention(input: AttentionInput, rules = ATTENTION): AttentionVerdict {
  const reasons = evaluateReasons(input, rules);
  const level = levelFromReasons(reasons, rules);
  const strong = reasons.filter((r) => r.weight === "fort").length;
  const primary = reasons[0]?.key ?? null;
  const recommendation: Recommendation | null =
    level === "vert" || primary == null
      ? null
      : { minutes: rules.minutes[level], ...RECOMMENDATION[primary] };

  return {
    salesperson: input.salesperson,
    firstName: input.firstName,
    performance: { level: assessPerformance(input.performanceScore), score: input.performanceScore },
    attention: { level, strong, total: reasons.length },
    reasons,
    primary,
    recommendation,
    // Le résumé dit ce qui a été vu, même en vert : une raison modérée isolée
    // n'appelle pas de point, mais elle mérite d'être lue.
    summary: reasons.length > 0 ? reasons.map((r) => r.label).join(" + ") : ATTENTION_LABEL.vert,
  };
}

/** Rouge d'abord, puis orange, puis vert ; à niveau égal, le plus de raisons fortes. */
export function sortVerdicts(verdicts: AttentionVerdict[]): AttentionVerdict[] {
  const rank: Record<AttentionLevel, number> = { rouge: 0, orange: 1, vert: 2 };
  return [...verdicts].sort((a, b) => {
    if (a.attention.level !== b.attention.level) return rank[a.attention.level] - rank[b.attention.level];
    if (a.attention.strong !== b.attention.strong) return b.attention.strong - a.attention.strong;
    if (a.attention.total !== b.attention.total) return b.attention.total - a.attention.total;
    return a.firstName.localeCompare(b.firstName, "fr");
  });
}

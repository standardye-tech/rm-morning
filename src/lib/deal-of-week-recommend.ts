/**
 * Affaire recommandée de la semaine — « RM Morning propose, Sami arbitre ».
 *
 * PUR : `week.ts` assemble les candidats à partir des données déjà en base
 * (opportunités, jalons, snapshots, verdict d'attention, gros dossiers,
 * historique des choix) ; ce module présélectionne, note, explique et choisit.
 *
 * PAS DE SCORE OPAQUE. Chaque critère ajoute des points ET une étiquette ; la
 * somme classe, l'étiquette la plus forte devient la raison affichée. On peut
 * toujours répondre à « pourquoi cette affaire plutôt qu'une autre ? » en
 * lisant la liste des critères. Les seuils vivent dans `config.ts`
 * (`DEAL_OF_WEEK_RECOMMENDATION`).
 *
 * Une affaire de la semaine n'est jamais obligatoire : sans candidat, aucune
 * recommandation ; et le directeur peut ignorer la semaine.
 */

import { DEAL_OF_WEEK_ANGLES, DEAL_OF_WEEK_RECOMMENDATION, type DealOfWeekAngle } from "./config";
import { daysBetween } from "./normalize";
import type { MilestoneStatus, NextExpectedEvent } from "./opportunity-milestones";

export type RecommendationCandidate = {
  opportunityId: string;
  owner: string;
  firstName: string;
  client: string;
  gmv: number | null;
  stage: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  isActive: boolean;
  /** Jalons du Monitoring, quand ils ont été calculés. */
  milestone: {
    status: MilestoneStatus;
    nextExpectedEvent: NextExpectedEvent;
    nextExpectedDueAt: string | null;
    estimationSentAt: string | null;
    devisSentAt: string | null;
    nextVisitAt: string | null;
    clientWaiting: boolean;
  } | null;
  /** Changement d'étape observé dans les snapshots depuis peu. */
  stageChangedRecently: boolean;
  /** Verdict d'attention de l'ET, ou null si l'ET n'est pas évalué. */
  attention: "vert" | "orange" | "rouge" | null;
  /** L'ET est actif dans le périmètre et n'est pas exclu du moteur. */
  ownerEligible: boolean;
  /** Déjà remontée dans le bloc Gros dossiers. */
  isBigDeal: boolean;
  /** Déjà l'affaire de la semaine en cours. */
  isCurrent: boolean;
};

export type HistoryEntry = {
  opportunityId: string;
  salesperson: string;
  /** Lundi ISO de la semaine concernée. */
  weekStart: string;
  status: string;
};

export type Criterion = { key: string; points: number; label: string };

export type Recommendation = {
  candidate: RecommendationCandidate;
  criteria: Criterion[];
  total: number;
  /** Une seule raison, courte et concrète. */
  reason: string;
  angle: DealOfWeekAngle;
  angleLabel: string;
};

export type RecommendationSet = {
  primary: Recommendation;
  alternatives: Recommendation[];
  /** Nombre de candidats après présélection, pour la note de bas de bloc. */
  considered: number;
  /** Classement brut complet, pour les audits et le harnais. Jamais affiché. */
  ranked: Recommendation[];
};

const CHALLENGEABLE_STAGES = ["Etude dossier", "Examen estimation", "Visite artisan", "Examen devis", "Signature"];

const days = (iso: string | null, today: string): number | null =>
  iso ? daysBetween(iso.slice(0, 10), today) : null;

// --- Présélection ------------------------------------------------------------

export function preselect(
  candidates: RecommendationCandidate[],
  today: string,
  rules = DEAL_OF_WEEK_RECOMMENDATION,
): RecommendationCandidate[] {
  return candidates.filter((c) => {
    if (!c.isActive || c.isCurrent || c.isBigDeal || !c.ownerEligible) return false;
    if ((c.gmv ?? 0) < rules.minGmv) return false;
    if (!c.stage || !CHALLENGEABLE_STAGES.includes(c.stage)) return false;
    const act = days(c.lastActivityAt, today);
    const age = days(c.createdAt, today);
    const recent = (act != null && act <= rules.recentActivityDays) || (age != null && age <= rules.newDealDays);
    if (!recent) return false;
    if (act != null && act > rules.staleDays) return false;
    const status = c.milestone?.status;
    if (status === "dormant_candidate" || status === "standby_expire" || status === "standby") return false;
    return true;
  });
}

// --- Angle suggéré -------------------------------------------------------------

export function suggestAngle(
  c: RecommendationCandidate,
  today: string,
  rules = DEAL_OF_WEEK_RECOMMENDATION,
): DealOfWeekAngle {
  const act = days(c.lastActivityAt, today);
  const age = days(c.createdAt, today);
  switch (c.stage) {
    case "Etude dossier":
      return age != null && age <= rules.freshDealDays ? "qualification" : "strategie_client";
    case "Examen estimation":
      return c.milestone?.estimationSentAt ? "strategie_client" : "estimation";
    case "Visite artisan":
      if (c.milestone?.nextVisitAt) return "visite_artisan";
      return act != null && act > rules.urgencyIdleDays ? "urgence" : "planning";
    case "Examen devis":
      return c.milestone?.devisSentAt ? "closing" : "strategie_client";
    case "Signature":
      return "closing";
    default:
      return "autre";
  }
}

export function angleLabel(key: DealOfWeekAngle): string {
  return DEAL_OF_WEEK_ANGLES.find((a) => a.key === key)?.label ?? "Autre";
}

// --- Raison courte, une seule -----------------------------------------------------

function reasonOf(c: RecommendationCandidate, today: string, rules = DEAL_OF_WEEK_RECOMMENDATION): string {
  const act = days(c.lastActivityAt, today);
  const age = days(c.createdAt, today);
  const performant = c.attention === "vert" ? "ET performant, mais " : "";
  switch (c.stage) {
    case "Etude dossier":
      return age != null && age <= rules.freshDealDays
        ? `${performant}affaire récente : bon dossier pour challenger la qualification.`
        : `${performant}étude dossier qui traîne : la stratégie client est à reprendre.`;
    case "Examen estimation":
      return c.milestone?.estimationSentAt
        ? `${performant}estimation envoyée : le bon moment pour challenger la stratégie client.`
        : `${performant}estimation en cours : challenger le chiffrage avant l'envoi.`;
    case "Visite artisan":
      if (c.milestone?.nextVisitAt) return `${performant}visite artisan à venir : challenger la préparation et l'urgence.`;
      return act != null && act > rules.urgencyIdleDays
        ? `${performant}visite artisan réalisée sans suite datée : créer l'urgence.`
        : `${performant}visite artisan réalisée : bon moment pour travailler planning et closing.`;
    case "Examen devis":
      return c.milestone && !c.milestone.nextExpectedDueAt
        ? `${performant}devis en examen : le client avance mais la prochaine étape n'est pas datée.`
        : `${performant}devis en examen : assez avancée pour challenger le closing, encore influençable.`;
    case "Signature":
      return `${performant}en signature : vérifier ce qui manque pour signer et le planning.`;
    default:
      return `${performant}affaire significative, à challenger sur la méthode.`;
  }
}

// --- Notation ---------------------------------------------------------------------

export function evaluate(
  c: RecommendationCandidate,
  today: string,
  weekStart: string,
  history: HistoryEntry[],
  rules = DEAL_OF_WEEK_RECOMMENDATION,
): Recommendation {
  const p = rules.points;
  const criteria: Criterion[] = [];
  const add = (key: string, points: number, label: string) => {
    if (points !== 0) criteria.push({ key, points, label });
  };
  const act = days(c.lastActivityAt, today);
  const age = days(c.createdAt, today);

  // 1. Fenêtre pédagogique de l'étape.
  switch (c.stage) {
    case "Examen devis":
      add("etape", p.stage.examenDevis, "devis en examen : closing challengeable");
      break;
    case "Visite artisan":
      add("etape", p.stage.visiteArtisan, c.milestone?.nextVisitAt ? "visite artisan à venir" : "visite artisan réalisée");
      break;
    case "Examen estimation":
      add("etape", p.stage.examenEstimation, "estimation en cours");
      break;
    case "Etude dossier":
      if (age != null && age <= rules.freshDealDays) add("etape", p.stage.etudeDossierRecente, "affaire récente, qualification à challenger");
      else add("etape", p.stage.etudeDossier, "étude dossier");
      break;
    case "Signature":
      add("etape", p.stage.signature, "en signature, marge d'influence réduite");
      break;
  }

  // 2. Mouvement.
  if (act != null && act < 0) add("activite", p.plannedEvent, "rendez-vous planifié");
  else if (act != null && act <= rules.freshActivityDays) add("activite", p.activityFresh, "activité cette semaine");
  else if (act != null && act <= rules.recentDays) add("activite", p.activityRecent, "activité récente");
  if (c.stageChangedRecently) add("etape_changee", p.stageChanged, "changement d'étape observé récemment");

  // 3. Montant : significatif sans être un gros dossier.
  const g = c.gmv ?? 0;
  if (g >= rules.significantGmv.lo && g <= rules.significantGmv.hi) add("montant", p.gmvSignificant, "montant significatif");
  else if (g >= rules.minGmv) add("montant", p.gmvModest, "montant modeste");

  // 4. Prochaine étape floue, client en attente.
  if (c.milestone && c.milestone.status === "normal" && !c.milestone.nextExpectedDueAt) {
    add("prochaine_etape", p.nextStepUndated, "prochaine étape non datée");
  }
  if (c.milestone?.clientWaiting) add("client_attend", p.clientWaiting, "client en attente de réponse");

  // 5. Attention managériale de l'ET : les oranges d'abord, sans exclure personne.
  if (c.attention === "orange") add("et", p.etOrange, "ET à surveiller");
  else if (c.attention === "rouge") add("et", p.etRouge, "ET prioritaire, déjà planifié");
  else if (c.attention === "vert") add("et", p.etVert, "ET performant, regard utile");

  // 6. Anti-répétition, d'après deal_of_week.
  const pen = rules.penalties;
  let chosenPenalty = 0;
  let ignoredPenalty = 0;
  let ownerPenalty = 0;
  for (const h of history) {
    const weeksAgo = Math.floor(daysBetween(h.weekStart, weekStart) / 7);
    const chosen = h.status === "en_cours" || h.status === "remplacee" || h.status === "cloturee";
    if (h.opportunityId === c.opportunityId) {
      if (chosen && weeksAgo <= 1) chosenPenalty = Math.min(chosenPenalty, pen.chosenLastWeek);
      else if (chosen && weeksAgo <= pen.recentWeeks) chosenPenalty = Math.min(chosenPenalty, pen.chosenRecently);
      else if (h.status === "ignoree" && weeksAgo === 1) ignoredPenalty = Math.min(ignoredPenalty, pen.ignoredLastWeek);
    } else if (chosen && h.salesperson === c.owner && weeksAgo <= 1) {
      ownerPenalty = Math.min(ownerPenalty, pen.sameOwnerLastWeek);
    }
  }
  if (chosenPenalty) add("historique", chosenPenalty, chosenPenalty === pen.chosenLastWeek ? "déjà choisie la semaine dernière" : "choisie récemment");
  if (ignoredPenalty) add("historique_ignoree", ignoredPenalty, "ignorée la semaine dernière");
  if (ownerPenalty) add("historique_et", ownerPenalty, "même ET la semaine dernière");

  const total = criteria.reduce((s, x) => s + x.points, 0);
  const angle = suggestAngle(c, today, rules);
  return { candidate: c, criteria, total, reason: reasonOf(c, today, rules), angle, angleLabel: angleLabel(angle) };
}

// --- Choix des trois ---------------------------------------------------------------

function tieBreak(a: Recommendation, b: Recommendation, today: string): number {
  if (a.total !== b.total) return b.total - a.total;
  const aa = days(a.candidate.lastActivityAt, today) ?? 999;
  const ab = days(b.candidate.lastActivityAt, today) ?? 999;
  if (Math.abs(aa) !== Math.abs(ab)) return Math.abs(aa) - Math.abs(ab);
  return (b.candidate.gmv ?? 0) - (a.candidate.gmv ?? 0);
}

/** Classement brut, du plus pertinent au moins pertinent. */
export function rank(
  candidates: RecommendationCandidate[],
  today: string,
  weekStart: string,
  history: HistoryEntry[],
  rules = DEAL_OF_WEEK_RECOMMENDATION,
): Recommendation[] {
  return preselect(candidates, today, rules)
    .map((c) => evaluate(c, today, weekStart, history, rules))
    .sort((a, b) => tieBreak(a, b, today));
}

/**
 * Sélection avec diversité : un même ET ou un même angle est sauté quand un
 * autre candidat presque aussi bon existe. Presque = tolérance de la config.
 */
export function pickDiverse(
  ranked: Recommendation[],
  rules = DEAL_OF_WEEK_RECOMMENDATION,
): Recommendation[] {
  const picks: Recommendation[] = [];
  const want = 1 + rules.alternatives;
  for (const r of ranked) {
    if (picks.length === want) break;
    const rest = ranked.filter((x) => x !== r && !picks.includes(x));
    const ownerTaken = picks.some((p) => p.candidate.owner === r.candidate.owner);
    const angleTaken = picks.some((p) => p.angle === r.angle);
    const otherOwner = (x: Recommendation) => !picks.some((p) => p.candidate.owner === x.candidate.owner);
    if (ownerTaken && rest.some((x) => otherOwner(x) && x.total >= r.total - rules.diversity.ownerTolerance)) continue;
    if (angleTaken && rest.some((x) => otherOwner(x) && x.angle !== r.angle && x.total >= r.total - rules.diversity.angleTolerance)) continue;
    picks.push(r);
  }
  return picks;
}

export function recommend(
  candidates: RecommendationCandidate[],
  today: string,
  weekStart: string,
  history: HistoryEntry[],
  rules = DEAL_OF_WEEK_RECOMMENDATION,
): RecommendationSet | null {
  const ranked = rank(candidates, today, weekStart, history, rules);
  if (ranked.length === 0) return null;
  const [primary, ...alternatives] = pickDiverse(ranked, rules);
  return { primary, alternatives, considered: ranked.length, ranked };
}

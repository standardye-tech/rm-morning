/**
 * Monitoring — composition des listes affichées et de l'état de lecture.
 *
 * Ce fichier existe pour une raison précise : « Tout lire » doit porter sur
 * EXACTEMENT ce que l'écran vient de montrer. Si la page et l'API construisaient
 * chacune leur liste, un décalage d'un seul élément suffirait à laisser une
 * anomalie non lue derrière un écran vide — le pire résultat possible pour un
 * mécanisme dont le rôle est de dire « il ne reste rien ».
 *
 * Les règles de priorité ne sont pas retouchées : `buildLeadTodo`,
 * `buildValueBlock` et `buildExceptionList` restent seuls juges de ce qui est
 * une anomalie et de son ordre. Ce module ne fait que deux choses de plus :
 * retirer ce qui a déjà été lu et n'a pas bougé, et attacher à chaque élément
 * restant ce qui a changé depuis.
 *
 * PLAFOND D'AFFICHAGE ET PÉRIMÈTRE DE LECTURE, volontairement distincts :
 * l'écran ne montre qu'une dizaine de lignes pour rester lisible, mais
 * « Tout lire » acquitte tout le stock actif. Sinon la liste se remplirait
 * aussitôt avec la page suivante et ne pourrait jamais atteindre zéro.
 */

import { LEAD_MONITORING, OPPORTUNITY_MONITORING } from "./config";
import { buildLeadTodo, type TodoItem } from "./lead-metrics";
import { loadLeads } from "./lead-store";
import {
  buildExceptionList,
  buildValueBlock,
  loadMilestoneOpportunities,
  type MilestoneOpportunity,
  type ValueItem,
} from "./opportunity-metrics";
import {
  compareWithRead,
  lastReadAt,
  leadFields,
  markAllRead,
  opportunityFields,
  type ReadVerdict,
  type WatchedField,
} from "./monitoring-read";

const ALL = Number.MAX_SAFE_INTEGER;

export type LeadTodoEntry = TodoItem & { verdict: ReadVerdict };
export type ValueEntry = ValueItem & { verdict: ReadVerdict };
export type ExceptionEntry = { opportunity: MilestoneOpportunity; verdict: ReadVerdict };

export type MonitoringListState = {
  /** Éléments restant à traiter, plafonnés pour l'affichage. */
  visibleCount: number;
  /** Éléments actifs masqués parce que lus et inchangés. */
  readCount: number;
  /** Éléments actifs au total, tels que « Tout lire » les acquittera. */
  activeCount: number;
  /** Éléments revenus parce qu'une valeur a changé depuis la lecture. */
  changedCount: number;
  lastReadAt: string | null;
};

export type LeadMonitoringView = MonitoringListState & { items: LeadTodoEntry[] };
export type OpportunityMonitoringView = MonitoringListState & {
  items: ValueEntry[];
  exceptions: ExceptionEntry[];
};

function stateOf(
  activeCount: number,
  pending: { verdict: ReadVerdict }[],
  visibleCount: number,
  scope: "piste" | "opportunite",
): MonitoringListState {
  return {
    visibleCount,
    readCount: activeCount - pending.length,
    activeCount,
    changedCount: pending.filter((p) => p.verdict.status === "modifie").length,
    lastReadAt: lastReadAt(scope),
  };
}

// --- Pistes ---------------------------------------------------------------

export function leadMonitoringView(
  ownerFilter: string | null,
  limit: number = LEAD_MONITORING.maxTodoItems,
): LeadMonitoringView {
  const leads = ownerFilter
    ? loadLeads().filter((l) => l.owner === ownerFilter)
    : loadLeads();
  const all = buildLeadTodo(leads, ALL);
  const verdicts = compareWithRead(
    "piste",
    all.map((t) => ({ id: t.lead.leadId, fields: leadFields(t.lead) })),
  );
  const pending = all
    .map((t) => ({ ...t, verdict: verdicts.get(t.lead.leadId)! }))
    .filter((t) => t.verdict.status !== "lu");

  return {
    items: pending.slice(0, limit),
    ...stateOf(all.length, pending, Math.min(pending.length, limit), "piste"),
  };
}

/** Ce que « Tout lire » acquitte côté pistes : tout le stock actif du périmètre. */
export function leadReadTargets(ownerFilter: string | null): { id: string; fields: WatchedField[] }[] {
  const leads = ownerFilter ? loadLeads().filter((l) => l.owner === ownerFilter) : loadLeads();
  return buildLeadTodo(leads, ALL).map((t) => ({
    id: t.lead.leadId,
    fields: leadFields(t.lead),
  }));
}

// --- Opportunités ---------------------------------------------------------

/**
 * Périmètre de lecture des opportunités : union de « À débloquer maintenant »
 * et des « Exceptions de suivi ».
 *
 * Les deux blocs décrivent le même stock sous deux angles — ce qu'on peut
 * débloquer, et ce qui traîne. Les acquitter séparément produirait l'effet
 * absurde d'un bloc vide au-dessus d'un bloc plein contenant les mêmes dossiers.
 */
function opportunityScope(ownerFilter: string | null): {
  value: ValueItem[];
  exceptions: MilestoneOpportunity[];
  union: MilestoneOpportunity[];
} {
  const all = loadMilestoneOpportunities();
  const opportunities = ownerFilter ? all.filter((o) => o.owner === ownerFilter) : all;
  const value = buildValueBlock(opportunities, ALL);
  const exceptions = buildExceptionList(opportunities, ALL);
  const union = new Map<string, MilestoneOpportunity>();
  for (const v of value) union.set(v.opportunity.opportunityId, v.opportunity);
  for (const e of exceptions) union.set(e.opportunityId, e);
  return { value, exceptions, union: [...union.values()] };
}

export function opportunityMonitoringView(
  ownerFilter: string | null,
  limit: number = OPPORTUNITY_MONITORING.maxValueItems,
  exceptionLimit = 10,
): OpportunityMonitoringView {
  const scope = opportunityScope(ownerFilter);
  const verdicts = compareWithRead(
    "opportunite",
    scope.union.map((o) => ({ id: o.opportunityId, fields: opportunityFields(o) })),
  );

  const pendingValue = scope.value
    .map((v) => ({ ...v, verdict: verdicts.get(v.opportunity.opportunityId)! }))
    .filter((v) => v.verdict.status !== "lu");
  const pendingExceptions = scope.exceptions
    .map((o) => ({ opportunity: o, verdict: verdicts.get(o.opportunityId)! }))
    .filter((e) => e.verdict.status !== "lu");

  // L'état affiché porte sur l'UNION : c'est le périmètre que « Tout lire »
  // acquitte, et le compteur doit décrire ce que le bouton va faire.
  const pendingUnion = scope.union
    .map((o) => ({ verdict: verdicts.get(o.opportunityId)! }))
    .filter((v) => v.verdict.status !== "lu");

  return {
    items: pendingValue.slice(0, limit),
    exceptions: pendingExceptions.slice(0, exceptionLimit),
    ...stateOf(
      scope.union.length,
      pendingUnion,
      Math.min(pendingValue.length, limit),
      "opportunite",
    ),
  };
}

export function opportunityReadTargets(
  ownerFilter: string | null,
): { id: string; fields: WatchedField[] }[] {
  return opportunityScope(ownerFilter).union.map((o) => ({
    id: o.opportunityId,
    fields: opportunityFields(o),
  }));
}

// --- Geste « Tout lire » --------------------------------------------------

/**
 * Acquitte tout le stock actif d'un périmètre.
 *
 * Recalculé côté serveur, jamais reçu du navigateur : ce qui est enregistré
 * comme lu doit être ce que RM Morning considère aujourd'hui comme actif, pas
 * une liste vieille de plusieurs minutes envoyée par un onglet resté ouvert.
 */
export function markScopeRead(
  scope: "piste" | "opportunite",
  ownerFilter: string | null,
  now = new Date(),
): number {
  const targets = scope === "piste" ? leadReadTargets(ownerFilter) : opportunityReadTargets(ownerFilter);
  return markAllRead(scope, targets, now);
}

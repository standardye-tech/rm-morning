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
 * LU ≠ TRAITÉ. « Lu » (`monitoring_read`) dit « j'ai vu cet état de la ligne » :
 * c'est un acquittement de NOTIFICATION, porté par l'entité entière (piste ou
 * opportunité) et par le cliché de ses champs. « Traité » dit « cette action
 * est gérée » : c'est l'état PARTAGÉ de l'ActionKey de la ligne
 * (`action-state`), le même que celui du Morning et de Ma semaine. Une ligne
 * disparaît si elle est lue et inchangée OU si son action est traitée ; une
 * lecture ne ferme jamais une action, et « Tout lire » ne traite rien.
 *
 * PLAFOND D'AFFICHAGE ET PÉRIMÈTRE DE LECTURE, volontairement distincts :
 * l'écran ne montre qu'une dizaine de lignes pour rester lisible, mais
 * « Tout lire » acquitte tout le stock actif. Sinon la liste se remplirait
 * aussitôt avec la page suivante et ne pourrait jamais atteindre zéro.
 */

import { leadActionKey, opportunityActionKey } from "./action-keys";
import { treatAction, treatedActions } from "./action-state";
import { LEAD_MONITORING, OPPORTUNITY_MONITORING } from "./config";
import { MILESTONE_LABEL } from "./opportunity-milestones";
import { buildLeadTodo, type TodoItem } from "./lead-metrics";
import { loadLeads, type StoredLead } from "./lead-store";
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
  /** Éléments actifs masqués parce que leur action est traitée (où que ce soit). */
  treatedCount: number;
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
  treatedCount: number,
): MonitoringListState {
  return {
    visibleCount,
    readCount: activeCount - pending.length - treatedCount,
    treatedCount,
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
  const treated = treatedLeads(all.map((t) => t.lead));
  const open = all.filter((t) => !treated.has(t.lead.leadId));
  const pending = open
    .map((t) => ({ ...t, verdict: verdicts.get(t.lead.leadId)! }))
    .filter((t) => t.verdict.status !== "lu");

  return {
    items: pending.slice(0, limit),
    ...stateOf(all.length, pending, Math.min(pending.length, limit), "piste", all.length - open.length),
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

/** Pistes dont l'action courante est traitée (état partagé). */
function treatedLeads(leads: StoredLead[]): Set<string> {
  const keyOf = new Map(leads.map((l) => [l.leadId, leadActionKey(l)]));
  const treated = treatedActions(keyOf.values());
  return new Set([...keyOf].filter(([, k]) => treated.has(k)).map(([id]) => id));
}

/** Opportunités dont l'action courante est traitée (état partagé, Bloc 2 compris). */
function treatedOpportunities(opportunities: MilestoneOpportunity[]): Set<string> {
  const keyOf = new Map(opportunities.map((o) => [o.opportunityId, opportunityActionKey(o)]));
  const treated = treatedActions(keyOf.values());
  return new Set([...keyOf].filter(([, k]) => treated.has(k)).map(([id]) => id));
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

  const treated = treatedOpportunities(scope.union);
  const pendingValue = scope.value
    .filter((v) => !treated.has(v.opportunity.opportunityId))
    .map((v) => ({ ...v, verdict: verdicts.get(v.opportunity.opportunityId)! }))
    .filter((v) => v.verdict.status !== "lu");
  const pendingExceptions = scope.exceptions
    .filter((o) => !treated.has(o.opportunityId))
    .map((o) => ({ opportunity: o, verdict: verdicts.get(o.opportunityId)! }))
    .filter((e) => e.verdict.status !== "lu");

  // L'état affiché porte sur l'UNION : c'est le périmètre que « Tout lire »
  // acquitte, et le compteur doit décrire ce que le bouton va faire.
  const pendingUnion = scope.union
    .filter((o) => !treated.has(o.opportunityId))
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
      treated.size,
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

/**
 * Lecture d'une seule ligne.
 *
 * Même principe que « Tout lire » : la signature est celle de l'élément TEL
 * QU'IL EST EN BASE au moment du geste, jamais reçue du navigateur. Un
 * identifiant qui ne désigne plus rien (piste convertie entre-temps,
 * opportunité sortie du périmètre) ne fait rien — il n'y a rien à figer, et ce
 * n'est pas une erreur : la ligne aura de toute façon disparu de l'écran.
 */
export function markItemRead(scope: "piste" | "opportunite", itemId: string, now = new Date()): boolean {
  if (scope === "piste") {
    const lead = loadLeads().find((l) => l.leadId === itemId);
    if (!lead) return false;
    markAllRead(scope, [{ id: lead.leadId, fields: leadFields(lead) }], now);
    return true;
  }
  const opportunity = loadMilestoneOpportunities().find((o) => o.opportunityId === itemId);
  if (!opportunity) return false;
  markAllRead(scope, [{ id: opportunity.opportunityId, fields: opportunityFields(opportunity) }], now);
  return true;
}

// --- Geste « Traité » -------------------------------------------------------

/**
 * Traite l'action COURANTE d'une ligne — et seulement elle.
 *
 * L'ActionKey est recalculée depuis la base au moment du geste, jamais reçue du
 * navigateur : c'est l'anomalie telle qu'elle est maintenant. Une ligne qui
 * n'est plus une anomalie du Monitoring ne fait rien. Rien n'est lu ni écrit
 * dans Salesforce ; `monitoring_read` n'est pas touché (traiter ≠ lire).
 *
 * « Répondre au client » porte la clé du message du Bloc 2 : le traiter ici
 * l'acquitte dans le Morning, sans rien changer à la réalité de l'attente.
 */
export function treatItem(scope: "piste" | "opportunite", itemId: string, now = new Date()): boolean {
  if (scope === "piste") {
    const todo = buildLeadTodo(loadLeads().filter((l) => l.leadId === itemId), ALL)[0];
    if (!todo) return false;
    return treatAction(
      {
        key: leadActionKey(todo.lead),
        surface: "monitoring_piste",
        owner: todo.lead.owner,
        label: `${todo.lead.name ?? todo.lead.leadId} — ${todo.reason}`,
      },
      now,
    );
  }
  const o = opportunityScope(null).union.find((x) => x.opportunityId === itemId);
  if (!o) return false;
  return treatAction(
    {
      key: opportunityActionKey(o),
      surface: "monitoring_opportunite",
      owner: o.owner,
      label: `${o.client ?? o.opportunityId} — ${MILESTONE_LABEL[o.milestoneStatus]}`,
    },
    now,
  );
}

// --- Cloche de navigation ---------------------------------------------------

export type MonitoringUnreadCounts = { fresh: number; legacy: number };

/**
 * Ce que la cloche affiche : le nombre de priorités Monitoring — pistes et
 * opportunités confondues, toutes équipes — qui ne sont PAS encore lues au
 * sens de `monitoring_read`.
 *
 * MÊME définition de « non lu » que les écrans : on ne relit jamais
 * `operational_status` ni `milestone_status` bruts ici. Marquer une ligne lue,
 * individuellement ou via « Tout lire », fait donc mécaniquement baisser ce
 * compte au prochain calcul — il n'y a pas d'état intermédiaire à synchroniser.
 *
 * La distinction fresh/legacy est conservée telle qu'elle existait déjà dans
 * le mini-centre d'exceptions : la dette héritée reste visible mais ne sonne
 * pas.
 */
export function monitoringUnreadCounts(): MonitoringUnreadCounts {
  let fresh = 0;
  let legacy = 0;

  const leadTodos = buildLeadTodo(loadLeads(), ALL);
  const leadVerdicts = compareWithRead(
    "piste",
    leadTodos.map((t) => ({ id: t.lead.leadId, fields: leadFields(t.lead) })),
  );
  // Une action traitée ne sonne plus, où qu'elle ait été traitée.
  const leadTreated = treatedLeads(leadTodos.map((t) => t.lead));
  for (const t of leadTodos) {
    if (leadTreated.has(t.lead.leadId)) continue;
    if (leadVerdicts.get(t.lead.leadId)?.status === "lu") continue;
    if (t.lead.isLegacy) legacy += 1;
    else fresh += 1;
  }

  const { union } = opportunityScope(null);
  const oppVerdicts = compareWithRead(
    "opportunite",
    union.map((o) => ({ id: o.opportunityId, fields: opportunityFields(o) })),
  );
  const oppTreated = treatedOpportunities(union);
  for (const o of union) {
    if (oppTreated.has(o.opportunityId)) continue;
    if (oppVerdicts.get(o.opportunityId)?.status === "lu") continue;
    if (o.isLegacy) legacy += 1;
    else fresh += 1;
  }

  return { fresh, legacy };
}

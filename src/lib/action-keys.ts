/**
 * ActionKey — l'identité canonique d'une action métier, partagée par toutes les
 * surfaces de RM Morning (Morning, Monitoring, Ma semaine).
 *
 * UNE ACTION = UN ÉVÉNEMENT PRÉCIS. La clé vient du signal source, jamais du
 * texte affiché : `type:identifiant:nature:version`. Une même affaire porte
 * autant d'actions que de natures (répondre au client, relancer un devis,
 * sécuriser la signature…) : traiter l'une ne ferme jamais les autres. Un
 * NOUVEL événement (nouveau message, nouvelle échéance, nouveau motif, nouvelle
 * semaine) produit une NOUVELLE clé, donc une action ouverte : on ne tue jamais
 * une affaire, seulement un événement.
 *
 *   mail:{gmailMessageId}:waiting_reply             Bloc 2 · Monitoring « client attend »
 *   mail:{gmailMessageId}:hot_client                Bloc 1
 *   plan:{OpportunityId}:{motif}:{semaine}:{événements} Plan du jour · Ma semaine
 *   opportunity:{OpportunityId}:{anomalie}:{version} Monitoring opportunités
 *   lead:{LeadId}:{anomalie}:{version}              Monitoring pistes
 *
 * Cœur PUR : aucune lecture de base. L'état (traité / ouvert) vit dans
 * `action-state.ts`.
 */

import { WEEK_VIEW } from "./config";
import { parisDate, parisWeekday } from "./business-time";
import { mondayOf, todayIso } from "./normalize";

export type ActionSource = "mail" | "plan" | "opportunity" | "lead";

const SOURCES: readonly ActionSource[] = ["mail", "plan", "opportunity", "lead"];

/** Nature de l'action portée par un message, selon le bloc qui le montre. */
export function mailActionKey(messageId: string, category: "chaud" | "attente"): string {
  return `mail:${messageId}:${category === "chaud" ? "hot_client" : "waiting_reply"}`;
}

/**
 * Action du Plan du jour. Versionnée par la SEMAINE (lundi ISO, celle de « Ma
 * semaine ») et par les ÉVÉNEMENTS MATÉRIELS de l'affaire : une affaire traitée
 * reste traitée jusqu'à la fin de la semaine tant que ni son motif ni ses
 * événements ne changent ; un nouveau motif ou un nouvel événement est une
 * nouvelle action.
 */
export function planActionKey(opportunityId: string, reason: string, weekStart: string, eventVersion = NO_EVENT): string {
  return `plan:${opportunityId}:${reason}:${weekStart}:${eventVersion}`;
}

const NO_EVENT = "0";

/**
 * Version d'événement d'une action du Plan : ses SIGNAUX DURS canoniques
 * (`hardSignals`, `morning-plan-select.ts`) — le dernier message client
 * significatif (chaud ou attente) désigné par son identifiant Gmail, et la
 * visite / le RDV planifié désigné par sa date. Aucune date du jour : sans
 * nouvel événement, la version ne bouge pas. L'« événement contractuel » n'a
 * pas de source sur une affaire ouverte (voir `hardSignals`) : il n'y figure pas.
 */
export function planEventVersion(e: { lastInboundMessageId: string | null; nextVisitAt: string | null }): string {
  const tokens: string[] = [];
  if (e.lastInboundMessageId) tokens.push(`m-${e.lastInboundMessageId}`);
  if (e.nextVisitAt) tokens.push(`v-${e.nextVisitAt.slice(0, 10)}`);
  return tokens.length > 0 ? tokens.join("+") : NO_EVENT;
}

/**
 * Une clé du Plan découpée : l'action (affaire, motif, semaine) et l'ensemble
 * de ses événements. Deux versions de la même action se comparent par
 * INCLUSION : l'action reste traitée tant qu'aucun événement NOUVEAU n'est
 * apparu — la disparition d'un signal (visite annulée) n'en est pas un.
 */
export function planKeyParts(key: string): { action: string; events: Set<string> } | null {
  const m = /^(plan:[^:]+:[^:]+:[^:]+):(.+)$/.exec(key);
  if (!m) return null;
  return { action: m[1], events: new Set(m[2] === NO_EVENT ? [] : m[2].split("+")) };
}

/** `current` est-elle couverte par le traitement de `treated` (même action, aucun événement nouveau) ? */
export function planVersionCovered(current: string, treated: string): boolean {
  const c = planKeyParts(current);
  const t = planKeyParts(treated);
  if (!c || !t || c.action !== t.action) return false;
  return [...c.events].every((e) => t.events.has(e));
}

/**
 * La semaine de référence : la courante jusqu'au vendredi, la suivante dès le
 * samedi — exactement la semaine que montre « Ma semaine » (`weekBounds`).
 */
export function actionWeekStart(now: Date = new Date()): string {
  const monday = mondayOf(parisDate(now));
  if (parisWeekday(now) < WEEK_VIEW.switchToNextFromDay) return monday;
  const d = new Date(`${monday}T00:00:00`);
  d.setDate(d.getDate() + 7);
  return todayIso(d);
}

/** Les faits d'une opportunité qui fondent son anomalie de suivi. */
export type OpportunityActionFacts = {
  opportunityId: string;
  milestoneStatus: string;
  clientWaiting: boolean;
  /** Message « attente » canonique qui fonde l'attente client, quand il existe. */
  waitingMessageId: string | null;
  devisSentAt: string | null;
  devisRelanceAt: string | null;
  estimationSentAt: string | null;
  estimationRelanceAt: string | null;
  standbyUntil: string | null;
  lastHumanActionAt: string | null;
  nextExpectedDueAt: string | null;
};

/**
 * Action d'une ligne du Monitoring opportunités.
 *
 * « Répondre au client » EST l'action du Bloc 2 : même message, même clé. Les
 * autres anomalies sont versionnées par le fait Salesforce qui les fonde — une
 * nouvelle relance, une nouvelle échéance de stand-by ouvrent une nouvelle
 * action.
 */
export function opportunityActionKey(o: OpportunityActionFacts): string {
  if (o.clientWaiting && o.waitingMessageId) return mailActionKey(o.waitingMessageId, "attente");
  const id = o.opportunityId;
  switch (o.milestoneStatus) {
    case "sla_devis":
      return `opportunity:${id}:sla_devis:${o.devisRelanceAt ?? o.devisSentAt ?? ""}`;
    case "sla_estimation":
      return `opportunity:${id}:sla_estimation:${o.estimationRelanceAt ?? o.estimationSentAt ?? ""}`;
    case "standby_expire":
      return `opportunity:${id}:standby_expire:${o.standbyUntil ?? ""}`;
    case "dormant_candidate":
      return `opportunity:${id}:dormant:${o.lastHumanActionAt ?? ""}`;
    default:
      return `opportunity:${id}:${o.milestoneStatus}:${o.nextExpectedDueAt ?? o.lastHumanActionAt ?? ""}`;
  }
}

export type LeadActionFacts = {
  leadId: string;
  operationalStatus: string;
  firstCallMissed: boolean;
  firstCallAt: string | null;
  recallDate: string | null;
  consignedAt: string | null;
  anomalySince: string | null;
};

/**
 * Action d'une ligne du Monitoring pistes. Une échéance qui s'aggrave (à
 * traiter → en retard → critique) reste LA MÊME action ; une nouvelle date de
 * rappel en ouvre une nouvelle.
 */
export function leadActionKey(l: LeadActionFacts): string {
  const id = l.leadId;
  if (l.firstCallMissed) return `lead:${id}:first_call:${l.firstCallAt ?? ""}`;
  if (l.operationalStatus === "a_traiter" || l.operationalStatus === "en_retard" || l.operationalStatus === "critique") {
    return `lead:${id}:echeance:${l.recallDate ?? ""}`;
  }
  if (l.operationalStatus === "sans_rendez_vous") return `lead:${id}:sans_rdv:${l.consignedAt ?? l.anomalySince ?? ""}`;
  return `lead:${id}:${l.operationalStatus}:${l.anomalySince ?? ""}`;
}

export function actionSource(key: string): ActionSource | null {
  const head = key.slice(0, key.indexOf(":"));
  return (SOURCES as readonly string[]).includes(head) ? (head as ActionSource) : null;
}

/** L'identifiant Gmail d'une clé `mail:…`, sinon null. */
export function mailMessageId(key: string): string | null {
  if (!key.startsWith("mail:")) return null;
  const rest = key.slice("mail:".length);
  const end = rest.indexOf(":");
  return end > 0 ? rest.slice(0, end) : null;
}

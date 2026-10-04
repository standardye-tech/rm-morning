/**
 * KPI du Monitoring Opportunités — C2.
 *
 * Deux familles séparées, et c'est volontaire :
 *   — VALEUR : GMV à signer, à débloquer, à sauver, à réactiver. C'est la
 *     raison d'être de RM Morning ;
 *   — EXCEPTIONS : relances non faites, jalons dépassés, stand-by expirés.
 *     Utile, mais jamais prioritaire sur la valeur.
 *
 * Aucun score global. Chaque compteur est accompagné du volume, pour qu'un
 * écart pose une question plutôt qu'il ne condamne.
 */

import { OPPORTUNITY_MONITORING, THRESHOLDS } from "./config";
import { queryAll } from "./db";
import { canonicalClientAttend, type CanonicalClientAttend } from "./morning-events";
import {
  fmt,
  MILESTONE_ANOMALIES,
  resolveMilestoneVerdict,
  type MilestoneStatus,
  type NextExpectedEvent,
} from "./opportunity-milestones";
import { loadTeam } from "./team-store";

const HOUR = 36e5;

/**
 * Mêmes seuils que ceux appliqués à l'import (`opportunity-import.ts::
 * MILESTONE_THRESHOLDS`), pour la même hiérarchie de jalons — mais lus ici
 * directement depuis la config, pour ne pas faire dépendre le chemin de
 * LECTURE du module d'IMPORT.
 */
const RESOLVE_THRESHOLDS = {
  devisSlaDays: OPPORTUNITY_MONITORING.devisSlaDays,
  estimationSlaDays: OPPORTUNITY_MONITORING.estimationSlaDays,
  dormantAfterDays: OPPORTUNITY_MONITORING.dormantAfterDays,
};

/**
 * Statuts qui priment sur une attente d'origine e-mail — exactement l'ordre de
 * `evaluateOpportunity` (C2) : stand-by, jalon futur connu et SLA de relance
 * restent des faits Salesforce prioritaires. « client_attend » d'origine
 * e-mail ne remplace qu'un statut « dormant_candidate » ou « normal », comme
 * le faisait l'ancienne règle de délai qu'il remplace — jamais un SLA ou un
 * stand-by en cours.
 */
const OUTRANKS_CLIENT_ATTEND: MilestoneStatus[] = [
  "standby",
  "standby_expire",
  "a_venir",
  "sla_devis",
  "sla_estimation",
];

export type MilestoneOpportunity = {
  opportunityId: string;
  name: string | null;
  client: string | null;
  owner: string;
  gmv: number | null;
  stage: string | null;
  /**
   * Mois de signature annoncé par le commercial (Projection Kanban), en
   * « AAAA-MM ». C'est l'équivalent local d'une Close Date : le seul champ qui
   * dise QUAND le commercial pense signer.
   */
  plannedMonth: string | null;
  standbyUntil: string | null;
  estimationSentAt: string | null;
  estimationRelanceAt: string | null;
  devisSentAt: string | null;
  devisRelanceAt: string | null;
  nextVisitAt: string | null;
  visitKind: string | null;
  /** Dernière relance client valide constatée à l'import — jamais affichée telle quelle. */
  lastHumanActionAt: string | null;
  nextExpectedEvent: NextExpectedEvent;
  nextExpectedDueAt: string | null;
  milestoneStatus: MilestoneStatus;
  milestoneReason: string | null;
  latenessHours: number;
  clientWaiting: boolean;
  /**
   * Message « attente » canonique de l'affaire (`canonicalClientAttend`), quand
   * il existe : il fonde l'action « Répondre au client », partagée avec le
   * Bloc 2. Projection à la lecture, jamais écrite en base.
   */
  waitingMessageId: string | null;
  isLegacy: boolean;
};

/**
 * Superpose la vérité canonique du Morning sur une opportunité déjà chargée.
 *
 * `evaluateOpportunity` (C2) ne décide plus jamais de `client_attend` : c'est
 * fait ICI, en lecture, à partir de `canonicalClientAttend()`. Résultat :
 * l'état suit le fil en temps réel, sans attendre le prochain import des
 * jalons Salesforce — une réponse RM tout juste synchronisée fait disparaître
 * l'attente au prochain affichage, pas au prochain « Actualiser » Salesforce.
 *
 * Rien n'est réécrit en base : c'est une projection à la lecture, exactement
 * comme le fingerprint de `monitoring-read`. Un statut qui prime déjà
 * (stand-by, jalon futur, SLA en cours) n'est jamais recouvert.
 *
 * DEUX DIRECTIONS, symétriques :
 *   — la vérité canonique dit « oui » et rien ne prime déjà → on AJOUTE
 *     `client_attend` ;
 *   — la base retient encore un `client_attend` hérité de l'ANCIENNE règle
 *     (par délai, avant C) mais la vérité canonique dit « non » → on ne le
 *     laisse JAMAIS traîner jusqu'au prochain import. On rejoue
 *     `resolveMilestoneVerdict` — la même hiérarchie que celle qui aurait
 *     tourné à l'import, à partir des mêmes faits déjà persistés (SLA,
 *     stand-by, dormant…) — pour retrouver le statut Salesforce pur exact,
 *     jamais un repli optimiste sur « normal » qui masquerait une anomalie.
 */
function withCanonicalClientAttend(
  o: MilestoneOpportunity,
  canonical: Map<string, CanonicalClientAttend>,
  now: number,
): MilestoneOpportunity {
  const attente = canonical.get(o.opportunityId);

  if (attente && !OUTRANKS_CLIENT_ATTEND.includes(o.milestoneStatus)) {
    return {
      ...o,
      waitingMessageId: attente.messageId,
      milestoneStatus: "client_attend",
      milestoneReason: `dernier message client le ${fmt(attente.sentAt)}, sans réponse constatée`,
      clientWaiting: true,
      latenessHours: attente.sentAt ? Math.round((now - new Date(attente.sentAt).getTime()) / HOUR) : o.latenessHours,
    };
  }

  if (!attente && o.milestoneStatus === "client_attend") {
    const verdict = resolveMilestoneVerdict(
      {
        standbyUntil: o.standbyUntil,
        nextVisitAt: o.nextVisitAt,
        visitKind: o.visitKind,
        devisSentAt: o.devisSentAt,
        devisRelanceAt: o.devisRelanceAt,
        estimationSentAt: o.estimationSentAt,
        estimationRelanceAt: o.estimationRelanceAt,
        lastHumanActionAt: o.lastHumanActionAt,
        nextExpectedDueAt: o.nextExpectedDueAt,
      },
      RESOLVE_THRESHOLDS,
      now,
    );
    return {
      ...o,
      milestoneStatus: verdict.milestoneStatus,
      milestoneReason: verdict.milestoneReason,
      latenessHours: verdict.latenessHours,
      clientWaiting: false,
    };
  }

  return attente ? { ...o, waitingMessageId: attente.messageId } : o;
}

export function loadMilestoneOpportunities(): MilestoneOpportunity[] {
  const canonical = canonicalClientAttend();
  const now = Date.now();
  return queryAll<Record<string, string | number | null>>(
    `SELECT opportunity_id, name, client_contact, owner, gmv, stage, standby_until,
            kanban_month, kanban_year,
            estimation_sent_at, estimation_relance_at, devis_sent_at, devis_relance_at,
            next_visit_at, visit_kind, last_human_action_at, next_expected_event, next_expected_due_at,
            milestone_status, milestone_reason, milestone_lateness_hours,
            client_waiting, milestone_is_legacy
       FROM opportunity
      WHERE is_terminal = 0 AND milestone_status IS NOT NULL`,
  )
    .map(
      (r): MilestoneOpportunity => ({
        opportunityId: String(r.opportunity_id),
        name: r.name as string | null,
        client: (r.client_contact as string | null) ?? (r.name as string | null),
        owner: String(r.owner),
        gmv: r.gmv as number | null,
        stage: r.stage as string | null,
        plannedMonth:
          r.kanban_year && r.kanban_month
            ? `${r.kanban_year}-${String(r.kanban_month).padStart(2, "0")}`
            : null,
        standbyUntil: r.standby_until as string | null,
        estimationSentAt: r.estimation_sent_at as string | null,
        estimationRelanceAt: r.estimation_relance_at as string | null,
        devisSentAt: r.devis_sent_at as string | null,
        devisRelanceAt: r.devis_relance_at as string | null,
        nextVisitAt: r.next_visit_at as string | null,
        visitKind: r.visit_kind as string | null,
        lastHumanActionAt: r.last_human_action_at as string | null,
        nextExpectedEvent: r.next_expected_event as NextExpectedEvent,
        nextExpectedDueAt: r.next_expected_due_at as string | null,
        milestoneStatus: String(r.milestone_status) as MilestoneStatus,
        milestoneReason: r.milestone_reason as string | null,
        latenessHours: Number(r.milestone_lateness_hours ?? 0),
        clientWaiting: Number(r.client_waiting) === 1,
        waitingMessageId: null,
        isLegacy: Number(r.milestone_is_legacy) === 1,
      }),
    )
    .map((o) => withCanonicalClientAttend(o, canonical, now));
}

const sum = (list: MilestoneOpportunity[]) => list.reduce((s, o) => s + (o.gmv ?? 0), 0);
const isAnomaly = (s: MilestoneStatus) => MILESTONE_ANOMALIES.includes(s);

export type OwnerOpportunityMetrics = {
  owner: string;
  firstName: string;
  active: number;
  gmv: number;
  estimationWithoutRelance: number;
  devisWithoutRelance: number;
  milestonesOverdue: number;
  clientWaiting: number;
  dormantCandidates: number;
  anomalyGmv: number;
  newExceptions: number;
  legacyBacklog: number;
  state: "sain" | "à surveiller" | "action requise";
  stateReason: string;
};

export type TeamOpportunityMetrics = {
  active: number;
  activeGmv: number;
  standbyGmv: number;
  newExceptionGmv: number;
  dormantGmv: number;
  unlockableGmv: number;
  newExceptions: number;
  legacyBacklog: number;
  owners: OwnerOpportunityMetrics[];
};

/**
 * GMV potentiellement débloquable : opportunités où une action concrète est
 * identifiée et où le montant justifie qu'on s'en occupe aujourd'hui.
 */
function isUnlockable(o: MilestoneOpportunity): boolean {
  if (o.milestoneStatus === "standby") return false;
  return (
    o.clientWaiting ||
    o.milestoneStatus === "sla_estimation" ||
    o.milestoneStatus === "sla_devis" ||
    o.milestoneStatus === "standby_expire"
  );
}

export function computeOpportunityMetrics(
  opportunities: MilestoneOpportunity[],
): TeamOpportunityMetrics {
  // Le périmètre est celui de la table `team_member`, pas de la graine TEAM de
  // config.ts : un commercial ajouté depuis l'écran Données doit recevoir son
  // verdict, et un commercial retiré ne doit plus en avoir. Même source que
  // l'import, la Performance et le Forecast.
  const owners: OwnerOpportunityMetrics[] = loadTeam().map((member) => {
    const mine = opportunities.filter((o) => o.owner === member.name);
    const anomalies = mine.filter((o) => isAnomaly(o.milestoneStatus));
    const fresh = anomalies.filter((o) => !o.isLegacy);

    const base = {
      owner: member.name,
      firstName: member.firstName,
      active: mine.length,
      gmv: sum(mine),
      estimationWithoutRelance: mine.filter((o) => o.milestoneStatus === "sla_estimation").length,
      devisWithoutRelance: mine.filter((o) => o.milestoneStatus === "sla_devis").length,
      milestonesOverdue: mine.filter(
        (o) => o.milestoneStatus === "sla_estimation" || o.milestoneStatus === "sla_devis" || o.milestoneStatus === "standby_expire",
      ).length,
      clientWaiting: mine.filter((o) => o.clientWaiting).length,
      dormantCandidates: mine.filter((o) => o.milestoneStatus === "dormant_candidate").length,
      anomalyGmv: sum(anomalies),
      newExceptions: fresh.length,
      legacyBacklog: anomalies.length - fresh.length,
    };

    // Verdict fondé sur les seules exceptions observées, ramenées au volume.
    const ratio = base.active > 0 ? base.newExceptions / base.active : 0;
    const state: OwnerOpportunityMetrics["state"] =
      base.newExceptions >= 3 && ratio > 0.15
        ? "action requise"
        : base.newExceptions >= 1
          ? "à surveiller"
          : "sain";
    const stateReason =
      base.newExceptions > 0
        ? `${base.newExceptions} exception(s) nouvelle(s) sur ${base.active} opportunités`
        : "jalons tenus depuis l'activation";

    return { ...base, state, stateReason };
  });

  const anomalies = opportunities.filter((o) => isAnomaly(o.milestoneStatus));
  return {
    active: opportunities.length,
    activeGmv: sum(opportunities),
    standbyGmv: sum(opportunities.filter((o) => o.milestoneStatus === "standby")),
    newExceptionGmv: sum(anomalies.filter((o) => !o.isLegacy)),
    dormantGmv: sum(opportunities.filter((o) => o.milestoneStatus === "dormant_candidate")),
    unlockableGmv: sum(opportunities.filter(isUnlockable)),
    newExceptions: anomalies.filter((o) => !o.isLegacy).length,
    legacyBacklog: anomalies.filter((o) => o.isLegacy).length,
    owners,
  };
}

export type ValueItem = {
  opportunity: MilestoneOpportunity;
  score: number;
  action: string;
};

/**
 * Bloc « À débloquer maintenant » — le cœur utile de C2.
 *
 * Trié sur impact GMV × urgence × actionnabilité, pas sur l'ancienneté. Une
 * petite anomalie administrative n'y entre jamais devant une grosse affaire
 * sur laquelle un geste concret est possible.
 */
export function buildValueBlock(
  opportunities: MilestoneOpportunity[],
  limit: number = OPPORTUNITY_MONITORING.maxValueItems,
): ValueItem[] {
  const items: ValueItem[] = [];

  for (const o of opportunities) {
    if (o.milestoneStatus === "standby" || o.milestoneStatus === "normal" || o.milestoneStatus === "a_venir") {
      continue;
    }

    // Actionnabilité : ce que le commercial peut faire aujourd'hui.
    let action: string | null = null;
    let urgency = 1;
    if (o.clientWaiting) {
      action = "Répondre au client, qui attend";
      urgency = 3;
    } else if (o.milestoneStatus === "sla_devis") {
      action = "Relancer sur le devis envoyé";
      urgency = 2.5;
    } else if (o.milestoneStatus === "sla_estimation") {
      action = "Relancer sur l'estimation envoyée";
      urgency = 2.5;
    } else if (o.milestoneStatus === "standby_expire") {
      action = "Reprendre le dossier, stand-by expiré";
      urgency = 2;
    } else if (o.milestoneStatus === "dormant_candidate") {
      action = "Reprendre contact, aucun jalon prévu";
      urgency = o.isLegacy ? 0.6 : 1.2;
    }
    if (!action) continue;

    // Plancher : une très petite affaire ne consomme pas une des priorités.
    const gmv = o.gmv ?? 0;
    if (gmv < OPPORTUNITY_MONITORING.minValueGmv) continue;

    // Impact : le montant compte, de façon progressive, bornée à [0, 1].
    const impact = Math.max(0, Math.min(1, Math.log10(gmv / 1000) / 3));
    // Une affaire fraîchement en retard est plus récupérable qu'un dossier
    // abandonné depuis six mois : l'urgence décroît avec l'ancienneté extrême.
    const staleness = o.latenessHours > 24 * 180 ? 0.5 : 1;

    items.push({ opportunity: o, score: urgency * (0.4 + impact) * staleness, action });
  }

  return items.sort((a, b) => b.score - a.score || (b.opportunity.gmv ?? 0) - (a.opportunity.gmv ?? 0)).slice(0, limit);
}

/** Exceptions de suivi, séparées de la valeur et volontairement secondaires. */
export function buildExceptionList(
  opportunities: MilestoneOpportunity[],
  limit = 10,
): MilestoneOpportunity[] {
  return opportunities
    .filter((o) => isAnomaly(o.milestoneStatus))
    .sort((a, b) => {
      if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
      return (b.gmv ?? 0) - (a.gmv ?? 0);
    })
    .slice(0, limit);
}

/** Dossiers anciens à fort GMV : de la valeur potentiellement récupérable. */
export function reactivableDeals(
  opportunities: MilestoneOpportunity[],
  limit = 5,
): MilestoneOpportunity[] {
  return opportunities
    .filter((o) => o.milestoneStatus === "dormant_candidate" && (o.gmv ?? 0) >= THRESHOLDS.bigDealGmv)
    .sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0))
    .slice(0, limit);
}

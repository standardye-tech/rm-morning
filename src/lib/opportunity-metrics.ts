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

import { OPPORTUNITY_MONITORING, TEAM, THRESHOLDS } from "./config";
import { queryAll } from "./db";
import {
  MILESTONE_ANOMALIES,
  type MilestoneStatus,
  type NextExpectedEvent,
} from "./opportunity-milestones";

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
  nextExpectedEvent: NextExpectedEvent;
  nextExpectedDueAt: string | null;
  milestoneStatus: MilestoneStatus;
  milestoneReason: string | null;
  latenessHours: number;
  clientWaiting: boolean;
  isLegacy: boolean;
};

export function loadMilestoneOpportunities(): MilestoneOpportunity[] {
  return queryAll<Record<string, string | number | null>>(
    `SELECT opportunity_id, name, client_contact, owner, gmv, stage, standby_until,
            kanban_month, kanban_year,
            estimation_sent_at, estimation_relance_at, devis_sent_at, devis_relance_at,
            next_visit_at, visit_kind, next_expected_event, next_expected_due_at,
            milestone_status, milestone_reason, milestone_lateness_hours,
            client_waiting, milestone_is_legacy
       FROM opportunity
      WHERE is_terminal = 0 AND milestone_status IS NOT NULL`,
  ).map((r) => ({
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
    nextExpectedEvent: r.next_expected_event as NextExpectedEvent,
    nextExpectedDueAt: r.next_expected_due_at as string | null,
    milestoneStatus: String(r.milestone_status) as MilestoneStatus,
    milestoneReason: r.milestone_reason as string | null,
    latenessHours: Number(r.milestone_lateness_hours ?? 0),
    clientWaiting: Number(r.client_waiting) === 1,
    isLegacy: Number(r.milestone_is_legacy) === 1,
  }));
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
  const owners: OwnerOpportunityMetrics[] = TEAM.map((member) => {
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

    // Impact : le montant compte, de façon progressive et plafonnée.
    const gmv = o.gmv ?? 0;
    const impact = gmv > 0 ? Math.min(1, Math.log10(gmv / 1000) / 3) : 0;
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

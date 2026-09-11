/**
 * Gros dossiers — « Ma semaine ».
 *
 * Les affaires importantes où le directeur régional intervient pour accélérer,
 * débloquer, closer ou arbitrer. PUR : les candidats sont assemblés par
 * `week.ts` à partir des opportunités, du scoring Expected et des jalons ; ce
 * module retient, qualifie et classe.
 *
 * Distinct de l'affaire de la semaine, qui est un support de management et
 * n'a aucune condition de montant.
 */

import { BIG_DEALS } from "./config";
import { MILESTONE_ANOMALIES, MILESTONE_LABEL, type MilestoneStatus } from "./opportunity-milestones";
import type { Recommendation } from "./attention";
import { kEur, pct } from "./vocabulary";

export type BigDealObjective = "closer" | "debloquer" | "accelerer" | "arbitrer";

export const OBJECTIVE_LABEL: Record<BigDealObjective, string> = {
  closer: "Closer",
  debloquer: "Débloquer",
  accelerer: "Accélérer",
  arbitrer: "Arbitrer",
};

export type BigDealCandidate = {
  opportunityId: string;
  client: string;
  owner: string;
  firstName: string;
  gmv: number;
  stage: string | null;
  stageRank: number;
  /** Mois de la Projection Kanban, « AAAA-MM », ou null. */
  kanbanMonth: string | null;
  /** Probabilité Expected de signer avant la fin du mois, ou null si non scorée. */
  pMonthEnd: number | null;
  milestoneStatus: MilestoneStatus | null;
  clientWaiting: boolean;
  daysSinceActivity: number | null;
};

export type BigDeal = BigDealCandidate & {
  objective: BigDealObjective;
  /** Urgent : à closer, à débloquer, ou déclaré sur le mois courant. */
  urgent: boolean;
  /** « Examen devis · signature déclarée ce mois · 62 % de chances ce mois ». */
  reason: string;
  recommendation: Recommendation;
};

const RECOMMENDATION: Record<BigDealObjective, Omit<Recommendation, "minutes">> = {
  closer: {
    action: "Fixer la date de signature",
    lookWhere: "Salesforce, l'opportunité et son devis",
    lookFor: "Ce qui retient encore le client",
    obtain: "Une date de signature confirmée avec le client",
  },
  debloquer: {
    action: "Lever le blocage",
    lookWhere: "Monitoring, l'exception de l'affaire",
    lookFor: "L'action en retard et qui la porte",
    obtain: "Le blocage levé ou une décision prise",
  },
  accelerer: {
    action: "Raccourcir le délai",
    lookWhere: "Salesforce, prochain jalon de l'affaire",
    lookFor: "La prochaine étape et sa date",
    obtain: "Un prochain jalon daté cette semaine",
  },
  arbitrer: {
    action: "Décider du sort de l'affaire",
    lookWhere: "Salesforce, historique d'activité",
    lookFor: "Si le client est encore là",
    obtain: "Poursuivre, mettre en stand-by ou abandonner",
  },
};

const BLOCKED: MilestoneStatus[] = ["client_attend", "sla_estimation", "sla_devis", "standby_expire"];

function isAnomaly(status: MilestoneStatus | null): boolean {
  return status != null && MILESTONE_ANOMALIES.includes(status);
}

function isBlocked(c: BigDealCandidate): boolean {
  return c.clientWaiting || (c.milestoneStatus != null && BLOCKED.includes(c.milestoneStatus));
}

/** Le dossier mérite-t-il le bloc ? Montant d'abord, puis au moins un critère de maturité. */
export function qualifies(c: BigDealCandidate, currentMonth: string, rules = BIG_DEALS): boolean {
  if (c.gmv < rules.minGmv) return false;
  return (
    c.stageRank >= rules.advancedRank ||
    (c.pMonthEnd != null && c.pMonthEnd >= rules.minProbability) ||
    isAnomaly(c.milestoneStatus) ||
    c.kanbanMonth === currentMonth
  );
}

export function objectiveOf(c: BigDealCandidate, rules = BIG_DEALS): BigDealObjective {
  if (isBlocked(c)) return "debloquer";
  if (c.stageRank >= rules.signatureRank || (c.pMonthEnd != null && c.pMonthEnd >= rules.closingProbability)) {
    return "closer";
  }
  if (c.milestoneStatus === "dormant_candidate") return "arbitrer";
  return "accelerer";
}

function reasonOf(c: BigDealCandidate, currentMonth: string, rules = BIG_DEALS): string {
  const parts: string[] = [];
  if (c.stage) parts.push(c.stage);
  if (c.kanbanMonth === currentMonth) parts.push("signature déclarée ce mois");
  if (c.pMonthEnd != null && c.pMonthEnd >= rules.showProbabilityFrom) {
    parts.push(`${pct(c.pMonthEnd, 0)} de chances de signer avant la fin du mois`);
  }
  if (c.clientWaiting) parts.push("client en attente de réponse");
  else if (isAnomaly(c.milestoneStatus) && c.milestoneStatus) parts.push(MILESTONE_LABEL[c.milestoneStatus].toLowerCase());
  if (c.milestoneStatus === "dormant_candidate" && c.daysSinceActivity != null) {
    parts.push(`sans activité depuis ${c.daysSinceActivity} jours`);
  }
  return parts.join(" · ");
}

/** Retient, qualifie et classe : urgents d'abord, puis par montant. Plafonné. */
export function detectBigDeals(
  candidates: BigDealCandidate[],
  currentMonth: string,
  rules = BIG_DEALS,
): BigDeal[] {
  return candidates
    .filter((c) => qualifies(c, currentMonth, rules))
    .map((c): BigDeal => {
      const objective = objectiveOf(c, rules);
      const urgent = objective === "closer" || objective === "debloquer" || c.kanbanMonth === currentMonth;
      return {
        ...c,
        objective,
        urgent,
        reason: reasonOf(c, currentMonth, rules),
        recommendation: { minutes: rules.minutes, ...RECOMMENDATION[objective] },
      };
    })
    .sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return b.gmv - a.gmv;
    })
    .slice(0, rules.maxItems);
}

export function bigDealTitle(deal: BigDeal): string {
  return `${deal.client} – ${kEur(deal.gmv)}`;
}

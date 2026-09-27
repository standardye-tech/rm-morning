/**
 * « Ma semaine » — composition.
 *
 * Répond à une seule question : cette semaine, où le directeur régional
 * doit-il investir son temps pour avoir le plus d'impact ? Ce module ne
 * calcule AUCUNE métrique nouvelle : il lit les calculs existants —
 * Performance, Forecast V2, Monitoring, métriques de pipe, snapshots — et les
 * confie aux moteurs purs (`attention.ts`, `big-deals.ts`, `week-plan.ts`).
 *
 * Tout est recalculé à chaque affichage, comme la Performance : les données
 * bougent à chaque actualisation et les verdicts doivent les suivre. Rien
 * n'est historisé en V1.
 */

import {
  assessAttention,
  sortVerdicts,
  type AttentionInput,
  type AttentionVerdict,
  type Recommendation,
} from "./attention";
import { actionWeekStart } from "./action-keys";
import { bigDealTitle, detectBigDeals, type BigDeal, type BigDealCandidate } from "./big-deals";
import { ATTENTION, BIG_DEALS, DEAL_OF_WEEK_ANGLES, RADAR, WEEK_SLOTS } from "./config";
import {
  recommend,
  type RecommendationCandidate,
  type RecommendationSet,
} from "./deal-of-week-recommend";
import {
  currentDealOfWeek,
  isWeekIgnored,
  recentDealOfWeekHistory,
  type DealOfWeekRecord,
} from "./deal-of-week-store";
import { buildForecastV2 } from "./forecast-v2";
import { computeMetrics, daysSinceActivity } from "./metrics";
import { computeOpportunityMetrics, loadMilestoneOpportunities } from "./opportunity-metrics";
import { parisDate } from "./business-time";
import { daysBetween, stageRank, todayIso } from "./normalize";
import { buildPerformanceBoard } from "./performance";
import { listRadarContacts, radarInterviews, radarToProcess, type RadarContact } from "./radar-store";
import { latestImport, loadOpportunities } from "./repository";
import { earliestSnapshotDate, loadStageStability } from "./stage-history";
import { stagnantDeals } from "./stagnation";
import { lastCompleteRun } from "./sync/store";
import { loadTeam } from "./team-store";
import type { Opportunity } from "./types";
import { orderActions, planWeek, type PlannedSlot, type WeekItem } from "./week-plan";
import { clientLabel, kEur } from "./vocabulary";

export type WeekSummary = {
  red: number;
  orange: number;
  bigDeals: number;
  dealOfWeek: 0 | 1;
  candidatures: number;
};

/** Une affaire proposable comme affaire de la semaine. */
export type DealCandidate = {
  opportunityId: string;
  owner: string;
  firstName: string;
  client: string;
  gmv: number | null;
  stage: string | null;
};

export type DealOfWeekView = {
  record: DealOfWeekRecord;
  client: string;
  firstName: string;
  gmv: number | null;
  stage: string | null;
  /** L'affaire n'est plus active dans Salesforce : signée, perdue ou en stand-by. */
  inactiveReason: string | null;
  /** Angle de challenge choisi, son libellé et l'objectif du point qui en découle. */
  angle: string;
  angleLabel: string;
  objective: string;
  recommendation: Recommendation;
};

export type WeekView = {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  dataAt: string | null;
  summary: WeekSummary;
  verdicts: AttentionVerdict[];
  bigDeals: BigDeal[];
  dealOfWeek: DealOfWeekView | null;
  /** Recommandation de la semaine, quand aucune affaire n'est en cours et que la semaine n'est pas ignorée. */
  recommendation: RecommendationSet | null;
  ignoredThisWeek: boolean;
  candidates: DealCandidate[];
  radar: { all: RadarContact[]; toProcess: RadarContact[]; interviews: RadarContact[] };
  actions: WeekItem[];
  planning: PlannedSlot[];
  /** Limites de lecture, dites plutôt que tues. */
  notes: string[];
};

/** L'angle choisi, ou « Autre » pour les choix antérieurs à l'angle. */
function angleOf(key: string | null) {
  return DEAL_OF_WEEK_ANGLES.find((a) => a.key === key) ?? DEAL_OF_WEEK_ANGLES[DEAL_OF_WEEK_ANGLES.length - 1];
}

/** Le point sur l'affaire de la semaine : l'angle dicte l'action et l'objectif. */
function dealOfWeekRecommendation(angleKey: string | null): Recommendation {
  const angle = angleOf(angleKey);
  return {
    minutes: 30,
    action: `Challenger : ${angle.label.toLowerCase()}`,
    lookWhere: "Salesforce, l'affaire et son historique",
    lookFor: "Ce que l'ET a fait, prévu et obtenu sur cet angle",
    obtain: angle.objective,
  };
}

const DAY_MONTH = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
const DAY_ONLY = new Intl.DateTimeFormat("fr-FR", { day: "numeric" });

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

/** Semaine affichée : la courante jusqu'au vendredi, la suivante dès le samedi. */
export function weekBounds(now: Date): { weekStart: string; weekEnd: string; weekLabel: string } {
  // Même semaine que celle des ActionKeys du Plan : les deux ne peuvent diverger.
  const weekStart = actionWeekStart(now);
  const weekEnd = addDays(weekStart, 4);
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(`${weekEnd}T00:00:00`);
  const sameMonth = start.getMonth() === end.getMonth();
  const weekLabel = sameMonth
    ? `Semaine du ${DAY_ONLY.format(start)} au ${DAY_MONTH.format(end)}`
    : `Semaine du ${DAY_MONTH.format(start)} au ${DAY_MONTH.format(end)}`;
  return { weekStart, weekEnd, weekLabel };
}

const clientOf = (o: Opportunity) => clientLabel(o.clientContact, o.name);
const kanbanKey = (o: Opportunity) =>
  o.kanbanYear && o.kanbanMonth ? `${o.kanbanYear}-${String(o.kanbanMonth).padStart(2, "0")}` : null;

export function buildWeek(now = new Date()): WeekView {
  const today = parisDate(now);
  const currentMonth = today.slice(0, 7);
  const { weekStart, weekEnd, weekLabel } = weekBounds(now);
  const notes: string[] = [];

  // --- Sources, lues une fois ------------------------------------------------
  const team = loadTeam();
  const excluded = new Set<string>(ATTENTION.excluded);
  const opportunities = loadOpportunities();
  const active = opportunities.filter((o) => o.isActive);
  const pipe = computeMetrics(opportunities, today);
  const pipeByOwner = new Map(pipe.owners.map((o) => [o.owner, o]));

  const milestones = loadMilestoneOpportunities();
  const milestoneById = new Map(milestones.map((m) => [m.opportunityId, m]));
  const monitoringByOwner = new Map(computeOpportunityMetrics(milestones).owners.map((o) => [o.owner, o]));

  const performance = buildPerformanceBoard(now);
  const scoreByOwner = new Map(performance.salespeople.map((s) => [s.salesperson, s.score]));

  const forecast = buildForecastV2(0);
  const forecastByOwner = new Map(forecast.salespeople.map((s) => [s.salesperson, s]));
  const expectedById = new Map(
    forecast.expectedAvailable && forecast.expected
      ? forecast.expected.opportunities.map((o) => [o.opportunityId, o])
      : [],
  );
  if (!forecast.expectedAvailable) {
    notes.push(
      `Expected du mois indisponible (${forecast.expectedUnavailableReason ?? "raison inconnue"}) : la règle « Forecast en retard » est neutralisée.`,
    );
  }

  const stability = loadStageStability(today);
  const earliest = earliestSnapshotDate();
  if (earliest) {
    const depth = daysBetween(earliest, today);
    notes.push(
      `Les changements d'étape ne sont observables que depuis le ${new Date(`${earliest}T00:00:00`).toLocaleDateString("fr-FR")} (${depth} jours) : une immobilité est toujours dite « depuis au moins ».`,
    );
  }

  // --- Attention par Expert Travaux -----------------------------------------
  const inputs: AttentionInput[] = team
    .filter((m) => !excluded.has(m.name))
    .map((member) => {
      const mine = active.filter((o) => o.owner === member.name);
      const pipeRow = pipeByOwner.get(member.name);
      const monitoring = monitoringByOwner.get(member.name);
      const fc = forecastByOwner.get(member.name);

      // Règle « figée » partagée avec le Plan du jour (`stagnation.ts`).
      const stagnantList = stagnantDeals(mine, stability, today);
      const nearList = mine.filter(
        (o) => (o.gmv ?? 0) >= BIG_DEALS.minGmv && stageRank(o.stage) >= ATTENTION.nearSignatureRank,
      );

      return {
        salesperson: member.name,
        firstName: member.firstName,
        performanceScore: scoreByOwner.get(member.name) ?? null,
        activeCount: mine.length,
        activeGmv: pipeRow?.activeGmv ?? 0,
        staleCount: pipeRow?.staleCount ?? 0,
        withoutProjectionCount: pipeRow?.withoutProjectionCount ?? 0,
        monitoringState: monitoring?.state ?? null,
        newExceptions: monitoring?.newExceptions ?? 0,
        clientWaiting: monitoring?.clientWaiting ?? 0,
        divergence: forecast.expectedAvailable && fc ? fc.divergence.level : null,
        expectedRemaining: fc?.expectedGmv ?? 0,
        kanbanRemaining: fc?.kanbanGmv ?? 0,
        stagnant: {
          count: stagnantList.length,
          minProvenDays: stagnantList.length
            ? Math.min(...stagnantList.map((o) => stability.get(o.opportunityId)!.provenDays))
            : 0,
          examples: stagnantList.slice(0, 3).map(clientOf),
        },
        nearSignature: {
          count: nearList.length,
          gmv: nearList.reduce((s, o) => s + (o.gmv ?? 0), 0),
          examples: nearList.slice(0, 3).map(clientOf),
        },
      };
    });

  const verdicts = sortVerdicts(inputs.map((i) => assessAttention(i)));
  const firstNameOf = new Map(team.map((m) => [m.name, m.firstName]));

  // --- Gros dossiers (toute l'équipe, directeur compris) ---------------------
  const candidates: BigDealCandidate[] = active
    .filter((o) => (o.gmv ?? 0) >= BIG_DEALS.minGmv)
    .map((o) => {
      const m = milestoneById.get(o.opportunityId);
      return {
        opportunityId: o.opportunityId,
        client: clientOf(o),
        owner: o.owner,
        firstName: firstNameOf.get(o.owner) ?? o.owner,
        gmv: o.gmv ?? 0,
        stage: o.stage,
        stageRank: stageRank(o.stage),
        kanbanMonth: kanbanKey(o),
        pMonthEnd: expectedById.get(o.opportunityId)?.pMonthEnd ?? null,
        milestoneStatus: m?.milestoneStatus ?? null,
        clientWaiting: m?.clientWaiting ?? false,
        daysSinceActivity: daysSinceActivity(o, today),
      };
    });
  const bigDeals = detectBigDeals(candidates, currentMonth);

  // --- Affaire de la semaine --------------------------------------------------
  const record = currentDealOfWeek();
  let dealOfWeek: DealOfWeekView | null = null;
  if (record) {
    const o = opportunities.find((x) => x.opportunityId === record.opportunityId) ?? null;
    dealOfWeek = {
      record,
      client: o ? clientOf(o) : "Affaire absente de la base",
      firstName: firstNameOf.get(record.salesperson) ?? record.salesperson,
      gmv: o?.gmv ?? null,
      stage: o?.stage ?? null,
      inactiveReason: !o
        ? "Affaire absente du dernier import Salesforce."
        : o.isSigned
          ? "Affaire signée : à clore ici."
          : o.isTerminal
            ? "Affaire terminée dans Salesforce : à clore ici."
            : o.isStandby
              ? `Affaire en stand-by jusqu'au ${o.standbyUntil ?? "?"}.`
              : null,
      angle: angleOf(record.angle).key,
      angleLabel: angleOf(record.angle).label,
      objective: angleOf(record.angle).objective,
      recommendation: dealOfWeekRecommendation(record.angle),
    };
  }

  // --- Affaire recommandée -----------------------------------------------------
  // « RM Morning propose, Sami arbitre » : proposée seulement s'il n'y a pas
  // d'affaire en cours et si la semaine n'a pas été ignorée. Les entrées sont
  // des données déjà calculées ; le moteur pur note et explique.
  const ignoredThisWeek = isWeekIgnored(weekStart);
  const bigDealIds = new Set(bigDeals.map((d) => d.opportunityId));
  const verdictByOwner = new Map(verdicts.map((v) => [v.salesperson, v]));
  const eligibleOwners = new Set(team.filter((m) => !excluded.has(m.name)).map((m) => m.name));
  const recoCandidates: RecommendationCandidate[] = active.map((o) => {
    const m = milestoneById.get(o.opportunityId);
    const s = stability.get(o.opportunityId);
    return {
      opportunityId: o.opportunityId,
      owner: o.owner,
      firstName: firstNameOf.get(o.owner) ?? o.owner,
      client: clientOf(o),
      gmv: o.gmv,
      stage: o.stage,
      createdAt: o.createdAt,
      lastActivityAt: o.lastActivityAt,
      isActive: o.isActive,
      milestone: m
        ? {
            status: m.milestoneStatus,
            nextExpectedEvent: m.nextExpectedEvent,
            nextExpectedDueAt: m.nextExpectedDueAt,
            estimationSentAt: m.estimationSentAt,
            devisSentAt: m.devisSentAt,
            nextVisitAt: m.nextVisitAt,
            clientWaiting: m.clientWaiting,
          }
        : null,
      stageChangedRecently: !!s && s.changeObserved && s.provenDays <= 14,
      attention: verdictByOwner.get(o.owner)?.attention.level ?? null,
      ownerEligible: eligibleOwners.has(o.owner),
      // Au-delà du seuil gros dossier, jamais une affaire de la semaine : même
      // hors des huit affichés, ce n'est pas un support de méthode.
      isBigDeal: bigDealIds.has(o.opportunityId) || (o.gmv ?? 0) >= BIG_DEALS.minGmv,
      isCurrent: record?.opportunityId === o.opportunityId,
    };
  });
  const historyStart = addDays(weekStart, -7 * 4);
  const history = recentDealOfWeekHistory(historyStart).map((h) => ({
    opportunityId: h.opportunityId,
    salesperson: h.salesperson,
    weekStart: h.weekStart,
    status: h.status,
  }));
  const recommendation =
    record || ignoredThisWeek ? null : recommend(recoCandidates, today, weekStart, history);

  const dealCandidates: DealCandidate[] = active
    .map((o) => ({
      opportunityId: o.opportunityId,
      owner: o.owner,
      firstName: firstNameOf.get(o.owner) ?? o.owner,
      client: clientOf(o),
      gmv: o.gmv,
      stage: o.stage,
    }))
    .sort((a, b) => a.firstName.localeCompare(b.firstName, "fr") || a.client.localeCompare(b.client, "fr"));

  // --- Radar -------------------------------------------------------------------
  const radarAll = listRadarContacts();
  const toProcess = radarToProcess(radarAll, weekEnd);
  const interviews = radarInterviews(radarAll);

  // --- Éléments à planifier ------------------------------------------------------
  const items: WeekItem[] = [];

  for (const v of verdicts) {
    if (v.attention.level === "vert" || !v.recommendation) continue;
    items.push({
      key: `et:${v.salesperson}`,
      kind: v.attention.level === "rouge" ? "et_rouge" : "et_orange",
      urgent: v.attention.level === "rouge",
      score: v.attention.strong * 10 + v.attention.total,
      title: v.firstName,
      who: v.salesperson,
      reason: v.summary,
      recommendation: v.recommendation,
      href: `/performance?commercial=${encodeURIComponent(v.salesperson)}`,
    });
  }

  for (const d of bigDeals) {
    items.push({
      key: `deal:${d.opportunityId}`,
      kind: "gros_dossier",
      urgent: d.urgent,
      score: d.gmv / 1000,
      title: bigDealTitle(d),
      who: d.firstName,
      reason: d.reason,
      recommendation: d.recommendation,
      href: `/forecast?commercial=${encodeURIComponent(d.owner)}`,
    });
  }

  if (dealOfWeek && !dealOfWeek.inactiveReason) {
    items.push({
      key: `dow:${dealOfWeek.record.opportunityId}`,
      kind: "affaire_semaine",
      urgent: false,
      score: 1,
      title: `${dealOfWeek.firstName} – ${dealOfWeek.client}${dealOfWeek.gmv != null ? ` – ${kEur(dealOfWeek.gmv)}` : ""}`,
      who: dealOfWeek.record.salesperson,
      reason: `Angle : ${dealOfWeek.angleLabel}${dealOfWeek.record.comment?.trim() ? ` · ${dealOfWeek.record.comment.trim()}` : ""}`,
      recommendation: dealOfWeek.recommendation,
      href: `/forecast?commercial=${encodeURIComponent(dealOfWeek.record.salesperson)}`,
    });
  }

  if (toProcess.length > 0) {
    items.push({
      key: "radar:candidatures",
      kind: "candidatures",
      urgent: false,
      score: toProcess.length,
      title: `${toProcess.length} candidature${toProcess.length > 1 ? "s" : ""} à traiter`,
      who: toProcess.slice(0, 4).map((c) => c.name).join(", ") + (toProcess.length > 4 ? "…" : ""),
      reason: "Contacts du radar en attente d'une action",
      recommendation: {
        minutes: Math.min(60, toProcess.length * RADAR.minutes),
        action: "Qualifier et contacter",
        lookWhere: "Ma semaine, radar",
        lookFor: "Les profils à rappeler cette semaine",
        obtain: "Un statut et une prochaine action pour chaque contact",
      },
      href: "/semaine?vue=radar",
    });
  }

  if (interviews.length > 0) {
    items.push({
      key: "radar:entretiens",
      kind: "entretiens",
      urgent: false,
      score: interviews.length,
      title: `${interviews.length} entretien${interviews.length > 1 ? "s" : ""} à mener`,
      who: interviews.map((c) => c.name).join(", "),
      reason: "Contacts du radar au stade RDV",
      recommendation: {
        minutes: 45,
        action: "Mener l'entretien",
        lookWhere: "Ma semaine, radar, fiche du contact",
        lookFor: "Fibre commerciale, culture travaux, disponibilité",
        obtain: "Une décision : poursuivre ou écarter",
      },
      href: "/semaine?vue=radar",
    });
  }

  const sourcingNote = (category: "et" | "archi") => {
    const waiting = radarAll.filter(
      (c) => c.category === category && (RADAR.toProcess as readonly string[]).includes(c.status),
    );
    if (waiting.length === 0) return undefined;
    return `${waiting.length} contact${waiting.length > 1 ? "s" : ""} en attente dans le radar : ${waiting
      .slice(0, 3)
      .map((c) => c.name)
      .join(", ")}${waiting.length > 3 ? "…" : ""}.`;
  };

  const planning = planWeek(WEEK_SLOTS, items, {
    sourcing_et: sourcingNote("et"),
    sourcing_archi: sourcingNote("archi"),
  });
  const actions = orderActions(items);

  const lastSync = lastCompleteRun();
  const dataAt = lastSync?.completedAt ?? latestImport()?.importedAt ?? null;

  return {
    weekStart,
    weekEnd,
    weekLabel,
    dataAt,
    summary: {
      red: verdicts.filter((v) => v.attention.level === "rouge").length,
      orange: verdicts.filter((v) => v.attention.level === "orange").length,
      bigDeals: bigDeals.length,
      dealOfWeek: dealOfWeek && !dealOfWeek.inactiveReason ? 1 : 0,
      candidatures: toProcess.length,
    },
    verdicts,
    bigDeals,
    dealOfWeek,
    recommendation,
    ignoredThisWeek,
    candidates: dealCandidates,
    radar: { all: radarAll, toProcess, interviews },
    actions,
    planning,
    notes,
  };
}

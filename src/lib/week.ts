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
import { bigDealTitle, detectBigDeals, type BigDeal, type BigDealCandidate } from "./big-deals";
import { ATTENTION, BIG_DEALS, RADAR, WEEK_SLOTS, WEEK_VIEW } from "./config";
import { currentDealOfWeek, type DealOfWeekRecord } from "./deal-of-week-store";
import { buildForecastV2 } from "./forecast-v2";
import { computeMetrics, daysSinceActivity } from "./metrics";
import { computeOpportunityMetrics, loadMilestoneOpportunities } from "./opportunity-metrics";
import { daysBetween, mondayOf, stageRank, todayIso } from "./normalize";
import { buildPerformanceBoard } from "./performance";
import { listRadarContacts, radarInterviews, radarToProcess, type RadarContact } from "./radar-store";
import { latestImport, loadOpportunities } from "./repository";
import { earliestSnapshotDate, loadStageStability } from "./stage-history";
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
  recommendation: Recommendation;
  /** Les axes à challenger, aide-mémoire fixe. */
  axes: string[];
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
  candidates: DealCandidate[];
  radar: { all: RadarContact[]; toProcess: RadarContact[]; interviews: RadarContact[] };
  actions: WeekItem[];
  planning: PlannedSlot[];
  /** Limites de lecture, dites plutôt que tues. */
  notes: string[];
};

export const DEAL_OF_WEEK_AXES = [
  "Qualité de qualification",
  "Stratégie client",
  "Prochaines étapes",
  "Création de l'urgence",
  "Disponibilité artisan",
  "Estimation",
  "Visite artisan",
  "Closing",
];

const DEAL_OF_WEEK_RECOMMENDATION: Recommendation = {
  minutes: 30,
  action: "Challenger stratégie et méthode",
  lookWhere: "Salesforce, l'affaire et son historique",
  lookFor: "Qualification, stratégie client, prochaines étapes, urgence, artisan, estimation, visite, closing",
  obtain: "Un plan d'action partagé avec l'ET, daté",
};

const DAY_MONTH = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
const DAY_ONLY = new Intl.DateTimeFormat("fr-FR", { day: "numeric" });

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

/** Semaine affichée : la courante jusqu'au vendredi, la suivante dès le samedi. */
export function weekBounds(now: Date): { weekStart: string; weekEnd: string; weekLabel: string } {
  const today = todayIso(now);
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  let weekStart = mondayOf(today);
  if (dow >= WEEK_VIEW.switchToNextFromDay) weekStart = addDays(weekStart, 7);
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
  const today = todayIso(now);
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

      const stagnantList = mine.filter((o) => {
        const s = stability.get(o.opportunityId);
        if (!s || s.provenDays < ATTENTION.stagnantDays) return false;
        const activity = daysSinceActivity(o, today);
        return activity == null || activity >= ATTENTION.stagnantDays;
      });
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
      recommendation: DEAL_OF_WEEK_RECOMMENDATION,
      axes: DEAL_OF_WEEK_AXES,
    };
  }

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
      reason: dealOfWeek.record.comment?.trim() || "Affaire choisie comme support de management",
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
    candidates: dealCandidates,
    radar: { all: radarAll, toProcess, interviews },
    actions,
    planning,
    notes,
  };
}

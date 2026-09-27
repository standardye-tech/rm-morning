/**
 * « Ma semaine » — composition du planning recommandé depuis les moteurs
 * existants. Aucun calcul métier ici : on lit l'attention managériale et les
 * gros dossiers (`buildWeek`), le Momentum 7 jours, le vivier du Plan du jour et
 * les challengers Forecast, puis on confie le tout au moteur pur
 * `week-agenda.ts`.
 */

import { treatedActions } from "./action-state";
import { ATTENTION, WEEK_SLOTS } from "./config";
import { parisDate, parisWeekday } from "./business-time";
import { OBJECTIVE_LABEL } from "./big-deals";
import { buildForecastV2, forecastChallengers } from "./forecast-v2";
import { buildMorningPlan } from "./morning-priority";
import { loadOpportunities } from "./repository";
import { buildMomentum } from "./since-last-snapshot";
import { loadTeam } from "./team-store";
import { buildWeek } from "./week";
import {
  agendaCounts,
  composeCards,
  etSlots,
  hideTreated,
  scheduleCards,
  type AgendaCard,
  type AgendaSlot,
  type OwnerAgendaInput,
  type ScheduledCard,
} from "./week-agenda";
import { loadAgendaState, slotValue, type AgendaDone } from "./week-agenda-store";

export type WeekAgendaView = {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  dataAt: string | null;
  /** Jour ouvré affiché comme « aujourd'hui » (1 = lundi), ou null le week-end. */
  todayDay: number | null;
  counts: { total: number; done: number; remaining: number };
  timeline: ScheduledCard[];
  toPlace: ScheduledCard[];
  /** Créneaux proposables pour placer un ET : créneaux libres de la grille, jour + heure. */
  placeOptions: { value: string; label: string }[];
  done: AgendaDone[];
  doneKeys: string[];
  notes: string[];
};

const DAY_LABEL = ["", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];

export function slotLabel(slot: AgendaSlot): string {
  return slot.time ? `${DAY_LABEL[slot.day]} ${slot.time}` : `${DAY_LABEL[slot.day]} · horaire à caler`;
}

/**
 * Les sujets terminés : ceux cochés ici (`week_agenda_state`), et ceux dont
 * l'ActionKey PARTAGÉE est traitée — depuis le Plan du jour comme depuis Ma
 * semaine. Un sujet purement managérial (sans ActionKey) ne dépend que de
 * l'état hebdomadaire, comme avant.
 */
export function withSharedState(cards: AgendaCard[], local: AgendaDone[]): AgendaDone[] {
  const tasks = cards.flatMap((c) => c.tasks);
  const actionOf = new Map(tasks.filter((t) => t.actionKey).map((t) => [t.key, t.actionKey as string]));
  const shared = treatedActions(actionOf.values());
  const out: AgendaDone[] = local.map((d) => ({ ...d, actionKey: actionOf.get(d.key) ?? d.actionKey }));
  const seen = new Set(out.map((d) => d.key));
  for (const t of tasks) {
    if (!t.actionKey || seen.has(t.key) || !shared.has(t.actionKey)) continue;
    out.push({ key: t.key, owner: t.owner, label: t.label, doneAt: shared.get(t.actionKey) ?? "", actionKey: t.actionKey });
  }
  return out.sort((a, b) => a.doneAt.localeCompare(b.doneAt));
}

export function buildWeekAgenda(now = new Date()): WeekAgendaView {
  const today = parisDate(now);
  const week = buildWeek(now);
  const upcoming = week.weekStart > today;
  const dow = parisWeekday(now);
  const fromDay = upcoming ? 1 : Math.min(dow, 6);
  const todayDay = !upcoming && dow <= 5 ? dow : null;

  const team = loadTeam();
  const firstNameOf = new Map(team.map((m) => [m.name, m.firstName]));
  const excluded = new Set<string>(ATTENTION.excluded);

  const momentum = buildMomentum(today, loadOpportunities());
  const momentumByOwner = new Map(momentum.owners.map((o) => [o.owner, o]));

  const plan = buildMorningPlan(now);
  const board = buildForecastV2(0, null, now);
  const challengers = forecastChallengers(board);

  const inputs: OwnerAgendaInput[] = week.verdicts
    .filter((v) => !excluded.has(v.salesperson))
    .map((v) => {
      const m = momentumByOwner.get(v.salesperson);
      return {
        owner: v.salesperson,
        firstName: firstNameOf.get(v.salesperson) ?? v.firstName,
        level: v.attention.level,
        attentionSummary: v.summary,
        reasons: v.reasons,
        momentum: m
          ? { available: momentum.window.available, signed: m.signed.gmv, up: m.gmvUp.gmv, down: m.gmvDown.gmv, stageChanges: m.stageChangedCount }
          : null,
        moves: (m?.changes ?? []).map((c) => ({
          opportunityId: c.opportunityId,
          client: c.client,
          gmv: c.gmv,
          gmvDelta: c.gmvChange?.delta ?? null,
          exitedM: !!c.kanbanChange?.exitedM,
          enteredStandby: !!c.standbyChange?.enteredStandby,
        })),
        plan: plan.pool.all
          .filter((a) => a.owner === v.salesperson && a.opportunityId)
          .map((a) => ({
            opportunityId: a.opportunityId as string,
            client: a.client ?? a.opportunityId ?? "",
            gmv: a.gmv ?? 0,
            reason: a.reason,
            impact: a.score,
            pMonthEnd: null,
            actionKey: a.key,
          })),
        challengers: challengers
          .filter((c) => c.row.owner === v.salesperson)
          .map((c) => ({
            opportunityId: c.row.opportunityId,
            client: c.row.client,
            gmv: c.row.gmv ?? 0,
            probability: c.row.expectedProbability ?? 0,
            expectedGmv: c.row.expectedGmv ?? 0,
          })),
        bigDeals: week.bigDeals
          .filter((d) => d.owner === v.salesperson)
          .map((d) => ({ opportunityId: d.opportunityId, client: d.client, gmv: d.gmv, objective: OBJECTIVE_LABEL[d.objective], urgent: d.urgent })),
      };
    });

  const cards = composeCards(inputs);
  const state = loadAgendaState(week.weekStart);
  const done = withSharedState(cards, state.done);
  const doneKeys = new Set(done.map((d) => d.key));
  const slots = etSlots(WEEK_SLOTS, fromDay);
  // Un placement manuel antérieur à aujourd'hui reste affiché à sa place : il a
  // été choisi, on ne le déplace pas en silence.
  // Les ET entièrement traités sont retirés après placement : leur créneau reste
  // réservé, prêt à les accueillir de nouveau si un sujet est rétabli.
  const { timeline, toPlace, freeSlots } = hideTreated(scheduleCards(cards, slots, state.placements), doneKeys);

  // Seuls des créneaux réels (jour + heure) sont proposés : placer un ET, c'est
  // lui donner une place dans la timeline, jamais un « horaire à caler ».
  const placeOptions = freeSlots
    .filter((s) => s.time)
    .map((s) => ({ value: slotValue(s.day, s.time), label: slotLabel(s) }));

  const notes: string[] = [];
  if (!momentum.window.available) notes.push("Momentum 7 jours indisponible : pas assez de recul entre deux photos.");
  if (slots.length === 0) notes.push("Plus aucun créneau ET de la grille cette semaine : les ET à voir sont dans « À placer ».");

  return {
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    weekLabel: week.weekLabel,
    dataAt: week.dataAt,
    todayDay,
    counts: agendaCounts(cards, doneKeys),
    timeline,
    toPlace,
    placeOptions,
    done,
    doneKeys: [...doneKeys],
    notes,
  };
}

/**
 * « Ma semaine » — persistance du planning recommandé (lot de simplification).
 *
 * Deux gestes, bornés à UNE semaine (lundi ISO) :
 *
 *   — un sujet coché « traité » : il quitte la liste active et reste retrouvable
 *     dans « Terminés cette semaine » (son libellé est conservé tel qu'il était
 *     affiché, puisque le sujet peut ne plus être recalculé demain) ;
 *   — un ET placé dans un créneau : sa carte quitte « À placer » et rejoint la
 *     timeline.
 *
 * Au changement de semaine, rien n'est reporté : l'ancienne reste archivée en
 * base, la nouvelle est recalculée. Aucun backlog, aucune échéance.
 */

import { restoreAction, treatAction } from "./action-state";
import { getDb } from "./db";

export type AgendaDone = {
  key: string;
  owner: string | null;
  label: string;
  doneAt: string;
  /** ActionKey partagée quand le sujet reprend une action existante ailleurs (Plan du jour). */
  actionKey: string | null;
};
export type AgendaPlacement = { owner: string; day: number; time: string | null };

const TASK = "task:";
const PLACE = "place:";

export function loadAgendaState(weekStart: string): { done: AgendaDone[]; placements: AgendaPlacement[] } {
  const rows = getDb()
    .prepare(
      `SELECT item_key, kind, owner, label, value, updated_at FROM week_agenda_state
        WHERE week_start = ? ORDER BY updated_at`,
    )
    .all(weekStart) as { item_key: string; kind: string; owner: string | null; label: string | null; value: string | null; updated_at: string }[];
  const done: AgendaDone[] = [];
  const placements: AgendaPlacement[] = [];
  for (const r of rows) {
    if (r.kind === "done" && r.item_key.startsWith(TASK)) {
      done.push({ key: r.item_key.slice(TASK.length), owner: r.owner, label: r.label ?? "", doneAt: r.updated_at, actionKey: null });
    } else if (r.kind === "placed" && r.item_key.startsWith(PLACE) && r.value) {
      const parsed = parseSlotValue(r.value);
      if (parsed) placements.push({ owner: r.item_key.slice(PLACE.length), ...parsed });
    }
  }
  return { done, placements };
}

/** « 2-14:00 » → mardi 14:00 ; « 5- » → vendredi, horaire à caler. */
export function parseSlotValue(value: string): { day: number; time: string | null } | null {
  const m = /^([1-5])-((?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(value);
  if (!m) return null;
  return { day: Number(m[1]), time: m[2] ?? null };
}

export function slotValue(day: number, time: string | null): string {
  return `${day}-${time ?? ""}`;
}

export function markAgendaTaskDone(
  weekStart: string,
  task: { key: string; owner: string; label: string },
  now = new Date(),
): boolean {
  const r = getDb()
    .prepare(
      `INSERT INTO week_agenda_state (week_start, item_key, kind, owner, label, value, updated_at)
       VALUES (?, ?, 'done', ?, ?, NULL, ?)
       ON CONFLICT(week_start, item_key) DO NOTHING`,
    )
    .run(weekStart, TASK + task.key, task.owner, task.label, now.toISOString());
  return Number(r.changes) > 0;
}

/**
 * Coche un sujet. S'il reprend une action existante ailleurs (ActionKey, Plan
 * du jour), c'est l'état PARTAGÉ qui est écrit : l'action disparaît aussi du
 * Plan. Un sujet purement managérial reste dans l'état hebdomadaire.
 */
export function checkAgendaTask(
  weekStart: string,
  task: { key: string; owner: string; label: string; actionKey: string | null },
  now = new Date(),
): boolean {
  if (task.actionKey) {
    return treatAction({ key: task.actionKey, surface: "semaine", owner: task.owner, label: task.label }, now);
  }
  return markAgendaTaskDone(weekStart, task, now);
}

/** Rétablit un sujet terminé : l'action partagée est rouverte partout. */
export function restoreAgendaTask(weekStart: string, entry: { key: string; actionKey: string | null }): boolean {
  const local = undoAgendaTask(weekStart, entry.key);
  const shared = entry.actionKey ? restoreAction(entry.actionKey) : false;
  return local || shared;
}

export function undoAgendaTask(weekStart: string, key: string): boolean {
  const r = getDb()
    .prepare("DELETE FROM week_agenda_state WHERE week_start = ? AND item_key = ? AND kind = 'done'")
    .run(weekStart, TASK + key);
  return Number(r.changes) > 0;
}

export function placeAgendaOwner(weekStart: string, owner: string, value: string, now = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO week_agenda_state (week_start, item_key, kind, owner, label, value, updated_at)
       VALUES (?, ?, 'placed', ?, NULL, ?, ?)
       ON CONFLICT(week_start, item_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(weekStart, PLACE + owner, owner, value, now.toISOString());
}

export function unplaceAgendaOwner(weekStart: string, owner: string): void {
  getDb()
    .prepare("DELETE FROM week_agenda_state WHERE week_start = ? AND item_key = ? AND kind = 'placed'")
    .run(weekStart, PLACE + owner);
}

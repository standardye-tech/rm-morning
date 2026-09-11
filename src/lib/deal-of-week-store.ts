/**
 * Affaire de la semaine — persistance.
 *
 * Une opportunité choisie À LA MAIN comme support de management. Une seule est
 * « en_cours » à la fois. Choisir une autre affaire passe la précédente en
 * « remplacee » ; la clore la passe en « cloturee ». Rien n'est supprimé : la
 * table est aussi le journal de ce qui a été travaillé avec chaque ET.
 *
 * Aucune écriture vers Salesforce. Aucun choix automatique en V1 : plus tard,
 * RM Morning proposera trois affaires, et ce sera toujours le directeur qui
 * tranchera — la colonne `status` et ce module n'auront pas à changer.
 */

import { getDb, queryAll, queryOne, type Row } from "./db";

export type DealOfWeekStatus = "en_cours" | "cloturee" | "remplacee";

export type DealOfWeekRecord = {
  id: number;
  opportunityId: string;
  salesperson: string;
  /** Lundi ISO de la semaine visée au moment du choix. */
  weekStart: string;
  selectedAt: string;
  comment: string | null;
  status: DealOfWeekStatus;
  closedAt: string | null;
  updatedAt: string;
};

function toRecord(row: Row): DealOfWeekRecord {
  return {
    id: Number(row.id),
    opportunityId: String(row.opportunity_id),
    salesperson: String(row.salesperson),
    weekStart: String(row.week_start),
    selectedAt: String(row.selected_at),
    comment: row.comment == null ? null : String(row.comment),
    status: String(row.status) as DealOfWeekStatus,
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    updatedAt: String(row.updated_at),
  };
}

/** L'affaire en cours, ou null. Conservée d'une semaine à l'autre tant qu'elle n'est pas close. */
export function currentDealOfWeek(): DealOfWeekRecord | null {
  const row = queryOne<Row>(
    "SELECT * FROM deal_of_week WHERE status = 'en_cours' ORDER BY selected_at DESC, id DESC LIMIT 1",
  );
  return row ? toRecord(row) : null;
}

export function dealOfWeekHistory(limit = 10): DealOfWeekRecord[] {
  return queryAll<Row>("SELECT * FROM deal_of_week ORDER BY selected_at DESC, id DESC LIMIT ?", limit).map(
    toRecord,
  );
}

export function selectDealOfWeek(
  input: { opportunityId: string; salesperson: string; weekStart: string; comment?: string | null },
  now = new Date(),
): DealOfWeekRecord {
  const iso = now.toISOString();
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE deal_of_week SET status = 'remplacee', closed_at = ?, updated_at = ? WHERE status = 'en_cours'`,
    ).run(iso, iso);
    const result = db
      .prepare(
        `INSERT INTO deal_of_week (opportunity_id, salesperson, week_start, selected_at, comment, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'en_cours', ?)`,
      )
      .run(input.opportunityId, input.salesperson, input.weekStart, iso, input.comment?.trim() || null, iso);
    db.exec("COMMIT");
    const row = queryOne<Row>("SELECT * FROM deal_of_week WHERE id = ?", Number(result.lastInsertRowid));
    if (!row) throw new Error("Affaire de la semaine non relue après insertion.");
    return toRecord(row);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function closeDealOfWeek(id: number, now = new Date()): boolean {
  const iso = now.toISOString();
  const result = getDb()
    .prepare(
      `UPDATE deal_of_week SET status = 'cloturee', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'en_cours'`,
    )
    .run(iso, iso, id);
  return result.changes > 0;
}

export function commentDealOfWeek(id: number, comment: string | null, now = new Date()): boolean {
  const result = getDb()
    .prepare(`UPDATE deal_of_week SET comment = ?, updated_at = ? WHERE id = ?`)
    .run(comment?.trim() || null, now.toISOString(), id);
  return result.changes > 0;
}

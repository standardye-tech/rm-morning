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

/**
 * « ignoree » : le directeur a décliné la recommandation de la semaine ; la
 * ligne porte l'affaire recommandée, pour la pénaliser une semaine. « reprise »
 * : cette ignorance a été annulée — elle ne compte plus pour rien.
 */
export type DealOfWeekStatus = "en_cours" | "cloturee" | "remplacee" | "ignoree" | "reprise";

export type DealOfWeekRecord = {
  id: number;
  opportunityId: string;
  salesperson: string;
  /** Lundi ISO de la semaine visée au moment du choix. */
  weekStart: string;
  selectedAt: string;
  /** Angle de challenge (clé de DEAL_OF_WEEK_ANGLES), ou null pour les choix anciens. */
  angle: string | null;
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
    angle: row.angle == null ? null : String(row.angle),
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
  input: {
    opportunityId: string;
    salesperson: string;
    weekStart: string;
    angle?: string | null;
    comment?: string | null;
  },
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
        `INSERT INTO deal_of_week (opportunity_id, salesperson, week_start, selected_at, angle, comment, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'en_cours', ?)`,
      )
      .run(
        input.opportunityId,
        input.salesperson,
        input.weekStart,
        iso,
        input.angle ?? null,
        input.comment?.trim() || null,
        iso,
      );
    db.exec("COMMIT");
    const row = queryOne<Row>("SELECT * FROM deal_of_week WHERE id = ?", Number(result.lastInsertRowid));
    if (!row) throw new Error("Affaire de la semaine non relue après insertion.");
    return toRecord(row);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Historique récent, pour l'anti-répétition. Toutes les lignes depuis ce lundi. */
export function recentDealOfWeekHistory(sinceWeekStart: string): DealOfWeekRecord[] {
  return queryAll<Row>("SELECT * FROM deal_of_week WHERE week_start >= ? ORDER BY selected_at", sinceWeekStart).map(
    toRecord,
  );
}

/** La semaine est-elle ignorée ? Une ligne « ignoree » non reprise sur ce lundi. */
export function isWeekIgnored(weekStart: string): boolean {
  return (
    queryOne<Row>("SELECT id FROM deal_of_week WHERE week_start = ? AND status = 'ignoree' LIMIT 1", weekStart) != null
  );
}

/** « Ignorer cette semaine » : mémorise la recommandation déclinée. Aucune affaire imposée. */
export function ignoreWeek(
  input: { opportunityId: string; salesperson: string; weekStart: string },
  now = new Date(),
): boolean {
  if (isWeekIgnored(input.weekStart)) return false;
  const iso = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO deal_of_week (opportunity_id, salesperson, week_start, selected_at, status, updated_at)
       VALUES (?, ?, ?, ?, 'ignoree', ?)`,
    )
    .run(input.opportunityId, input.salesperson, input.weekStart, iso, iso);
  return true;
}

/** Annule l'ignorance de la semaine : la recommandation revient. Rien n'est supprimé. */
export function resumeWeek(weekStart: string, now = new Date()): boolean {
  const r = getDb()
    .prepare(`UPDATE deal_of_week SET status = 'reprise', updated_at = ? WHERE week_start = ? AND status = 'ignoree'`)
    .run(now.toISOString(), weekStart);
  return r.changes > 0;
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

/** Change l'angle et la note de l'affaire en cours, sans la remplacer. */
export function updateDealOfWeek(
  id: number,
  patch: { angle?: string | null; comment?: string | null },
  now = new Date(),
): boolean {
  const current = queryOne<Row>("SELECT * FROM deal_of_week WHERE id = ?", id);
  if (!current) return false;
  const angle = patch.angle === undefined ? (current.angle == null ? null : String(current.angle)) : patch.angle;
  const comment =
    patch.comment === undefined
      ? current.comment == null
        ? null
        : String(current.comment)
      : patch.comment?.trim() || null;
  const result = getDb()
    .prepare(`UPDATE deal_of_week SET angle = ?, comment = ?, updated_at = ? WHERE id = ?`)
    .run(angle, comment, now.toISOString(), id);
  return result.changes > 0;
}

export function commentDealOfWeek(id: number, comment: string | null, now = new Date()): boolean {
  const result = getDb()
    .prepare(`UPDATE deal_of_week SET comment = ?, updated_at = ? WHERE id = ?`)
    .run(comment?.trim() || null, now.toISOString(), id);
  return result.changes > 0;
}

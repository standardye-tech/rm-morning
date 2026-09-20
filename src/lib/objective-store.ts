/**
 * Objectif mensuel — stockage minimal.
 *
 * `monthly_objective(month, scope, amount, updated_at)`. En V1 le seul périmètre
 * est `region` : l'objectif de la Région pour un mois « AAAA-MM ». Aucun montant
 * n'est codé en dur : sans saisie, l'objectif est NON RENSEIGNÉ et aucune
 * couverture ni aucun déficit n'est inventé.
 *
 * Saisi depuis l'écran Données. Aucune écriture vers Salesforce.
 */

import { getDb } from "./db";

export const OBJECTIVE_SCOPE_REGION = "region";

export type MonthlyObjective = {
  month: string;
  scope: string;
  amount: number;
  updatedAt: string;
};

type Row = { month: string; scope: string; amount: number; updated_at: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const toObjective = (r: Row): MonthlyObjective => ({
  month: String(r.month),
  scope: String(r.scope),
  amount: Number(r.amount),
  updatedAt: String(r.updated_at),
});

/** Objectif d'un mois, ou null s'il n'a jamais été renseigné. */
export function getObjective(month: string, scope: string = OBJECTIVE_SCOPE_REGION): MonthlyObjective | null {
  const row = getDb()
    .prepare("SELECT month, scope, amount, updated_at FROM monthly_objective WHERE month = ? AND scope = ?")
    .get(month, scope) as Row | undefined;
  return row ? toObjective(row) : null;
}

/** Les objectifs renseignés pour une liste de mois (les mois absents sont omis). */
export function listObjectives(months: string[], scope: string = OBJECTIVE_SCOPE_REGION): MonthlyObjective[] {
  return months.map((m) => getObjective(m, scope)).filter((o): o is MonthlyObjective => o != null);
}

/**
 * Enregistre (ou remplace) l'objectif d'un mois. Un montant strictement positif
 * est exigé : pour « effacer », utiliser `clearObjective`. Rend l'objectif écrit.
 */
export function setObjective(
  month: string,
  amount: number,
  now: Date = new Date(),
  scope: string = OBJECTIVE_SCOPE_REGION,
): MonthlyObjective {
  if (!MONTH.test(month)) throw new Error("Mois invalide : « AAAA-MM » attendu.");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Montant invalide : un nombre strictement positif est attendu.");
  const rounded = Math.round(amount);
  getDb()
    .prepare(
      `INSERT INTO monthly_objective (month, scope, amount, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(month, scope) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
    )
    .run(month, scope, rounded, now.toISOString());
  return getObjective(month, scope)!;
}

/** Retire l'objectif d'un mois : il redevient « non renseigné ». */
export function clearObjective(month: string, scope: string = OBJECTIVE_SCOPE_REGION): boolean {
  if (!MONTH.test(month)) throw new Error("Mois invalide : « AAAA-MM » attendu.");
  const r = getDb().prepare("DELETE FROM monthly_objective WHERE month = ? AND scope = ?").run(month, scope);
  return Number(r.changes) > 0;
}

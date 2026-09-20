/**
 * Journal du Plan du jour.
 *
 * Répond plus tard à : « qu'est-ce que RM Morning avait recommandé, à quel rang,
 * pour quel montant ? ». C'est un journal d'OBSERVATION : rien ne le relit pour
 * construire le Plan, qui est recalculé en entier depuis l'état courant. Il ne
 * porte ni statut, ni échéance, ni report, ni rappel — voir `morning_plan_log`
 * dans `db.ts`.
 *
 * Idempotent pour une journée : la première recommandation d'une situation est
 * conservée, un rechargement de la page ne la réécrit pas.
 */

import { parisDate } from "./business-time";
import { getDb } from "./db";
import type { MorningAction } from "./morning-types";

/**
 * Journalise les situations recommandées. `rankOffset` est le nombre de
 * situations déjà traitées aujourd'hui : elles ont occupé les premiers rangs de
 * la journée, la liste restante commence donc après elles.
 * Rend le nombre de lignes réellement ajoutées.
 */
export function recordPlanLog(proposed: MorningAction[], now = new Date(), rankOffset = 0): number {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO morning_plan_log
       (plan_date, action_key, owner, opportunity_id, category, score, rank, gmv, reason_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const date = parisDate(now);
  const createdAt = now.toISOString();
  let added = 0;
  proposed.forEach((a, i) => {
    const r = insert.run(
      date,
      a.key,
      a.owner,
      a.opportunityId,
      a.category,
      a.score,
      rankOffset + i + 1,
      a.gmv,
      a.reason,
      createdAt,
    );
    added += Number(r.changes);
  });
  return added;
}

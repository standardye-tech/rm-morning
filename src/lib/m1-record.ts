/**
 * Historisation des suggestions M+1 et relevé de leur issue.
 *
 * Extrait du script `m1:record` en C12, pour que l'actualisation globale
 * l'exécute automatiquement. Il n'existe qu'une implémentation.
 *
 * DEUX opérations, dans cet ordre :
 *   1. enregistrer la génération courante — toutes les affaires au-dessus du
 *      seuil, leur contexte déclaratif, et si elles ont été retenues comme ligne
 *      jaune ou écartées parce que déjà déclarées ;
 *   2. renseigner l'issue des générations dont le mois cible est terminé, depuis
 *      la source officielle Travaux.
 *
 * IDEMPOTENT. La clé est (snapshot_date, opportunity_id, target_month) : deux
 * actualisations le même jour mettent à jour la même ligne au lieu d'en créer une
 * seconde. Les colonnes d'issue ne figurent pas dans le UPDATE, donc une issue
 * déjà relevée n'est jamais effacée par une nouvelle génération.
 *
 * Écrit uniquement dans `expected_m1_suggestion`.
 */

import { EXPECTED_M1 } from "./config";
import { getDb } from "./db";
import { buildForecastV2 } from "./forecast-v2";
import { officialSignedGmv } from "./official-signed";

export type M1RecordSummary = {
  snapshotDate: string;
  targetMonth: string;
  candidates: number;
  yellow: number;
  excludedKanban: number;
  excludedPerspective: number;
  excludedFrozen: number;
  /** Mois cibles dont l'issue vient d'être relevée. */
  outcomes: { month: string; rows: number; signed: number }[];
  total: number;
};

export function recordM1Suggestions(now = new Date()): M1RecordSummary | null {
  const db = getDb();
  const board = buildForecastV2(1);
  const m1 = board.expectedM1;
  if (m1 == null) return null;

  const snapshotDate = m1.observationDate;
  const yellow = new Set(board.examine.map((e) => e.row.opportunityId));
  const declared = new Set<string>();
  const inPerspective = new Set<string>();
  for (const sp of board.salespeople) {
    for (const o of sp.opportunities) {
      if (!o.outsideKanban && o.kanbanMonth === board.month) declared.add(o.opportunityId);
      if (o.perspectiveMonth === board.month) inPerspective.add(o.opportunityId);
    }
  }

  // On conserve TOUTES les affaires au-dessus du seuil, y compris celles écartées
  // parce que déjà déclarées. Sans elles, impossible de mesurer plus tard si la
  // règle d'exclusion nous fait rater des signatures.
  const candidates = m1.opportunities.filter(
    (o) => o.probability >= EXPECTED_M1.probabilityThreshold,
  );

  const insert = db.prepare(
    `INSERT INTO expected_m1_suggestion
       (snapshot_date, opportunity_id, target_month, owner, gmv, probability, expected_gmv,
        declared_kanban, in_perspective, suggested_yellow, rule_version, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_date, opportunity_id, target_month) DO UPDATE SET
       owner = excluded.owner, gmv = excluded.gmv, probability = excluded.probability,
       expected_gmv = excluded.expected_gmv, declared_kanban = excluded.declared_kanban,
       in_perspective = excluded.in_perspective, suggested_yellow = excluded.suggested_yellow,
       rule_version = excluded.rule_version, recorded_at = excluded.recorded_at`,
  );

  db.exec("BEGIN");
  try {
    for (const o of candidates) {
      insert.run(
        snapshotDate,
        o.opportunityId,
        m1.targetMonth,
        o.owner,
        o.gmv,
        o.probability,
        o.expectedGmv,
        declared.has(o.opportunityId) ? 1 : 0,
        inPerspective.has(o.opportunityId) ? 1 : 0,
        yellow.has(o.opportunityId) ? 1 : 0,
        EXPECTED_M1.ruleVersion,
        now.toISOString(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // --- Issue des mois cibles terminés.
  //
  // Une suggestion est réussie si l'affaire porte un devis Travaux ORIGINAL signé
  // dans le mois cible — exactement la cible sur laquelle le modèle a appris. Le
  // GMV relevé est le GMV OFFICIEL de l'affaire sur ce mois, avenants compris.
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const pending = db
    .prepare(
      `SELECT DISTINCT target_month m FROM expected_m1_suggestion
        WHERE target_month < ? AND outcome_recorded_at IS NULL
        ORDER BY m`,
    )
    .all(currentMonth) as { m: string }[];

  const setOutcome = db.prepare(
    `UPDATE expected_m1_suggestion
        SET outcome_signed = ?, outcome_gmv = ?, outcome_recorded_at = ?
      WHERE target_month = ? AND opportunity_id = ?`,
  );

  const outcomes: M1RecordSummary["outcomes"] = [];
  for (const { m: month } of pending) {
    const official = officialSignedGmv(month);
    const gmvByOpp = new Map<string, number>();
    const signedOriginal = new Set<string>();
    for (const line of official.rows) {
      if (line.opportunityId == null) continue;
      gmvByOpp.set(line.opportunityId, (gmvByOpp.get(line.opportunityId) ?? 0) + line.gmv);
      if (line.worksType === "ORIGINAL") signedOriginal.add(line.opportunityId);
    }
    const rows = db
      .prepare("SELECT DISTINCT opportunity_id id FROM expected_m1_suggestion WHERE target_month = ?")
      .all(month) as { id: string }[];
    let signed = 0;
    for (const r of rows) {
      const ok = signedOriginal.has(r.id) ? 1 : 0;
      signed += ok;
      setOutcome.run(ok, gmvByOpp.get(r.id) ?? 0, now.toISOString(), month, r.id);
    }
    outcomes.push({ month, rows: rows.length, signed });
  }

  const total = (
    db.prepare("SELECT COUNT(*) n FROM expected_m1_suggestion").get() as { n: number }
  ).n;

  return {
    snapshotDate,
    targetMonth: m1.targetMonth,
    candidates: candidates.length,
    yellow: yellow.size,
    excludedKanban: candidates.filter((o) => declared.has(o.opportunityId)).length,
    excludedPerspective: candidates.filter((o) => inPerspective.has(o.opportunityId)).length,
    excludedFrozen: candidates.filter((o) => o.frozenM1).length,
    outcomes,
    total,
  };
}

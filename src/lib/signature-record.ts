/**
 * Journal durable des signatures.
 *
 * Extrait du script `signatures:record` en C12, pour que l'actualisation globale
 * l'exécute automatiquement. Il n'existe qu'une implémentation : le script
 * appelle désormais cette fonction.
 *
 * POURQUOI CE JOURNAL EXISTE. `expected_gmv_observation` porte
 * `actual_signature_at`, mais cette table est REGÉNÉRÉE à chaque reconstruction
 * du dataset. Sans recopie durable, l'historique de signatures dont une V2
 * M+1/M+2 aura besoin serait perdu à la prochaine reconstruction.
 *
 * Idempotent : une signature déjà enregistrée voit ses champs rafraîchis, mais sa
 * date de création et son premier enregistrement sont conservés.
 *
 * Écrit uniquement dans `signature_event`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getDb } from "./db";

export type SignatureRecordSummary = {
  total: number;
  added: number;
  from: string | null;
  to: string | null;
  months: number;
  withCreatedAt: number;
};

const DAY = 864e5;

export function recordSignatureEvents(): SignatureRecordSummary {
  const db = getDb();
  const now = new Date().toISOString();

  // Une ligne par opportunité signée : la dernière observation avant la
  // signature, qui porte le GMV et l'étape connus au plus près de l'événement.
  const rows = db
    .prepare(
      `SELECT substr(o.opportunity_id, 1, 15) AS id,
              o.actual_signature_at, o.amount, o.owner, o.stage,
              o.acquisition_channel, o.service, o.postal_code
         FROM expected_gmv_observation o
         JOIN (
           SELECT opportunity_id, MAX(observation_date) AS last_day
             FROM expected_gmv_observation
            WHERE actual_signature_at IS NOT NULL
            GROUP BY opportunity_id
         ) last
           ON last.opportunity_id = o.opportunity_id
          AND last.last_day = o.observation_date
        WHERE o.actual_signature_at IS NOT NULL`,
    )
    .all() as {
    id: string;
    actual_signature_at: string | null;
    amount: number | null;
    owner: string | null;
    stage: string | null;
    acquisition_channel: string | null;
    service: string | null;
    postal_code: string | null;
  }[];

  // La date de création vient de la table courante quand l'affaire y figure
  // encore. `opportunity` ne garde que le périmètre courant : une affaire signée
  // il y a un an n'y est plus, et le catalogue d'extraction sert alors de repli.
  const created = new Map<string, string | null>(
    (
      db
        .prepare("SELECT substr(opportunity_id,1,15) k, created_at FROM opportunity")
        .all() as { k: string; created_at: string | null }[]
    ).map((r) => [r.k, r.created_at]),
  );
  const catalog = path.resolve(process.cwd(), "data/dataset-cache/opportunities.json");
  if (existsSync(catalog)) {
    const parsed = JSON.parse(readFileSync(catalog, "utf8")) as {
      Id: string;
      CreatedDate?: string;
    }[];
    for (const o of parsed) {
      const k = o.Id.slice(0, 15);
      if (!created.get(k) && o.CreatedDate) created.set(k, o.CreatedDate);
    }
  }

  const insert = db.prepare(
    `INSERT INTO signature_event
       (opportunity_id, signed_at, gmv, owner, stage_before, acquisition_channel,
        service, postal_code, created_at, days_to_sign, first_recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(opportunity_id) DO UPDATE SET
       signed_at = excluded.signed_at, gmv = excluded.gmv, owner = excluded.owner,
       stage_before = excluded.stage_before, acquisition_channel = excluded.acquisition_channel,
       service = excluded.service, postal_code = excluded.postal_code,
       created_at = COALESCE(signature_event.created_at, excluded.created_at),
       days_to_sign = excluded.days_to_sign`,
  );

  const count = () => (db.prepare("SELECT COUNT(*) n FROM signature_event").get() as { n: number }).n;
  const before = count();

  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const createdAt = created.get(r.id) ?? null;
      const days =
        createdAt && r.actual_signature_at
          ? Math.round(
              (new Date(r.actual_signature_at).getTime() - new Date(createdAt).getTime()) / DAY,
            )
          : null;
      insert.run(
        r.id,
        r.actual_signature_at,
        r.amount,
        r.owner,
        r.stage,
        r.acquisition_channel,
        r.service,
        r.postal_code,
        createdAt,
        days,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const after = count();
  const span = db
    .prepare("SELECT MIN(signed_at) a, MAX(signed_at) b FROM signature_event")
    .get() as { a: string | null; b: string | null };
  const months = (
    db
      .prepare("SELECT COUNT(DISTINCT substr(signed_at,1,7)) n FROM signature_event")
      .get() as { n: number }
  ).n;
  const withCreatedAt = (
    db
      .prepare("SELECT COUNT(*) n FROM signature_event WHERE created_at IS NOT NULL")
      .get() as { n: number }
  ).n;

  return { total: after, added: after - before, from: span.a, to: span.b, months, withCreatedAt };
}

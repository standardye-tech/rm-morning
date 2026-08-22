/**
 * Import des lignes Travaux — source officielle du GMV signé.
 *
 * Extrait du script `travaux:import` en C12 pour que l'orchestrateur puisse
 * l'appeler dans le même processus. Le script reste disponible et appelle
 * désormais cette fonction : il n'existe qu'une seule implémentation.
 *
 * LECTURE SEULE Salesforce : une seule requête SOQL, aucune écriture. Écrit
 * uniquement dans la table locale `travaux`.
 *
 * `first_seen_at` n'est jamais réécrit — c'est ce qui permettra de dater
 * l'apparition d'un avenant ou d'une annulation.
 */

import { TRAVAUX } from "./config";
import { getDb } from "./db";
import { runSoql } from "./sources/api-salesforce";

type TravauxRecord = {
  Id: string;
  Name: string | null;
  Opportunite__c: string | null;
  NomOpportunite__c: string | null;
  Proprietaire_de_l_opportunite__c: string | null;
  Date_de_signature_du_devis__c: string | null;
  Montant__c: number | null;
  Chiffre_d_affaires__c: number | null;
  Type_de_travaux__c: string | null;
  Statut_travaux__c: string | null;
  Travaux_annulant__c: string | null;
  LastModifiedDate: string | null;
};

export type TravauxImportSummary = {
  importedAt: string;
  extracted: number;
  total: number;
  added: number;
  from: string | null;
  to: string | null;
};

const FIELDS = [
  "Id",
  "Name",
  "Opportunite__c",
  "NomOpportunite__c",
  "Proprietaire_de_l_opportunite__c",
  "Date_de_signature_du_devis__c",
  "Montant__c",
  "Chiffre_d_affaires__c",
  "Type_de_travaux__c",
  "Statut_travaux__c",
  "Travaux_annulant__c",
  "LastModifiedDate",
];

export async function importTravaux(): Promise<TravauxImportSummary> {
  const rows = await runSoql<TravauxRecord>(
    `SELECT ${FIELDS.join(", ")} FROM Travaux__c WHERE Date_de_signature_du_devis__c >= ${TRAVAUX.from}`,
  );

  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO travaux
       (travaux_id, opportunity_id, name, opportunity_name, owner_raw, signature_date, gmv,
        revenue, works_type, works_status, cancels_travaux_id, last_modified_at,
        first_seen_at, last_import_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(travaux_id) DO UPDATE SET
       opportunity_id = excluded.opportunity_id, name = excluded.name,
       opportunity_name = excluded.opportunity_name, owner_raw = excluded.owner_raw,
       signature_date = excluded.signature_date, gmv = excluded.gmv, revenue = excluded.revenue,
       works_type = excluded.works_type, works_status = excluded.works_status,
       cancels_travaux_id = excluded.cancels_travaux_id,
       last_modified_at = excluded.last_modified_at, last_import_at = excluded.last_import_at`,
  );

  const before = (db.prepare("SELECT COUNT(*) n FROM travaux").get() as { n: number }).n;
  db.exec("BEGIN");
  try {
    for (const t of rows) {
      upsert.run(
        t.Id,
        // Identifiant en 15 caractères, forme canonique de l'application.
        t.Opportunite__c ? String(t.Opportunite__c).slice(0, 15) : null,
        t.Name,
        t.NomOpportunite__c,
        t.Proprietaire_de_l_opportunite__c,
        t.Date_de_signature_du_devis__c,
        t.Montant__c,
        t.Chiffre_d_affaires__c,
        t.Type_de_travaux__c,
        t.Statut_travaux__c,
        t.Travaux_annulant__c ? String(t.Travaux_annulant__c).slice(0, 15) : null,
        t.LastModifiedDate,
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const after = (db.prepare("SELECT COUNT(*) n FROM travaux").get() as { n: number }).n;
  const span = db
    .prepare("SELECT MIN(signature_date) a, MAX(signature_date) b FROM travaux")
    .get() as { a: string | null; b: string | null };

  return {
    importedAt: now,
    extracted: rows.length,
    total: after,
    added: after - before,
    from: span.a,
    to: span.b,
  };
}

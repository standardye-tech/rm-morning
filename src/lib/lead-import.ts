/**
 * Import des pistes Salesforce et calcul de leur état opérationnel.
 *
 * Lecture seule côté Salesforce. L'évaluation est déléguée à `lead-rules`,
 * qui ne connaît ni la base ni le réseau : le moteur de règles reste testable
 * et réutilisable pour une autre direction régionale.
 */

import { LEAD_MONITORING } from "./config";
import { loadTeam } from "./team-store";
import { getDb } from "./db";
import { evaluateLead, type LeadThresholds } from "./lead-rules";
import {
  ensureMonitoringActivated,
  previousAnomalyState,
  upsertLead,
  monitoringActivatedAt,
} from "./lead-store";
import { normalizeKey } from "./normalize";
import { fetchLeads, salesforceOwnerNames } from "./sources/leads-salesforce";

export const LEAD_THRESHOLDS: LeadThresholds = {
  noAppointmentGraceHours: LEAD_MONITORING.noAppointmentGraceHours,
  lateAfterHours: LEAD_MONITORING.lateAfterHours,
  criticalAfterHours: LEAD_MONITORING.criticalAfterHours,
  automatedTaskPattern: LEAD_MONITORING.automatedTaskPattern,
  minConsignationLength: LEAD_MONITORING.minConsignationLength,
};

export type LeadImportSummary = {
  importId: number;
  snapshotDate: string;
  totalLeads: number;
  byStatus: Record<string, number>;
  byOperational: Record<string, number>;
  newExceptions: number;
  legacyBacklog: number;
  firstImport: boolean;
  activatedAt: string;
  durationMs: number;
};

/** Résout le nom Salesforce vers le nom canonique de l'équipe. */
function canonicalOwner(raw: string): string | null {
  const target = normalizeKey(raw);
  for (const member of loadTeam()) {
    if (normalizeKey(member.name) === target) return member.name;
    if ((member.aliases ?? []).some((a) => normalizeKey(a) === target)) return member.name;
  }
  return null;
}

export async function importLeads(now = new Date()): Promise<LeadImportSummary> {
  const startedAt = Date.now();
  const snapshotDate = now.toISOString().slice(0, 10);
  const observedAt = now.toISOString();

  // Le périmètre est relu ici : la requête Salesforce ne demande que les
  // pistes des commerciaux actuellement dans l'équipe.
  const raw = await fetchLeads(salesforceOwnerNames(loadTeam()));

  // Le premier import pose la frontière : tout ce qui est déjà en anomalie à
  // cet instant est de la dette héritée, pas un manquement observé.
  const wasActivated = monitoringActivatedAt();
  const activatedAt = ensureMonitoringActivated(observedAt);
  const isFirstImport = !wasActivated;

  const previous = previousAnomalyState();

  const db = getDb();
  const importId = Number(
    db
      .prepare(
        `INSERT INTO import_run (imported_at, snapshot_date, source_kind, source_label, total_rows, team_rows)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(observedAt, snapshotDate, "leads-api", "Pistes Salesforce", raw.length, raw.length)
      .lastInsertRowid,
  );

  const byStatus: Record<string, number> = {};
  const byOperational: Record<string, number> = {};
  let newExceptions = 0;
  let legacyBacklog = 0;

  for (const lead of raw) {
    const owner = canonicalOwner(lead.ownerRaw);
    if (!owner) continue; // hors périmètre équipe

    const verdict = evaluateLead(
      {
        leadId: lead.leadId,
        status: lead.status,
        createdAt: lead.createdAt,
        recallDate: lead.recallDate,
        convertedDate: lead.convertedDate,
        abandonedAt: lead.abandonedAt,
        events: lead.events,
        tasks: lead.tasks,
      },
      LEAD_THRESHOLDS,
      now.getTime(),
    );

    byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1;
    byOperational[verdict.operationalStatus] = (byOperational[verdict.operationalStatus] ?? 0) + 1;

    upsertLead(
      {
        leadId: lead.leadId,
        name: lead.name,
        email: lead.email,
        owner,
        ownerRaw: lead.ownerRaw,
        status: lead.status,
        createdAt: lead.createdAt,
        recallDate: lead.recallDate,
        convertedDate: lead.convertedDate,
        convertedOpportunityId: lead.convertedOpportunityId,
        abandonedAt: lead.abandonedAt,
        abandonReason: lead.abandonReason,
        acquisitionChannel: lead.acquisitionChannel,
        service: lead.service,
        postalCode: lead.postalCode,
        city: lead.city,
        firstCallAt: verdict.firstCallAt,
        nextAppointmentAt: verdict.nextAppointmentAt,
        consignedAt: verdict.consignedAt,
        consignedBy: verdict.consignedBy,
        lastActionAt: verdict.lastValidActionAt,
        operationalStatus: verdict.operationalStatus,
        flagReason: verdict.reason,
        latenessHours: verdict.latenessHours,
        firstCallMissed: verdict.firstCallMissed,
      },
      { importId, snapshotDate, observedAt, activatedAt, previous, isFirstImport },
    );
  }

  // Recompte après écriture : `is_legacy` n'est connu qu'une fois arbitré.
  const counts = db
    .prepare(
      `SELECT is_legacy AS legacy, COUNT(*) AS n FROM lead
        WHERE operational_status IN ('a_traiter','en_retard','critique','sans_rendez_vous')
        GROUP BY is_legacy`,
    )
    .all() as { legacy: number; n: number }[];
  for (const row of counts) {
    if (Number(row.legacy) === 1) legacyBacklog = Number(row.n);
    else newExceptions = Number(row.n);
  }

  return {
    importId,
    snapshotDate,
    totalLeads: Object.values(byStatus).reduce((s, v) => s + v, 0),
    byStatus,
    byOperational,
    newExceptions,
    legacyBacklog,
    firstImport: isFirstImport,
    activatedAt,
    durationMs: Date.now() - startedAt,
  };
}

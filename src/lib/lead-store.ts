/**
 * Persistance des pistes et de leur état opérationnel.
 *
 * Deux notions à ne pas confondre :
 *   — `anomaly_since` : quand RM Morning a constaté l'anomalie pour la
 *     première fois. Conservé d'un import à l'autre, jamais réinitialisé tant
 *     que l'anomalie dure ;
 *   — `is_legacy` : l'anomalie existait-elle déjà à l'activation du
 *     Monitoring ? C'est ce drapeau qui empêche une dette héritée de compter
 *     comme un manquement observé.
 */

import { getDb, queryAll, queryOne } from "./db";
import { ANOMALY_STATUSES, type LeadOperationalStatus } from "./lead-rules";

export type StoredLead = {
  leadId: string;
  name: string | null;
  owner: string;
  status: string;
  createdAt: string;
  recallDate: string | null;
  convertedOpportunityId: string | null;
  abandonReason: string | null;
  acquisitionChannel: string | null;
  service: string | null;
  postalCode: string | null;
  firstCallAt: string | null;
  nextAppointmentAt: string | null;
  consignedAt: string | null;
  lastActionAt: string | null;
  operationalStatus: LeadOperationalStatus;
  flagReason: string | null;
  latenessHours: number;
  firstCallMissed: boolean;
  anomalySince: string | null;
  isLegacy: boolean;
};

/**
 * Date d'activation du Monitoring. Posée au tout premier import et jamais
 * modifiée ensuite : c'est la frontière entre la dette héritée et ce que
 * RM Morning a réellement observé.
 */
export function monitoringActivatedAt(): string | null {
  const row = queryOne<{ activated_at: string }>(
    "SELECT activated_at FROM monitoring_state WHERE id = 1",
  );
  return row?.activated_at ?? null;
}

export function ensureMonitoringActivated(at: string): string {
  const existing = monitoringActivatedAt();
  if (existing) return existing;
  getDb()
    .prepare("INSERT INTO monitoring_state (id, activated_at) VALUES (1, ?)")
    .run(at);
  return at;
}

type UpsertInput = {
  leadId: string;
  name: string | null;
  /** Adresse de la piste (C13). Seule voie d'identification d'un client non converti. */
  email: string | null;
  owner: string;
  ownerRaw: string;
  status: string;
  createdAt: string;
  recallDate: string | null;
  convertedDate: string | null;
  convertedOpportunityId: string | null;
  abandonedAt: string | null;
  abandonReason: string | null;
  acquisitionChannel: string | null;
  service: string | null;
  postalCode: string | null;
  city: string | null;
  firstCallAt: string | null;
  nextAppointmentAt: string | null;
  consignedAt: string | null;
  consignedBy: string | null;
  lastActionAt: string | null;
  operationalStatus: LeadOperationalStatus;
  flagReason: string;
  latenessHours: number;
  firstCallMissed: boolean;
};

/** État antérieur, pour savoir depuis quand une anomalie dure. */
export function previousAnomalyState(): Map<string, { since: string | null; legacy: boolean }> {
  const rows = queryAll<{ lead_id: string; anomaly_since: string | null; is_legacy: number }>(
    "SELECT lead_id, anomaly_since, is_legacy FROM lead",
  );
  return new Map(rows.map((r) => [r.lead_id, { since: r.anomaly_since, legacy: r.is_legacy === 1 }]));
}

export function upsertLead(
  lead: UpsertInput,
  context: {
    importId: number;
    snapshotDate: string;
    observedAt: string;
    activatedAt: string;
    previous: Map<string, { since: string | null; legacy: boolean }>;
    isFirstImport: boolean;
  },
): void {
  const isAnomaly = ANOMALY_STATUSES.includes(lead.operationalStatus);
  const before = context.previous.get(lead.leadId);

  // L'anomalie court depuis sa première observation, pas depuis aujourd'hui.
  const anomalySince = isAnomaly ? (before?.since ?? context.observedAt) : null;

  // Dette héritée : anomalie déjà présente au tout premier import, ou déjà
  // marquée comme telle. Une anomalie née après l'activation ne le sera jamais.
  const isLegacy = isAnomaly ? (before?.legacy ?? context.isFirstImport) : false;

  getDb()
    .prepare(
      `INSERT INTO lead (
         lead_id, name, email, owner, owner_raw, status, created_at, recall_date,
         converted_date, converted_opportunity_id, abandoned_at, abandon_reason,
         acquisition_channel, service, postal_code, city,
         first_call_at, next_appointment_at, consigned_at, consigned_by, last_action_at,
         operational_status, flag_reason, lateness_hours, first_call_missed,
         anomaly_since, is_legacy, first_seen_on, last_import_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (lead_id) DO UPDATE SET
         name=excluded.name, email=excluded.email, owner=excluded.owner, owner_raw=excluded.owner_raw,
         status=excluded.status, recall_date=excluded.recall_date,
         converted_date=excluded.converted_date,
         converted_opportunity_id=excluded.converted_opportunity_id,
         abandoned_at=excluded.abandoned_at, abandon_reason=excluded.abandon_reason,
         acquisition_channel=excluded.acquisition_channel, service=excluded.service,
         postal_code=excluded.postal_code, city=excluded.city,
         first_call_at=excluded.first_call_at,
         next_appointment_at=excluded.next_appointment_at,
         consigned_at=excluded.consigned_at, consigned_by=excluded.consigned_by,
         last_action_at=excluded.last_action_at,
         operational_status=excluded.operational_status,
         flag_reason=excluded.flag_reason, lateness_hours=excluded.lateness_hours,
         first_call_missed=excluded.first_call_missed,
         anomaly_since=excluded.anomaly_since, is_legacy=excluded.is_legacy,
         last_import_id=excluded.last_import_id`,
    )
    .run(
      lead.leadId, lead.name, lead.email, lead.owner, lead.ownerRaw, lead.status, lead.createdAt,
      lead.recallDate, lead.convertedDate, lead.convertedOpportunityId, lead.abandonedAt,
      lead.abandonReason, lead.acquisitionChannel, lead.service, lead.postalCode, lead.city,
      lead.firstCallAt, lead.nextAppointmentAt, lead.consignedAt, lead.consignedBy,
      lead.lastActionAt, lead.operationalStatus, lead.flagReason, Math.round(lead.latenessHours),
      lead.firstCallMissed ? 1 : 0, anomalySince, isLegacy ? 1 : 0,
      context.snapshotDate, context.importId,
    );

  getDb()
    .prepare(
      `INSERT INTO lead_snapshot (snapshot_date, lead_id, owner, status, operational_status, lateness_hours, is_legacy)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (snapshot_date, lead_id) DO UPDATE SET
         status=excluded.status, operational_status=excluded.operational_status,
         lateness_hours=excluded.lateness_hours, is_legacy=excluded.is_legacy`,
    )
    .run(
      context.snapshotDate, lead.leadId, lead.owner, lead.status,
      lead.operationalStatus, Math.round(lead.latenessHours), isLegacy ? 1 : 0,
    );
}

/** Pistes vues à ce jour, dans la fenêtre d'import. */
export function loadLeads(): StoredLead[] {
  return queryAll<Record<string, string | number | null>>(
    `SELECT lead_id, name, owner, status, created_at, recall_date, converted_opportunity_id,
            abandon_reason, acquisition_channel, service, postal_code, first_call_at,
            next_appointment_at, consigned_at, last_action_at, operational_status,
            flag_reason, lateness_hours, first_call_missed, anomaly_since, is_legacy
       FROM lead`,
  ).map((r) => ({
    leadId: String(r.lead_id),
    name: r.name as string | null,
    owner: String(r.owner),
    status: String(r.status),
    createdAt: String(r.created_at),
    recallDate: r.recall_date as string | null,
    convertedOpportunityId: r.converted_opportunity_id as string | null,
    abandonReason: r.abandon_reason as string | null,
    acquisitionChannel: r.acquisition_channel as string | null,
    service: r.service as string | null,
    postalCode: r.postal_code as string | null,
    firstCallAt: r.first_call_at as string | null,
    nextAppointmentAt: r.next_appointment_at as string | null,
    consignedAt: r.consigned_at as string | null,
    lastActionAt: r.last_action_at as string | null,
    operationalStatus: String(r.operational_status) as LeadOperationalStatus,
    flagReason: r.flag_reason as string | null,
    latenessHours: Number(r.lateness_hours ?? 0),
    firstCallMissed: Number(r.first_call_missed) === 1,
    anomalySince: r.anomaly_since as string | null,
    isLegacy: Number(r.is_legacy) === 1,
  }));
}

export function leadCount(): number {
  return Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM lead")?.n ?? 0);
}

/** Dates de snapshot disponibles, pour comparer d'un jour à l'autre. */
export function leadSnapshotDates(limit = 30): string[] {
  return queryAll<{ snapshot_date: string }>(
    "SELECT DISTINCT snapshot_date FROM lead_snapshot ORDER BY snapshot_date DESC LIMIT ?",
    limit,
  ).map((r) => r.snapshot_date);
}

/**
 * Compteurs du mini-centre d'exceptions.
 *
 * Ne contient QUE des exceptions au process — jamais une création de piste,
 * un nouveau mail ou un mouvement Salesforce ordinaire. La dette héritée est
 * comptée à part : elle est visible, elle ne sonne pas.
 */
export function exceptionCounts(): { fresh: number; legacy: number } {
  let fresh = 0;
  let legacy = 0;
  const add = (rows: { is_legacy: number; n: number }[]) => {
    for (const r of rows) {
      if (Number(r.is_legacy) === 1) legacy += Number(r.n);
      else fresh += Number(r.n);
    }
  };
  add(
    queryAll<{ is_legacy: number; n: number }>(
      `SELECT is_legacy, COUNT(*) AS n FROM lead
        WHERE operational_status IN ('a_traiter','en_retard','critique','sans_rendez_vous')
        GROUP BY is_legacy`,
    ),
  );
  // Une seule cloche pour tout le Monitoring : pistes et opportunités.
  add(
    queryAll<{ is_legacy: number; n: number }>(
      `SELECT milestone_is_legacy AS is_legacy, COUNT(*) AS n FROM opportunity
        WHERE is_terminal = 0 AND milestone_status IN
              ('sla_estimation','sla_devis','client_attend','dormant_candidate','standby_expire')
        GROUP BY milestone_is_legacy`,
    ),
  );
  return { fresh, legacy };
}

/** Dernier contrôle de couverture des libellés Salesforce. Alerte TECHNIQUE. */
export function latestMilestoneCoverage(): {
  checkedAt: string;
  counters: Record<string, number>;
  degraded: string[];
} | null {
  const row = queryOne<{ checked_at: string; counters: string; degraded: string }>(
    "SELECT checked_at, counters, degraded FROM milestone_coverage ORDER BY checked_at DESC LIMIT 1",
  );
  if (!row) return null;
  return {
    checkedAt: row.checked_at,
    counters: JSON.parse(row.counters) as Record<string, number>,
    degraded: JSON.parse(row.degraded) as string[],
  };
}

/**
 * Import d'une source Salesforce : normalisation, filtrage équipe, écriture
 * de l'état courant et du snapshot quotidien.
 */

import { getDb } from "./db";
import {
  isTerminalStage,
  isWonStage,
  matchTeamMember,
  parseFrenchDate,
  parseFrenchNumber,
  parseKanban,
  todayIso,
} from "./normalize";
import type { SalesforceSource } from "./sources/salesforce";
import type { Opportunity } from "./types";

export type ImportSummary = {
  importId: number;
  snapshotDate: string;
  fileName: string | null;
  totalRows: number;
  teamRows: number;
  activeRows: number;
  signedRows: number;
  standbyRows: number;
  ignoredRows: number;
  /** Affaires sorties du périmètre source à cet import (abandon, annulation…). */
  departedRows: number;
  /** Affaires réapparues dans la source depuis leur disparition. */
  returnedRows: number;
  detectedFields: string[];
  missingFields: string[];
  issues: { row?: number; message: string }[];
};

/**
 * Part maximale du pipe qu'un seul import a le droit de faire sortir.
 *
 * Une source tronquée — requête partielle, session expirée en cours de page,
 * filtre modifié par erreur — ferait autrement disparaître le pipe entier d'un
 * coup. Au-delà de ce seuil on ne réconcilie pas : on le signale et on garde
 * l'état précédent, quitte à laisser un fantôme un jour de plus.
 */
const MAX_DEPARTURE_RATIO = 0.2;
const MIN_DEPARTURE_ALLOWANCE = 15;

/**
 * Importe la source, ne conserve que l'équipe suivie, et historise.
 *
 * Le snapshot est daté du jour de l'import. Ré-importer le même jour corrige
 * la photo du jour courant ; les snapshots des jours précédents ne sont
 * jamais touchés.
 */
export async function importFromSource(
  source: SalesforceSource,
  options: { referenceDate?: string } = {},
): Promise<ImportSummary> {
  const result = await source.fetch();
  const today = options.referenceDate ?? todayIso();
  const db = getDb();

  const opportunities: Opportunity[] = [];
  const issues = [...result.issues];
  let ignoredRows = 0;

  for (const raw of result.rows) {
    const member = matchTeamMember(raw.ownerName);
    if (!member) {
      ignoredRows++;
      continue; // Commercial hors périmètre : volontairement non importé.
    }

    const opportunityId = raw.opportunityId?.trim();
    if (!opportunityId) {
      issues.push({ message: `Opportunité sans ID ignorée : « ${raw.name ?? "sans nom"} »` });
      continue;
    }

    const kanban = parseKanban(raw.kanbanProjection);
    const standbyUntil = parseFrenchDate(raw.standByUntil);
    if (raw.standByUntil && !standbyUntil) {
      issues.push({
        message: `Date de stand-by illisible sur ${opportunityId} : « ${raw.standByUntil} »`,
      });
    }

    const gmv = parseFrenchNumber(raw.gmv);
    if (raw.gmv && gmv === null) {
      issues.push({ message: `GMV illisible sur ${opportunityId} : « ${raw.gmv} »` });
    }

    const isTerminal = isTerminalStage(raw.stage);
    // Stand-by en cours : la date de réveil est encore dans le futur.
    const isStandby = standbyUntil !== null && standbyUntil > today;

    opportunities.push({
      opportunityId,
      name: raw.name,
      clientContact: raw.clientContact,
      clientEmail: raw.clientEmail ? raw.clientEmail.trim().toLowerCase() : null,
      owner: member.name,
      ownerRaw: raw.ownerName,
      gmv,
      stage: raw.stage,
      probability: parseFrenchNumber(raw.probability),
      kanbanRaw: kanban?.raw ?? null,
      kanbanColor: kanban?.colorKey ?? null,
      kanbanColorRaw: kanban?.colorRaw ?? null,
      kanbanMonth: kanban?.month ?? null,
      kanbanYear: kanban?.year ?? null,
      createdAt: parseFrenchDate(raw.createdAt),
      leadCreatedAt: parseFrenchDate(raw.leadCreatedAt),
      quoteSignatureDate: parseFrenchDate(raw.quoteSignatureDate),
      lastActivityAt: parseFrenchDate(raw.lastActivityAt),
      lastModifiedAt: parseFrenchDate(raw.lastModifiedAt),
      postalCode: raw.postalCode,
      city: raw.city,
      acquisitionChannel: raw.acquisitionChannel,
      leadSource: raw.leadSource,
      service: raw.service,
      standbyUntil,
      standbyFlag:
        raw.standByFlag === null ? null : /^(true|1|vrai|oui)$/i.test(raw.standByFlag),
      isSigned: isWonStage(raw.stage),
      isTerminal,
      // Publiée par la source à l'instant : par construction, elle n'est pas
      // absente. La réconciliation ci-dessous ne concerne que les autres.
      absentSince: null,
      absentReason: null,
      isStandby,
      isActive: !isTerminal && !isStandby,
    });
  }

  const activeRows = opportunities.filter((o) => o.isActive).length;
  const signedRows = opportunities.filter((o) => o.isSigned).length;
  const standbyRows = opportunities.filter((o) => o.isStandby).length;

  const insertRun = db.prepare(`
    INSERT INTO import_run (
      imported_at, snapshot_date, source_kind, source_label, file_name,
      total_rows, team_rows, active_rows, signed_rows, standby_rows,
      detected_fields, missing_fields, raw_headers, issues
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const runInfo = insertRun.run(
    result.fetchedAt.toISOString(),
    today,
    result.sourceKind,
    result.sourceLabel,
    result.fileName,
    result.rows.length,
    opportunities.length,
    activeRows,
    signedRows,
    standbyRows,
    JSON.stringify(result.detectedFields),
    JSON.stringify(result.missingFields),
    JSON.stringify(result.rawHeaders),
    JSON.stringify(issues),
  );
  const importId = Number(runInfo.lastInsertRowid);

  const upsertOpportunity = db.prepare(`
    INSERT INTO opportunity (
      opportunity_id, name, client_contact, client_email, owner, owner_raw, gmv, stage, probability,
      kanban_raw, kanban_color, kanban_color_raw, kanban_month, kanban_year,
      created_at, lead_created_at, quote_signature_date, last_activity_at, last_modified_at,
      postal_code, city, acquisition_channel, lead_source, service,
      standby_until, standby_flag, is_signed, is_terminal, is_standby, is_active,
      first_seen_on, last_import_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(opportunity_id) DO UPDATE SET
      name = excluded.name, client_contact = excluded.client_contact,
      client_email = excluded.client_email,
      owner = excluded.owner, owner_raw = excluded.owner_raw,
      gmv = excluded.gmv, stage = excluded.stage, probability = excluded.probability,
      kanban_raw = excluded.kanban_raw, kanban_color = excluded.kanban_color,
      kanban_color_raw = excluded.kanban_color_raw,
      kanban_month = excluded.kanban_month, kanban_year = excluded.kanban_year,
      created_at = excluded.created_at, lead_created_at = excluded.lead_created_at,
      quote_signature_date = excluded.quote_signature_date,
      last_activity_at = excluded.last_activity_at,
      last_modified_at = excluded.last_modified_at,
      postal_code = excluded.postal_code, city = excluded.city,
      acquisition_channel = excluded.acquisition_channel,
      lead_source = excluded.lead_source, service = excluded.service,
      standby_until = excluded.standby_until, standby_flag = excluded.standby_flag,
      is_signed = excluded.is_signed, is_terminal = excluded.is_terminal,
      is_standby = excluded.is_standby, is_active = excluded.is_active,
      -- Réapparue dans la source : elle redevient une affaire ordinaire, et son
      -- état terminal est celui de son étape, comme pour toutes les autres.
      absent_since = NULL, absent_reason = NULL,
      last_import_id = excluded.last_import_id
  `);

  const upsertSnapshot = db.prepare(`
    INSERT INTO opportunity_snapshot (
      snapshot_date, opportunity_id, import_id, owner, gmv, stage, probability,
      kanban_raw, kanban_color, kanban_month, kanban_year,
      last_activity_at, standby_until, is_standby, is_signed, is_active,
      created_at, acquisition_channel, service
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, opportunity_id) DO UPDATE SET
      import_id = excluded.import_id, owner = excluded.owner, gmv = excluded.gmv,
      stage = excluded.stage, probability = excluded.probability,
      kanban_raw = excluded.kanban_raw, kanban_color = excluded.kanban_color,
      kanban_month = excluded.kanban_month, kanban_year = excluded.kanban_year,
      last_activity_at = excluded.last_activity_at, standby_until = excluded.standby_until,
      is_standby = excluded.is_standby, is_signed = excluded.is_signed,
      is_active = excluded.is_active, created_at = excluded.created_at,
      acquisition_channel = excluded.acquisition_channel, service = excluded.service
  `);

  // Second enregistrement, rattaché à l'import et non au jour. Deux imports le
  // même jour s'écrasent dans `opportunity_snapshot` ; ici ils coexistent, ce qui
  // rend les états intermédiaires reconstructibles. Écriture additive : l'ancienne
  // table continue d'être alimentée exactement comme avant.
  const insertRunSnapshot = db.prepare(`
    INSERT INTO opportunity_snapshot_run (
      import_id, opportunity_id, imported_at, snapshot_date, owner, gmv, stage, probability,
      kanban_raw, kanban_month, kanban_year, created_at, acquisition_channel, service,
      last_activity_at, standby_until, is_standby, is_signed, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(import_id, opportunity_id) DO UPDATE SET
      owner = excluded.owner, gmv = excluded.gmv, stage = excluded.stage,
      probability = excluded.probability, kanban_raw = excluded.kanban_raw,
      kanban_month = excluded.kanban_month, kanban_year = excluded.kanban_year,
      created_at = excluded.created_at, acquisition_channel = excluded.acquisition_channel,
      service = excluded.service, last_activity_at = excluded.last_activity_at,
      standby_until = excluded.standby_until, is_standby = excluded.is_standby,
      is_signed = excluded.is_signed, is_active = excluded.is_active
  `);
  const importedAt = new Date().toISOString();

  const bool = (value: boolean) => (value ? 1 : 0);

  // --- Réconciliation des disparitions.
  //
  // La source ne publie qu'un périmètre : six étapes pour l'API, le même
  // filtre pour l'export manuel. Une affaire abandonnée, annulée, ou reprise
  // par un commercial hors équipe n'y figure plus — elle n'est pas « modifiée »,
  // elle disparaît. Sans ce rapprochement, sa dernière étape connue restait
  // vraie en base pour toujours et elle continuait à peser dans le Forecast,
  // dans l'Expected et dans le Morning.
  //
  // On ne devine pas POURQUOI elle est sortie : on enregistre qu'elle n'est
  // plus publiée, à partir de quand, et on la retire du pipe actif. Sa dernière
  // étape connue est conservée telle quelle, jamais réécrite.
  const fetchedIds = new Set(
    result.rows.map((r) => r.opportunityId?.trim()).filter((id): id is string => Boolean(id)),
  );
  const keptIds = new Set(opportunities.map((o) => o.opportunityId));
  const known = db
    .prepare("SELECT opportunity_id, is_terminal, absent_since FROM opportunity")
    .all() as { opportunity_id: string; is_terminal: number; absent_since: string | null }[];

  const departures = known.filter(
    (k) => !keptIds.has(k.opportunity_id) && k.absent_since === null && Number(k.is_terminal) === 0,
  );
  const returned = known.filter((k) => keptIds.has(k.opportunity_id) && k.absent_since !== null);
  const stillActive = known.filter((k) => Number(k.is_terminal) === 0).length;
  const allowance = Math.max(MIN_DEPARTURE_ALLOWANCE, Math.round(stillActive * MAX_DEPARTURE_RATIO));
  // Une source vide ou tronquée ne doit jamais vider le pipe : on refuse alors
  // de réconcilier et on le dit, plutôt que de perdre l'état précédent.
  const reconcile = result.rows.length > 0 && departures.length <= allowance;
  if (!reconcile && departures.length > 0) {
    issues.push({
      message:
        `${departures.length} affaire(s) absente(s) de la source, au-delà du garde-fou de ${allowance} : ` +
        `sortie du pipe non appliquée, la source est probablement incomplète`,
    });
  }

  const markAbsent = db.prepare(
    `UPDATE opportunity
        SET absent_since = ?, absent_reason = ?, is_terminal = 1, is_active = 0
      WHERE opportunity_id = ?`,
  );

  db.exec("BEGIN");
  try {
    for (const o of opportunities) {
      upsertOpportunity.run(
        o.opportunityId, o.name, o.clientContact, o.clientEmail, o.owner, o.ownerRaw, o.gmv, o.stage, o.probability,
        o.kanbanRaw, o.kanbanColor, o.kanbanColorRaw, o.kanbanMonth, o.kanbanYear,
        o.createdAt, o.leadCreatedAt, o.quoteSignatureDate, o.lastActivityAt, o.lastModifiedAt,
        o.postalCode, o.city, o.acquisitionChannel, o.leadSource, o.service,
        o.standbyUntil, o.standbyFlag === null ? null : bool(o.standbyFlag),
        bool(o.isSigned), bool(o.isTerminal), bool(o.isStandby), bool(o.isActive),
        today, importId,
      );
      upsertSnapshot.run(
        today, o.opportunityId, importId, o.owner, o.gmv, o.stage, o.probability,
        o.kanbanRaw, o.kanbanColor, o.kanbanMonth, o.kanbanYear,
        o.lastActivityAt, o.standbyUntil, bool(o.isStandby), bool(o.isSigned), bool(o.isActive),
        o.createdAt, o.acquisitionChannel, o.service,
      );
      insertRunSnapshot.run(
        importId, o.opportunityId, importedAt, today, o.owner, o.gmv, o.stage, o.probability,
        o.kanbanRaw, o.kanbanMonth, o.kanbanYear, o.createdAt, o.acquisitionChannel, o.service,
        o.lastActivityAt, o.standbyUntil, bool(o.isStandby), bool(o.isSigned), bool(o.isActive),
      );
    }
    if (reconcile) {
      for (const d of departures) {
        markAbsent.run(
          today,
          fetchedIds.has(d.opportunity_id)
            ? "reprise par un commercial hors équipe"
            : "absente de la source : abandon, annulation ou étape hors périmètre",
          d.opportunity_id,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    importId,
    snapshotDate: today,
    fileName: result.fileName,
    totalRows: result.rows.length,
    teamRows: opportunities.length,
    activeRows,
    signedRows,
    standbyRows,
    ignoredRows,
    departedRows: reconcile ? departures.length : 0,
    returnedRows: returned.length,
    detectedFields: result.detectedFields,
    missingFields: result.missingFields,
    issues,
  };
}

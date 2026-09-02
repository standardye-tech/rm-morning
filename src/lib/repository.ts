/**
 * Lecture de la base : conversion des lignes SQLite vers le modèle métier.
 */

import { queryAll, queryOne, type Row } from "./db";
import type { ImportRun, Opportunity } from "./types";

const str = (value: Row[string]): string | null =>
  value === null || value === undefined ? null : String(value);
const int = (value: Row[string]): number | null =>
  value === null || value === undefined ? null : Number(value);
const bool = (value: Row[string]): boolean => Number(value) === 1;

function toOpportunity(row: Row): Opportunity {
  return {
    opportunityId: String(row.opportunity_id),
    name: str(row.name),
    clientContact: str(row.client_contact),
    clientEmail: str(row.client_email),
    owner: String(row.owner),
    ownerRaw: str(row.owner_raw),
    gmv: int(row.gmv),
    stage: str(row.stage),
    probability: int(row.probability),
    kanbanRaw: str(row.kanban_raw),
    kanbanColor: str(row.kanban_color),
    kanbanColorRaw: str(row.kanban_color_raw),
    kanbanMonth: int(row.kanban_month),
    kanbanYear: int(row.kanban_year),
    createdAt: str(row.created_at),
    leadCreatedAt: str(row.lead_created_at),
    quoteSignatureDate: str(row.quote_signature_date),
    lastActivityAt: str(row.last_activity_at),
    lastModifiedAt: str(row.last_modified_at),
    postalCode: str(row.postal_code),
    city: str(row.city),
    acquisitionChannel: str(row.acquisition_channel),
    leadSource: str(row.lead_source),
    service: str(row.service),
    standbyUntil: str(row.standby_until),
    standbyFlag: row.standby_flag === null || row.standby_flag === undefined ? null : bool(row.standby_flag),
    isSigned: bool(row.is_signed),
    isTerminal: bool(row.is_terminal),
    absentSince: str(row.absent_since),
    absentReason: str(row.absent_reason),
    isStandby: bool(row.is_standby),
    isActive: bool(row.is_active),
  };
}

/** Toutes les opportunités de l'équipe présentes en base. */
export function loadOpportunities(): Opportunity[] {
  return queryAll<Row>("SELECT * FROM opportunity").map(toOpportunity);
}

function toImportRun(row: Row): ImportRun {
  const parse = <T>(value: Row[string], fallback: T): T => {
    try {
      return JSON.parse(String(value ?? "")) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: Number(row.id),
    importedAt: String(row.imported_at),
    snapshotDate: String(row.snapshot_date),
    sourceKind: String(row.source_kind),
    sourceLabel: String(row.source_label),
    fileName: str(row.file_name),
    totalRows: Number(row.total_rows),
    teamRows: Number(row.team_rows),
    activeRows: Number(row.active_rows),
    signedRows: Number(row.signed_rows),
    standbyRows: Number(row.standby_rows),
    detectedFields: parse<string[]>(row.detected_fields, []),
    missingFields: parse<string[]>(row.missing_fields, []),
    rawHeaders: parse<string[]>(row.raw_headers, []),
    issues: parse<ImportRun["issues"]>(row.issues, []),
  };
}

/**
 * Dernier import D'OPPORTUNITÉS.
 *
 * Le journal mêle trois natures d'import : opportunités (`api`, `manual`) et
 * pistes (`leads-api`). Prendre le dernier tout court faisait présenter
 * l'horodatage d'un import de pistes comme étant l'état des opportunités — la
 * date affichée sous « Données Salesforce » pouvait donc être postérieure à
 * l'état réellement chargé.
 *
 * `imported_at` est l'instant où la donnée a été LUE dans Salesforce, pas celui
 * où elle a été appliquée en base. C'est bien ce qu'il faut afficher comme
 * fraîcheur, mais cela ne permet pas de dater une modification de la base : pour
 * cela, seul l'ordre des `id` fait foi.
 */
export function latestImport(): ImportRun | null {
  const row = queryOne<Row>(
    "SELECT * FROM import_run WHERE source_kind IN ('api', 'manual') ORDER BY id DESC LIMIT 1",
  );
  return row ? toImportRun(row) : null;
}

/** Dernier import toutes natures confondues, pour la page Données. */
export function latestImportAnyKind(): ImportRun | null {
  const row = queryOne<Row>("SELECT * FROM import_run ORDER BY id DESC LIMIT 1");
  return row ? toImportRun(row) : null;
}

export function listImports(limit = 30): ImportRun[] {
  return queryAll<Row>("SELECT * FROM import_run ORDER BY id DESC LIMIT ?", limit).map(toImportRun);
}

export type SnapshotDay = {
  snapshotDate: string;
  opportunities: number;
  activeOpportunities: number;
  activeGmv: number;
  signedOpportunities: number;
  standbyOpportunities: number;
};

/** Une ligne agrégée par jour d'historique, la plus récente d'abord. */
export function listSnapshotDays(limit = 30): SnapshotDay[] {
  return queryAll<Row>(
    `SELECT snapshot_date,
            COUNT(*)                                              AS opportunities,
            SUM(is_active)                                        AS active_opportunities,
            COALESCE(SUM(CASE WHEN is_active = 1 THEN gmv END),0) AS active_gmv,
            SUM(is_signed)                                        AS signed_opportunities,
            SUM(is_standby)                                       AS standby_opportunities
       FROM opportunity_snapshot
      GROUP BY snapshot_date
      ORDER BY snapshot_date DESC
      LIMIT ?`,
    limit,
  ).map((row) => ({
    snapshotDate: String(row.snapshot_date),
    opportunities: Number(row.opportunities),
    activeOpportunities: Number(row.active_opportunities),
    activeGmv: Number(row.active_gmv),
    signedOpportunities: Number(row.signed_opportunities),
    standbyOpportunities: Number(row.standby_opportunities),
  }));
}

export type SnapshotLine = {
  opportunityId: string;
  owner: string;
  gmv: number | null;
  stage: string | null;
  kanbanRaw: string | null;
  kanbanMonth: number | null;
  kanbanYear: number | null;
  isStandby: boolean;
  isSigned: boolean;
  isActive: boolean;
};

/** Snapshot d'un jour donné, indexé par opportunité. */
export function loadSnapshot(snapshotDate: string): Map<string, SnapshotLine> {
  const rows = queryAll<Row>(
    "SELECT * FROM opportunity_snapshot WHERE snapshot_date = ?",
    snapshotDate,
  );
  return new Map(
    rows.map((row) => [
      String(row.opportunity_id),
      {
        opportunityId: String(row.opportunity_id),
        owner: String(row.owner),
        gmv: int(row.gmv),
        stage: str(row.stage),
        kanbanRaw: str(row.kanban_raw),
        kanbanMonth: int(row.kanban_month),
        kanbanYear: int(row.kanban_year),
        isStandby: bool(row.is_standby),
        isSigned: bool(row.is_signed),
        isActive: bool(row.is_active),
      },
    ]),
  );
}

/**
 * Date du snapshot le plus récent strictement antérieur à `before`,
 * et pas plus ancien que `notBefore` si fourni.
 */
export function previousSnapshotDate(before: string, notBefore?: string): string | null {
  const row = notBefore
    ? queryOne<Row>(
        `SELECT snapshot_date FROM opportunity_snapshot
          WHERE snapshot_date < ? AND snapshot_date >= ?
          ORDER BY snapshot_date DESC LIMIT 1`,
        before,
        notBefore,
      )
    : queryOne<Row>(
        `SELECT snapshot_date FROM opportunity_snapshot
          WHERE snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1`,
        before,
      );
  return row ? String(row.snapshot_date) : null;
}

// --- Snapshots de forecast (Google Sheet) --------------------------------

export type ForecastLine = {
  snapshotDate: string;
  forecastMonth: string;
  rowKey: string;
  opportunityId: string | null;
  salesperson: string;
  opportunityLabel: string | null;
  confidence: number | null;
  gmv: number | null;
  ca: number | null;
  projectedGmv: number | null;
  state: string | null;
};

function toForecastLine(row: Row): ForecastLine {
  return {
    snapshotDate: String(row.snapshot_date),
    forecastMonth: String(row.forecast_month),
    rowKey: String(row.row_key),
    opportunityId: str(row.opportunity_id),
    salesperson: String(row.salesperson),
    opportunityLabel: str(row.opportunity_label),
    confidence: int(row.confidence),
    gmv: int(row.gmv),
    ca: int(row.ca),
    projectedGmv: int(row.projected_gmv),
    state: str(row.state),
  };
}

/**
 * Dates de snapshot disponibles pour un mois forecasté, de la plus récente à la
 * plus ancienne, en excluant strictement toute date postérieure à `onOrBefore`.
 * Un snapshot futur ne doit jamais être retenu.
 */
export function forecastSnapshotDates(forecastMonth: string, onOrBefore: string): string[] {
  return queryAll<Row>(
    `SELECT DISTINCT snapshot_date FROM forecast_snapshot
      WHERE forecast_month = ? AND snapshot_date <= ?
      ORDER BY snapshot_date DESC`,
    forecastMonth,
    onOrBefore,
  ).map((row) => String(row.snapshot_date));
}

/** Lignes d'un snapshot donné, pour un mois forecasté. */
export function loadForecastSnapshot(
  forecastMonth: string,
  snapshotDate: string,
): ForecastLine[] {
  return queryAll<Row>(
    `SELECT * FROM forecast_snapshot
      WHERE forecast_month = ? AND snapshot_date = ?`,
    forecastMonth,
    snapshotDate,
  ).map(toForecastLine);
}

/**
 * ÉTAT COURANT du forecast pour un mois — bloc « EN COURS » du classeur.
 *
 * Rendu dans la même forme qu'un snapshot pour être interchangeable côté
 * appelant, avec `snapshotDate` porté à la DATE du « MAJ le ». Ce n'est pas une
 * date de snapshot et rien ne l'écrit dans `forecast_snapshot` : c'est
 * uniquement la date à laquelle cet état a été constaté.
 */
export function loadForecastCurrent(forecastMonth: string): ForecastLine[] {
  return queryAll<Row>(
    "SELECT * FROM forecast_current WHERE forecast_month = ?",
    forecastMonth,
  ).map((row) => ({
    ...toForecastLine({ ...row, snapshot_date: String(row.updated_at ?? "").slice(0, 10) }),
  }));
}

/** Fraîcheur annoncée par le classeur pour l'état courant d'un mois. */
export function forecastCurrentUpdatedAt(forecastMonth?: string): string | null {
  const row = forecastMonth
    ? queryOne<Row>(
        "SELECT MAX(updated_at) AS at FROM forecast_current WHERE forecast_month = ?",
        forecastMonth,
      )
    : queryOne<Row>("SELECT MAX(updated_at) AS at FROM forecast_current");
  return row?.at ? String(row.at) : null;
}

export type ForecastImportInfo = {
  source: string;
  importedAt: string;
  months: string[];
  snapshotDates: string[];
  lines: number;
};

/** Résumé du dernier import de forecast présent en base. */
export function latestForecastImport(): ForecastImportInfo | null {
  const head = queryOne<Row>(
    "SELECT source, MAX(imported_at) AS imported_at, COUNT(*) AS lines FROM forecast_snapshot",
  );
  if (!head || head.imported_at === null) return null;

  const months = queryAll<Row>(
    "SELECT DISTINCT forecast_month FROM forecast_snapshot ORDER BY forecast_month",
  ).map((r) => String(r.forecast_month));
  const dates = queryAll<Row>(
    "SELECT DISTINCT snapshot_date FROM forecast_snapshot ORDER BY snapshot_date",
  ).map((r) => String(r.snapshot_date));

  return {
    source: String(head.source ?? "inconnue"),
    importedAt: String(head.imported_at),
    months,
    snapshotDates: dates,
    lines: Number(head.lines),
  };
}

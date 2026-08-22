/**
 * Parseur d'un onglet mensuel du Sheet de forecast.
 *
 * C'est le seul fichier qui connaît la disposition du classeur. Les deux
 * sources (HTTP et fichier local) lui passent le même CSV.
 *
 * Disposition constatée lors de l'audit du 16/08/2026 :
 *   — un en-tête de tableau repérable par la cellule « ID Opp » ;
 *   — juste au-dessus, une ligne d'étiquettes fusionnées « Snapshot 5 — 2026-08-10 » ;
 *   — 7 colonnes fixes : ID Opp, DR, Sales, Opportunité, Apporteur, Canal, LeadSource ;
 *   — puis, par snapshot, 6 colonnes : Confiance, GMV, CA, GMV × conf., CA × conf., État.
 *
 * On ne suppose ni le nombre de colonnes fixes, ni la largeur des blocs : les
 * blocs sont repérés par les occurrences de « Confiance » dans l'en-tête, et
 * chaque sous-colonne par son libellé. Un onglet qui gagnerait une colonne
 * continuerait donc d'être lu correctement.
 */

import { normalizeKey, parseFrenchNumber } from "../normalize";
import type { ParseIssue } from "./salesforce";
import type { ForecastSnapshotLine } from "./forecast-snapshot";

/** Découpe un CSV (RFC 4180 : guillemets, virgules et sauts de ligne échappés). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const body = text.replace(/^﻿/, "");

  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const cell = (grid: string[][], r: number, c: number): string =>
  (grid[r]?.[c] ?? "").replace(/\s+/gu, " ").trim();

/** Colonnes fixes reconnues, par libellé normalisé. */
const FIXED_COLUMNS: Record<string, keyof FixedIndexes> = {
  idopp: "id",
  dr: "region",
  sales: "salesperson",
  opportunite: "label",
};

type FixedIndexes = {
  id?: number;
  region?: number;
  salesperson?: number;
  label?: number;
};

/** Sous-colonnes d'un bloc de snapshot, par libellé normalisé. */
const BLOCK_COLUMNS: Record<string, keyof BlockIndexes> = {
  confiance: "confidence",
  gmv: "gmv",
  ca: "ca",
  gmvconf: "projectedGmv",
  caconf: "projectedCa",
  etat: "state",
};

type BlockIndexes = {
  confidence?: number;
  gmv?: number;
  ca?: number;
  projectedGmv?: number;
  projectedCa?: number;
  state?: number;
};

/** « 30% » → 0.3 ; « 0,3 » → 0.3 ; « 30 » → 0.3. */
function parseConfidence(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = parseFrenchNumber(text.replace("%", ""));
  if (value === null) return null;
  if (text.includes("%")) return value / 100;
  return value > 1 ? value / 100 : value;
}

/** Normalise un ID Salesforce sur 15 caractères, forme commune aux deux sources. */
export function normalizeOpportunityId(raw: string | null): string | null {
  const text = (raw ?? "").trim();
  if (!/^[a-zA-Z0-9]{15,18}$/.test(text)) return null;
  return text.slice(0, 15);
}

export type SheetParseResult = {
  lines: ForecastSnapshotLine[];
  snapshotDates: string[];
  issues: ParseIssue[];
};

/**
 * Lit un onglet mensuel au format CSV et produit une ligne par
 * (opportunité × snapshot). `forecastMonth` est le nom de l'onglet.
 */
export function parseForecastSheet(csv: string, forecastMonth: string): SheetParseResult {
  return parseForecastGrid(parseCsv(csv), forecastMonth);
}

/**
 * Cœur du parsing, sur une grille de cellules déjà découpée. L'API Sheets la
 * fournit directement ; la source CSV passe par `parseCsv` d'abord.
 */
export function parseForecastGrid(grid: string[][], forecastMonth: string): SheetParseResult {
  const issues: ParseIssue[] = [];

  // 1. Ligne d'en-tête : celle qui porte « ID Opp ».
  const headerRow = grid.findIndex((row) =>
    row.some((c) => normalizeKey(c) === "idopp"),
  );
  if (headerRow < 0) {
    return {
      lines: [],
      snapshotDates: [],
      issues: [
        { message: `Onglet ${forecastMonth} : en-tête « ID Opp » introuvable, onglet ignoré.` },
      ],
    };
  }

  const width = Math.max(...grid.slice(headerRow).map((r) => r.length), 0);

  // 2. Blocs de snapshot : chaque occurrence de « Confiance » ouvre un bloc.
  const blockStarts: number[] = [];
  for (let c = 0; c < width; c++) {
    if (normalizeKey(cell(grid, headerRow, c)) === "confiance") blockStarts.push(c);
  }
  if (blockStarts.length === 0) {
    return {
      lines: [],
      snapshotDates: [],
      issues: [
        { message: `Onglet ${forecastMonth} : aucun bloc de snapshot (colonne « Confiance »).` },
      ],
    };
  }

  // 3. Colonnes fixes, avant le premier bloc.
  const fixed: FixedIndexes = {};
  for (let c = 0; c < blockStarts[0]; c++) {
    const key = FIXED_COLUMNS[normalizeKey(cell(grid, headerRow, c))];
    if (key && fixed[key] === undefined) fixed[key] = c;
  }
  if (fixed.id === undefined) {
    issues.push({ message: `Onglet ${forecastMonth} : colonne « ID Opp » non localisée.` });
  }

  // 4. Date de chaque bloc : étiquette fusionnée la plus proche à gauche, sur la
  //    ligne au-dessus de l'en-tête. En CSV, une fusion n'écrit la valeur qu'une
  //    fois ; dans d'autres rendus elle est répétée. Les deux cas fonctionnent.
  const labelRow = headerRow - 1;
  const datePattern = /Snapshot\s*\d*\s*[—–-]?\s*(\d{4}-\d{2}-\d{2})/i;

  const blocks = blockStarts.map((start, index) => {
    const end = blockStarts[index + 1] ?? width;

    let snapshotDate: string | null = null;
    for (let c = end - 1; c >= 0 && snapshotDate === null; c--) {
      const match = cell(grid, labelRow, c).match(datePattern);
      if (match) snapshotDate = match[1];
    }

    const columns: BlockIndexes = {};
    for (let c = start; c < end; c++) {
      const key = BLOCK_COLUMNS[normalizeKey(cell(grid, headerRow, c))];
      if (key && columns[key] === undefined) columns[key] = c;
    }

    return { start, end, snapshotDate, columns };
  });

  for (const block of blocks) {
    if (!block.snapshotDate) {
      issues.push({
        message: `Onglet ${forecastMonth} : bloc en colonne ${block.start + 1} sans date de snapshot, ignoré.`,
      });
    }
  }

  // 5. Lignes d'opportunités.
  const lines: ForecastSnapshotLine[] = [];
  const snapshotDates = new Set<string>();

  for (let r = headerRow + 1; r < grid.length; r++) {
    const rawId = fixed.id === undefined ? "" : cell(grid, r, fixed.id);
    const labelText = fixed.label === undefined ? "" : cell(grid, r, fixed.label);
    const salesperson = fixed.salesperson === undefined ? "" : cell(grid, r, fixed.salesperson);

    // Ligne vide ou ligne de total : ni identifiant ni libellé exploitable.
    if (!rawId && !labelText) continue;

    const opportunityId = normalizeOpportunityId(rawId);
    if (rawId && !opportunityId) {
      issues.push({
        row: r + 1,
        message: `Onglet ${forecastMonth} : identifiant inattendu « ${rawId} », ligne rattachée par libellé.`,
      });
    }
    const rowKey = opportunityId ?? `label:${normalizeKey(labelText) || `ligne-${r}`}`;

    for (const block of blocks) {
      if (!block.snapshotDate) continue;

      const at = (key: keyof BlockIndexes): string =>
        block.columns[key] === undefined ? "" : cell(grid, r, block.columns[key]!);

      const confidence = parseConfidence(at("confidence"));
      const gmv = parseFrenchNumber(at("gmv"));
      const ca = parseFrenchNumber(at("ca"));
      const projectedGmv = parseFrenchNumber(at("projectedGmv"));
      const state = at("state") || null;

      // Un bloc entièrement vide signifie que l'affaire n'existait pas encore
      // à ce snapshot : on ne crée pas de ligne fantôme.
      if (confidence === null && gmv === null && projectedGmv === null && !state) continue;

      snapshotDates.add(block.snapshotDate);
      lines.push({
        snapshotDate: block.snapshotDate,
        forecastMonth,
        opportunityId,
        rowKey,
        salespersonRaw: salesperson || null,
        region: fixed.region === undefined ? null : cell(grid, r, fixed.region) || null,
        opportunityLabel: labelText || null,
        confidence,
        gmv,
        ca,
        projectedGmv: projectedGmv ?? (gmv !== null && confidence !== null ? gmv * confidence : null),
        state,
      });
    }
  }

  return { lines, snapshotDates: [...snapshotDates].sort(), issues };
}

/** Fenêtre d'onglets mensuels à lire, centrée sur le mois de `referenceDate`. */
export function forecastMonthsAround(
  referenceDate: string,
  back: number,
  forward: number,
): string[] {
  const [year, month] = referenceDate.split("-").map(Number);
  const months: string[] = [];
  for (let offset = -back; offset <= forward; offset++) {
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    months.push(
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  return months;
}

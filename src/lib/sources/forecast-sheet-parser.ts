/**
 * Parseur d'un onglet mensuel du Sheet de forecast.
 *
 * C'est le seul fichier qui connaît la disposition du classeur. Les deux
 * sources (HTTP et fichier local) lui passent le même CSV.
 *
 * Disposition constatée lors de l'audit du 16/08/2026, revue le 02/09/2026 :
 *   — un en-tête de tableau repérable par la cellule « ID Opp » ;
 *   — juste au-dessus, une ligne d'étiquettes fusionnées, de DEUX natures :
 *       « Snapshot 5 — 2026-08-10 »            photographie hebdomadaire figée,
 *       « EN COURS — MAJ le 02/09/2026 08:00 » état du jour, rafraîchi chaque jour ;
 *   — 7 colonnes fixes : ID Opp, DR, Sales, Opportunité, Apporteur, Canal, LeadSource ;
 *   — puis, par bloc, 6 à 7 colonnes : Confiance, GMV, CA, GMV × conf.,
 *     CA × conf., État, et depuis le remaniement d'août 2026 Commentaire.
 *
 * On ne suppose ni le nombre de colonnes fixes, ni la largeur des blocs : les
 * blocs sont repérés par les occurrences de « Confiance » dans l'en-tête, et
 * chaque sous-colonne par son libellé. Un onglet qui gagnerait une colonne
 * continuerait donc d'être lu correctement — c'est ce qui a permis d'absorber
 * « Commentaire » sans rien changer.
 *
 * Le parseur rend les deux natures SÉPARÉMENT : `lines` pour l'historique figé,
 * `currentLines` pour l'état du jour. Rien ne les mélange.
 */

import { normalizeKey, parseFrenchNumber } from "../normalize";
import type { ParseIssue } from "./salesforce";
import type { ForecastCurrentLine, ForecastSnapshotLine } from "./forecast-snapshot";

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

/**
 * Anomalie CANDIDATE portant sur une ligne précise.
 *
 * Elle n'est pas encore une anomalie : le parseur ne sait pas si la ligne est
 * dans le périmètre. C'est l'import qui tranche, une fois le commercial et le
 * territoire connus — voir `forecast-import.ts`. Une ligne hors équipe ou hors
 * territoire est écartée sans jamais être signalée.
 */
export type SheetRowIssue = {
  /** Numéro de ligne dans l'onglet, tel qu'affiché par le tableur. */
  row: number;
  forecastMonth: string;
  salespersonRaw: string | null;
  opportunityId: string | null;
  opportunityLabel: string | null;
  message: string;
};

export type SheetParseResult = {
  /** Snapshots hebdomadaires figés. */
  lines: ForecastSnapshotLine[];
  /** État courant, issu du bloc « EN COURS ». Jamais mélangé aux snapshots. */
  currentLines: ForecastCurrentLine[];
  snapshotDates: string[];
  /** « MAJ le » le plus récent rencontré, ou null. */
  currentUpdatedAt: string | null;
  /** Anomalies de STRUCTURE de l'onglet : toujours réelles, jamais filtrées. */
  issues: ParseIssue[];
  /** Anomalies de ligne, à confirmer par l'import une fois le périmètre connu. */
  rowIssues: SheetRowIssue[];
};

/**
 * DEUX NATURES DE BLOC, qu'il ne faut jamais confondre.
 *
 *   HISTORIQUE — « Snapshot 4 — 2026-08-31 »
 *     Photographie hebdomadaire FIGÉE. Elle ne bouge plus jamais.
 *
 *   COURANT — « EN COURS — MAJ le 02/09/2026 08:00 »
 *     L'état du jour, rafraîchi quotidiennement par le classeur. C'est la
 *     donnée la plus fraîche dont on dispose, et elle DOIT être exploitée —
 *     mais ce n'est pas un snapshot : demain elle est remplacée, alors qu'un
 *     snapshot du 31/08 reste celui du 31/08 pour toujours.
 *
 * Le bloc courant est donc lu, daté par son propre « MAJ le », et rangé à part
 * (table `forecast_current`). Il ne peut ni hériter de la date d'un snapshot
 * voisin, ni en écraser un.
 */
const CURRENT_BLOCK_PATTERN = /^EN\s+COURS\b/i;

/** « MAJ le 02/09/2026 08:00 » → « 2026-09-02T08:00 », trié comme du texte. */
const UPDATED_AT_PATTERN =
  /MAJ\s+le\s+(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2})[:h](\d{2}))?/i;

function parseUpdatedAt(label: string): string | null {
  const match = label.match(UPDATED_AT_PATTERN);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  const time = hour ? `T${hour.padStart(2, "0")}:${minute}` : "T00:00";
  return `${year}-${month}-${day}${time}`;
}

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
  // `normalizeKey(c)` et non `c` : l'API Sheets peut rendre des lignes courtes,
  // et un rendu tiers une cellule absente. On ne veut pas planter sur un trou.
  const headerRow = grid.findIndex((row) =>
    row.some((c) => normalizeKey(c ?? "") === "idopp"),
  );
  if (headerRow < 0) {
    return {
      lines: [],
      currentLines: [],
      snapshotDates: [],
      currentUpdatedAt: null,
      rowIssues: [],
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
      currentLines: [],
      snapshotDates: [],
      currentUpdatedAt: null,
      rowIssues: [],
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

  // 4. Étiquette de chaque bloc, sur la ligne au-dessus de l'en-tête.
  //
  //    ELLE EST CHERCHÉE DANS LES SEULES COLONNES DU BLOC. Le balayage allait
  //    autrefois jusqu'à la colonne A : un bloc dépourvu d'étiquette héritait
  //    silencieusement de la date du bloc précédent. C'est exactement ce qui
  //    arrivait au bloc « EN COURS » de 2026-09 et 2026-10, importé sous la date
  //    du dernier lundi — et qui, la clé étant (date, mois, ligne), ÉCRASAIT le
  //    vrai snapshot de ce lundi par des valeurs de milieu de semaine.
  //
  //    En CSV, une fusion n'écrit la valeur qu'une fois, à sa première colonne ;
  //    dans d'autres rendus elle est répétée. Les deux cas fonctionnent.
  const labelRow = headerRow - 1;
  const datePattern = /Snapshot\s*\d*\s*[—–-]?\s*(\d{4}-\d{2}-\d{2})/i;

  const blocks = blockStarts.map((start, index) => {
    const end = blockStarts[index + 1] ?? width;

    let label = "";
    for (let c = start; c < end && !label; c++) label = cell(grid, labelRow, c);

    const columns: BlockIndexes = {};
    for (let c = start; c < end; c++) {
      const key = BLOCK_COLUMNS[normalizeKey(cell(grid, headerRow, c))];
      if (key && columns[key] === undefined) columns[key] = c;
    }

    const current = CURRENT_BLOCK_PATTERN.test(label);
    return {
      start,
      end,
      label,
      /** « snapshot » = photographie figée ; « current » = état du jour. */
      kind: current ? ("current" as const) : ("snapshot" as const),
      snapshotDate: current ? null : (label.match(datePattern)?.[1] ?? null),
      /** Horodatage du bloc courant. Null si le classeur ne l'a pas écrit. */
      updatedAt: current ? parseUpdatedAt(label) : null,
      columns,
    };
  });

  for (const block of blocks) {
    // Un bloc courant est exploitable même sans « MAJ le » lisible : l'import
    // le datera de l'heure de lecture. Ce n'est donc pas une anomalie.
    if (block.kind === "current" || block.snapshotDate) continue;
    issues.push({
      message:
        `Onglet ${forecastMonth} : bloc en colonne ${block.start + 1} sans date de snapshot` +
        `${block.label ? ` (« ${block.label} »)` : ""}, ignoré.`,
    });
  }

  // 5. Lignes d'opportunités.
  const lines: ForecastSnapshotLine[] = [];
  const currentLines: ForecastCurrentLine[] = [];
  const rowIssues: SheetRowIssue[] = [];
  const snapshotDates = new Set<string>();
  const currentUpdatedAt = new Set<string>();

  for (let r = headerRow + 1; r < grid.length; r++) {
    const rawId = fixed.id === undefined ? "" : cell(grid, r, fixed.id);
    const labelText = fixed.label === undefined ? "" : cell(grid, r, fixed.label);
    const salesperson = fixed.salesperson === undefined ? "" : cell(grid, r, fixed.salesperson);

    // Ligne vide ou ligne de total : ni identifiant ni libellé exploitable.
    if (!rawId && !labelText) continue;

    const opportunityId = normalizeOpportunityId(rawId);
    if (rawId && !opportunityId) {
      // CANDIDATE, pas encore une anomalie : l'import ne la retiendra que si la
      // ligne appartient bien au périmètre RM Morning.
      rowIssues.push({
        row: r + 1,
        forecastMonth,
        salespersonRaw: salesperson || null,
        opportunityId: null,
        opportunityLabel: labelText || null,
        message: `identifiant inattendu « ${rawId} », ligne rattachée par libellé`,
      });
    }
    const rowKey = opportunityId ?? `label:${normalizeKey(labelText) || `ligne-${r}`}`;

    for (const block of blocks) {
      // Un bloc historique sans date reste inexploitable ; un bloc courant, lui,
      // est toujours exploitable — c'est l'état du jour.
      if (block.kind === "snapshot" && !block.snapshotDate) continue;

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

      const common = {
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
      };

      // ÉTAT COURANT — rangé à part, jamais daté d'un lundi qu'il ne décrit pas.
      if (block.kind === "current") {
        currentLines.push({ ...common, updatedAt: block.updatedAt });
        if (block.updatedAt) currentUpdatedAt.add(block.updatedAt);
        continue;
      }

      // SNAPSHOT HISTORIQUE — figé, et daté par sa seule étiquette.
      snapshotDates.add(block.snapshotDate!);
      lines.push({ ...common, snapshotDate: block.snapshotDate! });
    }
  }

  return {
    lines,
    currentLines,
    snapshotDates: [...snapshotDates].sort(),
    currentUpdatedAt: [...currentUpdatedAt].sort().pop() ?? null,
    issues,
    rowIssues,
  };
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

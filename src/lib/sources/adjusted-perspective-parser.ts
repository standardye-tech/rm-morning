/**
 * Parseur du classeur manuel « Perspectives M+1 (> 50 % de probabilité) ».
 *
 * Ce classeur est tenu à la main par la Région : c'est la source de « Perspective
 * ajustée ». Module PUR (aucune dépendance base ni réseau) : il reçoit des grilles
 * de cellules et rend des nombres.
 *
 * DISPOSITION constatée le 20/09/2026, un onglet par mois CIBLE :
 *   — A commercial (renseigné en tête de groupe seulement), B client, C source,
 *     D URL Opportunity, E CA, F GMV, G statut manuel ;
 *   — des blocs de snapshot de 3 colonnes `Proba | CA | GMV`, chacun coiffé d'une
 *     date, ajoutés au fil des semaines (31/08, 07/09, 14/09, 21/09…) ;
 *   — plus bas, un tableau de synthèse (« SAMI », « Forecast <mois> »,
 *     « OBJECTIF »…) recopié d'anciens gabarits : ses libellés sont FAUX
 *     (« Forecast Janvier » dans l'onglet d'octobre) et ne sont jamais lus.
 *
 * RÈGLES :
 *   — le mois d'un onglet est celui de son NOM, jamais celui du nom du classeur ;
 *   — les blocs sont repérés par la date puis par les libellés Proba/CA/GMV,
 *     jamais par un numéro de ligne ni de colonne ;
 *   — le snapshot retenu est le dernier qui porte réellement des chiffres, pas le
 *     dernier daté : le bloc de la semaine à venir existe déjà, vide ;
 *   — sans snapshot renseigné, la GMV de la liste manuelle (colonne F) tient lieu de
 *     valeur pour un mois futur, jamais pour le mois courant (sa colonne F liste
 *     alors tout le pipe, pas la sélection à plus de 50 %).
 */

import { matchTeamMember, normalizeKey } from "../normalize";

export type Cell = string | number | null | undefined;
export type Grid = Cell[][];

export type AdjustedPerspective = {
  /** Mois cible « AAAA-MM », celui de l'onglet. */
  month: string;
  gmv: number;
  source: "snapshot" | "selection";
  /** Date du snapshot retenu, « AAAA-MM-JJ ». Nulle pour une sélection manuelle. */
  snapshotDate: string | null;
  /** Lignes d'affaires comptées. */
  count: number;
  /** GMV par membre de l'équipe ; les lignes hors équipe ne figurent que dans `gmv`. */
  byOwner: Record<string, number>;
  /** Snapshots datés vus dans l'onglet, renseignés ou non — pour l'audit. */
  snapshots: { date: string; filled: boolean; gmv: number }[];
};

const MONTHS = [
  "janvier", "fevrier", "mars", "avril", "mai", "juin",
  "juillet", "aout", "septembre", "octobre", "novembre", "decembre",
];
const TAB_PATTERN = new RegExp(`^(${MONTHS.join("|")})(\\d{4})$`);

/**
 * Mois « AAAA-MM » désigné par le NOM d'un onglet, ou null. Tolère la casse, les
 * accents, les espaces parasites (« Novembre 2024 ») et « Aout ». Les onglets
 * « Copie de … » ou abrégés (« Jui 2023 ») sont ignorés : mieux vaut n'en lire
 * aucun que deviner.
 */
export function tabMonth(title: string): string | null {
  const m = TAB_PATTERN.exec(normalizeKey(title));
  if (!m) return null;
  return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}`;
}

/** Choisit l'onglet d'un mois. Deux onglets pour le même mois : aucun n'est lu. */
export function pickTab(titles: string[], month: string): { title: string | null; issue: string | null } {
  const found = titles.filter((t) => tabMonth(t) === month);
  if (found.length === 0) return { title: null, issue: `aucun onglet pour ${month}` };
  if (found.length > 1) return { title: null, issue: `plusieurs onglets pour ${month} : ${found.join(", ")}` };
  return { title: found[0], issue: null };
}

const text = (c: Cell): string => (c == null ? "" : String(c).replace(/\s+/gu, " ").trim());
const key = (c: Cell): string => normalizeKey(text(c));
const num = (c: Cell): number | null => (typeof c === "number" && Number.isFinite(c) ? c : null);

/** Date d'en-tête : numéro de série Sheets, « AAAA-MM-JJ » ou « JJ/MM/AAAA ». */
export function parseHeaderDate(c: Cell): string | null {
  if (typeof c === "number") {
    if (c < 30000 || c > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(c) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = text(c);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

type Block = { date: string; proba: number; ca: number; gmv: number };

/** Blocs `Proba | CA | GMV` : trois libellés consécutifs, la date au-dessus. */
function findBlocks(grid: Grid): Block[] {
  const blocks: Block[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c + 2 < row.length; c++) {
      if (!["proba", "probabilite"].includes(key(row[c])) || key(row[c + 1]) !== "ca" || key(row[c + 2]) !== "gmv") continue;
      let date: string | null = null;
      for (let up = r - 1; up >= Math.max(0, r - 3) && !date; up--) {
        for (let k = c; k <= c + 2 && !date; k++) date = parseHeaderDate(grid[up]?.[k]);
      }
      if (date) blocks.push({ date, proba: c, ca: c + 1, gmv: c + 2 });
    }
  }
  return blocks;
}

const SUMMARY_LABEL = /^(forecast|objectif|signature|dontprovision|moinsvalue|restantasigner|national|sami)/;

type DealRow = { owner: string | null; ownerRaw: string; client: string; row: Cell[] };

/** Lignes d'affaires : un client renseigné, sous l'en-tête, avant le tableau de synthèse. */
function findDeals(grid: Grid): DealRow[] {
  const deals: DealRow[] = [];
  let ownerRaw = "";
  let started = false;
  for (const row of grid) {
    const a = text(row?.[0]);
    const b = text(row?.[1]);
    if (started && (SUMMARY_LABEL.test(normalizeKey(a)) && !b)) break;
    if (a && !SUMMARY_LABEL.test(normalizeKey(a))) ownerRaw = a;
    if (!b || /^moinsvalue/.test(normalizeKey(b))) continue;
    if (!ownerRaw) continue;
    started = true;
    deals.push({ owner: matchTeamMember(ownerRaw)?.name ?? null, ownerRaw, client: b, row: row ?? [] });
  }
  return deals;
}

/** Index de la colonne de base « GMV » (F) : repérée par son libellé, F par défaut. */
const BASE_GMV_COL = 5;

/**
 * Lit un onglet. `allowSelection` autorise le repli sur la liste manuelle quand
 * aucun snapshot n'est renseigné (mois futur seulement).
 */
export function parseAdjustedTab(
  grid: Grid,
  month: string,
  opts: { allowSelection: boolean },
): AdjustedPerspective | null {
  const deals = findDeals(grid);
  const blocks = findBlocks(grid).sort((a, b) => a.date.localeCompare(b.date));

  const summarise = (col: number) => {
    let gmv = 0;
    let count = 0;
    const byOwner: Record<string, number> = {};
    for (const d of deals) {
      const v = num(d.row[col]);
      if (v == null) continue;
      gmv += v;
      count += 1;
      if (d.owner) byOwner[d.owner] = (byOwner[d.owner] ?? 0) + v;
    }
    return { gmv, count, byOwner };
  };

  const snapshots = blocks.map((b) => {
    const s = summarise(b.gmv);
    return { block: b, ...s, filled: s.count > 0 };
  });
  const seen = snapshots.map((s) => ({ date: s.block.date, filled: s.filled, gmv: s.gmv }));

  const latest = [...snapshots].reverse().find((s) => s.filled);
  if (latest) {
    return {
      month,
      gmv: latest.gmv,
      source: "snapshot",
      snapshotDate: latest.block.date,
      count: latest.count,
      byOwner: latest.byOwner,
      snapshots: seen,
    };
  }
  if (!opts.allowSelection) return null;
  const sel = summarise(BASE_GMV_COL);
  if (sel.count === 0) return null;
  return { month, gmv: sel.gmv, source: "selection", snapshotDate: null, count: sel.count, byOwner: sel.byOwner, snapshots: seen };
}

/**
 * Normalisation des valeurs brutes Salesforce : texte, montants FR, dates FR,
 * Projection Kanban, rattachement d'un propriétaire à l'équipe suivie.
 *
 * Aucune de ces fonctions ne connaît le format du fichier source.
 */

import {
  ADVANCED_STAGE_RANK,
  KANBAN_COLORS,
  KANBAN_UNKNOWN_WEIGHT,
  STAGE_ORDER,
  TEAM,
  TERMINAL_STAGES,
  WON_STAGES,
  type TeamMember,
} from "./config";

/** Minuscules, sans accents, sans ponctuation ni espaces. Sert à comparer des libellés. */
export function normalizeKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Nettoie une cellule : espaces insécables, espaces multiples, bords. */
export function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Montant au format français : « 148508,05 », « 1 326 419,08 », « 1.326.419,08 ».
 * Retourne null si la cellule est vide ou non numérique.
 */
export function parseFrenchNumber(value: string | null | undefined): number | null {
  const text = cleanText(value);
  if (!text) return null;

  let body = text.replace(/[\s ]/g, "").replace(/[€%]/g, "");
  const negative = /^\(.*\)$/.test(body) || body.startsWith("-");
  body = body.replace(/^[-(]|\)$/g, "");

  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Le séparateur décimal est le dernier des deux ; l'autre sépare les milliers.
    if (lastComma > lastDot) body = body.replace(/\./g, "").replace(",", ".");
    else body = body.replace(/,/g, "");
  } else if (lastComma >= 0) {
    body = body.replace(/\./g, "").replace(",", ".");
  }

  if (!/^\d*\.?\d+$/.test(body)) return null;
  const parsed = Number(body);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Date française « JJ/MM/AAAA », avec heure optionnelle « JJ/MM/AAAA HH:MM ».
 * Retourne une date ISO « AAAA-MM-JJ » (l'heure n'est pas conservée : aucun
 * calcul de l'application n'en a besoin).
 */
export function parseFrenchDate(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text) return null;

  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!match) {
    // Tolère une date déjà au format ISO.
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return iso ? iso[0] : null;
  }

  const [, d, m, y] = match;
  const day = Number(d);
  const month = Number(m);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Date du jour au format ISO, en heure locale (et non UTC). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Nombre de jours entre deux dates ISO (positif si `to` est après `from`). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Lundi de la semaine d'une date ISO donnée. */
export function mondayOf(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  const dow = (date.getDay() + 6) % 7; // 0 = lundi
  date.setDate(date.getDate() - dow);
  return todayIso(date);
}

const MONTHS_FR: Record<string, number> = {
  janv: 1, janvier: 1,
  fevr: 2, fevrier: 2, fev: 2,
  mars: 3,
  avr: 4, avril: 4,
  mai: 5,
  juin: 6,
  juil: 7, juillet: 7,
  aout: 8,
  sept: 9, septembre: 9,
  oct: 10, octobre: 10,
  nov: 11, novembre: 11,
  dec: 12, decembre: 12,
};

export const MONTH_LABELS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export type ParsedKanban = {
  /** Valeur brute, toujours conservée telle quelle. */
  raw: string;
  /** Clé de couleur si la pastille est identifiable, sinon null. */
  colorKey: string | null;
  /** Pastille brute (emoji ou « ? ») si présente. */
  colorRaw: string | null;
  month: number | null;
  year: number | null;
};

/**
 * Projection Kanban : « 🟠 Sept. 2026 », « Oct. 2026 », « ? Août 2026 ».
 * On stocke le brut, le mois, l'année, et la couleur lorsqu'elle est identifiable.
 * On n'interprète jamais la couleur ici.
 */
export function parseKanban(value: string | null | undefined): ParsedKanban | null {
  const raw = cleanText(value);
  if (!raw) return null;

  const result: ParsedKanban = { raw, colorKey: null, colorRaw: null, month: null, year: null };

  // La pastille est le premier caractère non alphanumérique isolé.
  const head = raw.match(/^(\S+)\s+(.*)$/);
  let rest = raw;
  if (head) {
    const candidate = head[1];
    const isWord = /^[\p{L}\d]/u.test(candidate);
    if (!isWord) {
      result.colorRaw = candidate;
      result.colorKey = KANBAN_COLORS[candidate]?.key ?? null;
      rest = head[2];
    }
  }

  const period = rest.match(/([\p{L}]+)\.?\s+(\d{4})/u);
  if (period) {
    const month = MONTHS_FR[normalizeKey(period[1])];
    if (month) {
      result.month = month;
      result.year = Number(period[2]);
    }
  }

  return result;
}

/** Poids de confiance provisoire associé à une pastille (voir config.KANBAN_COLORS). */
export function kanbanColorWeight(colorKey: string | null, colorRaw: string | null): number {
  if (colorKey) {
    const entry = Object.values(KANBAN_COLORS).find((c) => c.key === colorKey);
    if (entry) return entry.weight;
  }
  return colorRaw ? KANBAN_UNKNOWN_WEIGHT : 0;
}

/** Libellé lisible d'une projection : « Sept. 2026 » → « septembre 2026 ». */
export function kanbanPeriodLabel(month: number | null, year: number | null): string | null {
  if (!month || !year) return null;
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

// --- Équipe --------------------------------------------------------------

const TEAM_INDEX = new Map<string, TeamMember>();
for (const member of TEAM) {
  TEAM_INDEX.set(normalizeKey(member.name), member);
  for (const alias of member.aliases ?? []) TEAM_INDEX.set(normalizeKey(alias), member);
}

/**
 * Rattache un propriétaire Salesforce à un membre de l'équipe.
 * Le matching est exact sur forme normalisée (les alias couvrent les vraies
 * divergences) : on ne fait pas de rapprochement approximatif, qui risquerait
 * de faire entrer un commercial hors périmètre dans le Morning Brief.
 */
export function matchTeamMember(ownerRaw: string | null): TeamMember | null {
  if (!ownerRaw) return null;
  return TEAM_INDEX.get(normalizeKey(ownerRaw)) ?? null;
}

// --- Étapes --------------------------------------------------------------

const TERMINAL_KEYS = new Set(TERMINAL_STAGES.map(normalizeKey));
const WON_KEYS = new Set(WON_STAGES.map(normalizeKey));
const STAGE_RANKS = new Map(Object.entries(STAGE_ORDER).map(([k, v]) => [normalizeKey(k), v]));

export function isTerminalStage(stage: string | null): boolean {
  return stage ? TERMINAL_KEYS.has(normalizeKey(stage)) : false;
}

export function isWonStage(stage: string | null): boolean {
  return stage ? WON_KEYS.has(normalizeKey(stage)) : false;
}

export function stageRank(stage: string | null): number {
  return stage ? (STAGE_RANKS.get(normalizeKey(stage)) ?? 0) : 0;
}

export function isAdvancedStage(stage: string | null): boolean {
  const rank = stageRank(stage);
  return rank >= ADVANCED_STAGE_RANK && !isTerminalStage(stage);
}

// --- Formatage -----------------------------------------------------------

const EUR = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

export function formatEur(value: number | null | undefined): string {
  if (value == null) return "—";
  return EUR.format(value);
}

/** Format compact pour les grands nombres : 3 096 572 € → 3,1 M€. */
export function formatEurShort(value: number | null | undefined): string {
  if (value == null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".", ",")} M€`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)} k€`;
  return EUR.format(value);
}

export function formatFrenchDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

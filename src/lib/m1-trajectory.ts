/**
 * « Trajectoire de construction » de M+1 — audit V3.3.
 *
 * Répond à : construisons-nous M+1 assez vite pour atteindre l'objectif ? Ce
 * module ne calcule AUCUNE prévision et ne touche pas au moteur Expected : il
 * compose (1) ce que `build-m1.ts` assemble déjà pour la vue M+1 — objectif,
 * prévision RM Morning, manque (`coverageOf`) — et (2) l'historique de ces
 * mêmes grandeurs, relu dans des tables qui existent déjà :
 *
 *   Prévision RM Morning M+1   expected_m1_snapshot   (une génération par
 *                              import ; on garde la DERNIÈRE de chaque jour,
 *                              celle que l'écran aurait affichée)
 *   Déclaratif commerciaux     opportunity_snapshot   (Projection Kanban du
 *                              mois cible, affaires actives : la définition
 *                              exacte de `board.region.kanbanGmv`)
 *   Pipe identifié             déclaratif + lignes jaunes RM Morning du jour
 *                              (expected_m1_suggestion.suggested_yellow), soit
 *                              la définition exacte de `ConstruireM1.identified`
 *   Perspective ajustée        blocs hebdomadaires datés du classeur, SI l'onglet
 *                              en porte. Rien n'est enregistré en base : sans
 *                              bloc daté, la série est indisponible, pas inventée.
 *
 * Trois règles qui ne se négocient pas :
 *   — une série qui manque reste manquante (jamais interpolée ni recopiée) ;
 *   — « ça monte / stagne / recule » ne se lit que sur des chiffres réels, avec
 *     le seuil de `M1_TRAJECTORY` ;
 *   — le rythme hebdomadaire est un RYTHME MATHÉMATIQUE REQUIS (manque ÷
 *     semaines restantes), jamais une prédiction ni une probabilité.
 *
 * Le pipe identifié n'est JAMAIS la prévision : la prévision M+1 intègre une
 * part statistique d'affaires qui n'existent pas encore (`futureShare`).
 *
 * LECTURE SEULE : aucune écriture en base.
 */

import type { ConstruireM1 } from "./build-m1";
import { M1_TRAJECTORY } from "./config";
import { getDb } from "./db";
import { addDays, daysBetween } from "./normalize";
import { kEur } from "./vocabulary";

// --- Rythme requis (pur) ------------------------------------------------------

export type RequiredPace = {
  daysLeft: number;
  /** Semaines restantes avant le 1er du mois cible : jours ÷ 7, sans arrondi caché. */
  weeksLeft: number;
  /** Manque ÷ semaines restantes, en euros par semaine. */
  weekly: number;
};

/** Jours entre `today` et le 1er du mois cible « AAAA-MM » (0 ou négatif : M+1 a commencé). */
export function daysUntilMonth(today: string, month: string): number {
  return daysBetween(today, `${month}-01`);
}

/**
 * Rythme mathématique requis : `manque ÷ (jours restants ÷ 7)`. `null` quand il
 * n'y a rien à construire (objectif absent, prévision absente, objectif déjà
 * couvert) ou quand le mois cible a commencé — aucun rythme n'est alors inventé.
 */
export function requiredPace(missing: number | null, daysLeft: number): RequiredPace | null {
  if (missing == null || !(missing > 0) || !Number.isFinite(missing)) return null;
  if (!(daysLeft > 0)) return null;
  const weeksLeft = daysLeft / 7;
  return { daysLeft, weeksLeft, weekly: missing / weeksLeft };
}

// --- Lecture de tendance (pur) ------------------------------------------------

export type Trend = "up" | "flat" | "down";

export type TrendReading = {
  from: string;
  to: string;
  fromValue: number;
  toValue: number;
  delta: number;
  trend: Trend;
};

/**
 * « Monte » / « stagne » / « recule » — uniquement si la variation dépasse à la
 * fois `flatRatio` du point de départ ET `flatMinAmount` (config).
 */
export function classifyTrend(fromValue: number, toValue: number): { delta: number; trend: Trend } {
  const delta = toValue - fromValue;
  const threshold = Math.max(M1_TRAJECTORY.flatMinAmount, M1_TRAJECTORY.flatRatio * Math.abs(fromValue));
  if (delta >= threshold) return { delta, trend: "up" };
  if (delta <= -threshold) return { delta, trend: "down" };
  return { delta, trend: "flat" };
}

function readingBetween(
  dates: string[],
  values: (number | null)[],
  fromIndex: number,
  toIndex: number,
): TrendReading | null {
  if (fromIndex < 0 || toIndex <= fromIndex) return null;
  const a = values[fromIndex];
  const b = values[toIndex];
  if (a == null || b == null) return null;
  return { from: dates[fromIndex], to: dates[toIndex], fromValue: a, toValue: b, ...classifyTrend(a, b) };
}

// --- Points de lecture (pur) --------------------------------------------------

/**
 * Points de lecture hebdomadaires, du plus ancien au plus récent : le dernier
 * jour disponible, puis, pour chaque semaine en arrière, le jour disponible le
 * plus proche AVANT OU ÉGAL à la cible (jamais après : on ne raccourcit pas une
 * semaine sans le dire). Les jours sans génération — week-ends, imports ratés —
 * ne sont donc jamais un obstacle. S'arrête quand l'historique s'arrête.
 */
export function pickCheckpoints(
  availableDates: string[],
  stepDays: number = M1_TRAJECTORY.checkpointStepDays,
  max: number = M1_TRAJECTORY.maxCheckpoints,
): string[] {
  const sorted = [...new Set(availableDates)].sort();
  if (sorted.length === 0) return [];
  const latest = sorted[sorted.length - 1];
  const picked = [latest];
  for (let k = 1; picked.length < max; k += 1) {
    const target = addDays(latest, -stepDays * k);
    let found: string | null = null;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i] <= target) {
        found = sorted[i];
        break;
      }
    }
    if (found == null) break;
    if (found !== picked[picked.length - 1]) picked.push(found);
  }
  return picked.reverse();
}

/** Jours calendaires entre le premier et le dernier point, absents de la série. */
export function missingDaysBetween(availableDates: string[]): string[] {
  const sorted = [...new Set(availableDates)].sort();
  if (sorted.length < 2) return [];
  const have = new Set(sorted);
  const out: string[] = [];
  for (let d = addDays(sorted[0], 1); d < sorted[sorted.length - 1]; d = addDays(d, 1)) {
    if (!have.has(d)) out.push(d);
  }
  return out;
}

/** Dernière valeur datée au plus tard à `date` (points triés par date croissante). */
export function valueAtOrBefore(points: { date: string; value: number }[], date: string): number | null {
  let found: number | null = null;
  for (const p of points) {
    if (p.date <= date) found = p.value;
    else break;
  }
  return found;
}

// --- Historique (lecture base) ------------------------------------------------

export type M1History = {
  /** Prévision RM Morning M+1, dernière génération de chaque jour. */
  rmMorning: Map<string, number>;
  /** Déclaratif Kanban du mois cible ; absent = pas de photo Opportunity ce jour-là. */
  declared: Map<string, { gmv: number; count: number }>;
  /** Lignes jaunes RM Morning enregistrées ce jour-là ; absent = aucune. */
  yellow: Map<string, { gmv: number; count: number }>;
};

/** Lit l'historique du mois cible. Aucune écriture. */
export function loadM1History(targetMonth: string): M1History {
  const db = getDb();
  const [year, month] = targetMonth.split("-").map(Number);

  const rmMorning = new Map<string, number>();
  const generations = db
    .prepare(
      // julianday() lit le décalage horaire : les générations d'août portent
      // « +02:00 », celles de septembre « +00:00 » — un tri sur le texte brut
      // pourrait mal classer deux générations d'un même jour.
      `SELECT observation_date d, projection p FROM expected_m1_snapshot
        WHERE target_month = ? ORDER BY julianday(generated_at)`,
    )
    .all(targetMonth) as { d: string; p: number }[];
  for (const g of generations) rmMorning.set(String(g.d), Number(g.p));

  const snapshotDays = new Set(
    (db.prepare("SELECT DISTINCT snapshot_date d FROM opportunity_snapshot").all() as { d: string }[]).map((r) =>
      String(r.d),
    ),
  );
  const declaredRows = db
    .prepare(
      `SELECT snapshot_date d, COUNT(*) n, COALESCE(SUM(gmv), 0) g FROM opportunity_snapshot
        WHERE is_active = 1 AND kanban_month = ? AND kanban_year = ? GROUP BY snapshot_date`,
    )
    .all(month, year) as { d: string; n: number; g: number }[];
  const declared = new Map<string, { gmv: number; count: number }>();
  for (const day of snapshotDays) declared.set(day, { gmv: 0, count: 0 });
  for (const r of declaredRows) declared.set(String(r.d), { gmv: Number(r.g), count: Number(r.n) });

  const yellowRows = db
    .prepare(
      `SELECT snapshot_date d, COUNT(*) n, COALESCE(SUM(gmv), 0) g FROM expected_m1_suggestion
        WHERE target_month = ? AND suggested_yellow = 1 GROUP BY snapshot_date`,
    )
    .all(targetMonth) as { d: string; n: number; g: number }[];
  const yellow = new Map<string, { gmv: number; count: number }>();
  for (const r of yellowRows) yellow.set(String(r.d), { gmv: Number(r.g), count: Number(r.n) });

  return { rmMorning, declared, yellow };
}

// --- Assemblage ---------------------------------------------------------------

export type SeriesKey = "rmMorning" | "declared" | "adjusted" | "identified";

export type TrajectorySeries = {
  key: SeriesKey;
  label: string;
  /** Une valeur par point de lecture ; `null` = donnée absente ce jour-là. */
  values: (number | null)[];
  /** Dernier point de lecture contre le précédent (une semaine). */
  week: TrendReading | null;
  /** Dernier point de lecture contre le plus ancien. */
  window: TrendReading | null;
  /** Renseigné quand la série n'existe pas : la raison, jamais une valeur de remplacement. */
  unavailableReason: string | null;
};

export type M1Trajectory = {
  month: string;
  monthLabel: string;
  today: string;
  objective: number | null;
  forecast: number | null;
  /** Perspective ajustée d'AUJOURD'HUI : un repère courant, jamais une série (aucun historique). */
  adjustedCurrent: { gmv: number; count: number; source: "snapshot" | "selection" } | null;
  /** Manque à construire, tel que `coverageOf` le rend ; null si objectif ou prévision absent. */
  missing: number | null;
  /** Vrai quand l'objectif est déjà couvert par la prévision. */
  covered: boolean;
  daysLeft: number;
  pace: RequiredPace | null;
  /** Rappel : part historique du GMV M+1 venue d'affaires pas encore créées. */
  futureShare: string;
  history: {
    checkpoints: string[];
    series: TrajectorySeries[];
    firstDate: string;
    lastDate: string;
    /** Étendue réelle de l'historique, en semaines (jours ÷ 7). */
    weeksCovered: number;
    missingDays: string[];
  } | null;
  notes: string[];
};

type TrajectoryInput = Pick<
  ConstruireM1,
  "month" | "monthLabel" | "objective" | "forecast" | "coverage" | "adjusted" | "futureShare" | "declared" | "identified"
>;

function buildSeries(
  key: SeriesKey,
  label: string,
  checkpoints: string[],
  values: (number | null)[],
  unavailableReason: string | null,
): TrajectorySeries {
  const last = checkpoints.length - 1;
  return {
    key,
    label,
    values,
    week: unavailableReason ? null : readingBetween(checkpoints, values, last - 1, last),
    window: unavailableReason ? null : readingBetween(checkpoints, values, 0, last),
    unavailableReason,
  };
}

/**
 * Compose la trajectoire à partir de ce que la vue M+1 a déjà assemblé (`data`)
 * et de l'historique du mois cible. Le manque vient de `data.coverage`, jamais
 * recalculé ici : il n'existe qu'un seul « manque à construire ».
 */
export function buildM1Trajectory(
  data: TrajectoryInput,
  today: string,
  history: M1History = loadM1History(data.month),
): M1Trajectory {
  const notes: string[] = [];
  const objective = data.objective?.amount ?? null;
  const forecast = data.forecast?.projection ?? null;
  const missing = data.coverage ? data.coverage.missing : null;
  const covered = data.coverage != null && data.coverage.missing === 0;
  const adjustedCurrent = data.adjusted.ok
    ? { gmv: data.adjusted.value.gmv, count: data.adjusted.value.count, source: data.adjusted.value.source }
    : null;
  const daysLeft = daysUntilMonth(today, data.month);
  const pace = requiredPace(missing, daysLeft);

  if (data.objective) {
    notes.push(
      "L'objectif affiché est celui saisi le " +
        `${data.objective.updatedAt.slice(8, 10)}/${data.objective.updatedAt.slice(5, 7)} : son historique n'est pas conservé, la série ne le rejoue donc pas.`,
    );
  }

  const rmDates = [...history.rmMorning.keys()].sort();
  if (rmDates.length === 0) {
    notes.push(`Aucune projection RM Morning enregistrée pour ${data.monthLabel} : pas de trajectoire.`);
    return {
      month: data.month,
      monthLabel: data.monthLabel,
      today,
      objective,
      forecast,
      adjustedCurrent,
      missing,
      covered,
      daysLeft,
      pace,
      futureShare: data.futureShare,
      history: null,
      notes,
    };
  }

  const checkpoints = pickCheckpoints(rmDates);
  const firstDate = rmDates[0];
  const lastDate = rmDates[rmDates.length - 1];
  const weeksCovered = daysBetween(firstDate, lastDate) / 7;

  const rmValues = checkpoints.map((d) => history.rmMorning.get(d) ?? null);
  const declaredValues = checkpoints.map((d) => history.declared.get(d)?.gmv ?? null);
  const identifiedValues = checkpoints.map((d) => {
    const declared = history.declared.get(d);
    if (!declared) return null;
    return declared.gmv + (history.yellow.get(d)?.gmv ?? 0);
  });

  // La dernière colonne, quand elle est d'aujourd'hui, DOIT dire la même chose
  // que le haut de la vue : elle reprend les chiffres du moteur. La photo
  // Opportunity du jour peut en effet s'écarter du moteur (affaires « absentes
  // de la source » que le garde-fou d'import n'a pas encore sorties du pipe) :
  // l'écart est alors dit, jamais absorbé en silence.
  if (lastDate === today) {
    const i = checkpoints.length - 1;
    if (data.forecast) rmValues[i] = data.forecast.projection;
    const photo = declaredValues[i];
    if (photo != null && Math.abs(photo - data.declared.gmv) > 1) {
      notes.push(
        `Le déclaratif du jour (${kEur(data.declared.gmv)}) diffère de la photo Opportunity du jour (${kEur(photo)}) : ` +
          "le moteur compte des affaires absentes de la photo. La dernière colonne reprend le chiffre du moteur.",
      );
    }
    if (photo != null) {
      declaredValues[i] = data.declared.gmv;
      identifiedValues[i] = data.identified.gmv;
    }
  }

  const series: TrajectorySeries[] = [
    buildSeries("rmMorning", "Prévision RM Morning", checkpoints, rmValues, null),
    buildSeries(
      "declared",
      "Déclaratif commerciaux (Kanban)",
      checkpoints,
      declaredValues,
      declaredValues.every((v) => v == null) ? "aucune photo Opportunity sur la période" : null,
    ),
  ];

  // Perspective ajustée : des blocs datés du classeur, ou rien.
  const filled =
    data.adjusted.ok
      ? data.adjusted.value.snapshots
          .filter((s) => s.filled)
          .map((s) => ({ date: s.date, value: s.gmv }))
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];
  const adjustedValues = checkpoints.map((d) => valueAtOrBefore(filled, d));
  const adjustedReason = !data.adjusted.ok
    ? data.adjusted.reason
    : filled.length === 0
      ? "l'onglet du mois ne porte aucun bloc hebdomadaire daté : pas d'historique"
      : adjustedValues.every((v) => v == null)
        ? "aucun bloc daté avant le début de la période"
        : null;
  series.push(buildSeries("adjusted", "Perspective ajustée", checkpoints, adjustedValues, adjustedReason));
  if (adjustedReason) notes.push(`Perspective ajustée : ${adjustedReason}.`);

  series.push(
    buildSeries(
      "identified",
      "Pipe identifié (GMV en pipe)",
      checkpoints,
      identifiedValues,
      identifiedValues.every((v) => v == null) ? "aucune photo Opportunity sur la période" : null,
    ),
  );

  const missingDays = missingDaysBetween(rmDates);
  if (missingDays.length > 0) {
    notes.push(
      `${missingDays.length} jour(s) sans photo dans la période — la lecture s'appuie sur le jour disponible le plus proche.`,
    );
  }
  if (weeksCovered < 4) {
    notes.push(
      `Historique disponible : ${weeksCovered.toFixed(1).replace(".", ",")} semaine(s) seulement — ` +
        `la première projection pour ${data.monthLabel} date du ${firstDate.slice(8, 10)}/${firstDate.slice(5, 7)}.`,
    );
  }
  if (lastDate < today) {
    notes.push(
      `Dernière projection enregistrée : ${lastDate.slice(8, 10)}/${lastDate.slice(5, 7)} — aucune génération plus récente.`,
    );
  }

  return {
    month: data.month,
    monthLabel: data.monthLabel,
    today,
    objective,
    forecast,
    adjustedCurrent,
    missing,
    covered,
    daysLeft,
    pace,
    futureShare: data.futureShare,
    history: { checkpoints, series, firstDate, lastDate, weeksCovered, missingDays },
    notes,
  };
}

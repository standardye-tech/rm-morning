/**
 * Fiabilité d'Expected GMV — lecture des historiques en base et assemblage.
 * Les règles de calcul vivent dans `expected-reliability.ts` (pur).
 */

import { parisDate } from "./business-time";
import { getDb } from "./db";
import {
  RELIABILITY,
  bucketAt,
  combinedPoints,
  daysUntilReliable,
  reliabilityCurve,
  type BucketReliability,
  type ReliabilityPoint,
} from "./expected-reliability";
import { officialSignedBetween, officialSignedGmv } from "./official-signed";

const DAY = 864e5;
const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const shiftMonth = (month: string, k: number) => {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const daysLeftIn = (date: string) => daysInMonth(date.slice(0, 7)) - Number(date.slice(8, 10));
const daysBefore = (date: string, month: string) =>
  Math.round((Date.parse(`${month}-01T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / DAY);
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1];

export type HorizonReliability = {
  label: string;
  month: string;
  monthLabel: string;
  /** Indice à la position d'aujourd'hui ; null = données insuffisantes ou pas de prévision. */
  reliability: number | null;
  /** Pourquoi il n'y a pas d'indice, quand il n'y en a pas. */
  unavailable: string | null;
  /** Mois cibles passés qui fondent l'indice à cet horizon. */
  months: number;
  /** Jours avant que l'indice historique atteigne 90 % ; null = jamais atteint. */
  reliableIn: { days: number; date: string } | null;
  curve: BucketReliability[] | null;
};

export type ExpectedReliabilityView = {
  today: string;
  global: HorizonReliability;
  horizons: HorizonReliability[];
  sources: { mPoints: number; mMonths: number; m1Points: number; m1Months: number; from: string | null; to: string | null };
  notes: string[];
};

type MBacktest = { date: string; month: string; signed_to_date: number; expected_finish: number; actual_finish: number };
type M1Backtest = { date: string; target: string; days_to_target: number; projection: number; actual: number };

function json<T>(raw: string | null | undefined): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const eveOf = (month: string) => new Date(Date.parse(`${month}-01T12:00:00Z`) - DAY).toISOString().slice(0, 10);

/**
 * Points M : backtest hors échantillon + prévisions affichées sur les mois clos.
 *
 * Le backtest de l'évaluation mesurait le réalisé sur les signatures du dataset,
 * qui diffèrent du GMV officiel Travaux (mai 2026 : 1 143 k€ contre 955 k€). Ses
 * points sont donc RÉEXPRIMÉS comme l'écran construit la prévision aujourd'hui :
 * signé officiel à la date d'observation + reste probable du modèle
 * (`expected_finish − signed_to_date`), comparé au GMV final officiel.
 */
function pointsM(currentMonth: string): ReliabilityPoint[] {
  const db = getDb();
  const latest = db
    .prepare("SELECT reliability FROM expected_gmv_snapshot ORDER BY scored_at DESC LIMIT 1")
    .get() as { reliability: string | null } | undefined;
  const bt = json<{ backtest?: MBacktest[] }>(latest?.reliability)?.backtest ?? [];
  const finals = new Map<string, number>();
  const finalOf = (month: string) => {
    if (!finals.has(month)) finals.set(month, officialSignedGmv(month).gmv);
    return finals.get(month)!;
  };
  const out: ReliabilityPoint[] = bt.map((b) => ({
    date: b.date,
    target: b.month,
    horizonDays: daysLeftIn(b.date),
    predicted: officialSignedBetween(eveOf(b.month), b.date).gmv + (b.expected_finish - b.signed_to_date),
    actual: finalOf(b.month),
  }));
  const covered = new Set(out.map((p) => p.target));

  // Prévisions RÉELLEMENT produites, sur des mois aujourd'hui clos : une par jour
  // (la dernière du jour). Le signé à date est relu dans Travaux à la date
  // d'observation, comme l'écran l'affichait.
  const live = db
    .prepare(
      `SELECT as_of_date, month, expected_remaining, scored_at FROM expected_gmv_snapshot
        WHERE month < ? ORDER BY scored_at`,
    )
    .all(currentMonth) as { as_of_date: string; month: string; expected_remaining: number; scored_at: string }[];
  const lastOfDay = new Map<string, (typeof live)[number]>();
  for (const r of live) if (!covered.has(r.month)) lastOfDay.set(`${r.month}|${r.as_of_date}`, r);
  for (const r of lastOfDay.values()) {
    out.push({
      date: r.as_of_date,
      target: r.month,
      horizonDays: daysLeftIn(r.as_of_date),
      predicted: officialSignedBetween(eveOf(r.month), r.as_of_date).gmv + r.expected_remaining,
      actual: finalOf(r.month),
    });
  }
  return out;
}

/** Points M+1 : règle publiée rejouée sur chaque lundi passé + projections publiées sur les mois clos. */
function pointsM1(currentMonth: string): ReliabilityPoint[] {
  const db = getDb();
  const latest = db
    .prepare("SELECT reliability FROM expected_m1_snapshot ORDER BY generated_at DESC LIMIT 1")
    .get() as { reliability: string | null } | undefined;
  const bt = json<{ backtest?: M1Backtest[] }>(latest?.reliability)?.backtest ?? [];
  const out: ReliabilityPoint[] = bt.map((b) => ({
    date: b.date,
    target: b.target,
    horizonDays: b.days_to_target,
    predicted: b.projection,
    actual: b.actual,
  }));
  const covered = new Set(out.map((p) => p.target));
  const live = db
    .prepare(
      `SELECT observation_date, target_month, projection, generated_at FROM expected_m1_snapshot
        WHERE target_month < ? ORDER BY generated_at`,
    )
    .all(currentMonth) as { observation_date: string; target_month: string; projection: number }[];
  const lastOfDay = new Map<string, (typeof live)[number]>();
  for (const r of live) if (!covered.has(r.target_month)) lastOfDay.set(`${r.target_month}|${r.observation_date}`, r);
  const finals = new Map<string, number>();
  for (const r of lastOfDay.values()) {
    if (!finals.has(r.target_month)) finals.set(r.target_month, officialSignedGmv(r.target_month).gmv);
    out.push({
      date: r.observation_date,
      target: r.target_month,
      horizonDays: daysBefore(r.observation_date, r.target_month),
      predicted: r.projection,
      actual: finals.get(r.target_month)!,
    });
  }
  return out;
}

export function buildExpectedReliability(now = new Date()): ExpectedReliabilityView {
  const today = parisDate(now);
  const month = today.slice(0, 7);
  const m1Month = shiftMonth(month, 1);
  const m2Month = shiftMonth(month, 2);

  const m = pointsM(month);
  const m1 = pointsM1(month);
  const both = combinedPoints(m, m1);

  const curveM = reliabilityCurve(m, RELIABILITY.bucketsM);
  const curveM1 = reliabilityCurve(m1, RELIABILITY.bucketsM1);
  const curveBoth = reliabilityCurve(both, RELIABILITY.bucketsM);

  const leftM = daysLeftIn(today);
  const beforeM1 = daysBefore(today, m1Month);
  const at = (curve: BucketReliability[], h: number) => bucketAt(curve, h);

  const insufficient = "Données insuffisantes";
  const horizon = (
    label: string,
    target: string,
    curve: BucketReliability[] | null,
    position: number | null,
    unavailable: string | null,
  ): HorizonReliability => {
    const bucket = curve && position != null ? at(curve, position) : null;
    return {
      label,
      month: target,
      monthLabel: monthName(target),
      reliability: bucket?.reliability ?? null,
      unavailable: unavailable ?? (bucket?.reliability == null ? insufficient : null),
      months: bucket?.months ?? 0,
      reliableIn: daysUntilReliable(today, target, curveM, curveM1),
      curve,
    };
  };

  const bothBucket = at(curveBoth, leftM);
  const global: HorizonReliability = {
    label: "Fiabilité globale",
    month: `${month}+${m1Month}`,
    monthLabel: `${monthName(month)} + ${monthName(m1Month)}`,
    reliability: bothBucket?.reliability ?? null,
    unavailable: bothBucket?.reliability == null ? insufficient : null,
    months: bothBucket?.months ?? 0,
    reliableIn: (() => {
      // Le total n'existe que dans le mois courant : on parcourt ses jours restants.
      for (let t = 0; t <= leftM; t += 1) {
        const b = at(curveBoth, leftM - t);
        if (b?.reliability != null && b.reliability >= RELIABILITY.target) {
          return { days: t, date: new Date(Date.parse(`${today}T12:00:00Z`) + t * DAY).toISOString().slice(0, 10) };
        }
      }
      return null;
    })(),
    curve: curveBoth,
  };

  const dates = [...m, ...m1].map((p) => p.date).sort();
  return {
    today,
    global,
    horizons: [
      horizon("Mois en cours", month, curveM, leftM, null),
      horizon("M+1", m1Month, curveM1, beforeM1, null),
      horizon("M+2", m2Month, null, null, "Aucune prévision RM Morning à cet horizon"),
    ],
    sources: {
      mPoints: m.length,
      mMonths: new Set(m.map((p) => p.target)).size,
      m1Points: m1.length,
      m1Months: new Set(m1.map((p) => p.target)).size,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
    },
    notes: [
      "Le total ne couvre que M et M+1 : RM Morning ne publie aucune prévision M+2 (classement jugé non fiable en C8.1), il n'y a donc rien à mesurer pour M+2.",
      "Côté M+1, la pondération du pipe (50 %) a été choisie sur des mois de 2026 : l'indice peut être légèrement optimiste sur ces mois-là.",
    ],
  };
}

/**
 * Fiabilité d'Expected GMV — lot de simplification (F5 à F7).
 *
 * AUCUN CHIFFRE INVENTÉ. L'indice ne vient jamais de la « confiance » affichée
 * par le modèle : il vient d'un BACKTEST HISTORIQUE RÉEL — les prévisions que
 * RM Morning a produites (ou aurait produites avec la règle publiée, sans
 * information postérieure) comparées au GMV final officiel du mois cible.
 *
 * Sources :
 *   — M   : les instantanés hebdomadaires hors échantillon de l'évaluation du
 *           modèle fin de mois (`expected_gmv_snapshot.reliability.backtest`),
 *           plus les prévisions réellement affichées sur les mois depuis clos
 *           (`expected_gmv_snapshot`) ;
 *   — M+1 : la règle de projection publiée, rejouée sur chaque lundi passé
 *           (`expected_m1_snapshot.reliability.backtest`, `publish_m1.py`), plus
 *           les projections réellement publiées sur les mois depuis clos ;
 *   — M+2 : RM Morning ne publie AUCUNE prévision à cet horizon (C8.1 : le
 *           classement M+2 ne fait pas mieux que le hasard). Pas d'indice.
 *
 * AUCUN INDICE GLOBAL (verrous du 24/09/2026) : additionner M et M+1 laissait
 * leurs erreurs se compenser (91 % sur 3 mois, quand chaque horizon pris seul
 * est à 68 % et 73 %). Chaque horizon est mesuré et affiché séparément.
 *
 * MÉTRIQUE : erreur absolue agrégée pondérée (WAPE), calculée par MOIS CIBLE
 * pour qu'un mois suivi chaque jour ne pèse pas plus qu'un mois suivi chaque
 * semaine : WAPE = Σ_mois (erreur absolue moyenne) / Σ_mois (GMV final). Le MAPE
 * brut est écarté : un petit mois le rendrait instable.
 *
 *   fiabilité = 100 × (1 − WAPE), bornée à [0, 100], arrondie à l'unité.
 *
 * Un horizon n'a d'indice qu'avec au moins `minMonths` mois cibles distincts ;
 * sinon « Données insuffisantes », jamais un pourcentage fabriqué.
 */

export type ReliabilityPoint = {
  /** Date d'observation « AAAA-MM-JJ ». */
  date: string;
  /** Mois cible « AAAA-MM ». */
  target: string;
  /**
   * Horizon, en jours : jours restants dans le mois cible (M), ou jours avant
   * son premier jour (M+1).
   */
  horizonDays: number;
  predicted: number;
  actual: number;
};

export type Bucket = { from: number; to: number };

export type BucketReliability = Bucket & {
  points: number;
  months: number;
  /** Null = données insuffisantes. */
  reliability: number | null;
  wape: number | null;
};

export const RELIABILITY = {
  /** Mois cibles distincts exigés pour publier un indice, même indicatif. */
  minMonths: 3,
  /**
   * En deçà, l'indice est affiché « indicatif » avec sa taille d'échantillon :
   * une année de mois cibles, pour qu'un mois atypique (août) ne pèse pas seul.
   */
  matureMonths: 12,
  /** Seuil de « très fiable ». */
  target: 90,
  /** Tranches d'horizon, en jours restants dans le mois cible (M). */
  bucketsM: [
    { from: 0, to: 7 },
    { from: 8, to: 14 },
    { from: 15, to: 21 },
    { from: 22, to: 31 },
  ] as Bucket[],
  /** Tranches d'horizon, en jours avant le premier jour du mois cible (M+1). */
  bucketsM1: [
    { from: 1, to: 7 },
    { from: 8, to: 14 },
    { from: 15, to: 21 },
    { from: 22, to: 35 },
  ] as Bucket[],
} as const;

/** WAPE par mois cible : Σ erreur absolue moyenne du mois / Σ GMV final. */
export function monthWeightedWape(points: ReliabilityPoint[]): { wape: number; months: number } | null {
  const byMonth = new Map<string, { err: number; n: number; actual: number }>();
  for (const p of points) {
    const cur = byMonth.get(p.target) ?? { err: 0, n: 0, actual: p.actual };
    cur.err += Math.abs(p.predicted - p.actual);
    cur.n += 1;
    byMonth.set(p.target, cur);
  }
  let err = 0;
  let actual = 0;
  for (const m of byMonth.values()) {
    err += m.err / m.n;
    actual += m.actual;
  }
  if (byMonth.size === 0 || actual <= 0) return null;
  return { wape: err / actual, months: byMonth.size };
}

export function reliabilityOf(points: ReliabilityPoint[], minMonths: number = RELIABILITY.minMonths) {
  const w = monthWeightedWape(points);
  if (!w || w.months < minMonths) return { reliability: null, wape: null, months: w?.months ?? 0, points: points.length };
  return {
    reliability: Math.round(Math.max(0, Math.min(100, 100 * (1 - w.wape)))),
    wape: w.wape,
    months: w.months,
    points: points.length,
  };
}

/** Courbe de fiabilité par tranche d'horizon. */
export function reliabilityCurve(points: ReliabilityPoint[], buckets: readonly Bucket[]): BucketReliability[] {
  return buckets.map((b) => ({
    ...b,
    ...reliabilityOf(points.filter((p) => p.horizonDays >= b.from && p.horizonDays <= b.to)),
  }));
}

export function bucketAt(curve: BucketReliability[], horizonDays: number): BucketReliability | null {
  return curve.find((b) => horizonDays >= b.from && horizonDays <= b.to) ?? null;
}

// --- Quand la prévision d'un mois devient-elle très fiable ? --------------------

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Premier jour, à partir d'aujourd'hui, où l'indice HISTORIQUE atteint le seuil
 * pour le mois `target` : on parcourt les jours à venir, on lit la courbe M+1
 * tant que le mois cible est le suivant, puis la courbe M quand il est en cours.
 * Aucune prévision n'existe tant qu'il est à M+2 ou au-delà.
 *
 * Renvoie `{ days: 0 }` si le seuil est déjà atteint, `null` s'il ne l'est jamais
 * dans l'historique — jamais une date fictive.
 */
export function daysUntilReliable(
  today: string,
  target: string,
  curveM: BucketReliability[],
  curveM1: BucketReliability[],
  threshold: number = RELIABILITY.target,
): { days: number; date: string } | null {
  const first = `${target}-01`;
  const last = `${target}-${String(daysInMonth(target)).padStart(2, "0")}`;
  for (let t = 0; ; t += 1) {
    const day = addDays(today, t);
    if (day > last) return null;
    let bucket: BucketReliability | null = null;
    if (day >= first) {
      const left = Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 864e5);
      bucket = bucketAt(curveM, left);
    } else {
      const before = Math.round((Date.parse(`${first}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 864e5);
      // Le mois cible n'est « M+1 » que pendant le mois qui le précède.
      if (day.slice(0, 7) === addDays(first, -1).slice(0, 7)) bucket = bucketAt(curveM1, before);
    }
    if (bucket?.reliability != null && bucket.reliability >= threshold) return { days: t, date: day };
  }
}

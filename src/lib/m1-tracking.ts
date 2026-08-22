/**
 * Suivi des suggestions M+1 dans le temps.
 *
 * La validation de C8.1 ne porte que sur trois mois cibles. Ce module lit
 * `expected_m1_suggestion` pour répondre, dans quelques mois, à la seule question
 * qui compte : le seuil de 20 % tient-il ?
 *
 * Il ne s'affiche PAS dans le parcours principal. Un manager n'a pas à lire un
 * taux de précision pour se servir des lignes jaunes ; il en a besoin le jour où
 * il se demande s'il peut encore leur faire confiance.
 *
 * Aucun chiffre n'est produit tant qu'un mois cible n'est pas terminé : afficher
 * un taux de signature sur un mois en cours donnerait un résultat mécaniquement
 * catastrophique et faux.
 */

import { getDb } from "./db";

export type M1Bucket = {
  label: string;
  suggestions: number;
  signed: number;
  rate: number | null;
};

export type M1TrackingKpi = {
  /** Générations enregistrées, toutes cibles confondues. */
  generations: number;
  suggestions: number;
  distinctOpportunities: number;
  firstSnapshot: string | null;
  lastSnapshot: string | null;
  targetMonths: string[];
  /** Mois cibles terminés, seuls exploitables pour mesurer. */
  closedMonths: string[];
  measured: {
    /** Lignes jaunes proposées sur des mois cibles terminés. */
    yellow: number;
    yellowSigned: number;
    yellowRate: number | null;
    /** GMV officiel réalisé par les lignes jaunes qui ont signé. */
    gmvCaptured: number;
    /** Écartées parce que déjà déclarées : ont-elles signé plus souvent ? */
    excluded: number;
    excludedSigned: number;
    excludedRate: number | null;
    /** Taux de base hors échantillon mesuré en C8.1, pour calculer le lift. */
    baseRate: number | null;
    lift: number | null;
  } | null;
  /** Stabilité du seuil : taux observé par tranche de probabilité. */
  buckets: M1Bucket[];
  ruleVersions: string[];
};

type Row = {
  probability: number;
  suggested_yellow: number;
  declared_kanban: number;
  outcome_signed: number | null;
  outcome_gmv: number | null;
};

export function m1TrackingKpi(): M1TrackingKpi | null {
  const db = getDb();
  const head = db
    .prepare(
      `SELECT COUNT(*) suggestions,
              COUNT(DISTINCT snapshot_date) generations,
              COUNT(DISTINCT opportunity_id) opportunities,
              MIN(snapshot_date) first_snapshot,
              MAX(snapshot_date) last_snapshot
         FROM expected_m1_suggestion`,
    )
    .get() as {
    suggestions: number;
    generations: number;
    opportunities: number;
    first_snapshot: string | null;
    last_snapshot: string | null;
  };
  if (head.suggestions === 0) return null;

  const targetMonths = (
    db
      .prepare("SELECT DISTINCT target_month m FROM expected_m1_suggestion ORDER BY m")
      .all() as { m: string }[]
  ).map((r) => r.m);
  const closedMonths = (
    db
      .prepare(
        `SELECT DISTINCT target_month m FROM expected_m1_suggestion
          WHERE outcome_recorded_at IS NOT NULL ORDER BY m`,
      )
      .all() as { m: string }[]
  ).map((r) => r.m);
  const ruleVersions = (
    db
      .prepare("SELECT DISTINCT rule_version v FROM expected_m1_suggestion ORDER BY v")
      .all() as { v: string }[]
  ).map((r) => r.v);

  const rows = db
    .prepare(
      `SELECT probability, suggested_yellow, declared_kanban, outcome_signed, outcome_gmv
         FROM expected_m1_suggestion
        WHERE outcome_recorded_at IS NOT NULL`,
    )
    .all() as Row[];

  // Le taux de base hors échantillon vient de la publication du modèle, jamais
  // d'un calcul maison : nous n'historisons que les affaires au-dessus du seuil,
  // donc nous ne pouvons pas mesurer le taux de l'ensemble du pipe ici.
  const raw = (
    db
      .prepare("SELECT reliability FROM expected_m1_snapshot ORDER BY generated_at DESC LIMIT 1")
      .get() as { reliability: string } | undefined
  )?.reliability;
  let baseRate: number | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { ranking_validation?: { base_rate?: number } };
      baseRate = parsed.ranking_validation?.base_rate ?? null;
    } catch {
      baseRate = null;
    }
  }

  let measured: M1TrackingKpi["measured"] = null;
  if (rows.length > 0) {
    const yellow = rows.filter((r) => r.suggested_yellow === 1);
    const excluded = rows.filter((r) => r.suggested_yellow === 0 && r.declared_kanban === 1);
    const yellowSigned = yellow.filter((r) => r.outcome_signed === 1).length;
    const excludedSigned = excluded.filter((r) => r.outcome_signed === 1).length;
    const yellowRate = yellow.length > 0 ? yellowSigned / yellow.length : null;
    measured = {
      yellow: yellow.length,
      yellowSigned,
      yellowRate,
      gmvCaptured: yellow
        .filter((r) => r.outcome_signed === 1)
        .reduce((t, r) => t + (r.outcome_gmv ?? 0), 0),
      excluded: excluded.length,
      excludedSigned,
      excludedRate: excluded.length > 0 ? excludedSigned / excluded.length : null,
      baseRate,
      lift: yellowRate != null && baseRate != null && baseRate > 0 ? yellowRate / baseRate : null,
    };
  }

  // Tranches de probabilité : c'est ce qui dira si 20 % reste le bon seuil. Si le
  // taux observé dans la tranche 20-25 % s'effondre, il faut le relever.
  const edges = [0.2, 0.25, 0.3, 0.4, 1.01];
  const buckets: M1Bucket[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const inBucket = rows.filter((r) => r.probability >= edges[i] && r.probability < edges[i + 1]);
    const signed = inBucket.filter((r) => r.outcome_signed === 1).length;
    buckets.push({
      label:
        i === edges.length - 2
          ? `≥ ${(edges[i] * 100).toFixed(0)} %`
          : `${(edges[i] * 100).toFixed(0)}–${(edges[i + 1] * 100).toFixed(0)} %`,
      suggestions: inBucket.length,
      signed,
      rate: inBucket.length > 0 ? signed / inBucket.length : null,
    });
  }

  return {
    generations: head.generations,
    suggestions: head.suggestions,
    distinctOpportunities: head.opportunities,
    firstSnapshot: head.first_snapshot,
    lastSnapshot: head.last_snapshot,
    targetMonths,
    closedMonths,
    measured,
    buckets,
    ruleVersions,
  };
}

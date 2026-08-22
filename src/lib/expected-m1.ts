/**
 * Lecture de la projection M+1 et du scoring M+1.
 *
 * Comme pour l'horizon du mois, l'application ne calcule rien ici : elle lit la
 * dernière publication de `npm run m1:publish`. Entraînement, publication et
 * affichage restent trois opérations distinctes.
 *
 * POURQUOI UNE TABLE SÉPARÉE de l'Expected du mois. Ce ne sont pas deux moitiés
 * d'un même chiffre :
 *
 *   — l'Expected du mois est une somme de contributions d'affaires connues ;
 *   — la projection M+1 part du niveau historique officiel de l'équipe et
 *     l'ajuste selon la force du pipe. Elle N'EST PAS la somme des probabilités
 *     M+1 des affaires ouvertes, parce que 46 % du GMV de M+1 viendra d'affaires
 *     qui n'existent pas encore aujourd'hui (mesuré en C8.1 sur la vérité
 *     officielle Travaux).
 *
 * Additionner les deux, ou présenter la somme des lignes comme la projection,
 * serait faux dans les deux sens. Les probabilités individuelles servent
 * uniquement à CLASSER les affaires, jamais à totaliser le mois.
 */

import { EXPECTED_M1 } from "./config";
import { getDb } from "./db";
import { monthLabel } from "./expected-gmv-live";
import { matchTeamMember } from "./normalize";

export type ExpectedM1Opportunity = {
  opportunityId: string;
  owner: string;
  client: string | null;
  city: string | null;
  gmv: number;
  stage: string | null;
  /** Chance de signer sur le mois cible. Sert au classement, jamais à sommer. */
  probability: number;
  /** GMV × probabilité. Indicateur de tri, pas un montant attendu du mois. */
  expectedGmv: number;
  isStandby: boolean;
  standbyUntil: string | null;
  /** Gelée au-delà du mois cible : jamais suggérée. */
  frozenM1: boolean;
  /** Mois projeté par le commercial dans le Kanban. Contexte déclaratif. */
  kanbanMonth: string | null;
};

export type ExpectedM1Reliability = {
  source?: string;
  approach?: string;
  region_test?: { mae: number; median_abs_pct: number; bias_pct: number; target_months: number };
  region_h0_test?: { mae: number; median_abs_pct: number; bias_pct: number };
  ranking_validation?: { model: string; pr_auc: number; base_rate: number };
  rule_test?: {
    threshold: number;
    precision: number;
    lift: number;
    per_snapshot: number;
    gmv_captured: number;
  };
  caveats?: string[];
};

export type ExpectedM1Snapshot = {
  generatedAt: string;
  observationDate: string;
  targetMonth: string;
  targetMonthLabel: string;
  ruleVersion: string;
  /** Niveau historique officiel de l'équipe sur douze mois. */
  baseline: number;
  /** Force du pipe. 1,00 = niveau habituel des treize dernières semaines. */
  strength: number;
  multiplier: number;
  projection: number;
  rangeLo: number;
  rangeHi: number;
  confidence: string;
  calibratedLo: number | null;
  calibratedHi: number | null;
  /** Faux = la force du pipe sort de ce qui a été calibré : extrapolation. */
  strengthInRange: boolean;
  openGmv: number;
  scoredCount: number;
  threshold: number;
  dataAsOf: string | null;
  /** Vrai quand un import postérieur à la publication a été appliqué. */
  supersededByImport: boolean;
  reliability: ExpectedM1Reliability;
  opportunities: ExpectedM1Opportunity[];
  issues: string[];
};

type SnapRow = {
  generated_at: string;
  observation_date: string;
  target_month: string;
  rule_version: string;
  baseline: number;
  strength: number;
  multiplier: number;
  projection: number;
  range_lo: number;
  range_hi: number;
  confidence: string;
  calibrated_lo: number | null;
  calibrated_hi: number | null;
  strength_in_range: number;
  open_gmv: number;
  scored_count: number;
  probability_threshold: number;
  data_as_of: string | null;
  reliability: string;
};

type ScoreRow = {
  opportunity_id: string;
  owner: string | null;
  stage: string | null;
  amount: number | null;
  p_m1: number;
  expected_gmv: number;
  is_standby: number | null;
  standby_until: string | null;
  client_contact: string | null;
  opportunity_name: string | null;
  city: string | null;
  kanban_month: number | null;
  kanban_year: number | null;
  is_terminal: number | null;
  /** Non nul si l'affaire existe encore dans la table `opportunity`. */
  opportunity_exists: string | null;
  absent_since: string | null;
};

/** Dernier jour du mois, pour juger si un stand-by dépasse l'horizon. */
function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function buildExpectedM1(): ExpectedM1Snapshot | null {
  const db = getDb();
  const snap = db
    .prepare("SELECT * FROM expected_m1_snapshot ORDER BY generated_at DESC LIMIT 1")
    .get() as SnapRow | undefined;
  if (!snap) return null;

  const rows = db
    .prepare(
      // `name` sert de repli au contact client, comme `clientOf` dans
      // forecast-board : une affaire sans contact renseigné doit afficher son
      // libellé Salesforce, jamais son identifiant technique.
      `SELECT s.*, o.client_contact, o.name AS opportunity_name, o.city,
              o.kanban_month, o.kanban_year, o.is_terminal,
              o.opportunity_id AS opportunity_exists, o.absent_since
         FROM expected_m1_score s
         LEFT JOIN opportunity o ON substr(o.opportunity_id, 1, 15) = s.opportunity_id
        WHERE s.generated_at = ?`,
    )
    .all(snap.generated_at) as ScoreRow[];

  const currentImport =
    (
      db
        .prepare(
          "SELECT imported_at FROM import_run WHERE source_kind IN ('api','manual') ORDER BY id DESC LIMIT 1",
        )
        .get() as { imported_at: string } | undefined
    )?.imported_at ?? null;

  const end = monthEnd(snap.target_month);
  const issues: string[] = [];
  const seen = new Set<string>();
  const opportunities: ExpectedM1Opportunity[] = [];

  for (const r of rows) {
    if (seen.has(r.opportunity_id)) {
      issues.push(`Opportunité dupliquée écartée : ${r.opportunity_id}`);
      continue;
    }
    seen.add(r.opportunity_id);
    // L'état Salesforce a pu évoluer depuis la publication.
    if (r.is_terminal === 1) {
      issues.push(
        r.absent_since
          ? `Affaire sortie du périmètre source le ${r.absent_since}, écartée : ${r.opportunity_id}`
          : `Affaire devenue terminale depuis la publication, écartée : ${r.opportunity_id}`,
      );
      continue;
    }
    // Même garde-fou que sur l'horizon du mois : sans ligne d'opportunité,
    // `is_terminal` vaut NULL et l'affaire passait au travers du contrôle.
    if (r.opportunity_exists == null) {
      issues.push(`Affaire absente de la base d'opportunités, écartée : ${r.opportunity_id}`);
      continue;
    }
    if (!(r.p_m1 >= 0 && r.p_m1 <= 1)) {
      issues.push(`Probabilité M+1 hors bornes, affaire écartée : ${r.opportunity_id}`);
      continue;
    }
    const standbyUntil = r.standby_until;
    opportunities.push({
      opportunityId: r.opportunity_id,
      owner: matchTeamMember(r.owner)?.name ?? r.owner ?? "—",
      client: r.client_contact ?? r.opportunity_name ?? null,
      city: r.city,
      gmv: r.amount ?? 0,
      stage: r.stage,
      probability: r.p_m1,
      expectedGmv: r.expected_gmv,
      isStandby: r.is_standby === 1,
      standbyUntil,
      frozenM1: r.is_standby === 1 && standbyUntil != null && standbyUntil.slice(0, 10) > end,
      kanbanMonth:
        r.kanban_year && r.kanban_month
          ? `${r.kanban_year}-${String(r.kanban_month).padStart(2, "0")}`
          : null,
    });
  }

  return {
    generatedAt: snap.generated_at,
    observationDate: snap.observation_date,
    targetMonth: snap.target_month,
    targetMonthLabel: monthLabel(snap.target_month),
    ruleVersion: snap.rule_version,
    baseline: snap.baseline,
    strength: snap.strength,
    multiplier: snap.multiplier,
    projection: snap.projection,
    rangeLo: snap.range_lo,
    rangeHi: snap.range_hi,
    confidence: snap.confidence,
    calibratedLo: snap.calibrated_lo,
    calibratedHi: snap.calibrated_hi,
    strengthInRange: snap.strength_in_range === 1,
    openGmv: snap.open_gmv,
    scoredCount: snap.scored_count,
    threshold: snap.probability_threshold,
    dataAsOf: snap.data_as_of,
    supersededByImport:
      currentImport != null && snap.data_as_of != null && currentImport > snap.data_as_of,
    reliability: JSON.parse(snap.reliability || "{}") as ExpectedM1Reliability,
    opportunities,
    issues,
  };
}

/**
 * Les affaires éligibles à une ligne jaune M+1.
 *
 * Règles énoncées en clair, aucune n'est un réglage caché :
 *
 *   1. probabilité au moins égale au seuil validé par C8.1 ;
 *   2. non terminale — déjà garanti par la lecture ci-dessus ;
 *   3. non gelée au-delà du mois cible ;
 *   4. pas déjà déclarée sur le mois cible dans le Kanban ;
 *   5. pas déjà présente dans la Perspective du mois cible.
 *
 * Les points 4 et 5 exigent le déclaratif : ils sont donc passés en paramètres
 * plutôt que relus ici, pour qu'il n'existe qu'un seul endroit dans
 * l'application où le déclaratif est chargé.
 *
 * Aucun plafond de volume. Le seuil fait varier le nombre de suggestions avec la
 * qualité réelle du pipe ; un Top N fixe remonterait toujours dix affaires même
 * quand il n'y a rien à signaler.
 */
export function eligibleM1Suggestions(
  snapshot: ExpectedM1Snapshot,
  declaredOnTarget: Set<string>,
  inPerspective: Set<string>,
  threshold = EXPECTED_M1.probabilityThreshold,
): ExpectedM1Opportunity[] {
  return snapshot.opportunities
    .filter(
      (o) =>
        o.probability >= threshold &&
        !o.frozenM1 &&
        !declaredOnTarget.has(o.opportunityId) &&
        !inPerspective.has(o.opportunityId),
    )
    .sort((a, b) => b.probability - a.probability);
}

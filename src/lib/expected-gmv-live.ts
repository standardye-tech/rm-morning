/**
 * Lecture du scoring Expected GMV.
 *
 * L'application ne calcule aucune probabilité : elle lit le dernier scoring
 * produit par `expected:score`. Entraînement, scoring et affichage sont trois
 * opérations distinctes, et seule la dernière vit ici.
 *
 * Les deux horizons ne sont jamais fusionnés. Une probabilité à 7 jours répond
 * à « qui est proche de signer », une probabilité fin de mois à « combien le
 * mois va-t-il faire » : les additionner ne voudrait rien dire.
 *
 * Règle de construction des totaux : tout remonte des lignes d'opportunités.
 * Le sous-total d'un commercial est la somme de ses affaires, le total Région
 * la somme des commerciaux. Il n'existe pas de second chemin de calcul, donc
 * pas d'écart possible entre les niveaux (EC1, EC2).
 */

import { getDb } from "./db";
import { NEXT_EVENT_LABEL, type NextExpectedEvent } from "./opportunity-milestones";
import { matchTeamMember } from "./normalize";
import { officialSignedGmv } from "./official-signed";
import { clientLabel } from "./vocabulary";

export type ExpectedGmvFactor = {
  feature: string;
  value: string;
  weight: number;
  /**
   * « mesure » : le sens de la contribution est interprétable.
   * « categorie » : le signe dépend du point de référence de l'encodage et ne
   * doit pas être présenté comme une direction.
   */
  kind: "mesure" | "categorie";
  direction: "hausse" | "baisse";
};

export type ExpectedGmvOpportunity = {
  opportunityId: string;
  owner: string;
  /** Nom du client, avec repli lisible : jamais un identifiant, jamais vide. */
  client: string;
  city: string | null;
  gmv: number;
  stage: string | null;
  amountBin: string | null;
  p7d: number;
  expected7d: number;
  pMonthEnd: number;
  expectedMonthEnd: number;
  ageDays: number;
  /** Nul quand l'entrée dans l'étape courante n'est pas datable. */
  daysInStage: number | null;
  daysLeftInMonth: number;
  nextMilestone: string | null;
  nextMilestoneDueAt: string | null;
  /** Contexte déclaratif uniquement. N'entre dans aucun modèle. */
  kanbanMonth: string | null;
  factors: ExpectedGmvFactor[];
  isStandby: boolean;
  standbyUntil: string | null;
  /**
   * Contribution neutralisée par la règle stand-by : l'affaire est gelée
   * au-delà de l'horizon. La probabilité affichée reste celle du modèle.
   */
  frozen7d: boolean;
  frozenMonthEnd: boolean;
};

export type ExpectedGmvSalesperson = {
  salesperson: string;
  count: number;
  openGmv: number;
  expected7d: number;
  expectedMonthEnd: number;
  signedGmv: number;
  expectedFinish: number;
  opportunities: ExpectedGmvOpportunity[];
};

export type ExpectedGmvReliability = {
  month_end?: {
    model: string;
    median_abs_error_pct: number;
    bias_pct: number;
    mae: number;
    snapshots: number;
    interval_covered: number;
    interval_total: number;
    pr_auc: number;
    brier: number;
    test_window: string;
  };
  seven_days?: {
    model: string;
    pr_auc: number;
    brier: number;
    precision_at_10: number;
    lift_top_decile: number;
    calibration_top_decile: { predicted: number; observed: number };
    test_window: string;
  };
  backtest?: {
    date: string;
    month: string;
    signed_to_date: number;
    expected_finish: number;
    actual_finish: number;
    error: number;
    error_pct: number;
  }[];
};

export type ExpectedGmvSnapshot = {
  scoredAt: string;
  asOfDate: string;
  month: string;
  monthLabel: string;
  daysLeft: number;
  modelVersion: string;
  model7d: string;
  modelMonthEnd: string;
  sourceObservationDate: string;
  /** Horodatage de l'import Salesforce qui a servi de source. */
  dataAsOf: string | null;
  /** Horodatage de l'extraction des transitions d'étape. */
  historyAsOf: string | null;
  /** Heures écoulées entre l'état des données et le scoring. */
  dataAgeHours: number | null;
  /** Idem pour l'extraction des transitions, qui alimente days_in_stage. */
  historyAgeHours: number | null;
  /** Affaires dont l'entrée dans l'étape courante n'est pas datable. */
  stageFromImport: number;
  /**
   * Vrai quand un import d'opportunités plus récent que le scoring a été
   * appliqué : la prévision décrit alors un état que la base n'a plus.
   */
  supersededByImport: boolean;
  currentImportAt: string | null;
  /** Stand-by du pipe, et combien sont gelés au-delà de la fin du mois. */
  standby: { count: number; gmv: number; frozenMonthEnd: number };
  draws: number;
  region: {
    count: number;
    openGmv: number;
    expected7d: number;
    signedGmv: number;
    signedCount: number;
    expectedRemaining: number;
    expectedFinish: number;
    /** Quantiles du finish : signé à date + simulation du restant. */
    simMean: number;
    p10: number;
    p50: number;
    p90: number;
  };
  salespeople: ExpectedGmvSalesperson[];
  opportunities: ExpectedGmvOpportunity[];
  reliability: ExpectedGmvReliability;
  /** Totaux tels qu'écrits par le service de scoring, pour recoupement. */
  stored: { openGmv: number; expected7d: number; expectedRemaining: number; signedGmv: number };
  /**
   * Ce que l'interface a retiré du scoring, et ce que cela pesait.
   *
   * Le service score l'état du pipe au moment de la publication ; l'interface
   * lit l'état d'aujourd'hui. Entre les deux, une affaire a pu être signée,
   * clôturée, ou disparaître de la source. Elle est alors écartée — et son poids
   * est publié ici, pour que l'identité
   *
   *     agrégat affiché + agrégat écarté = agrégat du service
   *
   * reste vérifiable au centime. Sans ce compte, une exclusion légitime et une
   * dérive de calcul seraient indiscernables.
   */
  excluded: { count: number; openGmv: number; expected7d: number; expectedRemaining: number };
  issues: string[];
};

type SnapshotRow = {
  scored_at: string;
  as_of_date: string;
  month: string;
  days_left: number;
  source_observation_date: string;
  model_version: string;
  model_7d: string;
  model_month_end: string;
  scored_count: number;
  open_gmv: number;
  expected_7d: number;
  signed_to_date: number;
  expected_remaining: number;
  sim_mean: number | null;
  sim_p10: number | null;
  sim_p50: number | null;
  sim_p90: number | null;
  draws: number;
  reliability: string;
  data_as_of: string | null;
  history_as_of: string | null;
  stage_from_import: number | null;
  standby_count: number | null;
  standby_gmv: number | null;
  standby_frozen_month_end: number | null;
};

type ScoreRow = {
  opportunity_id: string;
  owner: string;
  stage: string | null;
  amount: number | null;
  amount_bin: string | null;
  age_days: number | null;
  days_in_stage: number | null;
  days_left_in_month: number;
  p_7d: number;
  p_month_end: number;
  expected_7d: number;
  expected_month_end: number;
  factors: string;
  is_standby: number | null;
  standby_until: string | null;
  frozen_7d: number | null;
  frozen_month_end: number | null;
  client_contact: string | null;
  opportunity_name: string | null;
  city: string | null;
  next_expected_event: string | null;
  next_expected_due_at: string | null;
  kanban_month: string | null;
  kanban_year: number | null;
  is_terminal: number | null;
  /** Non nul si l'affaire existe encore dans la table `opportunity`. */
  opportunity_exists: string | null;
  absent_since: string | null;
};

const MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

function parseFactors(raw: string): ExpectedGmvFactor[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as ExpectedGmvFactor[]) : [];
  } catch {
    return [];
  }
}

export function buildExpectedGmvSnapshot(): ExpectedGmvSnapshot | null {
  const db = getDb();
  const snap = db
    .prepare("SELECT * FROM expected_gmv_snapshot ORDER BY scored_at DESC LIMIT 1")
    .get() as SnapshotRow | undefined;
  if (!snap) return null;

  // La jointure passe par l'ID 15 caractères : le dataset porte la forme
  // Salesforce en 18, la table opportunity la forme canonique en 15.
  const rows = db
    .prepare(
      `SELECT s.*, o.client_contact, o.name AS opportunity_name, o.city, o.next_expected_event,
              o.next_expected_due_at, o.kanban_month, o.kanban_year, o.is_terminal,
              o.opportunity_id AS opportunity_exists, o.absent_since
         FROM expected_gmv_score s
         LEFT JOIN opportunity o ON substr(o.opportunity_id, 1, 15) = s.opportunity_id
        WHERE s.scored_at = ?`,
    )
    .all(snap.scored_at) as ScoreRow[];

  // État d'opportunités réellement chargé aujourd'hui. S'il est postérieur à
  // celui qui a servi au scoring, la prévision est périmée même si ses propres
  // horodatages paraissent frais — c'est exactement ce qui a rendu Forecast et
  // Expected incohérents au checkpoint du 17/08/2026.
  const currentImport =
    (
      db
        .prepare(
          "SELECT imported_at FROM import_run WHERE source_kind IN ('api','manual') ORDER BY id DESC LIMIT 1",
        )
        .get() as { imported_at: string } | undefined
    )?.imported_at ?? null;

  // Le GMV signé vient de la SOURCE OFFICIELLE (lignes Travaux), pas du journal
  // d'événements de signature. `expected_gmv_signed` reste utilisée pour exclure
  // du pipe les affaires déjà signées — c'est une question d'événement, pas de
  // montant — mais elle ne chiffre plus le réalisé.
  const official = officialSignedGmv(snap.month);
  const signedRows = official.bySalesperson.map((s) => ({ owner: s.salesperson, gmv: s.gmv }));

  const issues: string[] = [];
  const seen = new Set<string>();
  const excluded = { count: 0, openGmv: 0, expected7d: 0, expectedRemaining: 0 };
  /** Retire une ligne du périmètre affiché en conservant son poids mesuré. */
  const exclude = (r: ScoreRow, reason: string) => {
    issues.push(reason);
    const gmv = r.amount ?? 0;
    excluded.count += 1;
    excluded.openGmv += gmv;
    excluded.expected7d += r.frozen_7d === 1 ? 0 : gmv * r.p_7d;
    excluded.expectedRemaining += r.frozen_month_end === 1 ? 0 : gmv * r.p_month_end;
  };

  const opportunities: ExpectedGmvOpportunity[] = [];
  for (const r of rows) {
    // EC5 — une OpportunityId n'apparaît qu'une fois. La clé primaire de la
    // table l'impose déjà ; on le revérifie ici parce que la jointure pourrait
    // dupliquer si `opportunity` contenait deux formes du même identifiant.
    if (seen.has(r.opportunity_id)) {
      issues.push(`Opportunité dupliquée écartée : ${r.opportunity_id}`);
      continue;
    }
    seen.add(r.opportunity_id);

    // EC4 — l'état Salesforce a pu évoluer depuis le scoring.
    if (r.is_terminal === 1) {
      exclude(
        r,
        r.absent_since
          ? `Affaire sortie du périmètre source le ${r.absent_since}, écartée : ${r.opportunity_id}`
          : `Affaire devenue terminale depuis le scoring, écartée : ${r.opportunity_id}`,
      );
      continue;
    }
    // EC4 bis — le scoring porte un identifiant que la table d'opportunités ne
    // connaît plus du tout. `is_terminal` vaut alors NULL, et le contrôle
    // ci-dessus laissait passer l'affaire : c'est le second chemin par lequel un
    // dossier abandonné revenait dans le pipe. Sans ligne d'opportunité, aucun
    // fait Salesforce ne soutient plus cette contribution.
    if (r.opportunity_exists == null) {
      exclude(r, `Affaire absente de la base d'opportunités, écartée : ${r.opportunity_id}`);
      continue;
    }
    // EC6 — une probabilité hors [0, 1] serait un défaut du service de scoring,
    // pas quelque chose à corriger silencieusement à l'affichage.
    if (!(r.p_7d >= 0 && r.p_7d <= 1) || !(r.p_month_end >= 0 && r.p_month_end <= 1)) {
      // Poids NON comptabilisé : une probabilité hors bornes est un défaut du
      // service, pas une exclusion métier. L'ajouter aux écartés reviendrait à
      // faire boucler une identité comptable sur une valeur invalide.
      issues.push(`Probabilité hors bornes, affaire écartée : ${r.opportunity_id}`);
      continue;
    }

    const gmv = r.amount ?? 0;
    opportunities.push({
      opportunityId: r.opportunity_id,
      // Le scoring écrit le libellé brut Salesforce ; la forme canonique de
      // l'équipe est résolue ici, par la même table d'alias que les imports.
      owner: matchTeamMember(r.owner)?.name ?? r.owner,
      // Repli partagé avec Forecast et Morning : jamais d'identifiant technique,
      // jamais de cellule vide.
      client: clientLabel(r.client_contact, r.opportunity_name),
      city: r.city,
      gmv,
      stage: r.stage,
      amountBin: r.amount_bin,
      p7d: r.p_7d,
      // EC7 — la contribution est exactement le produit, sauf lorsque la règle
      // stand-by la neutralise. Elle est recalculée ici plutôt que relue : si le
      // service dérivait, l'écart apparaîtrait au contrôle plutôt que de se
      // propager à l'écran.
      expected7d: r.frozen_7d === 1 ? 0 : gmv * r.p_7d,
      pMonthEnd: r.p_month_end,
      expectedMonthEnd: r.frozen_month_end === 1 ? 0 : gmv * r.p_month_end,
      ageDays: r.age_days ?? 0,
      daysInStage: r.days_in_stage,
      daysLeftInMonth: r.days_left_in_month,
      // Libellé partagé avec Monitoring et Forecast : le jalon se lit de la
      // même façon partout dans l'application.
      nextMilestone: r.next_expected_event
        ? (NEXT_EVENT_LABEL[r.next_expected_event as NonNullable<NextExpectedEvent>] ??
           r.next_expected_event)
        : null,
      nextMilestoneDueAt: r.next_expected_due_at,
      kanbanMonth:
        r.kanban_year && r.kanban_month
          ? `${r.kanban_year}-${String(r.kanban_month).padStart(2, "0")}`
          : null,
      factors: parseFactors(r.factors),
      isStandby: r.is_standby === 1,
      standbyUntil: r.standby_until,
      frozen7d: r.frozen_7d === 1,
      frozenMonthEnd: r.frozen_month_end === 1,
    });
  }

  const signedByOwner = new Map<string, { gmv: number; count: number }>();
  for (const s of signedRows) {
    const owner = matchTeamMember(s.owner)?.name ?? s.owner;
    const cur = signedByOwner.get(owner) ?? { gmv: 0, count: 0 };
    signedByOwner.set(owner, { gmv: cur.gmv + s.gmv, count: cur.count + 1 });
  }

  const owners = new Set<string>([...opportunities.map((o) => o.owner), ...signedByOwner.keys()]);
  const salespeople: ExpectedGmvSalesperson[] = [...owners]
    .map((owner) => {
      const own = opportunities.filter((o) => o.owner === owner);
      const signed = signedByOwner.get(owner)?.gmv ?? 0;
      const expectedMonthEnd = own.reduce((t, o) => t + o.expectedMonthEnd, 0);
      return {
        salesperson: owner,
        count: own.length,
        openGmv: own.reduce((t, o) => t + o.gmv, 0),
        expected7d: own.reduce((t, o) => t + o.expected7d, 0),
        expectedMonthEnd,
        signedGmv: signed,
        expectedFinish: signed + expectedMonthEnd,
        opportunities: own,
      };
    })
    .sort((a, b) => a.salesperson.localeCompare(b.salesperson, "fr"));

  const expectedRemaining = salespeople.reduce((t, s) => t + s.expectedMonthEnd, 0);
  const signedGmv = salespeople.reduce((t, s) => t + s.signedGmv, 0);

  return {
    scoredAt: snap.scored_at,
    asOfDate: snap.as_of_date,
    month: snap.month,
    monthLabel: monthLabel(snap.month),
    daysLeft: snap.days_left,
    modelVersion: snap.model_version,
    model7d: snap.model_7d,
    modelMonthEnd: snap.model_month_end,
    sourceObservationDate: snap.source_observation_date,
    dataAsOf: snap.data_as_of,
    historyAsOf: snap.history_as_of,
    dataAgeHours:
      snap.data_as_of == null
        ? null
        : (new Date(snap.scored_at).getTime() - new Date(snap.data_as_of).getTime()) / 36e5,
    historyAgeHours:
      snap.history_as_of == null
        ? null
        : (new Date(snap.scored_at).getTime() - new Date(snap.history_as_of).getTime()) / 36e5,
    stageFromImport: snap.stage_from_import ?? 0,
    supersededByImport:
      currentImport != null && snap.data_as_of != null && currentImport > snap.data_as_of,
    currentImportAt: currentImport,
    standby: {
      count: snap.standby_count ?? 0,
      gmv: snap.standby_gmv ?? 0,
      frozenMonthEnd: snap.standby_frozen_month_end ?? 0,
    },
    draws: snap.draws,
    region: {
      count: opportunities.length,
      openGmv: salespeople.reduce((t, s) => t + s.openGmv, 0),
      expected7d: salespeople.reduce((t, s) => t + s.expected7d, 0),
      signedGmv,
      signedCount: official.lines,
      expectedRemaining,
      // EC3 — le finish est cette somme et rien d'autre.
      expectedFinish: signedGmv + expectedRemaining,
      // La simulation ne porte que sur le restant : le signé est acquis, il ne
      // se tire pas au sort. On le rajoute pour obtenir la zone du finish.
      simMean: signedGmv + (snap.sim_mean ?? 0),
      p10: signedGmv + (snap.sim_p10 ?? 0),
      p50: signedGmv + (snap.sim_p50 ?? 0),
      p90: signedGmv + (snap.sim_p90 ?? 0),
    },
    salespeople,
    opportunities,
    reliability: JSON.parse(snap.reliability || "{}") as ExpectedGmvReliability,
    stored: {
      openGmv: snap.open_gmv,
      expected7d: snap.expected_7d,
      expectedRemaining: snap.expected_remaining,
      signedGmv: snap.signed_to_date,
    },
    excluded,
    issues,
  };
}

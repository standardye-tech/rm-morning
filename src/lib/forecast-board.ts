/**
 * Modèle Forecast V1 — le tableau de pilotage Région → Commercial → Opportunité.
 *
 * À NE PAS CONFONDRE avec `forecast.ts`, qui produit le Bloc 2 du Morning
 * (mouvements hebdomadaires du déclaratif). Ici on construit une vue
 * consolidée d'un mois donné, dans l'esprit du classeur « Perspective M+1 ».
 *
 * VOCABULAIRE, strictement séparé :
 *   — Signé            : réalisé, daté par `DateSignatureDevis__c` ;
 *   — Projection Kanban: déclaratif ACTUEL du commercial dans Salesforce ;
 *   — Perspective      : snapshot hebdomadaire HISTORIQUE de ce déclaratif ;
 *   — Expected GMV     : prévision statistique — produite par le service
 *                        Expected, jamais recalculée ici ni approchée par le
 *                        scoring Morning.
 *
 * Identités garanties par construction :
 *   Total Région = Σ totaux commerciaux = Σ opportunités retenues.
 * Aucun total n'est calculé par un autre chemin.
 */

import { matchTeamMember } from "./normalize";
import { loadTeam } from "./team-store";
import { clientLabel } from "./vocabulary";
import { loadMilestoneOpportunities } from "./opportunity-metrics";
import {
  latestImport,
  forecastCurrentUpdatedAt,
  forecastSnapshotDates,
  loadForecastCurrent,
  loadForecastSnapshot,
  loadOpportunities,
} from "./repository";
import type { Opportunity } from "./types";
import {
  MILESTONE_LABEL,
  NEXT_EVENT_LABEL,
  type MilestoneStatus,
  type NextExpectedEvent,
} from "./opportunity-milestones";

/** Clé de mois « AAAA-MM », identique à celle du Google Sheet. */
export type MonthKey = string;

export type { ForecastMovement } from "./forecast-labels";
export { MOVEMENT_LABEL } from "./forecast-labels";
import type { ForecastMovement } from "./forecast-labels";

export type ForecastRow = {
  opportunityId: string;
  client: string;
  owner: string;
  stage: string | null;
  gmv: number | null;
  /** Mois projeté par la Projection Kanban actuelle. */
  kanbanMonth: MonthKey | null;
  kanbanRaw: string | null;
  isStandby: boolean;
  /** Mois déclaré lors de la dernière Perspective, si l'affaire y figure. */
  perspectiveMonth: MonthKey | null;
  perspectiveGmv: number | null;
  /** GMV brut déclaré lors de la dernière Perspective, avant confiance. */
  perspectiveRawGmv: number | null;
  perspectiveConfidence: number | null;
  movement: ForecastMovement;
  /** Prochain jalon issu du moteur C2. */
  nextExpectedEvent: NextExpectedEvent;
  nextExpectedLabel: string | null;
  milestoneStatus: MilestoneStatus | null;
  /** Lecture RM Morning, courte et factuelle. */
  reading: string | null;
  /**
   * Toujours nuls ici : Forecast V1 ne calcule aucune prévision statistique.
   * C'est `forecast-v2` qui les renseigne, en lisant le service Expected.
   */
  expectedProbability: null;
  expectedGmv: null;
};

export type ForecastSalespersonBlock = {
  salesperson: string;
  firstName: string;
  count: number;
  gmv: number;
  kanbanGmv: number;
  /** Part de la Perspective encore présente dans le pipe du jour. */
  perspectiveGmv: number;
  /** Total du snapshot du commercial, tel qu'il a été lu. */
  perspectiveSnapshotGmv: number;
  signedCount: number;
  signedGmv: number;
  opportunities: ForecastRow[];
};

export type ForecastRegionTotals = {
  count: number;
  gmv: number;
  kanbanGmv: number;
  /**
   * Part de la Perspective ENCORE présente dans le Salesforce du jour.
   *
   * Ce total ne somme que les lignes du snapshot retrouvées parmi les
   * opportunités actuelles : une affaire depuis signée, perdue ou déplacée en
   * sort. C'est une lecture utile — « que reste-t-il de ce qui était annoncé » —
   * mais ce n'est PAS la Perspective.
   */
  perspectiveGmv: number;
  /**
   * La Perspective, au sens propre : le total du snapshot hebdomadaire tel qu'il
   * a été lu dans le Google Sheet.
   *
   * Séparé du précédent depuis l'audit V1, qui a mesuré 984 k€ de snapshot réel
   * affichés comme 265 k€. Une photographie ne se réécrit pas en fonction de
   * l'état actuel du CRM : c'est précisément ce qu'on lui demande de fixer.
   */
  perspectiveSnapshotGmv: number;
  perspectiveSnapshotLines: number;
  signedCount: number;
  signedGmv: number;
  /** Signé + Projection Kanban restante. Nommé explicitement dans l'UI. */
  signedPlusKanban: number;
  objective: number | null;
  gapToObjective: number | null;
};

export type ForecastExit = {
  opportunityId: string;
  client: string;
  owner: string;
  perspectiveGmv: number | null;
  /** Où l'affaire est-elle passée ? */
  destination: string;
};

export type ForecastMonthBoard = {
  month: MonthKey;
  monthLabel: string;
  isCurrentMonth: boolean;
  updatedAt: string | null;
  /** Date de la Perspective utilisée pour ce mois (snapshot OU état courant). */
  perspectiveDate: string | null;
  /**
   * D'où vient la Perspective affichée :
   *   « courant »   — bloc « EN COURS » du classeur, la donnée la plus fraîche ;
   *   « snapshot »  — dernière photographie hebdomadaire figée ;
   *   null          — aucune Perspective pour ce mois.
   */
  perspectiveSource: "courant" | "snapshot" | null;
  /** « MAJ le » du classeur quand la Perspective vient de l'état courant. */
  perspectiveUpdatedAt: string | null;
  region: ForecastRegionTotals;
  salespeople: ForecastSalespersonBlock[];
  /** Présentes dans la dernière Perspective du mois, plus projetées dessus. */
  exits: ForecastExit[];
  /** Affaires très avancées projetées sur le mois suivant. Règles existantes. */
  candidates: ForecastRow[];
  /** Anomalies empêchant un calcul complet. */
  issues: string[];
};

const MONTH_FR = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

export function monthKey(date: Date): MonthKey {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key: MonthKey): string {
  const [y, m] = key.split("-").map(Number);
  return MONTH_FR.format(new Date(y, m - 1, 1));
}

export function shiftMonth(key: MonthKey, offset: number): MonthKey {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + offset, 1));
}

/** Mois projeté par la Projection Kanban, en clé « AAAA-MM ». */
function kanbanKey(o: Opportunity): MonthKey | null {
  if (!o.kanbanMonth || !o.kanbanYear) return null;
  return `${o.kanbanYear}-${String(o.kanbanMonth).padStart(2, "0")}`;
}

// Repli partagé avec Expected et Morning. L'identifiant technique n'est plus un
// repli acceptable : il ne dit rien au lecteur et se confond avec une donnée.
const clientOf = (o: Opportunity) => clientLabel(o.clientContact, o.name);

/**
 * Construit le tableau d'un mois.
 *
 * `monthOffset` : 0 pour M, 1 pour M+1. Le même moteur sert aux deux vues —
 * il n'existe volontairement aucune seconde logique parallèle.
 */
export function buildForecastBoard(monthOffset = 0, objective: number | null = null): ForecastMonthBoard {
  const lastImport = latestImport();
  const reference = lastImport?.snapshotDate ?? new Date().toISOString().slice(0, 10);
  const currentMonth = reference.slice(0, 7);
  const month = shiftMonth(currentMonth, monthOffset);
  const nextMonth = shiftMonth(month, 1);

  const opportunities = loadOpportunities();
  const issues: string[] = [];

  // --- Perspective LA PLUS FRAÎCHE disponible pour ce mois.
  //
  // Cet écran décrit l'état ACTUEL du forecast déclaré : il prend donc le bloc
  // « EN COURS », rafraîchi quotidiennement par le classeur, et ne retombe sur
  // la dernière photographie hebdomadaire que si l'état courant est absent.
  //
  // Un mois qui vient d'être ouvert — novembre au 02/09 — n'a encore aucun
  // snapshot figé mais possède déjà un bloc courant : il reste donc exploitable,
  // au lieu de paraître vide.
  //
  // La comparaison de deux photographies dans le temps, elle, reste
  // exclusivement historique : voir `forecast.ts`, qui n'utilise pas l'état
  // courant, sans quoi le mouvement « depuis la semaine dernière » comparerait
  // des choses de natures différentes.
  const freshest = (targetMonth: MonthKey) => {
    const current = loadForecastCurrent(targetMonth);
    if (current.length > 0) {
      return {
        lines: current,
        date: forecastCurrentUpdatedAt(targetMonth)?.slice(0, 10) ?? null,
        updatedAt: forecastCurrentUpdatedAt(targetMonth),
        source: "courant" as const,
      };
    }
    const dates = forecastSnapshotDates(targetMonth, reference);
    const date = dates[0] ?? null;
    return {
      lines: date ? loadForecastSnapshot(targetMonth, date) : [],
      date,
      updatedAt: null,
      source: date ? ("snapshot" as const) : null,
    };
  };

  const perspective = freshest(month);
  const perspectiveLines = perspective.lines;
  const perspectiveDate = perspective.date;
  const perspectiveSource = perspective.source;
  const perspectiveUpdatedAt = perspective.updatedAt;
  const perspectiveById = new Map(
    perspective.lines.filter((l) => l.opportunityId).map((l) => [l.opportunityId as string, l]),
  );

  // La Perspective du mois suivant sert à qualifier les glissements.
  const nextPerspectiveById = new Map(
    freshest(nextMonth)
      .lines.filter((l) => l.opportunityId)
      .map((l) => [l.opportunityId as string, l]),
  );

  // --- Jalons C2, quand ils ont été calculés.
  const milestones = new Map(loadMilestoneOpportunities().map((m) => [m.opportunityId, m]));

  // --- Périmètre du mois.
  //
  // Une affaire signée est du RÉALISÉ : elle sort du forecast restant, ce qui
  // rend tout double comptage impossible par construction.
  const signed = opportunities.filter(
    (o) => o.isSigned && (o.quoteSignatureDate ?? "").slice(0, 7) === month,
  );

  // Le stand-by conserve la sémantique déjà validée : il ne fait pas partie du
  // pipe actif. Ces affaires sont sorties du total et listées à part, jamais
  // silencieusement absorbées.
  const projectedAll = opportunities.filter((o) => !o.isTerminal && kanbanKey(o) === month);
  const standbyProjected = projectedAll.filter((o) => o.isStandby);
  const projected = projectedAll.filter((o) => !o.isStandby);
  if (standbyProjected.length > 0) {
    issues.push(
      `${standbyProjected.length} affaire(s) projetée(s) sur ${month} mais en stand-by, exclues du total (${Math.round(standbyProjected.reduce((s, o) => s + (o.gmv ?? 0), 0) / 1000)} k€)`,
    );
  }
  const missingKanban = opportunities.filter((o) => !o.isTerminal && !kanbanKey(o)).length;
  if (missingKanban > 0) {
    issues.push(`${missingKanban} opportunités actives sans Projection Kanban, hors périmètre mensuel`);
  }
  const missingGmv = projected.filter((o) => o.gmv == null).length;
  if (missingGmv > 0) issues.push(`${missingGmv} opportunité(s) projetée(s) sans GMV`);

  // --- Lignes.
  const rows: ForecastRow[] = projected.map((o) => {
    const line = perspectiveById.get(o.opportunityId) ?? null;
    const inNext = nextPerspectiveById.get(o.opportunityId) ?? null;
    const milestone = milestones.get(o.opportunityId);

    // Le mouvement compare le déclaratif D'AUJOURD'HUI à celui de la dernière
    // Perspective. Sans rattachement fiable, on ne déduit rien.
    let movement: ForecastMovement;
    if (line) {
      // « Renforcé » : le commercial a relevé le montant depuis la dernière
      // Perspective. Comparaison sur le GMV brut, jamais sur le projeté, qui
      // mêle montant et confiance.
      const before = line.gmv ?? null;
      const now = o.gmv ?? null;
      movement =
        before != null && now != null && now > before * 1.1 && now - before >= 5000
          ? "renforce"
          : "stable";
    } else if (inNext) movement = "revenu";
    else if (perspectiveDate) movement = "nouveau";
    else movement = "non_comparable";

    return {
      opportunityId: o.opportunityId,
      client: clientOf(o),
      owner: o.owner,
      stage: o.stage,
      gmv: o.gmv,
      kanbanMonth: kanbanKey(o),
      kanbanRaw: o.kanbanRaw,
      isStandby: o.isStandby,
      perspectiveMonth: line ? month : inNext ? nextMonth : null,
      perspectiveGmv: line?.projectedGmv ?? inNext?.projectedGmv ?? null,
      perspectiveRawGmv: line?.gmv ?? inNext?.gmv ?? null,
      perspectiveConfidence: line?.confidence ?? inNext?.confidence ?? null,
      movement,
      nextExpectedEvent: milestone?.nextExpectedEvent ?? null,
      nextExpectedLabel: milestone?.nextExpectedEvent
        ? NEXT_EVENT_LABEL[milestone.nextExpectedEvent]
        : null,
      milestoneStatus: milestone?.milestoneStatus ?? null,
      reading: milestone
        ? milestone.milestoneStatus === "normal"
          ? null
          : MILESTONE_LABEL[milestone.milestoneStatus]
        : null,
      expectedProbability: null,
      expectedGmv: null,
    } satisfies ForecastRow;
  });

  // --- Regroupement par commercial. Les sous-totaux sont l'agrégation exacte
  //     des lignes affichées : aucun calcul parallèle.
  const signedByOwner = new Map<string, Opportunity[]>();
  for (const o of signed) {
    signedByOwner.set(o.owner, [...(signedByOwner.get(o.owner) ?? []), o]);
  }

  const team = loadTeam();
  const salespeople: ForecastSalespersonBlock[] = team.map((member) => {
    const mine = rows.filter((r) => r.owner === member.name);
    const mySigned = signedByOwner.get(member.name) ?? [];
    return {
      salesperson: member.name,
      firstName: member.firstName,
      count: mine.length,
      gmv: mine.reduce((s, r) => s + (r.gmv ?? 0), 0),
      kanbanGmv: mine.reduce((s, r) => s + (r.gmv ?? 0), 0),
      perspectiveGmv: mine.reduce((s, r) => s + (r.perspectiveGmv ?? 0), 0),
      // Le snapshot du commercial, lu dans le classeur et non recalculé sur le
      // pipe du jour : c'est ce que « Dernière Perspective » doit dire.
      perspectiveSnapshotGmv: perspectiveLines
        .filter((l) => matchTeamMember(l.salesperson)?.name === member.name)
        .reduce((t, l) => t + (l.projectedGmv ?? 0), 0),
      signedCount: mySigned.length,
      signedGmv: mySigned.reduce((s, o) => s + (o.gmv ?? 0), 0),
      opportunities: mine,
    };
  }).filter((s) => s.count > 0 || s.signedCount > 0);

  // Un commercial hors équipe ne doit jamais entrer dans les totaux.
  const outsiders = rows.filter((r) => !team.some((m) => m.name === r.owner));
  if (outsiders.length > 0) {
    issues.push(`${outsiders.length} opportunité(s) portée(s) par un commercial hors équipe`);
  }

  const region: ForecastRegionTotals = {
    count: salespeople.reduce((s, p) => s + p.count, 0),
    gmv: salespeople.reduce((s, p) => s + p.gmv, 0),
    kanbanGmv: salespeople.reduce((s, p) => s + p.kanbanGmv, 0),
    perspectiveGmv: salespeople.reduce((s, p) => s + p.perspectiveGmv, 0),
    // Lu directement dans le snapshot, sans passer par les opportunités du jour.
    perspectiveSnapshotGmv: perspectiveLines.reduce((t, l) => t + (l.projectedGmv ?? 0), 0),
    perspectiveSnapshotLines: perspectiveLines.length,
    signedCount: salespeople.reduce((s, p) => s + p.signedCount, 0),
    signedGmv: salespeople.reduce((s, p) => s + p.signedGmv, 0),
    signedPlusKanban: 0,
    objective,
    gapToObjective: null,
  };
  region.signedPlusKanban = region.signedGmv + region.kanbanGmv;
  region.gapToObjective = objective == null ? null : region.signedPlusKanban - objective;

  // --- Sorties depuis la dernière Perspective : répond à « pourquoi le
  //     forecast a-t-il baissé cette semaine ? ».
  const inBoard = new Set(rows.map((r) => r.opportunityId));
  const exits: ForecastExit[] = [];
  for (const [id, line] of perspectiveById) {
    if (inBoard.has(id)) continue;
    const o = opportunities.find((x) => x.opportunityId === id);
    const destination = !o
      ? "absente de Salesforce"
      : o.isSigned
        ? "signée"
        : o.isTerminal
          ? "clôturée"
          : o.isStandby
            ? "passée en stand-by"
            : kanbanKey(o)
              ? `reprojetée sur ${kanbanKey(o)}`
              : "sans projection Kanban";
    exits.push({
      opportunityId: id,
      client: o ? clientOf(o) : (line.opportunityLabel ?? id),
      owner: o?.owner ?? line.salesperson,
      perspectiveGmv: line.projectedGmv,
      destination,
    });
  }

  // --- Candidats à examiner : uniquement sur des règles déjà existantes,
  //     jamais sur une heuristique inventée pour l'occasion.
  const candidates: ForecastRow[] = opportunities
    .filter((o) => !o.isTerminal && !o.isStandby && kanbanKey(o) === nextMonth)
    .filter((o) => {
      const m = milestones.get(o.opportunityId);
      return o.stage === "Signature" || m?.nextExpectedEvent === "signature";
    })
    .map((o) => {
      const m = milestones.get(o.opportunityId);
      return {
        opportunityId: o.opportunityId,
        client: clientOf(o),
        owner: o.owner,
        stage: o.stage,
        gmv: o.gmv,
        kanbanMonth: kanbanKey(o),
        kanbanRaw: o.kanbanRaw,
        isStandby: o.isStandby,
        perspectiveMonth: null,
        perspectiveGmv: null,
        perspectiveRawGmv: null,
        perspectiveConfidence: null,
        movement: "non_comparable" as ForecastMovement,
        nextExpectedEvent: m?.nextExpectedEvent ?? null,
        nextExpectedLabel: m?.nextExpectedEvent ? NEXT_EVENT_LABEL[m.nextExpectedEvent] : null,
        milestoneStatus: m?.milestoneStatus ?? null,
        reading: m && m.milestoneStatus !== "normal" ? MILESTONE_LABEL[m.milestoneStatus] : null,
        expectedProbability: null,
        expectedGmv: null,
      } satisfies ForecastRow;
    });

  return {
    month,
    monthLabel: monthLabel(month),
    isCurrentMonth: monthOffset === 0,
    updatedAt: lastImport?.importedAt ?? null,
    perspectiveDate,
    perspectiveSource,
    perspectiveUpdatedAt,
    region,
    salespeople,
    exits,
    candidates,
    issues,
  };
}

/**
 * Glissements constatés : affaires de la dernière Perspective M désormais
 * projetées sur M+1. Calculé à part du tableau, qui ne montre que M.
 */
export function forecastSlippage(board: ForecastMonthBoard): ForecastExit[] {
  return board.exits.filter((e) => e.destination.startsWith("reprojetée sur"));
}

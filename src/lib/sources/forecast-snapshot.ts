/**
 * Contrat de la source de snapshots de forecast (Google Sheet hebdomadaire).
 *
 * Le classeur porte un onglet par mois (« 2026-08 »). Chaque lundi, un bloc de
 * colonnes est ajouté à droite ; les blocs passés ne sont jamais réécrits.
 * Une ligne = une opportunité, avec pour chaque snapshot : confiance, GMV, CA,
 * les versions pondérées, et un état.
 *
 * Deux implémentations partagent le même parseur :
 *   — `HttpForecastSnapshotSource`   : export CSV gviz, source principale ;
 *   — `ManualForecastSnapshotSource` : CSV déposés à la main, secours.
 */

import type { ParseIssue } from "./salesforce";
import type { SheetRowIssue } from "./forecast-sheet-parser";

/** États déclarés dans le Sheet. Conservés tels quels, jamais réinterprétés. */
export const FORECAST_STATES = ["Gagnée", "Perdue", "Repoussée", "Nouvelle"] as const;

export type ForecastSnapshotLine = {
  /** Date du snapshot hebdomadaire (le lundi), format ISO. */
  snapshotDate: string;
  /** Mois forecasté, c'est-à-dire l'onglet d'origine, format « AAAA-MM ». */
  forecastMonth: string;

  /** ID Salesforce normalisé sur 15 caractères. null pour une ligne manuelle. */
  opportunityId: string | null;
  /** Clé de ligne : l'ID s'il existe, sinon le libellé — pour ne rien perdre. */
  rowKey: string;

  /** Nom du commercial tel qu'écrit dans le Sheet. */
  salespersonRaw: string | null;
  /** Direction régionale, telle qu'écrite dans le Sheet. */
  region: string | null;
  opportunityLabel: string | null;

  /** Confiance déclarée, ramenée à une fraction de 0 à 1. */
  confidence: number | null;
  gmv: number | null;
  ca: number | null;
  /** GMV × confiance, tel que calculé par le Sheet. */
  projectedGmv: number | null;

  /** « Gagnée », « Perdue », « Repoussée », « Nouvelle », ou null. */
  state: string | null;
};

/**
 * ÉTAT COURANT d'une ligne, lu dans le bloc « EN COURS » du classeur.
 *
 * Même forme qu'un snapshot, à une différence près, et elle est essentielle :
 * pas de `snapshotDate`. Cette ligne ne décrit pas un lundi, elle décrit
 * AUJOURD'HUI. Elle est remplacée à chaque import, jamais accumulée, et ne
 * touche jamais l'historique figé.
 */
export type ForecastCurrentLine = Omit<ForecastSnapshotLine, "snapshotDate"> & {
  /** Horodatage « MAJ le … » lu dans l'étiquette. Null si le classeur l'omet. */
  updatedAt: string | null;
};

export type ForecastFetchResult = {
  sourceKind: string;
  sourceLabel: string;
  fetchedAt: Date;
  /** Onglets mensuels effectivement lus. */
  months: string[];
  /** Dates de snapshot rencontrées, toutes onglets confondus. */
  snapshotDates: string[];
  /** Onglets dont le bloc courant a été lu : ceux-là seuls sont remplacés. */
  currentMonths: string[];
  /** « MAJ le » le plus récent, toutes onglets confondus. */
  currentUpdatedAt: string | null;
  lines: ForecastSnapshotLine[];
  /** État courant, tenu à part de l'historique. */
  currentLines: ForecastCurrentLine[];
  /** Anomalies de STRUCTURE : toujours réelles, indépendantes du périmètre. */
  issues: ParseIssue[];
  /**
   * Anomalies de ligne CANDIDATES. L'import ne retient que celles dont la ligne
   * appartient au périmètre RM Morning : une ligne hors équipe ou hors
   * territoire est écartée sans être signalée.
   */
  rowIssues: SheetRowIssue[];
};

export interface ForecastSnapshotSource {
  readonly kind: string;
  /** Lit les onglets demandés (« 2026-08 »…). Un onglet absent est ignoré. */
  fetch(months: string[]): Promise<ForecastFetchResult>;
}

/** Implémentation vide, utile pour désactiver le forecast sans casser le reste. */
export class NoForecastSnapshotSource implements ForecastSnapshotSource {
  readonly kind = "none";

  async fetch(): Promise<ForecastFetchResult> {
    return {
      sourceKind: this.kind,
      sourceLabel: "Aucune source de forecast",
      fetchedAt: new Date(),
      months: [],
      snapshotDates: [],
      currentMonths: [],
      currentUpdatedAt: null,
      lines: [],
      currentLines: [],
      issues: [],
      rowIssues: [],
    };
  }
}

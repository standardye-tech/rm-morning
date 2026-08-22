/**
 * Libellés et énumérations Forecast, sans aucune dépendance.
 *
 * Existe pour une raison technique précise : la feuille Forecast est un
 * composant client (elle déplie les groupes localement), et elle ne doit donc
 * importer aucun module qui touche la base. `forecast-board` et `forecast-v2`
 * réexportent ces valeurs pour ne pas dupliquer la source.
 */

export type ForecastMovement =
  | "stable"
  | "renforce"
  | "glissement"
  | "revenu"
  | "sorti"
  | "nouveau"
  | "non_comparable";

export const MOVEMENT_LABEL: Record<ForecastMovement, string> = {
  stable: "Stable",
  renforce: "Renforcé",
  glissement: "Glissement",
  revenu: "Revenu sur M",
  sorti: "Sorti du forecast",
  nouveau: "Nouveau",
  non_comparable: "Non comparable",
};

/**
 * Les motifs pour lesquels RM Morning conseille de challenger.
 *
 * `non_prevue_m1` est propre à l'horizon M+1 : l'affaire a une chance réelle de
 * signer le mois prochain et le commercial ne l'y a pas placée. C'est le seul
 * motif de challenge produit à cet horizon — C8.1 n'a validé aucune règle
 * permettant de qualifier de « fragile » une affaire déjà déclarée sur M+1.
 */
export type ChallengeKind =
  | "absente_du_mois"
  | "prevue_mois_suivant"
  | "declaree_fragile"
  | "non_prevue_m1";

export const CHALLENGE_LABEL: Record<ChallengeKind, string> = {
  absente_du_mois: "Pas prévue ce mois",
  prevue_mois_suivant: "Prévue le mois prochain",
  declaree_fragile: "Prévue ce mois mais fragile",
  non_prevue_m1: "Pas prévue le mois prochain",
};

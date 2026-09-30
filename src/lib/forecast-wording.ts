/**
 * Forecast — mise en mots des totaux de la feuille.
 *
 * PRÉSENTATION SEULE : chaque montant est reçu tel que la page l'a sommé
 * (`page.tsx`, `sheetTotals` et les groupes). Rien ici ne calcule un agrégat,
 * ne filtre une ligne ni ne touche un seuil. Module pur, sans JSX, pour que les
 * harnais `verify-*` puissent l'éprouver directement.
 */

import { montant } from "./momentum-wording";

/** « 1 affaire affichée », « 4 affaires affichées ». */
export function shownCount(count: number): string {
  return count > 1 ? `${count} affaires affichées` : `${count} affaire affichée`;
}

/**
 * Une contribution pondérée réelle, même petite, ne se lit jamais « 0 k€ » :
 * sous 1 000 € elle s'écrit à l'euro. En dessous de l'euro, il n'y a rien à
 * nommer.
 */
export function hasWeightedContribution(value: number | null | undefined): boolean {
  return value != null && Math.round(value) >= 1;
}

export type ForecastGroupFigures = {
  signedGmv: number;
  declaredOpenGmv: number;
  adjustedGmv: number | null;
  expectedGmv: number;
  rowCount: number;
};

/**
 * Ligne de résumé d'un commercial.
 *
 * Le signé est dit dès qu'il est non nul, y compris négatif (un commercial dont
 * le seul mouvement du mois est une moins-value) : il compte dans le signé
 * officiel et dans l'atterrissage, le taire rendrait la ligne fausse.
 * « Aucun potentiel supplémentaire identifié » ne parle que du pondéré RM
 * restant — il ne dit rien du signé, qui est écrit à côté.
 */
export function groupSummary(g: ForecastGroupFigures, showExpected: boolean): string {
  const parts = [`Reste annoncé ${montant(g.declaredOpenGmv)}`];
  if (g.signedGmv !== 0) {
    parts.push(`Signé ${montant(g.signedGmv)}`, `Atterrissage ${montant(g.declaredOpenGmv + g.signedGmv)}`);
  }
  if (g.adjustedGmv != null) parts.push(`Perspective ajustée ${montant(g.adjustedGmv)}`);
  parts.push(shownCount(g.rowCount));
  if (showExpected) {
    parts.push(
      hasWeightedContribution(g.expectedGmv)
        ? `Potentiel RM restant pondéré : ${montant(g.expectedGmv)}`
        : "Aucun potentiel supplémentaire identifié",
    );
  }
  return parts.join(" · ");
}

export type SignedRowSituation = { label: string; tone: "neutral" | "positive" };

/**
 * Situation d'une ligne signée (une par affaire, lignes Travaux du mois
 * fusionnées). Négative : moins-value — elle reste dans le signé officiel mais
 * n'est pas une affaire gagnée. `null` : la ligne suit le mouvement ordinaire.
 */
export function signedRowSituation(row: { isSignedRow: boolean; gmv: number | null }): SignedRowSituation | null {
  if (row.isSignedRow && (row.gmv ?? 0) < 0) return { label: "Moins-value signée", tone: "neutral" };
  return null;
}

export type ForecastFooterTotals = {
  signed: number;
  declaredOpen: number;
  expectedRemaining: number;
};

/**
 * Pied de la feuille : chaque montant porte son nom, pour tout le périmètre.
 *
 *   Signé à date            = Σ signé officiel (Travaux) du périmètre
 *   Reste annoncé           = Σ lignes ouvertes de la Perspective, signé exclu
 *   Atterrissage commercial = Signé à date + Reste annoncé (même somme que la bande)
 *   Contribution RM pondérée du reste
 *                           = Σ (GMV × chance de signer) des affaires éligibles
 *                             non signées ; Signé + elle = Prévision RM Morning
 *
 * Sur M+1, la somme pondérée n'est pas la projection du mois ; sur M+2 elle
 * n'existe pas. Le libellé le dit plutôt que de laisser un chiffre nu.
 */
export function footerItems(
  t: ForecastFooterTotals,
  opts: { horizon: 0 | 1 | 2; showExpected: boolean },
): { primary: string[]; detail: string[] } {
  const primary = [
    `Signé à date : ${montant(t.signed)}`,
    `Reste annoncé : ${montant(t.declaredOpen)}`,
    `Atterrissage commercial : ${montant(t.signed + t.declaredOpen)}`,
  ];
  const detail: string[] = [];
  if (opts.showExpected) {
    const z = hasWeightedContribution(t.expectedRemaining) ? montant(t.expectedRemaining) : "aucune";
    detail.push(
      opts.horizon === 1
        ? `Contribution RM pondérée du reste : ${z} (somme des affaires, pas la projection du mois, au-dessus)`
        : `Contribution RM pondérée du reste : ${z}`,
    );
  } else if (opts.horizon === 2) {
    detail.push("Déclaratif seul : pas de contribution RM à cet horizon");
  }
  return { primary, detail };
}

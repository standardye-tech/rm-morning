/**
 * Momentum 7 jours — mise en phrases des compteurs d'un commercial.
 *
 * PRÉSENTATION SEULE : les compteurs sont ceux de `aggregateOwnerMomentum`,
 * tels quels. Rien ici ne touche à la note, aux pondérations ni au tri.
 */

import type { OwnerMomentum } from "./since-last-snapshot";
import { kEur, LABEL } from "./vocabulary";

/** « 1 affaire signée », « 3 affaires signées » : le participe s'accorde avec le nombre. */
export function affaires(count: number, participle: string): string {
  return count > 1 ? `${count} affaires ${participle}s` : `${count} affaire ${participle}`;
}

/**
 * Montant lisible d'un mouvement : en k€ dès 1 000 €, à l'euro en dessous —
 * un mouvement réel ne s'affiche jamais « 0 k€ » (−157,92 € → « −158 € »).
 * `signed` préfixe « + » aux montants positifs ; « − » est toujours écrit.
 */
export function montant(value: number, signed = false): string {
  const abs = Math.abs(value);
  const body = Math.round(abs) >= 1000 ? kEur(abs) : `${Math.round(abs)} €`;
  if (value < 0) return `−${body}`;
  return signed && value > 0 ? `+${body}` : body;
}

export type Tone = "up" | "down" | "neutral";
export type Movement = { tone: Tone; label: string; text: string };

/**
 * Le signé de la fenêtre, séparé par SIGNE. `signed` somme des lignes Travaux
 * signées ou réalisées — contrats d'origine, mais aussi avenants, moins-values
 * et annulations (définition officielle, `official-signed.ts`) : une
 * opportunité qui y figure n'est donc pas forcément une nouvelle affaire
 * signée. Chaque opportunité est rangée selon le signe de SON total sur la
 * fenêtre ; un total nul (lignes qui s'annulent) ne produit aucune phrase.
 */
function signedSplit(o: OwnerMomentum): { positive: number; negative: number; negativeCount: number } {
  let positive = 0, negative = 0, negativeCount = 0;
  for (const c of o.changes) {
    if (!c.signed) continue;
    if (c.signed.gmv > 0) positive += c.signed.gmv;
    else if (c.signed.gmv < 0) { negative += c.signed.gmv; negativeCount += 1; }
  }
  return { positive, negative, negativeCount };
}

/**
 * Les mouvements NON NULS d'un commercial, en phrases : hausses d'abord, puis
 * baisses, puis le neutre (changements d'étape, sans sens validé). Présentation
 * seule — les compteurs sont ceux de `aggregateOwnerMomentum`, tels quels.
 */
export function movementsOf(o: OwnerMomentum): Movement[] {
  const s = signedSplit(o);
  const all: (Movement & { count: number })[] = [
    {
      tone: "up",
      count: s.positive > 0 ? 1 : 0,
      label: LABEL.momentumSigned,
      // « positif » seulement quand des moins-values coexistent : sinon le mot n'apprend rien.
      text: `${s.negative < 0 ? "GMV signé positif" : "GMV signé sur 7 jours"} · ${montant(s.positive, true)}`,
    },
    { tone: "up", count: o.enteredM.count, label: LABEL.momentumEnteredM, text: `${affaires(o.enteredM.count, "avancée")} sur ce mois · ${montant(o.enteredM.gmv)}` },
    { tone: "up", count: o.gmvUp.count, label: LABEL.momentumGmvUp, text: `${affaires(o.gmvUp.count, "revue")} à la hausse · ${montant(o.gmvUp.gmv, true)}` },
    { tone: "up", count: o.standbyReturned, label: LABEL.momentumStandby, text: affaires(o.standbyReturned, "réactivée") },
    {
      tone: "down",
      count: s.negativeCount,
      label: LABEL.momentumSignedDown,
      text: `${s.negativeCount > 1 ? "Moins-values signées" : "Moins-value signée"} · ${montant(s.negative)}`,
    },
    { tone: "down", count: o.exitedM.count, label: LABEL.momentumExitedM, text: `${affaires(o.exitedM.count, "repoussée")} hors de ce mois · ${montant(o.exitedM.gmv)}` },
    { tone: "down", count: o.gmvDown.count, label: LABEL.momentumGmvDown, text: `${affaires(o.gmvDown.count, "revue")} à la baisse · ${montant(o.gmvDown.gmv, true)}` },
    { tone: "down", count: o.standbyEntered, label: LABEL.momentumStandby, text: `${affaires(o.standbyEntered, "mise")} en pause` },
    {
      tone: "neutral",
      count: o.stageChangedCount,
      label: LABEL.momentumStages,
      text: `${o.stageChangedCount} ${o.stageChangedCount > 1 ? "affaires ont" : "affaire a"} changé d’étape`,
    },
  ];
  return all.filter((m) => m.count > 0);
}

/** Les familles restées à zéro, regroupées en une ligne secondaire plutôt qu'en lignes « 0 ». */
export function quietOf(o: OwnerMomentum): string[] {
  const quiet: string[] = [];
  if (o.signed.count === 0) quiet.push("Aucun GMV signé");
  if (o.enteredM.count === 0 && o.exitedM.count === 0) quiet.push("Aucune affaire avancée ou repoussée sur le mois");
  if (o.gmvUp.count === 0 && o.gmvDown.count === 0) quiet.push("Aucun montant revu");
  if (o.standbyEntered === 0 && o.standbyReturned === 0) quiet.push("Aucune mise en pause / réactivation");
  if (o.stageChangedCount === 0) quiet.push("Aucun changement d’étape");
  return quiet;
}

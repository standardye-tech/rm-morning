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

export type Tone = "up" | "down" | "neutral";
export type Movement = { tone: Tone; label: string; text: string };

/**
 * Les mouvements NON NULS d'un commercial, en phrases : hausses d'abord, puis
 * baisses, puis le neutre (changements d'étape, sans sens validé). Présentation
 * seule — les compteurs sont ceux de `aggregateOwnerMomentum`, tels quels.
 */
export function movementsOf(o: OwnerMomentum): Movement[] {
  const all: (Movement & { count: number })[] = [
    { tone: "up", count: o.signed.count, label: LABEL.momentumSigned, text: `${affaires(o.signed.count, "signée")} · ${kEur(o.signed.gmv)}` },
    { tone: "up", count: o.enteredM.count, label: LABEL.momentumEnteredM, text: `${affaires(o.enteredM.count, "avancée")} sur ce mois · ${kEur(o.enteredM.gmv)}` },
    { tone: "up", count: o.gmvUp.count, label: LABEL.momentumGmvUp, text: `${affaires(o.gmvUp.count, "revue")} à la hausse · +${kEur(o.gmvUp.gmv)}` },
    { tone: "up", count: o.standbyReturned, label: LABEL.momentumStandby, text: affaires(o.standbyReturned, "réactivée") },
    { tone: "down", count: o.exitedM.count, label: LABEL.momentumExitedM, text: `${affaires(o.exitedM.count, "repoussée")} hors de ce mois · ${kEur(o.exitedM.gmv)}` },
    { tone: "down", count: o.gmvDown.count, label: LABEL.momentumGmvDown, text: `${affaires(o.gmvDown.count, "revue")} à la baisse · ${kEur(o.gmvDown.gmv)}` },
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
  if (o.signed.count === 0) quiet.push("Aucune signature");
  if (o.enteredM.count === 0 && o.exitedM.count === 0) quiet.push("Aucune affaire avancée ou repoussée sur le mois");
  if (o.gmvUp.count === 0 && o.gmvDown.count === 0) quiet.push("Aucun montant revu");
  if (o.standbyEntered === 0 && o.standbyReturned === 0) quiet.push("Aucune mise en pause / réactivation");
  if (o.stageChangedCount === 0) quiet.push("Aucun changement d’étape");
  return quiet;
}

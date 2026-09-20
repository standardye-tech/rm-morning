/**
 * Affaire « figée » : la règle, écrite une seule fois.
 *
 * Elle vivait dans `week.ts` (moteur d'attention de « Ma semaine »). Le Plan du
 * jour en a besoin à l'identique — une affaire figée ne doit pas être figée
 * pour Ma semaine et mouvante pour le Morning — d'où cette extraction, sans
 * aucun changement de règle.
 *
 * Une affaire est figée si AUCUN changement d'étape n'est prouvé par les
 * snapshots depuis `ATTENTION.stagnantDays` jours ET si Salesforce n'y a vu
 * aucune activité depuis autant de jours (ou jamais). La preuve est une borne
 * basse : les snapshots ne remontent qu'au 16/08/2026, on dit donc toujours
 * « depuis au moins N jours ».
 *
 * Module sans accès base : les snapshots sont fournis par l'appelant.
 */

import { ATTENTION } from "./config";
import { daysSinceActivity } from "./metrics";
import type { StageStability } from "./stage-history";
import type { Opportunity } from "./types";

export function isStagnant(
  o: Opportunity,
  stability: Map<string, StageStability>,
  today: string,
): boolean {
  const s = stability.get(o.opportunityId);
  if (!s || s.provenDays < ATTENTION.stagnantDays) return false;
  const activity = daysSinceActivity(o, today);
  return activity == null || activity >= ATTENTION.stagnantDays;
}

export function stagnantDeals(
  mine: Opportunity[],
  stability: Map<string, StageStability>,
  today: string,
): Opportunity[] {
  return mine.filter((o) => isStagnant(o, stability, today));
}

/**
 * Ce que l'on peut dire du mouvement d'une affaire, sans jamais inventer.
 * Rend null quand rien de prouvé ne mérite d'être écrit.
 */
export function movementText(
  o: Opportunity,
  stability: Map<string, StageStability>,
  today: string,
): string | null {
  const s = stability.get(o.opportunityId);
  if (!s) return null;
  if (isStagnant(o, stability, today)) {
    return `aucun mouvement depuis au moins ${s.provenDays} jours`;
  }
  if (s.changeObserved && s.provenDays <= ATTENTION.stagnantDays) {
    return s.provenDays <= 0 ? "étape changée aujourd'hui" : `étape changée il y a ${s.provenDays} j`;
  }
  return null;
}

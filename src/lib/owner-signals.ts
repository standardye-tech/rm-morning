/**
 * Signaux PAR COMMERCIAL : pipe insuffisant, affaires figées.
 *
 * Ce ne sont pas des affaires, donc ils ne prennent plus de place dans le Plan du
 * jour, qui ne contient que des affaires individuelles. Ils restent calculés ici,
 * avec les règles et les seuils d'`attention.ts` (jamais recopiés), pour
 * Performance et « Ma semaine » : la liste EXHAUSTIVE des affaires figées de
 * chaque commercial est fournie (`stagnant`), prête pour une future vue.
 */

import { ATTENTION } from "./config";
import { parisDate } from "./business-time";
import { computeMetrics } from "./metrics";
import { absenceSignals, type AbsenceSignals } from "./morning-plan-select";
import { loadOpportunities } from "./repository";
import { loadStageStability } from "./stage-history";
import { stagnantDeals } from "./stagnation";
import { loadTeam } from "./team-store";
import type { Opportunity } from "./types";
import { clientLabel } from "./vocabulary";

export type OwnerSignals = AbsenceSignals & {
  owner: string;
  firstName: string;
  activeCount: number;
  activeGmv: number;
  /** Liste exhaustive des affaires actives figées de ce commercial. */
  stagnant: Opportunity[];
};

/** Un commerciale par ligne, Sami (directeur) exclu comme dans le moteur d'attention. */
export function buildOwnerSignals(now = new Date()): OwnerSignals[] {
  const today = parisDate(now);
  const opportunities = loadOpportunities();
  const stability = loadStageStability(today);
  const pipeByOwner = new Map(computeMetrics(opportunities, today).owners.map((o) => [o.owner, o]));
  const out: OwnerSignals[] = [];
  for (const member of loadTeam()) {
    if ((ATTENTION.excluded as readonly string[]).includes(member.name)) continue;
    const mine = opportunities.filter((o) => o.isActive && o.owner === member.name);
    const stagnant = stagnantDeals(mine, stability, today);
    const pipeRow = pipeByOwner.get(member.name);
    const activeGmv = pipeRow?.activeGmv ?? 0;
    const signals = absenceSignals({
      salesperson: member.name,
      firstName: member.firstName,
      activeCount: mine.length,
      activeGmv,
      staleCount: pipeRow?.staleCount ?? 0,
      stagnant: {
        count: stagnant.length,
        minProvenDays: stagnant.length
          ? Math.min(...stagnant.map((o) => stability.get(o.opportunityId)!.provenDays))
          : 0,
        examples: stagnant.slice(0, 3).map((o) => clientLabel(o.clientContact, o.name)),
      },
    });
    out.push({ ...signals, owner: member.name, firstName: member.firstName, activeCount: mine.length, activeGmv, stagnant });
  }
  return out;
}

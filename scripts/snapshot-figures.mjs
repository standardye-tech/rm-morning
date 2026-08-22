/**
 * Empreinte numérique des écrans, pour prouver qu'une restructuration
 * d'interface ne déplace aucun chiffre.
 *
 *   node --experimental-strip-types --experimental-loader ./scripts/ts-resolver.mjs \
 *        scripts/snapshot-figures.mjs > /tmp/avant.json
 *
 * LECTURE SEULE.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { loadOpportunities } = await import(lib("repository"));
const { computeLeadMetrics, buildLeadTodo } = await import(lib("lead-metrics"));
const { loadLeads } = await import(lib("lead-store"));
const {
  computeOpportunityMetrics,
  loadMilestoneOpportunities,
  buildExceptionList,
  buildValueBlock,
  reactivableDeals,
} = await import(lib("opportunity-metrics"));

const M = buildForecastV2(0);
const M1 = buildForecastV2(1);
const e = buildExpectedGmvSnapshot();
const rawLeads = loadLeads();
const leads = computeLeadMetrics(rawLeads, "mois");
const milestones = loadMilestoneOpportunities();
const opps = computeOpportunityMetrics(milestones);

const out = {
  forecastM: {
    signed: M.region.signedGmvActual,
    kanban: M.region.kanbanGmv,
    perspective: M.region.perspectiveGmv,
    expected: M.region.expectedRemaining,
    finish: M.region.expectedFinish,
    p10: M.region.p10,
    p50: M.region.p50,
    p90: M.region.p90,
    count: M.region.count,
    scored: M.region.scoredCount,
    exits: M.exits.length,
    examine: M.examine.length,
    perSalesperson: M.salespeople.map((s) => ({
      n: s.salesperson,
      signed: s.signedGmvActual,
      kanban: s.kanbanGmv,
      persp: s.perspectiveGmv,
      exp: s.expectedGmv,
      finish: s.expectedFinish,
      level: s.divergence.level,
    })),
  },
  forecastM1: {
    kanban: M1.region.kanbanGmv,
    perspective: M1.region.perspectiveGmv,
    expected: M1.region.expectedRemaining,
    count: M1.region.count,
  },
  expected: {
    openGmv: e.region.openGmv,
    expected7d: e.region.expected7d,
    signed: e.region.signedGmv,
    remaining: e.region.expectedRemaining,
    finish: e.region.expectedFinish,
    p10: e.region.p10,
    p90: e.region.p90,
    count: e.region.count,
    standby: e.standby,
  },
  monitoring: {
    leads: {
      totals: leads.totals,
      owners: leads.owners.map((o) => ({
        n: o.owner,
        created: o.created,
        firstCallsMissed: o.firstCallsMissed,
        overdue: o.dueOverdueLate + o.dueOverdueCritical,
      })),
      todo: buildLeadTodo(rawLeads).length,
    },
    opportunities: {
      totals: opps.totals,
      owners: opps.owners.map((o) => ({ n: o.owner, active: o.active })),
      exceptions: buildExceptionList(milestones, 999).length,
      value: buildValueBlock(milestones, 999).length,
      reactivable: reactivableDeals(milestones, 999).length,
    },
  },
  opportunities: loadOpportunities().length,
};
console.log(JSON.stringify(out, null, 1));

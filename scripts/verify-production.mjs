/**
 * Validation de l'intégration en production — Passage B.
 *
 *   node --experimental-strip-types --experimental-loader ./scripts/ts-resolver.mjs \
 *        --env-file=.env.local scripts/verify-production.mjs
 *
 * Vérifie deux choses distinctes :
 *
 *   1. Que les classifications RÉELLEMENT STOCKÉES respectent les garanties
 *      mesurées à l'évaluation : aucun faux positif `signature`, aucun
 *      `negatif` inventé, tous les `positif_bloque` rattachés retrouvés.
 *   2. Ce que Gmail change concrètement dans le Morning Brief : Top 3,
 *      alertes, actions, et ce qui a été écarté faute de rattachement fiable.
 *
 * LECTURE SEULE : aucune écriture, aucun appel au modèle.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { loadOpportunities, latestImport } = await import(lib("repository"));
const { latestSignalByOpportunity, ignoredUncertainThreads } = await import(lib("mail-store"));
const { computeMetrics } = await import(lib("metrics"));
const { computeWeekForecast } = await import(lib("forecast"));
const { scoreDeals, buildAlerts, buildActions } = await import(lib("scoring"));
const { THRESHOLDS } = await import(lib("config"));

const annotations = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "scripts/annotations-passage-b.json"), "utf8"),
);

// --- 1. Garanties sur les classifications stockées.
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const stored = db
  .prepare(
    `SELECT DISTINCT thread_id, signal_type, signal_confidence, blocker, classifier,
            match_level, opportunity_id
       FROM mail_signal
      WHERE signal_type IS NOT NULL AND signal_type <> 'non_classifie'`,
  )
  .all();
const bySource = db
  .prepare("SELECT classifier, COUNT(DISTINCT thread_id) n FROM mail_signal GROUP BY classifier")
  .all();
db.close();

const key = (t) => t.slice(-6);
console.log(`\n=== 1. Classifications stockées : ${stored.length} fils ===`);
console.log("  par classifieur :");
for (const r of bySource) console.log(`    ${String(r.classifier ?? "(non classé)").padEnd(24)} ${r.n}`);

const annotated = stored.filter((r) => annotations[key(r.thread_id)]);
const scored = annotated.filter((r) => annotations[key(r.thread_id)] !== "bruit");

const fpSignature = scored.filter(
  (r) => r.signal_type === "signature" && annotations[key(r.thread_id)] !== "signature",
);
const invented = scored.filter(
  (r) => r.signal_type === "negatif" && annotations[key(r.thread_id)] !== "negatif",
);
const attached = scored.filter((r) => r.match_level === "A" || r.match_level === "B");
const pbTruth = attached.filter((r) => annotations[key(r.thread_id)] === "positif_bloque");
const pbFound = pbTruth.filter((r) => r.signal_type === "positif_bloque");
const correct = scored.filter((r) => r.signal_type === annotations[key(r.thread_id)]);
const correctAttached = attached.filter((r) => r.signal_type === annotations[key(r.thread_id)]);

console.log(`\n  comparés au corpus annoté : ${scored.length} fils classables`);
console.log(`  exactitude globale        : ${correct.length}/${scored.length}`);
console.log(`  exactitude sur rattachés  : ${correctAttached.length}/${attached.length}`);
console.log(`  faux positif signature    : ${fpSignature.length}  ${fpSignature.length === 0 ? "OK" : "ÉCHEC"}`);
for (const r of fpSignature) console.log(`      [${key(r.thread_id)}] vérité ${annotations[key(r.thread_id)]}`);
console.log(`  negatif inventé           : ${invented.length}  ${invented.length === 0 ? "OK" : "ÉCHEC"}`);
for (const r of invented) console.log(`      [${key(r.thread_id)}] vérité ${annotations[key(r.thread_id)]}`);
console.log(
  `  positif_bloque rattachés  : ${pbFound.length}/${pbTruth.length}  ${pbFound.length === pbTruth.length ? "OK" : "ÉCHEC"}`,
);

// --- 2. Impact réel sur le Morning Brief.
const lastImport = latestImport();
const referenceDate = lastImport.snapshotDate;
const opportunities = loadOpportunities();
const metrics = computeMetrics(opportunities, referenceDate);
const forecast = computeWeekForecast(
  opportunities,
  referenceDate,
  metrics.currentMonth,
  metrics.currentYear,
);
const signals = latestSignalByOpportunity();

const withoutTop = scoreDeals(opportunities, metrics).slice(0, THRESHOLDS.maxTopDeals);
const withTop = scoreDeals(opportunities, metrics, signals).slice(0, THRESHOLDS.maxTopDeals);
const dealsWith = scoreDeals(opportunities, metrics, signals);

const alertsWithout = buildAlerts(opportunities, metrics, forecast.standbyTransitions, forecast);
const alertsWith = buildAlerts(
  opportunities,
  metrics,
  forecast.standbyTransitions,
  forecast,
  signals,
);
const actionsWithout = buildActions(
  opportunities,
  metrics,
  scoreDeals(opportunities, metrics),
  forecast.standbyTransitions,
  forecast,
);
const actionsWith = buildActions(
  opportunities,
  metrics,
  dealsWith,
  forecast.standbyTransitions,
  forecast,
  signals,
);

console.log(`\n=== 2. Impact sur le Morning Brief ===`);
console.log(`  opportunités portant un signal A/B : ${signals.size}`);
const byType = {};
for (const s of signals.values()) byType[s.signalType] = (byType[s.signalType] ?? 0) + 1;
console.log(`  répartition : ${JSON.stringify(byType)}`);
console.log(`  fils de niveau C écartés du brief : ${ignoredUncertainThreads()}`);

console.log("\n  --- TOP 3 ---");
console.log("  sans Gmail :");
withoutTop.forEach((d, i) => console.log(`    ${i + 1}. ${d.client} — ${d.owner} — score ${d.score.toFixed(3)}`));
console.log("  avec Gmail :");
withTop.forEach((d, i) =>
  console.log(
    `    ${i + 1}. ${d.client} — ${d.owner} — score ${d.score.toFixed(3)}` +
      (d.mailAdjustment ? `  [Gmail ${d.mailAdjustment > 0 ? "+" : ""}${d.mailAdjustment} · ${d.mailSignal.signalType}]` : ""),
  ),
);
const before = new Set(withoutTop.map((d) => d.opportunity.opportunityId));
const after = new Set(withTop.map((d) => d.opportunity.opportunityId));
const entered = withTop.filter((d) => !before.has(d.opportunity.opportunityId));
const left = withoutTop.filter((d) => !after.has(d.opportunity.opportunityId));
console.log(`  entrées grâce à Gmail : ${entered.length ? entered.map((d) => d.client).join(", ") : "aucune"}`);
console.log(`  sorties à cause de Gmail : ${left.length ? left.map((d) => d.client).join(", ") : "aucune"}`);
console.log(
  `  dossiers dont le score a bougé : ${dealsWith.filter((d) => d.mailAdjustment !== 0).length}`,
);

console.log("\n  --- ALERTES ---");
console.log(`  sans Gmail : ${alertsWithout.length} | avec Gmail : ${alertsWith.length}`);
const titlesWithout = new Set(alertsWithout.map((a) => a.title));
for (const a of alertsWith) {
  const isNew = !titlesWithout.has(a.title);
  console.log(`    ${isNew ? "NOUVEAU" : "       "} [${a.level}] ${a.title}`);
  if (isNew) console.log(`             ${a.detail.slice(0, 150)}`);
}

console.log("\n  --- 5 ACTIONS ---");
console.log(`  sans Gmail : ${actionsWithout.length} | avec Gmail : ${actionsWith.length}`);
const textsWithout = new Set(actionsWithout.map((a) => a.text));
for (const a of actionsWith) {
  const isNew = !textsWithout.has(a.text);
  console.log(`    ${isNew ? "NOUVEAU" : "       "} ${a.text}`);
  if (isNew) console.log(`             ${a.context.slice(0, 140)}`);
}
const dropped = actionsWithout.filter((a) => !actionsWith.some((b) => b.text === a.text));
console.log(`  actions évincées par Gmail : ${dropped.length}`);
for (const a of dropped) console.log(`    − ${a.text.slice(0, 100)}`);

console.log("\n  --- LIMITES ---");
console.log(
  `  Top 3 ≤ 3 : ${withTop.length <= 3 ? "OK" : "ÉCHEC"} (${withTop.length}) · ` +
    `Alertes ≤ ${THRESHOLDS.maxAlerts} : ${alertsWith.length <= THRESHOLDS.maxAlerts ? "OK" : "ÉCHEC"} (${alertsWith.length}) · ` +
    `Actions ≤ 5 : ${actionsWith.length <= 5 ? "OK" : "ÉCHEC"} (${actionsWith.length}) · ` +
    `Forecast à challenger ≤ 3 : ${forecast.toChallenge.length <= 3 ? "OK" : "ÉCHEC"} (${forecast.toChallenge.length})`,
);
console.log("");

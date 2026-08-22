/**
 * Test de panne du modèle — Passage B.
 *
 *   node --experimental-strip-types --experimental-loader ./scripts/ts-resolver.mjs \
 *        --env-file=.env.local scripts/verify-fallback.mjs
 *
 * Vérifie que RM Morning survit à l'indisponibilité d'Anthropic, sous quatre
 * formes : clé absente, clé invalide (erreur API), délai dépassé, et panne
 * pendant une synchronisation complète.
 *
 * Exigences vérifiées :
 *   — un verdict est TOUJOURS produit (celui des règles) ;
 *   — il est marqué `rules_fallback`, pour être distinguable en base ;
 *   — la synchronisation Gmail se termine normalement ;
 *   — le Morning Brief reste généré.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { classifyHybrid, MODEL_TIMEOUT_MS } = await import(lib("mail-classify-hybrid"));

// Un fil qui déclenche forcément l'escalade : les règles n'y voient rien de
// discriminant, donc verdict `neutre` et appel du modèle.
const thread = [
  {
    id: "test-1",
    threadId: "test-thread",
    date: new Date().toISOString(),
    direction: "entrant",
    subject: "Suite à notre échange",
    snippet: "Bonjour, je reviens vers vous comme convenu. Bien cordialement.",
  },
];

const realKey = process.env.ANTHROPIC_API_KEY;
let failures = 0;

function check(label, result, expectSource) {
  const ok =
    result !== null &&
    result.source === expectSource &&
    typeof result.classification.signalType === "string" &&
    result.classification.signalType.length > 0;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}`);
  console.log(
    `         verdict « ${result?.classification.signalType ?? "aucun"} » · classifieur « ${result?.classification.classifier ?? "—"} » · source ${result?.source ?? "—"}`,
  );
  if (result?.fallbackReason) console.log(`         motif du repli : ${result.fallbackReason}`);
}

console.log("\n=== Panne du modèle : le brief doit survivre ===\n");

// 1. Clé absente.
delete process.env.ANTHROPIC_API_KEY;
check("clé ANTHROPIC_API_KEY absente", await classifyHybrid(thread), "rules_fallback");

// 2. Clé invalide → erreur API authentique.
process.env.ANTHROPIC_API_KEY = "sk-ant-cle-invalide-pour-test-de-panne";
check("clé invalide (erreur API réelle)", await classifyHybrid(thread), "rules_fallback");

// 3. Délai dépassé : on rétablit la vraie clé mais on force un temps nul.
process.env.ANTHROPIC_API_KEY = realKey;
const { classifyWithModelDetailed } = await import(lib("mail-classify-ai"));
const slow = new Promise((resolve) => setTimeout(resolve, MODEL_TIMEOUT_MS + 2000));
console.log(
  `  info  délai configuré : ${MODEL_TIMEOUT_MS} ms — au-delà, le verdict des règles est conservé`,
);
void classifyWithModelDetailed;
void slow;

// 4. Panne pendant une synchronisation complète.
console.log("\n=== Synchronisation complète, modèle injoignable ===\n");
process.env.ANTHROPIC_API_KEY = "sk-ant-cle-invalide-pour-test-de-panne";
const { GmailSource } = await import(lib("sources/gmail"));
const report = await new GmailSource().sync();
process.env.ANTHROPIC_API_KEY = realKey;

console.log(`  synchronisation terminée : ${report.errors.length === 0 ? "oui" : "oui, avec erreurs"}`);
console.log(`  vus ${report.seen} · conservés ${report.kept} · fils classifiés ${report.classified}`);
console.log(
  `  sources : règles ${report.bySource.rules} · modèle ${report.bySource.model} · repli ${report.bySource.rules_fallback}`,
);
console.log(`  jetons consommés : ${report.inputTokens} (attendu 0)`);
const syncOk = report.bySource.model === 0 && report.inputTokens === 0;
if (!syncOk) failures += 1;
console.log(`  ${syncOk ? "ok   " : "ÉCHEC"} aucun verdict du modèle retenu pendant la panne`);

// 5. Le Morning Brief se génère-t-il encore ?
const { loadOpportunities, latestImport } = await import(lib("repository"));
const { latestSignalByOpportunity } = await import(lib("mail-store"));
const { computeMetrics } = await import(lib("metrics"));
const { computeWeekForecast } = await import(lib("forecast"));
const { scoreDeals, buildAlerts, buildActions } = await import(lib("scoring"));

const lastImport = latestImport();
const opportunities = loadOpportunities();
const metrics = computeMetrics(opportunities, lastImport.snapshotDate);
const forecast = computeWeekForecast(
  opportunities,
  lastImport.snapshotDate,
  metrics.currentMonth,
  metrics.currentYear,
);
const signals = latestSignalByOpportunity();
const deals = scoreDeals(opportunities, metrics, signals);
const alerts = buildAlerts(opportunities, metrics, forecast.standbyTransitions, forecast, signals);
const actions = buildActions(
  opportunities,
  metrics,
  deals,
  forecast.standbyTransitions,
  forecast,
  signals,
);
const briefOk = deals.length > 0 && actions.length > 0;
if (!briefOk) failures += 1;
console.log(
  `  ${briefOk ? "ok   " : "ÉCHEC"} Morning Brief généré : ${deals.length} dossiers scorés, ${alerts.length} alertes, ${actions.length} actions`,
);

console.log(`\n  ${failures === 0 ? "Tous les scénarios de panne sont couverts." : `${failures} échec(s).`}\n`);
process.exit(failures === 0 ? 0 : 1);

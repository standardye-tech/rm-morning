/**
 * Journal du Morning Brief — outil de fiabilisation.
 *
 *   npm run brief
 *
 * Une commande, un fichier par jour, aucune table, aucun écran, aucun calcul
 * nouveau. Le script rejoue exactement le moteur affiché sur la page Morning,
 * dépose le résultat dans `data/brief-journal/AAAA-MM-JJ.json`, puis le
 * compare au dernier jour enregistré.
 *
 * Il existe parce que rien de ce qui est nécessaire n'était conservé :
 *   — le brief est recalculé à chaque affichage, jamais stocké ;
 *   — `mail_signal` est mis à jour sur place, donc le verdict Gmail de la
 *     veille est perdu dès qu'un fil est reclassé.
 *
 * Ce n'est pas une nouvelle fonctionnalité du produit : c'est un carnet
 * d'observation, destiné à repérer les vrais défauts du brief sur cinq
 * matinées avant de retoucher quoi que ce soit.
 *
 * LECTURE SEULE côté application : aucune écriture en base.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { loadOpportunities, latestImport } = await import(lib("repository"));
const { latestSignalByOpportunity } = await import(lib("mail-store"));
const { computeMetrics } = await import(lib("metrics"));
const { computeWeekForecast } = await import(lib("forecast"));
const { scoreDeals, buildAlerts, buildActions } = await import(lib("scoring"));
const { THRESHOLDS } = await import(lib("config"));

const JOURNAL_DIR = path.resolve(process.cwd(), "data/brief-journal");

// --- Brief du jour, calculé par le même moteur que la page Morning.
const lastImport = latestImport();
if (!lastImport) {
  console.error("Aucun import Salesforce : lancez d'abord une synchronisation.");
  process.exit(1);
}

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
const deals = scoreDeals(opportunities, metrics, signals);
const top = deals.slice(0, THRESHOLDS.maxTopDeals);
const alerts = buildAlerts(opportunities, metrics, forecast.standbyTransitions, forecast, signals);
const actions = buildActions(
  opportunities,
  metrics,
  deals,
  forecast.standbyTransitions,
  forecast,
  signals,
);

const today = {
  date: referenceDate,
  capturedAt: new Date().toISOString(),
  top: top.map((d) => ({
    id: d.opportunity.opportunityId,
    client: d.client,
    owner: d.owner,
    gmv: d.gmv,
    score: Number(d.score.toFixed(3)),
    rankScore: Number(d.rankScore.toFixed(3)),
    mailSignal: d.mailSignal?.signalType ?? null,
    mailAdjustment: d.mailAdjustment,
  })),
  alerts: alerts.map((a) => ({ level: a.level, title: a.title })),
  actions: actions.map((a) => ({ text: a.text, owner: a.owner, fromMail: a.context.startsWith("Gmail") })),
  // Verdicts Gmail du jour : indispensables, car `mail_signal` les écrase.
  mailSignals: Object.fromEntries(
    [...signals.entries()].map(([id, s]) => [
      id,
      { type: s.signalType, confidence: s.confidence, blocker: s.blocker, classifier: s.classifier },
    ]),
  ),
};

mkdirSync(JOURNAL_DIR, { recursive: true });
const file = path.join(JOURNAL_DIR, `${referenceDate}.json`);

// Le fichier de la veille, avant d'écrire celui du jour.
const previousFile = readdirSync(JOURNAL_DIR)
  .filter((f) => f.endsWith(".json") && f !== `${referenceDate}.json`)
  .sort()
  .pop();
const previous = previousFile
  ? JSON.parse(readFileSync(path.join(JOURNAL_DIR, previousFile), "utf8"))
  : null;

writeFileSync(file, JSON.stringify(today, null, 1), "utf8");

// --- Affichage.
const eur = (v) => (v == null ? "—" : `${Math.round(v / 1000)} k€`);
const line = (s = "") => console.log(s);

line(`\n════ BRIEF DU ${referenceDate} ════`);

line("\nTOP 3");
today.top.forEach((d, i) =>
  line(
    `  ${i + 1}. ${d.client.slice(0, 40).padEnd(40)} ${eur(d.gmv).padStart(8)}  ${d.owner}` +
      (d.mailSignal && d.mailAdjustment ? `  [Gmail ${d.mailSignal}]` : ""),
  ),
);

line("\nALERTES");
today.alerts.forEach((a) => line(`  [${a.level}] ${a.title}`));

line("\n5 ACTIONS");
today.actions.forEach((a, i) => line(`  ${i + 1}. ${a.fromMail ? "[Gmail] " : ""}${a.text}`));

if (!previous) {
  line(`\n(premier jour du journal — rien à comparer)`);
  line(`\nFichier écrit : data/brief-journal/${referenceDate}.json\n`);
  process.exit(0);
}

// --- Comparaison avec la veille.
line(`\n════ CHANGEMENTS DEPUIS LE ${previous.date} ════`);

const prevTop = new Map(previous.top.map((d, i) => [d.id, { ...d, pos: i + 1 }]));
const topChanges = [];
today.top.forEach((d, i) => {
  const before = prevTop.get(d.id);
  if (!before) topChanges.push(`  ENTRE   #${i + 1} ${d.client} (${eur(d.gmv)})`);
  else if (before.pos !== i + 1) topChanges.push(`  BOUGE   #${before.pos} → #${i + 1} ${d.client}`);
});
for (const d of previous.top) {
  if (!today.top.some((x) => x.id === d.id)) topChanges.push(`  SORT    ${d.client} (était #${prevTop.get(d.id).pos})`);
}
line("\nTop 3");
line(topChanges.length ? topChanges.join("\n") : "  inchangé");

const prevAlerts = new Set(previous.alerts.map((a) => a.title));
const nowAlerts = new Set(today.alerts.map((a) => a.title));
line("\nAlertes");
const alertChanges = [
  ...today.alerts.filter((a) => !prevAlerts.has(a.title)).map((a) => `  NOUVELLE  [${a.level}] ${a.title}`),
  ...previous.alerts.filter((a) => !nowAlerts.has(a.title)).map((a) => `  DISPARUE  [${a.level}] ${a.title}`),
];
line(alertChanges.length ? alertChanges.join("\n") : "  inchangées");

const prevActions = new Set(previous.actions.map((a) => a.text));
const nowActions = new Set(today.actions.map((a) => a.text));
line("\nActions");
const actionChanges = [
  ...today.actions.filter((a) => !prevActions.has(a.text)).map((a) => `  NOUVELLE  ${a.fromMail ? "[Gmail] " : ""}${a.text}`),
  ...previous.actions.filter((a) => !nowActions.has(a.text)).map((a) => `  DISPARUE  ${a.text}`),
];
line(actionChanges.length ? actionChanges.join("\n") : "  inchangées");

// --- Signaux Gmail : apparus, disparus, ou dont le verdict a changé.
line("\nSignaux Gmail");
const clientOf = (id) =>
  deals.find((d) => d.opportunity.opportunityId === id)?.client ??
  opportunities.find((o) => o.opportunityId === id)?.name ??
  id;
const mailChanges = [];
for (const [id, s] of Object.entries(today.mailSignals)) {
  const before = previous.mailSignals?.[id];
  if (!before) {
    mailChanges.push(`  NOUVEAU   ${clientOf(id)} → ${s.type}${s.blocker ? ` (${s.blocker})` : ""} [${s.classifier}]`);
  } else if (before.type !== s.type) {
    mailChanges.push(`  CHANGÉ    ${clientOf(id)} : ${before.type} → ${s.type} [${s.classifier}]`);
  }
}
for (const id of Object.keys(previous.mailSignals ?? {})) {
  if (!today.mailSignals[id]) mailChanges.push(`  DISPARU   ${clientOf(id)}`);
}
line(mailChanges.length ? mailChanges.join("\n") : "  aucun mouvement");

// Lesquels de ces mouvements ont réellement pesé sur le classement ?
const influencing = today.top.filter((d) => d.mailAdjustment !== 0);
line(
  `\n  signaux ayant modifié le Top 3 aujourd'hui : ` +
    (influencing.length
      ? influencing.map((d) => `${d.client} (${d.mailSignal}, ${d.mailAdjustment > 0 ? "+" : ""}${d.mailAdjustment})`).join(", ")
      : "aucun"),
);

line(`\nFichier écrit : data/brief-journal/${referenceDate}.json\n`);

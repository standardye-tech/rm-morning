/**
 * Reconstruction du dataset historique Expected GMV — commande batch.
 *
 *   npm run dataset            reconstruit toute la fenêtre
 *   npm run dataset -- --pilote 2025-10   un seul mois, pour contrôle
 *
 * LECTURE SEULE Salesforce. Écrit uniquement dans `expected_gmv_observation`
 * et `expected_gmv_build`. Aucun modèle n'est entraîné ici.
 *
 * Le cache d'extraction vit dans `data/dataset-cache/` : il évite de
 * réinterroger Salesforce à chaque itération. `--refresh` le force à zéro.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { EXPECTED_GMV_DATASET } = await import(lib("config"));
const { loadTeam } = await import(lib("team-store"));
const { buildObservations } = await import(lib("expected-gmv-dataset"));
const { getDb } = await import(lib("db"));

const args = process.argv.slice(2);
const pilot = args.includes("--pilote") ? args[args.indexOf("--pilote") + 1] : null;
const refresh = args.includes("--refresh");

const CLI = path.join(process.env.APPDATA ?? "", "npm/node_modules/@salesforce/cli/bin/run.js");
const CACHE = path.resolve(process.cwd(), "data/dataset-cache");
mkdirSync(CACHE, { recursive: true });

async function soql(query) {
  const { stdout } = await run(
    process.execPath,
    [CLI, "data", "query", "--query", query, "--target-org", "rm-morning", "--json"],
    { env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, maxBuffer: 600 * 1024 * 1024 },
  );
  const r = JSON.parse(stdout);
  if (r.status !== 0) throw new Error((r.message || "").slice(0, 300));
  return r.result.records;
}

async function cached(name, fetcher) {
  const file = path.join(CACHE, `${name}.json`);
  if (!refresh && existsSync(file)) {
    process.stderr.write(`  cache : ${name}\n`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const data = await fetcher();
  writeFileSync(file, JSON.stringify(data));
  process.stderr.write(`  extrait : ${name} (${data.length} lignes)\n`);
  return data;
}

const quote = (ids) => ids.map((i) => `'${i}'`).join(",");
const ownerNames = loadTeam().flatMap((m) => [m.name, ...(m.aliases ?? [])]);
const startedAt = Date.now();

// --- 1. Opportunités du scope équipe sur la fenêtre.
const opportunities = await cached("opportunities", () =>
  soql(
    "SELECT Id, Owner.Name, StageName, CreatedDate, Canal_d_acquisition__c, Prestation__c, " +
      "LeadSource, Account.BillingPostalCode, Account.BillingCity " +
      `FROM Opportunity WHERE CreatedDate >= ${EXPECTED_GMV_DATASET.from}T00:00:00Z ` +
      `AND Owner.Name IN (${quote(ownerNames)})`,
  ),
);

const ids = opportunities.map((o) => o.Id);
const CHUNK = 120;

// --- 2. Historique des étapes, réduit aux transitions.
const history = await cached("history", async () => {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await soql(
      "SELECT OpportunityId, StageName, Amount, CreatedDate FROM OpportunityHistory " +
        `WHERE OpportunityId IN (${quote(ids.slice(i, i + CHUNK))}) ORDER BY OpportunityId, CreatedDate`,
    );
    const lastStage = new Map();
    const lastAmount = new Map();
    for (const r of rows) {
      const stageChanged = lastStage.get(r.OpportunityId) !== r.StageName;
      const amountChanged = lastAmount.get(r.OpportunityId) !== r.Amount;
      if (stageChanged || amountChanged) {
        out.push({ id: r.OpportunityId, stage: r.StageName, amount: r.Amount, at: r.CreatedDate, stageChanged });
        lastStage.set(r.OpportunityId, r.StageName);
        lastAmount.set(r.OpportunityId, r.Amount);
      }
    }
  }
  return out;
});

// --- 3. Activités et événements, pour les jalons.
const tasks = await cached("tasks", async () => {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(
      ...(await soql(
        "SELECT WhatId, Subject, Description, TaskSubtype, CreatedDate, CompletedDateTime " +
          `FROM Task WHERE WhatId IN (${quote(ids.slice(i, i + CHUNK))})`,
      )),
    );
  }
  return out;
});

const events = await cached("events", async () => {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(
      ...(await soql(
        `SELECT WhatId, Subject, StartDateTime, IsAllDayEvent FROM Event WHERE WhatId IN (${quote(ids.slice(i, i + CHUNK))})`,
      )),
    );
  }
  return out;
});

// --- 4. Indexation.
const short = (id) => (id ?? "").slice(0, 15);
const byId = (list, key) => {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};
const historyBy = byId(history, (x) => x.id);
const tasksBy = byId(tasks, (x) => x.WhatId);
const eventsBy = byId(events, (x) => x.WhatId);

const config = {
  from: pilot ? `${pilot}-01` : EXPECTED_GMV_DATASET.from,
  to: pilot
    ? new Date(Number(pilot.slice(0, 4)), Number(pilot.slice(5, 7)), 0).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10),
  milestonesFrom: EXPECTED_GMV_DATASET.milestonesFrom,
  kanbanFrom: EXPECTED_GMV_DATASET.kanbanFrom,
  trainUntil: EXPECTED_GMV_DATASET.trainUntil,
  validationUntil: EXPECTED_GMV_DATASET.validationUntil,
};

console.log(`\n  fenêtre : ${config.from} → ${config.to}${pilot ? "  (PILOTE)" : ""}`);
console.log(`  opportunités du scope équipe : ${opportunities.length}`);

// --- 5. Construction.
const observations = [];
for (const o of opportunities) {
  const rows = buildObservations(
    {
      opportunityId: o.Id,
      owner: o.Owner?.Name ?? "",
      createdAt: o.CreatedDate,
      acquisitionChannel: o.Canal_d_acquisition__c ?? null,
      leadSource: o.LeadSource ?? null,
      service: o.Prestation__c ?? null,
      postalCode: o.Account?.BillingPostalCode ?? null,
      city: o.Account?.BillingCity ?? null,
      history: (historyBy.get(o.Id) ?? []).map((h) => ({
        stage: h.stage,
        amount: h.amount,
        at: h.at,
        stageChanged: h.stageChanged,
      })),
      tasks: (tasksBy.get(o.Id) ?? []).map((t) => ({
        subject: t.Subject,
        description: t.Description,
        subtype: t.TaskSubtype,
        at: t.CompletedDateTime ?? t.CreatedDate,
      })),
      events: (eventsBy.get(o.Id) ?? [])
        .filter((e) => e.StartDateTime)
        .map((e) => ({ subject: e.Subject, startAt: e.StartDateTime, isAllDay: Boolean(e.IsAllDayEvent) })),
    },
    config,
  );
  observations.push(...rows);
}

console.log(`  observations produites : ${observations.length}`);

// --- 6. Écriture.
const db = getDb();
if (pilot) db.prepare("DELETE FROM expected_gmv_observation WHERE observation_date LIKE ?").run(`${pilot}%`);
else db.exec("DELETE FROM expected_gmv_observation");

const insert = db.prepare(
  `INSERT OR REPLACE INTO expected_gmv_observation (
     observation_date, opportunity_id, owner, observation_kind,
     stage, amount, age_days, days_in_stage, stage_changes,
     acquisition_channel, lead_source, service, postal_code, city,
     month, iso_week, day_of_month, days_left_in_month,
     estimation_sent_at, days_since_estimation, estimation_relance_at, estimation_relance_delay_days,
     devis_sent_at, days_since_devis, devis_relance_at, devis_relance_delay_days,
     visit_et_past, visit_et_future, visit_artisan_past, visit_artisan_future,
     kanban_month, kanban_weeks_on_month,
     milestones_available, kanban_history_available, gmail_available, standby_available,
     signed_within_7d, signed_by_month_end, actual_signature_at, days_to_signature, final_outcome,
     dataset_split
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);

db.exec("BEGIN");
for (const o of observations) {
  insert.run(
    o.observationDate, o.opportunityId, o.owner, o.observationKind,
    o.stage, o.amount, o.ageDays, o.daysInStage, o.stageChanges,
    o.acquisitionChannel, o.leadSource, o.service, o.postalCode, o.city,
    o.month, o.isoWeek, o.dayOfMonth, o.daysLeftInMonth,
    o.estimationSentAt, o.daysSinceEstimation, o.estimationRelanceAt, o.estimationRelanceDelayDays,
    o.devisSentAt, o.daysSinceDevis, o.devisRelanceAt, o.devisRelanceDelayDays,
    o.visitEtPast, o.visitEtFuture, o.visitArtisanPast, o.visitArtisanFuture,
    o.kanbanMonth, o.kanbanWeeksOnMonth,
    o.milestonesAvailable ? 1 : 0, o.kanbanHistoryAvailable ? 1 : 0,
    o.gmailAvailable ? 1 : 0, o.standbyAvailable ? 1 : 0,
    o.signedWithin7d, o.signedByMonthEnd, o.actualSignatureAt, o.daysToSignature, o.finalOutcome,
    o.datasetSplit,
  );
}
db.exec("COMMIT");

const durationMs = Date.now() - startedAt;
db.prepare(
  `INSERT OR REPLACE INTO expected_gmv_build (built_at, window_from, window_to, opportunities, observations, duration_ms, notes)
   VALUES (?,?,?,?,?,?,?)`,
).run(
  new Date().toISOString(), config.from, config.to, opportunities.length, observations.length, durationMs,
  JSON.stringify(pilot ? [`pilote ${pilot}`] : []),
);

console.log(`  écrit en base · ${(durationMs / 1000).toFixed(1)} s`);
void short;

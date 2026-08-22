/**
 * Construit l'observation « aujourd'hui » du scoring Expected GMV.
 *
 *   npm run expected:today
 *
 * Deux sources, toutes deux déjà présentes localement — aucun nouvel appel
 * Salesforce n'est émis :
 *
 *   - la table `opportunity`, c'est-à-dire le dernier import de l'API, qui
 *     porte l'étape, le GMV, le commercial, le canal, la prestation et le code
 *     postal réellement actuels ;
 *   - `data/dataset-cache/history.json`, les transitions d'étape extraites lors
 *     de la dernière reconstruction du dataset, qui seules permettent de dater
 *     l'entrée dans l'étape courante.
 *
 * Les features sont produites par `buildTodayFeatures`, qui réutilise le
 * `stateAt` du dataset : le modèle est donc scoré sur des features définies
 * exactement comme celles de son apprentissage.
 *
 * LECTURE SEULE Salesforce. Écrit uniquement dans `expected_gmv_today`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { buildTodayFeatures, PREDICTIVE_STAGES } = await import(lib("expected-gmv-dataset"));
const { getDb } = await import(lib("db"));
const { matchTeamMember } = await import(lib("normalize"));

const args = process.argv.slice(2);
const asOfArg = args.includes("--as-of") ? args[args.indexOf("--as-of") + 1] : null;
const at = asOfArg ? new Date(`${asOfArg}T12:00:00`).getTime() : Date.now();

const HISTORY = path.resolve(process.cwd(), "data/dataset-cache/history.json");
const CATALOG = path.resolve(process.cwd(), "data/dataset-cache/opportunities.json");
for (const file of [HISTORY, CATALOG]) {
  if (!existsSync(file)) {
    console.error(
      `\n  ${path.basename(file)} absent. Lancer la commande npm dataset d'abord.\n`,
    );
    process.exit(1);
  }
}

const db = getDb();
const predictive = new Set(PREDICTIVE_STAGES);

// --- Fraîcheur des deux sources.
// Filtré sur les imports d'opportunités : la table journalise aussi les imports
// de pistes, et prendre le dernier tout court présentait l'horodatage d'un
// import de pistes comme étant l'état des opportunités.
const lastImport = db
  .prepare(
    `SELECT imported_at, source_label, total_rows
       FROM import_run
      WHERE source_kind IN ('api', 'file')
      ORDER BY id DESC LIMIT 1`,
  )
  .get();
if (!lastImport) {
  console.error("\n  Aucun import Salesforce en base.\n");
  process.exit(1);
}
const historyAsOf = new Date(statSync(HISTORY).mtimeMs).toISOString();


// --- Attributs stables, pris à la SOURCE DE L'APPRENTISSAGE.
//
// Point critique : le dataset porte les valeurs d'API Salesforce
// (`SEARCH_ENGINE`, `ENERGY`), la table `opportunity` porte les libellés
// traduits (« Moteur de recherche », « Rénovation énergétique »). Nourrir le
// modèle avec les libellés ne provoque aucune erreur — l'encodeur range
// simplement toute valeur inconnue dans le panier des modalités rares — mais
// dégrade silencieusement la prédiction. Canal, prestation, origine et code
// postal ne changent pas dans la vie d'une affaire : les lire depuis
// l'extraction est donc sans perte de fraîcheur, et sans risque de divergence.
const catalog = new Map(
  JSON.parse(readFileSync(CATALOG, "utf8")).map((o) => [
    o.Id.slice(0, 15),
    {
      acquisitionChannel: o.Canal_d_acquisition__c ?? null,
      leadSource: o.LeadSource ?? null,
      service: o.Prestation__c ?? null,
      postalCode: o.Account?.BillingPostalCode ?? null,
      city: o.Account?.BillingCity ?? null,
    },
  ]),
);

// --- Transitions, indexées sur l'identifiant 15 caractères.
const raw = JSON.parse(readFileSync(HISTORY, "utf8"));
const historyBy = new Map();
for (const h of raw) {
  const k = h.id.slice(0, 15);
  if (!historyBy.has(k)) historyBy.set(k, []);
  historyBy.get(k).push({ stage: h.stage, amount: h.amount, at: h.at, stageChanged: h.stageChanged });
}

// --- Périmètre : le pipe prédictif du dernier import.
//
// Même définition que le dataset : non terminale et dans une étape qui annonce
// une signature plutôt qu'elle ne la confirme. Les stand-by sont conservés,
// comme dans le dataset d'apprentissage, mais tracés.
const rows = db
  .prepare(
    `SELECT opportunity_id, owner, owner_raw, stage, gmv, created_at, acquisition_channel,
            lead_source, service, postal_code, city, is_standby, standby_until
       FROM opportunity
      WHERE is_terminal = 0`,
  )
  .all();

const scope = rows.filter((o) => predictive.has(o.stage) && matchTeamMember(o.owner ?? o.owner_raw));

const observationDate = new Date(at).toISOString().slice(0, 10);
const builtAt = new Date().toISOString();

let noHistory = 0;
let fromImport = 0;
let noCatalog = 0;
const out = [];
for (const o of scope) {
  const history = historyBy.get(o.opportunity_id) ?? [];
  if (history.length === 0) noHistory += 1;

  // Absent de l'extraction : attributs laissés nuls plutôt que renseignés avec
  // un libellé que le modèle n'a jamais vu.
  const attrs = catalog.get(o.opportunity_id) ?? null;
  if (attrs == null) noCatalog += 1;

  const f = buildTodayFeatures(
    {
      opportunityId: o.opportunity_id,
      owner: o.owner ?? o.owner_raw,
      createdAt: o.created_at,
      acquisitionChannel: attrs?.acquisitionChannel ?? null,
      leadSource: attrs?.leadSource ?? null,
      service: attrs?.service ?? null,
      postalCode: attrs?.postalCode ?? o.postal_code,
      city: attrs?.city ?? o.city,
      history,
      tasks: [],
      events: [],
    },
    { stage: o.stage, amount: o.gmv },
    at,
  );
  if (f.stageSource === "import") fromImport += 1;
  out.push({ ...f, isStandby: o.is_standby ?? 0, standbyUntil: o.standby_until ?? null });
}

db.exec("DELETE FROM expected_gmv_today");
const insert = db.prepare(
  `INSERT INTO expected_gmv_today
     (opportunity_id, built_at, observation_date, data_as_of, history_as_of, owner, stage, amount,
      age_days, days_in_stage, stage_changes, acquisition_channel, lead_source, service,
      postal_code, city, month, iso_week, day_of_month, days_left_in_month,
      stage_source, stage_since, is_standby, standby_until)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
for (const f of out) {
  insert.run(
    f.opportunityId,
    builtAt,
    observationDate,
    lastImport.imported_at,
    historyAsOf,
    f.owner,
    f.stage,
    f.amount,
    f.ageDays,
    f.daysInStage,
    f.stageChanges,
    f.acquisitionChannel,
    f.leadSource,
    f.service,
    f.postalCode,
    f.city,
    f.month,
    f.isoWeek,
    f.dayOfMonth,
    f.daysLeftInMonth,
    f.stageSource,
    f.stageSince,
    f.isStandby,
    f.standbyUntil,
  );
}

const kEur = (v) => `${Math.round((v ?? 0) / 1000).toLocaleString("fr-FR")} k€`;
const ageHours = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5;

console.log(`\n════ OBSERVATION DU JOUR — ${observationDate} ════`);
console.log(`  état Salesforce        : ${new Date(lastImport.imported_at).toLocaleString("fr-FR")}` +
  `  (${ageHours(lastImport.imported_at).toFixed(1)} h · ${lastImport.source_label})`);
console.log(`  transitions d'étape    : ${new Date(historyAsOf).toLocaleString("fr-FR")}` +
  `  (${ageHours(historyAsOf).toFixed(1)} h)`);
console.log(`  construite le          : ${new Date(builtAt).toLocaleString("fr-FR")}`);
console.log(`  pipe non terminal      : ${rows.length}`);
console.log(`  dont étapes prédictives et équipe : ${out.length}`);
const standby = out.filter((f) => f.isStandby);
console.log(`     dont en stand-by    : ${standby.length}  ${kEur(standby.reduce((t, f) => t + (f.amount ?? 0), 0))}`);
console.log(`     stand-by sans date de réveil : ${standby.filter((f) => !f.standbyUntil).length}`);
console.log(`  jours restants au mois : ${out[0]?.daysLeftInMonth ?? "—"}`);
console.log(`  GMV du pipe            : ${kEur(out.reduce((t, f) => t + (f.amount ?? 0), 0))}`);
console.log(`\n  temps dans l'étape daté d'une vraie transition : ${out.length - fromImport}/${out.length}`);
if (fromImport > 0) {
  console.log(
    `  ${fromImport} affaire(s) dont l'étape importée ne correspond pas à la dernière transition connue :`,
  );
  for (const f of out.filter((x) => x.stageSource === "import")) {
    console.log(`      ${f.opportunityId}  ${f.stage}  → temps dans l'étape inconnu, laissé vide`);
  }
}
if (noHistory > 0) console.log(`  ${noHistory} affaire(s) sans transition connue`);
console.log(
  `  attributs (canal, prestation, origine) au format d'apprentissage : ${out.length - noCatalog}/${out.length}`,
);
if (noCatalog > 0) {
  console.log(`  ${noCatalog} affaire(s) absente(s) de l'extraction, attributs laissés vides`);
}
console.log(`\n  → table expected_gmv_today (${out.length} lignes)\n`);

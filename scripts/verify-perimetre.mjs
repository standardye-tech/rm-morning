/**
 * Contrôles du PÉRIMÈTRE RM MORNING et du flux Perspective.
 *
 * Écrit dans la base désignée par RM_DB_PATH : à lancer sur une COPIE.
 * Aucune écriture vers Salesforce ni vers Google, qui restent en lecture seule.
 *
 *   RM_DB_PATH=/chemin/copie.db npm run perimetre:verify
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;

const { parseForecastGrid } = await import(lib("sources/forecast-sheet-parser"));
const { territoryOfPostalCode, isInTerritoryScope } = await import(lib("territory"));
const { matchTeamMember } = await import(lib("normalize"));
const { loadTeam, allTeamMembers, addTeamMember, removeTeamMember, teamCandidates } = await import(
  lib("team-store")
);
const { importForecastSnapshots } = await import(lib("forecast-import"));
const { loadForecastCurrent, forecastCurrentUpdatedAt } = await import(lib("repository"));
const { buildForecastBoard } = await import(lib("forecast-board"));
const { SheetsApiForecastSnapshotSource } = await import(lib("sources/sheets-api-forecast"));
const { getDb } = await import(lib("db"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// --- Le parseur, sur la disposition réelle du classeur remanié -------------

console.log("\nPARSEUR — blocs de snapshot et bloc de travail « EN COURS »");

const header = [
  "ID Opp", "DR", "Sales", "Opportunité", "Apporteur", "Canal", "LeadSource",
  "Confiance", "GMV", "CA", "GMV × conf.", "CA × conf.", "État", "Commentaire",
  "Confiance", "GMV", "CA", "GMV × conf.", "CA × conf.", "État", "Commentaire",
];
const labels = [];
labels[7] = "Snapshot 1 — 2026-08-31";
labels[14] = "EN COURS — MAJ le 02/09/2026 08:00";

const grid = [
  ["Forecast 2026-11 — Données"],
  ["🔎 Filtre personnel : menu « RM Forecast » → « Mon filtre »"],
  labels,
  header,
  // Une affaire d'équipe : figée au snapshot, modifiée dans le bloc vivant.
  ["006Sb00000aZDAX", "Île-de-France", "Valentin MARION", "Client A", "", "", "",
   "30%", "100 000 €", "10 000 €", "30 000 €", "3 000 €", "Nouvelle", "",
   "80%", "999 999 €", "10 000 €", "799 999 €", "3 000 €", "Nouvelle", ""],
];

const parsed = parseForecastGrid(grid, "2026-11");

// 1. Les deux natures sont rendues SÉPARÉMENT.
check("le bloc historique produit un snapshot", parsed.lines.length === 1,
  `${parsed.lines.length} ligne(s)`);
check("le bloc « EN COURS » produit un état courant", parsed.currentLines.length === 1,
  `${parsed.currentLines.length} ligne(s)`);
check("« EN COURS » n'est pas une anomalie", parsed.issues.length === 0,
  parsed.issues.map((i) => i.message).join(" | ") || "aucune");

// 2. Aucune contamination : le snapshot garde SA valeur et SA date.
check("le snapshot garde sa valeur, non celle du bloc courant",
  parsed.lines[0]?.gmv === 100000, `gmv=${parsed.lines[0]?.gmv}`);
check("le snapshot garde sa date", parsed.lines[0]?.snapshotDate === "2026-08-31",
  `${parsed.lines[0]?.snapshotDate}`);
check("l'état courant porte SA valeur", parsed.currentLines[0]?.gmv === 999999,
  `gmv=${parsed.currentLines[0]?.gmv}`);
check("l'état courant n'a AUCUNE date de snapshot",
  parsed.currentLines[0]?.snapshotDate === undefined);
check("l'état courant est horodaté par son « MAJ le »",
  parsed.currentLines[0]?.updatedAt === "2026-09-02T08:00",
  `${parsed.currentLines[0]?.updatedAt}`);
check("le « MAJ le » le plus récent est identifiable",
  parsed.currentUpdatedAt === "2026-09-02T08:00", `${parsed.currentUpdatedAt}`);

// 3 et 4. Un mois neuf n'ayant QUE le bloc courant reste exploitable, sans
// fausse anomalie — c'est exactement le cas de 2026-11 au 02/09/2026.
const fresh = parseForecastGrid(
  [grid[0], grid[1], ["", "", "", "", "", "", "", "EN COURS — MAJ le 02/09/2026 08:00"],
   header.slice(0, 14), grid[4].slice(0, 14)],
  "2026-11",
);
check("mois neuf : aucun snapshot historique", fresh.lines.length === 0);
check("mois neuf : l'état courant est bien exploitable", fresh.currentLines.length === 1,
  `${fresh.currentLines.length} ligne(s)`);
check("mois neuf : aucune fausse anomalie", fresh.issues.length === 0,
  fresh.issues.map((i) => i.message).join(" | ") || "aucune");

// Un bloc courant sans « MAJ le » lisible reste exploitable, sans anomalie.
const undated = parseForecastGrid(
  [grid[0], grid[1], ["", "", "", "", "", "", "", "EN COURS"],
   header.slice(0, 14), grid[4].slice(0, 14)],
  "2026-11",
);
check("bloc courant sans horodatage : exploitable quand même",
  undated.currentLines.length === 1 && undated.issues.length === 0,
  `${undated.currentLines.length} ligne(s), ${undated.issues.length} anomalie(s)`);

// Un bloc réellement anonyme reste, lui, une anomalie : on n'a pas remplacé un
// signalement excessif par un silence complet.
const anonymous = parseForecastGrid(
  [grid[0], grid[1], [], header.slice(0, 14), grid[4].slice(0, 14)],
  "2026-11",
);
check("un bloc sans étiquette du tout reste signalé", anonymous.issues.length === 1,
  anonymous.issues.map((i) => i.message).join(" | ") || "aucune");

// --- Le territoire ---------------------------------------------------------

console.log("\nTERRITOIRE — champ retenu : le code postal du compte");
check("75011 est en Île-de-France", territoryOfPostalCode("75011") === "idf");
check("56600 (Lanester) est hors Île-de-France", territoryOfPostalCode("56600") === "hors-idf");
check("un code postal absent reste « inconnu »", territoryOfPostalCode(null) === "inconnu");
check("sans restriction, tout est dans le périmètre", isInTerritoryScope(null, "56600"));
check("avec « idf », un dossier breton est hors périmètre",
  isInTerritoryScope("idf", "56600") === false);
check("avec « idf », un dossier francilien est dans le périmètre",
  isInTerritoryScope("idf", "75011"));
check("avec « idf », un code postal absent ne fait rien disparaître",
  isInTerritoryScope("idf", null));

// --- Le périmètre d'équipe -------------------------------------------------

console.log("\nÉQUIPE — la liste attendue par le DR");
loadTeam();
const EXPECTED = [
  "Anthony Ramaherison", "Daravith Chan Fah", "David Bernstein", "Guillaume Fontaine",
  "Guillaume Huc", "Jonathan Florville", "Mathis Coulon", "Stéphane Strat",
  "Sami Lazari", "Valentin Marion", "Vincent Bouzy", "Vincent Da Silva",
];
const active = allTeamMembers().filter((m) => m.active).map((m) => m.name);
check(`${EXPECTED.length} commerciaux suivis`, active.length === EXPECTED.length,
  `${active.length} : ${active.join(", ")}`);
for (const name of EXPECTED) {
  check(`${name} est dans le périmètre`, matchTeamMember(name) !== null);
}
check("Delphine LE MOINE est hors périmètre", matchTeamMember("Delphine LE MOINE") === null);
check("Nicolas GERARD est hors périmètre", matchTeamMember("Nicolas GERARD") === null);
check("Valentin Marion porte la restriction Île-de-France",
  matchTeamMember("Valentin MARION")?.territory === "idf");

// CAS 6 et 7 : retrait puis réintégration, sans perte de données.
console.log("\nÉQUIPE — retrait et réintégration (données intactes)");
const db = getDb();
const countOpps = (owner) =>
  db.prepare("SELECT count(*) AS n FROM opportunity WHERE owner = ?").get(owner).n;

const victim = "Mathis Coulon";
const before = countOpps(victim);
removeTeamMember("mathiscoulon");
check(`${victim} sort du périmètre`, matchTeamMember(victim) === null);
check("ses opportunités ne sont PAS supprimées", countOpps(victim) === before,
  `${countOpps(victim)} / ${before}`);
addTeamMember({ name: victim });
check(`${victim} revient dans le périmètre`, matchTeamMember(victim) !== null);
check("ses données réapparaissent intactes", countOpps(victim) === before,
  `${countOpps(victim)} / ${before}`);

// --- Le flux Perspective de bout en bout -----------------------------------

console.log("\nPERSPECTIVE — import réel du classeur (lecture seule)");
const histQuery = `SELECT forecast_month, snapshot_date, count(*) n,
       coalesce(round(sum(coalesce(gmv,0)), 2), 0) gmv
  FROM forecast_snapshot GROUP BY 1, 2 ORDER BY 1, 2`;
const fingerprint = () =>
  db.prepare(histQuery).all()
    .map((r) => `${r.forecast_month}|${r.snapshot_date}|${r.n}|${r.gmv}`).join("~");
// IMMUABILITE : empreinte de l'historique AVANT import, comparee apres.
const historyBefore = fingerprint();

const summary = await importForecastSnapshots(new SheetsApiForecastSnapshotSource());
console.log(
  `  ${summary.totalLines} lignes lues · ${summary.teamLines} d'équipe · ` +
    `${summary.ignoredLines} hors équipe · ${summary.outOfTerritoryLines} hors territoire`,
);
check("aucune anomalie dans le périmètre", summary.issues.length === 0,
  summary.issues.map((i) => i.message).join(" | ") || "aucune");
check("des lignes d'équipe ont bien été importées", summary.teamLines > 0,
  `${summary.teamLines}`);
check("les lignes hors équipe sont écartées sans bruit", summary.ignoredLines > 0,
  `${summary.ignoredLines}`);

// CAS 5 : les dossiers bretons de Valentin Marion, présents dans le classeur et
// étiquetés « Île-de-France » par la colonne DR, ne doivent pas entrer.
const BRETON = ["006Sb00000Th05i", "006Sb00000bkCos"]; // Lanester 56600, Languidic 56440
const importedBreton = db
  .prepare(
    `SELECT count(*) AS n FROM forecast_snapshot
     WHERE opportunity_id IN (?, ?) AND imported_at >= ?`,
  )
  .get(BRETON[0], BRETON[1], new Date(Date.now() - 600_000).toISOString()).n;
check("CAS 5 — les dossiers bretons de Valentin Marion sont exclus", importedBreton === 0,
  `${importedBreton} ligne(s) importée(s)`);

const marionIdf = db
  .prepare(
    `SELECT count(*) AS n FROM forecast_snapshot
     WHERE salesperson = 'Valentin Marion' AND imported_at >= ?`,
  )
  .get(new Date(Date.now() - 600_000).toISOString()).n;
check("CAS 4 — les dossiers franciliens de Valentin Marion sont conservés", marionIdf > 0,
  `${marionIdf} ligne(s)`);

const delphine = db
  .prepare("SELECT count(*) AS n FROM forecast_snapshot WHERE salesperson_raw LIKE '%LE MOINE%'")
  .get().n;
check("CAS 1 — aucune ligne de Delphine LE MOINE en base", delphine === 0, `${delphine}`);

console.log("\nETAT COURANT - exploite, et cloisonne de l'historique");
check("5. les snapshots historiques sont restes IDENTIQUES", historyBefore === fingerprint(),
  historyBefore === fingerprint() ? "aucun octet modifie" : "l'historique a bouge");
check("1. aucun snapshot fabrique apres le dernier lundi consolide",
  db.prepare("SELECT count(*) n FROM forecast_snapshot WHERE snapshot_date > ?")
    .get("2026-08-31").n === 0);
check("2. l'etat courant est disponible en base", summary.currentLines > 0,
  `${summary.currentLines} ligne(s)`);
check("6. le bloc courant le plus recent est identifiable",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(summary.currentUpdatedAt ?? ""),
  `${summary.currentUpdatedAt}`);
check("l'etat courant n'est pas accumule : une ligne par (mois, affaire)",
  db.prepare(
    "SELECT count(*) n FROM (SELECT forecast_month, row_key FROM forecast_current GROUP BY 1,2 HAVING count(*) > 1)",
  ).get().n === 0);

const novSnapshots = db
  .prepare("SELECT count(*) n FROM forecast_snapshot WHERE forecast_month = '2026-11'").get().n;
const novCurrent = loadForecastCurrent("2026-11");
check("3. 2026-11 n'a aucun snapshot historique", novSnapshots === 0, `${novSnapshots}`);
check("3. 2026-11 reste exploitable via l'etat courant", novCurrent.length > 0,
  `${novCurrent.length} ligne(s) - MAJ ${forecastCurrentUpdatedAt("2026-11")}`);

const currentOutsiders = db
  .prepare(
    `SELECT DISTINCT salesperson_raw s FROM forecast_current
      WHERE salesperson NOT IN (SELECT name FROM team_member WHERE active = 1)`,
  ).all().map((r) => r.s);
check("7. aucun commercial hors equipe dans l'etat courant", currentOutsiders.length === 0,
  currentOutsiders.join(", ") || "aucun");
const currentBreton = db
  .prepare("SELECT count(*) n FROM forecast_current WHERE opportunity_id IN (?, ?)")
  .get(BRETON[0], BRETON[1]).n;
check("7. dossiers bretons de Valentin Marion exclus de l'etat courant aussi",
  currentBreton === 0, `${currentBreton} ligne(s)`);
const currentMarion = db
  .prepare("SELECT count(*) n FROM forecast_current WHERE salesperson = 'Valentin Marion'").get().n;
check("7. ses dossiers franciliens y sont bien presents", currentMarion > 0,
  `${currentMarion} ligne(s)`);

const board = buildForecastBoard(0);
check("la vue Forecast s'appuie sur l'etat courant", board.perspectiveSource === "courant",
  `source=${board.perspectiveSource} date=${board.perspectiveDate} MAJ=${board.perspectiveUpdatedAt}`);

console.log("\nLISTE DE CHOIX — commerciaux proposables à l'ajout");
const candidates = teamCandidates();
check("le classeur a alimenté la liste", candidates.length > 0, `${candidates.length} nom(s)`);
check("Delphine LE MOINE est proposable mais hors périmètre",
  candidates.some((c) => /LE MOINE/i.test(c.name) && !c.known));

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT.\n" : `\n${failures} CONTRÔLE(S) EN ÉCHEC.\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles de la famille « Signé » du Forecast.
 *
 *   npm run forecast:signed-verify
 *
 * RÉGRESSION CORRIGÉE : avant ce lot, `forecast-board` écartait du tableau
 * toute affaire `isTerminal` — signée ou abandonnée confondues — si bien
 * qu'une affaire signée dans le mois disparaissait entièrement de la feuille,
 * alors que le total « Signé » de la bande au-dessus (source `official-signed`)
 * restait, lui, correct. Ces contrôles verrouillent le comportement cible :
 *
 *   A. signée dans le mois affiché  → toujours visible, étiquetée « Signé »,
 *      GMV visible, sans probabilité ni motif de challenge ;
 *   B. déclarée par le commercial   → inchangé (non touché par ce lot) ;
 *   C. probable RM Morning, non déclarée → inchangé (règle testée en pur) ;
 *   D. abandonnée                   → toujours absente.
 *
 * et l'absence de double comptage quand une affaire tout juste signée traîne
 * encore un instant dans le Kanban (retard d'import).
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE, jamais la base réelle.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "forecast-signed.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { buildForecastV2, isVisibleInForecast } = await import(lib("forecast-v2"));
const { shiftMonth } = await import(lib("forecast-board"));
const { officialSignedGmv } = await import(lib("official-signed"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const OWNER = "Anthony Ramaherison";
const today = new Date().toISOString().slice(0, 10);

// Mois de référence réel de la copie : on ne fabrique aucun import, on lit
// celui déjà en vigueur, exactement comme l'écran le ferait.
const MONTH = buildForecastV2(0).month;
const PREV_MONTH = shiftMonth(MONTH, -1);
const [y, m] = MONTH.split("-").map(Number);

function insertOpportunity({ id, gmv, kanbanMonth = null, kanbanYear = null, isTerminal = 0 }) {
  db.prepare(
    `INSERT INTO opportunity
       (opportunity_id, name, owner, gmv, stage, kanban_month, kanban_year,
        is_signed, is_terminal, is_standby, is_active, first_seen_on, last_import_id)
     VALUES (?, ?, ?, ?, 'Examen devis', ?, ?, 0, ?, 0, ?, ?, 0)`,
  ).run(id, `Client ${id}`, OWNER, gmv, kanbanMonth, kanbanYear, isTerminal, isTerminal ? 0 : 1, today);
}

function insertTravaux({ id, opportunityId, gmv, signatureDate }) {
  db.prepare(
    `INSERT INTO travaux
       (travaux_id, opportunity_id, name, opportunity_name, owner_raw, signature_date, gmv,
        works_status, first_seen_at, last_import_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Signé', ?, ?)`,
  ).run(id, opportunityId, `Client ${id}`, `Client ${id}`, OWNER, signatureDate, gmv, today, today);
}

// Signée ce mois-ci, mais encore visible au Kanban : simule le retard d'un
// import qui n'a pas encore marqué l'opportunité `isTerminal`.
const SIGNED_A = "TESTFCSIGNED_A";
// Active, déclarée sur le mois — famille B, doit rester inchangée.
const ACTIVE_C = "TESTFCSIGNED_C";
// Abandonnée — jamais visible, quelle que soit sa projection Kanban.
const ABANDONED_D = "TESTFCSIGNED_D";
// Signée le mois PRÉCÉDENT, disparue de Salesforce depuis (aucune ligne
// `opportunity` : seule la ligne Travaux en témoigne encore).
const SIGNED_B = "TESTFCSIGNED_B";

insertOpportunity({ id: SIGNED_A, gmv: 60000, kanbanMonth: m, kanbanYear: y, isTerminal: 0 });
insertTravaux({ id: "TRAV_TESTFC_A", opportunityId: SIGNED_A, gmv: 60000, signatureDate: `${MONTH}-15` });

insertOpportunity({ id: ACTIVE_C, gmv: 45000, kanbanMonth: m, kanbanYear: y, isTerminal: 0 });

insertOpportunity({ id: ABANDONED_D, gmv: 30000, kanbanMonth: m, kanbanYear: y, isTerminal: 1 });

insertTravaux({ id: "TRAV_TESTFC_B", opportunityId: SIGNED_B, gmv: 25000, signatureDate: `${PREV_MONTH}-20` });

const boardM = buildForecastV2(0);
const boardPrev = buildForecastV2(-1);
const rowsM = boardM.salespeople.flatMap((s) => s.opportunities);
const rowsPrev = boardPrev.salespeople.flatMap((s) => s.opportunities);
const rowById = (rows, id) => rows.find((r) => r.opportunityId === id);

section(`Mois observé : ${MONTH} (précédent ${PREV_MONTH})`);

// 1. Affaire signée ce mois-ci → visible, étiquetée, GMV présent, sans prévision.
const a = rowById(rowsM, SIGNED_A);
check("1a. affaire signée dans le mois : ligne présente", !!a, `id ${SIGNED_A}`);
check("1b. étiquetée « Signé »", a?.movement === "signee", `movement=${a?.movement}`);
check("1c. GMV visible", a?.gmv === 60000, `gmv=${a?.gmv}`);
check(
  "1d. aucune probabilité ni GMV probable — ce n'est pas une prévision",
  a?.expectedProbability == null && a?.expectedGmv == null,
);

// 2. Affaire signée le mois précédent → n'entre pas dans M par confusion sur
//    un état courant, mais apparaît sur le mois où elle a réellement signé.
check("2a. absente du mois M (signée un autre mois)", !rowById(rowsM, SIGNED_B));
check("2b. présente sur le mois où elle a réellement été signée", !!rowById(rowsPrev, SIGNED_B));

// 3. Affaire active déclarée sur le mois → famille B inchangée.
const c = rowById(rowsM, ACTIVE_C);
check("3. affaire active déclarée : toujours visible, pas une ligne signée", !!c && c.isSignedRow === false);

// 4. Famille C — probable RM Morning non déclarée : la règle est testée sur la
//    fonction pure `isVisibleInForecast`, seule source de vérité de l'écran,
//    inchangée par ce lot en dehors du court-circuit des lignes signées.
const probable = {
  outsideKanban: true,
  isStandby: false,
  standbyUntil: null,
  perspectiveMonth: null,
  expectedProbability: 0.3,
  isSignedRow: false,
};
check("4a. ≥ 25 % de chance de signer, non déclarée : visible", isVisibleInForecast(probable, MONTH, today) === true);
check(
  "4b. < 25 % de chance de signer, non déclarée : invisible",
  isVisibleInForecast({ ...probable, expectedProbability: 0.1 }, MONTH, today) === false,
);

// 5. Affaire abandonnée → jamais visible.
check("5. affaire abandonnée : absente du tableau", !rowById(rowsM, ABANDONED_D));

// 6. Une ligne signée ne reçoit jamais de motif « à challenger ».
const challenged = boardM.examine.some((e) => e.row.opportunityId === SIGNED_A);
check("6. affaire signée jamais « à challenger »", !challenged);

// 7. Aucun double comptage, y compris quand l'affaire signée est encore
//    visible au Kanban le temps du prochain import (cas volontaire de SIGNED_A).
const idsM = rowsM.map((r) => r.opportunityId);
check(
  "7a. aucun OpportunityId en double sur M",
  idsM.length === new Set(idsM).size,
  `${idsM.length - new Set(idsM).size} doublon(s)`,
);
check("7b. l'affaire signée ne compte qu'une seule fois", idsM.filter((id) => id === SIGNED_A).length === 1);

// 8. Le total « Signé » de la bande reste la même source unique qu'avant : la
//    somme des lignes signées affichées ne peut pas diverger du total officiel.
const official = officialSignedGmv(MONTH);
const sumSignedRows = rowsM.filter((r) => r.isSignedRow).reduce((t, r) => t + (r.gmv ?? 0), 0);
check(
  "8a. Σ lignes signées affichées = total Signé officiel du mois",
  Math.abs(sumSignedRows - official.gmv) < 1e-9,
  `lignes ${sumSignedRows} € · officiel ${official.gmv} €`,
);
check(
  "8b. Signé Région = Σ Signé officiel par commercial (calcul déjà existant, non modifié)",
  Math.abs(boardM.region.signedGmvActual - official.bySalesperson.reduce((t, s) => t + s.gmv, 0)) < 1e-9,
);

// 9. Cohérence des sommes par commercial après fusion des familles.
let ownerMismatch = 0;
for (const s of boardM.salespeople) {
  const gmv = s.opportunities.reduce((t, r) => t + (r.gmv ?? 0), 0);
  if (Math.abs(gmv - s.gmv) > 1e-9 || s.opportunities.length !== s.count) {
    ownerMismatch += 1;
    console.log(`        ${s.salesperson} : Σ lignes ${gmv} € ≠ sous-total ${s.gmv} €`);
  }
}
check(
  "9. Σ lignes = sous-total, pour chaque commercial",
  ownerMismatch === 0,
  `${boardM.salespeople.length} commerciaux vérifiés`,
);

console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

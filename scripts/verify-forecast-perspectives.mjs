/**
 * Contrôles du bandeau Forecast : trois lectures jamais mélangées.
 *
 *   npm run forecast:perspectives-verify
 *
 *   Signé à date        — Travaux officiels (`official-signed`) ;
 *   Reste annoncé       — Perspective M, onglet du mois affiché, lignes OUVERTES,
 *                         GMV brut, signé exclu ;
 *   Perspective ajustée — fichier manuel de Sami : pas branché, donc absent ;
 *   Prévision RM Morning — moteur Expected, inchangé.
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE, jamais la base réelle.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), process.env.VERIF_SOURCE_DB ?? "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "forecast-perspectives.db");
mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replaceAll(path.sep, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { buildForecastV2, applyTableMode, isVisibleInForecast } = await import(lib("forecast-v2"));
const { shiftMonth } = await import(lib("forecast-board"));
const { officialSignedGmv } = await import(lib("official-signed"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const db = getDb();
const OWNER = "Anthony Ramaherison";
const today = new Date().toISOString().slice(0, 10);
const MONTH = buildForecastV2(0).month;
const NEXT = shiftMonth(MONTH, 1);

// Base de contrôle : on vide la Perspective des deux mois et on la remplace par
// des lignes dont chaque montant identifie sa nature.
db.prepare("DELETE FROM forecast_current WHERE forecast_month IN (?, ?)").run(MONTH, NEXT);
db.prepare("DELETE FROM forecast_snapshot WHERE forecast_month IN (?, ?)").run(MONTH, NEXT);
const line = (month, id, gmv, conf, state) =>
  db
    .prepare(
      `INSERT INTO forecast_current (forecast_month, row_key, opportunity_id, salesperson, salesperson_raw,
         confidence, gmv, projected_gmv, state, updated_at, source, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)`,
    )
    .run(month, `k-${id}`, id, OWNER, OWNER, conf, gmv, gmv * conf, state, `${today}T08:00`, new Date().toISOString());

line(MONTH, "TESTPERSP_OPEN", 100000, 0.5, null); //  ouverte  → reste annoncé
line(MONTH, "TESTPERSP_WON", 30000, 1, "Gagnée"); //  gagnée   → exclue du reste
line(MONTH, "TESTPERSP_LOST", 20000, 0, "Perdue"); //  perdue   → exclue
line(MONTH, "TESTPERSP_PUSH", 10000, 0, "Repoussée"); // repoussée → exclue
line(MONTH, "TESTPERSP_SIGNED", 40000, 0.75, null); // ouverte au classeur MAIS signée en Travaux
line(NEXT, "TESTPERSP_NEXT", 70000, 0.5, null); //   onglet du mois suivant

db.prepare(
  `INSERT INTO travaux (travaux_id, opportunity_id, name, opportunity_name, owner_raw, signature_date, gmv,
     works_status, first_seen_at, last_import_at)
   VALUES ('TRAV_PERSP', 'TESTPERSP_SIGNED', 'x', 'Client signé test', ?, ?, 40000, 'Signé', ?, ?)`,
).run(OWNER, `${MONTH}-10`, today, today);

const M = buildForecastV2(0);
const M1 = buildForecastV2(1);
const r = M.region;
const officialM = officialSignedGmv(MONTH);
const rows = M.salespeople.flatMap((s) => s.opportunities);
const owner = M.salespeople.find((s) => s.salesperson === OWNER);

console.log(`\nMois ${MONTH} / ${NEXT}`);
check("1. Reste annoncé = GMV brut des lignes OUVERTES de Perspective M (100 000 €)", r.declaredOpenGmv === 100000 && r.declaredOpenCount === 1, `${r.declaredOpenGmv} € · ${r.declaredOpenCount} ligne(s)`);
check("1b. gagnée / perdue / repoussée exclues du reste annoncé", r.declaredOpenGmv < 100000 + 30000 + 20000 + 10000);
check("1c. non pondéré : ≠ Σ GMV × confiance de l'onglet", r.declaredOpenGmv !== r.perspectiveSnapshotGmv, `pondérée ${r.perspectiveSnapshotGmv}`);
check("2. le moteur n'invente aucune Perspective ajustée (la page la rattache depuis le classeur manuel)", r.adjustedPerspective === null && M1.region.adjustedPerspective === null);
check("3. septembre ne lit pas octobre", !rows.some((x) => x.opportunityId === "TESTPERSP_NEXT") && r.declaredOpenGmv !== 70000 && r.declaredOpenGmv !== 170000);
check("4. M+1 lit l'onglet du mois suivant (70 000 €)", M1.region.declaredOpenGmv === 70000, `${M1.region.declaredOpenGmv} €`);
check("5. Signé = Travaux officiels", Math.abs(r.signedGmvActual - officialM.bySalesperson.reduce((t, s) => t + s.gmv, 0)) < 1e-6);
check("5b. atterrissage = signé + reste annoncé", Math.abs(r.commercialLanding - (r.signedGmvActual + r.declaredOpenGmv)) < 1e-6);
check("5c. ligne ouverte au classeur mais signée en Travaux : retirée du reste (pas de double compte)", r.declaredOpenGmv === 100000 && owner?.declaredOpenGmv === 100000);

const signedRow = rows.find((x) => x.opportunityId === "TESTPERSP_SIGNED");
check("6. affaire signée visible dans « Toutes les affaires »", !!signedRow && applyTableMode(rows, "all").includes(signedRow) && isVisibleInForecast(signedRow, MONTH, today));
check("7. elle disparaît avec « Reste à signer »", !applyTableMode(rows, "remaining").some((x) => x.isSignedRow) && applyTableMode(rows, "remaining").length === rows.length - rows.filter((x) => x.isSignedRow).length);
check("8. le filtre n'altère aucun KPI (le mode ne touche que les lignes)", JSON.stringify(buildForecastV2(0).region) === JSON.stringify(r));
check("9. ligne signée jamais « À challenger »", !M.examine.some((e) => e.row.isSignedRow));
check("10. ligne signée jamais réinjectée dans Expected/probable", rows.filter((x) => x.isSignedRow).every((x) => x.expectedGmv == null && x.expectedProbability == null));
const ids = rows.map((x) => x.opportunityId);
check("11. aucun double comptage", ids.length === new Set(ids).size);
check("12. règles de challenge inchangées : seuls les motifs existants", M.examine.every((e) => ["absente_du_mois", "prevue_mois_suivant", "declaree_fragile"].includes(e.kind)));
check("Σ commerciaux = Région (reste annoncé)", M.salespeople.reduce((t, s) => t + s.declaredOpenGmv, 0) === r.declaredOpenGmv);

console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

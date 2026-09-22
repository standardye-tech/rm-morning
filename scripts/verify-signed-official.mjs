/**
 * Contrôles LOT 0 — le signé a une seule définition.
 *
 *   npm run signed:verify
 *
 * Le signé officiel est la somme des lignes Travaux réellement signées
 * (`officialSignedGmv`). Une affaire porte plusieurs lignes — l'originale, ses
 * avenants, ses annulations — donc :
 *
 *   GMV signé        = somme officielle des lignes Travaux ;
 *   nombre d'affaires = opportunités DISTINCTES, jamais le nombre de lignes.
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : des lignes Travaux fictives, retirées à la
 * fin. Jamais sur les données réelles.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "signed-official.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { businessMonth } = await import(lib("business-time"));
const { officialSignedGmv, officialSignedBetween } = await import(lib("official-signed"));
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { buildPerformanceBoard } = await import(lib("performance"));
const { TRAVAUX } = await import(lib("config"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const now = new Date();
const month = businessMonth(now);
const db = getDb();

const perfMetric = (board, owner, key) => {
  const row = board.salespeople.find((s) => s.salesperson === owner);
  for (const pillar of Object.values(row?.pillars ?? {})) {
    const m = pillar.metrics.find((x) => x.key === key);
    if (m) return m.value;
  }
  return null;
};

// ============================================================================
section("1 — Sur les données réelles : une seule valeur « signé »");

const official0 = officialSignedGmv(month);
const v2 = buildForecastV2(0, null, now);
const r = v2.region;
check("région : signedGmv = signedGmvActual", near(r.signedGmv, r.signedGmvActual), `${r.signedGmv} / ${r.signedGmvActual}`);
check("région : signedGmv = officialSignedGmv (Travaux)", near(r.signedGmv, official0.gmv), `${Math.round(r.signedGmv)} / ${Math.round(official0.gmv)}`);
check("région : signedCount = affaires DISTINCTES", r.signedCount === official0.opportunities, `${r.signedCount} / ${official0.opportunities}`);
check("région : signedLines = lignes Travaux", r.signedLines === official0.lines, `${r.signedLines} / ${official0.lines}`);
check("région : signedPlusKanban = signé officiel + Kanban", near(r.signedPlusKanban, official0.gmv + r.kanbanGmv));
const sumOwners = v2.salespeople.reduce((t, s) => t + s.signedGmv, 0);
check("Σ commerciaux : signedGmv = région", near(sumOwners, r.signedGmv), `${Math.round(sumOwners)} / ${Math.round(r.signedGmv)}`);
check(
  "chaque commercial : signedGmv = signedGmvActual",
  v2.salespeople.every((s) => near(s.signedGmv, s.signedGmvActual)),
);
check("le nombre d'affaires n'excède jamais le nombre de lignes", r.signedCount <= r.signedLines);

const snap = buildExpectedGmvSnapshot();
if (snap) {
  const officialSnap = officialSignedGmv(snap.month);
  check("Expected : signedGmv = officiel", near(snap.region.signedGmv, officialSnap.gmv));
  check("Expected : signedCount = affaires distinctes", snap.region.signedCount === officialSnap.opportunities, `${snap.region.signedCount} / ${officialSnap.opportunities}`);
  check("Expected : signedLines = lignes Travaux", snap.region.signedLines === officialSnap.lines, `${snap.region.signedLines} / ${officialSnap.lines}`);
  check(
    "Expected : Σ signedCount commerciaux = région",
    snap.salespeople.reduce((t, s) => t + s.signedCount, 0) === snap.region.signedCount,
  );
} else {
  check("Expected : aucun scoring dans cette base", true, "contrôles ignorés");
}

// ============================================================================
section("2 — 3 lignes Travaux, 2 affaires : l'écran ne dit pas « 3 affaires »");

const OWNER = v2.salespeople.find((s) => s.salesperson)?.salesperson ?? "Anthony Ramaherison";
const perfBefore = buildPerformanceBoard(now);
const perfDealsBefore = perfMetric(perfBefore, OWNER, "signed_deals");
const perfGmvBefore = perfMetric(perfBefore, OWNER, "signed_gmv");
const ownerBefore = v2.salespeople.find((s) => s.salesperson === OWNER);
const snapBefore = snap;

const status = TRAVAUX.signedStatuses[0];
const insert = db.prepare(
  `INSERT INTO travaux
     (travaux_id, opportunity_id, name, opportunity_name, owner_raw, signature_date, gmv, revenue,
      works_type, works_status, cancels_travaux_id, last_modified_at, first_seen_at, last_import_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
);
const stamp = new Date().toISOString();
const rows = [
  ["TESTSIGN_T1", "TESTSIGN_OPP_A", "Affaire A", 10_000, "Original"],
  ["TESTSIGN_T2", "TESTSIGN_OPP_A", "Affaire A", 2_000, "Avenant"],
  ["TESTSIGN_T3", "TESTSIGN_OPP_B", "Affaire B", 5_000, "Original"],
];
for (const [id, opp, name, gmv, type] of rows) {
  insert.run(id, opp, name, name, OWNER, `${month}-05`, gmv, type, status, stamp, stamp, stamp);
}

const official1 = officialSignedGmv(month);
check("officiel : +17 000 € de GMV", near(official1.gmv - official0.gmv, 17_000), `${official1.gmv - official0.gmv}`);
check("officiel : +3 lignes", official1.lines - official0.lines === 3, `${official1.lines - official0.lines}`);
check("officiel : +2 affaires distinctes", official1.opportunities - official0.opportunities === 2, `${official1.opportunities - official0.opportunities}`);

const v2b = buildForecastV2(0, null, now);
check("région : +17 000 € de signé", near(v2b.region.signedGmv - r.signedGmv, 17_000));
check("région : « affaires » +2 (et non +3)", v2b.region.signedCount - r.signedCount === 2, `${v2b.region.signedCount - r.signedCount}`);
check("région : lignes +3", v2b.region.signedLines - r.signedLines === 3);
check("région : signé + Kanban suit le signé officiel", near(v2b.region.signedPlusKanban - r.signedPlusKanban, 17_000));
const ownerAfter = v2b.salespeople.find((s) => s.salesperson === OWNER);
check(
  `${OWNER} : +2 affaires, +17 000 €`,
  (ownerAfter?.signedCount ?? 0) - (ownerBefore?.signedCount ?? 0) === 2 &&
    near((ownerAfter?.signedGmv ?? 0) - (ownerBefore?.signedGmv ?? 0), 17_000),
);
check("la page Morning lit region.signedCount (affaires distinctes)", v2b.region.signedCount === official1.opportunities);

const snapAfter = buildExpectedGmvSnapshot();
if (snapAfter && snapBefore && snapAfter.month === month) {
  check("Expected : +2 affaires, +3 lignes", snapAfter.region.signedCount - snapBefore.region.signedCount === 2 && snapAfter.region.signedLines - snapBefore.region.signedLines === 3, `${snapAfter.region.signedCount - snapBefore.region.signedCount} / ${snapAfter.region.signedLines - snapBefore.region.signedLines}`);
} else {
  check("Expected : mois scoré différent du mois courant dans cette base", true, "contrôle ignoré");
}

const perfAfter = buildPerformanceBoard(now);
const perfDealsAfter = perfMetric(perfAfter, OWNER, "signed_deals");
const perfGmvAfter = perfMetric(perfAfter, OWNER, "signed_gmv");
if (perfDealsBefore != null && perfDealsAfter != null) {
  check("Performance : +2 affaires signées (distinctes)", perfDealsAfter - perfDealsBefore === 2, `${perfDealsAfter - perfDealsBefore}`);
  check("Performance : +17 000 € de signé", near(perfGmvAfter - perfGmvBefore, 17_000), `${perfGmvAfter - perfGmvBefore}`);
} else {
  check("Performance : mesure « signé » lisible", false, "signed_deals introuvable");
}

// ============================================================================
// Non-régression demandée après l'écart « 4 affaires / 86 414 € » constaté
// entre un audit manuel (filtré par présence dans le roster opportunity_snapshot
// — un proxy d'équipe erroné) et officialSignedBetween (filtré par
// matchTeamMember(owner_raw), la VRAIE doctrine C10). officialSignedBetween
// doit rester à toute date une simple reparamétrisation par plage de
// officialSignedGmv — jamais une seconde définition.
section("3 — officialSignedBetween partage EXACTEMENT la doctrine de officialSignedGmv");

const monthStart = (m) => `${m}-01`;
const dayBefore = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const lastDayOf = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

// Même mois que la section 1/2 (les 3 lignes TESTSIGN_* y sont toujours actives) :
// officialSignedBetween sur l'équivalent EXACT du mois doit reproduire à l'euro
// et à l'affaire près ce que rend officialSignedGmv, avenants compris.
const range = officialSignedBetween(dayBefore(monthStart(month)), lastDayOf(month));
const official2 = officialSignedGmv(month);
check(
  "même GMV, mêmes lignes, mêmes affaires distinctes sur une plage équivalente au mois",
  near(range.gmv, official2.gmv) && range.lines === official2.lines && range.opportunities === official2.opportunities,
  `officialSignedGmv=${official2.gmv}/${official2.lines}l/${official2.opportunities}o ` +
    `vs officialSignedBetween=${range.gmv}/${range.lines}l/${range.opportunities}o`,
);
check(
  "les 3 lignes de test (2 affaires, avenant compris) s'y retrouvent identiquement",
  range.opportunities - official0.opportunities === official2.opportunities - official0.opportunities &&
    range.lines - official0.lines === official2.lines - official0.lines,
);

// Fenêtre plus étroite que le mois (le cas réel du bloc « Depuis ») : les 3
// lignes de test datées du 5 du mois doivent apparaître, sommées par affaire.
const narrowRange = officialSignedBetween(`${month}-01`, `${month}-10`);
const testRows = narrowRange.rows.filter((r) => r.travauxId?.startsWith("TESTSIGN_"));
const oppA = testRows.filter((r) => r.opportunityId === "TESTSIGN_OPP_A");
check(
  "affaire A (2 lignes Travaux, avenant) : une entrée par ligne dans le détail, mais 1 seule affaire distincte",
  oppA.length === 2,
  `${oppA.length} ligne(s) pour l'affaire A`,
);
check(
  "somme de l'affaire A = 12 000 € (10 000 original + 2 000 avenant)",
  near(oppA.reduce((t, r) => t + r.gmv, 0), 12_000),
);

// --- Nettoyage ---------------------------------------------------------------
db.prepare("DELETE FROM travaux WHERE travaux_id LIKE 'TESTSIGN_%'").run();

console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

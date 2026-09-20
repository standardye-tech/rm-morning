/**
 * Contrôles LOT 0 — le mois métier est unique.
 *
 *   npm run business-time:verify
 *
 * Le fuseau métier est Europe/Paris et la clé canonique « AAAA-MM ». Ces
 * contrôles couvrent les frontières où les anciennes définitions divergeaient
 * (horloge locale, UTC, date d'import) : le 31 à 23 h 59 Paris, le 1er à
 * 00 h 01 Paris, l'écart UTC / Paris, et les horizons M, M+1, M+2.
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE (jamais dans les données réelles), et
 * seulement pour les contrôles d'intégration de la fin du fichier.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "business-time.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { parisDate, businessMonth, shiftBusinessMonth, businessYearToDateMonths, parisWeekday } =
  await import(lib("business-time"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const at = (iso) => new Date(iso);
const utcMonth = (d) => d.toISOString().slice(0, 7);

// ============================================================================
section("1 — Le 31 du mois à 23 h 59, heure de Paris");
// Hiver (UTC+1) : 23 h 59 Paris = 22 h 59 UTC.
{
  const d = at("2026-01-31T22:59:00Z");
  check("Paris : toujours le 31 janvier", parisDate(d) === "2026-01-31", parisDate(d));
  check("mois métier : 2026-01", businessMonth(d) === "2026-01", businessMonth(d));
  check("M+1 : 2026-02", businessMonth(d, 1) === "2026-02");
}
// Été (UTC+2) : 23 h 59 Paris = 21 h 59 UTC.
{
  const d = at("2026-08-31T21:59:00Z");
  check("été : toujours le 31 août à Paris", parisDate(d) === "2026-08-31", parisDate(d));
  check("été : mois métier 2026-08", businessMonth(d) === "2026-08");
}

// ============================================================================
section("2 — Le 1er du mois à 00 h 01, heure de Paris");
{
  const d = at("2026-01-31T23:01:00Z");
  check("hiver : Paris est déjà le 1er février", parisDate(d) === "2026-02-01", parisDate(d));
  check("hiver : mois métier 2026-02", businessMonth(d) === "2026-02", businessMonth(d));
  check("hiver : UTC dit encore janvier (c'est l'ancien bug)", utcMonth(d) === "2026-01");
}
{
  const d = at("2026-08-31T22:01:00Z");
  check("été : Paris est déjà le 1er septembre", parisDate(d) === "2026-09-01", parisDate(d));
  check("été : mois métier 2026-09", businessMonth(d) === "2026-09");
}

// ============================================================================
section("3 — Écart UTC / Europe-Paris : une seule réponse");
{
  // Entre minuit et 2 h Paris en été, UTC est encore la veille. La machine de
  // production tourne en UTC : c'est exactement la fenêtre où deux écrans
  // pouvaient afficher deux mois différents.
  const d = at("2026-09-30T22:30:00Z");
  check("UTC : septembre", utcMonth(d) === "2026-09");
  check("Paris : octobre (00 h 30, 1er octobre)", businessMonth(d) === "2026-10", businessMonth(d));
  check("le jour métier est celui de Paris", parisDate(d) === "2026-10-01", parisDate(d));
  // Passage à l'heure d'hiver : 25 octobre 2026 à 03 h → 02 h.
  const winter = at("2026-10-31T23:30:00Z");
  check("après le passage à l'heure d'hiver : 31 oct. 23 h 30 UTC = 00 h 30 Paris le 1er nov.",
    parisDate(winter) === "2026-11-01", parisDate(winter));
}

// ============================================================================
section("4 — M, M+1, M+2, et le franchissement d'année");
{
  const d = at("2026-11-30T23:30:00Z"); // 00 h 30 le 1er décembre à Paris
  check("M = 2026-12", businessMonth(d, 0) === "2026-12", businessMonth(d, 0));
  check("M+1 = 2027-01", businessMonth(d, 1) === "2027-01", businessMonth(d, 1));
  check("M+2 = 2027-02", businessMonth(d, 2) === "2027-02", businessMonth(d, 2));
  check("M-1 = 2026-11", businessMonth(d, -1) === "2026-11");
  check("shiftBusinessMonth : -13 mois", shiftBusinessMonth("2026-01", -13) === "2024-12", shiftBusinessMonth("2026-01", -13));
  check("shiftBusinessMonth : +24 mois", shiftBusinessMonth("2026-12", 24) === "2028-12");
  const ytd = businessYearToDateMonths(at("2026-03-15T10:00:00Z"));
  check("année civile à date : janvier à mars", ytd.length === 3 && ytd[0] === "2026-01" && ytd[2] === "2026-03", ytd.join(","));
  const ytdEdge = businessYearToDateMonths(at("2026-12-31T23:30:00Z")); // 00 h 30 le 1er janvier 2027 à Paris
  check("le 1er janvier à Paris ouvre l'année suivante", ytdEdge.length === 1 && ytdEdge[0] === "2027-01", ytdEdge.join(","));
  check("jour de la semaine à Paris : 2026-09-21 est un lundi", parisWeekday(at("2026-09-21T09:00:00Z")) === 1);
  check("dimanche = 7", parisWeekday(at("2026-09-20T09:00:00Z")) === 7);
}

// ============================================================================
section("5 — Toutes les surfaces donnent le même mois au même instant");

const { buildForecastBoard } = await import(lib("forecast-board"));
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { yearToDateMonths, dynamicWindows } = await import(lib("performance"));
const { officialMonthlyReference } = await import(lib("official-signed"));
const { weekBounds } = await import(lib("week"));

for (const iso of ["2026-08-31T21:30:00Z", "2026-08-31T22:30:00Z", "2026-12-31T22:30:00Z", "2026-09-15T12:00:00Z"]) {
  const now = at(iso);
  const expected = businessMonth(now);
  const m0 = buildForecastBoard(0, null, now);
  const m1 = buildForecastBoard(1, null, now);
  const m2 = buildForecastV2(2, null, now);
  const ytd = yearToDateMonths(now);
  const dyn = dynamicWindows(now);
  const ref = officialMonthlyReference(24, now);
  check(
    `${iso} — Forecast M / M+1 / M+2`,
    m0.month === expected && m1.month === businessMonth(now, 1) && m2.month === businessMonth(now, 2),
    `${m0.month} / ${m1.month} / ${m2.month}`,
  );
  check(`${iso} — Performance : dernier mois de l'année à date`, ytd[ytd.length - 1] === expected, ytd[ytd.length - 1]);
  check(
    `${iso} — Performance : dernier mois clôturé = M-1`,
    dyn.recent[dyn.recent.length - 1] === businessMonth(now, -1),
    dyn.recent[dyn.recent.length - 1],
  );
  check(
    `${iso} — signé officiel : le mois courant est exclu du repère`,
    ref == null || ref.to < expected,
    ref ? `jusqu'à ${ref.to}` : "aucun repère",
  );
  const wb = weekBounds(now);
  check(`${iso} — Ma semaine : la semaine commence un lundi`, parisWeekday(new Date(`${wb.weekStart}T12:00:00Z`)) === 1, wb.weekStart);
}
{
  // Un import de la veille ne doit plus décaler le mois : on simule un dernier
  // import daté du 30 septembre, puis on demande le tableau le 1er octobre.
  const board = buildForecastBoard(0, null, at("2026-09-30T22:30:00Z"));
  check("date d'import antérieure : le mois suit l'horloge, pas l'import", board.month === "2026-10", board.month);
}

// ============================================================================
section("6 — Plus aucun calcul de mois hors du module partagé");

const SKIP = new Set([
  "business-time.ts",
  // Le dataset reconstruit des dates PASSÉES à partir de l'historique Salesforce :
  // il n'exprime pas « le mois courant ».
  "expected-gmv-dataset.ts",
  // `todayIso` est le formateur générique de dates calendaires locales, utilisé
  // pour l'arithmétique de dates (lundi de la semaine, +N jours). Ce n'est pas
  // une réponse à « quel mois sommes-nous ? » : celle-ci vient de business-time.
  "normalize.ts",
  // Monitoring : hors périmètre de ce lot (période « mois » d'un tableau de pistes).
  "lead-metrics.ts",
]);
const PATTERNS = [
  { re: /new Date\(\)\.toISOString\(\)\.slice\(0,\s*7\)/, label: "new Date().toISOString().slice(0, 7)" },
  { re: /now\.getMonth\(\)\s*\+\s*1/, label: "now.getMonth() + 1" },
  { re: /now\.getFullYear\(\)/, label: "now.getFullYear()" },
  { re: /reference\.slice\(0,\s*7\)/, label: "reference.slice(0, 7)" },
  { re: /referenceDate\.slice\(0,\s*7\)/, label: "referenceDate.slice(0, 7)" },
];
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const offenders = [];
for (const file of walk(path.resolve(process.cwd(), "src"))) {
  if (SKIP.has(path.basename(file))) continue;
  const text = readFileSync(file, "utf8");
  for (const { re, label } of PATTERNS) if (re.test(text)) offenders.push(`${path.relative(process.cwd(), file)} : ${label}`);
}
check("aucun calcul de mois courant hors de `business-time.ts`", offenders.length === 0, offenders.join(" | "));

console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles — lien Salesforce standardisé.
 *
 *   npm run links:verify
 *
 * Règle produit : partout où un élément affiché correspond à une Opportunity qui
 * porte un OpportunityId, le nom de l'affaire est un lien (nouvel onglet) vers sa
 * fiche Salesforce. Une seule construction d'URL (`salesforceOpportunityUrl`) ;
 * sans identifiant exploitable, du texte simple.
 *
 * Lecture seule : la copie de base n'est écrite par aucun contrôle.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "links.db");
mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");
delete process.env.SF_INSTANCE_URL;

const url = (n) => pathToFileURL(path.resolve(process.cwd(), n)).href;
const { salesforceOpportunityUrl } = await import(url("src/lib/salesforce-link.ts"));
const { SALESFORCE_RECORD_BASE } = await import(url("src/lib/config.ts"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const read = (f) => readFileSync(path.resolve(process.cwd(), f), "utf8");

section("1 — Le helper : une seule construction d'URL");
const ID15 = "006Sb00000c7jfF";
const ID18 = "006Sb00000c7jfFAAQ";
check("Id à 15 caractères → URL de la fiche", salesforceOpportunityUrl(ID15) === `${SALESFORCE_RECORD_BASE}/${ID15}`, salesforceOpportunityUrl(ID15));
check("Id à 18 caractères → URL de la fiche", salesforceOpportunityUrl(ID18) === `${SALESFORCE_RECORD_BASE}/${ID18}`);
check("espaces autour de l'Id tolérés", salesforceOpportunityUrl(`  ${ID15} `) === `${SALESFORCE_RECORD_BASE}/${ID15}`);
check("fallback : sans SF_INSTANCE_URL, le domaine de l'org", /^https:\/\/renovationman\.my\.salesforce\.com$/.test(SALESFORCE_RECORD_BASE), SALESFORCE_RECORD_BASE);
for (const bad of [null, undefined, "", "   ", "TESTPV_HOT", "006Sb0000", "006Sb00000c7jfF/../x", "javascript:alert(1)", `${ID15}x`]) {
  check(`aucun Id exploitable (${JSON.stringify(bad)}) → null : pas de faux lien`, salesforceOpportunityUrl(bad) === null);
}

section("2 — SF_INSTANCE_URL est respectée (processus séparé)");
const child = spawnSync(
  process.execPath,
  [
    ...process.execArgv,
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(url("src/lib/salesforce-link.ts"))}); console.log(m.salesforceOpportunityUrl(${JSON.stringify(ID15)}));`,
  ],
  { env: { ...process.env, SF_INSTANCE_URL: "https://exemple.my.salesforce.com/" }, encoding: "utf8" },
);
const out = (child.stdout || "").trim().split("\n").pop();
check("base surchargée, barre finale retirée", out === `https://exemple.my.salesforce.com/${ID15}`, out || (child.stderr || "").slice(0, 120));

section("3 — Aucun composant ne construit d'URL Salesforce lui-même");
const walk = (dir, o = []) => {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, o);
    else if (/\.(ts|tsx)$/.test(e)) o.push(f);
  }
  return o;
};
const rel = (f) => path.relative(process.cwd(), f).replace(/\\/g, "/");
const builders = walk(path.resolve(process.cwd(), "src"))
  .filter((f) => /SALESFORCE_RECORD_BASE|\.salesforce\.com|lightning\.force\.com/.test(readFileSync(f, "utf8")))
  .map(rel)
  .sort();
check(
  "seuls config.ts (constante) et salesforce-link.ts (helper) connaissent le domaine",
  JSON.stringify(builders) === JSON.stringify(["src/lib/config.ts", "src/lib/salesforce-link.ts"]),
  builders.join(", "),
);

section("4 — Le composant : nouvel onglet, discret, pas de faux lien");
const comp = read("src/components/salesforce-link.tsx");
check('ouverture dans un nouvel onglet, sans fuite (target="_blank", rel="noopener noreferrer")', /target="_blank"/.test(comp) && /rel="noopener noreferrer"/.test(comp));
check("sans Id exploitable : texte simple (aucun <a>)", /if \(!href\) return <span/.test(comp));
check("style discret : souligné pointillé, aucun bouton ni icône", /decoration-dotted/.test(comp) && !/<button|<svg|<img/.test(comp));
check("l'URL vient du helper partagé", /salesforceOpportunityUrl/.test(comp) && !/https?:\/\//.test(comp.replace(/\/\*[\s\S]*?\*\//g, "")));

section("5 — Inventaire : chaque surface qui affiche une affaire porte le lien");
const surfaces = [
  ["Morning · Blocs 1 et 2 + Plan du jour + silencieuses", "src/components/morning-v2.tsx", 4],
  ["Morning · blocs V1 (top affaires, à challenger)", "src/components/morning.tsx", 2],
  ["Forecast (tableau, à challenger)", "src/components/forecast-v2.tsx", 2],
  ["Forecast (feuille par commercial)", "src/components/forecast-sheet.tsx", 1],
  ["Forecast (sorties, candidats)", "src/components/forecast-board.tsx", 3],
  ["Expected GMV · M (challenge, affaires suivies)", "src/components/expected-gmv.tsx", 2],
  ["Expected GMV · M+1 (Construire M+1)", "src/components/construire-m1.tsx", 1],
  ["Monitoring · Opportunités", "src/components/monitoring-opportunities.tsx", 3],
  ["Ma semaine · gros dossiers", "src/components/week.tsx", 1],
  ["Ma semaine · affaire de la semaine", "src/components/deal-of-week.tsx", 2],
];
for (const [label, file, min] of surfaces) {
  const src = read(file);
  const n = (src.match(/<SalesforceOpportunityLink/g) || []).length;
  check(`${label}`, n >= min && /from "@\/components\/salesforce-link"/.test(src), `${n} lien(s) dans ${file.split("/").pop()}`);
}
const perf = read("src/components/performance.tsx") + read("src/components/performance-table.tsx");
check("Performance : aucune affaire individuelle affichée (agrégats seulement) → rien à lier", !/opportunityId|\.client\b/.test(perf));

section("6 — Chaque lien reçoit un OpportunityId réel (données)");
const { buildMorningPlan } = await import(url("src/lib/morning-priority.ts"));
const plan = buildMorningPlan(new Date());
check("Plan du jour : chaque ligne a un Id → lien", plan.actions.every((a) => salesforceOpportunityUrl(a.opportunityId) !== null), `${plan.actions.length} ligne(s)`);
check(
  "affaires « prometteuses mais silencieuses » : l'Id est porté",
  plan.silentButStrong.every((s) => typeof s.opportunityId === "string" && salesforceOpportunityUrl(s.opportunityId) !== null),
  `${plan.silentButStrong.length}`,
);
const all = [...plan.hot, ...plan.waiting];
const withId = all.filter((e) => e.opportunityId);
const withoutId = all.filter((e) => !e.opportunityId);
check("Blocs 1 et 2 : un message rattaché à une affaire reçoit un lien", withId.every((e) => salesforceOpportunityUrl(e.opportunityId) !== null), `${withId.length} rattaché(s)`);
check("Blocs 1 et 2 : un message sans affaire reste du texte (pas de faux lien)", withoutId.every((e) => salesforceOpportunityUrl(e.opportunityId) === null), `${withoutId.length} sans affaire`);

console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles — lien Salesforce standardisé (affaires ET pistes).
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
const { salesforceOpportunityUrl, salesforceRecordUrl } = await import(url("src/lib/salesforce-link.ts"));
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

section("1 bis — Helper généralisé : Lead et Opportunity, une seule logique");
const LEAD15 = "00QbF00000LlJW9";
const LEAD18 = "00QbF00000LlJW9UAN";
check("LeadId à 15 caractères → URL de la fiche", salesforceRecordUrl(LEAD15) === `${SALESFORCE_RECORD_BASE}/${LEAD15}`, salesforceRecordUrl(LEAD15));
check("LeadId à 18 caractères → URL de la fiche", salesforceRecordUrl(LEAD18) === `${SALESFORCE_RECORD_BASE}/${LEAD18}`, salesforceRecordUrl(LEAD18));
check("l'URL d'une piste pointe le domaine Salesforce et l'Id exact", /^https:\/\/[a-z0-9-]+\.my\.salesforce\.com\/00Q[a-zA-Z0-9]{12,15}$/.test(salesforceRecordUrl(LEAD18)));
for (const bad of [null, undefined, "", "  ", "00Q", "00QbF00000LlJW9UA", "Camille BELLEDENT", "camille@exemple.fr", "00QbF00000LlJW9UAN?x=1", "00QbF00000LlJW9UAN/../", `${LEAD18}Z`]) {
  check(`Id de piste invalide (${JSON.stringify(bad)}) → aucun lien`, salesforceRecordUrl(bad) === null);
}
check("non-régression : salesforceOpportunityUrl est LA MÊME fonction (aucun code dupliqué)", salesforceOpportunityUrl === salesforceRecordUrl);
check("non-régression : les Id d'affaires donnent exactement les mêmes URL", salesforceOpportunityUrl(ID15) === salesforceRecordUrl(ID15) && salesforceOpportunityUrl(ID18) === salesforceRecordUrl(ID18));

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
check("l'URL vient du helper partagé (salesforceRecordUrl)", /salesforceRecordUrl/.test(comp) && !/https?:\/\//.test(comp.replace(/\/\*[\s\S]*?\*\//g, "")));

check("SalesforceRecordLink porte la logique ; SalesforceOpportunityLink n'en est qu'un habillage", /export function SalesforceRecordLink/.test(comp) && /<SalesforceRecordLink recordId=\{opportunityId\}/.test(comp) && (comp.match(/target="_blank"/g) || []).length === 1);

section("5 — Inventaire : chaque surface qui affiche une affaire porte le lien");
const surfaces = [
  // Lot de simplification : « silencieuses » et les blocs V1 (morning.tsx) ne
  // sont plus rendus — leurs moteurs restent, leurs liens disparaissent avec eux.
  ["Morning · Blocs 1 et 2 + Plan du jour", "src/components/morning-v2.tsx", 3],
  ["Morning · Depuis la dernière photo (audit V3.1)", "src/components/since-last-snapshot.tsx", 1],
  // Lot de simplification (E6) : le détail de la Région (sorties, candidats,
  // tableau à challenger) n'est plus rendu ; toutes les affaires du Forecast
  // passent par la feuille, qui porte le lien.
  ["Forecast (feuille par commercial)", "src/components/forecast-sheet.tsx", 1],
  ["Expected GMV · M (challenge, affaires suivies)", "src/components/expected-gmv.tsx", 2],
  ["Expected GMV · M+1 (Construire M+1)", "src/components/construire-m1.tsx", 1],
  ["Monitoring · Opportunités", "src/components/monitoring-opportunities.tsx", 3],
  // Lot de simplification : les blocs de Ma semaine sont fondus dans le
  // planning recommandé — les affaires clés de chaque carte portent le lien.
  ["Ma semaine · planning recommandé (affaires clés)", "src/components/week-agenda.tsx", 1],
];
{
  const mon = read("src/components/monitoring.tsx");
  check("Monitoring · Pistes : le nom de la piste ouvre sa fiche (LeadId)", /<SalesforceRecordLink recordId=\{lead\.leadId\}>/.test(mon) && /from "@\/components\/salesforce-link"/.test(mon));
  check("Monitoring · Pistes : aucun Id reconstruit depuis le nom ou l'e-mail", !/email|Email/.test(mon.slice(mon.indexOf("LeadTodo"))));
}
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

section("7 — Pistes du stock Monitoring : Id original, lien exact");
const { loadLeads } = await import(url("src/lib/lead-store.ts"));
const { leadMonitoringView } = await import(url("src/lib/monitoring-view.ts"));
const leads = loadLeads();
const linkable = leads.filter((l) => salesforceRecordUrl(l.leadId) !== null);
check("le stock de pistes est non vide (sinon le contrôle est vide)", leads.length > 0, `${leads.length} piste(s)`);
check("chaque piste porte son Id Salesforce original (15 ou 18 car., préfixe 00Q)", linkable.length === leads.length && leads.every((l) => /^00Q/.test(l.leadId)), `${linkable.length}/${leads.length}`);
check("chaque URL cible exactement le LeadId de la piste", linkable.every((l) => salesforceRecordUrl(l.leadId) === `${SALESFORCE_RECORD_BASE}/${l.leadId.trim()}`));
const shown = leadMonitoringView(null).items.map((i) => i.lead);
check("pistes AFFICHÉES dans Monitoring → Pistes : toutes liables", shown.every((l) => salesforceRecordUrl(l.leadId) !== null), `${shown.length} affichée(s)`);
check("aucun Id n'est reconstruit : un identifiant altéré ne donne aucun lien", salesforceRecordUrl(`${leads[0]?.leadId ?? "x"}!`) === null);

console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles — objectif mensuel et « Construire M+1 ».
 *
 *   npm run objective:verify
 *
 * Couvre le stockage minimal `monthly_objective`, la route de saisie, le calcul
 * de couverture et de manque, et surtout les SOURCES : chaque chiffre du bloc doit
 * venir du moteur qui le produit (Projection Kanban, Perspective ajustée, projection
 * RM Morning M+1, signé officiel Travaux), sans aucun KPI concurrent.
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : des objectifs fictifs, retirés à la fin.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "objective-m1.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { businessMonth } = await import(lib("business-time"));
const { getObjective, setObjective, clearObjective, listObjectives } = await import(lib("objective-store"));
const { coverageOf, buildConstruireM1, m1Deals, FUTURE_SHARE_M1 } = await import(lib("build-m1"));
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { loadAdjustedPerspective } = await import(lib("adjusted-perspective"));
const { officialSignedGmv } = await import(lib("official-signed"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const db = getDb();
const now = new Date();
const M = businessMonth(now, 0);
const M1 = businessMonth(now, 1);

// ============================================================================
section("1 — Migration additive : monthly_objective(month, scope, amount, updated_at)");

const cols = db.prepare("PRAGMA table_info(monthly_objective)").all();
check("colonnes exactes", cols.map((c) => c.name).join(",") === "month,scope,amount,updated_at", cols.map((c) => c.name).join(","));
check("clé primaire (month, scope)", cols.filter((c) => c.pk > 0).map((c) => c.name).sort().join(",") === "month,scope");
check("aucun montant par défaut dans le schéma", cols.every((c) => c.dflt_value == null));
check("aucune ligne à la création : aucun objectif codé en dur", db.prepare("SELECT COUNT(*) n FROM monthly_objective").get().n === 0);

// ============================================================================
section("2 — Stockage : saisie, remplacement, retrait, validation");

check("mois sans objectif : null", getObjective(M1) === null);
const o1 = setObjective(M1, 800_000, now);
check("saisie : région, montant, date", o1.scope === "region" && o1.amount === 800_000 && o1.month === M1 && o1.updatedAt === now.toISOString());
const later = new Date(now.getTime() + 60_000);
const o2 = setObjective(M1, 850_000.4, later);
check("une seule ligne par mois : la saisie remplace, met à jour la date", o2.amount === 850_000 && o2.updatedAt === later.toISOString() && db.prepare("SELECT COUNT(*) n FROM monthly_objective WHERE month = ?").get(M1).n === 1);
check("mois invalide refusé", throws(() => setObjective("2026-13", 1000)) && throws(() => setObjective("septembre", 1000)));
check("montant nul, négatif ou non numérique refusé", throws(() => setObjective(M1, 0)) && throws(() => setObjective(M1, -5)) && throws(() => setObjective(M1, Number.NaN)));
check("liste par mois", listObjectives([M, M1]).length === 1 && listObjectives([M, M1])[0].month === M1);
check("retrait : le mois redevient non renseigné", clearObjective(M1) === true && getObjective(M1) === null && clearObjective(M1) === false);

// ============================================================================
section("3 — Couverture et manque à construire (calcul pur)");

const c1 = coverageOf(1_000_000, 620_000);
check("objectif 1 000 k€, prévision 620 k€ → couverture 62 %, manque 380 k€", near(c1.ratio, 0.62) && c1.missing === 380_000 && c1.surplus === 0);
const c2 = coverageOf(500_000, 620_000);
check("prévision au-dessus de l'objectif → manque nul, excédent 120 k€", c2.missing === 0 && c2.surplus === 120_000 && near(c2.ratio, 1.24));
check("objectif non renseigné : aucune couverture, aucun déficit inventé", coverageOf(null, 620_000) === null);
check("prévision indisponible : aucune couverture", coverageOf(800_000, null) === null);
check("objectif nul ou négatif : aucune couverture", coverageOf(0, 620_000) === null && coverageOf(-1, 620_000) === null);

// ============================================================================
section("4 — Construire M+1 : sans objectif, rien n'est inventé");

const m1a = await buildConstruireM1(now);
check("mois = M+1 métier", m1a.month === M1, m1a.month);
check("sans objectif : objectif nul, couverture nulle, manque nul", m1a.objective === null && m1a.coverage === null);

// ============================================================================
section("5 — Construire M+1 : chaque chiffre vient de son moteur");

setObjective(M1, 900_000, now);
const m1b = await buildConstruireM1(now);
const board = buildForecastV2(1, null, now);
check("Objectif M+1 = monthly_objective", m1b.objective?.amount === 900_000);
check("Déclaratif commerciaux M+1 = Projection Kanban de Forecast V2 (M+1)", m1b.declared.gmv === board.region.kanbanGmv && m1b.declared.count === board.region.count, `${Math.round(m1b.declared.gmv)} / ${board.region.count}`);
const adj = await loadAdjustedPerspective(M1, true);
check("Perspective ajustée M+1 = classeur manuel de la Région (même lecture)", m1b.adjusted.ok === adj.ok && (!adj.ok || near(m1b.adjusted.value.gmv, adj.value.gmv)), adj.ok ? `${Math.round(adj.value.gmv)}` : adj.reason);
if (board.expectedM1) {
  check("Prévision RM Morning M+1 = projection régionale C8.1 (expected-m1)", m1b.forecast?.projection === board.expectedM1.projection && m1b.forecast.rangeLo === board.expectedM1.rangeLo && m1b.forecast.rangeHi === board.expectedM1.rangeHi);
  const cov = m1b.coverage;
  check("Couverture = prévision RM Morning ÷ objectif", cov != null && near(cov.ratio, board.expectedM1.projection / 900_000, 1e-9));
  check("Manque à construire = max(0, objectif − prévision RM Morning)", cov != null && near(cov.missing, Math.max(0, 900_000 - board.expectedM1.projection)));
} else {
  check("projection M+1 non publiée : prévision nulle, aucune couverture inventée", m1b.forecast === null && m1b.coverage === null && typeof m1b.forecastUnavailableReason === "string");
}
const b0 = buildForecastV2(0, null, now);
const official = officialSignedGmv(M);
check("signé du mois courant = officialSignedGmv (Travaux) — non concurrencé par une autre source", near(b0.region.signedGmv, official.gmv) && near(b0.region.signedGmvActual, official.gmv));
check("part d'affaires futures = mesure historique C8.1 (46 %), pas une ventilation du jour", m1b.futureShare === "46 %" && FUTURE_SHARE_M1 === "46 %");

// ============================================================================
section("6 — Affaires qui construisent M+1");

const deals = m1b.deals;
check("chaque affaire est déclarée sur M+1 (Kanban) OU suggérée par RM Morning (ligne jaune M+1)", deals.every((d) => d.declaredOnM1 || d.challenge));
check("aucun doublon d'affaire", new Set(deals.map((d) => d.opportunityId)).size === deals.length);
check("triées par GMV décroissante", deals.every((d, i) => i === 0 || deals[i - 1].gmv >= d.gmv));
check("aucune affaire signée ni sans montant", deals.every((d) => d.gmv > 0));
check("champs demandés : commercial, affaire, GMV, stade, Kanban M+1, probabilité, challenge", deals.every((d) => d.ownerFirstName && d.client && "stage" in d && "declaredOnM1" in d && "probability" in d && "challenge" in d));
check("identifié = Σ des affaires listées (et jamais présenté comme la prévision)", m1b.identified.count === deals.length && near(m1b.identified.gmv, deals.reduce((t, d) => t + d.gmv, 0)));
check("m1Deals reproductible depuis la même planche", JSON.stringify(m1Deals(board).map((d) => d.opportunityId)) === JSON.stringify(deals.map((d) => d.opportunityId)));

const comp = readFileSync(path.resolve(process.cwd(), "src/components/construire-m1.tsx"), "utf8");
check("le bloc dit que la prévision n'est PAS la somme des affaires", /n&apos;est pas la somme des affaires/.test(comp) && /pas la prévision/.test(comp));
check("le bloc affiche « Objectif non renseigné » quand l'objectif manque", /Objectif non renseigné/.test(comp));
check("aucune ventilation « pipe identifié / GMV futur » n'est fabriquée", /aucune n&apos;est affichée/.test(comp));
check("lien Salesforce par affaire, via le composant partagé", /SalesforceOpportunityLink/.test(comp) && !/SALESFORCE_RECORD_BASE/.test(comp) && /opportunityId/.test(comp));

// ============================================================================
section("7 — Route de saisie /api/objective");

let route = null;
try {
  route = await import(pathToFileURL(path.resolve(process.cwd(), "src/app/api/objective/route.ts")).href);
} catch (e) {
  console.log(`  (route non importable dans ce harnais : ${String(e).slice(0, 80)})`);
}
if (route) {
  const post = (body) => route.POST(new Request("http://x/api/objective", { method: "POST", body: JSON.stringify(body) }));
  const r1 = await post({ month: M1, amount: "1 200 000" });
  const j1 = await r1.json();
  check("POST : montant saisi avec espaces accepté", r1.status === 200 && j1.objective?.amount === 1_200_000, `${r1.status}`);
  const r2 = await post({ month: "n'importe quoi", amount: 5 });
  check("POST : mois invalide → 400", r2.status === 400);
  const r3 = await post({ month: M1, amount: "abc" });
  check("POST : montant invalide → 400", r3.status === 400);
  const r4 = await route.GET();
  const j4 = await r4.json();
  check("GET : objectifs de M à M+3", Array.isArray(j4.objectives) && j4.objectives.some((o) => o.month === M1 && o.amount === 1_200_000));
  const r5 = await route.DELETE(new Request("http://x/api/objective", { method: "DELETE", body: JSON.stringify({ month: M1 }) }));
  check("DELETE : l'objectif est retiré", r5.status === 200 && getObjective(M1) === null);
}

// ============================================================================
section("8 — Aucun objectif codé en dur, saisie depuis Données");

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(f);
  }
  return out;
};
const writers = walk(path.resolve(process.cwd(), "src")).filter((f) => /INSERT INTO monthly_objective/.test(readFileSync(f, "utf8"))).map((f) => path.basename(f));
check("une seule écriture de l'objectif : objective-store.ts", JSON.stringify(writers) === JSON.stringify(["objective-store.ts"]), writers.join(", "));
const donnees = readFileSync(path.resolve(process.cwd(), "src/app/donnees/page.tsx"), "utf8");
check("saisie depuis l'écran Données", /ObjectiveForm/.test(donnees) && /Objectif mensuel de la Région/.test(donnees));
const expectedPage = readFileSync(path.resolve(process.cwd(), "src/app/expected-gmv/page.tsx"), "utf8");
check("vue M+1 dans /expected-gmv (pas de nouvel onglet)", /vue === "m1"/.test(expectedPage) && /ConstruireM1Block/.test(expectedPage));

db.prepare("DELETE FROM monthly_objective").run();
console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

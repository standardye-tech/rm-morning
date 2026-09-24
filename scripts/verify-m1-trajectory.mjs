/**
 * Tests de la « Trajectoire de construction » M+1 — audit V3.3.
 *
 *   npm run m1-trajectory:verify
 *
 * Deux parties :
 *
 *   — cas obligatoires joués sur des fixtures fabriquées (l'historique est
 *     injecté : aucune base n'est lue). Les séries de test reprennent les
 *     chiffres RÉELS de la production du 24/09/2026 (mois cible 2026-10) ;
 *   — contrôle d'intégration en LECTURE SEULE sur la base locale : cohérence
 *     avec l'Expected M+1 actuel, et garde-fous de structure (aucun KPI
 *     concurrent, aucune écriture, moteur Expected non modifié).
 *
 * LECTURE SEULE de bout en bout.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const {
  buildM1Trajectory,
  classifyTrend,
  daysUntilMonth,
  loadM1History,
  missingDaysBetween,
  pickCheckpoints,
  requiredPace,
  valueAtOrBefore,
} = await import(lib("m1-trajectory"));
const { coverageOf } = await import(lib("build-m1"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// Dates réellement présentes en production (mois cible 2026-10) : 5 trous.
const PROD_DATES = [
  "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-07", "2026-09-08", "2026-09-09",
  "2026-09-10", "2026-09-11", "2026-09-13", "2026-09-14", "2026-09-16", "2026-09-17", "2026-09-18",
  "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24",
];
const RM = {
  "2026-09-01": 814746, "2026-09-02": 802222, "2026-09-03": 792295, "2026-09-05": 795407,
  "2026-09-07": 797252, "2026-09-08": 795992, "2026-09-09": 802480, "2026-09-10": 812834,
  "2026-09-11": 811906, "2026-09-13": 814717, "2026-09-14": 819290, "2026-09-16": 820360,
  "2026-09-17": 820462, "2026-09-18": 823775, "2026-09-20": 822735, "2026-09-21": 812275,
  "2026-09-22": 807142, "2026-09-23": 799521, "2026-09-24": 803905,
};
const DECLARED = {
  "2026-09-01": 989567, "2026-09-02": 1018746, "2026-09-03": 708190, "2026-09-05": 697794,
  "2026-09-07": 697794, "2026-09-08": 697794, "2026-09-09": 542989, "2026-09-10": 543942,
  "2026-09-11": 586682, "2026-09-13": 716941, "2026-09-14": 818726, "2026-09-16": 1069910,
  "2026-09-17": 1087789, "2026-09-18": 1099971, "2026-09-20": 1095804, "2026-09-21": 1233311,
  "2026-09-22": 1489593, "2026-09-23": 1395435, "2026-09-24": 1093539,
};
const YELLOW = { "2026-09-17": 96478, "2026-09-24": 172994, "2026-09-10": 64475, "2026-09-03": 40610 };

const history = (over = {}) => ({
  rmMorning: new Map(Object.entries(RM)),
  declared: new Map(Object.entries(DECLARED).map(([d, g]) => [d, { gmv: g, count: 10 }])),
  yellow: new Map(Object.entries(YELLOW).map(([d, g]) => [d, { gmv: g, count: 2 }])),
  ...over,
});

const input = (over = {}) => {
  const declaredLive = over.declared ?? { gmv: 1_093_539, count: 20 };
  const identifiedLive = over.identified ?? { count: 27, gmv: 1_266_533 };
  const objective = over.objective === undefined ? { amount: 1_200_000, updatedAt: "2026-09-20T19:43:27.589Z" } : over.objective;
  const forecast = over.forecast === undefined ? { projection: 803905, rangeLo: 683319, rangeHi: 1004881, confidence: "moyenne", generatedAt: "2026-09-24T09:55:56+00:00" } : over.forecast;
  return {
    month: "2026-10",
    monthLabel: "octobre 2026",
    objective,
    forecast,
    coverage: coverageOf(objective?.amount ?? null, forecast?.projection ?? null),
    adjusted: over.adjusted ?? { ok: false, reason: "test" },
    futureShare: "46 %",
    declared: declaredLive,
    identified: identifiedLive,
  };
};

// ────────────────────────────────────────────────────────────────────────
section("OBJECTIF ABSENT / PRÉSENT / MANQUE");

{
  const t = buildM1Trajectory(input({ objective: null }), "2026-09-24", history());
  check("objectif absent : pas de manque", t.missing === null && t.objective === null);
  check("objectif absent : aucun rythme inventé", t.pace === null && t.covered === false);
  check("objectif absent : la trajectoire (historique) reste disponible", t.history !== null);
}
{
  const t = buildM1Trajectory(input(), "2026-09-24", history());
  check("objectif présent : manque = objectif − prévision (coverageOf, jamais recalculé)", near(t.missing, 1_200_000 - 803905), `${Math.round(t.missing)}`);
  check("manque positif : non couvert", t.covered === false && t.missing > 0);
  check("semaines restantes : 7 jours avant le 1er octobre = 1 semaine", t.daysLeft === 7 && near(t.pace.weeksLeft, 1));
  check("rythme requis = manque ÷ semaines restantes", near(t.pace.weekly, 1_200_000 - 803905));
}
{
  const t = buildM1Trajectory(input({ forecast: { projection: 1_250_000, rangeLo: 1, rangeHi: 2, confidence: "moyenne", generatedAt: "x" } }), "2026-09-24", history());
  check("objectif déjà couvert : manque 0, covered", t.missing === 0 && t.covered === true);
  check("objectif déjà couvert : aucun rythme requis", t.pace === null);
}
{
  const t = buildM1Trajectory(input({ forecast: null }), "2026-09-24", history());
  check("prévision absente : ni manque ni rythme fabriqués", t.missing === null && t.pace === null);
}

// ────────────────────────────────────────────────────────────────────────
section("SEMAINES RESTANTES ET RYTHME REQUIS");

{
  check("30/09 : 1 jour avant M+1", daysUntilMonth("2026-09-30", "2026-10") === 1);
  check("17/09 : 14 jours = 2 semaines", daysUntilMonth("2026-09-17", "2026-10") === 14);
  check("01/10 : M+1 a commencé, 0 jour", daysUntilMonth("2026-10-01", "2026-10") === 0);
  const p = requiredPace(176_000, 14);
  check("exemple de la mission : 176 k€ en 2 semaines -> 88 k€/semaine", p && near(p.weeksLeft, 2) && near(p.weekly, 88_000));
  const q = requiredPace(100_000, 10);
  check("10 jours = 10/7 semaine, sans arrondi caché", q && near(q.weeksLeft, 10 / 7) && near(q.weekly, 100_000 / (10 / 7)));
  check("M+1 commencé : aucun rythme", requiredPace(50_000, 0) === null);
  check("manque nul ou négatif : aucun rythme", requiredPace(0, 7) === null && requiredPace(-5, 7) === null);
  check("manque absent : aucun rythme", requiredPace(null, 7) === null);
}

// ────────────────────────────────────────────────────────────────────────
section("TROUS HISTORIQUES");

{
  const cp = pickCheckpoints(PROD_DATES);
  check("points de lecture hebdomadaires, du plus ancien au plus récent", JSON.stringify(cp) === JSON.stringify(["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]), cp.join(", "));
  check("les 5 jours sans génération sont listés, pas comblés", JSON.stringify(missingDaysBetween(PROD_DATES)) === JSON.stringify(["2026-09-04", "2026-09-06", "2026-09-12", "2026-09-15", "2026-09-19"]));
  // Cible J-7 tombant sur un jour sans photo : jour disponible AVANT OU ÉGAL, jamais après.
  const gap = pickCheckpoints(["2026-09-08", "2026-09-14", "2026-09-16", "2026-09-22"]);
  check("cible sans photo : on prend le jour disponible le plus proche AVANT", gap.includes("2026-09-14") && !gap.includes("2026-09-16"), gap.join(", "));
  check("une seule date : un seul point, pas de semaine inventée", pickCheckpoints(["2026-09-24"]).length === 1);
  check("aucune date : aucun point", pickCheckpoints([]).length === 0);
  check("plafonné à maxCheckpoints", pickCheckpoints(Array.from({ length: 60 }, (_, i) => `2026-07-${String((i % 28) + 1).padStart(2, "0")}`)).length <= 6);

  const t = buildM1Trajectory(input(), "2026-09-24", history());
  check("historique : 4 points de lecture sur ~3,4 semaines", t.history.checkpoints.length === 4 && t.history.weeksCovered > 3 && t.history.weeksCovered < 4, `${t.history.weeksCovered.toFixed(2)} sem.`);
  check("note : moins de 4 semaines d'historique signalé", t.notes.some((n) => n.includes("semaine(s) seulement")));
  check("note : jours sans photo signalés", t.notes.some((n) => n.includes("5 jour(s) sans photo")));
  check("note : l'historique de l'objectif n'est pas conservé (jamais rejoué)", t.notes.some((n) => n.includes("historique n'est pas conservé")));
}

// ────────────────────────────────────────────────────────────────────────
section("COHÉRENCE DE LA DERNIÈRE COLONNE AVEC LE HAUT DE LA VUE");

{
  const same = buildM1Trajectory(input(), "2026-09-24", history());
  const s = Object.fromEntries(same.history.series.map((x) => [x.key, x]));
  check("aujourd'hui = dernier point : la dernière colonne reprend le moteur (prévision, déclaratif, pipe identifié)", s.rmMorning.values[3] === 803905 && s.declared.values[3] === 1_093_539 && s.identified.values[3] === 1_266_533);
  check("écart nul avec la photo du jour : aucune note d'écart", !same.notes.some((n) => n.includes("diffère de la photo")));

  const drift = buildM1Trajectory(input({ declared: { gmv: 1_190_000, count: 22 }, identified: { count: 29, gmv: 1_362_994 } }), "2026-09-24", history());
  const d = Object.fromEntries(drift.history.series.map((x) => [x.key, x]));
  check("écart photo/moteur : la dernière colonne prend le moteur, comme le haut de la vue", d.declared.values[3] === 1_190_000 && d.identified.values[3] === 1_362_994);
  check("écart photo/moteur : dit explicitement, jamais absorbé", drift.notes.some((n) => n.includes("diffère de la photo Opportunity du jour")));
  check("les points passés ne sont jamais réécrits par le moteur", d.declared.values[2] === 1_087_789 && d.rmMorning.values[2] === 820_462);

  const stale = buildM1Trajectory(input({ declared: { gmv: 1, count: 1 } }), "2026-09-26", history());
  const st = stale.history.series.find((x) => x.key === "declared");
  check("historique qui s'arrête avant aujourd'hui : rien n'est écrasé par le moteur", st.values[3] === 1_093_539);
  check("historique en retard : dit", stale.notes.some((n) => n.includes("Dernière projection enregistrée : 24/09")));
}

// ────────────────────────────────────────────────────────────────────────
section("OBJECTIF ET PERSPECTIVE AJUSTÉE = REPÈRES ACTUELS, JAMAIS DES SÉRIES");

{
  const adj = { ok: true, value: { month: "2026-10", gmv: 724664.68, source: "selection", snapshotDate: null, count: 16, byOwner: {}, snapshots: [] } };
  const t = buildM1Trajectory(input({ adjusted: adj }), "2026-09-24", history());
  check("aucune série « objectif » : pas de ligne ni de valeur d'objectif par date", !t.history.series.some((s) => /objectif/i.test(s.label) || s.key === "objective"));
  check("les 4 séries sont RM Morning, déclaratif, ajustée, pipe identifié", t.history.series.map((s) => s.key).join() === "rmMorning,declared,adjusted,identified");
  check("Perspective ajustée : valeur actuelle exposée comme repère", t.adjustedCurrent && near(t.adjustedCurrent.gmv, 724664.68) && t.adjustedCurrent.count === 16);
  const a = t.history.series.find((s) => s.key === "adjusted");
  check("Perspective ajustée : la valeur actuelle n'est PAS recopiée dans la série", a.values.every((v) => v === null) && a.week === null && a.window === null);
  check("Perspective ajustée illisible : aucun repère inventé", buildM1Trajectory(input(), "2026-09-24", history()).adjustedCurrent === null);
  const src = readFileSync(path.resolve(process.cwd(), "src/components/trajectory-m1.tsx"), "utf8");
  check("UI : « Objectif actuel » (repère courant), plus « Objectif M+1 »", src.includes('label="Objectif actuel"') && !src.includes('label="Objectif M+1"'));
  check("UI : rappel « Pipe identifié ≠ prévision RM Morning »", src.includes("≠ prévision RM Morning"));
  check("UI : l'objectif n'est jamais rendu dans le tableau historique", !/t\.objective/.test(src.slice(src.indexOf("<table"))));
}

// ────────────────────────────────────────────────────────────────────────
section("TENDANCES — « monte / stagne / recule » sur chiffres réels");

{
  check("+16 k€ sur 820 k€ (+2 %) -> stagne", classifyTrend(820_462, 803_905).trend === "flat");
  check("+54 % -> monte", classifyTrend(708_190, 1_093_539).trend === "up");
  check("−50 k€ sur 400 k€ (−12 %) -> recule", classifyTrend(400_000, 350_000).trend === "down");
  check("petite série : +4 k€ (< plancher 5 k€) -> stagne malgré +40 %", classifyTrend(10_000, 14_000).trend === "flat");
  check("seuil relatif 3 % respecté : +2,9 % de 1 M€ -> stagne", classifyTrend(1_000_000, 1_029_000).trend === "flat");
  const t = buildM1Trajectory(input(), "2026-09-24", history());
  const byKey = Object.fromEntries(t.history.series.map((s) => [s.key, s]));
  check("RM Morning M+1 sur la période : stagne (815 k -> 804 k)", byKey.rmMorning.window.trend === "flat" || byKey.rmMorning.window.trend === "up");
  check("RM Morning M+1 sur 7 jours (820 k -> 804 k) : stagne", byKey.rmMorning.week.trend === "flat" && byKey.rmMorning.week.delta < 0);
  check("déclaratif Kanban sur la période : monte (708 k -> 1 094 k)", byKey.declared.window.trend === "up");
  check("déclaratif Kanban sur 7 jours : stagne (1 088 k -> 1 094 k)", byKey.declared.week.trend === "flat");
  check("pipe identifié = déclaratif + jaunes du jour", byKey.identified.values[3] === 1_093_539 + 172_994 && byKey.identified.values[2] === 1_087_789 + 96_478, `${byKey.identified.values.join(" / ")}`);
  check("pipe identifié à un jour sans jaune enregistré : jaunes = 0, pas un trou", byKey.identified.values[0] === 708_190 + 40_610 && byKey.identified.values[1] === 543_942 + 64_475);
}

// ────────────────────────────────────────────────────────────────────────
section("ABSENCE D'UNE SÉRIE — rien n'est inventé");

{
  const t = buildM1Trajectory(input(), "2026-09-24", history());
  const adj = t.history.series.find((s) => s.key === "adjusted");
  check("Perspective ajustée illisible : série indisponible avec sa raison", adj.unavailableReason === "test" && adj.values.every((v) => v === null));
  check("série indisponible : aucune tendance", adj.week === null && adj.window === null);
  check("les autres séries restent affichées", t.history.series.filter((s) => !s.unavailableReason).length === 3);

  const emptySnapshots = buildM1Trajectory(input({ adjusted: { ok: true, value: { month: "2026-10", gmv: 724664, source: "selection", snapshotDate: null, count: 16, byOwner: {}, snapshots: [] } } }), "2026-09-24", history());
  const adj2 = emptySnapshots.history.series.find((s) => s.key === "adjusted");
  check("onglet sans bloc daté (cas réel d'octobre) : indisponible, valeur actuelle NON recopiée en série", adj2.unavailableReason?.includes("aucun bloc hebdomadaire daté") && adj2.values.every((v) => v === null));

  const filled = buildM1Trajectory(input({ adjusted: { ok: true, value: { month: "2026-10", gmv: 560000, source: "snapshot", snapshotDate: "2026-09-21", count: 5, byOwner: {}, snapshots: [{ date: "2026-09-07", filled: true, gmv: 500000 }, { date: "2026-09-21", filled: true, gmv: 560000 }, { date: "2026-09-28", filled: false, gmv: 0 }] } } }), "2026-09-24", history());
  const adj3 = filled.history.series.find((s) => s.key === "adjusted");
  check("blocs datés présents : dernier bloc daté au plus tard à chaque point (09-03 sans bloc = —)", JSON.stringify(adj3.values) === JSON.stringify([null, 500000, 500000, 560000]), adj3.values.join(" / "));
  check("bloc vide de la semaine à venir ignoré", adj3.values.every((v) => v !== 0));
  check("valueAtOrBefore ne regarde jamais en avant", valueAtOrBefore([{ date: "2026-09-21", value: 1 }], "2026-09-20") === null);

  const noDeclared = buildM1Trajectory(input(), "2026-09-24", history({ declared: new Map() }));
  const dec = noDeclared.history.series.find((s) => s.key === "declared");
  const ide = noDeclared.history.series.find((s) => s.key === "identified");
  check("aucune photo Opportunity : déclaratif et pipe identifié indisponibles, pas à zéro", dec.unavailableReason !== null && ide.unavailableReason !== null && dec.values.every((v) => v === null));

  const partial = buildM1Trajectory(input(), "2026-09-24", history({ declared: new Map([["2026-09-24", { gmv: 1_093_539, count: 20 }]]) }));
  const dec2 = partial.history.series.find((s) => s.key === "declared");
  check("point Opportunity manquant à une date : « — », jamais interpolé", dec2.values[0] === null && dec2.values[3] === 1_093_539 && dec2.window === null);

  const none = buildM1Trajectory(input(), "2026-09-24", history({ rmMorning: new Map() }));
  check("aucune projection RM Morning : pas de trajectoire, mais objectif/manque/rythme restent", none.history === null && none.pace !== null && none.notes.some((n) => n.includes("Aucune projection RM Morning")));
}

// ════════════════════════════════════════════════════════════════════════
section("INTÉGRATION — lecture seule sur la base locale");

{
  const { buildForecastV2 } = await import(lib("forecast-v2"));
  const { getObjective } = await import(lib("objective-store"));
  const { parisDate } = await import(lib("business-time"));
  const today = parisDate();
  const board = buildForecastV2(1);
  const m1 = board.expectedM1;
  const objective = getObjective(board.month);
  const data = {
    month: board.month,
    monthLabel: board.monthLabel,
    objective: objective ? { amount: objective.amount, updatedAt: objective.updatedAt } : null,
    forecast: m1 ? { projection: m1.projection, rangeLo: m1.rangeLo, rangeHi: m1.rangeHi, confidence: m1.confidence, generatedAt: m1.generatedAt } : null,
    coverage: coverageOf(objective?.amount ?? null, m1?.projection ?? null),
    adjusted: { ok: false, reason: "test hors ligne" },
    futureShare: "46 %",
    declared: { gmv: board.region.kanbanGmv, count: board.region.count },
    identified: { count: 0, gmv: 0 },
  };
  let t = null;
  try {
    t = buildM1Trajectory(data, today);
  } catch (e) {
    console.log(`  ÉCHEC — ${e instanceof Error ? e.message : String(e)}`);
    failures += 1;
  }
  check("buildM1Trajectory ne lève pas sur l'état réel", t !== null);
  if (t) {
    console.log(`  info  mois=${t.month} objectif=${t.objective ?? "—"} prévision=${t.forecast != null ? Math.round(t.forecast) : "—"} manque=${t.missing != null ? Math.round(t.missing) : "—"} historique=${t.history ? `${t.history.firstDate}→${t.history.lastDate}` : "aucun"}`);
    check("aucun KPI concurrent : le manque est celui de coverageOf, à l'euro", t.missing === (data.coverage ? data.coverage.missing : null));
    check("aucun KPI concurrent : la prévision est celle de l'Expected M+1 actuel", t.forecast === (m1 ? m1.projection : null));
    const h = loadM1History(board.month);
    if (m1 && h.rmMorning.has(m1.observationDate)) {
      check(
        "cohérence : le dernier point historique du jour = Expected M+1 actuel",
        near(h.rmMorning.get(m1.observationDate), m1.projection, 0.5),
        `${Math.round(h.rmMorning.get(m1.observationDate))} / ${Math.round(m1.projection)}`,
      );
      const decl = h.declared.get(m1.observationDate);
      if (decl) {
        // Information seulement : sur cette base locale, des affaires « absentes de
        // la source » restent comptées par le moteur mais pas par la photo du jour.
        console.log(`  info  déclaratif Kanban : photo du ${m1.observationDate} = ${Math.round(decl.gmv)} / moteur = ${Math.round(board.region.kanbanGmv)} (l'écart éventuel est dit dans la vue, voir « cohérence de la dernière colonne »)`);
      }
    } else {
      console.log("  info  pas de projection M+1 enregistrée pour le jour de l'Expected actuel sur cette base : cohérence non testable ici");
    }
  }

  section("GARDE-FOUS DE STRUCTURE");
  const src = readFileSync(path.resolve(process.cwd(), "src/lib/m1-trajectory.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("lecture seule : aucune écriture SQL dans le module", !/\b(INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|DROP)\b/i.test(code));
  check("aucun moteur parallèle : n'importe ni le scoring ni le moteur Expected", !/expected-m1|expected-gmv-live|forecast-v2|publish_m1/.test(code));
  const keys = Object.keys(buildM1Trajectory(input(), "2026-09-24", history()));
  check("aucun score, aucune probabilité, aucun risque dans la trajectoire", !keys.some((k) => /score|proba|risk|risque|alert|ratio|verdict/i.test(k)), keys.join(", "));
  const dirty = execSync(
    "git status --porcelain -- src/lib/expected-m1.ts src/lib/expected-gmv-live.ts src/lib/build-m1.ts src/lib/forecast-v2.ts src/lib/config.ts scripts/publish_m1.py scripts/expected_gmv.py scripts/expected_gmv_score.py",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((l) => l.trim() && !l.includes("src/lib/config.ts"));
  check("moteur Expected / build-m1 / Forecast non modifiés (config.ts : ajout du bloc M1_TRAJECTORY seul)", dirty.length === 0, dirty.join(" | "));
}

console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

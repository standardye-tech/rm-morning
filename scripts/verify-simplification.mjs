/**
 * Contrôles des règles pures du lot de simplification (D, E, F).
 *
 *   npm run simplification:verify
 *
 * Aucune écriture. Entrées fabriquées, puis invariants sur l'état réel.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/${n}`)).href;
const { compare } = await import(lib("lib/sort-compare.ts"));
const { forecastChallengers, buildForecastV2 } = await import(lib("lib/forecast-v2.ts"));
const { FORECAST_CHALLENGE } = await import(lib("lib/config.ts"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

section("D — Monitoring : tri des colonnes");
{
  const nums = [1_100_000, 34_000, null, 281_000].sort((a, b) => compare(a, b, "desc"));
  check("nombres : ordre numérique (1,1 M€ avant 281 k€ avant 34 k€)", nums.join() === "1100000,281000,34000,");
  const asc = [1_100_000, 34_000, null, 281_000].sort((a, b) => compare(a, b, "asc"));
  check("vides toujours en dernier, quel que soit le sens", asc[3] === null && asc[0] === 34_000);
  const txt = ["Valentin", "Émile", "anthony", "David"].sort((a, b) => compare(a, b, "asc"));
  check("textes : ordre alphabétique français (accents, casse)", txt.join() === "anthony,David,Émile,Valentin", txt.join());
}

// Planche minimale : affaires NON déclarées du mois en cours, sans montant imposé.
const fakeBoard = (rows, horizon = 0) => ({
  horizon,
  month: "2026-09",
  examine: [],
  salespeople: [
    {
      opportunities: rows.map(([id, p, over = {}]) => ({
        opportunityId: id, client: id, owner: "ET Test", gmv: 10_000, expectedProbability: p,
        expectedGmv: 10_000 * p, isSignedRow: false, outsideKanban: true, frozenMonthEnd: false, kanbanMonth: null, ...over,
      })),
    },
  ],
});

section("E1 / F9-F10 — frontière unique : > 25 % Forecast, 15 %–25 % Expected");
{
  const { expectedChallengers } = await import(lib("lib/forecast-v2.ts"));
  const b = fakeBoard([
    ["p150", 0.15], ["p151", 0.151], ["p250", 0.25], ["p251", 0.251], ["p800", 0.8],
    ["petite", 0.3, { gmv: 3_000, expectedGmv: 900 }],
    ["declaree", 0.5, { outsideKanban: false }], ["signee", 0.9, { isSignedRow: true }], ["gelee", 0.5, { frozenMonthEnd: true }],
  ]);
  const f = forecastChallengers(b).map((e) => e.row.opportunityId);
  const x = expectedChallengers(b).map((e) => e.row.opportunityId);
  check("15,0 % : absent des deux écrans", !f.includes("p150") && !x.includes("p150"));
  check("15,1 % : Expected", x.includes("p151") && !f.includes("p151"));
  check("25,0 % : Expected, pas Forecast", x.includes("p250") && !f.includes("p250"));
  check("25,1 % : Forecast seulement", f.includes("p251") && !x.includes("p251"));
  check("aucun recouvrement entre les deux listes", !f.some((id) => x.includes(id)));
  check("aucun seuil de montant : 3 k€ à 30 % -> Forecast", f.includes("petite"));
  check("déclarée, signée ou gelée : jamais proposée", !["declaree", "signee", "gelee"].some((id) => f.includes(id) || x.includes(id)));
  const many = expectedChallengers(fakeBoard(Array.from({ length: 11 }, (_, i) => [`x${i}`, 0.2])));
  check("aucun nombre maximum : 11 passent -> 11", many.length === 11);
  const real = buildForecastV2(0);
  const rf = forecastChallengers(real), rx = expectedChallengers(real);
  check("état réel : Forecast > 25 % strictement", rf.every((e) => (e.row.expectedProbability ?? 0) > FORECAST_CHALLENGE.minProbability), `${rf.length}`);
  check("état réel : Expected dans ]15 % ; 25 %]", rx.every((e) => e.row.expectedProbability > 0.15 && e.row.expectedProbability <= 0.25), `${rx.length}`);
  console.log(`  (info) Forecast : ${rf.map((e) => `${e.row.client} ${(e.row.expectedProbability * 100).toFixed(1)} %`).join(", ") || "—"} · Expected : ${rx.map((e) => `${e.row.client} ${(e.row.expectedProbability * 100).toFixed(1)} %`).join(", ") || "aucune"}`);
}

section("F4 — écart commerciaux / RM Morning sur M+1");
{
  const { m1GapDeals } = await import(lib("lib/build-m1.ts"));
  const d = (id, gmv, p, declared = true) => ({ opportunityId: id, client: id, gmv, probability: p, declaredOnM1: declared });
  const out = m1GapDeals([d("petit-sûr", 50_000, 0.1), d("gros", 157_000, 0.058), d("suggérée", 300_000, 0.2, false), d("solide", 80_000, 0.7), d("sans-p", 90_000, null)]);
  check("seules les affaires ANNONCÉES et jugées moins solides (p < 50 %)", out.map((x) => x.opportunityId).join() === "gros,petit-sûr");
  check("tri par enjeu = GMV × (1 − p)", Math.round(out[0].stake) === Math.round(157_000 * (1 - 0.058)));
}

section("F5-F7 — fiabilité : backtest, jamais de chiffre inventé");
{
  const R = await import(lib("lib/expected-reliability.ts"));
  const pt = (target, h, predicted, actual, date = `${target}-10`) => ({ date, target, horizonDays: h, predicted, actual });
  const two = [pt("2026-01", 5, 110, 100), pt("2026-02", 5, 90, 100)];
  check("moins de 3 mois cibles : « Données insuffisantes » (null), pas un %", R.reliabilityOf(two).reliability === null);
  const three = [...two, pt("2026-03", 5, 100, 100)];
  check("3 mois : 100 × (1 − WAPE) = 93 %", R.reliabilityOf(three).reliability === 93, String(R.reliabilityOf(three).reliability));
  const daily = [...three, ...Array.from({ length: 20 }, (_, i) => pt("2026-03", 5, 100, 100, `2026-03-${10 + i}`))];
  check("un mois suivi chaque jour ne pèse pas plus qu'un mois hebdomadaire", R.reliabilityOf(daily).reliability === 93);
  const bad = [pt("2026-01", 5, 300, 100), pt("2026-02", 5, 0, 100), pt("2026-03", 5, 400, 100)];
  check("borné à 0 quand l'erreur dépasse le réalisé", R.reliabilityOf(bad).reliability === 0);

  const curve = (vals) => vals.map(([from, to, reliability]) => ({ from, to, reliability, points: 3, months: 3, wape: null }));
  const cM = curve([[0, 7, 95], [8, 14, 80], [15, 21, 70], [22, 31, 60]]);
  const cM1 = curve([[1, 7, 70], [8, 14, 70], [15, 21, 70], [22, 35, 70]]);
  const r = R.daysUntilReliable("2026-09-10", "2026-09", cM, cM1);
  check("mois en cours : 90 % atteint quand il reste ≤ 7 jours (le 23/09)", r?.date === "2026-09-23" && r.days === 13, JSON.stringify(r));
  const r1 = R.daysUntilReliable("2026-09-24", "2026-10", cM, cM1);
  check("mois suivant : passe par la courbe M+1 puis M (le 24/10)", r1?.date === "2026-10-24", JSON.stringify(r1));
  const never = R.daysUntilReliable("2026-09-10", "2026-09", curve([[0, 7, 85], [8, 14, 80], [15, 21, 70], [22, 31, 60]]), cM1);
  check("jamais atteint historiquement -> null, aucune date fictive", never === null);
  const insufficient = R.daysUntilReliable("2026-09-10", "2026-09", curve([[0, 7, null], [8, 14, null], [15, 21, null], [22, 31, null]]), cM1);
  check("courbe sans données -> null", insufficient === null);

  const { buildExpectedReliability } = await import(lib("lib/expected-reliability-view.ts"));
  const v = buildExpectedReliability();
  const m2 = v.horizons.find((h) => h.label === "M+2");
  check("aucun indice global (pas de compensation d'erreurs entre horizons)", !("global" in v));
  check("M+2 : « Pas encore disponible », aucun pourcentage", m2.reliability === null && m2.unavailable === "Pas encore disponible");
  check("état réel : chaque indice publié est entre 0 et 100 ou absent", v.horizons.every((h) => h.reliability === null || (h.reliability >= 0 && h.reliability <= 100)));
  check("état réel : un indice publié repose sur au moins 3 mois", v.horizons.every((h) => h.reliability === null || h.months >= 3));
  check("moins de 12 mois : indicatif ; 12 et plus : mature", v.horizons.every((h) => h.reliability === null || h.mature === h.months >= 12));
  console.log(`  (info) ${v.horizons.map((h) => `${h.label} ${h.reliability ?? h.unavailable}${h.reliability != null ? ` (${h.months} mois${h.mature ? "" : ", indicatif"})` : ""}`).join(" · ")}`);
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);

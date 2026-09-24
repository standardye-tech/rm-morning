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

section("E1 — Forecast : « À challenger » strictement au-delà de 25 %");
{
  const row = (p, kind = "absente_du_mois") => ({ row: { opportunityId: String(p), expectedProbability: p }, kind, reason: "" });
  const out = forecastChallengers({ examine: [row(0.25), row(0.2501), row(0.8), row(0.1), row(0.9, "declaree_fragile"), row(0.3, "prevue_mois_suivant")] });
  const ids = out.map((e) => e.row.opportunityId);
  check("25 % pile : non proposé (strictement supérieur)", !ids.includes("0.25"));
  check("25,01 % : proposé", ids.includes("0.2501"));
  check("déclarée fragile : jamais un challenger Forecast", !out.some((e) => e.kind === "declaree_fragile"));
  check("prévue le mois suivant, 30 % : proposée", ids.includes("0.3"));
  const board = buildForecastV2(0);
  const real = forecastChallengers(board);
  check("état réel : chaque challenger dépasse le seuil", real.every((e) => (e.row.expectedProbability ?? 0) > FORECAST_CHALLENGE.minProbability), `${real.length} challenger(s)`);
}

section("F9-F10 — Expected : challengers > 15 %, articulation avec Forecast");
{
  const { expectedChallengers } = await import(lib("lib/forecast-v2.ts"));
  const row = (id, p, eg, kind = "absente_du_mois") => ({ row: { opportunityId: id, client: id, expectedProbability: p, expectedGmv: eg }, kind, reason: "" });
  const out = expectedChallengers({ examine: [row("a15", 0.15, 50_000), row("b16", 0.16, 50_000), row("c30", 0.3, 20_000), row("d-petit", 0.5, 3_000), row("e-frag", 0.9, 90_000, "declaree_fragile")] });
  const ids = out.map((e) => e.row.opportunityId);
  check("15 % pile : exclu (strictement supérieur)", !ids.includes("a15"));
  check("16 % avec impact crédible : inclus", ids.includes("b16"));
  check("impact sur l'écart trop faible (GMV probable < 4 k€) : exclu", !ids.includes("d-petit"));
  check("déclarée fragile : jamais", !ids.includes("e-frag"));
  check("> 25 % : listée mais marquée « Déjà proposé dans Forecast »", out.find((e) => e.row.opportunityId === "c30")?.inForecast === true && out.find((e) => e.row.opportunityId === "b16")?.inForecast === false);
  const many = expectedChallengers({ examine: Array.from({ length: 11 }, (_, i) => row(`x${i}`, 0.2, 10_000 + i)) });
  check("aucune limite arbitraire : 11 passent -> 11", many.length === 11);
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
  check("M+2 : aucun pourcentage (pas de prévision RM Morning)", m2.reliability === null && /Aucune prévision/.test(m2.unavailable ?? ""));
  check("état réel : chaque indice publié est entre 0 et 100 ou absent", [v.global, ...v.horizons].every((h) => h.reliability === null || (h.reliability >= 0 && h.reliability <= 100)));
  check("état réel : un indice publié repose sur au moins 3 mois", [v.global, ...v.horizons].every((h) => h.reliability === null || h.months >= 3));
  console.log(`  (info) global ${v.global.reliability ?? "—"} · ${v.horizons.map((h) => `${h.label} ${h.reliability ?? h.unavailable}`).join(" · ")}`);
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);

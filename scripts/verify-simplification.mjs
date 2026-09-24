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

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);

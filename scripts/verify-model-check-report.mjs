/**
 * Comptage de `mail:model-check` : les appels annoncés sont les appels envoyés.
 *
 *   npm run mail:model-check-verify
 *
 * Régression du 26/09/2026 : un verdict du modèle écarté au profit des règles
 * revient avec `source: "rules"` ; le script le rangeait parmi les fils « sans
 * appel » et annonçait 18 appels quand le registre en consignait 19.
 *
 * Base TEMPORAIRE, modèle SIMULÉ : aucun appel réseau, aucune clé réelle,
 * aucun contenu d'email (messages anonymisés écrits pour l'occasion).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(path.join(os.tmpdir(), "rm-model-check-"));
process.env.RM_DB_PATH = path.join(tmp, "test.db");
process.env.ANTHROPIC_API_KEY = "cle-factice-de-test";

// Modèle simulé : `verdict` fixe la réponse, `mode = "credit"` simule un refus.
let verdict = "positif_bloque";
let mode = "ok";
globalThis.fetch = async (url) => {
  if (!String(url).includes("api.anthropic.com")) throw new Error("réseau interdit dans ce test");
  if (mode === "credit") {
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 });
  }
  return new Response(
    JSON.stringify({
      content: [{ text: JSON.stringify({ signal_type: verdict, confidence: 0.9, blocker: null, summary: "test", reason: "test", quote: null }) }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    { status: 200 },
  );
};

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { classifyHybrid } = await import(lib("mail-classify-hybrid"));
const { countAnthropicRequests, formatModelCheckReport, newModelCheckTally, tallyReadError, tallyResult } = await import(
  pathToFileURL(path.resolve(process.cwd(), "scripts/model-check-report.mjs")).href
);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
// Fil que les règles jugent « neutre » : il escalade vers le modèle.
const neutral = [{ id: "m1", threadId: "t1", date: "2026-09-20T10:00:00Z", direction: "entrant", subject: "Projet", snippet: "Bonjour, voici quelques informations." }];
// Fil que les règles tranchent seules : aucun appel.
const sure = [{ ...neutral[0], snippet: "Bon pour accord, je signe le devis." }];

section("PIPELINE RÉEL — chaque catégorie séparée, appels = requêtes envoyées");
{
  const anthropic = countAnthropicRequests();
  const tally = newModelCheckTally();
  const results = [];
  const run = async (thread) => {
    const r = await classifyHybrid(thread, { origin: "controle" });
    results.push(r);
    tallyResult(tally, r);
  };
  await run(neutral); // verdict du modèle retenu
  verdict = "signature";
  await run(neutral); // promotion refusée : verdict écarté, appel effectué
  verdict = "positif_bloque";
  mode = "credit";
  await run(neutral); // échec du modèle : repli
  mode = "ok";
  await run(sure); // règles seules
  tallyReadError(tally, Object.assign(new Error("x"), { name: "GaxiosError" }));

  const registry = getDb().prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM ai_usage_daily WHERE origin = 'controle'").get().n;
  check("le cas piège existe bien : verdict écarté renvoyé avec source « rules »", results[1].source === "rules" && results[1].escalated && results[1].clamped);
  check("fils testés 4, erreur de lecture Gmail 1", tally.tested === 4 && tally.readErrors === 1, `${tally.tested}/${tally.readErrors}`);
  check("3 requêtes Anthropic envoyées", anthropic.requests === 3, String(anthropic.requests));
  check("appels annoncés = appels consignés dans le registre", anthropic.requests === registry, `${anthropic.requests} vs ${registry}`);
  check("réponses réussies 2 : 1 retenue, 1 écartée", tally.modelOk === 2 && tally.modelKept === 1 && tally.modelDiscarded === 1, JSON.stringify([tally.modelOk, tally.modelKept, tally.modelDiscarded]));
  check("1 repli après échec du modèle", tally.fallbacks === 1);
  check("1 seul fil sans appel, alors que 2 résultats portent source « rules »", tally.noCall === 1 && results.filter((r) => r.source === "rules").length === 2);
  check("la somme des catégories fait le nombre de fils testés", tally.modelOk + tally.fallbacks + tally.noCall === tally.tested);

  const report = formatModelCheckReport(tally, anthropic.requests).join("\n");
  check("rapport : appels effectués 3", report.includes("appels Anthropic effectués 3"));
  check("rapport : verdict écarté visible", report.includes("verdict écarté au profit des règles 1"));
  check("rapport : sans appel = 1", report.includes("classés sans aucun appel IA 1"));
  check("rapport cohérent : aucune ligne ÉCART", !report.includes("ÉCART"));
  check("rapport : motifs sans contenu (fournisseur/statut, lecture Gmail)", /400 invalid_request_error/.test(report) && report.includes("lecture Gmail : GaxiosError"));
}

section("ÉCART — un comptage incohérent est signalé, jamais masqué");
{
  const t = newModelCheckTally();
  tallyResult(t, { source: "rules", escalated: true, clamped: true, fallbackReason: null });
  check("réponse comptée sans requête envoyée : ÉCART affiché", formatModelCheckReport(t, 0).some((l) => l.startsWith("ÉCART")));
  const k = newModelCheckTally();
  tallyResult(k, { source: "rules_fallback", escalated: true, clamped: false, fallbackReason: "anthropic/x — cle_absente" });
  check("repli sans requête (clé absente) : 0 appel, pas d'écart", !formatModelCheckReport(k, 0).some((l) => l.startsWith("ÉCART")) && k.fallbacks === 1);
}

getDb().close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}`);
process.exit(failures === 0 ? 0 : 1);

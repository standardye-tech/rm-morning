/**
 * Contrôles du registre de consommation IA et du garde-fou de coût
 * (audit coût IA du 24/09/2026).
 *
 *   npm run ia:cout-verify
 *
 * Base TEMPORAIRE, modèle SIMULÉ : aucun appel réseau, aucune clé réelle,
 * aucun contenu d'email (messages anonymisés écrits pour l'occasion).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(path.join(os.tmpdir(), "rm-ia-cout-"));
process.env.RM_DB_PATH = path.join(tmp, "test.db");
process.env.ANTHROPIC_API_KEY = "cle-factice-de-test";

// Modèle simulé : compte les requêtes, renvoie un verdict neutre et un usage fixe.
let calls = 0;
let mode = "ok";
globalThis.fetch = async (url) => {
  if (!String(url).includes("api.anthropic.com")) throw new Error("réseau interdit dans ce test");
  calls += 1;
  if (mode === "credit") {
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 });
  }
  return new Response(
    JSON.stringify({
      content: [{ text: JSON.stringify({ signal_type: "positif_bloque", confidence: 0.7, blocker: null, summary: "test", reason: "test", quote: null }) }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    { status: 200 },
  );
};

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { aiCostUsd, aiUsageSummary, AI_PRICING_USD_PER_MTOK } = await import(lib("ai-usage"));
const { AI_MODEL } = await import(lib("mail-classify-ai"));
const { classifyHybrid, AI_BUDGET_REACHED } = await import(lib("mail-classify-hybrid"));
const { GMAIL_SYNC } = await import(lib("config"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
// Fil anonymisé que les règles jugent « neutre » : il escalade vers le modèle.
const thread = [{ id: "m1", threadId: "t1", date: "2026-09-20T10:00:00Z", direction: "entrant", subject: "Projet", snippet: "Bonjour, voici quelques informations." }];

section("TARIF — un seul endroit, calcul exact");
{
  check("le modèle du scanner a un tarif", Boolean(AI_PRICING_USD_PER_MTOK[AI_MODEL]));
  const c = aiCostUsd(AI_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 });
  check("Haiku 4.5 : 1 $ entrée + 5 $ sortie + 1,25 $ écriture cache + 0,10 $ lecture cache par million", Math.abs(c - 7.35) < 1e-9, String(c));
  check("modèle sans tarif : coût inconnu, jamais zéro", aiCostUsd("modele-inconnu", { inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 }) === null);
}

section("REGISTRE — chaque requête envoyée est comptée, sans contenu");
{
  const r1 = await classifyHybrid(thread, { origin: "synchro" });
  await classifyHybrid(thread, { origin: "synchro" });
  mode = "credit";
  const r3 = await classifyHybrid(thread, { origin: "synchro" });
  mode = "ok";
  const s = aiUsageSummary();
  check("appel réussi : verdict du modèle", r1.source === "model");
  check("crédit épuisé : repli sur les règles", r3.source === "rules_fallback");
  check("3 requêtes envoyées = 3 appels consignés, dont 1 en échec", s.today.calls === 3 && s.today.failures === 1, `${s.today.calls}/${s.today.failures}`);
  check("tokens agrégés : 2 × 1 000 en entrée, 2 × 100 en sortie", s.today.inputTokens === 2000 && s.today.outputTokens === 200);
  check("coût du jour = 2 × (1 000 × 1 $ + 100 × 5 $) / 1 M = 0,003 $", Math.abs(s.today.costUsd - 0.003) < 1e-12, String(s.today.costUsd));
  const cols = getDb().prepare("PRAGMA table_info(ai_usage_daily)").all().map((c) => c.name);
  check("aucune colonne de contenu dans le registre", cols.every((c) => !/subject|snippet|summary|quote|email|body|key|text/.test(c)), cols.join(","));
  const rules = await classifyHybrid([{ ...thread[0], snippet: "Bon pour accord, je signe le devis." }], { origin: "synchro" });
  check("verdict sûr des règles : aucun appel, rien consigné", rules.source === "rules" && aiUsageSummary().today.calls === 3, rules.source);
}

section("GARDE-FOU — budget d'appels par passage");
{
  check("budget de synchro défini", GMAIL_SYNC.maxModelCallsPerRun === 100);
  const before = calls;
  const budget = { remaining: 2 };
  const out = [];
  for (let i = 0; i < 5; i++) out.push(await classifyHybrid(thread, { origin: "synchro" }, budget));
  check("au plus 2 appels avec un budget de 2", calls - before === 2, String(calls - before));
  check("au-delà : règles, motif « budget IA de la synchronisation atteint »", out.slice(2).every((r) => r.source === "rules_fallback" && r.fallbackReason === AI_BUDGET_REACHED && !r.escalated));
  const concurrent = { remaining: 3 };
  const b2 = calls;
  await Promise.all(Array.from({ length: 10 }, () => classifyHybrid(thread, { origin: "synchro" }, concurrent)));
  check("en parallèle, le budget tient : 3 appels pour 10 fils", calls - b2 === 3, String(calls - b2));
}

getDb().close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}`);
process.exit(failures === 0 ? 0 : 1);

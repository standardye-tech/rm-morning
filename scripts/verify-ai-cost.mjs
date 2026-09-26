/**
 * Contrôles du coût IA (audit du 24/09/2026) : registre de consommation,
 * tarif centralisé, plafond d'appels par synchro, délai avec annulation réelle,
 * et état de classification (un message relu n'est pas un message à classer).
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
let aborted = 0;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.anthropic.com")) throw new Error("réseau interdit dans ce test");
  calls += 1;
  if (mode === "hang") {
    // Ne répond jamais ; seule l'annulation réelle (AbortSignal) libère la requête.
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted += 1;
        reject(Object.assign(new Error("requête annulée"), { name: "AbortError" }));
      });
    });
  }
  if (mode === "server") {
    return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 });
  }
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
const { classifyHybrid, AI_BUDGET_REACHED, AI_PROVIDER_HALTED, MODEL_TIMEOUT_MS, newModelBudget } = await import(lib("mail-classify-hybrid"));
const { isAutomaticNotification } = await import(lib("mail-rules"));
const store = await import(lib("mail-store"));
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

section("DÉLAI — annulation réelle de la requête");
{
  mode = "hang";
  const before = aiUsageSummary().today;
  const t0 = Date.now();
  const r = await classifyHybrid(thread, { origin: "synchro" });
  const elapsed = Date.now() - t0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  mode = "ok";
  const after = aiUsageSummary().today;
  check(`repli sur les règles au bout de ${MODEL_TIMEOUT_MS} ms`, r.source === "rules_fallback" && elapsed >= MODEL_TIMEOUT_MS && elapsed < MODEL_TIMEOUT_MS + 2000, `${elapsed} ms`);
  check("motif « timeout » journalisable", /timeout$/.test(r.fallbackReason ?? ""), r.fallbackReason ?? "");
  check("la requête HTTP est réellement annulée (aucun appel orphelin)", aborted === 1, String(aborted));
  check("l'échec est consigné : +1 appel, +1 échec, 0 token", after.calls === before.calls + 1 && after.failures === before.failures + 1 && after.inputTokens === before.inputTokens);
}

section("ÉTAT DE CLASSIFICATION — relu ≠ à classifier");
{
  const db = getDb();
  const sig = (id, thread, at, direction) => ({
    gmailMessageId: id, threadId: thread, sentAt: at, fromEmail: `${thread}@exemple.fr`, fromName: null, subject: "Projet",
    direction, filterRule: "conserve", opportunityId: null, matchLevel: "C", matchReason: "test", salesperson: null, rmTo: [], rmCc: [],
  });
  const since = "2026-09-01T00:00:00Z";
  const pendingIds = () => store.threadsPendingClassification(since).map((p) => p.threadId).sort().join(",");
  const syncId = store.startSync(since, "2026-09-30T00:00:00Z");
  store.insertSignal(sig("a1", "fa", "2026-09-20T10:00:00Z", "entrant"), syncId);
  store.insertSignal(sig("b1", "fb", "2026-09-20T10:00:00Z", "sortant"), syncId);
  store.insertSignal(sig("c1", "fc", "2026-08-01T10:00:00Z", "entrant"), syncId);
  check("message client inséré, pas encore classé : fil en attente", pendingIds() === "fa", pendingIds());
  check("réponse RM seule : jamais en attente", !pendingIds().includes("fb"));
  check("au-delà de la profondeur de reprise : pas repris automatiquement", !pendingIds().includes("fc"));
  const verdict = { signalType: "positif_bloque", confidence: 0.7, blocker: null, summary: "test", classifier: "rules_fallback", quote: null };
  store.updateThreadClassification("fa", verdict, false);
  check("verdict provisoire (repli, budget) : écrit, mais le fil reste en attente", pendingIds() === "fa" && db.prepare("SELECT signal_type FROM mail_signal WHERE gmail_message_id='a1'").get().signal_type === "positif_bloque");
  store.updateThreadClassification("fa", { ...verdict, classifier: AI_MODEL }, true);
  check("verdict définitif : plus rien en attente — une relecture ne coûte plus rien", pendingIds() === "", pendingIds());
  store.insertSignal(sig("a2", "fa", "2026-09-21T10:00:00Z", "sortant"), syncId);
  store.inheritThreadClassification("a2", "fa");
  const a2 = db.prepare("SELECT signal_type, classifier FROM mail_signal WHERE gmail_message_id='a2'").get();
  check("réponse RM : reprend le verdict du fil, sans analyse", a2.signal_type === "positif_bloque" && a2.classifier === AI_MODEL && pendingIds() === "", JSON.stringify(a2));
  store.insertSignal(sig("a3", "fa", "2026-09-22T10:00:00Z", "entrant"), syncId);
  check("nouveau message du client après la réponse RM : fil de nouveau en attente", pendingIds() === "fa", pendingIds());
  store.markThreadAnalyzed("fa");
  check("fil sans verdict possible : marqué analysé, non relu indéfiniment", pendingIds() === "");
}

// Classe des fils comme la synchro : `concurrency` à la fois, même budget.
const classifyAll = async (threads, budget, concurrency = 4) => {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < threads.length) {
        const i = next++;
        out[i] = await classifyHybrid(threads[i], { origin: "synchro" }, budget);
      }
    }),
  );
  return out;
};
const pendingThreads = Array.from({ length: 50 }, (_, i) => [{ ...thread[0], id: `p${i}`, threadId: `tp${i}` }]);

section("COUPE-CIRCUIT — erreur permanente du fournisseur");
{
  mode = "credit";
  const before = calls;
  const budget = newModelBudget(GMAIL_SYNC.maxModelCallsPerRun);
  const out = await classifyAll(pendingThreads, budget);
  mode = "ok";
  const halted = out.filter((r) => r.fallbackReason === AI_PROVIDER_HALTED).length;
  check("crédit insuffisant au 1er fil, 50 fils en attente : 1 seul appel Anthropic", calls - before === 1, String(calls - before));
  check("49 fils en repli sans appel, motif « appels IA suspendus »", halted === 49 && out.every((r) => r.source === "rules_fallback"), String(halted));
  check("motif permanent retenu une fois : crédit, 400 invalid_request_error", /400 invalid_request_error/.test(budget.halted ?? ""), budget.halted ?? "");
  check("le plafond n'est pas consommé par des requêtes vouées à l'échec", budget.remaining === GMAIL_SYNC.maxModelCallsPerRun - 1, String(budget.remaining));
  check("verdicts provisoires : aucun ne pose `analyzed_at` (source rules_fallback)", out.every((r) => r.source === "rules_fallback"));

  const b2 = calls;
  const restored = await classifyAll(pendingThreads, newModelBudget(GMAIL_SYNC.maxModelCallsPerRun));
  check("synchro suivante, fournisseur rétabli : les 50 fils provisoires sont retraités par le modèle", calls - b2 === 50 && restored.every((r) => r.source === "model"), String(calls - b2));

  mode = "server";
  const b3 = calls;
  const transient = await classifyAll(pendingThreads.slice(0, 10), newModelBudget(GMAIL_SYNC.maxModelCallsPerRun));
  mode = "ok";
  check("erreur transitoire (5xx) : pas de coupe-circuit, chaque fil garde sa tentative", calls - b3 === 10 && transient.every((r) => r.fallbackReason !== AI_PROVIDER_HALTED), String(calls - b3));
}

section("NOTIFICATIONS INTERNES — automatique certain vs message humain");
{
  const interne = (subject, snippet) => [{ id: "i1", threadId: "ti", date: "2026-09-20T10:00:00Z", direction: "interne", subject, snippet }];
  check("gabarit Salesforce « Notification piste abandonnée » : automatique", isAutomaticNotification({ direction: "interne", subject: "Notification piste abandonnée" }));
  check("gabarit Salesforce « Notification opportunité perdue » : automatique", isAutomaticNotification({ direction: "interne", subject: "Notification opportunité perdue" }));
  check("« TR: Notification … » transférée par un ET : message humain", !isAutomaticNotification({ direction: "interne", subject: "TR: Notification piste abandonnée" }));
  check("même objet venant d'un client : pas une notification interne", !isAutomaticNotification({ direction: "entrant", subject: "Notification piste abandonnée" }));
  const before = calls;
  const n = await classifyHybrid(interne("Notification opportunité perdue", "Bonjour."), { origin: "synchro" }, newModelBudget(10));
  check("notification automatique : 0 appel, verdict des règles", calls - before === 0 && n.source === "rules" && n.classification.signalType === "negatif", `${calls - before} · ${n.source}`);
  const b2 = calls;
  const h = await classifyHybrid(interne("Re: Rdv téléphonique ce jour", "Bonjour, je te confirme le rendez-vous de cet après-midi."), { origin: "synchro" }, newModelBudget(10));
  check("vrai message interne d'un ET : comportement actuel (escalade vers le modèle)", calls - b2 === 1 && h.source === "model", `${calls - b2} · ${h.source}`);
}

getDb().close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}`);
process.exit(failures === 0 ? 0 : 1);

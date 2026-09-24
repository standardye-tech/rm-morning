/**
 * Retraitement des fils mail récents — après la panne du classifieur modèle
 * (14/09/2026 → crédit API épuisé) et le correctif de la citation client.
 *
 *   npm run mail:reclassify                 DRY-RUN, 14 derniers jours
 *   npm run mail:reclassify -- --days 7     DRY-RUN, 7 jours
 *   npm run mail:reclassify -- --apply      ÉCRIT dans la base configurée
 *   npm run mail:reclassify -- --max-appels 100   plafond d'appels IA (défaut 400)
 *
 * COÛT : le DRY-RUN appelle RÉELLEMENT le modèle (seule la base est copiée).
 * 14 jours ≈ 320 fils ≈ 320 appels au 24/09/2026. Au-delà du plafond, les
 * fils restants sont classés par les règles et le rapport le dit.
 *
 * Pour chaque fil ayant reçu un message client dans la fenêtre : relecture
 * Gmail en LECTURE SEULE puis classification exactement comme la synchro
 * (`classifyThreadForStore`), puis réécriture de la classification du fil
 * (`updateThreadClassification`) et re-triage Morning. Rien n'est écrit dans
 * Gmail. L'état « pris en compte » des messages n'est jamais touché.
 *
 * DRY-RUN par défaut : la base est COPIÉE dans un dossier temporaire et seule la
 * copie est modifiée ; le rapport compare Morning avant / après. IDEMPOTENT :
 * relancer l'opération réécrit la même classification sur les mêmes fils.
 *
 * Aucun contenu d'email n'est affiché : seulement des compteurs.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const days = Number(args[args.indexOf("--days") + 1] ?? NaN) || 14;
const maxCalls = args.includes("--max-appels") ? Number(args[args.indexOf("--max-appels") + 1]) : 400;

const source = path.resolve(process.cwd(), process.env.RM_DB_PATH ?? "data/rm-morning.db");
let tmp = null;
if (!apply) {
  tmp = mkdtempSync(path.join(os.tmpdir(), "rm-reclassify-"));
  const copy = path.join(tmp, "copie.db");
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
  process.env.RM_DB_PATH = copy;
}

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { classifyThreadForStore } = await import(lib("sources/gmail"));
const { updateThreadClassification } = await import(lib("mail-store"));
const { AI_BUDGET_REACHED } = await import(lib("mail-classify-hybrid"));
const ev = await import(lib("morning-events"));

const db = getDb();
const snapshot = () => {
  ev.syncMorningEvents();
  const vis = ev.visibleMorningMessageIds();
  const cats = new Map(db.prepare("SELECT gmail_message_id id, category FROM morning_event").all().map((r) => [r.id, r.category]));
  return { cats, hot: vis.hot, waiting: vis.waiting };
};

const cutoff = new Date(Date.now() - days * 864e5).toISOString();
const threads = db
  .prepare(
    `SELECT m.thread_id, MAX(o.stage) AS stage FROM mail_signal m
       LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id
      WHERE m.direction = 'entrant' AND m.sent_at >= ?
      GROUP BY m.thread_id`,
  )
  .all(cutoff);

const budget = { remaining: maxCalls };
const before = snapshot();
const tally = { threads: threads.length, reclassified: 0, model: 0, rules: 0, rules_fallback: 0, errors: 0, budgetSkipped: 0 };
const reasons = new Map();
for (const t of threads) {
  try {
    const previous = db.prepare("SELECT signal_type, summary, classifier, quote FROM mail_signal WHERE thread_id = ? LIMIT 1").get(t.thread_id);
    const out = await classifyThreadForStore(t.thread_id, t.stage ?? null, "retraitement", budget);
    if (!out) continue;
    tally[out.result.source] += 1;
    if (out.result.fallbackReason === AI_BUDGET_REACHED) tally.budgetSkipped += 1;
    else if (out.result.fallbackReason) reasons.set(out.result.fallbackReason, (reasons.get(out.result.fallbackReason) ?? 0) + 1);
    const s = out.stored;
    if (!previous || previous.signal_type !== s.signalType || previous.summary !== s.summary.slice(0, 200) || previous.classifier !== s.classifier || (previous.quote ?? null) !== (s.quote == null ? null : s.quote.slice(0, 160))) {
      tally.reclassified += 1;
    }
    updateThreadClassification(t.thread_id, s);
  } catch {
    tally.errors += 1;
  }
}
const after = snapshot();

// Ce que Morning MONTRE (Blocs 1 et 2), avant / après.
const shown = (s, id) => (s.hot.has(id) ? "chaud" : s.waiting.has(id) ? "attente" : null);
const ids = new Set([...before.hot, ...before.waiting, ...after.hot, ...after.waiting]);
const moves = { entrent_chaud: 0, entrent_attente: 0, sortent_chaud: 0, sortent_attente: 0, chaud_vers_attente: 0, attente_vers_chaud: 0 };
for (const id of ids) {
  const b = shown(before, id), a = shown(after, id);
  if (b === a) continue;
  if (!b) moves[a === "chaud" ? "entrent_chaud" : "entrent_attente"] += 1;
  else if (!a) moves[b === "chaud" ? "sortent_chaud" : "sortent_attente"] += 1;
  else moves[b === "chaud" ? "chaud_vers_attente" : "attente_vers_chaud"] += 1;
}

console.log(`\n${apply ? "APPLIQUÉ" : "DRY-RUN (copie temporaire, base source intacte)"} — fenêtre ${days} jours`);
console.log(`fils concernés ${tally.threads} | reclassés ${tally.reclassified} | modèle ${tally.model} | repli ${tally.rules_fallback} | règles sûres ${tally.rules} | erreurs ${tally.errors}`);
for (const [r, n] of reasons) console.log(`  motif de repli : ${r} — ${n}`);
console.log(`appels IA envoyés ${maxCalls - budget.remaining} (plafond ${maxCalls})${tally.budgetSkipped ? ` — ${AI_BUDGET_REACHED} : ${tally.budgetSkipped} fil(s) classé(s) par les règles` : ""}`);
console.log(`Morning avant : ${before.hot.size} chaud(s), ${before.waiting.size} attente(s) · après : ${after.hot.size} chaud(s), ${after.waiting.size} attente(s)`);
console.log(`entrent en chaud ${moves.entrent_chaud} | entrent en attente ${moves.entrent_attente} | sortent de chaud ${moves.sortent_chaud} | sortent d'attente ${moves.sortent_attente} | chaud → attente ${moves.chaud_vers_attente} | attente → chaud ${moves.attente_vers_chaud}`);

db.close();
if (tmp) rmSync(tmp, { recursive: true, force: true });

/**
 * Audit des événements Bloc 1 (« chaud ») et Bloc 2 (« attente ») RÉELLEMENT
 * affichés aujourd'hui — sur une COPIE de la base, lecture seule, aucune
 * écriture. Sert à décider où corriger les règles de classification, pas à
 * les corriger lui-même.
 *
 *   npm run morning:waiting-audit
 *
 * Pour chaque événement affiché (non acquitté, et pour l'attente : encore
 * active au sens `awaitingReply`) : expéditeur, date, thread, rattachement
 * Salesforce, propriétaire, raison de classification, présence d'un « ? »,
 * signal_type, âge, réponse sortante plus récente ou non. Regroupe ensuite
 * en familles factuelles et signale les threads à attentes multiples.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "morning-waiting-audit.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { loadMorningEvents } = await import(lib("morning-events"));

const db = getDb();
const nowMs = Date.now();
const HOUR = 36e5;

const { events } = loadMorningEvents();

const signalByMessage = new Map(
  db
    .prepare("SELECT gmail_message_id, subject, summary, signal_type, blocker, direction FROM mail_signal")
    .all()
    .map((r) => [r.gmail_message_id, r]),
);

function hasQuestionMark(e) {
  const sig = signalByMessage.get(e.messageId);
  return `${sig?.subject ?? ""} ${sig?.summary ?? ""}`.includes("?");
}

function ageHours(sentAt) {
  if (!sentAt) return null;
  return Math.round((nowMs - new Date(sentAt).getTime()) / HOUR);
}

function laterInboundInThread(threadId, sentAt) {
  if (!sentAt) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM mail_signal WHERE thread_id = ? AND direction = 'entrant' AND sent_at > ? LIMIT 1`,
    )
    .get(threadId, sentAt);
  return Boolean(row);
}

function laterOutboundInThread(threadId, sentAt) {
  if (!sentAt) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM mail_signal WHERE thread_id = ? AND direction = 'sortant' AND sent_at > ? LIMIT 1`,
    )
    .get(threadId, sentAt);
  return Boolean(row);
}

// --- Familles factuelles (classement DESCRIPTIF, aucune règle changée) -----

function classifyFamily(e, sig) {
  const text = `${sig?.subject ?? ""} ${sig?.summary ?? ""}`.toLowerCase();
  const reason = (e.reason ?? "").toLowerCase();
  const q = hasQuestionMark(e);

  if (/merci|bien recu|bien reçu|accuse|accusé/.test(text) && !q) return "remerciement / accusé de réception";
  if (/voici|ci-joint|veuillez trouver|vous trouverez|transmet|transmis|en pièce jointe/.test(text) && !q) return "simple transmission";
  if (/attestation|urssaf|kbis|facture|rib|tva|comptable|vigilance/.test(text)) return "administratif";
  if (/dispon|creneau|créneau|rendez-vous|rdv|mardi|mercredi|jeudi|lundi|vendredi/.test(text) && reason.includes("créneau")) return "proposition de créneau";
  if (/document|attestation|justificatif|corrig|modif|ajust|rectifi/.test(text) && reason.includes("document")) return "demande de document/action";
  if (q) return "vraie question client nécessitant réponse";
  if (reason.includes("difficulté") || reason.includes("relance")) return "relance / difficulté signalée";
  return "autre / à qualifier";
}

function printSection(title) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

// ============================================================================
// Bloc 2 — attente affichée aujourd'hui (non acquittée, active)
// ============================================================================

const waitingDisplayed = events.filter((e) => e.category === "attente" && e.awaitingReply && !e.acknowledged);

printSection(`BLOC 2 — ${waitingDisplayed.length} attente(s) affichée(s) aujourd'hui`);

const rows = waitingDisplayed.map((e) => {
  const sig = signalByMessage.get(e.messageId);
  return {
    messageId: e.messageId,
    threadId: e.threadId,
    from: e.fromEmail,
    sentAt: e.sentAt,
    ageH: ageHours(e.sentAt),
    matchKind: e.matchKind,
    attachment: e.attachment,
    opportunityId: e.opportunityId,
    leadId: e.leadId,
    salesperson: e.salesperson,
    reason: e.reason,
    said: e.said,
    hasQuestion: hasQuestionMark(e),
    signalType: sig?.signal_type ?? null,
    blocker: sig?.blocker ?? null,
    laterInbound: laterInboundInThread(e.threadId, e.sentAt),
    laterOutbound: laterOutboundInThread(e.threadId, e.sentAt),
    family: classifyFamily(e, sig),
  };
});

for (const r of rows) {
  console.log(
    `\n[${r.messageId.slice(0, 12)}…] ${r.from ?? "?"} · ${r.sentAt ?? "?"} (${r.ageH ?? "?"} h) · fil ${r.threadId.slice(0, 10)}…`,
  );
  console.log(
    `  Salesforce: ${r.matchKind} (${r.attachment})${r.opportunityId ? ` opp=${r.opportunityId}` : ""}${r.leadId ? ` lead=${r.leadId}` : ""} · propriétaire=${r.salesperson ?? "?"}`,
  );
  console.log(`  raison="${r.reason}" · dit="${(r.said ?? "").slice(0, 90)}"`);
  console.log(
    `  « ? »=${r.hasQuestion} · signal_type=${r.signalType ?? "?"} · blocage=${r.blocker ?? "—"} · autre message ENTRANT plus récent dans le fil=${r.laterInbound} · réponse SORTANTE plus récente=${r.laterOutbound}`,
  );
  console.log(`  famille => ${r.family}`);
}

printSection("BLOC 2 — distribution par famille");
const byFamily = new Map();
for (const r of rows) byFamily.set(r.family, (byFamily.get(r.family) ?? 0) + 1);
for (const [family, count] of [...byFamily.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${family}`);
}

printSection("BLOC 2 — threads avec plusieurs attentes affichées simultanément");
const byThread = new Map();
for (const r of rows) {
  const list = byThread.get(r.threadId) ?? [];
  list.push(r);
  byThread.set(r.threadId, list);
}
const multi = [...byThread.entries()].filter(([, list]) => list.length > 1);
console.log(`  ${multi.length} thread(s) avec ${multi.reduce((s, [, l]) => s + l.length, 0)} événement(s) au total`);
for (const [threadId, list] of multi) {
  console.log(`\n  fil ${threadId} — ${list.length} attente(s) affichée(s) :`);
  for (const r of list.sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""))) {
    console.log(`    - ${r.sentAt} (${r.ageH} h) : "${(r.said ?? "").slice(0, 70)}"`);
  }
}

printSection("BLOC 2 — sans rattachement Salesforce de confiance (niveau C / à vérifier)");
const unreliable = rows.filter((r) => r.attachment === "a_verifier");
console.log(`  ${unreliable.length} / ${rows.length}`);

printSection("BLOC 2 — sans point d'interrogation (formulation implicite)");
const noQuestion = rows.filter((r) => !r.hasQuestion);
console.log(`  ${noQuestion.length} / ${rows.length}`);
for (const r of noQuestion) {
  console.log(`    - [${r.family}] "${(r.said ?? "").slice(0, 80)}" (raison: ${r.reason})`);
}

// ============================================================================
// Bloc 1 — chaud affiché aujourd'hui
// ============================================================================

const hotDisplayed = events.filter((e) => e.category === "chaud" && !e.acknowledged && e.isLatestHotInThread);
printSection(`BLOC 1 — ${hotDisplayed.length} chaud(s) affiché(s) aujourd'hui`);

const hotByReason = new Map();
for (const e of hotDisplayed) hotByReason.set(e.reason, (hotByReason.get(e.reason) ?? 0) + 1);
console.log("Distribution par raison :");
for (const [reason, count] of [...hotByReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${reason}`);
}

const hotOpportunities = new Set(hotDisplayed.map((e) => e.opportunityId).filter(Boolean));
const hotThreads = new Set(hotDisplayed.map((e) => e.threadId));
console.log(`\nOpportunités distinctes : ${hotOpportunities.size} (pour ${hotDisplayed.length} événements)`);
console.log(`Threads distincts : ${hotThreads.size} (pour ${hotDisplayed.length} événements)`);

const hotByThread = new Map();
for (const e of hotDisplayed) {
  const list = hotByThread.get(e.threadId) ?? [];
  list.push(e);
  hotByThread.set(e.threadId, list);
}
const hotMulti = [...hotByThread.entries()].filter(([, list]) => list.length > 1);
console.log(`Threads avec plusieurs événements « chaud » : ${hotMulti.length}`);
for (const [threadId, list] of hotMulti) {
  console.log(`  fil ${threadId} — ${list.length} événement(s) : ${list.map((e) => e.reason).join(" | ")}`);
}

// ============================================================================
// Synthèse
// ============================================================================

printSection("SYNTHÈSE");
console.log(`Bloc 1 (chaud) affiché : ${hotDisplayed.length} — ${hotOpportunities.size} opportunité(s) distincte(s), ${hotThreads.size} thread(s) distinct(s)`);
console.log(`Bloc 2 (attente) affiché : ${rows.length} — threads distincts : ${byThread.size}`);
console.log(`Threads à attentes multiples : ${multi.length} (${multi.reduce((s, [, l]) => s + l.length, 0)} événements concernés)`);
console.log(`Sans rattachement fiable (à vérifier) : ${unreliable.length}`);
console.log(`Sans point d'interrogation : ${noQuestion.length}`);

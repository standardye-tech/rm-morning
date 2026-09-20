/**
 * Contrôles G : « Tout traiter » du Plan du jour, et synchronisation
 * Bloc 1/2 → Plan du jour (traitement individuel, global, reload, et
 * changement du filtre de fraîcheur `awaitingReply` introduit en F).
 *
 *   npm run morning:plan-sync-verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : fixtures d'opportunités, signaux mail et
 * événements Morning ; acquitte et coche des actions, comme le ferait
 * l'utilisateur. Jamais sur les données réelles.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "morning-plan-sync.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage, acknowledgeEvent, acknowledgeAllEvents, completeShownActions } = await import(lib("morning-events"));
const { buildMorningPlan } = await import(lib("morning-priority"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const nowMs = Date.now();
const HOUR = 36e5;
const hoursAgo = (h) => new Date(nowMs - h * HOUR).toISOString();
const today = new Date(nowMs).toISOString().slice(0, 10);

const PIPE = { match_kind: "affaire_pipe", opportunity_stage: null, lead_status: null, stage: "Examen devis", is_terminal: 0, owner: null, ext_owner: null, lead_owner: null, rm_to: null, rm_cc: null };

const cleanup = { opportunities: [], messages: [] };

function insertOpportunity(id, owner = "Commercial Test G") {
  db.prepare(
    `INSERT INTO opportunity
       (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
        milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
     VALUES (?, ?, ?, 60000, 'Examen devis', 0, 0, 0, 1, 'normal', 0, 0, 0, ?, 0)`,
  ).run(id, `Client ${id}`, owner, today);
  cleanup.opportunities.push(id);
}

function insertMailSignal({ id, threadId, opportunityId, sentAt, direction, matchLevel = "A", summary = null, subject = "Devis" }) {
  db.prepare(
    `INSERT INTO mail_signal
       (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
        filter_rule, opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
     VALUES (?, ?, ?, 'client@example.com', 'Client Test', ?, ?, 'conserve', ?, ?, 'test', 'Commercial Test G', 'neutre', ?, 0)`,
  ).run(id, threadId, sentAt, subject, direction, opportunityId, matchLevel, summary);
  cleanup.messages.push(id);
}

function insertMorningEvent({ id, threadId, sentAt, category, reason }) {
  db.prepare(
    `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)`,
  ).run(id, threadId, sentAt, category, reason, new Date(nowMs).toISOString());
}

function actionFor(plan, messageId) {
  return plan.actions.find((a) => a.messageId === messageId);
}

// ============================================================================
// 1 — Traitement INDIVIDUEL d'un événement chaud retire son action du Plan
// ============================================================================

section("1 — Traitement individuel Bloc 1 (chaud) => l'action correspondante quitte le Plan");

const OPP_G1 = "TESTG_OPP1";
const MSG_G1 = "TESTG_MSG1";
const THREAD_G1 = "TESTG_THREAD1";
insertOpportunity(OPP_G1);
const tG1 = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Le devis nous convient. Comment lance-t-on les travaux ?", blocker: null, signal_type: "neutre" });
check("classé chaud par le triage", tG1.category === "chaud", tG1.category);
insertMailSignal({ id: MSG_G1, threadId: THREAD_G1, opportunityId: OPP_G1, sentAt: hoursAgo(2), direction: "entrant", summary: "Le devis nous convient. Comment lance-t-on les travaux ?" });
insertMorningEvent({ id: MSG_G1, threadId: THREAD_G1, sentAt: hoursAgo(2), category: tG1.category, reason: tG1.reason });

const planG1Before = buildMorningPlan();
const actionG1Before = actionFor(planG1Before, MSG_G1);
check("l'action « client_motive » apparaît dans le Plan", actionG1Before?.reason === "client_motive", JSON.stringify(actionG1Before?.key));

acknowledgeEvent(MSG_G1);
const planG1After = buildMorningPlan();
check("l'action a disparu du Plan après acquittement individuel", actionFor(planG1After, MSG_G1) === undefined);

const planG1Reload = buildMorningPlan();
check("reload : l'action reste absente", actionFor(planG1Reload, MSG_G1) === undefined);

// ============================================================================
// 2 — Traitement GLOBAL (Bloc 2, "Tout traiter") retire les actions du Plan
// ============================================================================

section("2 — Traitement global Bloc 2 (attente) => les actions correspondantes quittent le Plan");

const OPP_G2 = "TESTG_OPP2";
const MSG_G2 = "TESTG_MSG2";
const THREAD_G2 = "TESTG_THREAD2";
insertOpportunity(OPP_G2);
const tG2 = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Pouvez-vous me confirmer la reception des documents ?", blocker: null, signal_type: "neutre" });
check("classé attente par le triage", tG2.category === "attente", tG2.category);
insertMailSignal({ id: MSG_G2, threadId: THREAD_G2, opportunityId: OPP_G2, sentAt: hoursAgo(3), direction: "entrant", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG_G2, threadId: THREAD_G2, sentAt: hoursAgo(3), category: tG2.category, reason: tG2.reason });

const planG2Before = buildMorningPlan();
const actionG2Before = actionFor(planG2Before, MSG_G2);
check("l'action « client_attend » apparaît dans le Plan", actionG2Before?.reason === "client_attend", JSON.stringify(actionG2Before?.key));

acknowledgeAllEvents("attente");
const planG2After = buildMorningPlan();
check("l'action a disparu du Plan après « Tout traiter » Bloc 2", actionFor(planG2After, MSG_G2) === undefined);

const planG2Reload = buildMorningPlan();
check("reload : l'action reste absente", actionFor(planG2Reload, MSG_G2) === undefined);

// ============================================================================
// 3 — Changement du filtre awaitingReply (F) => l'action du Plan disparaît
//     SANS acquittement manuel du message
// ============================================================================

section("3 — Réponse RM (fraîcheur du fil) => l'action du Plan disparaît sans geste manuel");

const OPP_G3 = "TESTG_OPP3";
const MSG_G3 = "TESTG_MSG3";
const THREAD_G3 = "TESTG_THREAD3";
insertOpportunity(OPP_G3);
const tG3 = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Pouvez-vous modifier le devis et me le renvoyer ?", blocker: null, signal_type: "neutre" });
insertMailSignal({ id: MSG_G3, threadId: THREAD_G3, opportunityId: OPP_G3, sentAt: hoursAgo(4), direction: "entrant", summary: "Pouvez-vous modifier le devis et me le renvoyer ?" });
insertMorningEvent({ id: MSG_G3, threadId: THREAD_G3, sentAt: hoursAgo(4), category: tG3.category, reason: tG3.reason });

const planG3Before = buildMorningPlan();
check("l'action « client_attend » apparaît dans le Plan avant réponse", actionFor(planG3Before, MSG_G3)?.reason === "client_attend");

// Une réponse RM synchronisée, SANS jamais appeler acknowledgeEvent : le
// message n'est pas « traité » par un geste utilisateur, seul le fil a changé.
const MSG_G3_REPLY = "TESTG_MSG3_REPLY";
insertMailSignal({ id: MSG_G3_REPLY, threadId: THREAD_G3, opportunityId: OPP_G3, sentAt: hoursAgo(0.5), direction: "sortant", subject: "Re: Devis" });

const planG3After = buildMorningPlan();
check("l'action a disparu du Plan, bien qu'aucun geste manuel n'ait été fait", actionFor(planG3After, MSG_G3) === undefined);

// ============================================================================
// 4 — « Tout traiter » du Plan du jour lui-même
// ============================================================================

section("4 — « Tout traiter » du Plan du jour : toutes les actions visibles disparaissent");

const OPP_G4 = "TESTG_OPP4";
const MSG_G4 = "TESTG_MSG4";
const THREAD_G4 = "TESTG_THREAD4";
insertOpportunity(OPP_G4);
const tG4 = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Nous souhaitons avancer, quelle est la prochaine etape ?", blocker: null, signal_type: "neutre" });
insertMailSignal({ id: MSG_G4, threadId: THREAD_G4, opportunityId: OPP_G4, sentAt: hoursAgo(1), direction: "entrant", summary: "Nous souhaitons avancer, quelle est la prochaine etape ?" });
insertMorningEvent({ id: MSG_G4, threadId: THREAD_G4, sentAt: hoursAgo(1), category: tG4.category, reason: tG4.reason });

const planBeforeAll = buildMorningPlan();
check("au moins une action visible avant « Tout traiter »", planBeforeAll.actions.length > 0, `${planBeforeAll.actions.length} action(s)`);
const keysBefore = planBeforeAll.actions.map((a) => a.key);

// Exactement la route « tout_faire » : recalcul serveur, restreint aux clés que
// l'écran affiche, puis double effet de « action_faite » pour chacune.
const changed = completeShownActions(planBeforeAll.actions, new Set(keysBefore));
check("toutes les actions affichées ont été marquées faites", changed === keysBefore.length, `${changed}/${keysBefore.length}`);

const planAfterAll = buildMorningPlan();
check("le Plan du jour est vide juste après « Tout traiter »", planAfterAll.actions.length === 0, `${planAfterAll.actions.length} restante(s)`);
// Plan V2 : « Tout traiter » ne touche QUE les situations affichées. Les mails
// des situations traitées sont acquittés (Blocs 1 et 2 vidés de ceux-là) ; les
// autres messages ouverts, qui n'étaient pas dans le Plan, restent.
const treatedMessages = new Set(planBeforeAll.actions.map((a) => a.messageId).filter(Boolean));
const stillOpen = [...planAfterAll.hot, ...planAfterAll.waiting].filter((e) => treatedMessages.has(e.messageId));
check("les messages des situations traitées sont acquittés (Blocs 1/2 vidés de ceux-là)", stillOpen.length === 0, `${treatedMessages.size} message(s) traité(s)`);

const planReloadAll = buildMorningPlan();
check("reload : toujours vide, état persistant", planReloadAll.actions.length === 0);
check("reload : rien n'est recréé artificiellement le même jour", planReloadAll.doneToday === planAfterAll.doneToday, `${planReloadAll.doneToday} vs ${planAfterAll.doneToday}`);

// --- Nettoyage ---------------------------------------------------------------

if (cleanup.opportunities.length > 0) {
  const ph = cleanup.opportunities.map(() => "?").join(",");
  db.prepare(`DELETE FROM opportunity WHERE opportunity_id IN (${ph})`).run(...cleanup.opportunities);
}
if (cleanup.messages.length > 0) {
  const ph = cleanup.messages.map(() => "?").join(",");
  db.prepare(`DELETE FROM mail_signal WHERE gmail_message_id IN (${ph})`).run(...cleanup.messages);
  db.prepare(`DELETE FROM morning_event WHERE gmail_message_id IN (${ph})`).run(...cleanup.messages);
}
db.prepare("DELETE FROM morning_action_done WHERE done_on = ? AND action_key LIKE ?").run(today, "%TESTG_MSG%");

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

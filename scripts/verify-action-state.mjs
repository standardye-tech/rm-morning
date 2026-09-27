/**
 * Contrôles de l'état d'action UNIQUE entre Morning, Monitoring et Ma semaine.
 *
 *   npm run actions:verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE (data/verif/action-state.db) : affaires,
 * pistes, messages et gestes fictifs, jamais les données réelles.
 *
 * Doctrine vérifiée : une action métier = une ActionKey = un seul état
 * utilisateur (`action-state`). Traiter sur une surface ferme l'action partout
 * où la MÊME clé apparaît ; une autre action de la même affaire reste ouverte ;
 * « Lu » n'est jamais « Traité » ; un nouvel événement ouvre une nouvelle clé ;
 * Rétablir rouvre partout où le signal existe encore, sans rien recréer.
 *
 * Tests A à M de la demande. Aucune action n'est, par construction, commune aux
 * TROIS surfaces (le Monitoring porte des anomalies de jalon et des attentes
 * client, le Plan et Ma semaine des motifs d'atterrissage) : A, B et C sont donc
 * joués sur les paires réelles — Monitoring ↔ Bloc 2 (même message) et Plan ↔
 * Ma semaine (même motif) — en vérifiant à chaque fois que l'autre surface garde
 * son action distincte sur la même affaire.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "action-state.db");
mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(WORK + suffix, { force: true });
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { parisDate } = await import(lib("business-time"));
const { ATTENTION } = await import(lib("config"));
const keys = await import(lib("action-keys"));
const { treatAction, restoreAction, treatedActions } = await import(lib("action-state"));
const { triage, markActionDone, completeShownActions } = await import(lib("morning-events"));
const { buildMorningPlan } = await import(lib("morning-priority"));
const { leadMonitoringView, opportunityMonitoringView, markItemRead, markScopeRead, treatItem, monitoringUnreadCounts } =
  await import(lib("monitoring-view"));
const { loadMilestoneOpportunities } = await import(lib("opportunity-metrics"));
const { loadTeam } = await import(lib("team-store"));
const { buildWeekAgenda, withSharedState } = await import(lib("week-agenda-view"));
const { composeCards, hideTreated, scheduleCards } = await import(lib("week-agenda"));
const { checkAgendaTask, restoreAgendaTask, loadAgendaState } = await import(lib("week-agenda-store"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const nowMs = Date.now();
const HOUR = 36e5;
const DAY = 24 * HOUR;
const now = new Date(nowMs);
const today = parisDate(now);
const hoursAgo = (h) => new Date(nowMs - h * HOUR).toISOString();
const dayOffset = (n) => parisDate(new Date(nowMs + n * DAY));
const ALL = 1e9;

// Base de référence : aucun geste préalable sur la copie.
db.prepare("DELETE FROM action_state").run();
db.prepare("DELETE FROM morning_action_done").run();

const owner = loadTeam().find((m) => !ATTENTION.excluded.includes(m.name))?.name;
if (!owner) throw new Error("Aucun commercial dans l'équipe : contrôle impossible.");

// --- Fixtures ----------------------------------------------------------------

function insertOpportunity({ id, gmv, status = "normal", standbyUntil = null, kanban = true }) {
  db.prepare(
    `INSERT INTO opportunity
       (opportunity_id, name, client_contact, owner, gmv, stage, kanban_month, kanban_year, last_activity_at,
        is_signed, is_terminal, is_standby, is_active, standby_until,
        milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
     VALUES (?, ?, ?, ?, ?, 'Examen devis', ?, ?, ?, 0, 0, 0, 1, ?, ?, 0, 0, 0, ?, 0)`,
  ).run(
    id, `Client ${id}`, `Client ${id}`, owner, gmv,
    kanban ? Number(today.slice(5, 7)) : null, kanban ? Number(today.slice(0, 4)) : null,
    new Date(nowMs - 40 * DAY).toISOString().slice(0, 10), standbyUntil, status, today,
  );
}
function stall(id) {
  for (const date of [dayOffset(-25), today]) {
    db.prepare(
      `INSERT OR REPLACE INTO opportunity_snapshot
         (snapshot_date, opportunity_id, import_id, owner, gmv, stage, is_standby, is_signed, is_active)
       VALUES (?, ?, 0, ?, 300000, 'Examen devis', 0, 0, 1)`,
    ).run(date, id, owner);
  }
}
function insertMessage({ id, thread, opportunityId, sentAt, direction = "entrant", summary }) {
  db.prepare(
    `INSERT INTO mail_signal
       (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction, filter_rule,
        opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
     VALUES (?, ?, ?, ?, 'Client Test', 'Devis', ?, 'conserve', ?, 'A', 'test', ?, 'neutre', ?, 0)`,
  ).run(id, thread, sentAt, `${thread}@example.com`, direction, opportunityId, owner, summary);
  if (direction !== "entrant") return null;
  const t = triage({
    match_kind: "affaire_pipe", opportunity_stage: null, lead_status: null, stage: "Examen devis", is_terminal: 0,
    owner: null, ext_owner: null, lead_owner: null, rm_to: null, rm_cc: null,
    direction, subject: "Devis", summary, blocker: null, signal_type: "neutre",
  });
  db.prepare(
    `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 'A', 'nouveau', NULL, ?)`,
  ).run(id, thread, sentAt, t.category, t.reason, opportunityId, new Date(nowMs).toISOString());
  return t.category;
}
function insertLead(id, status = "a_traiter", recall = dayOffset(-3)) {
  db.prepare(
    `INSERT INTO lead
       (lead_id, name, owner, owner_raw, status, created_at, recall_date, operational_status,
        lateness_hours, first_call_missed, is_legacy, first_seen_on, last_import_id)
     VALUES (?, ?, ?, ?, 'A confirmer', ?, ?, ?, 72, 0, 0, ?, 0)`,
  ).run(id, `Piste ${id}`, owner, owner, now.toISOString(), recall, status, today);
}

// --- Surfaces ----------------------------------------------------------------

const plan = () => buildMorningPlan(now);
const inPlan = (key) => plan().actions.some((a) => a.key === key);
const inBloc2 = (msg) => plan().waiting.some((e) => e.messageId === msg);
const monOpp = () => {
  const v = opportunityMonitoringView(null, ALL, ALL);
  return new Set([...v.items.map((i) => i.opportunity.opportunityId), ...v.exceptions.map((e) => e.opportunity.opportunityId)]);
};
const inMonitoring = (id) => monOpp().has(id);
const inLeads = (id) => leadMonitoringView(null, ALL).items.some((i) => i.lead.leadId === id);
const week = () => buildWeekAgenda(now);
const weekTask = (actionKey) => {
  const v = week();
  const cards = [...v.timeline, ...v.toPlace];
  const task = cards.flatMap((c) => c.tasks).find((t) => t.actionKey === actionKey);
  const done = v.done.find((d) => d.actionKey === actionKey);
  return { active: !!task && !v.doneKeys.includes(task.key), done, task, weekStart: v.weekStart };
};
const treatedCount = () => db.prepare("SELECT COUNT(*) n FROM action_state WHERE status = 'traite'").get().n;
const ackCount = () => db.prepare("SELECT COUNT(*) n FROM morning_event WHERE status = 'pris_en_compte'").get().n;

// L'affaire commune : candidate du Plan (grosse, annoncée sur M, immobile) ET
// client en attente d'une réponse (Bloc 2 + Monitoring « client attend »).
const OPP = "TESTAS_OPP";
const MSG1 = "TESTAS_MSG1";
const THREAD = "TESTAS_THREAD";
insertOpportunity({ id: OPP, gmv: 1_500_000 });
stall(OPP);
const cat1 = insertMessage({ id: MSG1, thread: THREAD, opportunityId: OPP, sentAt: hoursAgo(5), summary: "Pouvez-vous me confirmer la reception des documents ?" });
const mailKey1 = keys.mailActionKey(MSG1, "attente");

section("0 — Mise en place : une même affaire, deux actions distinctes");
const p0 = plan();
const planAction = p0.actions.find((a) => a.opportunityId === OPP);
const planKey = planAction?.key;
check("le message est une attente (vrai triage du Morning)", cat1 === "attente", cat1);
check("action 1 — Plan du jour : l'affaire y est, clé plan:…", !!planAction && planKey.startsWith(`plan:${OPP}:`), planKey);
check("action 2 — Bloc 2 : le message y est", inBloc2(MSG1));
check("… et Monitoring opportunités montre « client attend » pour le même message", findOpp()?.waitingMessageId === MSG1 && inMonitoring(OPP));
check("… sous la clé du Bloc 2 (mail:…:waiting_reply)", keys.opportunityActionKey(findOpp()) === mailKey1, keys.opportunityActionKey(findOpp()));
const wt0 = weekTask(planKey);
check("action 1 — Ma semaine : une tâche porte la MÊME ActionKey que le Plan", wt0.active && wt0.task?.source === "plan", wt0.task?.key);
check("les deux actions de l'affaire ont des clés différentes", planKey !== mailKey1);
function findOpp() {
  return loadMilestoneOpportunities().find((o) => o.opportunityId === OPP);
}

section("A — Traité dans Monitoring (client attend = Bloc 2)");
treatItem("opportunite", OPP, now);
check("A. disparaît du Monitoring", !inMonitoring(OPP));
check("A. disparaît du Bloc 2 (même message, même action)", !inBloc2(MSG1));
check("E. l'autre action de la même affaire reste : Plan", inPlan(planKey));
check("E. … et Ma semaine", weekTask(planKey).active);
check("8. réalité intacte : le client attend toujours (aucune réponse RM)", findOpp()?.clientWaiting === true);
check("… et aucun message n'a été écrit dans Gmail ni l'opportunité modifiée", db.prepare("SELECT client_waiting FROM opportunity WHERE opportunity_id = ?").get(OPP).client_waiting === 0);
restoreAction(mailKey1, now);
check("K. Rétablir : l'attente revient dans le Bloc 2 et le Monitoring", inBloc2(MSG1) && inMonitoring(OPP));

section("B — Traité dans le Plan du jour");
markActionDone(planKey, now);
check("B. disparaît du Plan", !inPlan(planKey));
const wtB = weekTask(planKey);
check("B. disparaît de Ma semaine (tâche terminée, dans « Terminés »)", !wtB.active && !!wtB.done, wtB.done?.label);
check("E. l'autre action reste : Bloc 2 et Monitoring", inBloc2(MSG1) && inMonitoring(OPP));

section("K — Rétablir depuis « Terminés cette semaine »");
restoreAgendaTask(wtB.weekStart, wtB.done);
check("K. l'action est rouverte : de retour dans le Plan", inPlan(planKey));
check("K. … et active dans Ma semaine", weekTask(planKey).active);

section("C — Cochée dans Ma semaine");
const wtC = weekTask(planKey);
checkAgendaTask(wtC.weekStart, wtC.task, now);
check("C. disparaît du Plan du jour", !inPlan(planKey));
check("C. terminée dans Ma semaine", !weekTask(planKey).active);
check("C. aucune écriture hebdomadaire locale pour un sujet partagé", !loadAgendaState(wtC.weekStart).done.some((d) => d.key === wtC.task.key));
check("E. l'autre action reste : Bloc 2 et Monitoring", inBloc2(MSG1) && inMonitoring(OPP));
restoreAgendaTask(wtC.weekStart, weekTask(planKey).done);
check("K. rétablie : de retour dans le Plan et Ma semaine", inPlan(planKey) && weekTask(planKey).active);

section("F / G — Lire n'est jamais traiter");
{
  const t0 = treatedCount();
  const a0 = ackCount();
  markItemRead("opportunite", OPP, now);
  check("F. « Lu » : aucune action fermée (état partagé inchangé)", treatedCount() === t0 && ackCount() === a0);
  check("F. … l'attente reste dans le Bloc 2, le Plan intact", inBloc2(MSG1) && inPlan(planKey));
  check("F. … la ligne quitte le Monitoring comme lue, pas comme traitée", !inMonitoring(OPP) && treatedActions([mailKey1]).size === 0);
  markScopeRead("opportunite", null, now);
  markScopeRead("piste", null, now);
  check("G. « Tout lire » (pistes et opportunités) : aucune action traitée", treatedCount() === t0 && ackCount() === a0);
  check("G. … Bloc 2 et Plan inchangés", inBloc2(MSG1) && inPlan(planKey));
  db.prepare("DELETE FROM monitoring_read").run();
}

section("H — « Tout traiter » du Plan : uniquement les ActionKeys affichées");
{
  const OPP2 = "TESTAS_OPP2";
  insertOpportunity({ id: OPP2, gmv: 1_400_000 });
  stall(OPP2);
  const p = plan();
  const other = p.actions.find((a) => a.opportunityId === OPP2);
  check("une seconde affaire est dans le Plan", !!other);
  completeShownActions(p.actions, new Set([other?.key]), now);
  check("H. l'action affichée et envoyée est traitée", !inPlan(other?.key) && treatedActions([other?.key]).size === 1);
  check("H. les autres actions du Plan ne le sont pas", inPlan(planKey) && treatedActions([planKey]).size === 0);
  check("H. aucune action d'un autre type n'est touchée (Bloc 2)", inBloc2(MSG1));
  restoreAction(other.key, now);
}

section("I — Nouvelle relance client après une action traitée");
{
  treatAction({ key: mailKey1, surface: "morning_bloc2" }, now);
  check("l'ancienne attente est traitée partout", !inBloc2(MSG1) && !inMonitoring(OPP));
  const MSG2 = "TESTAS_MSG2";
  insertMessage({ id: MSG2, thread: THREAD, opportunityId: OPP, sentAt: hoursAgo(1), summary: "Pouvez-vous me renvoyer le devis signe ?" });
  const mailKey2 = keys.mailActionKey(MSG2, "attente");
  check("I. nouvelle ActionKey, ouverte", mailKey2 !== mailKey1 && treatedActions([mailKey2]).size === 0);
  check("I. la nouvelle demande réapparaît dans le Bloc 2", inBloc2(MSG2));
  check("I. … et dans le Monitoring, sous la nouvelle clé", inMonitoring(OPP) && keys.opportunityActionKey(findOpp()) === mailKey2);

  section("K bis — Rétablir ne recrée pas un signal disparu");
  treatAction({ key: mailKey2, surface: "morning_bloc2" }, now);
  insertMessage({ id: "TESTAS_REPLY", thread: THREAD, opportunityId: OPP, sentAt: hoursAgo(0.5), direction: "sortant", summary: "Voici le devis" });
  restoreAction(mailKey2, now);
  check("K bis. RM a répondu : l'attente rétablie ne revient ni dans le Bloc 2…", !inBloc2(MSG2));
  check("K bis. … ni en « client attend » dans le Monitoring", findOpp()?.clientWaiting === false);
}

section("J — Nouvelle anomalie Salesforce après une anomalie traitée");
{
  const OPPJ = "TESTAS_OPPJ";
  insertOpportunity({ id: OPPJ, gmv: 60_000, status: "standby_expire", standbyUntil: dayOffset(-10), kanban: false });
  check("l'anomalie est dans le Monitoring", inMonitoring(OPPJ));
  treatItem("opportunite", OPPJ, now);
  check("traitée : elle disparaît", !inMonitoring(OPPJ));
  check("… la donnée Salesforce reste une anomalie", db.prepare("SELECT milestone_status s FROM opportunity WHERE opportunity_id = ?").get(OPPJ).s === "standby_expire");
  db.prepare("UPDATE opportunity SET standby_until = ? WHERE opportunity_id = ?").run(dayOffset(-2), OPPJ);
  check("J. nouveau stand-by expiré (nouvelle date) : nouvelle ActionKey, la ligne revient", inMonitoring(OPPJ));
}

section("D — Monitoring pistes → Ma semaine");
{
  const LEAD = "TESTAS_LEAD";
  insertLead(LEAD);
  const lead = leadMonitoringView(null, ALL).items.find((i) => i.lead.leadId === LEAD)?.lead;
  check("la piste est dans le Monitoring", !!lead);
  const leadKey = keys.leadActionKey(lead);
  // Ma semaine ne génère aujourd'hui aucune tâche de piste : une tâche qui
  // porterait cette ActionKey est fabriquée ici pour vérifier le mécanisme.
  const card = composeCards([
    { owner: "ET Piste", firstName: "ET", level: "orange", attentionSummary: null, reasons: [], momentum: null, moves: [], plan: [{ opportunityId: "X", client: "X", gmv: 100_000, reason: "securiser", impact: 1, pMonthEnd: null, actionKey: leadKey }], challengers: [], bigDeals: [] },
  ]);
  treatItem("piste", LEAD, now);
  check("D. traitée dans Monitoring : la piste disparaît du Monitoring", !inLeads(LEAD));
  const done = withSharedState(card, []);
  check("D. … et la tâche Ma semaine qui porterait la même clé est terminée", done.some((d) => d.actionKey === leadKey));
  check("« Tout lire » des pistes, rejoué ensuite, ne rouvre rien", (markScopeRead("piste", null, now), !inLeads(LEAD)));
  db.prepare("DELETE FROM monitoring_read").run();
  db.prepare("UPDATE lead SET recall_date = ? WHERE lead_id = ?").run(dayOffset(-1), LEAD);
  check("J (pistes). nouvelle date de rappel manquée : nouvelle action, la piste revient", inLeads(LEAD));
}

section("L — Dernière tâche d'un ET traitée depuis le Morning");
{
  const K = keys.planActionKey("TESTAS_L", "securiser", keys.actionWeekStart(now));
  const cards = composeCards([
    { owner: "ET Seul", firstName: "ET", level: "orange", attentionSummary: null, reasons: [], momentum: null, moves: [], plan: [{ opportunityId: "TESTAS_L", client: "L", gmv: 200_000, reason: "securiser", impact: 1, pMonthEnd: null, actionKey: K }], challengers: [], bigDeals: [] },
  ]);
  const visible = () => {
    const doneKeys = new Set(withSharedState(cards, []).map((d) => d.key));
    const s = hideTreated(scheduleCards(cards, [{ day: 2, time: "10:00" }], []), doneKeys);
    return [...s.timeline, ...s.toPlace].some((c) => c.owner === "ET Seul");
  };
  check("la carte est au planning", visible());
  markActionDone(K, now);
  check("L. traitée dans le Plan : la carte de l'ET disparaît de Ma semaine", !visible());
  restoreAction(K, now);
  check("L. rétablie : la carte revient", visible());
}

section("M — Sujet purement Ma semaine : comportement inchangé");
{
  const ws = keys.actionWeekStart(now);
  const t0 = treatedCount();
  const task = { key: `${owner}|baisse|TESTAS_M`, owner, label: "Comprendre la baisse", actionKey: null };
  checkAgendaTask(ws, task, now);
  check("M. coché : écrit dans l'état hebdomadaire de Ma semaine", loadAgendaState(ws).done.some((d) => d.key === task.key));
  check("M. … et nulle part ailleurs (état partagé inchangé)", treatedCount() === t0);
  restoreAgendaTask(ws, { key: task.key, actionKey: null });
  check("M. rétabli : la ligne hebdomadaire disparaît", !loadAgendaState(ws).done.some((d) => d.key === task.key));
}

section("Cloche — une action traitée ne sonne plus");
{
  const before = monitoringUnreadCounts();
  const OPPB = "TESTAS_OPPB";
  insertOpportunity({ id: OPPB, gmv: 70_000, status: "standby_expire", standbyUntil: dayOffset(-5), kanban: false });
  const mid = monitoringUnreadCounts();
  treatItem("opportunite", OPPB, now);
  const after = monitoringUnreadCounts();
  check("la cloche compte la nouvelle anomalie, puis la retire une fois traitée", mid.fresh + mid.legacy === before.fresh + before.legacy + 1 && after.fresh + after.legacy === before.fresh + before.legacy);
}

section("Schéma — migration additive");
{
  const cols = db.prepare("PRAGMA table_info(action_state)").all().map((c) => c.name);
  check("action_state : clé, source, statut, surface, dates", ["action_key", "source_type", "status", "surface", "treated_at", "restored_at", "updated_at"].every((c) => cols.includes(c)), cols.join(","));
  check("Rétablir ne supprime aucune ligne (historique conservé)", db.prepare("SELECT COUNT(*) n FROM action_state WHERE status = 'ouvert' AND restored_at IS NOT NULL").get().n > 0);
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT (base de travail : data/verif/action-state.db)" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);

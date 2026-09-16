/**
 * Contrôles de l'unification « client attend » (C) : le Morning devient la
 * seule autorité sur une attente d'origine e-mail, et Monitoring Opportunités
 * ne recalcule plus rien de son côté.
 *
 *   npm run monitoring:client-attend-verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : le contrôle ajoute des opportunités, des
 * signaux mail et des événements Morning fictifs, et ne doit jamais toucher
 * aux données réelles.
 *
 * Ce qui est vérifié :
 *   — un message classé « attente » par le VRAI triage du Morning (`triage()`,
 *     rejoué ici tel quel, jamais réécrit) fait apparaître `client_attend`
 *     côté Monitoring ;
 *   — un message qui n'appelle pas de réponse (`ignore`) n'en crée aucun ;
 *   — une réponse RM postérieure dans le même fil éteint l'attente, sans
 *     qu'aucun import Salesforce n'ait eu lieu entre les deux lectures ;
 *   — un rattachement de confiance insuffisante (niveau C) ne ressuscite pas
 *     l'ancienne règle de délai ;
 *   — l'acquittement utilisateur (`acknowledged` / « Pris en compte ») ne
 *     modifie jamais la réalité métier du fil ;
 *   — les autres jalons (stand-by, SLA, dormant) restent inchangés et priment
 *     toujours sur une attente d'origine e-mail ;
 *   — Morning (`canonicalClientAttend`) et Monitoring (`loadMilestoneOpportunities`)
 *     rendent exactement le même verdict pour les mêmes fixtures.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "monitoring-client-attend.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage, canonicalClientAttend, loadMorningEvents } = await import(lib("morning-events"));
const { loadMilestoneOpportunities } = await import(lib("opportunity-metrics"));
const { evaluateOpportunity } = await import(lib("opportunity-milestones"));
const { MILESTONE_THRESHOLDS } = await import(lib("opportunity-import"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const today = new Date().toISOString().slice(0, 10);
const nowMs = Date.now();
const HOUR = 36e5;
const DAY = 24 * HOUR;
const hoursAgo = (h) => new Date(nowMs - h * HOUR).toISOString();
const daysAgo = (d) => new Date(nowMs - d * DAY).toISOString();

function insertOpportunity(id, opts = {}) {
  const {
    owner = "Commercial Test C",
    gmv = 40000,
    stage = "Examen devis",
    milestoneStatus = "normal",
    clientWaiting = 0,
    standbyUntil = null,
    latenessHours = 0,
    devisSentAt = null,
    devisRelanceAt = null,
    lastHumanActionAt = null,
  } = opts;
  db.prepare(
    `INSERT INTO opportunity
       (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
        milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, standby_until,
        devis_sent_at, devis_relance_at, last_human_action_at,
        first_seen_on, last_import_id)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 1, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id, `Client ${id}`, owner, gmv, stage, milestoneStatus, clientWaiting, latenessHours, standbyUntil,
    devisSentAt, devisRelanceAt, lastHumanActionAt, today,
  );
}

function insertMailSignal({ id, threadId, opportunityId, sentAt, direction, matchLevel = "A", summary = null, subject = "Devis" }) {
  db.prepare(
    `INSERT INTO mail_signal
       (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
        filter_rule, opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
     VALUES (?, ?, ?, 'client@example.com', 'Client Test', ?, ?, 'conserve', ?, ?, 'test', 'Commercial Test C', 'neutre', ?, 0)`,
  ).run(id, threadId, sentAt, subject, direction, opportunityId, matchLevel, summary);
}

function insertMorningEvent({ id, threadId, sentAt, category, reason, status = "nouveau", acknowledgedAt = null }) {
  db.prepare(
    `INSERT INTO morning_event
       (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(id, threadId, sentAt, category, reason, status, acknowledgedAt, new Date(nowMs).toISOString());
}

const findOpp = (id) => loadMilestoneOpportunities().find((o) => o.opportunityId === id);

const ELIGIBLE_PIPE = { match_kind: "affaire_pipe", opportunity_stage: null, lead_status: null, stage: "Examen devis", is_terminal: 0, signal_type: "neutre" };

// --- Fixtures communes ---------------------------------------------------

const cleanupIds = { opportunities: [], messages: [] };

// === 1 — Message nécessitant une réponse : Morning « attente » => Monitoring « client_attend »

section("1 — Message classé « attente » par le VRAI triage du Morning => client_attend");

const OPP1 = "TESTCA_OPP1";
const MSG1 = "TESTCA_MSG1";
const THREAD1 = "TESTCA_THREAD1";
insertOpportunity(OPP1);
const t1 = triage({ ...ELIGIBLE_PIPE, direction: "entrant", subject: "Documents", summary: "Pouvez-vous me confirmer la reception des documents ?" });
check("le triage du Morning classe bien ce message en « attente »", t1.category === "attente", JSON.stringify(t1));
insertMailSignal({ id: MSG1, threadId: THREAD1, opportunityId: OPP1, sentAt: hoursAgo(2), direction: "entrant", matchLevel: "A", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG1, threadId: THREAD1, sentAt: hoursAgo(2), category: t1.category, reason: t1.reason });
cleanupIds.opportunities.push(OPP1);
cleanupIds.messages.push(MSG1);

check("canonicalClientAttend() retient l'affaire", canonicalClientAttend().has(OPP1));
const opp1 = findOpp(OPP1);
check("Monitoring affiche client_attend", opp1?.milestoneStatus === "client_attend", opp1?.milestoneStatus);
check("clientWaiting est vrai", opp1?.clientWaiting === true);
check("le motif cite la date du dernier message", typeof opp1?.milestoneReason === "string" && opp1.milestoneReason.includes("dernier message client"));

// === 2 — Message n'appelant pas de réponse : pas de client_attend

section("2 — Message classé « ignore » par le Morning => pas de client_attend");

const OPP2 = "TESTCA_OPP2";
const MSG2 = "TESTCA_MSG2";
const THREAD2 = "TESTCA_THREAD2";
insertOpportunity(OPP2);
const t2 = triage({ ...ELIGIBLE_PIPE, direction: "entrant", subject: "Devis", summary: "Merci beaucoup, bien recu." });
check("le triage du Morning classe ce message en « ignore »", t2.category === "ignore", JSON.stringify(t2));
insertMailSignal({ id: MSG2, threadId: THREAD2, opportunityId: OPP2, sentAt: hoursAgo(2), direction: "entrant", matchLevel: "A", summary: "Merci beaucoup, bien recu." });
insertMorningEvent({ id: MSG2, threadId: THREAD2, sentAt: hoursAgo(2), category: t2.category, reason: t2.reason || "écarté" });
cleanupIds.opportunities.push(OPP2);
cleanupIds.messages.push(MSG2);

check("canonicalClientAttend() ne retient pas l'affaire", !canonicalClientAttend().has(OPP2));
const opp2 = findOpp(OPP2);
check("Monitoring n'affiche pas client_attend", opp2?.milestoneStatus !== "client_attend", opp2?.milestoneStatus);

// === 3 — Réponse RM postérieure : l'attente s'éteint, sans nouvel import Salesforce

section("3 — Réponse RM postérieure dans le même fil : l'attente n'est plus active");

check("avant la réponse : l'affaire 1 est toujours en attente canonique", canonicalClientAttend().has(OPP1));
const MSG1_REPLY = "TESTCA_MSG1_REPLY";
insertMailSignal({ id: MSG1_REPLY, threadId: THREAD1, opportunityId: OPP1, sentAt: hoursAgo(1), direction: "sortant", matchLevel: "A", subject: "Re: Documents" });
insertMorningEvent({ id: MSG1_REPLY, threadId: THREAD1, sentAt: hoursAgo(1), category: "ignore", reason: "" });
cleanupIds.messages.push(MSG1_REPLY);

check("canonicalClientAttend() ne retient plus l'affaire", !canonicalClientAttend().has(OPP1));
const opp1After = findOpp(OPP1);
check(
  "Monitoring ne retourne plus client_attend pour cette affaire",
  opp1After?.milestoneStatus !== "client_attend",
  opp1After?.milestoneStatus,
);

// === 4 — Rattachement insuffisant (niveau C) : pas de résurrection de l'ancienne règle de délai

section("4 — Rattachement de niveau C : pas de client_attend, même sur un message ancien");

const OPP4 = "TESTCA_OPP4";
const MSG4 = "TESTCA_MSG4";
const THREAD4 = "TESTCA_THREAD4";
insertOpportunity(OPP4);
const t4 = triage({ ...ELIGIBLE_PIPE, direction: "entrant", subject: "Documents", summary: "Pouvez-vous me confirmer la reception des documents ?" });
check("le message serait classé « attente » par le Morning", t4.category === "attente");
// Volontairement ANCIEN (10 j) : l'ancienne règle de délai (3 j) l'aurait signalé.
insertMailSignal({ id: MSG4, threadId: THREAD4, opportunityId: OPP4, sentAt: daysAgo(10), direction: "entrant", matchLevel: "C", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG4, threadId: THREAD4, sentAt: daysAgo(10), category: t4.category, reason: t4.reason });
cleanupIds.opportunities.push(OPP4);
cleanupIds.messages.push(MSG4);

check("canonicalClientAttend() exclut un rattachement de niveau C", !canonicalClientAttend().has(OPP4));
const opp4 = findOpp(OPP4);
check("Monitoring n'affiche pas client_attend malgré l'ancienneté du message", opp4?.milestoneStatus !== "client_attend", opp4?.milestoneStatus);

// === 5 — Acquittement utilisateur ≠ réalité métier

section("5 — Événement « pris en compte » : la réalité métier reste vraie");

const OPP5 = "TESTCA_OPP5";
const MSG5 = "TESTCA_MSG5";
const THREAD5 = "TESTCA_THREAD5";
insertOpportunity(OPP5);
const t5 = triage({ ...ELIGIBLE_PIPE, direction: "entrant", subject: "Documents", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMailSignal({ id: MSG5, threadId: THREAD5, opportunityId: OPP5, sentAt: hoursAgo(3), direction: "entrant", matchLevel: "B", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({
  id: MSG5,
  threadId: THREAD5,
  sentAt: hoursAgo(3),
  category: t5.category,
  reason: t5.reason,
  status: "pris_en_compte",
  acknowledgedAt: hoursAgo(1),
});
cleanupIds.opportunities.push(OPP5);
cleanupIds.messages.push(MSG5);

const morningState = loadMorningEvents().events.find((e) => e.messageId === MSG5);
check("côté Morning, le message est bien marqué « acknowledged »", morningState?.acknowledged === true);
check("canonicalClientAttend() l'ignore PAS pour autant (le statut n'entre pas dans le calcul)", canonicalClientAttend().has(OPP5));
const opp5 = findOpp(OPP5);
check(
  "Monitoring affiche toujours client_attend malgré l'acquittement utilisateur",
  opp5?.milestoneStatus === "client_attend",
  opp5?.milestoneStatus,
);

// === 6 — Régression : les autres jalons restent inchangés et priment toujours

section("6 — Régression : le moteur Salesforce (sans mailSignal) est inchangé");

const vStandby = evaluateOpportunity(
  { opportunityId: "X", stage: "Examen devis", amount: 1000, standbyUntil: new Date(nowMs + 10 * DAY).toISOString(), isActive: true, tasks: [], events: [] },
  MILESTONE_THRESHOLDS,
  nowMs,
);
check("stand-by en cours => standby", vStandby.milestoneStatus === "standby", vStandby.milestoneStatus);

const vStandbyExpire = evaluateOpportunity(
  { opportunityId: "X", stage: "Examen devis", amount: 1000, standbyUntil: daysAgo(5), isActive: true, tasks: [], events: [] },
  MILESTONE_THRESHOLDS,
  nowMs,
);
check("stand-by expiré, aucune reprise => standby_expire", vStandbyExpire.milestoneStatus === "standby_expire", vStandbyExpire.milestoneStatus);

const vSlaDevis = evaluateOpportunity(
  {
    opportunityId: "X", stage: "Examen devis", amount: 1000, standbyUntil: null, isActive: true,
    tasks: [{ subject: "Votre devis est disponible", description: null, subtype: "Email", at: daysAgo(10) }],
    events: [],
  },
  MILESTONE_THRESHOLDS,
  nowMs,
);
check("devis envoyé, aucune relance au-delà du SLA => sla_devis", vSlaDevis.milestoneStatus === "sla_devis", vSlaDevis.milestoneStatus);

const vSlaEstimation = evaluateOpportunity(
  {
    opportunityId: "X", stage: "Etude dossier", amount: 1000, standbyUntil: null, isActive: true,
    tasks: [{ subject: "Votre estimation est disponible", description: null, subtype: "Email", at: daysAgo(10) }],
    events: [],
  },
  MILESTONE_THRESHOLDS,
  nowMs,
);
check("estimation envoyée, aucune relance au-delà du SLA => sla_estimation", vSlaEstimation.milestoneStatus === "sla_estimation", vSlaEstimation.milestoneStatus);

const vDormant = evaluateOpportunity(
  { opportunityId: "X", stage: null, amount: 1000, standbyUntil: null, isActive: true, tasks: [], events: [] },
  MILESTONE_THRESHOLDS,
  nowMs,
);
check("aucun jalon, aucune action humaine => dormant_candidate", vDormant.milestoneStatus === "dormant_candidate", vDormant.milestoneStatus);

section("6bis — Régression : une attente e-mail ne recouvre jamais un jalon prioritaire");

const OPP6_STANDBY = "TESTCA_OPP6_STANDBY";
const OPP6_SLA = "TESTCA_OPP6_SLA";
const MSG6A = "TESTCA_MSG6A";
const MSG6B = "TESTCA_MSG6B";
insertOpportunity(OPP6_STANDBY, { milestoneStatus: "standby", standbyUntil: new Date(nowMs + 10 * DAY).toISOString() });
insertOpportunity(OPP6_SLA, { milestoneStatus: "sla_devis", latenessHours: 240 });
const t6 = triage({ ...ELIGIBLE_PIPE, direction: "entrant", subject: "Documents", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMailSignal({ id: MSG6A, threadId: "TESTCA_THREAD6A", opportunityId: OPP6_STANDBY, sentAt: hoursAgo(2), direction: "entrant", matchLevel: "A", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG6A, threadId: "TESTCA_THREAD6A", sentAt: hoursAgo(2), category: t6.category, reason: t6.reason });
insertMailSignal({ id: MSG6B, threadId: "TESTCA_THREAD6B", opportunityId: OPP6_SLA, sentAt: hoursAgo(2), direction: "entrant", matchLevel: "A", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG6B, threadId: "TESTCA_THREAD6B", sentAt: hoursAgo(2), category: t6.category, reason: t6.reason });
cleanupIds.opportunities.push(OPP6_STANDBY, OPP6_SLA);
cleanupIds.messages.push(MSG6A, MSG6B);

check("les deux affaires sont bien en attente canonique côté Morning", canonicalClientAttend().has(OPP6_STANDBY) && canonicalClientAttend().has(OPP6_SLA));
const oppStandby = findOpp(OPP6_STANDBY);
const oppSla = findOpp(OPP6_SLA);
check("le stand-by n'est PAS recouvert par l'attente e-mail", oppStandby?.milestoneStatus === "standby", oppStandby?.milestoneStatus);
check("le SLA devis n'est PAS recouvert par l'attente e-mail", oppSla?.milestoneStatus === "sla_devis", oppSla?.milestoneStatus);

// === 7 — Morning et Monitoring rendent le même verdict

section("7 — Morning et Monitoring produisent le même verdict pour les mêmes fixtures");

// Comparaison directe, sur les affaires où AUCUN jalon Salesforce prioritaire
// n'interfère : là, « en attente pour Morning » et « client_attend affiché
// par Monitoring » doivent être rigoureusement la même chose.
// OPP6_STANDBY / OPP6_SLA sont volontairement exclus d'ici : Morning les
// juge bien en attente (vérifié en 6bis), mais Monitoring priorise à raison
// un jalon Salesforce plus urgent pour l'AFFICHAGE — ce n'est pas un
// désaccord entre les deux vérités, c'est la hiérarchie déjà en vigueur avant
// C, que ce chantier n'a pas à modifier.
const canonical = canonicalClientAttend();
const all = loadMilestoneOpportunities();
const verdictOf = (id) => all.find((o) => o.opportunityId === id)?.milestoneStatus === "client_attend";
for (const id of [OPP1, OPP2, OPP4, OPP5]) {
  check(`${id} : même verdict des deux côtés`, canonical.has(id) === verdictOf(id), `Morning=${canonical.has(id)} · Monitoring=${verdictOf(id)}`);
}
check(
  "affaires protégées : Morning voit l'attente, Monitoring priorise le jalon Salesforce — cohérent, pas contradictoire",
  canonical.has(OPP6_STANDBY) && canonical.has(OPP6_SLA) && !verdictOf(OPP6_STANDBY) && !verdictOf(OPP6_SLA),
);

// === 8 — Un `client_attend` hérité de l'ANCIENNE règle est neutralisé SANS
//         attendre le prochain import Salesforce, jamais mis à « normal » par
//         défaut : la hiérarchie de jalons est rejouée depuis les faits
//         persistés pour retrouver le VRAI statut, y compris une autre
//         anomalie.

section("8 — client_attend hérité, sans attente canonique : neutralisation immédiate");

// 8a — une autre anomalie Salesforce (SLA devis) doit prendre sa place.
const OPP8_SLA = "TESTCA_OPP8_SLA";
insertOpportunity(OPP8_SLA, {
  milestoneStatus: "client_attend", // valeur PERSISTÉE par l'ancienne règle, jamais recalculée depuis
  clientWaiting: 1,
  devisSentAt: daysAgo(10),
  devisRelanceAt: null,
});
cleanupIds.opportunities.push(OPP8_SLA);

check("aucune attente canonique Morning pour cette affaire", !canonicalClientAttend().has(OPP8_SLA));
const opp8Sla = findOpp(OPP8_SLA);
check(
  "Monitoring ne retourne PLUS client_attend (donnée obsolète, pas relue depuis un import)",
  opp8Sla?.milestoneStatus !== "client_attend",
  opp8Sla?.milestoneStatus,
);
check(
  "l'anomalie réellement applicable (SLA devis) prend sa place — pas un repli sur « normal »",
  opp8Sla?.milestoneStatus === "sla_devis",
  opp8Sla?.milestoneStatus,
);
check("clientWaiting redevient faux avec ce statut", opp8Sla?.clientWaiting === false);

// 8b — aucune anomalie Salesforce applicable : bascule vers « normal », pas
//      « dormant_candidate » (une action humaine récente protège l'affaire).
const OPP8_NORMAL = "TESTCA_OPP8_NORMAL";
insertOpportunity(OPP8_NORMAL, {
  milestoneStatus: "client_attend",
  clientWaiting: 1,
  lastHumanActionAt: daysAgo(1),
});
cleanupIds.opportunities.push(OPP8_NORMAL);

check("aucune attente canonique Morning pour cette affaire", !canonicalClientAttend().has(OPP8_NORMAL));
const opp8Normal = findOpp(OPP8_NORMAL);
check(
  "Monitoring retrouve le statut Salesforce pur : normal, une action récente existe",
  opp8Normal?.milestoneStatus === "normal",
  opp8Normal?.milestoneStatus,
);
check("clientWaiting redevient faux", opp8Normal?.clientWaiting === false);

// --- Nettoyage ---------------------------------------------------------------

const oppPlaceholders = cleanupIds.opportunities.map(() => "?").join(",");
const msgPlaceholders = cleanupIds.messages.map(() => "?").join(",");
if (cleanupIds.opportunities.length > 0) {
  db.prepare(`DELETE FROM opportunity WHERE opportunity_id IN (${oppPlaceholders})`).run(...cleanupIds.opportunities);
}
if (cleanupIds.messages.length > 0) {
  db.prepare(`DELETE FROM mail_signal WHERE gmail_message_id IN (${msgPlaceholders})`).run(...cleanupIds.messages);
  db.prepare(`DELETE FROM morning_event WHERE gmail_message_id IN (${msgPlaceholders})`).run(...cleanupIds.messages);
}

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

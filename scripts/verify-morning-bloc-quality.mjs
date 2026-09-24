/**
 * Contrôles F : qualité des blocs 1 (« client chaud ») et 2 (« client qui
 * attend une réponse »), et fraîcheur du fil mutualisée avec `canonicalClientAttend()`.
 *
 *   npm run morning:bloc-quality-verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE pour les contrôles qui ont besoin d'un fil
 * réel (`mail_signal` / `morning_event` / `opportunity`) ; les contrôles de
 * classification pure appellent `triage()` directement, sans aucune écriture.
 *
 * Ce qui est vérifié :
 *   — Bloc 2 : une réponse RM postérieure éteint l'attente, qu'elle soit ou
 *     non acquittée (« acknowledged » ≠ attente métier), sans nouvel import
 *     Salesforce ;
 *   — précision : accusés de réception, remerciements et simples
 *     transmissions ne sont plus classés « attente » à tort ; les vraies
 *     demandes (document, correction, créneau à confirmer) le restent ;
 *   — Bloc 1 : un accord/une volonté d'avancer implicite est capturé, un
 *     « merci, on réfléchit » ou une question technique amont ne le sont pas ;
 *   — hiérarchie : un message à la fois chaud et demandeur reste « chaud » ;
 *   — non-régression D/E : l'exclusion « géré directement » reste prioritaire ;
 *   — `canonicalClientAttend()` et la fraîcheur du Bloc 2 s'accordent
 *     TOUJOURS sur les mêmes fixtures.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "morning-bloc-quality.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage, loadMorningEvents, canonicalClientAttend } = await import(lib("morning-events"));

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

const PIPE = { match_kind: "affaire_pipe", opportunity_stage: null, lead_status: null, stage: "Examen devis", is_terminal: 0, owner: null, ext_owner: null, lead_owner: null, rm_to: null, rm_cc: null };

function triageWith(summary, overrides = {}) {
  return triage({ direction: "entrant", subject: "Devis", summary, blocker: null, signal_type: "neutre", ...PIPE, ...overrides });
}

// ============================================================================
// H — Bloc 1, précision du signal chaud
// ============================================================================

section("H1-H8 — Bloc 1 : preuve d'engagement exploitable, pas un mail « positif »");

check("H1 — accord + demande de lancement => chaud", triageWith("Le devis nous convient. Comment peut-on lancer les travaux ?").category === "chaud");
check("H2 — date de démarrage sur affaire active => chaud (signal implicite)", triageWith("Quand pouvez-vous demarrer ?").category === "chaud");
check("H3 — négociation finale + signature => chaud", triageWith("Si vous retirez la peinture, on peut signer cette semaine.").category === "chaud");
check("H4 — politesse + réflexion => pas chaud", triageWith("Merci pour le devis, nous allons reflechir.").category !== "chaud");
check("H5 — question technique amont, sans décision => pas chaud", triageWith("Quelle marque de robinet utilisez-vous ?").category !== "chaud");
check("H6 — refus => pas chaud", triageWith("Nous ne donnerons pas suite.").category !== "chaud");
const h7 = triageWith("Pouvez-vous envoyer la fiche technique ?");
check("H7 — demande d'info sans autre signal => pas chaud (attente possible)", h7.category !== "chaud", h7.category);
check("H8 — accord + demande de lien de signature => chaud, prioritaire sur attente", triageWith("Le budget nous convient, pouvez-vous m'envoyer le lien pour signer ?").category === "chaud");

section("P1-P3 — Hiérarchie chaud > attente : l'engagement prime sur la demande qui l'accompagne");

check(
  "P1 — accord + demande de lien de signature (verbe « pourriez ») => chaud",
  triageWith("Le devis nous convient, pourriez-vous m'envoyer le lien pour signer ?").category === "chaud",
);
check(
  "P2 — négociation conditionnelle + intention de signer (conjugaison) => chaud",
  triageWith("Si vous retirez la peinture, pouvez-vous me renvoyer le devis pour que nous signions ?").category === "chaud",
);
const p3 = triageWith("Pouvez-vous simplement m'envoyer la fiche technique ?");
check("P3 — simple demande d'info, aucun engagement => attente, pas chaud", p3.category === "attente", p3.category);

section("P4 — Régression audit production : « signature » nue dans un résumé sans engagement réel");

// Résumé générique produit par le classifieur IA quand rien de concluant n'a
// été trouvé : le mot « signature » y apparaît dans un contexte négatif, pas
// comme un signal d'engagement. Cause racine confirmée sur la production :
// ce résumé, à lui seul, faisait passer des dizaines de messages sans rapport
// en chaud/attente.
const p4a = triageWith("Echange sans effet clair sur la signature");
check("P4a — résumé générique inconclusif => ni chaud ni attente", p4a.category !== "chaud" && p4a.category !== "attente", p4a.category);
const p4b = triageWith("Nous restons dans l'attente d'un retour sur la signature du dossier");
check(
  "P4b — « signature » en contexte non-engageant, sans verbe ni demande => pas chaud",
  p4b.category !== "chaud",
  p4b.category,
);

// ============================================================================
// W — Bloc 2, précision et fraîcheur du fil
// ============================================================================

section("W3-W7 — Bloc 2 : ce qui ne doit PAS être une attente");

check("W3 — accusé de réception pur => pas attente", triageWith("Merci, c'est bien recu.").category !== "attente");
check("W4 — remerciement + « nous revenons vers vous » => pas attente", triageWith("Merci pour votre devis, nous allons reflechir et reviendrons vers vous.").category !== "attente");
check("W7 — transmission sans question ni demande => pas attente", triageWith("Bonjour, voici le document signe. Cordialement.").category !== "attente");

section("W5-W6 — Bloc 2 : ce qui doit rester une attente");

check("W5 — demande de correction et de renvoi => attente", triageWith("Pouvez-vous modifier le devis et me le renvoyer ?").category === "attente");
// Lot de simplification (A2) : proposer ses disponibilités, c'est « disponibilité
// pour poursuivre » — une intention d'avancer, donc Bloc 1 (hiérarchie chaud >
// attente, P1-P3). Avant, ce cas tombait en attente.
check("W6 — propose un créneau => chaud (disponibilité pour poursuivre, chaud > attente)", triageWith("Je suis disponible mardi ou mercredi, dites-moi ce qui vous convient.").category === "chaud");

// --- Fixtures DB pour la fraîcheur du fil (W1, W2, W8, W9, T4, T5) -----------

const cleanup = { opportunities: [], messages: [] };
function insertOpportunity(id, owner = "Commercial Test F") {
  db.prepare(
    `INSERT INTO opportunity
       (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
        milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
     VALUES (?, ?, ?, 40000, 'Examen devis', 0, 0, 0, 1, 'normal', 0, 0, 0, ?, 0)`,
  ).run(id, `Client ${id}`, owner, nowMs && new Date(nowMs).toISOString().slice(0, 10));
  cleanup.opportunities.push(id);
}
function insertMailSignal({ id, threadId, opportunityId, sentAt, direction, matchLevel = "A", summary = null, subject = "Devis" }) {
  db.prepare(
    `INSERT INTO mail_signal
       (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
        filter_rule, opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
     VALUES (?, ?, ?, 'client@example.com', 'Client Test', ?, ?, 'conserve', ?, ?, 'test', 'Commercial Test F', 'neutre', ?, 0)`,
  ).run(id, threadId, sentAt, subject, direction, opportunityId, matchLevel, summary);
  cleanup.messages.push(id);
}
function insertMorningEvent({ id, threadId, sentAt, category, reason, status = "nouveau", acknowledgedAt = null }) {
  db.prepare(
    `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(id, threadId, sentAt, category, reason, status, acknowledgedAt, new Date(nowMs).toISOString());
}
const findEvent = (id) => loadMorningEvents().events.find((e) => e.messageId === id);

section("W1 — attente active, sans réponse RM");

const OPP_W1 = "TESTF_OPP_W1";
const MSG_W1 = "TESTF_MSG_W1";
const THREAD_W1 = "TESTF_THREAD_W1";
insertOpportunity(OPP_W1);
const tW1 = triageWith("Pouvez-vous me confirmer la reception des documents ?");
check("classé attente par le triage", tW1.category === "attente", tW1.category);
insertMailSignal({ id: MSG_W1, threadId: THREAD_W1, opportunityId: OPP_W1, sentAt: hoursAgo(3), direction: "entrant", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG_W1, threadId: THREAD_W1, sentAt: hoursAgo(3), category: tW1.category, reason: tW1.reason });

const evW1 = findEvent(MSG_W1);
check("apparaît comme attente active (awaitingReply)", evW1?.category === "attente" && evW1?.awaitingReply === true);
check("l'affaire est en attente canonique côté Monitoring", canonicalClientAttend().has(OPP_W1));

section("W2 — réponse RM plus récente : l'attente disparaît des DEUX côtés");

const MSG_W1_REPLY = "TESTF_MSG_W1_REPLY";
insertMailSignal({ id: MSG_W1_REPLY, threadId: THREAD_W1, opportunityId: OPP_W1, sentAt: hoursAgo(1), direction: "sortant", subject: "Re: Devis" });
insertMorningEvent({ id: MSG_W1_REPLY, threadId: THREAD_W1, sentAt: hoursAgo(1), category: "ignore", reason: "" });

const evW2 = findEvent(MSG_W1);
check("n'est plus une attente active (Bloc 2)", evW2?.awaitingReply === false, `awaitingReply=${evW2?.awaitingReply}`);
check("n'alimente plus canonicalClientAttend() (Monitoring)", !canonicalClientAttend().has(OPP_W1));

section("W8 — événement acknowledged, aucune réponse RM : la réalité métier reste vraie");

const OPP_W8 = "TESTF_OPP_W8";
const MSG_W8 = "TESTF_MSG_W8";
const THREAD_W8 = "TESTF_THREAD_W8";
insertOpportunity(OPP_W8);
const tW8 = triageWith("Pouvez-vous me confirmer la reception des documents ?");
insertMailSignal({ id: MSG_W8, threadId: THREAD_W8, opportunityId: OPP_W8, sentAt: hoursAgo(5), direction: "entrant", summary: "Pouvez-vous me confirmer la reception des documents ?" });
insertMorningEvent({ id: MSG_W8, threadId: THREAD_W8, sentAt: hoursAgo(5), category: tW8.category, reason: tW8.reason, status: "pris_en_compte", acknowledgedAt: hoursAgo(2) });

const evW8 = findEvent(MSG_W8);
check("le message est bien acquitté (état utilisateur)", evW8?.acknowledged === true);
check("il reste une attente active tant qu'aucune réponse n'existe (état métier)", evW8?.awaitingReply === true);
check("canonicalClientAttend() confirme l'attente malgré l'acquittement", canonicalClientAttend().has(OPP_W8));

section("W9 — réponse RM après acquittement : client_attend devient faux");

const MSG_W8_REPLY = "TESTF_MSG_W8_REPLY";
insertMailSignal({ id: MSG_W8_REPLY, threadId: THREAD_W8, opportunityId: OPP_W8, sentAt: hoursAgo(1), direction: "sortant", subject: "Re: Devis" });
insertMorningEvent({ id: MSG_W8_REPLY, threadId: THREAD_W8, sentAt: hoursAgo(1), category: "ignore", reason: "" });

const evW9 = findEvent(MSG_W8);
check("le message acquitté n'est plus une attente active", evW9?.awaitingReply === false);
check("canonicalClientAttend() ne retient plus l'affaire", !canonicalClientAttend().has(OPP_W8));

// ============================================================================
// T — Transversal : D/E toujours prioritaires, cohérence Morning/Monitoring
// ============================================================================

section("T1-T3 — D/E restent prioritaires sur la précision F");

check("T1 — owner Sami + signal chaud => hors périmètre", triageWith("Le devis nous convient. Comment peut-on lancer les travaux ?", { owner: "Sami Lazari" }).category === "hors_perimetre");
check("T2 — owner autre + Sami en copie + signal chaud => chaud", triageWith("Le devis nous convient. Comment peut-on lancer les travaux ?", { owner: "Jonathan Florville", rm_cc: JSON.stringify(["Sami Lazari"]) }).category === "chaud");
check("T3 — owner autre + Sami en copie + signal attente => attente", triageWith("Pouvez-vous me confirmer la reception des documents ?", { owner: "Jonathan Florville", rm_cc: JSON.stringify(["Sami Lazari"]) }).category === "attente");

section("T4/T5 — Morning et Monitoring toujours d'accord, sans nouvel import Salesforce");

const OPP_T4 = "TESTF_OPP_T4";
const MSG_T4 = "TESTF_MSG_T4";
const THREAD_T4 = "TESTF_THREAD_T4";
insertOpportunity(OPP_T4);
const tT4 = triageWith("Pouvez-vous modifier le devis et me le renvoyer ?");
insertMailSignal({ id: MSG_T4, threadId: THREAD_T4, opportunityId: OPP_T4, sentAt: hoursAgo(6), direction: "entrant", summary: "Pouvez-vous modifier le devis et me le renvoyer ?" });
insertMorningEvent({ id: MSG_T4, threadId: THREAD_T4, sentAt: hoursAgo(6), category: tT4.category, reason: tT4.reason });

const allEvents = loadMorningEvents().events;
const canonical = canonicalClientAttend();
const attenteWithOpp = allEvents.filter((e) => e.category === "attente" && e.opportunityId != null && e.attachment !== "a_verifier");
// Comparaison PAR AFFAIRE, pas par message : une affaire peut porter plusieurs
// messages « attente » (plusieurs threads, ou plusieurs relances) — seule
// compte la question « au moins un message actif pour cette affaire ? ».
const byOpp = new Map();
for (const e of attenteWithOpp) {
  const list = byOpp.get(e.opportunityId) ?? [];
  list.push(e);
  byOpp.set(e.opportunityId, list);
}
let agree = true;
for (const [oppId, list] of byOpp) {
  const anyActive = list.some((e) => e.awaitingReply);
  if (anyActive !== canonical.has(oppId)) agree = false;
}
check(
  "toutes les fixtures d'attente rattachées Salesforce : même verdict actif Morning/Monitoring",
  agree,
  `${byOpp.size} affaire(s) comparée(s), ${attenteWithOpp.length} événement(s)`,
);

// Une réponse synchronisée suffit, sans réimporter Salesforce (aucune ligne
// `opportunity` n'est modifiée ici : seule `mail_signal` reçoit le message).
const MSG_T4_REPLY = "TESTF_MSG_T4_REPLY";
insertMailSignal({ id: MSG_T4_REPLY, threadId: THREAD_T4, opportunityId: OPP_T4, sentAt: hoursAgo(0.5), direction: "sortant", subject: "Re: Devis" });
check("T5 — l'attente disparaît au prochain chargement, sans import Salesforce", !canonicalClientAttend().has(OPP_T4));
const evT5 = findEvent(MSG_T4);
check("T5 — le Bloc 2 suit immédiatement (même lecture)", evT5?.awaitingReply === false);

// ============================================================================
// Audit du bruit réel (43 attentes affichées) : notifications d'outils tiers
// ============================================================================

section("Audit — notifications d'outils tiers exclues (docs.google.com, DocuSign, Trello)");

// La garde (E1ter) porte sur l'EXPÉDITEUR, pas sur le contenu : même un
// rattachement Salesforce fort (`affaire_pipe`, via `PIPE`) ne doit pas
// suffire à faire remonter une notification d'outil.
const gdocs = triage({
  direction: "entrant",
  subject: "Vous avez été mentionné",
  summary: "Mention dans un document partagé (Perspectives M)",
  blocker: null,
  signal_type: "neutre",
  from_email: "comments-noreply@docs.google.com",
  ...PIPE,
});
check("Google Docs (comments-noreply) => hors périmètre quel que soit le contenu", gdocs.category === "hors_perimetre", gdocs.category);

const docusign = triage({
  direction: "entrant",
  subject: "Envelope complete",
  summary: "Prêt à signer ou dernière étape avant signature",
  blocker: null,
  signal_type: "signature",
  from_email: "dse@eumail.docusign.net",
  ...PIPE,
});
check("DocuSign (dse@eumail.docusign.net) => hors périmètre, même en signal_type=signature", docusign.category === "hors_perimetre", docusign.category);

const trello = triage({
  direction: "entrant",
  subject: "Carte modifiée",
  summary: "Date limite changée sur une carte interne",
  blocker: null,
  signal_type: "neutre",
  from_email: "do-not-reply@trello.com",
  ...PIPE,
});
check("Trello (do-not-reply@trello.com) => hors périmètre", trello.category === "hors_perimetre", trello.category);

// ============================================================================
// Audit du bruit réel : déduplication des relances successives d'un même fil
// ============================================================================

section("Audit — un seul fil, plusieurs relances non répondues => une seule attente affichée");

const OPP_DUP = "TESTF_OPP_DUP";
const THREAD_DUP = "TESTF_THREAD_DUP";
const MSG_DUP1 = "TESTF_MSG_DUP1";
const MSG_DUP2 = "TESTF_MSG_DUP2";
const MSG_DUP3 = "TESTF_MSG_DUP3";
insertOpportunity(OPP_DUP);
for (const [id, hoursBack] of [[MSG_DUP1, 72], [MSG_DUP2, 48], [MSG_DUP3, 24]]) {
  const t = triageWith("Pouvez-vous retirer ce poste du devis et me le renvoyer ?");
  insertMailSignal({ id, threadId: THREAD_DUP, opportunityId: OPP_DUP, sentAt: hoursAgo(hoursBack), direction: "entrant", summary: "Pouvez-vous retirer ce poste du devis et me le renvoyer ?" });
  insertMorningEvent({ id, threadId: THREAD_DUP, sentAt: hoursAgo(hoursBack), category: t.category, reason: t.reason });
}

const dupEvents = loadMorningEvents().events.filter((e) => e.threadId === THREAD_DUP);
check("les 3 messages sont bien classés attente", dupEvents.every((e) => e.category === "attente"), dupEvents.map((e) => e.category).join(","));
const activeInThread = dupEvents.filter((e) => e.awaitingReply);
check("une seule des trois relances reste active (la plus récente)", activeInThread.length === 1, `${activeInThread.length} active(s)`);
check("c'est bien la plus récente qui reste active", activeInThread[0]?.messageId === MSG_DUP3, activeInThread[0]?.messageId);
check("canonicalClientAttend() ne compte l'affaire qu'une fois (Map par affaire)", canonicalClientAttend().has(OPP_DUP));

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

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

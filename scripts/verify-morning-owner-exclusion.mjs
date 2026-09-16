/**
 * Contrôles D + E : persistance des destinataires RM (`to`/`cc`) et exclusion
 * des échanges gérés directement par le titulaire du compte lu (Sami).
 *
 *   npm run morning:owner-exclusion-verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : le contrôle insère des signaux mail, des
 * événements Morning et des opportunités fictifs, et ne doit jamais toucher
 * aux données réelles.
 *
 * Ce qui est vérifié :
 *   D — `teamMembersInTo`/`teamMembersInCc` distinguent bien `to` de `cc`, et
 *       `insertSignal` persiste cette donnée en JSON compact, lisible même
 *       sur d'anciennes lignes qui ne l'ont jamais eue ;
 *   E — le propriétaire Salesforce fait SEUL autorité quand une affaire ou une
 *       piste est identifiée (la présence de Sami en copie ne l'exclut ni ne
 *       l'inclut) ; à défaut, les destinataires RM tranchent, mais seulement
 *       si Sami en est l'UNIQUE interlocuteur RM identifié ; une ligne sans
 *       cette donnée (antérieure à D) n'est jamais exclue pour ce motif ;
 *   — la vérité canonique « client attend » (C) hérite naturellement de cette
 *     exclusion, sans que `canonicalClientAttend()` ait besoin de la
 *     réinterpréter.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "morning-owner-exclusion.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { teamMembersInTo, teamMembersInCc } = await import(lib("mail-rules"));
const { evaluateEligibility } = await import(lib("morning-eligibility"));
const { triage, canonicalClientAttend } = await import(lib("morning-events"));
const { insertSignal } = await import(lib("mail-store"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const SAMI = "sami@renovationman.com";
const JONATHAN = "jonathan.florville@renovationman.com";
const CLIENT = "client@example.com";

// ============================================================================
// D — Persistance des destinataires RM
// ============================================================================

section("D1 — Sami en `to`, Jonathan en `cc` : les deux sont persistés séparément");

const msgD1 = { from: CLIENT, to: [SAMI], cc: [JONATHAN] };
check("Sami détecté en `to`", JSON.stringify(teamMembersInTo(msgD1)) === JSON.stringify(["Sami Lazari"]));
check("Jonathan détecté en `cc`", JSON.stringify(teamMembersInCc(msgD1)) === JSON.stringify(["Jonathan Florville"]));
check("Jonathan n'est PAS compté en `to`", !teamMembersInTo(msgD1).includes("Jonathan Florville"));
check("Sami n'est PAS compté en `cc`", !teamMembersInCc(msgD1).includes("Sami Lazari"));

section("D2 — Sami seul côté RM (to et cc)");

const msgD2 = { from: CLIENT, to: [SAMI], cc: [] };
check("Sami seul en `to`", JSON.stringify(teamMembersInTo(msgD2)) === JSON.stringify(["Sami Lazari"]));
check("aucun membre en `cc`", teamMembersInCc(msgD2).length === 0);

section("D3 — Aucun membre RM reconnu : représentation vide, aucune erreur");

const msgD3 = { from: CLIENT, to: ["inconnu@client.fr"], cc: ["autre@client.fr"] };
check("aucune exception levée", (() => {
  try {
    teamMembersInTo(msgD3);
    teamMembersInCc(msgD3);
    return true;
  } catch {
    return false;
  }
})());
check("`to` vide, conforme", JSON.stringify(teamMembersInTo(msgD3)) === "[]");
check("`cc` vide, conforme", JSON.stringify(teamMembersInCc(msgD3)) === "[]");

section("D — Persistance réelle via insertSignal, y compris les anciennes lignes");

const db = getDb();
const now = new Date().toISOString();
const MSG_D_TO_CC = "TESTOWNER_D_TOCC";
const MSG_D_LEGACY = "TESTOWNER_D_LEGACY";

insertSignal(
  {
    gmailMessageId: MSG_D_TO_CC,
    threadId: "TESTOWNER_D_THREAD",
    sentAt: now,
    fromEmail: CLIENT,
    fromName: "Client Test",
    subject: "Devis",
    direction: "entrant",
    filterRule: "conserve",
    opportunityId: null,
    matchLevel: "A",
    matchReason: "test",
    salesperson: null,
    rmTo: teamMembersInTo(msgD1),
    rmCc: teamMembersInCc(msgD1),
  },
  0,
);

const persisted = db
  .prepare("SELECT rm_to, rm_cc FROM mail_signal WHERE gmail_message_id = ?")
  .get(MSG_D_TO_CC);
check("rm_to persisté correctement", persisted?.rm_to === '["Sami Lazari"]', persisted?.rm_to);
check("rm_cc persisté correctement", persisted?.rm_cc === '["Jonathan Florville"]', persisted?.rm_cc);

// Simule une ligne ANTÉRIEURE à D : insérée sans jamais passer par les
// nouvelles colonnes (aucune ALTER TABLE rétroactive ne les remplit).
db.prepare(
  `INSERT INTO mail_signal (gmail_message_id, thread_id, sent_at, from_email, direction, match_level, sync_id)
   VALUES (?, ?, ?, ?, 'entrant', 'A', 0)`,
).run(MSG_D_LEGACY, "TESTOWNER_D_LEGACY_THREAD", now, CLIENT);
const legacyRow = db.prepare("SELECT rm_to, rm_cc FROM mail_signal WHERE gmail_message_id = ?").get(MSG_D_LEGACY);
check("une ligne antérieure à D a bien rm_to = NULL (pas '[]')", legacyRow?.rm_to == null, String(legacyRow?.rm_to));
check("une ligne antérieure à D a bien rm_cc = NULL (pas '[]')", legacyRow?.rm_cc == null, String(legacyRow?.rm_cc));

db.prepare("DELETE FROM mail_signal WHERE gmail_message_id IN (?, ?)").run(MSG_D_TO_CC, MSG_D_LEGACY);

// ============================================================================
// E — Exclusion des échanges gérés directement par Sami
// ============================================================================

const SAMI_NAME = "Sami Lazari";
const JONATHAN_NAME = "Jonathan Florville";

function baseContext(overrides) {
  return {
    matchKind: null,
    externalStage: null,
    leadStatus: null,
    dealStage: null,
    dealIsTerminal: false,
    direction: "entrant",
    ownerName: null,
    rmTo: null,
    rmCc: null,
    ...overrides,
  };
}
const baseMessage = { fromEmail: CLIENT, subject: "Devis", summary: "Le devis nous convient." };

section("E — evaluateEligibility() : la règle de propriété, isolée");

const e1 = evaluateEligibility(baseMessage, baseContext({ matchKind: "affaire_pipe", ownerName: SAMI_NAME, dealStage: "Examen devis" }), "renovationman.com");
check("E1 — opportunité de Sami : exclu (« géré directement »)", e1.verdict === "non" && e1.family === "géré directement", JSON.stringify(e1));

const e3 = evaluateEligibility(baseMessage, baseContext({ matchKind: "affaire_pipe", ownerName: JONATHAN_NAME, rmCc: [SAMI_NAME], dealStage: "Examen devis" }), "renovationman.com");
check("E3 — opportunité de Jonathan, Sami en copie : reste éligible", e3.verdict === "oui" && e3.family !== "géré directement", JSON.stringify(e3));

const e5 = evaluateEligibility(baseMessage, baseContext({ matchKind: null, rmTo: [SAMI_NAME] }), "renovationman.com");
check("E5 — pas de Salesforce, Sami seul interlocuteur RM : exclu", e5.verdict === "non" && e5.family === "géré directement", JSON.stringify(e5));

const e6 = evaluateEligibility(baseMessage, baseContext({ matchKind: null, rmTo: [SAMI_NAME, JONATHAN_NAME] }), "renovationman.com");
check("E6 — pas de Salesforce, Sami + Jonathan impliqués : pas exclu par cette règle", e6.family !== "géré directement", JSON.stringify(e6));

const e7 = evaluateEligibility(baseMessage, baseContext({ matchKind: null, rmTo: [JONATHAN_NAME] }), "renovationman.com");
check("E7 — pas de Salesforce, Jonathan seul : pas exclu par cette règle", e7.family !== "géré directement", JSON.stringify(e7));

const e8 = evaluateEligibility(baseMessage, baseContext({ matchKind: null, rmTo: null, rmCc: null }), "renovationman.com");
check("E8 — donnée absente : pas exclu par cette règle, aucune exception", e8.family !== "géré directement", JSON.stringify(e8));

const eLead = evaluateEligibility(baseMessage, baseContext({ matchKind: "piste", ownerName: SAMI_NAME, leadStatus: "Nouvelle" }), "renovationman.com");
check("piste de Sami : exclue au même titre qu'une opportunité", eLead.verdict === "non" && eLead.family === "géré directement");

section("E — intégration triage() : le verdict se répercute sur le bloc affiché");

const CHAUD = { subject: "Devis", summary: "Le devis nous convient. Comment lance-t-on les travaux ?" };
const ATTENTE = { subject: "Documents", summary: "Pouvez-vous me confirmer la reception des documents ?" };

const triageBase = {
  direction: "entrant",
  blocker: null,
  signal_type: "neutre",
  match_kind: "affaire_pipe",
  opportunity_stage: null,
  lead_status: null,
  stage: "Examen devis",
  is_terminal: 0,
  owner: null,
  ext_owner: null,
  lead_owner: null,
  rm_to: null,
  rm_cc: null,
};

const t1 = triage({ ...triageBase, ...CHAUD, owner: SAMI_NAME });
check("E1 — signal chaud, opportunité de Sami => PAS Bloc 1", t1.category !== "chaud", t1.category);

const t2 = triage({ ...triageBase, ...ATTENTE, owner: SAMI_NAME });
check("E2 — signal attente, opportunité de Sami => PAS Bloc 2", t2.category !== "attente", t2.category);

const t3 = triage({ ...triageBase, ...CHAUD, owner: JONATHAN_NAME, rm_cc: JSON.stringify([SAMI_NAME]) });
check("E3 — signal chaud, opportunité de Jonathan, Sami en copie => reste Bloc 1", t3.category === "chaud", t3.category);

const t4 = triage({ ...triageBase, ...ATTENTE, owner: JONATHAN_NAME, rm_cc: JSON.stringify([SAMI_NAME]) });
check("E4 — signal attente, opportunité de Jonathan, Sami en copie => reste Bloc 2", t4.category === "attente", t4.category);

const t5chaud = triage({ ...triageBase, ...CHAUD, match_kind: null, owner: null, rm_to: JSON.stringify([SAMI_NAME]) });
check("E5 — sans Salesforce, Sami seul, signal chaud => exclu", t5chaud.category !== "chaud", t5chaud.category);
const t5attente = triage({ ...triageBase, ...ATTENTE, match_kind: null, owner: null, rm_to: JSON.stringify([SAMI_NAME]) });
check("E5 — sans Salesforce, Sami seul, signal attente => exclu", t5attente.category !== "attente", t5attente.category);

const t8 = triage({ ...triageBase, ...CHAUD, owner: SAMI_NAME, rm_to: undefined, rm_cc: undefined });
check(
  "E8 — ancienne ligne (rm_to/rm_cc absents) : le rattachement Salesforce reste seul juge, ici toujours exclue via son propriétaire",
  t8.category !== "chaud",
);
const t8bis = triage({ ...triageBase, ...CHAUD, match_kind: null, owner: null, rm_to: undefined, rm_cc: undefined });
check(
  // Le contenu est « chaud », mais sans Salesforce ni destinataire connu,
  // l'expéditeur reste « entreprise inconnue » (incertain) : la règle
  // pré-existante rétrograde un chaud incertain en attente. C'est ce
  // comportement PRÉ-EXISTANT, sans lien avec E, qu'il ne faut pas confondre
  // avec une exclusion « géré directement » : seul `hors_perimetre` la trahirait.
  "E8bis — ancienne ligne SANS Salesforce ET sans destinataires connus : jamais exclue par la règle Sami (hors_perimetre)",
  t8bis.category !== "hors_perimetre",
  t8bis.category,
);

// ============================================================================
// E9 / E10 — Répercussion sur canonicalClientAttend()
// ============================================================================

section("E9 — une opportunité de Sami ne peut plus alimenter client_attend canonique");

const OPP_SAMI = "TESTOWNER_OPP_SAMI";
const MSG_SAMI = "TESTOWNER_MSG_SAMI";
db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES (?, 'Client Owner Sami', ?, 40000, 'Examen devis', 0, 0, 0, 1, 'normal', 0, 0, 0, ?, 0)`,
).run(OPP_SAMI, SAMI_NAME, now.slice(0, 10));

const tSami = triage({ ...triageBase, ...ATTENTE, owner: SAMI_NAME });
check("le triage exclut bien ce message (owner = Sami)", tSami.category !== "attente", tSami.category);

db.prepare(
  `INSERT INTO mail_signal
     (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
      filter_rule, opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
   VALUES (?, ?, ?, ?, 'Client Test', ?, 'entrant', 'conserve', ?, 'A', 'test', ?, 'neutre', ?, 0)`,
).run(MSG_SAMI, "TESTOWNER_THREAD_SAMI", now, CLIENT, ATTENTE.subject, OPP_SAMI, SAMI_NAME, ATTENTE.summary);
db.prepare(
  `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
   VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)`,
).run(MSG_SAMI, "TESTOWNER_THREAD_SAMI", now, tSami.category, tSami.ignoredBecause ?? tSami.reason, now);

check(
  "canonicalClientAttend() n'inclut PAS l'affaire de Sami",
  !canonicalClientAttend().has(OPP_SAMI),
);

section("E10 — une affaire d'un autre commercial reste éligible même avec Sami en copie");

const OPP_JONATHAN = "TESTOWNER_OPP_JONATHAN";
const MSG_JONATHAN = "TESTOWNER_MSG_JONATHAN";
db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES (?, 'Client Owner Jonathan', ?, 40000, 'Examen devis', 0, 0, 0, 1, 'normal', 0, 0, 0, ?, 0)`,
).run(OPP_JONATHAN, JONATHAN_NAME, now.slice(0, 10));

const tJonathan = triage({ ...triageBase, ...ATTENTE, owner: JONATHAN_NAME, rm_cc: JSON.stringify([SAMI_NAME]) });
check("le triage garde ce message éligible (owner = Jonathan, Sami en copie)", tJonathan.category === "attente", tJonathan.category);

db.prepare(
  `INSERT INTO mail_signal
     (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
      filter_rule, opportunity_id, match_level, match_reason, salesperson, signal_type, summary, rm_cc, sync_id)
   VALUES (?, ?, ?, ?, 'Client Test', ?, 'entrant', 'conserve', ?, 'A', 'test', ?, 'neutre', ?, ?, 0)`,
).run(MSG_JONATHAN, "TESTOWNER_THREAD_JONATHAN", now, CLIENT, ATTENTE.subject, OPP_JONATHAN, JONATHAN_NAME, ATTENTE.summary, JSON.stringify([SAMI_NAME]));
db.prepare(
  `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
   VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)`,
).run(MSG_JONATHAN, "TESTOWNER_THREAD_JONATHAN", now, tJonathan.category, tJonathan.reason, now);

check(
  "canonicalClientAttend() inclut bien l'affaire de Jonathan malgré Sami en copie",
  canonicalClientAttend().has(OPP_JONATHAN),
);

// --- Nettoyage ---------------------------------------------------------------

db.prepare("DELETE FROM opportunity WHERE opportunity_id IN (?, ?)").run(OPP_SAMI, OPP_JONATHAN);
db.prepare("DELETE FROM mail_signal WHERE gmail_message_id IN (?, ?)").run(MSG_SAMI, MSG_JONATHAN);
db.prepare("DELETE FROM morning_event WHERE gmail_message_id IN (?, ?)").run(MSG_SAMI, MSG_JONATHAN);

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

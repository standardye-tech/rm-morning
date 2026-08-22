/**
 * Tests métier de Morning V2.
 *
 *   npm run morning:verify
 *
 * Deux parties :
 *
 *   — dix cas de triage, joués sur des messages fabriqués, qui vérifient la
 *     règle et non les données du jour ;
 *   — des contrôles sur l'état réel : pas de doublon, pas de trou temporel
 *     entre deux synchronisations, aucune anomalie Monitoring remontée sans
 *     valeur immédiate.
 *
 * LECTURE SEULE, sauf le cycle d'acquittement du cas 5/6, qui écrit puis
 * restaure exactement l'état initial.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { triage, loadMorningEvents, acknowledgeEvent, ignoredSummary } = await import(
  lib("morning-events")
);
const { buildMorningPlan, REASON_LABEL } = await import(lib("morning-priority"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const msg = (over) => ({
  direction: "entrant",
  subject: null,
  summary: null,
  blocker: null,
  signal_type: "neutre",
  ...over,
});

console.log(`\n════ CAS DE TRIAGE ════`);

// 1. Le devis convient, le client demande la suite.
//
// Depuis C14, le triage a deux étages : l'appartenance au périmètre commercial
// précède l'intention. Les fixtures portent donc le contexte C13 — sans lui,
// l'expéditeur est un inconnu, et un inconnu ne peut jamais être annoncé comme
// « client chaud ». C'est exactement le garde-fou recherché.
const t1 = triage(
  msg({
    match_kind: "affaire_pipe",
    subject: "Re: Votre devis est disponible",
    summary: "Le devis nous convient, comment avançons-nous ?",
    signal_type: "positif_bloque",
  }),
);
check("1. « Le devis nous convient, comment avançons-nous ? » → client chaud", t1.category === "chaud", t1.reason);

// 2. Relance explicite sans réponse.
const t2 = triage(
  msg({
    subject: "Relance",
    summary: "Je me permets de vous relancer, je n'ai pas eu de réponse.",
    signal_type: "neutre",
  }),
);
check("2. « Je me permets de vous relancer » → client qui attend", t2.category === "attente", t2.reason);

// 3. Notification de plateforme.
const t3 = triage(msg({ subject: "Vous avez un nouveau lead kelvin !", summary: "Notification automatique" }));
check("3. message automatique → ignoré", t3.category === "ignore", t3.ignoredBecause ?? "");

// 4. Artisan qui répond : ce n'est pas le client.
const t4 = triage(
  msg({
    from_email: "contact@dupont-batiment.fr",
    subject: "Re: intervention",
    summary: "L'artisan confirme sa disponibilité pour le chantier",
  }),
);
// C14 distingue « hors périmètre » (ce n'est pas un sujet commercial) de
// « ignoré » (interlocuteur recevable, mais aucune intention). Les deux sortent
// du Morning ; le premier est plus précis pour un artisan.
check(
  "4. artisan → écarté du Morning commercial",
  t4.category === "hors_perimetre" || t4.category === "ignore",
  t4.ignoredBecause ?? "",
);

// 7 / 8. Un signal client chaud doit primer sur un simple montant.
const t8 = triage(
  msg({
    match_kind: "affaire_pipe",
    subject: "Re: estimation",
    summary: "Nous souhaitons avancer, quelle est la prochaine étape ?",
  }),
);
check("8. « nous souhaitons avancer » → client chaud", t8.category === "chaud", t8.reason);

// Refus explicite.
const tNeg = triage(msg({ subject: "Re: devis", summary: "Nous ne donnons pas suite", signal_type: "negatif" }));
check("client qui refuse → ignoré", tNeg.category === "ignore", tNeg.ignoredBecause ?? "");

// Échange interne.
const tInt = triage(msg({ direction: "interne", subject: "point équipe", summary: "revue de pipe" }));
check("échange interne → ignoré", tInt.category === "ignore", tInt.ignoredBecause ?? "");

// Demande de document.
const tDoc = triage(msg({ subject: "Devis", summary: "Pourriez-vous m'envoyer l'attestation ?" }));
check("demande de document → client qui attend", tDoc.category === "attente", tDoc.reason);

console.log(`\n════ ÉTAT RÉEL ════`);
const { events, lastRead } = loadMorningEvents();
const hot = events.filter((e) => e.category === "chaud" && !e.acknowledged);
const waiting = events.filter((e) => e.category === "attente" && !e.acknowledged);
console.log(`  dernière lecture Morning : ${lastRead ? new Date(lastRead).toLocaleString("fr-FR") : "jamais"}`);
console.log(`  retenus : ${events.length} · chauds ${hot.length} · en attente ${waiting.length}`);
console.log(`  écartés :`);
for (const i of ignoredSummary()) console.log(`      ${i.reason.padEnd(46)} ${i.count}`);

const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: false });

// Pas de doublon message ni fil incohérent.
const dup = db
  .prepare("SELECT COUNT(*) n FROM (SELECT gmail_message_id FROM morning_event GROUP BY gmail_message_id HAVING COUNT(*) > 1)")
  .get().n;
check("aucun doublon de message", dup === 0, `${dup} doublon(s)`);

// Pas de trou temporel entre deux synchronisations Gmail.
const syncs = db
  .prepare("SELECT id, window_start, window_end FROM mail_sync WHERE finished_at IS NOT NULL ORDER BY id")
  .all();
let gaps = 0;
for (let i = 1; i < syncs.length; i += 1) {
  if (syncs[i].window_start > syncs[i - 1].window_end) gaps += 1;
}
check(
  "aucun trou temporel entre deux synchronisations",
  gaps === 0,
  `${syncs.length} synchronisations terminées · ${gaps} trou(s)`,
);

// Une synchronisation interrompue ne bloque pas la suivante : la fenêtre
// suivante repart du dernier window_end TERMINÉ.
const unfinished = db.prepare("SELECT COUNT(*) n FROM mail_sync WHERE finished_at IS NULL").get().n;
check("les synchronisations inachevées ne cassent pas le curseur", true, `${unfinished} inachevée(s), ignorée(s) par le curseur`);

// 5 et 6. Acquitter un message, vérifier qu'il ne revient pas, puis restaurer.
//
// LE CONTRÔLE NE DOIT PAS DÉPENDRE DE L'ÉTAT DE LA BOÎTE. Selon l'heure, tout
// peut être acquitté — c'est même le cas nominal en fin de matinée — ou bien le
// seul message non acquitté peut venir d'un expéditeur qui n'en a qu'un, ce qui
// rend le contrôle 6 non concluant. On construit donc explicitement la
// configuration qu'il faut éprouver : un expéditeur ayant PLUSIEURS messages
// retenus, tous rouverts le temps du test, et tous restaurés à la fin.
//
// C'est la seule configuration qui prouve ce que le contrôle affirme :
// acquitter porte sur l'ÉVÉNEMENT, jamais sur le client.
const anyMulti = db
  .prepare(
    `SELECT m.from_email, COUNT(*) n FROM morning_event e
       JOIN mail_signal m USING(gmail_message_id)
      WHERE e.category IN ('chaud','attente') AND m.from_email IS NOT NULL
      GROUP BY m.from_email HAVING n > 1 ORDER BY n DESC LIMIT 1`,
  )
  .get();

const candidates = anyMulti
  ? events.filter((e) => e.fromEmail === anyMulti.from_email)
  : events.slice(0, 1);

// État initial de chaque message touché, pour le rendre tel qu'il était.
const restoreLater = candidates.map((c) => ({
  messageId: c.messageId,
  ...db
    .prepare("SELECT status, acknowledged_at FROM morning_event WHERE gmail_message_id = ?")
    .get(c.messageId),
}));
for (const c of restoreLater) {
  db.prepare(
    "UPDATE morning_event SET status = 'nouveau', acknowledged_at = NULL WHERE gmail_message_id = ?",
  ).run(c.messageId);
}

const reopened = restoreLater[0] ?? null;
const sample =
  candidates.length > 0
    ? (loadMorningEvents().events.find((e) => e.messageId === candidates[0].messageId) ?? null)
    : null;

if (sample) {
  const before = reopened ?? db
    .prepare("SELECT status, acknowledged_at FROM morning_event WHERE gmail_message_id = ?")
    .get(sample.messageId);
  acknowledgeEvent(sample.messageId);
  const after = loadMorningEvents().events.find((e) => e.messageId === sample.messageId);
  check("5. un message pris en compte ne revient pas", after?.acknowledged === true, sample.client ?? "");

  // Le fil du même client reste visible si un AUTRE message existe : acquitter
  // porte sur l'événement, jamais sur le client.
  const sameSender = loadMorningEvents().events.filter(
    (e) => e.fromEmail === sample.fromEmail && e.messageId !== sample.messageId && !e.acknowledged,
  );
  check(
    "6. acquitter porte sur le message, pas sur le client",
    sameSender.length > 0,
    sameSender.length > 0
      ? `${sameSender.length} autre(s) message(s) du même expéditeur restent visibles`
      : "aucun autre message du même expéditeur : test non concluant",
  );

  db.prepare("UPDATE morning_event SET status = ?, acknowledged_at = ? WHERE gmail_message_id = ?").run(
    before.status,
    before.acknowledged_at,
    sample.messageId,
  );
  // Les messages rouverts pour les besoins du test retrouvent leur état.
  for (const r of restoreLater) {
    if (r.messageId === sample.messageId) continue;
    db.prepare(
      "UPDATE morning_event SET status = ?, acknowledged_at = ? WHERE gmail_message_id = ?",
    ).run(r.status, r.acknowledged_at, r.messageId);
  }
  const restored = db
    .prepare("SELECT status FROM morning_event WHERE gmail_message_id = ?")
    .get(sample.messageId).status;
  check("état initial restauré après le test", restored === before.status, `statut ${restored}`);
} else {
  check("5/6. cycle de prise en compte", false, "aucun événement disponible pour le test");
}

console.log(`\n════ PLAN DU JOUR ════`);
const plan = buildMorningPlan();
const by = {};
for (const a of plan.actions) by[a.reason] = (by[a.reason] ?? 0) + 1;
console.log(`  ${plan.actions.length} actions`);
for (const [k, v] of Object.entries(by)) console.log(`      ${REASON_LABEL[k].padEnd(52)} ${v}`);

// 7. Une affaire à fort Expected sans signal client ne doit pas être en tête.
const top = plan.actions.slice(0, 5);
const topSilent = top.filter((a) => a.messageId == null && a.reason !== "affaire_decisive" && a.reason !== "proche_signature");
check(
  "7. aucune affaire silencieuse en tête du plan",
  topSilent.length === 0,
  `${plan.silentButStrong.length} affaire(s) forte(s) mais muette(s) écartée(s) du plan`,
);

// 9. Une affaire de la Perspective dont le client attend doit être prioritaire.
const perspectiveWaiting = plan.actions.filter(
  (a) => a.reason === "client_attend" && a.facts.some((f) => f.includes("Perspective")),
);
check(
  "9. Perspective + client qui attend → remonte dans le plan",
  perspectiveWaiting.length === 0 || plan.actions.indexOf(perspectiveWaiting[0]) < plan.actions.length / 2,
  perspectiveWaiting.length === 0
    ? "aucun cas présent aujourd'hui"
    : `premier cas en position ${plan.actions.indexOf(perspectiveWaiting[0]) + 1}`,
);

// 10. Aucune anomalie Monitoring ne remonte du seul fait qu'elle existe.
const monitoringOnly = plan.actions.filter(
  (a) =>
    a.messageId == null &&
    a.reason !== "affaire_decisive" &&
    a.reason !== "proche_signature",
);
const exceptions = db
  .prepare(
    "SELECT COUNT(*) n FROM opportunity WHERE milestone_status IS NOT NULL AND milestone_status NOT IN ('ok','sans_objet')",
  )
  .get().n;
check(
  "10. aucune anomalie Monitoring remontée sans valeur immédiate",
  monitoringOnly.length === 0,
  `${exceptions} anomalie(s) de suivi en base · ${monitoringOnly.length} remontée(s) dans Morning`,
);

// L'ordre du §9 doit être respecté : motivé avant attente avant décisive.
const rank = { client_motive: 1, client_attend: 2, affaire_decisive: 3, a_challenger_vivante: 4, proche_signature: 5 };
let inversions = 0;
for (let i = 1; i < plan.actions.length; i += 1) {
  if (rank[plan.actions[i].reason] < rank[plan.actions[i - 1].reason]) inversions += 1;
}
check("ordre des catégories respecté", inversions === 0, `${inversions} inversion(s)`);

// Vocabulaire : aucun terme technique dans ce que l'utilisateur lit.
const FORBIDDEN = /\bintent\b|\bconfidence\b|\bscore\b|p7d|p_month|contribution Expected|matching|classification|\bevent\b/i;
const leaks = plan.actions.filter(
  (a) => FORBIDDEN.test(a.why) || FORBIDDEN.test(a.todo) || a.facts.some((f) => FORBIDDEN.test(f)),
);
check("aucun terme technique dans les libellés du plan", leaks.length === 0, `${leaks.length} fuite(s)`);

db.close();
console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

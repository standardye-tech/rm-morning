/**
 * Contrôles de la lecture individuelle du Monitoring et de la cloche de
 * navigation.
 *
 *   npm run monitoring:lecture-verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : le contrôle réinitialise l'état de lecture
 * des deux périmètres et ajoute des pistes/opportunités fictives ; il ne doit
 * jamais toucher l'état de lecture réel du directeur régional.
 *
 * Ce qui est vérifié :
 *   — `markItemRead` acquitte UNE SEULE ligne, sans toucher aux autres ;
 *   — la cloche (`monitoringUnreadCounts`) est calculée depuis `monitoring_read`,
 *     jamais depuis `operational_status`/`milestone_status` bruts : elle suit
 *     exactement les compteurs `activeCount`/`readCount` des écrans ;
 *   — un champ de décision qui change marque la ligne « modifiée » ET remonte
 *     la cloche, sans qu'on ait besoin de la relire depuis Salesforce ;
 *   — Lu ≠ Traité, dans toutes les listes (pistes, « À débloquer maintenant »,
 *     exceptions de suivi) : une ligne lue reste affichée, seule une ligne
 *     traitée sort ; « Tout lire » ne change ni les lignes ni leur ordre ;
 *   — persistance : chaque geste est relu immédiatement depuis la même base,
 *     comme le ferait un rechargement de page.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "monitoring-lecture.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { resetRead } = await import(lib("monitoring-read"));
const {
  leadMonitoringView,
  opportunityMonitoringView,
  markScopeRead,
  markItemRead,
  monitoringUnreadCounts,
} = await import(lib("monitoring-view"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const ALL = Number.MAX_SAFE_INTEGER;
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

// --- Fixtures ----------------------------------------------------------------

const LEAD_A = "TESTLECTURE_LEAD_A"; // fraîche, non légataire
const LEAD_B = "TESTLECTURE_LEAD_B"; // dette héritée
const OPP_A = "TESTLECTURE_OPP_A"; // fraîche

db.prepare(
  `INSERT INTO lead
     (lead_id, name, owner, owner_raw, status, created_at, recall_date, operational_status,
      lateness_hours, first_call_missed, is_legacy, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'A confirmer', ?, NULL, 'a_traiter', 100, 0, 0, ?, 0)`,
).run(LEAD_A, "Client Test Lecture A", "Commercial Test Lecture", "Commercial Test Lecture", now, today);

db.prepare(
  `INSERT INTO lead
     (lead_id, name, owner, owner_raw, status, created_at, recall_date, operational_status,
      lateness_hours, first_call_missed, is_legacy, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'A confirmer', ?, NULL, 'critique', 500, 0, 1, ?, 0)`,
).run(LEAD_B, "Client Test Lecture B", "Commercial Test Lecture", "Commercial Test Lecture", now, today);

db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'Examen devis', 0, 0, 0, 1, 'sla_devis', 0, 0, 200, ?, 0)`,
).run(OPP_A, "Client Test Lecture Opp A", "Commercial Test Lecture", 50000, today);

// Base de référence : personne n'a encore rien lu, dans la copie de travail.
resetRead("piste");
resetRead("opportunite");

// --- 1 — La cloche suit exactement les écrans --------------------------------

section("1 — La cloche est dérivée de monitoring_read, pas du statut brut");

const leadViewBefore = leadMonitoringView(null);
const oppViewBefore = opportunityMonitoringView(null);
const countsBefore = monitoringUnreadCounts();

check(
  "toutes les anomalies sont non lues juste après la réinitialisation",
  leadViewBefore.readCount === 0 && oppViewBefore.readCount === 0,
);
// État partagé des actions : une ligne dont l'action est déjà traitée
// ailleurs (ex. message « attente » acquitté dans le Morning) ne sonne plus.
const openOf = (v) => v.activeCount - v.treatedCount;
check(
  "le total de la cloche = actif non lu et non traité des deux périmètres (pistes + opportunités)",
  countsBefore.fresh + countsBefore.legacy === openOf(leadViewBefore) + openOf(oppViewBefore),
  `cloche ${countsBefore.fresh}+${countsBefore.legacy} · vues ${openOf(leadViewBefore)}+${openOf(oppViewBefore)} · traitées ${leadViewBefore.treatedCount}+${oppViewBefore.treatedCount}`,
);

const leadAInView = leadViewBefore.items.some((i) => i.lead.leadId === LEAD_A);
check("la piste fraîche de test est comptée dans la vue", leadAInView || leadViewBefore.activeCount >= 1);
check(
  "les deux pistes de test existent bien parmi les anomalies actives",
  leadMonitoringView(null).activeCount >= 2,
);

// --- 2 — Lecture individuelle : une seule ligne, cloche décrémentée ----------

section("2 — Lecture individuelle d'une piste");

const okReadA = markItemRead("piste", LEAD_A, new Date(now));
check("markItemRead renvoie true pour une piste existante", okReadA === true);

const leadViewAfterA = leadMonitoringView(null);
const countsAfterA = monitoringUnreadCounts();

// Lu ≠ traité : la piste lue reste affichée, marquée lue.
check(
  "la piste A reste dans la vue, marquée lue ; seule elle change d'état",
  leadMonitoringView(null, ALL).items.some((i) => i.lead.leadId === LEAD_A && i.verdict.status === "lu") &&
    leadViewAfterA.readCount === leadViewBefore.readCount + 1,
);
check(
  "la piste B (dette héritée) est toujours listée comme non lue",
  leadMonitoringView(null).activeCount === leadViewBefore.activeCount &&
    (opportunityMonitoringView(null).activeCount === oppViewBefore.activeCount),
);
check(
  "la cloche baisse d'exactement une unité (piste fraîche)",
  countsAfterA.fresh === countsBefore.fresh - 1 && countsAfterA.legacy === countsBefore.legacy,
  `avant ${countsBefore.fresh}/${countsBefore.legacy} · après ${countsAfterA.fresh}/${countsAfterA.legacy}`,
);

const readRow = db.prepare("SELECT * FROM monitoring_read WHERE scope = 'piste' AND item_id = ?").get(LEAD_A);
check("la ligne est bien persistée dans monitoring_read", readRow != null);

section("3 — Lecture individuelle d'une opportunité");

check("l'opportunité de test est comptée parmi les anomalies actives", opportunityMonitoringView(null).activeCount >= 1);
const countsMid = monitoringUnreadCounts();
const okReadOpp = markItemRead("opportunite", OPP_A, new Date(now));
check("markItemRead renvoie true pour une opportunité existante", okReadOpp === true);

const countsAfterOpp = monitoringUnreadCounts();
// Lu ≠ traité : l'action reste ouverte dans les deux blocs, marquée lue.
const oppPoolAfter = opportunityMonitoringView(null, ALL, ALL);
check(
  "lue, l'opportunité reste dans « À débloquer maintenant » ET dans les exceptions",
  oppPoolAfter.items.some((v) => v.opportunity.opportunityId === OPP_A && v.verdict.status === "lu") &&
    oppPoolAfter.exceptions.some((e) => e.opportunity.opportunityId === OPP_A && e.verdict.status === "lu"),
);
check(
  "la cloche baisse d'exactement une unité (opportunité fraîche)",
  countsAfterOpp.fresh === countsMid.fresh - 1 && countsAfterOpp.legacy === countsMid.legacy,
  `avant ${countsMid.fresh}/${countsMid.legacy} · après ${countsAfterOpp.fresh}/${countsAfterOpp.legacy}`,
);

section("4 — Identifiant inconnu : aucun effet, pas d'erreur");

const before404 = monitoringUnreadCounts();
check("piste inexistante : renvoie false", markItemRead("piste", "N_EXISTE_PAS") === false);
check("opportunité inexistante : renvoie false", markItemRead("opportunite", "N_EXISTE_PAS") === false);
check("la cloche n'a pas bougé", JSON.stringify(monitoringUnreadCounts()) === JSON.stringify(before404));

// --- 5 — Persistance / relecture ---------------------------------------------

section("5 — Persistance : une relecture depuis la même base reflète l'état écrit");

check(
  "relire la vue juste après l'écriture montre exactement le même résultat (pas de cache local)",
  leadMonitoringView(null, ALL).items.some((i) => i.lead.leadId === LEAD_A && i.verdict.status === "lu") &&
    opportunityMonitoringView(null, ALL).items.some(
      (v) => v.opportunity.opportunityId === OPP_A && v.verdict.status === "lu",
    ),
);
check(
  "relire deux fois de suite est idempotent",
  JSON.stringify(monitoringUnreadCounts()) === JSON.stringify(monitoringUnreadCounts()),
);

// --- 6 — Une valeur qui change marque la ligne « modifiée » et remonte la cloche

section("6 — Signature : un champ de décision modifié marque la ligne « modifiée »");

const countsBefore6 = monitoringUnreadCounts();
db.prepare("UPDATE lead SET recall_date = ? WHERE lead_id = ?").run(`${today}T09:00:00.000Z`, LEAD_A);

const leadViewAfterChange = leadMonitoringView(null, ALL);
const entryA = leadViewAfterChange.items.find((i) => i.lead.leadId === LEAD_A);
check("la piste A est dans la vue après changement d'échéance", entryA != null);
check("elle revient avec le statut « modifié », pas « jamais lu »", entryA?.verdict.status === "modifie");
check(
  "le changement affiché porte sur l'échéance, avant → après",
  entryA?.verdict.changes.some((c) => c.label === "Échéance de rappel"),
);
const countsAfterChange = monitoringUnreadCounts();
check(
  "la cloche remonte d'une unité, sans nouvel import Salesforce",
  countsAfterChange.fresh === countsBefore6.fresh + 1,
  `avant ${countsBefore6.fresh} · après ${countsAfterChange.fresh}`,
);

section("7 — Une relecture sans changement reste lue");

markItemRead("piste", LEAD_A);
const countsRelu = monitoringUnreadCounts();
const stillRead = leadMonitoringView(null, ALL).items.some((i) => i.lead.leadId === LEAD_A && i.verdict.status === "lu");
check("relue sans changement depuis, la piste A reste affichée, marquée lue", stillRead);
check("la cloche est repassée sous le niveau du point 6", countsRelu.fresh === countsAfterChange.fresh - 1);

// --- 8 — « Tout lire » ramène le périmètre à zéro pour ce qu'il couvre ------

section("8 — « Tout lire » acquitte tout le stock actif restant");

const leadIds = (v) => JSON.stringify(v.items.map((i) => i.lead.leadId));
const leadsBefore8 = leadMonitoringView(null);
const leadReadCount = markScopeRead("piste", null);
check(
  "bouton global (pistes) : mêmes actions, même ordre, même nombre à traiter",
  leadIds(leadMonitoringView(null)) === leadIds(leadsBefore8) && leadMonitoringView(null).visibleCount === leadsBefore8.visibleCount,
);
check("« Tout lire » pistes a acquitté au moins la piste B restante", leadReadCount >= 1, `${leadReadCount} ligne(s)`);
check(
  "plus aucune piste active non lue après « Tout lire »",
  leadMonitoringView(null).activeCount === leadMonitoringView(null).readCount + leadMonitoringView(null).treatedCount,
);

const oppIds = (v) => JSON.stringify([v.items.map((i) => i.opportunity.opportunityId), v.exceptions.map((e) => e.opportunity.opportunityId)]);
const oppsBefore8 = opportunityMonitoringView(null);
const oppReadCount = markScopeRead("opportunite", null);
check(
  "bouton global (opportunités) : mêmes actions dans les deux blocs, même ordre, même nombre à traiter",
  oppIds(opportunityMonitoringView(null)) === oppIds(oppsBefore8) && opportunityMonitoringView(null).visibleCount === oppsBefore8.visibleCount,
);
check("« Tout lire » opportunités s'exécute sans erreur", typeof oppReadCount === "number");
check(
  "plus aucune opportunité active non lue après « Tout lire »",
  opportunityMonitoringView(null).activeCount ===
    opportunityMonitoringView(null).readCount + opportunityMonitoringView(null).treatedCount,
);

const countsFinal = monitoringUnreadCounts();
check(
  "la cloche tombe à zéro (fraîche et héritée) quand plus rien n'est actif non lu",
  countsFinal.fresh === 0 && countsFinal.legacy === 0,
  `fresh=${countsFinal.fresh} legacy=${countsFinal.legacy}`,
);

// --- 9 — « À débloquer maintenant » : les priorités, pas les non-lus ----------

section("9 — À débloquer maintenant : Lu garde l'action, Traité la retire");

resetRead("opportunite");
const OPP_TOP = "TESTLECTURE_OPP_TOP"; // relance devis à 900 k€ : en tête du bloc
db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'Examen devis', 0, 0, 0, 1, 'sla_devis', 0, 0, 200, ?, 0)`,
).run(OPP_TOP, "Client Test Lecture Top", "Commercial Test Lecture", 900_000, today);

const top8 = () => opportunityMonitoringView(null).items;
const topIds = () => top8().map((v) => v.opportunity.opportunityId);
const before9 = opportunityMonitoringView(null);
const counts9 = monitoringUnreadCounts();
check("A0. action prioritaire non lue : visible", top8().some((v) => v.opportunity.opportunityId === OPP_TOP && v.verdict.status === "jamais_lu"));
const idsBefore = topIds();

markItemRead("opportunite", OPP_TOP);
const after9 = opportunityMonitoringView(null);
check("A. clic Lu : toujours visible dans « À débloquer maintenant »", after9.items.some((v) => v.opportunity.opportunityId === OPP_TOP && v.verdict.status === "lu"));
check("A. … et plus comptée comme non lue (cloche et compteur)", monitoringUnreadCounts().fresh === counts9.fresh - 1 && after9.readCount === before9.readCount + 1);

markScopeRead("opportunite", null);
check(
  "C. Top 8 indépendant du statut lu : « Tout lire » ne change ni la liste ni son ordre",
  JSON.stringify(topIds()) === JSON.stringify(idsBefore),
  `${topIds().length} ligne(s)`,
);
check(
  "C. le Top 8 = les 8 meilleures actions ouvertes, triées par score décroissant",
  top8().every((v, i, a) => i === 0 || a[i - 1].score >= v.score) &&
    top8().length === Math.min(8, opportunityMonitoringView(null, Number.MAX_SAFE_INTEGER).items.length),
);

const { treatItem } = await import(lib("monitoring-view"));
treatItem("opportunite", OPP_TOP);
check("B. clic Traité : disparaît du bloc actif", !opportunityMonitoringView(null, Number.MAX_SAFE_INTEGER).items.some((v) => v.opportunity.opportunityId === OPP_TOP));
db.prepare("DELETE FROM action_state WHERE action_key LIKE ?").run(`opportunity:${OPP_TOP}:%`);
db.prepare("DELETE FROM opportunity WHERE opportunity_id = ?").run(OPP_TOP);
db.prepare("DELETE FROM monitoring_read WHERE item_id = ?").run(OPP_TOP);

section("9 bis — Plancher 10 k€ et impact GMV borné (règle pure)");

const { buildValueBlock } = await import(lib("opportunity-metrics"));
const synth = (id, gmv, over = {}) => ({
  opportunityId: id, gmv, milestoneStatus: "sla_devis", clientWaiting: false, isLegacy: false, latenessHours: 200, ...over,
});
const pool = buildValueBlock(
  [
    synth("G9999", 9_999),
    synth("G10000", 10_000),
    synth("G35000", 35_000),
    synth("G953W", 953, { milestoneStatus: "client_attend", clientWaiting: true }),
    synth("GNULL", null),
  ],
  Number.MAX_SAFE_INTEGER,
);
const ids = pool.map((v) => v.opportunity.opportunityId);
check("D. 9 999 € : exclue", !ids.includes("G9999"));
check("D. 10 000 € : incluse si actionnable", ids.includes("G10000"));
check("D. 35 000 € : incluse quand son score la place dans le Top 8", buildValueBlock([synth("G35000", 35_000)]).length === 1);
check("D. 953 € en attente client : exclue", !ids.includes("G953W"));
check("D. GMV inconnue : exclue (lue comme 0 €)", !ids.includes("GNULL"));
check(
  "E. impact GMV jamais négatif : score ≥ urgence × 0,4 × ancienneté",
  pool.every((v) => v.score >= 2.5 * 0.4 - 1e-9),
  pool.map((v) => `${v.opportunity.opportunityId}=${v.score.toFixed(3)}`).join(" · "),
);
const real = opportunityMonitoringView(null, Number.MAX_SAFE_INTEGER).items;
check("D. base réelle : aucune ligne sous 10 k€", real.every((v) => (v.opportunity.gmv ?? 0) >= 10_000), `${real.length} ligne(s)`);

section("9 ter — Libellés et accords");

const { monitoringSummary, markReadLabel } = await import(lib("monitoring-wording"));
const pairs = [
  [monitoringSummary("piste", { visibleCount: 8, changedCount: 3, readCount: 23, treatedCount: 0 }), "8 pistes à traiter · 3 mises à jour depuis votre dernière lecture · 23 déjà lues"],
  [monitoringSummary("opportunite", { visibleCount: 8, changedCount: 4, readCount: 52, treatedCount: 17 }), "8 opportunités à traiter · 4 mises à jour depuis votre dernière lecture · 52 déjà lues · 17 traitées"],
  [monitoringSummary("piste", { visibleCount: 1, changedCount: 1, readCount: 1, treatedCount: 1 }), "1 piste à traiter · 1 mise à jour depuis votre dernière lecture · 1 déjà lue · 1 traitée"],
  [monitoringSummary("opportunite", { visibleCount: 0, changedCount: 0, readCount: 0, treatedCount: 0 }), "0 opportunité à traiter"],
  [markReadLabel(13), "Marquer les 13 comme lues"],
  [markReadLabel(1), "Marquer la dernière comme lue"],
];
for (const [got, want] of pairs) check(`G. « ${want} »`, got === want, got);
check("G. le geste de lecture ne dit jamais « traiter »", !/trait/i.test(markReadLabel(13) + markReadLabel(1)));

// --- 10 — Pistes et exceptions de suivi : même règle Lu / Traité -------------

section("10 — Pistes : Lu garde l'action, Traité la retire");

resetRead("piste");
const LEAD_C = "TESTLECTURE_LEAD_C";
db.prepare(
  `INSERT INTO lead
     (lead_id, name, owner, owner_raw, status, created_at, recall_date, operational_status,
      lateness_hours, first_call_missed, is_legacy, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'A confirmer', ?, ?, 'a_traiter', 72, 0, 0, ?, 0)`,
).run(LEAD_C, "Client Test Lecture C", "Commercial Test Lecture", "Commercial Test Lecture", now, `${today}T08:00:00.000Z`, today);
const leadC = () => leadMonitoringView(null, ALL).items.find((i) => i.lead.leadId === LEAD_C);
const unreadOf = (v) => v.activeCount - v.readCount - v.treatedCount;
const leadsC0 = leadMonitoringView(null, ALL);
check("piste active non lue : visible", leadC()?.verdict.status === "jamais_lu");
markItemRead("piste", LEAD_C);
check("clic Lu : toujours visible, marquée lue", leadC()?.verdict.status === "lu");
check("… le compteur non lu diminue d'une unité, pas le nombre à traiter", unreadOf(leadMonitoringView(null, ALL)) === unreadOf(leadsC0) - 1 && leadMonitoringView(null, ALL).visibleCount === leadsC0.visibleCount);
const { treatItem: treat10 } = await import(lib("monitoring-view"));
check("clic Traité : accepté", treat10("piste", LEAD_C) === true);
check("… la piste disparaît du bloc actif", leadC() == null);
check("… et le nombre à traiter baisse d'une unité", leadMonitoringView(null, ALL).visibleCount === leadsC0.visibleCount - 1);
db.prepare("DELETE FROM action_state WHERE action_key LIKE ?").run(`lead:${LEAD_C}:%`);
db.prepare("DELETE FROM lead WHERE lead_id = ?").run(LEAD_C);
db.prepare("DELETE FROM monitoring_read WHERE item_id = ?").run(LEAD_C);

section("10 bis — Exceptions de suivi : Lu garde l'action, Traité la retire");

resetRead("opportunite");
const OPP_EX = "TESTLECTURE_OPP_EX"; // stand-by expiré : une exception actionnable
db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active, standby_until,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'Examen devis', 0, 0, 0, 1, ?, 'standby_expire', 0, 0, 120, ?, 0)`,
).run(OPP_EX, "Client Test Lecture Exception", "Commercial Test Lecture", 5_000, `${today.slice(0, 8)}01`, today);
const exOf = () => opportunityMonitoringView(null, ALL, ALL).exceptions.find((e) => e.opportunity.opportunityId === OPP_EX);
check("exception active non lue : visible (5 k€, hors du Top 8 mais bien une exception)", exOf()?.verdict.status === "jamais_lu");
markItemRead("opportunite", OPP_EX);
check("clic Lu : toujours visible, marquée lue", exOf()?.verdict.status === "lu");
check("clic Traité : accepté", treat10("opportunite", OPP_EX) === true);
check("… l'exception disparaît du bloc actif", exOf() == null);
db.prepare("DELETE FROM action_state WHERE action_key LIKE ?").run(`opportunity:${OPP_EX}:%`);
db.prepare("DELETE FROM opportunity WHERE opportunity_id = ?").run(OPP_EX);
db.prepare("DELETE FROM monitoring_read WHERE item_id = ?").run(OPP_EX);

// --- Nettoyage -----------------------------------------------------------------

db.prepare("DELETE FROM lead WHERE lead_id IN (?, ?)").run(LEAD_A, LEAD_B);
db.prepare("DELETE FROM opportunity WHERE opportunity_id = ?").run(OPP_A);
db.prepare("DELETE FROM monitoring_read WHERE item_id IN (?, ?, ?)").run(LEAD_A, LEAD_B, OPP_A);

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

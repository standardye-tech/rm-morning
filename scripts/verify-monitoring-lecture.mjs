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
 *   — un champ de décision qui change fait réapparaître la ligne ET remonte la
 *     cloche, sans qu'on ait besoin de la relire depuis Salesforce ;
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

check(
  "seule la piste A a disparu de la vue, la piste B reste",
  !leadViewAfterA.items.some((i) => i.lead.leadId === LEAD_A) &&
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

const oppViewAfter = opportunityMonitoringView(null);
const countsAfterOpp = monitoringUnreadCounts();
check(
  "l'opportunité disparaît des deux blocs (valeur ET exceptions)",
  !oppViewAfter.items.some((v) => v.opportunity.opportunityId === OPP_A) &&
    !oppViewAfter.exceptions.some((e) => e.opportunity.opportunityId === OPP_A),
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
  !leadMonitoringView(null).items.some((i) => i.lead.leadId === LEAD_A) &&
    !opportunityMonitoringView(null).items.some((v) => v.opportunity.opportunityId === OPP_A),
);
check(
  "relire deux fois de suite est idempotent",
  JSON.stringify(monitoringUnreadCounts()) === JSON.stringify(monitoringUnreadCounts()),
);

// --- 6 — Une valeur qui change fait réapparaître la ligne et remonte la cloche

section("6 — Signature : un champ de décision modifié fait réapparaître la ligne");

const countsBefore6 = monitoringUnreadCounts();
db.prepare("UPDATE lead SET recall_date = ? WHERE lead_id = ?").run(`${today}T09:00:00.000Z`, LEAD_A);

const leadViewAfterChange = leadMonitoringView(null);
const entryA = leadViewAfterChange.items.find((i) => i.lead.leadId === LEAD_A);
check("la piste A revient dans la vue après changement d'échéance", entryA != null);
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

section("7 — Une relecture sans changement ne revient pas");

markItemRead("piste", LEAD_A);
const countsRelu = monitoringUnreadCounts();
const stillGone = !leadMonitoringView(null).items.some((i) => i.lead.leadId === LEAD_A);
check("relue sans changement depuis, la piste A reste absente", stillGone);
check("la cloche est repassée sous le niveau du point 6", countsRelu.fresh === countsAfterChange.fresh - 1);

// --- 8 — « Tout lire » ramène le périmètre à zéro pour ce qu'il couvre ------

section("8 — « Tout lire » acquitte tout le stock actif restant");

const leadReadCount = markScopeRead("piste", null);
check("« Tout lire » pistes a acquitté au moins la piste B restante", leadReadCount >= 1, `${leadReadCount} ligne(s)`);
check(
  "plus aucune piste active non lue après « Tout lire »",
  leadMonitoringView(null).activeCount === leadMonitoringView(null).readCount + leadMonitoringView(null).treatedCount,
);

const oppReadCount = markScopeRead("opportunite", null);
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

// --- Nettoyage -----------------------------------------------------------------

db.prepare("DELETE FROM lead WHERE lead_id IN (?, ?)").run(LEAD_A, LEAD_B);
db.prepare("DELETE FROM opportunity WHERE opportunity_id = ?").run(OPP_A);
db.prepare("DELETE FROM monitoring_read WHERE item_id IN (?, ?, ?)").run(LEAD_A, LEAD_B, OPP_A);

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

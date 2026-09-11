/**
 * Contrôle du périmètre du verdict Monitoring par commercial.
 *
 *   npm run monitoring:verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : le contrôle ajoute un commercial et des
 * opportunités fictives, et ne doit rien laisser dans les données du directeur.
 *
 * Ce qui est vérifié : `computeOpportunityMetrics` prend son périmètre dans la
 * table `team_member` — la source de vérité gérée depuis l'écran Données — et
 * non dans la graine TEAM de config.ts. Un commercial ajouté en base mais absent
 * de la graine reçoit un verdict ; un commercial inactif ou hors périmètre n'en
 * reçoit pas ; les commerciaux historiques gardent exactement le leur.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "monitoring-perimetre.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { TEAM, TEAM_SEED_INACTIVE } = await import(lib("config"));
const { getDb } = await import(lib("db"));
const { loadTeam, addTeamMember, allTeamMembers } = await import(lib("team-store"));
const { computeOpportunityMetrics, loadMilestoneOpportunities } = await import(lib("opportunity-metrics"));
const { MILESTONE_ANOMALIES } = await import(lib("opportunity-milestones"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

/**
 * Recalcul À LA MAIN du verdict, avec la règle telle qu'elle est écrite dans
 * opportunity-metrics.ts. Sert à prouver que les valeurs sont celles attendues,
 * indépendamment du périmètre utilisé.
 */
function handVerdict(mine) {
  const fresh = mine.filter((o) => MILESTONE_ANOMALIES.includes(o.milestoneStatus) && !o.isLegacy).length;
  const ratio = mine.length > 0 ? fresh / mine.length : 0;
  return fresh >= 3 && ratio > 0.15 ? "action requise" : fresh >= 1 ? "à surveiller" : "sain";
}

// --- M1 — Périmètre = team_member, pas la graine ---------------------------

section("M1 — Le périmètre du verdict est celui de team_member");

const team = loadTeam();
const before = computeOpportunityMetrics(loadMilestoneOpportunities());
const names = before.owners.map((o) => o.owner);

check("une ligne par membre ACTIF de team_member", names.length === team.length && team.every((m) => names.includes(m.name)), `${names.length} lignes pour ${team.length} membres actifs`);
check("aucune ligne pour un commercial absent de team_member", names.every((n) => team.some((m) => m.name === n)));

const inactiveSeed = TEAM.filter((m) => TEAM_SEED_INACTIVE.includes(m.name)).map((m) => m.name);
const retired = allTeamMembers().filter((m) => !m.active).map((m) => m.name);
check(
  "un membre de la graine retiré du périmètre n'a plus de ligne",
  [...inactiveSeed, ...retired].every((n) => !names.includes(n)),
  [...new Set([...inactiveSeed, ...retired])].join(", ") || "aucun membre retiré",
);

// --- M2 — Les commerciaux historiques gardent le même verdict ------------------

section("M2 — Verdicts historiques inchangés");

const milestones = loadMilestoneOpportunities();
const historical = team.filter((m) => TEAM.some((s) => s.name === m.name));
check("les commerciaux de la graine encore actifs sont tous présents", historical.every((m) => names.includes(m.name)), `${historical.length} commerciaux`);
check(
  "leur verdict est exactement celui de la règle Monitoring",
  historical.every((m) => before.owners.find((o) => o.owner === m.name)?.state === handVerdict(milestones.filter((o) => o.owner === m.name))),
);
check(
  "leurs compteurs sont ceux de leurs affaires",
  historical.every((m) => {
    const row = before.owners.find((o) => o.owner === m.name);
    const mine = milestones.filter((o) => o.owner === m.name);
    return row.active === mine.length && row.clientWaiting === mine.filter((o) => o.clientWaiting).length;
  }),
);

// --- M3 — Un commercial de team_member absent de la graine reçoit un verdict --------

section("M3 — Commercial présent dans team_member, absent de la graine TEAM");

const NEW_NAME = "Camille Testeur";
check("le nom de test n'est pas dans la graine", !TEAM.some((m) => m.name === NEW_NAME));
check("le nom de test n'a pas encore de verdict", !names.includes(NEW_NAME));

const member = addTeamMember({ name: NEW_NAME });
check("ajout par le store existant, comme depuis l'écran Données", member.active && loadTeam().some((m) => m.name === NEW_NAME));

// Cinq affaires actives portées par ce commercial : trois en anomalie nouvelle,
// une en attente client, une saine. Règle attendue : 3 exceptions sur 5 (60 %)
// ⇒ « action requise ».
const db = getDb();
const today = new Date().toISOString().slice(0, 10);
const fixtures = [
  ["TESTCAMILLE0001", "sla_devis", 0, 120_000],
  ["TESTCAMILLE0002", "sla_estimation", 0, 40_000],
  ["TESTCAMILLE0003", "client_attend", 1, 60_000],
  ["TESTCAMILLE0004", "normal", 0, 25_000],
  ["TESTCAMILLE0005", "a_venir", 0, 10_000],
];
const insert = db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES (?, ?, ?, ?, 'Examen devis', 0, 0, 0, 1, ?, 0, ?, 0, ?, 0)`,
);
for (const [id, status, waiting, gmv] of fixtures) {
  insert.run(id, `Client ${id}`, NEW_NAME, gmv, status, waiting, today);
}

const after = computeOpportunityMetrics(loadMilestoneOpportunities());
const row = after.owners.find((o) => o.owner === NEW_NAME);
check("le commercial reçoit désormais une ligne de verdict", row != null);
check("ses affaires sont comptées", row?.active === 5 && row?.clientWaiting === 1 && row?.newExceptions === 3, row ? `${row.active} affaires · ${row.newExceptions} exceptions · ${row.clientWaiting} client(s) en attente` : "aucune ligne");
check("son verdict suit la règle Monitoring : « action requise »", row?.state === "action requise", row?.stateReason ?? "");
check("son prénom vient du store, pas d'une table à la main", row?.firstName === member.firstName);

// --- M4 — Rien d'autre n'a bougé --------------------------------------------------

section("M4 — Aucun effet de bord");

check(
  "les verdicts des autres commerciaux sont identiques avant et après l'ajout",
  before.owners.every((b) => {
    const a = after.owners.find((o) => o.owner === b.owner);
    return a && a.state === b.state && a.active === b.active && a.newExceptions === b.newExceptions && a.legacyBacklog === b.legacyBacklog;
  }),
);

db.prepare(
  `INSERT INTO opportunity
     (opportunity_id, name, owner, gmv, stage, is_signed, is_terminal, is_standby, is_active,
      milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
   VALUES ('TESTEXTERNE0001', 'Client externe', 'Externe Inconnu', 90000, 'Examen devis', 0, 0, 0, 1, 'sla_devis', 0, 0, 0, ?, 0)`,
).run(today);
const withStranger = computeOpportunityMetrics(loadMilestoneOpportunities());
check("un commercial hors team_member avec des affaires ne remonte pas", !withStranger.owners.some((o) => o.owner === "Externe Inconnu"));
check("ses affaires comptent dans les totaux d'équipe comme avant (périmètre non filtré ici)", withStranger.active === after.active + 1, "comportement inchangé : les totaux lisent toutes les affaires non terminées");

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

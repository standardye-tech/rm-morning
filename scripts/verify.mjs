/**
 * Contrôle indépendant de la base : relit le SQLite produit par l'import et
 * recalcule les agrégats à la main, sans passer par le code de l'application.
 *
 *   node scripts/verify.mjs
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"));
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const eur = (n) => Math.round(n).toLocaleString("fr-FR") + " €";

const run = one("SELECT * FROM import_run ORDER BY id DESC LIMIT 1");
console.log("=== DERNIER IMPORT ===");
console.log(`  fichier      : ${run.file_name}`);
console.log(`  snapshot     : ${run.snapshot_date}`);
console.log(`  lignes lues  : ${run.total_rows}`);
console.log(`  équipe       : ${run.team_rows}`);
console.log(`  actives      : ${run.active_rows} | signées : ${run.signed_rows} | stand-by : ${run.standby_rows}`);

const t = one(`SELECT COUNT(*) n,
                      SUM(is_active) act,
                      SUM(is_signed) sig,
                      SUM(is_standby) sb,
                      COALESCE(SUM(CASE WHEN is_active=1 THEN gmv END),0) gmv_act,
                      COALESCE(SUM(CASE WHEN is_signed=1 THEN gmv END),0) gmv_sig,
                      COALESCE(SUM(CASE WHEN is_standby=1 THEN gmv END),0) gmv_sb
                 FROM opportunity`);
console.log("\n=== TOTAUX RECALCULÉS ===");
console.log(`  opportunités : ${t.n}`);
console.log(`  actives      : ${t.act}  ${eur(t.gmv_act)}`);
console.log(`  signées      : ${t.sig}  ${eur(t.gmv_sig)}`);
console.log(`  stand-by     : ${t.sb}  ${eur(t.gmv_sb)}`);
console.log(`  contrôle     : actives + signées + stand-by = ${t.act + t.sig + t.sb} (doit valoir ${t.n})`);

console.log("\n=== RÈGLE : SIGNÉ HORS PIPE ACTIF ===");
console.log(`  signées encore comptées actives : ${one("SELECT COUNT(*) n FROM opportunity WHERE is_signed=1 AND is_active=1").n} (attendu 0)`);

console.log("\n=== RÈGLE : STAND-BY FUTUR HORS PIPE ACTIF ===");
const sbFuture = one(
  "SELECT COUNT(*) n FROM opportunity WHERE standby_until > ? AND is_active=1",
  run.snapshot_date,
);
const sbPast = one(
  "SELECT COUNT(*) n FROM opportunity WHERE standby_until IS NOT NULL AND standby_until <= ?",
  run.snapshot_date,
);
console.log(`  stand-by futur encore actif    : ${sbFuture.n} (attendu 0)`);
console.log(`  stand-by échu (date conservée) : ${sbPast.n}`);
console.log("  3 exemples de stand-by :");
for (const r of all(
  "SELECT client_contact, gmv, stage, standby_until, is_active FROM opportunity WHERE is_standby=1 ORDER BY gmv DESC LIMIT 3",
)) {
  console.log(`    ${r.client_contact} · ${eur(r.gmv)} · ${r.stage} · réveil ${r.standby_until} · actif=${r.is_active}`);
}

console.log("\n=== GMV ACTIVE PAR COMMERCIAL ===");
for (const r of all(
  `SELECT owner, COUNT(*) n, COALESCE(SUM(gmv),0) g
     FROM opportunity WHERE is_active=1 GROUP BY owner ORDER BY g DESC`,
)) {
  console.log(`  ${r.owner.padEnd(22)} ${String(r.n).padStart(3)} opp  ${eur(r.g).padStart(14)}`);
}

console.log("\n=== PROJECTION KANBAN (actives) ===");
console.log(`  avec projection : ${one("SELECT COUNT(*) n FROM opportunity WHERE is_active=1 AND kanban_raw IS NOT NULL").n}`);
console.log(`  sur août 2026   : ${one("SELECT COUNT(*) n, COALESCE(SUM(gmv),0) g FROM opportunity WHERE is_active=1 AND kanban_month=8 AND kanban_year=2026").n}`);
console.log(`  GMV projetée    : ${eur(one("SELECT COALESCE(SUM(gmv),0) g FROM opportunity WHERE is_active=1 AND kanban_month=8 AND kanban_year=2026").g)}`);
console.log("  couleurs identifiées :");
for (const r of all(
  `SELECT COALESCE(kanban_color,'(non identifiée)') c, kanban_color_raw, COUNT(*) n
     FROM opportunity WHERE kanban_raw IS NOT NULL GROUP BY c, kanban_color_raw ORDER BY n DESC`,
)) {
  console.log(`    ${String(r.n).padStart(3)}  ${r.c.padEnd(18)} pastille brute ${JSON.stringify(r.kanban_color_raw)}`);
}

console.log("\n=== HISTORISATION ===");
for (const r of all(
  "SELECT snapshot_date, COUNT(*) n FROM opportunity_snapshot GROUP BY snapshot_date ORDER BY snapshot_date",
)) {
  console.log(`  ${r.snapshot_date} : ${r.n} lignes`);
}

console.log("\n=== CONTRÔLE DÉTAILLÉ SUR 3 OPPORTUNITÉS ===");
for (const r of all(
  `SELECT opportunity_id, client_contact, owner, gmv, stage, probability, kanban_raw,
          created_at, last_activity_at, standby_until, is_active, is_signed, is_standby
     FROM opportunity WHERE is_active=1 ORDER BY gmv DESC LIMIT 3`,
)) {
  const jours = Math.round(
    (Date.parse(run.snapshot_date + "T00:00:00") - Date.parse(r.last_activity_at + "T00:00:00")) / 86400000,
  );
  console.log(`  ${r.client_contact} (${r.opportunity_id})`);
  console.log(`    ${r.owner} · ${eur(r.gmv)} · ${r.stage} (${r.probability} %) · Kanban ${JSON.stringify(r.kanban_raw)}`);
  console.log(`    créée ${r.created_at} · dernière activité ${r.last_activity_at} → ${jours} j`);
  console.log(`    actif=${r.is_active} signé=${r.is_signed} standby=${r.is_standby}`);
}

db.close();

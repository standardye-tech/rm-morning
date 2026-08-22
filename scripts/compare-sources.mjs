/**
 * Compare deux états de la base, avant et après un changement de source.
 *
 *   node scripts/compare-sources.mjs capture <fichier.json>   # photographie l'état courant
 *   node scripts/compare-sources.mjs compare <fichier.json>   # compare l'état courant à la photo
 *
 * Sert à vérifier qu'une synchronisation API reproduit bien l'import fichier,
 * et à expliquer les écarts opportunité par opportunité quand il y en a.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , mode, file] = process.argv;
if (!["capture", "compare"].includes(mode) || !file) {
  console.error("usage: node scripts/compare-sources.mjs <capture|compare> <fichier.json>");
  process.exit(1);
}

const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"));
const eur = (n) => Math.round(n).toLocaleString("fr-FR") + " €";

function readState() {
  const run = db.prepare("SELECT * FROM import_run ORDER BY id DESC LIMIT 1").get();
  const rows = db
    .prepare(
      `SELECT opportunity_id, owner, gmv, stage, kanban_raw, standby_until,
              last_activity_at, is_active, is_signed, is_standby
         FROM opportunity`,
    )
    .all();
  const totals = db
    .prepare(
      `SELECT COUNT(*) n,
              SUM(is_active) act, SUM(is_signed) sig, SUM(is_standby) sb,
              COALESCE(SUM(CASE WHEN is_active=1  THEN gmv END),0) gmv_act,
              COALESCE(SUM(CASE WHEN is_signed=1  THEN gmv END),0) gmv_sig,
              COALESCE(SUM(CASE WHEN is_standby=1 THEN gmv END),0) gmv_sb
         FROM opportunity`,
    )
    .get();
  return {
    source: run.source_kind,
    sourceLabel: run.source_label,
    importedAt: run.imported_at,
    totalRows: run.total_rows,
    totals,
    rows: Object.fromEntries(rows.map((r) => [r.opportunity_id, r])),
  };
}

const state = readState();

if (mode === "capture") {
  writeFileSync(file, JSON.stringify(state, null, 1));
  console.log(`état « ${state.source} » capturé : ${state.totals.n} opportunités -> ${file}`);
  process.exit(0);
}

const before = JSON.parse(readFileSync(file, "utf8"));
const after = state;

console.log(`AVANT : ${before.sourceLabel}  (${before.importedAt})`);
console.log(`APRÈS : ${after.sourceLabel}  (${after.importedAt})\n`);

const line = (label, a, b, money = false) => {
  const same = Math.round(a) === Math.round(b);
  const fmt = (v) => (money ? eur(v) : String(v));
  const delta = same ? "" : `   Δ ${b - a > 0 ? "+" : ""}${fmt(b - a)}`;
  console.log(
    `  ${same ? "OK " : "≠  "} ${label.padEnd(24)} ${fmt(a).padStart(15)} → ${fmt(b).padStart(15)}${delta}`,
  );
};

line("opportunités équipe", before.totals.n, after.totals.n);
line("actives (nb)", before.totals.act, after.totals.act);
line("actives (GMV)", before.totals.gmv_act, after.totals.gmv_act, true);
line("signées (nb)", before.totals.sig, after.totals.sig);
line("signées (GMV)", before.totals.gmv_sig, after.totals.gmv_sig, true);
line("stand-by (nb)", before.totals.sb, after.totals.sb);
line("stand-by (GMV)", before.totals.gmv_sb, after.totals.gmv_sb, true);

const idsBefore = new Set(Object.keys(before.rows));
const idsAfter = new Set(Object.keys(after.rows));
const added = [...idsAfter].filter((i) => !idsBefore.has(i));
const removed = [...idsBefore].filter((i) => !idsAfter.has(i));

console.log(`\n  Opportunités apparues : ${added.length}`);
for (const id of added.slice(0, 10)) {
  const r = after.rows[id];
  console.log(`    + ${id} ${r.owner} ${eur(r.gmv ?? 0)} ${r.stage}`);
}
console.log(`  Opportunités disparues : ${removed.length}`);
for (const id of removed.slice(0, 10)) {
  const r = before.rows[id];
  console.log(`    - ${id} ${r.owner} ${eur(r.gmv ?? 0)} ${r.stage}`);
}

const changed = [];
for (const id of idsAfter) {
  if (!idsBefore.has(id)) continue;
  const a = before.rows[id];
  const b = after.rows[id];
  const diffs = [];
  for (const k of ["owner", "gmv", "stage", "kanban_raw", "standby_until", "last_activity_at", "is_active"]) {
    if (String(a[k] ?? "") !== String(b[k] ?? "")) diffs.push(`${k}: ${a[k] ?? "∅"} → ${b[k] ?? "∅"}`);
  }
  if (diffs.length) changed.push({ id, owner: b.owner, diffs });
}
console.log(`\n  Opportunités modifiées : ${changed.length}`);
for (const c of changed.slice(0, 15)) {
  console.log(`    ~ ${c.id} (${c.owner})`);
  for (const d of c.diffs) console.log(`        ${d}`);
}

db.close();

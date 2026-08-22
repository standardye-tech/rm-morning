/**
 * Contrôle indépendant du forecast : relit SQLite et recalcule à la main le
 * rapprochement entre le dernier snapshot hebdomadaire et l'état Salesforce.
 *
 *   node scripts/verify-forecast.mjs [AAAA-MM-JJ]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const today = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"));
const all = (sql, ...p) => db.prepare(sql).all(...p);
const eur = (n) => Math.round(n ?? 0).toLocaleString("fr-FR") + " €";

console.log(`=== SNAPSHOTS DE FORECAST EN BASE ===`);
for (const r of all(
  `SELECT forecast_month, snapshot_date, COUNT(*) n, COALESCE(SUM(projected_gmv),0) g
     FROM forecast_snapshot GROUP BY forecast_month, snapshot_date
     ORDER BY forecast_month, snapshot_date`,
)) {
  console.log(
    `  ${r.forecast_month}  ${r.snapshot_date}  ${String(r.n).padStart(3)} lignes  projeté ${eur(r.g).padStart(14)}`,
  );
}

const dates = all(
  `SELECT DISTINCT snapshot_date FROM forecast_snapshot
    WHERE forecast_month = ? AND snapshot_date <= ?
    ORDER BY snapshot_date DESC`,
  month,
  today,
).map((r) => r.snapshot_date);

console.log(`\n=== SÉLECTION DU SNAPSHOT (mois ${month}, aujourd'hui ${today}) ===`);
console.log(`  candidats ≤ aujourd'hui : ${dates.join(", ") || "aucun"}`);
console.log(`  référence retenue       : ${dates[0] ?? "—"}`);
console.log(`  précédent               : ${dates[1] ?? "—"}`);

const futurs = all(
  `SELECT DISTINCT snapshot_date FROM forecast_snapshot
    WHERE forecast_month = ? AND snapshot_date > ?`,
  month,
  today,
).map((r) => r.snapshot_date);
console.log(`  snapshots futurs ignorés : ${futurs.join(", ") || "aucun"} (jamais retenus)`);

if (!dates[0]) {
  console.log("\nAucun snapshot exploitable, arrêt.");
  db.close();
  process.exit(0);
}

const ref = all(
  "SELECT * FROM forecast_snapshot WHERE forecast_month = ? AND snapshot_date = ?",
  month,
  dates[0],
);
const opportunities = new Map(
  all("SELECT * FROM opportunity").map((o) => [o.opportunity_id, o]),
);

let snapshotGmv = 0;
let currentGmv = 0;
const gaps = [];
const signed = [];
const standby = [];

for (const line of ref) {
  snapshotGmv += line.projected_gmv ?? 0;
  const o = line.opportunity_id ? opportunities.get(line.opportunity_id) : undefined;
  if (!o) {
    gaps.push(line);
    continue;
  }
  if (o.is_signed) {
    currentGmv += o.gmv ?? 0;
    signed.push({ line, o });
  } else if (o.is_standby) {
    standby.push({ line, o });
  } else if (line.state === "Perdue") {
    // ne contribue pas
  } else {
    currentGmv += (o.gmv ?? 0) * (line.confidence ?? 0);
  }
}

console.log(`\n=== RAPPROCHEMENT (${ref.length} lignes d'équipe au snapshot ${dates[0]}) ===`);
console.log(`  rapprochées par ID 15 car. : ${ref.length - gaps.length}`);
console.log(`  non rapprochées            : ${gaps.length}`);
console.log(`  projeté au snapshot        : ${eur(snapshotGmv)}`);
console.log(`  projection actuelle        : ${eur(currentGmv)}`);
console.log(`  écart                      : ${eur(currentGmv - snapshotGmv)}`);
console.log(`  dont signées               : ${signed.length}`);
console.log(`  dont passées en stand-by   : ${standby.length}`);

if (gaps.length) {
  console.log(`\n  --- lignes du forecast sans correspondance Salesforce (à investiguer) ---`);
  for (const g of gaps.sort((a, b) => (b.projected_gmv ?? 0) - (a.projected_gmv ?? 0))) {
    console.log(
      `    ${g.opportunity_id ?? "(sans ID)"}  ${String(g.salesperson).padEnd(20)} ` +
        `${eur(g.projected_gmv).padStart(12)}  ${String(g.opportunity_label).slice(0, 42)}`,
    );
  }
}

console.log(`\n=== ÉTATS DÉCLARÉS AU SNAPSHOT ${dates[0]} ===`);
for (const r of all(
  `SELECT COALESCE(NULLIF(state,''),'(aucun)') s, COUNT(*) n
     FROM forecast_snapshot WHERE forecast_month = ? AND snapshot_date = ?
     GROUP BY s ORDER BY n DESC`,
  month,
  dates[0],
)) {
  console.log(`  ${String(r.n).padStart(3)}  ${r.s}`);
}

db.close();

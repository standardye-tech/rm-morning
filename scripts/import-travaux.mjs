/**
 * Import des lignes Travaux — source officielle du GMV signé.
 *
 *   npm run travaux:import
 *
 * Enveloppe de maintenance autour de `importTravaux()`. Depuis C12, l'import est
 * exécuté automatiquement par l'actualisation globale ; ce script reste pour le
 * diagnostic et n'a donc pas sa propre implémentation.
 *
 * LECTURE SEULE Salesforce.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { importTravaux } = await import(lib("travaux-import"));
const { getDb } = await import(lib("db"));

process.stderr.write("  extraction Travaux__c…\n");
const s = await importTravaux();

const kEur = (v) => `${Math.round((v ?? 0) / 1000).toLocaleString("fr-FR")} k€`;
console.log(`\n════ IMPORT TRAVAUX ════`);
console.log(`  lignes extraites   : ${s.extracted}`);
console.log(`  lignes en base     : ${s.total}  (${s.added} nouvelle(s))`);
console.log(`  fenêtre            : ${s.from} → ${s.to}`);
console.log(`\n  ${"statut".padEnd(14)}${"type".padEnd(20)}${"lignes".padStart(8)}${"GMV".padStart(14)}`);
for (const r of getDb()
  .prepare("SELECT works_status s, works_type t, COUNT(*) n, SUM(gmv) g FROM travaux GROUP BY s, t ORDER BY g DESC")
  .all()) {
  console.log(`  ${String(r.s).padEnd(14)}${String(r.t).padEnd(20)}${String(r.n).padStart(8)}${kEur(r.g).padStart(14)}`);
}
console.log(`\n  → table travaux\n`);

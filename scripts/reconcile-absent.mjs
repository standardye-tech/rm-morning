/**
 * Rattrapage des affaires sorties du périmètre source.
 *
 *   npm run opps:reconcile          (aperçu, aucune écriture)
 *   npm run opps:reconcile -- --appliquer
 *
 * POURQUOI CE SCRIPT EXISTE. La réconciliation vit désormais dans l'import
 * (`src/lib/import.ts`) : à chaque actualisation, une affaire que la source ne
 * publie plus quitte le pipe actif. Mais les affaires disparues AVANT la mise en
 * place de cette règle n'ont jamais été rapprochées : leur dernière étape connue
 * est restée figée en base, et elles continuaient à peser dans le Forecast et
 * dans l'Expected. Ce script applique la même règle au passé, une fois.
 *
 * MÊME CRITÈRE QUE L'IMPORT, exprimé autrement : une affaire dont
 * `last_import_id` est antérieur au dernier import d'opportunités n'a pas été
 * revue par la source lors de cet import. Elle n'a donc pas été publiée.
 *
 * Le même garde-fou s'applique : au-delà d'une part du pipe, on refuse d'écrire
 * — un import tronqué ne doit jamais vider le pipe.
 *
 * LECTURE SEULE sans `--appliquer`.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

// On passe par `getDb` plutôt que d'ouvrir la base directement : c'est lui qui
// applique les migrations, donc qui garantit l'existence des colonnes lues ici.
const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));

const apply = process.argv.includes("--appliquer");
const db = getDb();

const lastImport = db
  .prepare(
    "SELECT id, snapshot_date, imported_at FROM import_run WHERE source_kind IN ('api','manual') ORDER BY id DESC LIMIT 1",
  )
  .get();

if (!lastImport) {
  console.log("Aucun import d'opportunités en base : rien à rapprocher.");
  process.exit(0);
}

console.log(
  `Dernier import d'opportunités : #${lastImport.id} du ${lastImport.snapshot_date} (${lastImport.imported_at})`,
);

const candidates = db
  .prepare(
    `SELECT opportunity_id, client_contact, name, owner, stage, gmv, last_import_id
       FROM opportunity
      WHERE last_import_id < ? AND is_terminal = 0 AND absent_since IS NULL
      ORDER BY gmv DESC`,
  )
  .all(lastImport.id);

const activeCount = db
  .prepare("SELECT COUNT(*) n FROM opportunity WHERE is_terminal = 0")
  .get().n;
const allowance = Math.max(15, Math.round(activeCount * 0.2));

console.log(`\n${candidates.length} affaire(s) non republiée(s) par la source, sur ${activeCount} active(s).`);
for (const c of candidates) {
  const label = c.client_contact ?? c.name ?? c.opportunity_id;
  console.log(
    `  ${c.opportunity_id}  ${String(label).padEnd(28)} ${String(c.owner).padEnd(22)} ` +
      `${String(c.stage ?? "—").padEnd(20)} ${Math.round((c.gmv ?? 0) / 1000)} k€  (vue à l'import #${c.last_import_id})`,
  );
}

if (candidates.length === 0) {
  console.log("\nRien à faire.");
  process.exit(0);
}

if (candidates.length > allowance) {
  console.log(
    `\nÉCHEC : ${candidates.length} dépasse le garde-fou de ${allowance}. ` +
      "Le dernier import est probablement incomplet — rien n'a été écrit.",
  );
  process.exit(1);
}

if (!apply) {
  console.log("\nAperçu seulement. Relancer avec « -- --appliquer » pour écrire.");
  process.exit(0);
}

const update = db.prepare(
  `UPDATE opportunity
      SET absent_since = ?, absent_reason = ?, is_terminal = 1, is_active = 0
    WHERE opportunity_id = ?`,
);
db.exec("BEGIN");
try {
  for (const c of candidates) {
    update.run(
      lastImport.snapshot_date,
      "absente de la source : abandon, annulation ou étape hors périmètre",
      c.opportunity_id,
    );
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(`\n${candidates.length} affaire(s) sortie(s) du pipe actif, datée(s) du ${lastImport.snapshot_date}.`);

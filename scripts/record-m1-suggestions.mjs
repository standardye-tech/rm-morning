/**
 * Historisation des suggestions M+1.
 *
 *   npm run m1:record
 *
 * Enveloppe de maintenance autour de `recordM1Suggestions()`. Depuis C12,
 * l'historisation est exécutée automatiquement par l'actualisation globale.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { recordM1Suggestions } = await import(lib("m1-record"));

const s = recordM1Suggestions();
if (s == null) {
  console.error("\n  Aucune projection M+1 publiée. Lancer npm run m1:publish d'abord.\n");
  process.exit(1);
}

console.log(`\n  Génération du ${s.snapshotDate} — cible ${s.targetMonth}`);
console.log(`  ${s.candidates} affaire(s) au-dessus du seuil`);
console.log(`  dont ${s.yellow} retenue(s) comme ligne jaune`);
console.log(
  `  écartées : ${s.excludedKanban} déjà déclarée(s) Kanban · ${s.excludedPerspective} déjà dans Perspective · ` +
    `${s.excludedFrozen} gelée(s) au-delà de l'horizon`,
);
for (const o of s.outcomes) console.log(`  issue ${o.month} : ${o.signed}/${o.rows} signature(s)`);
if (s.outcomes.length === 0) console.log("  aucun mois cible terminé en attente d'issue");
console.log(`\n  → expected_m1_suggestion : ${s.total} ligne(s) au total\n`);

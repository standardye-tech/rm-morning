/**
 * Journal durable des signatures.
 *
 *   npm run signatures:record
 *
 * Enveloppe de maintenance autour de `recordSignatureEvents()`. Depuis C12,
 * l'historisation est exécutée automatiquement par l'actualisation globale.
 *
 * LIMITE CONNUE : la source est `expected_gmv_observation`, qui n'est régénérée
 * que par une reconstruction du dataset. En usage quotidien, ce journal n'avance
 * donc que lorsque le dataset est reconstruit.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { recordSignatureEvents } = await import(lib("signature-record"));

const s = recordSignatureEvents();
console.log(`\n════ JOURNAL DES SIGNATURES ════`);
console.log(`  signatures enregistrées : ${s.total}  (${s.added} nouvelle(s))`);
console.log(`  fenêtre                 : ${(s.from ?? "").slice(0, 10)} → ${(s.to ?? "").slice(0, 10)}`);
console.log(`  mois couverts           : ${s.months}`);
console.log(`  avec date de création    : ${s.withCreatedAt}/${s.total}`);
console.log(`\n  → table signature_event (durable, jamais reconstruite)\n`);

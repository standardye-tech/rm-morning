/**
 * Audit de la preuve d'intérêt — avant / après sur les messages RÉELS.
 *
 *   npm run morning:proof-audit
 *
 * LECTURE SEULE : relit auprès de Gmail les fils des événements Morning encore
 * ouverts (métadonnées et extrait court, comme la synchronisation), applique
 * la sélection de preuve d'intérêt et affiche, pour chacun, ce que l'écran
 * montrait avant et ce qu'il montrera après. Rien n'est écrit en base, aucun
 * modèle n'est appelé.
 *
 * L'extrait du message est affiché pour permettre de juger la fidélité de la
 * citation à l'œil. Il ne quitte pas la console.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { auditInterestProofs } = await import(lib("sources/gmail"));

const limit = Number(process.argv[2] ?? 25);
const rows = await auditInterestProofs(limit);

const wrap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

let withProof = 0;
let excludedNoise = 0;
for (const r of rows) {
  if (r.after) withProof += 1;
  if (!r.after && /(signature automatique|mention|notification|docusign)/i.test(r.before)) excludedNoise += 1;
  console.log(`\n── ${r.client} · ${r.category} · ${wrap(r.subject ?? "(sans objet)", 70)}`);
  console.log(`   avant : ${r.before}`);
  console.log(`   après : ${r.after ? `« ${r.after} » (${r.tier})` : "Pas de preuve d'intérêt explicite dans le dernier message"}`);
  console.log(`   texte : ${wrap(r.text, 220)}`);
  if (r.after && !r.text.includes(r.after.replace(/…$/, ""))) console.log("   !! la citation n'est pas un extrait exact du texte");
}

console.log(`\n${rows.length} message(s) relus · ${withProof} avec preuve · ${rows.length - withProof} sans preuve explicite (dont ${excludedNoise} bruit administratif ou automatique)`);

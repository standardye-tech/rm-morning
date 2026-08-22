/**
 * Actualisation globale en ligne de commande.
 *
 *   npm run sync:run
 *
 * Même orchestrateur que le bouton : aucune logique d'ordre n'est dupliquée ici.
 * Sert au diagnostic et permettrait une exécution planifiée.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { runGlobalSyncToCompletion, SyncBusyError } = await import(lib("sync/orchestrator"));
const { RUN_STATUS_LABEL, humanDuration } = await import(lib("sync/labels"));

let run;
try {
  run = await runGlobalSyncToCompletion("script");
} catch (error) {
  if (error instanceof SyncBusyError) {
    console.error("\n  Une actualisation est déjà en cours.\n");
    process.exit(1);
  }
  throw error;
}

console.log(`\n════ ACTUALISER RM MORNING ════\n`);
console.log(`  ${"étape".padEnd(32)}${"statut".padEnd(10)}${"durée".padStart(9)}`);
for (const s of run.steps) {
  console.log(
    `  ${s.label.padEnd(32)}${s.status.padEnd(10)}` +
      `${(s.durationMs == null ? "—" : `${(s.durationMs / 1000).toFixed(1)} s`).padStart(9)}`,
  );
  if (s.detail) console.log(`      ${s.detail}`);
  if (s.error) console.log(`      erreur : ${s.error}`);
}
console.log(`\n  ${RUN_STATUS_LABEL[run.status]} — ${humanDuration(run.durationMs)}`);
for (const w of run.warnings) console.log(`  avertissement : ${w}`);
if (run.error) console.log(`  ${run.error}`);
console.log(`\n  versions utilisées :`);
for (const [k, v] of Object.entries(run.sources)) console.log(`    ${k.padEnd(26)}${v ?? "—"}`);
console.log("");
process.exit(run.status === "failed" ? 1 : 0);

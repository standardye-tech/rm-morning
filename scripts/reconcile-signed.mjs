/**
 * Contrôle permanent du GMV signé officiel.
 *
 *   npm run signed:reconcile               les 6 derniers mois
 *   npm run signed:reconcile -- 2026-08    un mois précis
 *
 * Compare, pour chaque mois, le calcul de RM Morning à une extraction SOQL
 * DIRECTE de Salesforce. Écart attendu : 0,00 €. Deux chemins indépendants — la
 * table locale d'un côté, l'org de l'autre — donc un écart signale soit un
 * import en retard, soit une divergence de définition.
 *
 * LECTURE SEULE.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { officialSignedGmv } = await import(lib("official-signed"));
const { TRAVAUX } = await import(lib("config"));
const { matchTeamMember } = await import(lib("normalize"));

const CLI = path.join(process.env.APPDATA ?? "", "npm/node_modules/@salesforce/cli/bin/run.js");

async function soql(query) {
  const { stdout } = await run(
    process.execPath,
    [CLI, "data", "query", "--query", query, "--target-org", "rm-morning", "--json"],
    { env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, maxBuffer: 400 * 1024 * 1024 },
  );
  const r = JSON.parse(stdout);
  if (r.status !== 0) throw new Error((r.message || "").slice(0, 300));
  return r.result.records;
}

const args = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}$/.test(a));
const months = args.length
  ? args
  : (() => {
      const out = [];
      const d = new Date();
      for (let i = 0; i < 6; i += 1) {
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        d.setMonth(d.getMonth() - 1);
      }
      return out.reverse();
    })();

const eur = (v) => `${(v ?? 0).toFixed(2)} €`;
const statuses = TRAVAUX.signedStatuses.map((s) => `'${s}'`).join(",");

let failures = 0;
console.log(`\n════ RÉCONCILIATION DU GMV SIGNÉ OFFICIEL ════`);
console.log(
  `  ${"mois".padEnd(10)}${"RM Morning".padStart(15)}${"Salesforce".padStart(15)}` +
    `${"écart".padStart(12)}${"lignes".padStart(9)}`,
);

for (const month of months) {
  const local = officialSignedGmv(month);
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const rows = await soql(
    `SELECT Proprietaire_de_l_opportunite__c, Montant__c FROM Travaux__c
      WHERE Date_de_signature_du_devis__c >= ${month}-01
        AND Date_de_signature_du_devis__c <= ${month}-${last}
        AND Statut_travaux__c IN (${statuses})`,
  );
  const remote = rows
    .filter((r) => matchTeamMember(r.Proprietaire_de_l_opportunite__c))
    .reduce((t, r) => t + (r.Montant__c ?? 0), 0);
  const remoteLines = rows.filter((r) => matchTeamMember(r.Proprietaire_de_l_opportunite__c)).length;

  const gap = local.gmv - remote;
  const ok = Math.abs(gap) < 0.005 && local.lines === remoteLines;
  if (!ok) failures += 1;
  console.log(
    `  ${month.padEnd(10)}${eur(local.gmv).padStart(15)}${eur(remote).padStart(15)}` +
      `${eur(gap).padStart(12)}${`${local.lines}/${remoteLines}`.padStart(9)}  ${ok ? "ok" : "ÉCART"}`,
  );
}

console.log(
  `\n  ${failures === 0 ? `Les ${months.length} mois sont réconciliés à 0,00 €.` : `${failures} mois en écart.`}\n`,
);
process.exit(failures === 0 ? 0 : 1);

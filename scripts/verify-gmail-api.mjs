/**
 * Validation du Passage A sur la vraie API Gmail.
 *
 *   node --experimental-strip-types --env-file=.env.local \
 *        scripts/verify-gmail-api.mjs [jours]
 *
 * LECTURE SEULE, et sans effet de bord : ce harnais n'écrit rien en base. Il
 * rejoue exactement le même filtrage et le même rattachement que la source de
 * production, sur une fenêtre choisie, et mesure ce que le passage exige :
 *
 *   — taux de rejet du bruit, règle par règle ;
 *   — précision des rattachements A, chacun affiché pour contrôle ;
 *   — volumes B et C ;
 *   — faux négatifs commerciaux : messages ÉCARTÉS dont l'adresse expéditeur
 *     est pourtant une adresse client connue de Salesforce. C'est la mesure
 *     qui compte le plus : écarter un vrai client est la seule erreur grave.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const days = Number(process.argv[2] ?? 7);
const lib = (name) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${name}.ts`)).href;

const { filterMessage, teamMembersInvolved, isSignedProjectFollowUp, INTERNAL_DOMAIN } =
  await import(lib("mail-rules"));
const { buildOpportunityIndex, matchMessage } = await import(lib("mail-match"));
const { GmailSource } = await import(lib("sources/gmail"));

// --- Opportunités du périmètre, depuis la base locale.
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const opportunities = db
  .prepare(
    `SELECT opportunity_id, name, client_email, client_contact, owner, stage, is_signed, is_active
       FROM opportunity`,
  )
  .all()
  .map((r) => ({
    opportunityId: r.opportunity_id,
    name: r.name,
    clientEmail: r.client_email,
    clientContact: r.client_contact,
    owner: r.owner,
    stage: r.stage,
    isSigned: r.is_signed === 1,
    isActive: r.is_active === 1,
  }));
db.close();

const index = buildOpportunityIndex(opportunities);
const byId = new Map(opportunities.map((o) => [o.opportunityId, o]));
const clientEmails = new Set(
  opportunities.map((o) => (o.clientEmail ?? "").toLowerCase()).filter(Boolean),
);

// --- Lecture Gmail, via exactement le même code que la production.
const source = new GmailSource();
const end = new Date();
const start = new Date(end.getTime() - days * 86_400_000);

const started = Date.now();
const messages = await source.readWindow(start, end);
const readMs = Date.now() - started;

console.log(`\nFenêtre : ${start.toLocaleString("fr-FR")} → ${end.toLocaleString("fr-FR")}`);
console.log(`${messages.length} messages lus en ${(readMs / 1000).toFixed(1)} s\n`);

// --- Rejeu du filtrage et du rattachement.
const excludedByRule = {};
const kept = [];
const falseNegatives = [];
const threadLinks = new Map();
let excluded = 0;

for (const { message } of messages.sort((a, b) => a.message.date.localeCompare(b.message.date))) {
  const verdict = filterMessage(message);
  if (!verdict.kept) {
    excluded += 1;
    excludedByRule[verdict.rule] = (excludedByRule[verdict.rule] ?? 0) + 1;
    // L'expéditeur est-il une adresse client connue de Salesforce ?
    if (clientEmails.has(message.from)) {
      falseNegatives.push({ rule: verdict.rule, from: message.from, subject: message.subject });
    }
    continue;
  }

  const teamMembers = teamMembersInvolved(message);
  const match = matchMessage(message, index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers,
    threadLinks,
  });
  const opportunity = match.opportunityId ? byId.get(match.opportunityId) : undefined;
  if (opportunity && isSignedProjectFollowUp(message, opportunity.isSigned)) {
    excluded += 1;
    excludedByRule["chantier-affaire-signee"] = (excludedByRule["chantier-affaire-signee"] ?? 0) + 1;
    continue;
  }
  if (match.level === "A" && match.opportunityId) threadLinks.set(message.threadId, match.opportunityId);
  kept.push({ message, match, opportunity });
}

const levels = { A: 0, B: 0, C: 0 };
for (const k of kept) levels[k.match.level] += 1;

console.log("=== Filtrage ===");
console.log(`  vus       : ${messages.length}`);
console.log(`  écartés   : ${excluded}  (${((excluded / messages.length) * 100).toFixed(1)} %)`);
console.log(`  conservés : ${kept.length}`);
for (const [rule, n] of Object.entries(excludedByRule).sort((a, b) => b[1] - a[1])) {
  console.log(`      ${String(n).padStart(4)}  ${rule}`);
}

console.log("\n=== Rattachement ===");
console.log(`  A — certain   : ${levels.A}`);
console.log(`  B — probable  : ${levels.B}`);
console.log(`  C — incertain : ${levels.C}`);
console.log(
  `  rattachements forcés (niveau C portant un opportunity_id) : ` +
    kept.filter((k) => k.match.level === "C" && k.match.opportunityId).length,
);

console.log("\n=== Les A, un par un — à contrôler à l'œil ===");
for (const k of kept.filter((x) => x.match.level === "A")) {
  const client = k.opportunity?.clientContact ?? k.opportunity?.name ?? "?";
  console.log(`  ${k.message.from}`);
  console.log(`      objet   : ${(k.message.subject || "(sans objet)").slice(0, 70)}`);
  console.log(`      affaire : ${String(client).slice(0, 50)} — ${k.opportunity?.owner ?? "?"}`);
  console.log(`      motif   : ${k.match.reason}`);
}

console.log("\n=== Les B, un par un ===");
for (const k of kept.filter((x) => x.match.level === "B")) {
  console.log(`  ${k.message.from} — ${(k.message.subject || "(sans objet)").slice(0, 60)}`);
  console.log(`      ${k.match.reason}`);
}

console.log("\n=== Faux négatifs commerciaux ===");
if (falseNegatives.length === 0) {
  console.log("  aucun : aucune adresse client connue de Salesforce n'a été écartée.");
} else {
  for (const f of falseNegatives) {
    console.log(`  ÉCARTÉ PAR ${f.rule} : ${f.from} — ${f.subject.slice(0, 60)}`);
  }
}

console.log("\n=== Bruit résiduel : les C, pour repérer ce qui aurait dû être écarté ===");
for (const k of kept.filter((x) => x.match.level === "C")) {
  console.log(`  ${k.message.from.padEnd(38).slice(0, 38)} ${(k.message.subject || "(sans objet)").slice(0, 62)}`);
}
console.log("");

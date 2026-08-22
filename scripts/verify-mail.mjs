/**
 * Validation du Passage A : filtrage du bruit et rattachement mail → opportunité,
 * mesurés sur un échantillon de messages réels.
 *
 *   node --experimental-strip-types scripts/verify-mail.mjs <echantillon.json>
 *
 * L'échantillon ne contient que des métadonnées (expéditeur, destinataires,
 * objet, extrait court) — jamais de corps de message. Rien n'est envoyé à une
 * API externe : tout le traitement est local et déterministe.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sampleFile = process.argv[2];
if (!sampleFile) {
  console.error("usage: node --experimental-strip-types scripts/verify-mail.mjs <echantillon.json>");
  process.exit(1);
}

const libUrl = (name) =>
  pathToFileURL(path.resolve(process.cwd(), `src/lib/${name}.ts`)).href;

const { filterMessage, teamMembersInvolved, isSignedProjectFollowUp, INTERNAL_DOMAIN } =
  await import(libUrl("mail-rules"));
const { buildOpportunityIndex, matchMessage } = await import(libUrl("mail-match"));

// --- Opportunités du périmètre équipe, depuis la base locale.
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"));
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
const index = buildOpportunityIndex(opportunities);
const byId = new Map(opportunities.map((o) => [o.opportunityId, o]));

// --- Échantillon.
const raw = JSON.parse(readFileSync(path.resolve(sampleFile), "utf8"));
const messages = raw
  .map((m) => ({
    id: m.id,
    threadId: m.t,
    date: m.d,
    from: m.f,
    to: m.to ?? [],
    cc: m.cc ?? [],
    subject: m.s ?? "",
    snippet: m.n ?? "",
  }))
  .sort((a, b) => a.date.localeCompare(b.date));

// --- Passe 1 : filtrage. Passe 2 : rattachement, puis filtre chantier signé.
const threadLinks = new Map();
const rejected = [];
const kept = [];

for (const message of messages) {
  const verdict = filterMessage(message);
  if (!verdict.kept) {
    rejected.push({ message, verdict });
    continue;
  }

  const teamMembers = teamMembersInvolved(message);
  const match = matchMessage(message, index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers,
    threadLinks,
  });

  const opportunity = match.opportunityId ? byId.get(match.opportunityId) : null;
  if (opportunity && isSignedProjectFollowUp(message, opportunity.isSigned)) {
    rejected.push({
      message,
      verdict: { rule: "chantier-signe", label: "Suivi de chantier sur une affaire déjà signée" },
    });
    continue;
  }

  if (match.level === "A" && match.opportunityId) {
    threadLinks.set(message.threadId, match.opportunityId);
  }
  kept.push({ message, match, teamMembers, opportunity });
}

// --- Rapport.
const mask = (email) => {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 2)}***@${domain ?? "?"}`;
};
const pct = (n, total) => (total === 0 ? "—" : `${Math.round((100 * n) / total)} %`);

console.log("=== ÉCHANTILLON ===");
console.log(`  messages analysés        : ${messages.length}`);
console.log(`  fils distincts           : ${new Set(messages.map((m) => m.threadId)).size}`);
console.log(
  `  période                  : ${messages[0].date.slice(0, 10)} → ${messages.at(-1).date.slice(0, 10)}`,
);

console.log("\n=== FILTRAGE ===");
console.log(`  rejetés comme bruit      : ${rejected.length}  (${pct(rejected.length, messages.length)})`);
console.log(`  conservés                : ${kept.length}  (${pct(kept.length, messages.length)})`);

const byRule = new Map();
for (const r of rejected) byRule.set(r.verdict.rule, (byRule.get(r.verdict.rule) ?? 0) + 1);
console.log("\n  règles d'exclusion, par efficacité :");
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  const label = rejected.find((r) => r.verdict.rule === rule).verdict.label;
  console.log(`    ${String(count).padStart(3)}  ${rule.padEnd(24)} ${label}`);
}

console.log("\n=== RATTACHEMENT (sur les messages conservés) ===");
const levels = { A: [], B: [], C: [] };
for (const k of kept) levels[k.match.level].push(k);
console.log(`  niveau A (certain)       : ${levels.A.length}  (${pct(levels.A.length, kept.length)})`);
console.log(`  niveau B (probable)      : ${levels.B.length}  (${pct(levels.B.length, kept.length)})`);
console.log(`  niveau C (incertain)     : ${levels.C.length}  (${pct(levels.C.length, kept.length)})`);
console.log(`  rattachés A ou B         : ${levels.A.length + levels.B.length}`);
console.log(`  aucun rattachement forcé : ${levels.C.every((k) => k.match.opportunityId === null) ? "confirmé" : "ANOMALIE"}`);

console.log("\n  --- niveau A, détail ---");
for (const k of levels.A) {
  const o = k.opportunity;
  console.log(
    `    ${k.message.id.padEnd(5)} ${mask(k.message.from).padEnd(26)} → ${o?.opportunityId ?? "?"} ` +
      `${(o?.clientContact ?? "?").slice(0, 24).padEnd(24)} ${o?.owner ?? "?"} [${o?.stage ?? "?"}]`,
  );
  console.log(`          ${k.match.reason}`);
}

console.log("\n  --- niveau B, détail ---");
for (const k of levels.B) {
  const o = k.opportunity;
  console.log(`    ${k.message.id.padEnd(5)} ${mask(k.message.from).padEnd(26)} → ${o?.opportunityId ?? "?"} ${o?.owner ?? "?"}`);
  console.log(`          ${k.match.reason}`);
}

console.log("\n  --- niveau C, détail ---");
for (const k of levels.C) {
  console.log(
    `    ${k.message.id.padEnd(5)} ${mask(k.message.from).padEnd(26)} « ${k.message.subject.slice(0, 46)} »`,
  );
  console.log(`          ${k.match.reason}${k.match.candidates.length ? ` [${k.match.candidates.length} candidates]` : ""}`);
}

console.log("\n=== MESSAGES REJETÉS, PAR RÈGLE ===");
for (const [rule] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`\n  [${rule}]`);
  for (const r of rejected.filter((x) => x.verdict.rule === rule).slice(0, 4)) {
    console.log(`    ${mask(r.message.from).padEnd(28)} « ${r.message.subject.slice(0, 58)} »`);
  }
  const total = byRule.get(rule);
  if (total > 4) console.log(`    … et ${total - 4} autre(s)`);
}

db.close();

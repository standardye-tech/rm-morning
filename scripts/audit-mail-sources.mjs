/**
 * Audit des sources de rattachement disponibles (C13 §1, §2).
 *
 *   npm run mail:sources
 *
 * Pour chaque adresse non rattachée, interroge Salesforce en LECTURE SEULE et
 * établit ce qui existe réellement derrière : une Piste, un Contact, une
 * Opportunité — et dans quel état. C'est la seule façon de distinguer un défaut
 * du moteur de rattachement d'une absence de données.
 *
 * Classement final en quatre familles, parce qu'elles n'appellent pas les mêmes
 * conclusions :
 *
 *   RATTACHABLE   — une affaire du pipe existe, le moteur l'a manquée. C'est là
 *                   que C13 peut gagner.
 *   HORS PIPE     — le client existe mais son affaire est signée, en chantier ou
 *                   terminée. La rattacher donnerait à Morning un GMV déjà acquis,
 *                   ce qui est contraire à sa question : où aller chercher l'argent.
 *   FERMÉE        — affaire perdue ou projet fini. Même raisonnement, en pire.
 *   NON CLIENT    — artisan, fournisseur, partenaire, prospection. Aucun
 *                   rattachement n'existe et aucun n'existera.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage } = await import(lib("morning-events"));

const CLI = path.join(process.env.APPDATA ?? "", "npm/node_modules/@salesforce/cli/bin/run.js");
const soql = async (q) => {
  const { stdout } = await run(
    process.execPath,
    [CLI, "data", "query", "--query", q, "--target-org", "rm-morning", "--json"],
    { env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, maxBuffer: 600 * 1024 * 1024 },
  );
  const r = JSON.parse(stdout);
  if (r.status !== 0) throw new Error((r.message || "").slice(0, 400));
  return r.result.records;
};

const db = getDb();
const quote = (v) => `'${String(v).replace(/'/g, "")}'`;

// Messages retenus par Morning et non rattachés.
const signals = db
  .prepare(
    `SELECT gmail_message_id, thread_id, from_email, from_name, subject, direction,
            opportunity_id, match_level, signal_type, blocker, summary
       FROM mail_signal WHERE direction = 'entrant'`,
  )
  .all();

const kept = signals.filter((s) => triage(s).category !== "ignore");
const unmatched = kept.filter(
  (s) => s.opportunity_id == null || s.match_level === "C",
);
const addresses = [...new Set(unmatched.map((s) => (s.from_email ?? "").toLowerCase()).filter(Boolean))];

console.log(`\n════ SOURCES DE RATTACHEMENT ════\n`);
console.log(`  messages retenus par Morning : ${kept.length}`);
console.log(`  rattachés (A ou B)           : ${kept.length - unmatched.length}`);
console.log(`  non rattachés                : ${unmatched.length}  (${addresses.length} adresses distinctes)`);

const list = addresses.map(quote).join(",");
const leads = await soql(
  `SELECT Id, Email, Name, Owner.Name, Status, IsConverted, ConvertedOpportunityId
     FROM Lead WHERE Email IN (${list})`,
);
const contacts = await soql(`SELECT Id, Email, Name FROM Contact WHERE Email IN (${list})`);

// Toutes les opportunités atteignables depuis ces pistes et contacts.
const oppIds = new Set(leads.map((l) => l.ConvertedOpportunityId).filter(Boolean));
const contactIds = contacts.map((c) => c.Id);
let roles = [];
if (contactIds.length > 0) {
  roles = await soql(
    `SELECT OpportunityId, ContactId FROM OpportunityContactRole
       WHERE ContactId IN (${contactIds.map(quote).join(",")})`,
  );
  for (const r of roles) oppIds.add(r.OpportunityId);
}
const opps =
  oppIds.size === 0
    ? []
    : await soql(
        `SELECT Id, Name, StageName, IsClosed, Amount, CreatedDate, Owner.Name
           FROM Opportunity WHERE Id IN (${[...oppIds].map(quote).join(",")})`,
      );
const oppById = new Map(opps.map((o) => [o.Id, o]));

// Périmètre local : les affaires du pipe que Morning sait exploiter.
const localOpen = new Set(
  db.prepare("SELECT opportunity_id id FROM opportunity WHERE is_terminal = 0").all().map((r) => r.id),
);

const leadsByEmail = new Map();
for (const l of leads) {
  const k = String(l.Email).toLowerCase();
  if (!leadsByEmail.has(k)) leadsByEmail.set(k, []);
  leadsByEmail.get(k).push(l);
}
const contactsByEmail = new Map();
for (const c of contacts) contactsByEmail.set(String(c.Email).toLowerCase(), c);
const rolesByContact = new Map();
for (const r of roles) {
  if (!rolesByContact.has(r.ContactId)) rolesByContact.set(r.ContactId, []);
  rolesByContact.get(r.ContactId).push(r.OpportunityId);
}

const families = new Map();
const bump = (k) => families.set(k, (families.get(k) ?? 0) + 1);
const rows = [];

for (const address of addresses) {
  const ls = leadsByEmail.get(address) ?? [];
  const c = contactsByEmail.get(address) ?? null;
  const reachable = [
    ...ls.map((l) => l.ConvertedOpportunityId).filter(Boolean),
    ...(c ? (rolesByContact.get(c.Id) ?? []) : []),
  ];
  const uniq = [...new Set(reachable)].map((id) => oppById.get(id)).filter(Boolean);
  const inPipe = uniq.filter((o) => localOpen.has(String(o.Id).slice(0, 15)));
  const openOutside = uniq.filter((o) => !o.IsClosed && !localOpen.has(String(o.Id).slice(0, 15)));
  const closed = uniq.filter((o) => o.IsClosed);

  let family;
  let detail;
  if (inPipe.length > 0) {
    family = "RATTACHABLE";
    detail = inPipe.map((o) => `${String(o.Id).slice(0, 15)} ${o.StageName}`).join(" · ");
  } else if (openOutside.length > 0) {
    family = "HORS PIPE";
    detail = openOutside.map((o) => `${o.StageName} · ${Math.round((o.Amount ?? 0) / 1000)}k`).join(" · ");
  } else if (closed.length > 0) {
    family = "FERMÉE";
    detail = closed.map((o) => o.StageName).join(" · ");
  } else if (ls.length > 0) {
    family = ls.some((l) => !l.IsConverted) ? "PISTE SEULE" : "PISTE SANS OPPORTUNITÉ";
    detail = ls.map((l) => `${l.Status}${l.IsConverted ? " (convertie)" : ""}`).join(" · ");
  } else if (c) {
    family = "CONTACT SANS AFFAIRE";
    detail = c.Name;
  } else {
    family = "NON CLIENT";
    detail = "aucune piste, aucun contact";
  }
  bump(family);
  const n = unmatched.filter((s) => (s.from_email ?? "").toLowerCase() === address).length;
  rows.push({ address, family, detail, messages: n, name: ls[0]?.Name ?? c?.Name ?? null });
}

console.log(`\n  ── Ce qui existe réellement derrière chaque adresse ──`);
console.log(`  ${"adresse".padEnd(40)}${"msg".padStart(4)}  ${"famille".padEnd(22)}détail`);
for (const r of rows.sort((a, b) => a.family.localeCompare(b.family) || b.messages - a.messages)) {
  console.log(
    `  ${r.address.slice(0, 38).padEnd(40)}${String(r.messages).padStart(4)}  ${r.family.padEnd(22)}${(r.detail ?? "").slice(0, 60)}`,
  );
}

console.log(`\n  ── Répartition par adresse ──`);
for (const [k, v] of [...families.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

console.log(`\n  ── Répartition par message ──`);
const byFamilyMessages = new Map();
for (const r of rows) byFamilyMessages.set(r.family, (byFamilyMessages.get(r.family) ?? 0) + r.messages);
for (const [k, v] of [...byFamilyMessages.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

console.log(`\n  ── Volumes Salesforce ──`);
for (const [label, q] of [
  ["Lead", "SELECT COUNT() FROM Lead"],
  ["Lead avec Email", "SELECT COUNT() FROM Lead WHERE Email != null"],
  ["Contact", "SELECT COUNT() FROM Contact"],
  ["Contact avec Email", "SELECT COUNT() FROM Contact WHERE Email != null"],
]) {
  const { stdout } = await run(
    process.execPath,
    [CLI, "data", "query", "--query", q, "--target-org", "rm-morning", "--json"],
    { env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, maxBuffer: 1e8 },
  );
  console.log(`  ${label.padEnd(22)}${JSON.parse(stdout).result.totalSize}`);
}
console.log("");

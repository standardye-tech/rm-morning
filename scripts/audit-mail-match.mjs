/**
 * Audit du rattachement Gmail ↔ Salesforce (C13 §1).
 *
 *   npm run mail:audit
 *
 * Ne modifie rien. Reprend les messages classés « client chaud » ou « client
 * attend », et pour chacun de ceux qui ne sont pas rattachés, cherche à établir
 * POURQUOI — en interrogeant les mêmes données que le moteur, plus celles qu'il
 * n'utilise pas encore.
 *
 * L'objectif de cet audit n'est pas de proposer une solution mais de mesurer la
 * répartition des causes : sans elle, on améliorerait au hasard.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage } = await import(lib("morning-events"));
const { loadTeam } = await import(lib("team-store"));
const TEAM = loadTeam();
const { GMAIL_SYNC } = await import(lib("config"));

const db = getDb();
const norm = (v) =>
  (v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
const tokens = (v) => norm(v).split(/[^a-z]+/).filter((t) => t.length >= 4);

const signals = db
  .prepare(
    `SELECT gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
            opportunity_id, match_level, match_reason, salesperson, signal_type, blocker, summary
       FROM mail_signal ORDER BY sent_at DESC`,
  )
  .all();

const opportunities = db
  .prepare(
    `SELECT opportunity_id, client_email, client_contact, name, owner, stage, city, postal_code,
            is_terminal, is_active, is_signed, created_at, last_activity_at
       FROM opportunity`,
  )
  .all();

const leads = db
  .prepare(
    `SELECT lead_id, name, owner, status, city, postal_code, converted_opportunity_id, created_at
       FROM lead`,
  )
  .all();

// Index par adresse, comme le moteur.
const byEmail = new Map();
for (const o of opportunities) {
  const e = norm(o.client_email ?? "");
  if (!e) continue;
  if (!byEmail.has(e)) byEmail.set(e, []);
  byEmail.get(e).push(o);
}

// Index par patronyme, TOUTES opportunités confondues — c'est ce qui permettra de
// distinguer « nom inconnu » de « nom connu mais adresse différente ».
const bySurname = new Map();
const surnameOf = (o) => {
  const person = o.client_contact || (o.name ?? "").split(/\s+[-–—]\s+/)[0];
  const t = tokens(person).filter((x) => x.length >= 5);
  return t.length ? t.reduce((a, b) => (b.length > a.length ? b : a)) : null;
};
for (const o of opportunities) {
  const s = surnameOf(o);
  if (!s) continue;
  if (!bySurname.has(s)) bySurname.set(s, []);
  bySurname.get(s).push(o);
}
const leadBySurname = new Map();
for (const l of leads) {
  const t = tokens(l.name ?? "").filter((x) => x.length >= 5);
  const s = t.length ? t.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  if (!s) continue;
  if (!leadBySurname.has(s)) leadBySurname.set(s, []);
  leadBySurname.get(s).push(l);
}

// Fils déjà rattachés de façon certaine, quel que soit le message.
const threadLinks = new Map();
for (const s of signals) {
  if (s.match_level === "A" && s.opportunity_id) threadLinks.set(s.thread_id, s.opportunity_id);
}

const DOMAIN = GMAIL_SYNC.internalDomain ?? "renovationman.fr";
const GENERIC = /^(contact|info|bonjour|hello|service|commercial|direction|compta|admin|secretariat|accueil|devis)@/i;

const causes = new Map();
const bump = (cause) => causes.set(cause, (causes.get(cause) ?? 0) + 1);

const rows = [];
let hotOrWaiting = 0;
let matched = 0;

for (const s of signals) {
  const t = triage(s);
  if (t.category === "ignore") continue;
  hotOrWaiting += 1;
  const linked = s.opportunity_id != null && (s.match_level === "A" || s.match_level === "B");
  if (linked) {
    matched += 1;
    continue;
  }

  // --- Diagnostic, du plus décisif au plus faible.
  const email = norm(s.from_email ?? "");
  const local = email.split("@")[0] ?? "";
  const domain = email.split("@")[1] ?? "";
  const hay = `${norm(s.subject)} ${norm(s.from_name)} ${local}`;

  let cause;
  let hint = "";

  const emailHits = byEmail.get(email) ?? [];
  const surnameHits = [...bySurname.entries()].filter(([k]) => hay.includes(k));
  const leadHits = [...leadBySurname.entries()].filter(([k]) => hay.includes(k));
  const threadKnown = threadLinks.has(s.thread_id);

  if (threadKnown) {
    cause = "fil rattachable depuis un message antérieur";
    hint = threadLinks.get(s.thread_id);
  } else if (emailHits.length > 1) {
    cause = "adresse partagée par plusieurs opportunités";
    hint = `${emailHits.length} candidates`;
  } else if (emailHits.length === 1) {
    cause = "adresse connue mais écartée par une règle";
    hint = emailHits[0].opportunity_id;
  } else if (GENERIC.test(email)) {
    cause = "adresse générique";
    hint = local;
  } else if (domain && domain !== DOMAIN && surnameHits.length === 1) {
    cause = "nom présent dans Salesforce mais adresse différente";
    hint = `${surnameHits[0][0]} → ${surnameHits[0][1].map((o) => o.opportunity_id).join(", ")}`;
  } else if (surnameHits.length > 1) {
    cause = "plusieurs opportunités pour le même nom";
    hint = surnameHits.map(([k, v]) => `${k}×${v.length}`).join(" ");
  } else if (leadHits.length > 0) {
    cause = "correspond à une Piste, pas à une opportunité";
    hint = leadHits.map(([k, v]) => `${k}→${v.length} piste(s)`).join(" ");
  } else if (!email) {
    cause = "aucune adresse exploitable";
  } else if (domain === DOMAIN) {
    cause = "expéditeur interne";
  } else {
    cause = "email absent de Salesforce et nom inconnu";
    hint = email;
  }

  bump(cause);
  rows.push({
    at: (s.sent_at ?? "").slice(0, 10),
    from: s.from_email,
    name: s.from_name,
    subject: (s.subject ?? "").slice(0, 46),
    category: t.category,
    level: s.match_level,
    cause,
    hint,
  });
}

console.log(`\n════ AUDIT DU RATTACHEMENT ════\n`);
console.log(`  messages retenus par Morning (chaud ou attente) : ${hotOrWaiting}`);
console.log(`  rattachés (A ou B)                              : ${matched}`);
console.log(
  `  non rattachés                                   : ${hotOrWaiting - matched}` +
    `   → taux actuel ${((matched / Math.max(1, hotOrWaiting)) * 100).toFixed(0)} %`,
);

console.log(`\n  ── Répartition des causes ──`);
for (const [cause, n] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${cause}`);
}

console.log(`\n  ── Détail ──`);
console.log(
  `  ${"date".padEnd(11)}${"cat".padEnd(9)}${"expéditeur".padEnd(34)}${"objet".padEnd(48)}cause`,
);
for (const r of rows) {
  console.log(
    `  ${r.at.padEnd(11)}${r.category.padEnd(9)}${String(r.from ?? "—").slice(0, 32).padEnd(34)}` +
      `${r.subject.padEnd(48)}${r.cause}${r.hint ? ` [${r.hint}]` : ""}`,
  );
}

// --- Ce que les sources non encore utilisées pourraient apporter.
console.log(`\n  ── Sources disponibles ──`);
console.log(`  opportunités                : ${opportunities.length}`);
console.log(
  `  dont adresse client          : ${opportunities.filter((o) => o.client_email).length}`,
);
console.log(`  pistes                      : ${leads.length}`);
console.log(`  dont adresse                : 0  (la table lead ne porte aucun email)`);
console.log(
  `  pistes converties            : ${leads.filter((l) => l.converted_opportunity_id).length}`,
);
console.log(`  fils Gmail distincts         : ${new Set(signals.map((s) => s.thread_id)).size}`);
console.log(`  fils déjà rattachés en A     : ${threadLinks.size}`);
const outbound = signals.filter((s) => s.direction !== "entrant");
console.log(
  `  messages sortants/internes   : ${outbound.length}` +
    `  (dont ${outbound.filter((s) => threadLinks.has(s.thread_id)).length} dans un fil rattaché)`,
);
console.log(`  membres d'équipe configurés  : ${TEAM.length}\n`);

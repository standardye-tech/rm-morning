/**
 * Audit du triage Morning (C14 §1).
 *
 *   npm run morning:triage-audit
 *
 * Ne modifie rien. Reprend tous les messages actuellement retenus par Morning et
 * croise, pour chacun, la catégorie décidée par le triage avec ce que C13 sait de
 * l'interlocuteur. C'est ce croisement qui révèle les faux positifs : un message
 * peut être parfaitement classé « souhaite avancer » et venir d'un fournisseur.
 *
 * La famille est proposée par des signaux factuels, jamais devinée. Les cas non
 * tranchables restent « à qualifier » : inventer une vérité fausserait la mesure
 * de précision qui suivra.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage } = await import(lib("morning-events"));
const { INTERNAL_DOMAIN } = await import(lib("mail-rules"));

const db = getDb();

const rows = db
  .prepare(
    `SELECT m.gmail_message_id, m.thread_id, m.sent_at, m.from_email, m.from_name, m.subject,
            m.direction, m.opportunity_id, m.lead_id, m.match_level, m.match_kind, m.match_reason,
            m.salesperson, m.signal_type, m.blocker, m.summary,
            o.owner, o.gmv, o.stage, o.is_terminal,
            d.resolved_kind, d.opportunity_stage, d.opportunity_amount, d.opportunity_owner,
            d.lead_status, d.lead_name, d.contact_name
       FROM mail_signal m
       LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id
       LEFT JOIN mail_directory d ON d.email = lower(m.from_email)
      ORDER BY m.sent_at DESC`,
  )
  .all();

const kept = rows.filter((r) => triage(r).category !== "ignore");

/**
 * Familles d'interlocuteur, établies sur des signaux factuels.
 *
 * L'ordre compte : un salarié reste un salarié même s'il est aussi contact d'une
 * affaire, et une affaire fermée l'emporte sur le domaine de l'adresse.
 */
const SAAS = /@(go-kelvin|lumidb|buildpokeslide|sanctuary-pass|cmtd1|obat)\./i;
const PRO_DOMAIN = /@[a-z0-9-]*(batiment|construction|renovation|habitat|artisan|menuiserie|elec|plomb|couvert|archi|studio|atelier|ixina|cuisine|immo)[a-z0-9-]*\./i;
const FREE = /@(gmail|hotmail|outlook|yahoo|orange|free|wanadoo|sfr|laposte|aol|icloud|me|live|msn|bbox|numericable)\./i;

function family(r) {
  const email = (r.from_email ?? "").toLowerCase();
  const domain = email.split("@")[1] ?? "";

  if (domain === INTERNAL_DOMAIN) return ["salarié RM", "domaine interne"];
  if (SAAS.test(email)) return ["prospection SaaS", "domaine de prospection connu"];

  const kind = r.match_kind ?? r.resolved_kind ?? "inconnu";
  if (kind === "affaire_fermee") {
    const stage = (r.opportunity_stage ?? "").toLowerCase();
    if (stage.includes("perdue")) return ["affaire perdue", r.opportunity_stage];
    return ["affaire terminée", r.opportunity_stage ?? "close"];
  }
  if (kind === "affaire_hors_pipe") return ["chantier en cours", r.opportunity_stage ?? "signée"];
  if (kind === "affaire_pipe") return ["client actif (pipe)", r.stage ?? ""];
  if (kind === "piste") {
    const s = (r.lead_status ?? "").toLowerCase();
    if (s.includes("abandon")) return ["piste abandonnée", r.lead_status];
    return ["piste active", r.lead_status ?? ""];
  }
  if (kind === "contact") return ["contact sans affaire", r.contact_name ?? r.lead_name ?? ""];

  // Aucune entité Salesforce : le domaine devient le seul indice disponible.
  if (PRO_DOMAIN.test(email)) return ["artisan / fournisseur / partenaire", domain];
  if (!FREE.test(email) && domain) return ["entreprise inconnue", domain];
  return ["à qualifier", domain];
}

const byFamily = new Map();
const byCategoryFamily = new Map();
const detail = [];

for (const r of kept) {
  const t = triage(r);
  const [fam, why] = family(r);
  byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
  const key = `${t.category} · ${fam}`;
  byCategoryFamily.set(key, (byCategoryFamily.get(key) ?? 0) + 1);
  detail.push({
    at: (r.sent_at ?? "").slice(0, 10),
    category: t.category,
    family: fam,
    why,
    from: r.from_email,
    subject: (r.subject ?? "").replace(/[^\x20-\x7EÀ-ÿ]/g, "").slice(0, 44),
    kind: r.match_kind ?? "—",
    salesperson: r.owner ?? r.opportunity_owner ?? r.salesperson ?? null,
    gmv: r.match_kind === "affaire_pipe" ? r.gmv : null,
    reason: t.reason,
  });
}

console.log(`\n════ AUDIT DU TRIAGE MORNING ════\n`);
console.log(`  messages en base            : ${rows.length}`);
console.log(`  retenus par Morning         : ${kept.length}`);
console.log(
  `  dont clients chauds         : ${kept.filter((r) => triage(r).category === "chaud").length}`,
);
console.log(
  `  dont clients qui attendent  : ${kept.filter((r) => triage(r).category === "attente").length}`,
);

console.log(`\n  ── Familles d'interlocuteur ──`);
for (const [k, v] of [...byFamily.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

console.log(`\n  ── Croisement catégorie × famille ──`);
for (const [k, v] of [...byCategoryFamily.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

console.log(`\n  ── Détail ──`);
console.log(
  `  ${"date".padEnd(11)}${"cat".padEnd(9)}${"famille".padEnd(30)}${"expéditeur".padEnd(34)}${"GMV".padStart(7)}  objet`,
);
for (const d of detail) {
  console.log(
    `  ${d.at.padEnd(11)}${d.category.padEnd(9)}${d.family.slice(0, 28).padEnd(30)}` +
      `${String(d.from ?? "").slice(0, 32).padEnd(34)}` +
      `${(d.gmv ? `${Math.round(d.gmv / 1000)}k` : "—").padStart(7)}  ${d.subject}`,
  );
}

// --- Ce que Morning porte réellement comme argent.
const pipe = detail.filter((d) => d.kind === "affaire_pipe");
console.log(`\n  ── Argent représenté ──`);
console.log(`  actions portant une affaire du pipe : ${pipe.length}`);
console.log(
  `  GMV pipe couvert                    : ${Math.round(
    pipe.reduce((t, d) => t + (d.gmv ?? 0), 0) / 1000,
  )} k€`,
);
const owners = new Map();
for (const d of pipe) owners.set(d.salesperson ?? "—", (owners.get(d.salesperson ?? "—") ?? 0) + 1);
console.log(
  `  par commercial                      : ${[...owners.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ")}`,
);
console.log("");

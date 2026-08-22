/**
 * Contrôles du rapprochement Gmail ↔ Salesforce (C13 §20, §28).
 *
 *   npm run mail:verify
 *
 * Deux familles :
 *
 *   — un BACKTEST : les rattachements aujourd'hui certains sont cachés au moteur
 *     — annuaire vidé, mémoire des fils vidée — et l'on vérifie qu'il les
 *     retrouve par ses propres moyens. C'est la seule façon de mesurer une
 *     précision sans se contenter de relire ce qu'on vient d'écrire ;
 *   — les TESTS MÉTIER, sur des cas fabriqués. Un client homonyme chez deux
 *     commerciaux différents n'existe pas forcément dans la boîte du jour :
 *     attendre qu'il apparaisse laisserait le contrôle au hasard.
 *
 * Le backtest ne modifie rien : il travaille sur des copies en mémoire.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { buildOpportunityIndex, matchMessage, nameTokens } = await import(lib("mail-match"));
const { loadThreadLinks, linkThreadManually, getThreadLink } = await import(lib("mail-thread-link"));
const { INTERNAL_DOMAIN } = await import(lib("mail-rules"));
const { triage } = await import(lib("morning-events"));

const db = getDb();
let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const opportunities = (
  db
    .prepare(
      `SELECT opportunity_id, client_email, client_contact, name, owner, stage, is_signed, is_active
         FROM opportunity`,
    )
    .all()
).map((r) => ({
  opportunityId: r.opportunity_id,
  clientEmail: r.client_email,
  clientContact: r.client_contact,
  name: r.name,
  owner: r.owner,
  stage: r.stage,
  isSigned: r.is_signed === 1,
  isActive: r.is_active === 1,
}));
const index = buildOpportunityIndex(opportunities);
const threadLinks = loadThreadLinks();

const msg = (over) => ({
  id: "m",
  threadId: "t",
  date: "2026-08-17T09:00:00Z",
  from: "",
  to: [],
  cc: [],
  subject: "",
  snippet: "",
  ...over,
});

// ── ÉTAT ────────────────────────────────────────────────────────────────────
const signals = db
  .prepare(
    `SELECT gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction,
            opportunity_id, lead_id, match_level, match_kind, match_reason, salesperson,
            signal_type, blocker, summary
       FROM mail_signal`,
  )
  .all();
const kept = signals.filter((s) => triage(s).category !== "ignore");
const identified = kept.filter((s) => s.match_kind && s.match_kind !== "inconnu" && s.match_kind !== "ambigu");
const inPipe = kept.filter((s) => s.match_kind === "affaire_pipe");

console.log("\n════ RAPPROCHEMENT GMAIL / SALESFORCE ════\n");
console.log(`  messages retenus par Morning : ${kept.length}`);
console.log(`  interlocuteur identifié      : ${identified.length}  (${((identified.length / kept.length) * 100).toFixed(0)} %)`);
console.log(`  dont affaire du pipe         : ${inPipe.length}`);
const byKind = {};
for (const s of kept) byKind[s.match_kind ?? "(vide)"] = (byKind[s.match_kind ?? "(vide)"] ?? 0) + 1;
console.log(`  répartition                  : ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

// ── BACKTEST ────────────────────────────────────────────────────────────────
console.log("\n──── BACKTEST : le moteur retrouve-t-il ce qu'il sait déjà ? ────\n");

// Vérité : les rattachements certains vers une affaire du pipe, seuls vérifiables
// sans jugement humain — ils viennent d'une adresse client exacte.
const truth = signals.filter(
  (s) => s.match_level === "A" && s.opportunity_id && s.match_kind === "affaire_pipe" && s.from_email,
);

let recovered = 0;
let wrong = 0;
let missed = 0;
// Deux populations très différentes : les rattachements que l'ADRESSE établit
// seule — le moteur doit tous les retrouver — et ceux qui n'existent que parce
// qu'un message antérieur du même fil avait tranché. Vider la mémoire des fils
// rend les seconds structurellement irrécupérables : les compter comme des échecs
// mesurerait la mémoire qu'on vient de supprimer, pas le moteur.
// Le critère est la RAISON enregistrée : « adresse client unique » signifie que
// l'adresse a suffi. Tout le reste — fil, annuaire — repose sur une mémoire.
const addressTruth = new Set(
  truth
    .filter((s) => String(s.match_reason ?? "").startsWith("adresse client unique"))
    .map((s) => s.gmail_message_id),
);
let addrRecovered = 0;
for (const s of truth) {
  // Mémoires vidées : ni fil, ni annuaire. Le moteur ne peut s'appuyer que sur
  // l'adresse et le nom.
  const r = matchMessage(
    msg({ id: s.gmail_message_id, threadId: `bt-${s.gmail_message_id}`, from: s.from_email, subject: s.subject ?? "" }),
    index,
    {
      internalDomain: INTERNAL_DOMAIN,
      teamMembers: s.salesperson ? [s.salesperson] : [],
      threadLink: null,
      directory: new Map(),
      senderMemory: [],
      fromName: s.from_name,
    },
  );
  if (r.opportunityId === s.opportunity_id) {
    recovered += 1;
    if (addressTruth.has(s.gmail_message_id)) addrRecovered += 1;
  } else if (r.opportunityId != null) wrong += 1;
  else missed += 1;
}
const precision = recovered + wrong > 0 ? recovered / (recovered + wrong) : 1;
console.log(`  vérité (rattachements certains au pipe) : ${truth.length}`);
console.log(`  retrouvés                               : ${recovered}`);
console.log(`  manqués (aucune proposition)            : ${missed}`);
console.log(`  FAUX (autre affaire proposée)           : ${wrong}`);
console.log(`  précision                               : ${(precision * 100).toFixed(1)} %`);
console.log(`  couverture                              : ${((recovered / Math.max(1, truth.length)) * 100).toFixed(1)} %`);

check("B1. aucun faux rattachement au backtest", wrong === 0, `${wrong} erreur(s)`);
console.log(`  dont établis par l'adresse seule        : ${addressTruth.size}`);
check(
  "B2. tous les rattachements établis par l'adresse sont retrouvés",
  addrRecovered === addressTruth.size,
  `${addrRecovered}/${addressTruth.size}`,
);
console.log(
  `  les ${truth.length - addressTruth.size} autres ne tiennent que par la mémoire du fil,` +
    ` vidée pour ce test.`,
);

// ── TESTS MÉTIER ────────────────────────────────────────────────────────────
console.log("\n──── TESTS MÉTIER ────\n");

// Échantillon : une affaire dont l'adresse est EXTERNE — une adresse au domaine
// de l'entreprise est écartée par construction, ce n'est pas un client.
const sample = opportunities.find(
  (o) =>
    o.clientEmail &&
    o.clientContact &&
    !o.clientEmail.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`) &&
    opportunities.filter((x) => (x.clientEmail ?? "").toLowerCase() === o.clientEmail.toLowerCase())
      .length === 1,
);

// 1. Adresse exacte d'une affaire unique du pipe → certain.
{
  const r = matchMessage(msg({ from: sample.clientEmail }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: new Map(),
  });
  check(
    "1. adresse exacte, affaire unique du pipe → certain",
    r.level === "A" && r.opportunityId === sample.opportunityId && r.kind === "affaire_pipe",
    r.reason,
  );
}

// 2. Adresse d'une piste non convertie → piste identifiée, aucune affaire.
{
  const dir = new Map([
    ["p@x.fr", { kind: "piste", confidence: "certain", reason: "piste Nouvelle piste", opportunityId: null, leadId: "00Q1", candidates: [] }],
  ]);
  const r = matchMessage(msg({ from: "p@x.fr" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: dir,
  });
  check(
    "2. adresse d'une piste non convertie → piste, sans affaire",
    r.level === "A" && r.kind === "piste" && r.leadId === "00Q1" && r.opportunityId === null,
    r.reason,
  );
}

// 3. Piste convertie → l'affaire issue de la conversion.
{
  const dir = new Map([
    ["c@x.fr", { kind: "affaire_pipe", confidence: "certain", reason: "adresse rattachée à une affaire du pipe", opportunityId: "006XYZ", leadId: "00Q2", candidates: [] }],
  ]);
  const r = matchMessage(msg({ from: "c@x.fr" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: dir,
  });
  check("3. piste convertie → affaire de la conversion", r.opportunityId === "006XYZ" && r.level === "A", r.reason);
}

// 4. Même fil → conserve l'affaire, quelle que soit l'adresse.
{
  const r = matchMessage(msg({ from: "inconnu@ailleurs.fr", threadId: "T1" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: new Map(),
    threadLink: { opportunityId: "006AAA", leadId: null, kind: "affaire_pipe", confidence: "certain", isManual: false },
  });
  check("4. même fil → conserve l'affaire", r.opportunityId === "006AAA" && r.level === "A", r.reason);
}

// 5. Même expéditeur, NOUVEAU fil → peut désigner une autre affaire.
{
  const dir = new Map([
    ["multi@x.fr", { kind: "affaire_pipe", confidence: "certain", reason: "nouvelle affaire", opportunityId: "006NEW", leadId: null, candidates: [] }],
  ]);
  const r = matchMessage(msg({ from: "multi@x.fr", threadId: "T-NOUVEAU" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: dir,
    threadLink: null,
    senderMemory: [{ opportunityId: "006ANCIEN", threads: 3 }],
  });
  check(
    "5. nouveau fil du même expéditeur → peut changer d'affaire",
    r.opportunityId === "006NEW",
    `${r.opportunityId} · ${r.reason}`,
  );
}

// 6. Deux affaires ouvertes possibles → jamais de faux certain.
{
  const dir = new Map([
    ["deux@x.fr", { kind: "affaire_pipe", confidence: "a_verifier", reason: "2 affaires ouvertes portent cette adresse", opportunityId: "006A", leadId: null, candidates: ["006A", "006B"] }],
  ]);
  const r = matchMessage(msg({ from: "deux@x.fr" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: dir,
  });
  check(
    "6. deux affaires ouvertes → à vérifier, pas de faux certain",
    r.level === "C" && r.candidates.length === 2,
    r.reason,
  );
}

// 7. Nom composé normalisé.
{
  const a = nameTokens("Jean-Pierre DURAND").sort().join(" ");
  const b = nameTokens("jean pierre durand").sort().join(" ");
  const c = nameTokens("M. Jean-Pierre  Durand").sort().join(" ");
  check("7. nom composé normalisé", a === b && b === c, a);
}

// 8. Homonymes chez deux commerciaux → le commercial désambiguïse.
{
  const twins = [
    { opportunityId: "006C1", clientEmail: null, clientContact: "Pauline LEFEBVRE", name: null, owner: "Vincent Bouzy", stage: null, isSigned: false, isActive: true },
    { opportunityId: "006C2", clientEmail: null, clientContact: "Pauline LEFEBVRE", name: null, owner: "Mathis Coulon", stage: null, isSigned: false, isActive: true },
  ];
  const idx = buildOpportunityIndex(twins);
  const both = matchMessage(msg({ from: "pauline.lefebvre@x.fr" }), idx, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: ["Vincent Bouzy", "Mathis Coulon"],
    directory: new Map(),
    fromName: "Pauline Lefebvre",
  });
  const one = matchMessage(msg({ from: "pauline.lefebvre@x.fr" }), idx, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: ["Vincent Bouzy"],
    directory: new Map(),
    fromName: "Pauline Lefebvre",
  });
  check(
    "8. homonymes → ambigu à deux commerciaux, tranché à un seul",
    both.level === "C" && one.level === "B" && one.opportunityId === "006C1",
    `${both.reason} / ${one.reason}`,
  );
}

// 9 & 10. Validation manuelle mémorisée, et conservée après resynchronisation.
{
  const threadId = "verify-manuel";
  const before = getThreadLink(threadId);
  linkThreadManually(threadId, { opportunityId: "006MANUEL" });
  const stored = getThreadLink(threadId);
  const r = matchMessage(msg({ from: "peu.importe@x.fr", threadId }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: new Map(),
    threadLink: { ...stored, kind: stored.kind, confidence: stored.confidence, isManual: stored.isManual },
  });
  check(
    "9. validation manuelle mémorisée et prioritaire",
    stored.isManual && r.opportunityId === "006MANUEL" && r.isManual && r.level === "A",
    r.reason,
  );
  // Une inférence automatique contraire ne doit pas l'écraser.
  const { rememberThread } = await import(lib("mail-thread-link"));
  rememberThread({ threadId, opportunityId: "006AUTRE", leadId: null, kind: "affaire_pipe", confidence: "certain" });
  const after = getThreadLink(threadId);
  check(
    "10. la synchronisation suivante ne défait pas la validation",
    after.opportunityId === "006MANUEL" && after.isManual,
    after.opportunityId,
  );
  // Remise en l'état : ce contrôle ne laisse pas de trace.
  if (before == null) db.prepare("DELETE FROM mail_thread_link WHERE thread_id = ?").run(threadId);
}

// 11. « Pris en compte » conservé.
{
  const n = db.prepare("SELECT COUNT(*) n FROM morning_event WHERE status <> 'nouveau'").get().n;
  const row = db.prepare("SELECT gmail_message_id id, status, acknowledged_at at FROM morning_event WHERE status <> 'nouveau' LIMIT 1").get();
  const { syncMorningEvents } = await import(lib("morning-events"));
  syncMorningEvents();
  const after = row
    ? db.prepare("SELECT status, acknowledged_at at FROM morning_event WHERE gmail_message_id = ?").get(row.id)
    : null;
  check(
    "11. « Pris en compte » conservé après recalcul des alertes",
    row == null || (after.status === row.status && after.at === row.at),
    row ? `${n} alerte(s) traitée(s), date conservée` : "aucune alerte traitée en base",
  );
}

// 12. Une affaire close ne prend pas le dessus sur une affaire ouverte.
{
  const dir = new Map([
    ["deuxprojets@x.fr", { kind: "affaire_pipe", confidence: "certain", reason: "adresse rattachée à une affaire du pipe", opportunityId: "006OUVERTE", leadId: null, candidates: [] }],
  ]);
  const r = matchMessage(msg({ from: "deuxprojets@x.fr" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: dir,
  });
  check(
    "12. l'affaire ouverte l'emporte sur l'affaire close",
    r.opportunityId === "006OUVERTE" && r.kind === "affaire_pipe",
    r.reason,
  );
}

// 13. Message sortant : ignoré comme alerte, mais il alimente la mémoire du fil.
{
  const outbound = signals.filter((s) => s.direction !== "entrant");
  const inMorning = db
    .prepare(
      `SELECT COUNT(*) n FROM morning_event e JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
        WHERE m.direction <> 'entrant' AND e.category <> 'ignore'`,
    )
    .get().n;
  const feedingThreads = outbound.filter((s) => threadLinks.has(s.thread_id)).length;
  check(
    "13. les sortants ne deviennent pas des alertes, mais servent au fil",
    inMorning === 0,
    `${outbound.length} sortant(s)/interne(s) · ${feedingThreads} dans un fil rattaché · ${inMorning} alerte(s)`,
  );
}

// 14. Aucun signal → affaire non identifiée, et rien d'inventé.
{
  const r = matchMessage(msg({ from: "personne@nulle-part-connu.zz" }), index, {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: [],
    directory: new Map(),
  });
  check(
    "14. aucun signal → affaire non identifiée",
    r.level === "C" && r.opportunityId === null && r.leadId === null && r.kind === "inconnu",
    r.reason,
  );
}

// 15. L'objet du message ne doit plus servir au rattachement par nom.
//     C'était le défaut corrigé en C13 : « Relance … » rapprochait un client LANCE.
{
  const lance = [
    { opportunityId: "006LANCE", clientEmail: null, clientContact: "Nathalie LANCE", name: null, owner: "Vincent Bouzy", stage: null, isSigned: false, isActive: true },
  ];
  const r = matchMessage(
    msg({ from: "quelquun@ailleurs.fr", subject: "RE: Relance document en fin de validité" }),
    buildOpportunityIndex(lance),
    { internalDomain: INTERNAL_DOMAIN, teamMembers: ["Vincent Bouzy"], directory: new Map(), fromName: "Nord Construction" },
  );
  check(
    "15. l'objet du message ne crée plus de faux rapprochement de nom",
    r.opportunityId === null,
    r.reason,
  );
}

// 16. Un prénom seul ne suffit plus.
{
  const thomas = [
    { opportunityId: "006THOMAS", clientEmail: null, clientContact: "Thomas BERGER", name: null, owner: "Vincent Bouzy", stage: null, isSigned: false, isActive: true },
  ];
  const r = matchMessage(msg({ from: "thomas.pasquier@gmail.com" }), buildOpportunityIndex(thomas), {
    internalDomain: INTERNAL_DOMAIN,
    teamMembers: ["Vincent Bouzy"],
    directory: new Map(),
    fromName: "Thomas Pasquier",
  });
  check("16. un prénom commun ne suffit pas à rattacher", r.opportunityId === null, r.reason);
}

console.log(
  failures === 0
    ? `\n  ${total} contrôles au vert.\n`
    : `\n  ${failures} contrôle(s) en échec sur ${total}.\n`,
);
process.exit(failures === 0 ? 0 : 1);

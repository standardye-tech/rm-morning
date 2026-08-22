/**
 * Contrôles du triage Morning (C14 §20, §30).
 *
 *   npm run morning:triage-verify
 *
 * Deux familles :
 *
 *   — un BACKTEST sur les messages réels, avec une vérité établie à partir de
 *     faits Salesforce et non d'une impression de lecture. Les cas qu'aucun fait
 *     ne tranche restent « incertain » et sortent du calcul de précision :
 *     leur inventer une étiquette fabriquerait le résultat ;
 *   — les TESTS MÉTIER, sur des cas construits. Un « affaire perdue + nouveau
 *     projet annoncé » n'existe pas forcément dans la boîte du jour.
 *
 * Aucune écriture.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage, loadMorningEvents, syncMorningEvents } = await import(lib("morning-events"));
const { evaluateEligibility, isPureAcknowledgement } = await import(lib("morning-eligibility"));
const { INTERNAL_DOMAIN } = await import(lib("mail-rules"));

const db = getDb();
let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const rows = db
  .prepare(
    `SELECT m.gmail_message_id, m.from_email, m.subject, m.summary, m.blocker, m.direction,
            m.signal_type, m.match_kind, m.opportunity_id,
            d.opportunity_stage, d.lead_status,
            o.gmv, o.owner, o.is_terminal
       FROM mail_signal m
       LEFT JOIN mail_directory d ON d.email = lower(m.from_email)
       LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id`,
  )
  .all();

/**
 * Vérité de référence, établie sur des FAITS.
 *
 *   doit_etre_morning  — une affaire du pipe est ouverte derrière l'expéditeur ;
 *   ne_doit_pas        — salarié, domaine de prospection, affaire close, chantier
 *                        signé, piste abandonnée : autant d'états Salesforce ;
 *   incertain          — aucune entité Salesforce, ou contact sans affaire. Rien
 *                        ne permet de trancher sans jugement métier.
 */
function groundTruth(r) {
  const email = (r.from_email ?? "").toLowerCase();
  if (r.direction !== "entrant") return "ne_doit_pas";
  if (email.endsWith(`@${INTERNAL_DOMAIN}`)) return "ne_doit_pas";
  switch (r.match_kind) {
    case "affaire_pipe":
      // Corrigé en C15 : le rattachement nomme encore « affaire du pipe » une
      // opportunité déjà signée, qui reste en base jusqu'à sa clôture. Une
      // affaire terminale n'appelle aucune action commerciale.
      return r.is_terminal === 1 ? "ne_doit_pas" : "doit_etre_morning";
    case "affaire_fermee":
    case "affaire_hors_pipe":
      return "ne_doit_pas";
    case "piste":
      // Une piste ABANDONNÉE est un fait. Une piste active ne dit rien de la
      // nature de l'expéditeur : Salesforce contient aussi des pistes créées
      // pour des prestataires qui démarchent l'entreprise. On ne tranche pas.
      return /abandon|perdue/i.test(r.lead_status ?? "") ? "ne_doit_pas" : "incertain";
    default:
      return "incertain";
  }
}

// ── BACKTEST ────────────────────────────────────────────────────────────────
console.log("\n════ TRIAGE MORNING ════\n");

const retained = (r) => {
  const c = triage(r).category;
  return c === "chaud" || c === "attente";
};

const labelled = rows.map((r) => ({ r, truth: groundTruth(r), kept: retained(r) }));
const decidable = labelled.filter((x) => x.truth !== "incertain");

const tp = decidable.filter((x) => x.truth === "doit_etre_morning" && x.kept).length;
const fp = decidable.filter((x) => x.truth === "ne_doit_pas" && x.kept).length;
const fn = decidable.filter((x) => x.truth === "doit_etre_morning" && !x.kept).length;
const uncertainKept = labelled.filter((x) => x.truth === "incertain" && x.kept).length;

const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
const recall = tp + fn > 0 ? tp / (tp + fn) : 1;

console.log(`  messages en base                 : ${rows.length}`);
console.log(`  vérité tranchable                : ${decidable.length}`);
console.log(`  dont doivent être dans Morning   : ${decidable.filter((x) => x.truth === "doit_etre_morning").length}`);
console.log(`  dont ne doivent pas y être       : ${decidable.filter((x) => x.truth === "ne_doit_pas").length}`);
console.log(`  cas incertains (hors calcul)     : ${labelled.length - decidable.length}, dont ${uncertainKept} retenus`);
console.log("");
console.log(`  vrais positifs                   : ${tp}`);
console.log(`  FAUX positifs                    : ${fp}`);
console.log(`  faux négatifs                    : ${fn}`);
console.log(`  précision                        : ${(precision * 100).toFixed(1)} %`);
console.log(`  rappel                           : ${(recall * 100).toFixed(1)} %`);

check("B1. aucun faux positif sur une vérité tranchable", fp === 0, `${fp} message(s)`);
// C14 n'agit que sur l'ÉTAGE A. Un message écarté par l'étage B — « aucune
// intention identifiable », « signal de risque sans demande » — l'était déjà
// avant ce chantier, et le compter ici mesurerait autre chose que C14.
const excludedByC14 = rows.filter(
  (r) =>
    r.match_kind === "affaire_pipe" &&
    // Une affaire signée n'est plus du pipe : son exclusion est voulue.
    r.is_terminal !== 1 &&
    r.direction === "entrant" &&
    evaluateEligibility(
      { fromEmail: r.from_email, subject: r.subject, summary: r.summary },
      {
        matchKind: r.match_kind,
        externalStage: r.opportunity_stage,
        leadStatus: r.lead_status,
        dealStage: r.stage,
        dealIsTerminal: r.is_terminal === 1,
        direction: r.direction,
      },
      INTERNAL_DOMAIN,
    ).verdict === "non",
);
check(
  "B2. aucune affaire du pipe écartée par le filtre de périmètre",
  excludedByC14.length === 0,
  `${excludedByC14.length} message(s)`,
);

// Mesure informative : ce que l'étage d'intention écarte, indépendamment de C14.
const byStageB = rows.filter(
  (r) =>
    r.match_kind === "affaire_pipe" &&
    r.is_terminal !== 1 &&
    r.direction === "entrant" &&
    !retained(r),
);
console.log(
  `
  écartés par l'étage d'intention (antérieur à C14) : ${byStageB.length} affaire(s) du pipe`,
);
for (const r of byStageB) {
  console.log(`    ${r.from_email} · ${triage(r).ignoredBecause} · ${(r.subject ?? "").slice(0, 38)}`);
}

if (fp > 0) {
  console.log("\n  faux positifs :");
  for (const x of decidable.filter((y) => y.truth === "ne_doit_pas" && y.kept)) {
    console.log(`    ${x.r.from_email} · ${x.r.match_kind} · ${(x.r.subject ?? "").slice(0, 40)}`);
  }
}
if (fn > 0) {
  console.log("\n  faux négatifs :");
  for (const x of decidable.filter((y) => y.truth === "doit_etre_morning" && !y.kept)) {
    console.log(
      `    ${x.r.from_email} · ${triage(x.r).ignoredBecause} · ${(x.r.subject ?? "").slice(0, 40)}`,
    );
  }
}

// ── TESTS MÉTIER ────────────────────────────────────────────────────────────
console.log("\n──── TESTS MÉTIER ────\n");

const row = (over) => ({
  direction: "entrant",
  subject: "",
  summary: "",
  blocker: null,
  signal_type: "neutre",
  from_email: "client@gmail.com",
  match_kind: null,
  opportunity_stage: null,
  lead_status: null,
  ...over,
});

// 1. Affaire active + demande de devis.
{
  const t = triage(
    row({
      match_kind: "affaire_pipe",
      subject: "Pouvez-vous m'envoyer le devis ?",
      summary: "Le client demande le devis pour valider",
      signal_type: "positif_bloque",
    }),
  );
  check("1. affaire active + demande de devis → Morning", t.category === "chaud", t.reason || t.ignoredBecause);
}

// 2. Affaire active + relance.
{
  const t = triage(
    row({
      match_kind: "affaire_pipe",
      subject: "Relance",
      summary: "Je vous relance, sans reponse de votre part",
      signal_type: "neutre",
    }),
  );
  check("2. affaire active + relance → Morning", t.category === "attente", t.reason || t.ignoredBecause);
}

// 3. Fournisseur sur un chantier terminé, ton urgent.
{
  const t = triage(
    row({
      from_email: "mgouron@ixina.com",
      match_kind: "affaire_hors_pipe",
      opportunity_stage: "Chantier en cours",
      subject: "URGENT : il faut valider avant vendredi",
      summary: "Demande de validation urgente",
      signal_type: "signature",
    }),
  );
  check(
    "3. fournisseur + chantier signé + « urgent » → hors périmètre",
    t.category === "hors_perimetre",
    t.ignoredBecause,
  );
}

// 4. Prospection SaaS.
{
  const t = triage(
    row({
      from_email: "juliette.girard@buildpokeslide.com",
      subject: "Powerpoint pour votre équipe",
      summary: "Proposition de notre solution",
      signal_type: "neutre",
    }),
  );
  check("4. prospection SaaS → hors périmètre", t.category === "hors_perimetre", t.ignoredBecause);
}

// 5. Salarié RM.
{
  const t = triage(
    row({
      from_email: `vincent.bouzy@${INTERNAL_DOMAIN}`,
      match_kind: "affaire_pipe",
      subject: "Le client veut signer",
      signal_type: "signature",
    }),
  );
  check("5. salarié RM → hors périmètre", t.category === "hors_perimetre", t.ignoredBecause);
}

// 6. Affaire perdue, message sur l'ancien projet.
{
  const t = triage(
    row({
      match_kind: "affaire_fermee",
      opportunity_stage: "Affaire perdue",
      subject: "Re: Renovation man a votre service",
      summary: "Le client repond a un ancien echange",
      signal_type: "positif_bloque",
    }),
  );
  check("6. affaire perdue + ancien projet → hors périmètre", t.category === "hors_perimetre", t.ignoredBecause);
}

// 7. Affaire perdue, mais nouveau projet explicitement annoncé.
{
  const t = triage(
    row({
      match_kind: "affaire_fermee",
      opportunity_stage: "Affaire perdue",
      subject: "Nouveau projet sur ma residence secondaire",
      summary: "Nouveau projet, souhaite un devis",
      signal_type: "positif_bloque",
    }),
  );
  check(
    "7. affaire perdue + nouveau projet annoncé → candidat Morning",
    t.category === "chaud" || t.category === "attente",
    t.category,
  );
}

// 8. Chantier en cours, question de service après-vente.
{
  const t = triage(
    row({
      match_kind: "affaire_hors_pipe",
      opportunity_stage: "Chantier terminé",
      subject: "Probleme electricite travaux passes",
      summary: "Le client signale une malfacon",
      signal_type: "risque",
    }),
  );
  check("8. chantier signé + SAV → hors périmètre", t.category === "hors_perimetre", t.ignoredBecause);
}

// 9. Piste active + demande de rappel.
{
  const t = triage(
    row({
      match_kind: "piste",
      lead_status: "Nouvelle piste",
      subject: "Pouvez-vous me rappeler ?",
      summary: "Le client demande un rappel",
      signal_type: "neutre",
    }),
  );
  check(
    "9. piste active + demande de rappel → Morning",
    t.category === "chaud" || t.category === "attente",
    `${t.category} · ${t.reason}`,
  );
}

// 10. Piste abandonnée, réponse tardive sans nouveau projet.
{
  const t = triage(
    row({
      match_kind: "piste",
      lead_status: "Abandonnée",
      subject: "Re: votre creneau de rappel",
      summary: "Le client repond tardivement",
      signal_type: "positif_bloque",
    }),
  );
  check("10. piste abandonnée + réponse tardive → hors périmètre", t.category === "hors_perimetre", t.ignoredBecause);
}

// 11. Accusé de réception sur une affaire active.
{
  const t = triage(
    row({ match_kind: "affaire_pipe", subject: "Re: devis", summary: "Bien recu", signal_type: "neutre" }),
  );
  check("11. accusé de réception → aucune action", t.category === "ignore", t.ignoredBecause);
  check("11b. le remerciement seul est reconnu", isPureAcknowledgement("Merci", "merci"));
  check("11c. un remerciement suivi d'une question reste une action",
    !isPureAcknowledgement("Merci", "merci, pouvez-vous m'envoyer le devis ?"));
}

// 12. Client actif qui attend vraiment une réponse.
{
  const t = triage(
    row({
      match_kind: "affaire_pipe",
      subject: "Toujours pas de nouvelles",
      summary: "J'attends votre retour depuis une semaine",
      signal_type: "neutre",
    }),
  );
  check("12. client actif qui attend → Client qui attend", t.category === "attente", t.reason);
}

// 13. « Pris en compte » conservé après reclassification.
{
  const target = db
    .prepare("SELECT gmail_message_id id, status, acknowledged_at at FROM morning_event LIMIT 1")
    .get();
  if (!target) {
    check("13. « Pris en compte » conservé", false, "aucune alerte en base");
  } else {
    db.prepare(
      "UPDATE morning_event SET status = 'pris_en_compte', acknowledged_at = ? WHERE gmail_message_id = ?",
    ).run("2026-08-17T10:00:00.000Z", target.id);
    syncMorningEvents();
    const after = db
      .prepare("SELECT status, acknowledged_at at FROM morning_event WHERE gmail_message_id = ?")
      .get(target.id);
    check(
      "13. « Pris en compte » et sa date survivent à la reclassification",
      after.status === "pris_en_compte" && after.at === "2026-08-17T10:00:00.000Z",
      `${after.status} · ${after.at}`,
    );
    db.prepare(
      "UPDATE morning_event SET status = ?, acknowledged_at = ? WHERE gmail_message_id = ?",
    ).run(target.status, target.at, target.id);
  }
}

// 14. Le cas IXINA, sur les données réelles.
{
  const ixina = rows.filter((r) => (r.from_email ?? "").includes("ixina"));
  const inMorning = ixina.filter(retained).length;
  check(
    "14. IXINA identifié par C13 mais exclu du Morning",
    ixina.length > 0 && inMorning === 0,
    `${ixina.length} message(s) IXINA · ${inMorning} dans Morning`,
  );
}

// 15. Le rattachement C13 est intact : le triage ne touche à aucun `match_kind`.
{
  const before = db
    .prepare("SELECT match_kind, COUNT(*) n FROM mail_signal GROUP BY 1 ORDER BY 1")
    .all()
    .map((r) => `${r.match_kind}:${r.n}`)
    .join(",");
  syncMorningEvents();
  const after = db
    .prepare("SELECT match_kind, COUNT(*) n FROM mail_signal GROUP BY 1 ORDER BY 1")
    .all()
    .map((r) => `${r.match_kind}:${r.n}`)
    .join(",");
  check("15. rattachement C13 inchangé par le triage", before === after, after);
}

// 16. Une exclusion structurelle ne peut pas être écrasée par la tonalité.
{
  const strong = triage(
    row({
      match_kind: "affaire_fermee",
      opportunity_stage: "Fin du projet",
      subject: "Bon pour accord, je signe aujourd'hui",
      summary: "Le client valide et souhaite signer immediatement",
      signal_type: "signature",
    }),
  );
  check(
    "16. le classifieur ne peut pas écraser une exclusion structurelle",
    strong.category === "hors_perimetre",
    strong.ignoredBecause,
  );
}

// 17. Un interlocuteur non qualifié ne devient jamais « client chaud ».
{
  const t = evaluateEligibility(
    { fromEmail: "inconnu@societe-x.fr", subject: "Nous souhaitons avancer", summary: "" },
    { matchKind: "inconnu", direction: "entrant" },
    INTERNAL_DOMAIN,
  );
  const cat = triage(
    row({ from_email: "inconnu@societe-x.fr", subject: "Nous souhaitons avancer", signal_type: "positif_bloque" }),
  ).category;
  check(
    "17. interlocuteur incertain plafonné à « client qui attend »",
    t.verdict === "incertain" && cat !== "chaud",
    `${t.verdict} → ${cat}`,
  );
}

// ── ÉTAT FINAL ──────────────────────────────────────────────────────────────
const { events } = loadMorningEvents();
const pipe = events.filter((e) => e.matchKind === "affaire_pipe");
console.log("\n──── MORNING APRÈS TRIAGE ────\n");
console.log(`  actions                  : ${events.length}`);
console.log(`  clients chauds           : ${events.filter((e) => e.category === "chaud").length}`);
console.log(`  clients qui attendent    : ${events.filter((e) => e.category === "attente").length}`);
console.log(`  affaires du pipe         : ${pipe.length}`);
console.log(
  `  GMV pipe couvert         : ${Math.round(pipe.reduce((t, e) => t + (e.gmv ?? 0), 0) / 1000)} k€`,
);
console.log(`  avec commercial connu    : ${events.filter((e) => e.salesperson).length}`);

console.log(
  failures === 0
    ? `\n  ${total} contrôles au vert.\n`
    : `\n  ${failures} contrôle(s) en échec sur ${total}.\n`,
);
process.exit(failures === 0 ? 0 : 1);

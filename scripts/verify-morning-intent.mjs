/**
 * Contrôles de l'étage d'intention Morning (C15 §16, §23).
 *
 *   npm run morning:intent-verify
 *
 * Vérifie que les demandes commerciales formulées platement remontent, que les
 * accusés de réception ne remontent pas, et surtout que la barrière structurelle
 * de C14 n'a pas été affaiblie : un fournisseur pressé ou un chantier signé
 * doivent rester exclus même si leur message contient une demande explicite.
 *
 * Les cas frontières sont fabriqués — « Devis bien reçu merci » face à « Pouvez-
 * vous envoyer le devis ? » ne se trouvent pas forcément dans la boîte du jour.
 * Les quatre faux négatifs connus sont eux vérifiés sur les données réelles.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { triage, loadMorningEvents, syncMorningEvents } = await import(lib("morning-events"));
const { detectIntent } = await import(lib("morning-intent"));

const db = getDb();
let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const row = (over) => ({
  direction: "entrant",
  subject: "",
  summary: "",
  blocker: null,
  signal_type: "neutre",
  from_email: "client@gmail.com",
  match_kind: "affaire_pipe",
  opportunity_stage: null,
  lead_status: null,
  ...over,
});
const kept = (t) => t.category === "chaud" || t.category === "attente";

console.log("\n════ INTENTIONS MORNING ════\n");
console.log("──── CAS FRONTIÈRES ────\n");

// 1 / 2. Demande de devis contre accusé de réception.
{
  const a = triage(row({ subject: "Devis", summary: "Pouvez-vous m'envoyer le devis ?" }));
  const b = triage(row({ subject: "Re: devis", summary: "Votre devis a bien ete recu, merci" }));
  check("1. « Pouvez-vous envoyer le devis ? » → action", kept(a), `${a.category} · ${a.reason}`);
  check("2. « Devis bien reçu, merci » → pas d'action", !kept(b), b.ignoredBecause ?? b.category);
}

// 3 / 4. Planning demandé contre planning transmis.
{
  const a = triage(
    row({ subject: "Planning", summary: "Pouvez-vous me donner un planning previsionnel ?" }),
  );
  const b = triage(row({ subject: "Planning", summary: "Planning transmis, merci" }));
  check("3. « Pouvez-vous me donner un planning ? » → action", kept(a), `${a.category} · ${a.reason}`);
  check("4. « Planning transmis, merci » → pas d'action", !kept(b), b.ignoredBecause ?? b.category);
}

// 5 / 6. Question directe contre simple remerciement.
{
  const a = triage(row({ subject: "Visite", summary: "Quand pouvons-nous prevoir la visite ?" }));
  const b = triage(row({ subject: "Re: devis", summary: "Merci beaucoup, tres bonne journee" }));
  check("5. question directe d'un client actif → action", kept(a), `${a.category} · ${a.reason}`);
  check("6. simple remerciement → pas d'action", !kept(b), b.ignoredBecause ?? b.category);
}

// 7. Demande de modification du devis.
{
  const t = triage(row({ subject: "Devis", summary: "Pouvez-vous modifier le devis ligne 3 ?" }));
  check("7. demande de modification du devis → action", kept(t), `${t.category} · ${t.reason}`);
}

// 8 / 9 / 10. La barrière C14 tient, malgré une demande explicite.
{
  const fournisseur = triage(
    row({
      from_email: "mgouron@ixina.com",
      match_kind: "affaire_hors_pipe",
      opportunity_stage: "Chantier en cours",
      subject: "URGENT",
      summary: "Pouvez-vous valider le devis avant vendredi ?",
      signal_type: "signature",
    }),
  );
  check("8. fournisseur + demande urgente → toujours exclu", !kept(fournisseur), fournisseur.ignoredBecause);

  const chantier = triage(
    row({
      match_kind: "affaire_hors_pipe",
      opportunity_stage: "Chantier en cours",
      subject: "Planning",
      summary: "Pouvez-vous me donner le planning des travaux ?",
    }),
  );
  check("9. chantier signé + planning → toujours exclu", !kept(chantier), chantier.ignoredBecause);

  const saas = triage(
    row({
      from_email: "juliette.girard@buildpokeslide.com",
      match_kind: "inconnu",
      subject: "Powerpoint",
      summary: "Pouvez-vous me dire qui gere vos outils ?",
    }),
  );
  check("10. prospection SaaS avec question → toujours exclue", !kept(saas), saas.ignoredBecause);
}

// --- Le détecteur lui-même, sur les pièges de structure.
console.log("\n──── STRUCTURE DE LA DEMANDE ────\n");
{
  const cases = [
    ["Pouvez-vous m'envoyer le devis ?", "action_required"],
    ["Votre devis a bien ete recu, merci", "acknowledgement_only"],
    ["Client recoit le devis, demande du temps pour l'examiner", "neutral"],
    ["Demande de planning previsionnel pour optimiser les livraisons", "action_required"],
    ["Client demande une estimation pour les travaux envisages", "action_required"],
    ["Merci beaucoup, tres bonne journee", "neutral"],
    ["Nous souhaitons avancer sur le projet", "wants_to_advance"],
    ["Je vous relance, toujours pas de nouvelles", "waiting_for_rm"],
    ["Bon pour accord, envoyez le lien de signature", "decisive_signal"],
  ];
  for (const [text, expected] of cases) {
    const r = detectIntent({ subject: "", summary: text, onActiveDeal: true });
    check(
      `« ${text.slice(0, 46)}${text.length > 46 ? "…" : ""} » → ${expected}`,
      r.intent === expected,
      `${r.intent} · ${r.evidence}`,
    );
  }
}

// --- Les faux négatifs connus, sur les données réelles.
console.log("\n──── FAUX NÉGATIFS CONNUS ────\n");
const { events } = loadMorningEvents();
const find = (needle) => events.find((e) => String(e.fromEmail).includes(needle));
for (const [needle, label] of [
  ["younnes.hamidine", "younnes.hamidine"],
  ["alexandre.philippot", "alexandre.philippot"],
  ["doutrelonben", "doutrelonben (découvert en C15)"],
  ["dperugia", "raphael.dperugia (découvert en C15)"],
]) {
  const e = find(needle);
  check(`${label} récupéré`, e != null, e ? `${e.category} · ${e.reason}` : "absent du Morning");
}
{
  // Sophie MARIA : NON récupérée, et c'est la bonne réponse. Sa demande de
  // planning porte sur les LIVRAISONS d'un dossier déjà signé — un suivi
  // d'exécution, pas une action commerciale. Elle figurait à tort parmi les
  // « faux négatifs connus » : elle était écartée pour une mauvaise raison
  // (aucune intention identifiée), elle l'est désormais pour la bonne.
  const e = find("maria-sophie");
  check(
    "maria-sophie écartée : planning de livraison sur affaire signée",
    e == null,
    e ? `présente : ${e.category}` : "suivi d'exécution après signature",
  );
}
{
  // Cyrill Lagel : volontairement NON récupéré. Le client demande du temps pour
  // examiner le devis — il n'attend rien de nous, et le ranger dans « Clients qui
  // attendent une réponse » serait faux à l'écran.
  const e = find("cyrillagel");
  check(
    "contact@cyrillagel.com volontairement non récupéré",
    e == null,
    e ? `présent : ${e.category}` : "demande du temps, n'attend pas de réponse de notre part",
  );
}

// --- Non-régressions structurelles.
console.log("\n──── NON-RÉGRESSIONS ────\n");
{
  const ixina = events.filter((e) => String(e.fromEmail).includes("ixina"));
  check("IXINA toujours absent du Morning", ixina.length === 0, `${ixina.length} message(s)`);
}
{
  const bad = events.filter((e) =>
    ["affaire_fermee", "affaire_hors_pipe"].includes(e.matchKind),
  );
  check(
    "aucune affaire close ni chantier signé réintroduit",
    bad.length === 0,
    `${bad.length} message(s)`,
  );
  // Une affaire du pipe dont l'étape est « Signé » n'est plus du pipe : le
  // rattachement la nomme encore ainsi, l'éligibilité doit la refuser.
  const signed = db
    .prepare(
      `SELECT COUNT(*) n FROM morning_event e
         JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
         JOIN opportunity o ON o.opportunity_id = m.opportunity_id
        WHERE e.category IN ('chaud','attente') AND o.is_terminal = 1`,
    )
    .get().n;
  check("aucune affaire déjà signée dans le Morning actif", signed === 0, `${signed} message(s)`);
}
{
  // Une première passe aligne l'état stocké sur le code courant : sans elle, le
  // contrôle mesurerait l'écart laissé par la version précédente, pas
  // l'idempotence du recalcul.
  syncMorningEvents();
  const counts = db
    .prepare("SELECT category, COUNT(*) n FROM morning_event GROUP BY 1")
    .all()
    .map((r) => `${r.category}:${r.n}`)
    .join(" ");
  const before = db.prepare("SELECT COUNT(*) n FROM morning_event").get().n;
  syncMorningEvents();
  syncMorningEvents();
  const after = db.prepare("SELECT COUNT(*) n FROM morning_event").get().n;
  const counts2 = db
    .prepare("SELECT category, COUNT(*) n FROM morning_event GROUP BY 1")
    .all()
    .map((r) => `${r.category}:${r.n}`)
    .join(" ");
  check("recalcul idempotent, aucune duplication", before === after && counts === counts2, counts2);
}
{
  const target = db.prepare("SELECT gmail_message_id id, status, acknowledged_at at FROM morning_event LIMIT 1").get();
  db.prepare(
    "UPDATE morning_event SET status = 'pris_en_compte', acknowledged_at = ? WHERE gmail_message_id = ?",
  ).run("2026-08-17T09:30:00.000Z", target.id);
  syncMorningEvents();
  const after = db
    .prepare("SELECT status, acknowledged_at at FROM morning_event WHERE gmail_message_id = ?")
    .get(target.id);
  check(
    "« Pris en compte » et sa date conservés",
    after.status === "pris_en_compte" && after.at === "2026-08-17T09:30:00.000Z",
    `${after.status} · ${after.at}`,
  );
  db.prepare("UPDATE morning_event SET status = ?, acknowledged_at = ? WHERE gmail_message_id = ?").run(
    target.status,
    target.at,
    target.id,
  );
}

// --- État final.
const pipe = events.filter((e) => e.matchKind === "affaire_pipe");
console.log("\n──── MORNING APRÈS CALIBRATION ────\n");
console.log(`  actions                : ${events.length}`);
console.log(`  clients chauds         : ${events.filter((e) => e.category === "chaud").length}`);
console.log(`  clients qui attendent  : ${events.filter((e) => e.category === "attente").length}`);
console.log(`  affaires du pipe       : ${pipe.length}`);
console.log(
  `  GMV pipe couvert       : ${Math.round(pipe.reduce((t, e) => t + (e.gmv ?? 0), 0) / 1000)} k€`,
);

console.log(
  failures === 0
    ? `\n  ${total} contrôles au vert.\n`
    : `\n  ${failures} contrôle(s) en échec sur ${total}.\n`,
);
process.exit(failures === 0 ? 0 : 1);

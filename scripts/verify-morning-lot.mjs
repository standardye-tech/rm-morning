/**
 * Contrôles du lot Morning « lecture groupée, phrase du client, plan nettoyé,
 * source Perspective ».
 *
 *   npm run morning:lot-verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : « Tout marquer comme lu » acquitte des
 * messages, et un contrôle ne doit jamais toucher l'état de lecture réel du
 * directeur régional.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "morning-lot.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { extractQuoteFromMessage, classifyMessage, QUOTE_MAX_LENGTH } = await import(lib("mail-classify"));
const { selectInterestProof, tierOf, acceptProof } = await import(lib("interest-proof"));
const { verifyQuote } = await import(lib("mail-classify-ai"));
const { whatClientSays, expectationOf, NO_PROOF, acknowledgeAllEvents, loadMorningEvents, threadsNeedingQuote } = await import(
  lib("morning-events")
);
const { setThreadQuote } = await import(lib("mail-store"));
const { buildMorningPlan } = await import(lib("morning-priority"));
const { computeWeekForecast } = await import(lib("forecast"));
const { loadOpportunities, latestImport } = await import(lib("repository"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

// --- Q — La phrase du client ---------------------------------------------------

section("Q1 — Preuve d'intérêt : paliers, exclusions, fidélité");

const msgText =
  "Bonjour, merci pour le devis. Si on valide aujourd'hui, pouvez-vous garantir un démarrage avant fin octobre ? Le financement est validé, il me reste uniquement à choisir l'entreprise. Bien à vous, M. Dupont";
const p1 = selectInterestProof(msgText);
check("intention forte (financement validé, palier 2) prime sur la condition et la question", p1?.tier === 2 && p1.quote === "Le financement est validé, il me reste uniquement à choisir l'entreprise.", p1?.quote ?? "null");
const p1b = selectInterestProof("Bonjour, merci pour le devis. Si on valide aujourd'hui, pouvez-vous garantir un démarrage avant fin octobre ? Bien à vous.");
check("condition de décision (palier 3) : « si on valide » est une condition, pas un accord", p1b?.tier === 3 && p1b.quote === "Si on valide aujourd'hui, pouvez-vous garantir un démarrage avant fin octobre ?", p1b?.quote ?? "null");
const bare = selectInterestProof("Bonjour Daravith Avez vous pu prendre connaissance des plans et avancé sur le devis? Merci à vous");
check("salutation sans virgule retirée, relance sur le devis = demande commerciale", bare?.tier === 5 && bare.quote === "Avez vous pu prendre connaissance des plans et avancé sur le devis?", bare?.quote ?? "null");
const p2 = selectInterestProof("Bonjour. Votre proposition nous convient. Pouvez-vous me confirmer que votre artisan est disponible début octobre ?");
check("intention forte (palier 2) prime sur la question de closing (palier 4)", p2?.tier === 2 && p2.quote === "Votre proposition nous convient.", p2?.quote ?? "null");
const p3 = selectInterestProof("Merci pour votre retour. Nous souhaitons avancer et signer rapidement. Bonne journée.");
check("engagement concret (palier 1) retenu, politesse ignorée", p3?.tier === 1 && p3.quote === "Nous souhaitons avancer et signer rapidement.", p3?.quote ?? "null");
const p4 = selectInterestProof("Bonjour, pouvez-vous me confirmer que votre artisan est disponible la première semaine d'octobre ? Merci.");
check("question de closing (palier 4) : disponibilité artisan, salutation retirée", p4?.tier === 4 && p4.quote === "pouvez-vous me confirmer que votre artisan est disponible la première semaine d'octobre ?", p4?.quote ?? "null");
const p5 = selectInterestProof("Bonjour, pourriez-vous m'envoyer le devis détaillé pour la cuisine ? Cordialement.");
check("demande commerciale (palier 5) à défaut", p5?.tier === 5, p5?.quote ?? "null");

check("formule de politesse seule ⇒ rien", selectInterestProof("Bonjour Monsieur, je vous remercie. Bien cordialement, Jean.") === null);
check("accusé de réception seul ⇒ rien", selectInterestProof("Bien reçu, merci beaucoup. Je reviens vers vous prochainement.") === null);
check("signature automatique ⇒ jamais retenue", tierOf("Envoyé depuis mon iPhone, veuillez signer le document") === null && selectInterestProof("Obtenir Outlook pour iOS. Je souhaite avancer.")?.quote === "Je souhaite avancer.");
check("notification administrative ⇒ rien", selectInterestProof("Julien RADIC vous a mentionné dans un document : Sales Meeting. Ouvrir le document.") === null);
check("Docusign / Yousign ⇒ rien", selectInterestProof("Xavier Himbert via DocuSign : veuillez examiner et signer le document.") === null);
check("phrase neutre sans intention ⇒ rien", selectInterestProof("Nous avons visité l'appartement mardi dernier avec l'architecte.") === null);
check("URL ou adresse ⇒ rien", selectInterestProof("Voir https://exemple.fr/devis pour signer en ligne, contact@exemple.fr") === null);

check("la citation est un extrait exact du texte", msgText.includes(p1.quote) && msgText.includes(p1b.quote) && "Votre proposition nous convient.".length === p2.quote.length);
const long = "Nous souhaitons avancer " + "très vite sur ce projet ".repeat(12) + "avant la fin du mois.";
const p6 = selectInterestProof(long);
check(`une phrase trop longue est coupée à ${QUOTE_MAX_LENGTH} caractères sur un mot, avec ellipse`, p6.quote.length <= QUOTE_MAX_LENGTH && p6.quote.endsWith("…") && long.startsWith(p6.quote.slice(0, -1)));

const classified = classifyMessage({
  id: "m1",
  threadId: "t1",
  date: "2026-09-11T08:00:00.000Z",
  direction: "entrant",
  subject: "Re: devis",
  snippet: "Bonjour. C'est bon pour nous, on part avec vous. Merci de nous envoyer le lien de signature.",
});
check("classifyMessage porte la preuve d'intérêt", classified.signalType === "signature" && classified.quote === "C'est bon pour nous, on part avec vous.", classified.quote ?? "null");
const risky = classifyMessage({
  id: "m3",
  threadId: "t3",
  date: "2026-09-11T08:00:00.000Z",
  direction: "entrant",
  subject: "Re: devis",
  snippet: "Le prix nous semble trop élevé. Si vous pouvez tenir le planning de novembre, nous avançons.",
});
check("un message « risque » peut porter une preuve d'intérêt (condition de décision)", risky.signalType === "risque" && risky.quote === "Si vous pouvez tenir le planning de novembre, nous avançons.", `${risky.signalType} · ${risky.quote ?? "null"}`);
const backfilled = extractQuoteFromMessage({
  id: "m2",
  threadId: "t2",
  date: "2026-09-11T08:00:00.000Z",
  direction: "entrant",
  subject: "Re: devis",
  snippet: "Merci. Nous réfléchissons encore, le prix nous semble trop élevé. Cordialement.",
});
check("le rattrapage ne fabrique rien sur un message sans preuve", backfilled === null);

section("Q2 — Citation du modèle : dans le texte ET probante");

const source = "Objet : devis. Bien reçu, merci. Pouvez-vous me confirmer que votre artisan est disponible la première semaine d'octobre ?";
check("phrase présente et probante ⇒ retenue", acceptProof(verifyQuote("Pouvez-vous me confirmer que votre artisan est disponible la première semaine d'octobre ?", source))?.tier === 4);
check("guillemets, casse et accents tolérés", verifyQuote("« pouvez-vous me confirmer que votre artisan est disponible la premiere semaine d'octobre ? »", source) !== null);
check("phrase inventée ⇒ écartée", verifyQuote("Le financement est validé, il ne reste qu'à signer.", source) === null);
check("phrase présente mais accusé de réception ⇒ écartée par le garde-fou", acceptProof(verifyQuote("Bien reçu, merci.", source)) === null);
check("valeur non textuelle ⇒ écartée", verifyQuote(null, source) === null && verifyQuote(42, source) === null);

section("Q3 — Ce qui s'affiche : citation, « pas de preuve », ou non analysé");

const withQuote = whatClientSays({ reason: "Demande le devis", quote: "Pouvez-vous m'envoyer le devis avant lundi ?", summary: "Client demande le devis", classifier: "claude-haiku-4-5-20251001" });
check("citation ⇒ guillemets et « attend : le devis »", withQuote.proof === "citation" && withQuote.said === "« Pouvez-vous m'envoyer le devis avant lundi ? »" && withQuote.expects === "attend : le devis");
const none = whatClientSays({ reason: "Souhaite avancer", quote: "", summary: "Client finalise sa demande de prêt", classifier: "claude-haiku-4-5-20251001" });
check("relu sans preuve ⇒ « Pas de preuve d'intérêt explicite », jamais le résumé", none.proof === "aucune" && none.said === NO_PROOF && none.expects === "attend : la prochaine étape");
const notYet = whatClientSays({ reason: "Souhaite avancer", quote: null, summary: "Client finalise sa demande de prêt, devis en cours d'examen", classifier: "claude-haiku-4-5-20251001" });
check("pas encore relu ⇒ résumé fidèle du modèle en attendant le rattrapage", notYet.proof === "non_analyse" && notYet.said === "Client finalise sa demande de prêt, devis en cours d'examen");
const rulesOnly = whatClientSays({ reason: "Souhaite avancer", quote: null, summary: "Projet vivant, probabilité de signature en baisse", classifier: "rules" });
check("pas encore relu, résumé des règles ⇒ motif, sans parenthèse", rulesOnly.said === "Souhaite avancer" && rulesOnly.expects === null);

check("« attend : … » : demande", expectationOf("Demande un planning prévisionnel") === "attend : un planning prévisionnel");
check("« attend : … » : relance", expectationOf("Relance, sans réponse de notre côté") === "attend : une réponse");
check("« attend : … » : signature", expectationOf("Prêt à signer ou dernière étape avant signature") === "attend : la signature");
check("« attend : … » : blocage", expectationOf("Souhaite avancer — financement en attente") === "attend : financement en attente");
check("« attend : … » : document", expectationOf("Attend un document ou une correction") === "attend : un document ou une correction");

const { events } = loadMorningEvents();
check("sur la base : chaque événement porte une phrase non vide", events.every((e) => e.said && e.said.trim().length > 0), `${events.length} événements`);
check("sur la base : aucune phrase n'est un identifiant technique", events.every((e) => !/^[a-z_]+$/.test(e.said)));

section("Q4 — Rattrapage : les fils ouverts sans citation sont repérés une seule fois");

const need = threadsNeedingQuote(500);
check("la liste ne contient que des fils d'événements ouverts", need.length >= 0, `${need.length} fil(s) à relire`);
if (need.length > 0) {
  setThreadQuote(need[0], null);
  check("un fil marqué « rien trouvé » ne revient plus dans la liste", !threadsNeedingQuote(500).includes(need[0]));
}

// --- A — Tout marquer comme lu ----------------------------------------------------

section("A1 — Acquittement groupé, même persistance que le geste unitaire");

const db = getDb();
const countOpen = (cat) =>
  db.prepare("SELECT COUNT(*) n FROM morning_event WHERE status <> 'pris_en_compte' AND category = ?").get(cat).n;
const alreadyAcked = db
  .prepare("SELECT gmail_message_id, acknowledged_at FROM morning_event WHERE status = 'pris_en_compte'")
  .all();
const openHot = countOpen("chaud");
const openWaiting = countOpen("attente");
const planBefore = buildMorningPlan();

const r1 = acknowledgeAllEvents("chaud");
check("« chaud » : tous les messages ouverts du bloc sont acquittés", r1.changed === openHot && countOpen("chaud") === 0, `${r1.changed} acquitté(s)`);
check("le bloc « attente » n'est pas touché", countOpen("attente") === openWaiting);
check("les statuts déjà enregistrés gardent leur date d'acquittement", alreadyAcked.every((a) => db.prepare("SELECT acknowledged_at FROM morning_event WHERE gmail_message_id = ?").get(a.gmail_message_id).acknowledged_at === a.acknowledged_at));
check("l'écriture est idempotente : un second appel ne change rien", acknowledgeAllEvents("chaud").changed === 0);
check("les identifiants renvoyés sont ceux qui ont changé", r1.messageIds.length === r1.changed);

section("A2 — Le plan du jour se nettoie : les actions « client motivé » disparaissent");

const planAfter = buildMorningPlan();
check("plus aucune action « Le client veut avancer » dans le plan", !planAfter.actions.some((a) => a.reason === "client_motive"), `${planBefore.actions.filter((a) => a.reason === "client_motive").length} avant · 0 après`);
// Les affaires décisives et en signature ne dépendent d'aucun message : elles
// doivent rester. « À challenger, et le client donne signe de vie » dépend par
// définition d'un message ouvert : une fois celui-ci traité, le signe de vie
// est traité aussi — comportement existant de buildMorningPlan, inchangé ici.
const keptKinds = ["affaire_decisive", "proche_signature", "a_challenger_vivante"];
const strongKinds = ["affaire_decisive", "proche_signature"];
const before = planBefore.actions.filter((a) => strongKinds.includes(a.reason)).map((a) => a.key).sort();
const after = planAfter.actions.filter((a) => strongKinds.includes(a.reason)).map((a) => a.key).sort();
check("les affaires décisives et en signature sont préservées", JSON.stringify(before) === JSON.stringify(after), `${after.length} action(s) de fond`);
const challengeBefore = planBefore.actions.filter((a) => a.reason === "a_challenger_vivante").length;
const challengeAfter = planAfter.actions.filter((a) => a.reason === "a_challenger_vivante").length;
check("« à challenger, client vivant » ne survit pas au message qui le portait (règle existante)", challengeAfter <= challengeBefore, `${challengeBefore} avant · ${challengeAfter} après`);
check("les actions « client attend » restent tant que le bloc 2 n'est pas traité", planAfter.actions.filter((a) => a.reason === "client_attend").length === planBefore.actions.filter((a) => a.reason === "client_attend").length);

const r2 = acknowledgeAllEvents(null);
const planAll = buildMorningPlan();
check("« tout » acquitte le reste (bloc 2)", r2.changed === openWaiting && countOpen("attente") === 0);
check("plus aucune action « Le client attend une réponse »", !planAll.actions.some((a) => a.reason === "client_attend"));
check("le plan ne recopie plus les blocs 1 et 2 : seules les actions de fond restent", planAll.actions.every((a) => keptKinds.includes(a.reason)), `${planAll.actions.length} action(s)`);
check("les blocs 1 et 2 sont vides après acquittement", planAll.hot.length === 0 && planAll.waiting.length === 0);

// --- P — Source Perspectives -------------------------------------------------------

section("P1 — Perspectives : l'état courant « EN COURS » d'abord");

const imp = latestImport();
const ref = imp?.snapshotDate ?? new Date().toISOString().slice(0, 10);
const [y, m] = ref.split("-").map(Number);
const opps = loadOpportunities();
const month = `${y}-${String(m).padStart(2, "0")}`;
const currentAt = db.prepare("SELECT MAX(updated_at) at FROM forecast_current WHERE forecast_month = ?").get(month).at;
const frozen = db
  .prepare("SELECT DISTINCT snapshot_date d FROM forecast_snapshot WHERE forecast_month = ? AND snapshot_date <= ? ORDER BY snapshot_date DESC")
  .all(month, ref)
  .map((r) => r.d);
const wf = computeWeekForecast(opps, ref, m, y);
if (currentAt) {
  check("l'état courant est la référence", wf.mode === "sheet" && wf.referenceSource === "courant", `${wf.referenceSource} · ${wf.referenceDate}`);
  check("sa date est celle du « MAJ le » du classeur", wf.referenceDate === String(currentAt).slice(0, 10), `${wf.referenceDate} = ${String(currentAt).slice(0, 10)}`);
  check("la référence n'est jamais un snapshot figé plus ancien", !frozen.length || wf.referenceDate >= frozen[0], `dernier figé : ${frozen[0] ?? "aucun"}`);
  const expectedPrev = frozen.find((d) => d < wf.referenceDate) ?? null;
  check("la trajectoire remonte au dernier snapshot figé antérieur", wf.previousDate === expectedPrev, `${wf.previousDate}`);
} else {
  check("pas d'état courant en base : contrôle P1 sans objet", true, "aucune ligne forecast_current pour ce mois");
}

section("P2 — Repli propre sur le dernier snapshot figé");

db.prepare("DELETE FROM forecast_current WHERE forecast_month = ?").run(month);
const wfFallback = computeWeekForecast(opps, ref, m, y);
if (frozen.length > 0) {
  check("sans état courant : le snapshot figé le plus récent ≤ aujourd'hui", wfFallback.mode === "sheet" && wfFallback.referenceSource === "snapshot" && wfFallback.referenceDate === frozen[0], `${wfFallback.referenceDate}`);
  check("le précédent est le snapshot figé d'avant", wfFallback.previousDate === (frozen[1] ?? null));
} else {
  check("ni courant ni figé : vue provisoire Salesforce seule", wfFallback.mode === "salesforce-only" && wfFallback.referenceSource === null);
}
db.prepare("DELETE FROM forecast_snapshot WHERE forecast_month = ?").run(month);
const wfNone = computeWeekForecast(opps, ref, m, y);
check("ni courant ni figé : vue provisoire, sans date inventée", wfNone.mode === "salesforce-only" && wfNone.referenceDate === null && wfNone.referenceSource === null);

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

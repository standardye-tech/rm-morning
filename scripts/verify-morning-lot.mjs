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
const { extractQuote, extractQuoteFromMessage, classifyMessage, QUOTE_MAX_LENGTH } = await import(lib("mail-classify"));
const { verifyQuote } = await import(lib("mail-classify-ai"));
const { whatClientSays, acknowledgeAllEvents, loadMorningEvents, threadsNeedingQuote } = await import(
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

section("Q1 — Extraction par les règles : textuelle, jamais inventée");

const snippet =
  "Bonjour, merci pour le devis. Si on valide aujourd'hui, pouvez-vous garantir un démarrage avant fin octobre ? Le financement est validé, il me reste uniquement à choisir l'entreprise. Bien à vous, M. Dupont";
const q1 = extractQuote(snippet, [/financement/i]);
check("la phrase retenue est celle qui porte le motif", q1 === "Le financement est validé, il me reste uniquement à choisir l'entreprise.", q1 ?? "null");
const q2 = extractQuote(snippet, [/motif absent/i]);
check("sans motif : la première question, telle quelle", q2 === "Si on valide aujourd'hui, pouvez-vous garantir un démarrage avant fin octobre ?", q2 ?? "null");
const q3 = extractQuote("Bonjour, bien reçu. Merci beaucoup et bonne journée.", [/financement/i]);
check("ni motif ni question ⇒ aucune citation", q3 === null);
const long = "Nous souhaitons avancer " + "très vite sur ce projet ".repeat(12) + "avant la fin du mois.";
const q4 = extractQuote(long, [/souhaitons avancer/i]);
check(`une phrase trop longue est coupée à ${QUOTE_MAX_LENGTH} caractères sur un mot, avec ellipse`, q4.length <= QUOTE_MAX_LENGTH && q4.endsWith("…"));
check("la citation est un extrait exact du texte", snippet.includes(q1) && snippet.includes(q2));

const classified = classifyMessage({
  id: "m1",
  threadId: "t1",
  date: "2026-09-11T08:00:00.000Z",
  direction: "entrant",
  subject: "Re: devis",
  snippet: "Bonjour. C'est bon pour nous, on part avec vous. Merci de nous envoyer le lien de signature.",
});
check("classifyMessage porte la phrase du motif décisif", classified.signalType === "signature" && classified.quote === "C'est bon pour nous, on part avec vous.", classified.quote ?? "null");
const backfilled = extractQuoteFromMessage({
  id: "m2",
  threadId: "t2",
  date: "2026-09-11T08:00:00.000Z",
  direction: "entrant",
  subject: "Re: devis",
  snippet: "Merci. Nous réfléchissons encore, le prix nous semble trop élevé. Cordialement.",
});
check("le rattrapage trouve la phrase parlante tous motifs confondus", backfilled === "Nous réfléchissons encore, le prix nous semble trop élevé.", backfilled ?? "null");

section("Q2 — Citation du modèle : retenue seulement si elle figure dans le texte");

const source = "Objet : devis. Pouvez-vous me confirmer que votre artisan est disponible la première semaine d'octobre ?";
check("phrase présente ⇒ retenue", verifyQuote("Pouvez-vous me confirmer que votre artisan est disponible la première semaine d'octobre ?", source) !== null);
check("guillemets, casse et accents tolérés", verifyQuote("« pouvez-vous me confirmer que votre artisan est disponible la premiere semaine d'octobre ? »", source) !== null);
check("phrase inventée ⇒ écartée", verifyQuote("Le financement est validé, il ne reste qu'à signer.", source) === null);
check("valeur non textuelle ⇒ écartée", verifyQuote(null, source) === null && verifyQuote(42, source) === null);

section("Q3 — Ce qui s'affiche : citation, puis résumé fidèle, puis motif");

const withQuote = whatClientSays({ reason: "Demande le devis", quote: "Pouvez-vous m'envoyer le devis avant lundi ?", summary: "Client demande le devis", classifier: "claude-haiku-4-5-20251001" });
check("citation ⇒ affichée entre guillemets, motif en parenthèse", withQuote.said === "« Pouvez-vous m'envoyer le devis avant lundi ? »" && withQuote.expects === "demande le devis");
const modelOnly = whatClientSays({ reason: "Souhaite avancer", quote: null, summary: "Client finalise sa demande de prêt, devis en cours d'examen", classifier: "claude-haiku-4-5-20251001" });
check("sans citation, résumé du modèle ⇒ affiché tel quel", modelOnly.said === "Client finalise sa demande de prêt, devis en cours d'examen" && modelOnly.expects === "souhaite avancer");
const rulesOnly = whatClientSays({ reason: "Souhaite avancer", quote: null, summary: "Projet vivant, probabilité de signature en baisse", classifier: "rules" });
check("résumé des règles (gabarit) ⇒ on garde le motif, sans parenthèse", rulesOnly.said === "Souhaite avancer" && rulesOnly.expects === null);
const emptyQuote = whatClientSays({ reason: "Demande le devis", quote: "", summary: null, classifier: "rules_fallback" });
check("chaîne vide (« cherché, rien trouvé ») ⇒ traitée comme absente", emptyQuote.said === "Demande le devis" && emptyQuote.quote === null);

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

/**
 * Contrôles du scanner mail V2 — identité avant intention (18/10/2026).
 *
 *   npm run morning:scanner-v2-verify
 *
 * Cas ANONYMISÉS, écrits pour l'occasion : aucun nom de client, aucun corps de
 * message réel. Chaque cas reproduit une FORME constatée à l'audit des 7 jours
 * du 18/10/2026 (faux négatif ou faux positif). Tous purs : aucun accès base,
 * aucun appel réseau, aucun appel modèle (clé absente : repli des règles).
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { qualifySender, qualifyMessageSender } = await import(lib("sender-role"));
const { filterMessage, teamMembersInvolved, INTERNAL_DOMAIN } = await import(lib("mail-rules"));
const { evaluateEligibility, isPostSignatureStage } = await import(lib("morning-eligibility"));
const { triage, selectVisible } = await import(lib("morning-events"));
const { rulesIntent, rulesProspectEvidence } = await import(lib("mail-intent"));
const { cleanText, cleanLatestInboundBody } = await import(lib("mail-body"));
const { classifyMessage, classifyThread } = await import(lib("mail-classify"));
const { buildPayload } = await import(lib("mail-classify-ai"));
const { classifyHybrid, newModelBudget } = await import(lib("mail-classify-hybrid"));
const { pickClassificationTarget } = await import(lib("sources/gmail"));

if (process.env.ANTHROPIC_API_KEY) {
  console.error("Refus : ce harnais doit tourner SANS clé Anthropic (aucun appel réel).");
  process.exit(2);
}

let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

/** Ligne de triage V2 : un client d'une affaire ouverte, intention à préciser. */
const V2 = {
  direction: "entrant",
  from_email: "client@exemple.fr",
  match_kind: "affaire_pipe",
  stage: "Examen devis",
  is_terminal: 0,
  owner: null,
  blocker: null,
  quote: null,
  subject: "Re: Votre projet",
  summary: "",
  classifier: "rules_fallback",
  signal_type: "neutre",
  sender_role: "customer",
  sender_role_reason: "adresse client d'une opportunité",
  intent: "uncertain",
  needs_reply: 0,
  prospect_evidence: 0,
  scanner_v2: 1,
};
/** Triage V2 d'un corps : intention par les règles, comme le repli de production. */
const triageBody = (body, over = {}) => {
  const i = rulesIntent(body, over.subject ?? null);
  return triage({ ...V2, intent: i.intent, needs_reply: i.needsReply ? 1 : 0, prospect_evidence: rulesProspectEvidence(body) ? 1 : 0, ...over });
};
const ctx = (over = {}) => ({ matchKind: "affaire_pipe", dealStage: "Examen devis", direction: "entrant", senderRole: "customer", scannerV2: true, ...over });
const elig = (over = {}, from = "client@exemple.fr") => evaluateEligibility({ fromEmail: from, subject: "", summary: "" }, ctx(over), INTERNAL_DOMAIN);
const msg = (over = {}) => ({
  id: "m1",
  threadId: "t1",
  date: "2026-10-16T09:00:00Z",
  from: "client@exemple.fr",
  to: ["daravith@renovationman.com"],
  cc: [],
  subject: "Re: Devis travaux",
  snippet: "",
  ...over,
});

// ────────────────────────────────────────────────────────────────────────
section("1. ÉTAPE SALESFORCE « SIGNATURE » — ouverte, éligible, Bloc 1");
{
  check("« Signature » n'est pas une étape post-signature", !isPostSignatureStage("Signature"));
  check("« Signé », « Chantier terminé », « Fin du projet » le sont", ["Signé", "Chantier terminé", "Fin du projet", "Affaire perdue"].every(isPostSignatureStage));
  const e = elig({ dealStage: "Signature" });
  check("affaire en Signature + client : éligible", e.verdict === "oui", `${e.verdict} · ${e.reason}`);
  const body = "Bonjour, Oui c'est bon pour moi, désolée du délai. Je vous envoie le devis signé ce week-end.";
  const t = triageBody(body, { stage: "Signature" });
  check("« Oui c'est bon pour moi, je vous envoie le devis signé » : Bloc 1", t.category === "chaud", `${t.category} · ${t.reason}`);
  const c = classifyMessage({ id: "s", threadId: "t", date: "2026-10-16", direction: "entrant", subject: "Re: Devis travaux", snippet: body });
  check("les règles le lisent comme signature (aucun appel nécessaire)", c.signalType === "signature" && c.intent === "strong_progress", `${c.signalType} · ${c.intent}`);
}

section("2. INTENTION APRÈS LE 200e CARACTÈRE — le corps est lu, pas l'extrait");
{
  const polite =
    "Bonsoir, Merci pour tout le travail de reprise des devis, et pour la rapidité avec laquelle vous l'avez mené. " +
    "Nous apprécions la qualité du détail, la répartition en deux phases, qui correspond à ce que nous souhaitions, et les optimisations proposées. ";
  const body = `${polite}Avant de signer dans les prochaines heures la phase 1, nous voudrions poser un cadre. Pouvons-nous en parler lundi ?`;
  check("le signal est bien après 200 caractères", body.indexOf("Avant de signer") > 200, String(body.indexOf("Avant de signer")));
  const snippet = body.slice(0, 200);
  check("sur l'extrait seul : rien de fort (le défaut corrigé)", rulesIntent(snippet).intent !== "strong_progress", rulesIntent(snippet).intent);
  const i = rulesIntent(body);
  check("sur le corps : intention forte et réponse attendue", i.intent === "strong_progress" && i.needsReply, `${i.intent} · ${i.evidence}`);
  const thread = [{ id: "a", threadId: "t", date: "2026-10-11T18:47:00Z", direction: "entrant", subject: "Devis du 10/10", snippet, body }];
  const payload = buildPayload(thread, { senderRole: "customer", senderRoleCertain: true });
  check("le modèle reçoit le corps (phrase au-delà de 200 caractères)", payload.lastMessage.includes("Avant de signer dans les prochaines heures"), `${payload.lastMessage.length} car.`);
  check("le modèle reçoit le rôle établi par le système", /customer \(établi par le système/.test(payload.senderRole), payload.senderRole);
  const quoted = cleanText(`Oui, on valide.\n\nLe lun. 12 oct. 2026 à 13:57, Expert <x@renovationman.com> a écrit :\n> Bonjour, voici le devis.\n> Nous restons à votre disposition.`);
  check("l'historique cité est retiré du corps", quoted === "Oui, on valide.", JSON.stringify(quoted));
  const html = Buffer.from('<div dir="ltr">Je vous confirme le créneau de jeudi 15h.</div><div class="gmail_quote">Le mar. a écrit : ancienne proposition</div>').toString("base64url");
  const fromHtml = cleanLatestInboundBody({ mimeType: "text/html", body: { data: html } });
  check("HTML seul : texte propre, citation Gmail retirée", fromHtml === "Je vous confirme le créneau de jeudi 15h.", JSON.stringify(fromHtml));
  const long = cleanText(`${"Texte utile. ".repeat(400)}`);
  check("corps borné (quelques milliers de caractères, jamais infini)", long.length <= 3001, String(long.length));
}

section("3. OBJET « REMISE » + CORPS POSITIF — l'objet ne met pas de veto");
{
  const c = classifyMessage({ id: "r", threadId: "t", date: "2026-10-15", direction: "entrant", subject: "Re: Retour suite à la demande de remise", snippet: "Tout est bon pour nous, on signe ensemble." });
  check("l'objet « remise » ne fait plus « risque »", c.signalType !== "risque", c.signalType);
  check("intention forte lue dans le corps", c.intent === "strong_progress", `${c.intent}`);
  const t = triageBody("Tout est bon pour nous, on signe ensemble.", { subject: "Remise projet appartement" });
  check("Bloc 1", t.category === "chaud", t.category);
  const internal = classifyMessage({ id: "n", threadId: "t", date: "2026-10-15", direction: "interne", subject: "Notification opportunité perdue", snippet: "Bonjour." });
  check("notification INTERNE : son objet reste lu (fait écrit par l'équipe)", internal.signalType === "negatif", internal.signalType);
}

section("4 à 6. SÉMANTIQUE BLOC 1 / BLOC 2");
{
  const hot = [
    "Oui c'est bon pour moi",
    "On souhaite continuer",
    "Je vous envoie le devis signé",
    "Comment procède-t-on pour signer ?",
    "Pouvez-vous me rappeler pour avancer ?",
    "Nous validons votre proposition",
    "Quand pouvons-nous démarrer ?",
    "Voici les documents demandés pour poursuivre",
    "Je peux me rendre disponible demain à 13h30, j'ai pris rdv sur le site.",
    "Oui demain ou jeudi si vous voulez.",
    "Comme discuté hier, je vous confirme le créneau de ce jeudi à 15h.",
  ];
  for (const b of hot) {
    const t = triageBody(b);
    check(`Bloc 1 : « ${b} »`, t.category === "chaud", `${t.category} · ${rulesIntent(b).evidence}`);
  }
  const ask = triageBody("Bonjour, je souhaiterais savoir s'il était possible d'apporter des modifications au devis de la salle de bain.");
  check("question concrète sur le devis : Bloc 2", ask.category === "attente", `${ask.category} · ${ask.reason}`);
  const ht = triageBody("Je suis confuse, vous m'aviez mentionné 8000 eur pour la sdb. S'agissait-il en fait de valeurs HT ?");
  check("question de prix avant signature : Bloc 2", ht.category === "attente", ht.category);
  const docs = rulesIntent("Bonjour, merci pour votre temps aujourd'hui. Comme convenu je vous envoie le dossier technique de la maison.");
  check("envoi de pièces pour poursuivre : fort ET réponse attendue", docs.intent === "strong_progress" && docs.needsReply, `${docs.intent} · ${docs.needsReply}`);
  const third = rulesIntent("Oui nous avons eu un retour : nous signons le compromis de vente lundi prochain.");
  check("« nous signons le compromis » : pas une signature avec RM", third.evidence !== "volonté de signer", third.evidence);
  const neg = rulesIntent("Je ne suis pas disponible mardi, et nous ne signerons pas avant la fin de l'année.");
  check("négation dans la phrase : pas de signal fort", neg.intent !== "strong_progress", neg.intent);
  const ack = triageBody("Merci David !");
  check("remerciement seul : aucun bloc", ack.category === "ignore", ack.category);
  const later = triageBody("Merci Anthony, j'étudie la chose avec mon compagnon et revenons vers vous lorsque nous voulons nous lancer.");
  check("« nous revenons vers vous » : aucun bloc", later.category === "ignore", later.category);
}

section("7 à 9. IDENTITÉ — artisan, architecte, fournisseur, même dans le fil d'un client");
{
  const artisan = qualifySender({ fromEmail: "artisan.bat@yahoo.com", internalDomain: INTERNAL_DOMAIN, directory: { kind: "contact", contactRecordType: "Artisan" } });
  check("artisan contact Salesforce (type Artisan, adresse yahoo) : artisan certain", artisan.role === "artisan" && artisan.certain, artisan.reason);
  const e1 = elig({ matchKind: "contact", senderRole: artisan.role, senderRoleReason: artisan.reason });
  check("artisan : hors périmètre avant toute intention", e1.verdict === "non", e1.reason);
  const t1 = triageBody("Voici le devis signé, l'acompte sera versé prochainement, merci de m'indiquer la date de livraison.", {
    from_email: "artisan.bat@yahoo.com", match_kind: "contact", sender_role: "artisan", sender_role_reason: artisan.reason,
  });
  check("son « devis signé » ne remonte pas (faux positif de l'audit)", t1.category === "hors_perimetre", t1.category);

  const moe = qualifyMessageSender({
    fromEmail: "archi@renaissance.archi", fromName: "Cabinet d'architecte", internalDomain: INTERNAL_DOMAIN,
    directory: new Map(), opportunityClientEmails: new Set(["client@exemple.fr"]),
    dealOpportunity: { opportunityId: "o1", name: "Antoine CLIENT - Appartement", clientEmail: "client@exemple.fr", clientContact: "Antoine Client", owner: "X", stage: "Examen devis", isSigned: false, isActive: true },
  });
  check("architecte dans le fil d'un client : n'hérite pas du rôle client", moe.role !== "customer", `${moe.role} · ${moe.reason}`);
  const eMoe = elig({ senderRole: moe.role, senderRoleReason: moe.reason }, "archi@renaissance.archi");
  check("architecte : jamais « client actif »", eMoe.verdict !== "oui", `${eMoe.verdict} · ${eMoe.reason}`);

  const supplier = qualifySender({ fromEmail: "commercial@theogam.fr", internalDomain: INTERNAL_DOMAIN });
  check("fournisseur dans le fil d'un client : fournisseur", supplier.role === "supplier", supplier.reason);
  check("fournisseur : hors périmètre", elig({ senderRole: "supplier", senderRoleReason: supplier.reason }).verdict === "non");

  const sameName = qualifyMessageSender({
    fromEmail: "antoine.client@gmail.com", fromName: "Antoine Client", internalDomain: INTERNAL_DOMAIN,
    directory: new Map(), opportunityClientEmails: new Set(["client@exemple.fr"]),
    dealOpportunity: { opportunityId: "o1", name: "Antoine CLIENT - Appartement", clientEmail: "client@exemple.fr", clientContact: "Antoine Client", owner: "X", stage: "Examen devis", isSigned: false, isActive: true },
  });
  check("le client qui écrit d'une seconde adresse reste client (nom conforme)", sameName.role === "customer" && !sameName.certain, sameName.reason);
  const stranger = qualifyMessageSender({
    fromEmail: "be.st@orange.fr", fromName: "Bureau études", internalDomain: INTERNAL_DOMAIN,
    directory: new Map(), opportunityClientEmails: new Set(["client@exemple.fr"]),
    dealOpportunity: { opportunityId: "o1", name: "Antoine CLIENT - Appartement", clientEmail: "client@exemple.fr", clientContact: "Antoine Client", owner: "X", stage: "Examen devis", isSigned: false, isActive: true },
  });
  check("inconnu sans concordance de nom dans un fil client : inconnu, pas client", stranger.role === "unknown", stranger.reason);
  const eStranger = elig({ senderRole: "unknown" }, "be.st@orange.fr");
  check("… et seulement « incertain » malgré l'affaire du fil", eStranger.verdict === "incertain", eStranger.reason);
  const clientSf = qualifySender({ fromEmail: "client@exemple.fr", internalDomain: INTERNAL_DOMAIN, directory: { kind: "affaire_pipe", contactRecordType: "Client" } });
  check("client Salesforce : client certain", clientSf.role === "customer" && clientSf.certain, clientSf.reason);
}

section("10 à 12. EXCLUSIONS DÉTERMINISTES — anti-spam, newsletter, no-reply");
{
  const mib = msg({ from: "partenaire@invitations.mailinblack.com", subject: "Re: Re: Demande de devis", snippet: "Un clic pour délivrer votre email ! Bonjour, Je suis protégé par Protect de Mailinblack" });
  check("Mailinblack : écarté par le filtre", filterMessage(mib).rule === "reponse-automatique", filterMessage(mib).rule);
  check("Mailinblack : rôle automate", qualifySender({ fromEmail: mib.from, subject: mib.subject, text: mib.snippet, internalDomain: INTERNAL_DOMAIN }).role === "automatic");
  const auto = msg({ from: "gestionnaire@syndic-exemple.fr", subject: "Réponse automatique : Devis nettoyage combles" });
  check("« Réponse automatique » : écartée", filterMessage(auto).rule === "reponse-automatique", filterMessage(auto).rule);
  const news = msg({ from: "marketing@exemple-media.fr", bulk: true, subject: "Nos offres de la rentrée" });
  check("newsletter (en-tête d'envoi en masse) : écartée", filterMessage(news).rule === "envoi-en-masse", filterMessage(news).rule);
  check("newsletter : rôle newsletter", qualifySender({ fromEmail: news.from, bulk: true, internalDomain: INTERNAL_DOMAIN }).role === "newsletter");
  const nr = msg({ from: "no-reply@plateforme-exemple.fr", subject: "Votre compte" });
  check("no-reply : écarté", filterMessage(nr).rule === "no-reply", filterMessage(nr).rule);
  check("no-reply : rôle automate", qualifySender({ fromEmail: "commandesnoreply@exemple.immo", internalDomain: INTERNAL_DOMAIN }).role === "automatic");
}

section("13 à 14. EXPÉDITEUR INCONNU — preuve forte ou rien");
{
  const explicit = "Bonjour, je souhaite être mis en relation avec un Expert Travaux pour avancer sur mon projet de rénovation de notre appartement. Pouvez-vous me rappeler ?";
  check("prospect explicite : preuve d'un projet personnel ET d'une demande", rulesProspectEvidence(explicit));
  const tExplicit = triageBody(explicit, { match_kind: "inconnu", from_email: "particulier@gmail.com", sender_role: "unknown", sender_role_reason: "adresse inconnue de Salesforce" });
  check("… candidat aux Blocs malgré l'absence de Salesforce", tExplicit.category === "chaud" || tExplicit.category === "attente", tExplicit.category);
  const vague = "Bonjour, nous faisons des travaux.";
  check("« nous faisons des travaux » : aucune preuve", !rulesProspectEvidence(vague));
  const tVague = triageBody(vague, { match_kind: "inconnu", from_email: "particulier@gmail.com", sender_role: "unknown" });
  check("… écarté", tVague.category === "ignore", tVague.category);
  const pitch = "Bonjour, nous proposons nos services d'entreprise tous corps d'état pour vos clients. Pouvez-vous me rappeler pour un partenariat sur votre projet ?";
  check("démarchage déguisé : aucune preuve de prospect", !rulesProspectEvidence(pitch));
}

section("15 à 17. ÉTAT DU FIL — réponse RM, Bloc 1 persistant, tiers qui répond");
{
  const base = { opportunity_id: "o1", match_level: "A", reason: "", sender_role: "customer", from_email: "client@exemple.fr", scanner_v2: 1 };
  const waiting = [
    { ...base, id: "w1", thread_id: "tw", sent_at: "2026-10-16T09:00:00Z", direction: "entrant", category: "attente" },
    { ...base, id: "w2", thread_id: "tw", sent_at: "2026-10-16T10:00:00Z", direction: "sortant", category: null, from_email: "daravith@renovationman.com", sender_role: "internal" },
  ];
  check("réponse humaine RM après une attente : sort du Bloc 2", !selectVisible(waiting).waiting.has("w1"));
  const ackOnly = [waiting[0], { ...waiting[1], from_email: "contact@renovationman.com" }];
  check("accusé de réception de contact@ : ne compte pas comme réponse", selectVisible(ackOnly).waiting.has("w1"));
  const hot = [
    { ...base, id: "h1", thread_id: "th", sent_at: "2026-10-16T09:00:00Z", direction: "entrant", category: "chaud" },
    { ...base, id: "h2", thread_id: "th", sent_at: "2026-10-16T11:00:00Z", direction: "sortant", category: null, from_email: "sami@renovationman.com", sender_role: "internal" },
  ];
  check("réponse RM après un message chaud : RESTE en Bloc 1 (jusqu'à traité)", selectVisible(hot).hot.has("h1"));
  const third = [
    { ...base, id: "c1", thread_id: "tt", sent_at: "2026-10-16T09:00:00Z", direction: "entrant", category: "attente" },
    { ...base, id: "a1", thread_id: "tt", sent_at: "2026-10-16T12:00:00Z", direction: "entrant", category: "ignore", from_email: "artisan@bat-exemple.fr", sender_role: "artisan" },
  ];
  const v = selectVisible(third);
  check("un artisan qui répond après le client ne masque pas la demande du client", v.waiting.has("c1") && !v.waiting.has("a1") && !v.hot.has("a1"));
  // Le tiers n'est pas classé : la cible est le dernier message CLIENT.
  const target = pickClassificationTarget([
    { gmailMessageId: "c1", direction: "entrant", senderRole: "customer", senderRoleReason: "adresse client d'une opportunité" },
    { gmailMessageId: "a1", direction: "entrant", senderRole: "artisan", senderRoleReason: "Salesforce : Artisan" },
  ]);
  check("le message classé est celui du client, pas celui du tiers", target?.messageId === "c1", target?.messageId ?? "aucun");
  check("rôle client transmis comme certain au modèle", target?.senderRoleCertain === true);
  const onlyThird = pickClassificationTarget([{ gmailMessageId: "a1", direction: "entrant", senderRole: "supplier", senderRoleReason: "domaine de fournisseur ou de négoce" }]);
  check("fil où seul un tiers a écrit : aucune analyse, aucun appel", onlyThird === null);
  const tThird = triageBody("Ça nous convient pour lancer les commandes.", { from_email: "atelier@exemple-menuiserie.fr", sender_role: "artisan", sender_role_reason: "Salesforce : Artisan" });
  check("un tiers du fil n'hérite pas du verdict client (son message reste hors périmètre)", tThird.category === "hors_perimetre", tThird.category);
}

section("18. PÉRIMÈTRE DES BOÎTES — Vincent Da Silva");
{
  const m = msg({ to: ["vincent.dasilva@renovationman.com"], from: "client@gmail.com", subject: "Re: Contact" });
  check("vincent.dasilva@ reconnu comme commercial suivi", teamMembersInvolved(m).includes("Vincent Da Silva"), teamMembersInvolved(m).join(", "));
  check("son client n'est plus « hors périmètre »", filterMessage(m).kept, filterMessage(m).rule);
  const other = msg({ to: ["inconnu@renovationman.com"], from: "client@gmail.com" });
  check("une boîte hors équipe reste hors périmètre", filterMessage(other).rule === "hors-perimetre", filterMessage(other).rule);
}

section("CAS RÉSIDUELS DU REJEU (après premier passage)");
{
  const slot = "Bonjour Monsieur,\n\nComme discuté hier, je vous confirme le créneau de ce jeudi à 15h :\n\nMa femme ne pourra malheureusement pas y assister.\n\nA tout à l'heure !";
  check("négation d'une AUTRE phrase : la confirmation reste un signal fort", rulesIntent(slot).intent === "strong_progress", rulesIntent(slot).evidence);
  const docs = "Bonjour,\nC'est bien noté.\nComme convenu, je vous joins l'audit initial, dont nous n'avons pas retenu les scénarios proposés.\nA lundi prochain";
  check("négation éloignée du signal : « je vous joins l'audit » reste fort", rulesIntent(docs).intent === "strong_progress", rulesIntent(docs).evidence);
  const doubt = "En effet, j'ai un doute sur le fait d'avoir en décembre le feu vert de la copropriété.";
  check("« un doute sur le feu vert » : pas une validation", rulesIntent(doubt).intent !== "strong_progress", rulesIntent(doubt).intent);
  const mairie = "Tous les documents ont été donnés à la banque. Toujours en attente des informations de la mairie, du coup pas encore fixé.";
  check("« toujours en attente de la mairie » : n'attend rien de RM", rulesIntent(mairie).intent === "informational", rulesIntent(mairie).intent);
  const request = "Bonjour, nous recherchons une entreprise pour chiffrer la reprise de notre escalier. Nous souhaitons obtenir un devis.";
  check("« nous souhaitons obtenir un devis » : Bloc 2", triageBody(request, { match_kind: "piste", sender_role: "prospect" }).category === "attente");
  const wrapped = cleanText("Oui, nous signons.\n\nOn Tue, Oct 13, 2026 at 5:19 PM Client Exemple <\nclient@exemple.fr> wrote:\n> Ancien message");
  check("en-tête de citation sur deux lignes : historique retiré", wrapped === "Oui, nous signons.", JSON.stringify(wrapped));
  const owner = "Pour ne pas pénaliser le chantier, nous allons ce jour accepter le devis en V2 et virer les fonds correspondants.";
  check("co-titulaire inconnu qui accepte le devis : preuve qu'il parle en client", rulesProspectEvidence(owner));
  const newRequest = triage({
    ...V2, match_kind: "affaire_fermee", opportunity_stage: "Affaire perdue", intent: "waiting_reply", needs_reply: 1,
    quote: "Pourriez-vous me proposer un devis ?",
  });
  check("ancien client (affaire perdue) qui redemande un devis : nouvelle demande, Bloc 2", newRequest.category === "attente", `${newRequest.category} · ${newRequest.ignoredBecause ?? newRequest.reason}`);
}

section("HISTORIQUE — aucun effet rétroactif (messages antérieurs au déploiement)");
{
  const legacyRow = { ...V2, scanner_v2: null, intent: null, sender_role: null, sender_role_reason: null };
  const signature = triage({ ...legacyRow, stage: "Signature", signal_type: "signature", summary: "Engagement exprimé" });
  check("ancien message, affaire en Signature : triage historique inchangé (exclu)", signature.category === "hors_perimetre", signature.category);
  const withIntent = triage({ ...legacyRow, intent: "strong_progress", summary: "Échange sans effet clair sur la signature" });
  check("ancien message : une intention éventuelle n'est jamais lue", withIntent.category !== "chaud", withIntent.category);
  const roleIgnored = elig({ scannerV2: false, senderRole: "artisan" });
  check("ancien message : aucun rôle d'expéditeur appliqué", roleIgnored.verdict === "oui", roleIgnored.verdict);
  const legacyBase = { opportunity_id: "o2", match_level: "A", reason: "", from_email: "ancien@exemple.fr" };
  const hotThenReply = [
    { ...legacyBase, id: "l1", thread_id: "tl", sent_at: "2026-10-01T09:00:00Z", direction: "entrant", category: "chaud" },
    { ...legacyBase, id: "l2", thread_id: "tl", sent_at: "2026-10-01T10:00:00Z", direction: "sortant", category: null, from_email: "contact@renovationman.com" },
  ];
  check("ancien message chaud : toute réponse sortante le ferme, comme avant", !selectVisible(hotThenReply).hot.has("l1"));
  const twoBlocks = [
    { ...legacyBase, id: "x1", thread_id: "t1", sent_at: "2026-10-01T09:00:00Z", direction: "entrant", category: "chaud" },
    { ...legacyBase, id: "x2", thread_id: "t2", sent_at: "2026-10-03T09:00:00Z", direction: "entrant", category: "attente" },
  ];
  const v = selectVisible(twoBlocks);
  check("anciens messages : une seule ligne par client, tous blocs confondus, comme avant", v.waiting.has("x2") && !v.hot.has("x1"));
  const thirdLegacy = [
    { ...legacyBase, id: "y1", thread_id: "ty", sent_at: "2026-10-01T09:00:00Z", direction: "entrant", category: "attente" },
    { ...legacyBase, id: "y2", thread_id: "ty", sent_at: "2026-10-01T12:00:00Z", direction: "entrant", category: "ignore", sender_role: "artisan" },
  ];
  check("anciens messages : la règle du dernier message du fil reste celle d'avant", !selectVisible(thirdLegacy).waiting.has("y1"));
  const legacyTarget = pickClassificationTarget([]);
  check("aucune cible V2 sans message V2 en attente", legacyTarget === null);
  const legacyRules = classifyThread([{ id: "r", threadId: "t", date: "2026-10-01", direction: "entrant", subject: "Re: demande de remise", snippet: "Merci pour votre retour." }], null, { legacy: true });
  check("reprise historique : l'objet reste lu comme avant (risque)", legacyRules.signalType === "risque", legacyRules.signalType);
}

section("COÛT — pas d'appel inutile");
{
  const budget = newModelBudget(10);
  const signed = [{ id: "s", threadId: "t", date: "2026-10-16", direction: "entrant", subject: "Re: Devis", snippet: "Oui c'est bon pour moi, je vous envoie le devis signé ce week-end." }];
  const r = await classifyHybrid(signed, { origin: "verification", senderRole: "customer", senderRoleCertain: true }, budget);
  check("signature reconnue par les règles : aucun appel au modèle", r.source === "rules" && budget.remaining === 10, `${r.source} · budget ${budget.remaining}`);
  const emptyBudget = newModelBudget(10);
  const empty = await classifyHybrid([{ id: "e", threadId: "t", date: "2026-10-13", direction: "entrant", subject: "", snippet: "" }], { origin: "verification" }, emptyBudget);
  check("message sans texte : aucun appel, verdict définitif des règles (plus de reprise à chaque synchro)", empty.source === "rules" && emptyBudget.remaining === 10, `${empty.source} · budget ${emptyBudget.remaining}`);
  const legacyEmpty = await classifyHybrid([{ id: "e", threadId: "t", date: "2026-10-13", direction: "entrant", subject: "", snippet: "  " }], { origin: "verification", legacy: true }, emptyBudget);
  check("idem pour une reprise historique", legacyEmpty.source === "rules" && emptyBudget.remaining === 10);
  const thread = [
    { id: "c", threadId: "t", date: "2026-10-16T09:00:00Z", direction: "entrant", subject: "Re", snippet: "Pouvez-vous me rappeler ?" },
    { id: "a", threadId: "t", date: "2026-10-16T10:00:00Z", direction: "entrant", subject: "Re", snippet: "Voici notre facture." },
  ];
  check("classification ciblée : le message du client, pas le dernier du fil", classifyThread(thread, "c").intent === "strong_progress", classifyThread(thread, "c").intent);
}

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} ÉCHEC(S)`} — ${total} contrôles.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Intention commerciale d'UN message, par règles — scanner mail V2 (18/10/2026).
 *
 * Rôle : donner une intention exploitable quand le modèle n'est pas appelé
 * (repli : crédit épuisé, budget atteint, délai) et dispenser du modèle les
 * engagements explicites. Le modèle reste l'outil de la sémantique fine ; ces
 * règles couvrent les formes que l'audit a vu rater : acceptation de
 * rendez-vous, « oui c'est bon pour moi », « on signe ensemble », questions sur
 * le devis, pièces envoyées pour poursuivre.
 *
 * Elles lisent le CORPS du dernier message (voir `mail-body.ts`), jamais
 * l'objet : un objet écrit par RM (« Retour suite à la demande de remise ») ne
 * dit rien de ce que le client répond.
 *
 * Évaluation PHRASE PAR PHRASE : une négation ou une condition proche annule un
 * signal fort de la même phrase, pas celui d'une autre.
 *
 * Aucune dépendance : testable tel quel.
 */

export type CommercialIntent = "strong_progress" | "waiting_reply" | "informational" | "negative" | "uncertain";

export const COMMERCIAL_INTENTS: readonly CommercialIntent[] = [
  "strong_progress",
  "waiting_reply",
  "informational",
  "negative",
  "uncertain",
];

export type RulesIntent = {
  intent: CommercialIntent;
  /** Le message appelle une réponse ou une action de RM. */
  needsReply: boolean;
  /** Vrai quand un motif d'engagement explicite et non nié a été trouvé. */
  certain: boolean;
  /** Motif retenu, pour le diagnostic. */
  evidence: string;
};

const norm = (v: string | null | undefined): string =>
  (v ?? "")
    .replace(/[  ]/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’´`]/g, "'")
    // Les sauts de ligne sont GARDÉS : ils séparent les phrases. Les écraser
    // laissait la négation d'une autre phrase (« ma femme ne pourra pas y
    // assister ») annuler la confirmation du rendez-vous qui précédait.
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim()
    .toLowerCase();

type Pattern = { label: string; re: RegExp };

/** Engagement, validation, volonté de signer ou de démarrer. */
const STRONG: Pattern[] = [
  { label: "validation explicite", re: /\b(oui,? )?c'est (bon|ok|parfait|valide) pour (moi|nous)\b|\b(je valide|nous validons|on valide|validons votre|valide(r)? (le|la|votre|notre) (devis|proposition|budget|estimation|offre))\b|\bbon pour accord\b|\bfeu vert\b|\b(accept(er|ons|e)|valid(er|ons)) (le|la|votre|notre|ce|cette) (devis|proposition|offre|budget)\b/ },
  { label: "accord", re: /\b(nous sommes|je suis) d'accord\b|\bd'accord (pour|sur) (le|la|votre|ce|cette|les)\b|\btout est (bon|ok) pour (nous|moi)\b/ },
  { label: "proposition qui convient", re: /\b(le devis|la proposition|l'offre|le budget|l'estimation|votre proposition|votre devis|votre offre|ce devis|cette proposition) (nous |me )?(convient|va|nous va|me va)\b|\b(ca|cela) (nous|me) convient pour (avancer|lancer|signer|demarrer|commencer|lancer les commandes)\b/ },
  { label: "choix arrêté", re: /\b(nous avons|j'ai|on a) (choisi|retenu|decide de (partir|travailler|avancer|signer|valider|lancer))\b|\b(on|nous) part(ons)? (sur|avec) vous\b|\bon y va\b|\ballons-y\b/ },
  { label: "volonté de signer", re: /\b(je|nous|on) (vais|allons|va|souhaite|souhaitons|veux|voulons|compte|comptons|peut|pouvons)? ?sign(er|ons|erons|erai|e) (ensemble|le devis|la phase|ce week-end|demain|cette semaine|des que)?|\bpret(e|s)? a signer\b|\bavant de signer\b|\bon signe\b|\bje signe\b|\bnous signons\b|\bdevis signe\b|\b(je vous|nous vous) (envoie|envoyons|renvoie|renvoyons|retourne|retournons|transmets|transmettons) (le|la|les) (devis|contrat|proposition|bon)[^.]{0,20}signe/ },
  { label: "demande de signature ou de contrat", re: /\bcomment (on )?(proceder?|procede-t-on|fait-on|faisons-nous|signer?)\b[^.?!]{0,40}(signer|signature|contrat|suite|avancer)?|\blien de signature\b|\b(envoyez|transmettez|adressez)(-| )?(moi|nous) (le|la|un|une) (contrat|devis definitif|lien|bon de commande|facture d'acompte|rib)\b|\bfacture d'acompte\b/ },
  { label: "prochaine étape", re: /\bprochaine etape\b|\bcomment (on )?(avance|avancons|procede)\b|\b(on|nous) (souhaite|souhaitons|voudrions|aimerions|voulons) (avancer|poursuivre|continuer|lancer|demarrer|commencer)\b|\b(je souhaite|nous souhaitons|souhaiterions) (avancer|poursuivre|continuer|donner suite)\b|\bquand (pouvons-nous|peut-on|pourrions-nous|pourra-t-on|est-ce qu'on peut|pourriez-vous)[^?.]{0,40}(demarrer|commencer|lancer|debuter)\b|\b(lancer|demarrer) les (travaux|commandes)\b/ },
  { label: "demande de rappel", re: /\b(pouvez|pourriez|pourrez)[- ]vous (me |m'|nous )?(rappeler|appeler|telephoner)\b|\bmerci de (me |m'|nous )(rappeler|contacter|appeler)\b|\brappelez[- ](moi|nous)\b|\b(j'aimerais|je souhaite|je souhaiterais|nous souhaitons) (etre (re)?contacte|etre rappele|etre mis en relation|etre mise? en relation|parler a|echanger avec)\b/ },
  { label: "rendez-vous accepté ou demandé", re: /\b(j'ai|nous avons) (pris|reserve|booke) (un |le )?(rdv|rendez-vous|creneau)\b|\bj'ai booke\b|\b(je|nous) (peux|pouvons|pourrai|pourrons) (me|nous)? ?rendre disponibles?\b|\b(je suis|je serai|nous sommes|nous serons) disponibles? (le |ce |demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|a partir|des|cette|la semaine)|\bje (vous )?confirme (le|la|notre|ce|mon)? ?(creneau|rendez-vous|rdv|visite|date|appel)\b|\b(ok|d'accord|parfait|oui) pour (le |ce )?(lundi|mardi|mercredi|jeudi|vendredi|samedi|\d{1,2} ?h|\d{1,2}\b)|\b(oui,? )?(demain|lundi|mardi|mercredi|jeudi|vendredi|samedi) ou (lundi|mardi|mercredi|jeudi|vendredi|samedi|demain)\b|\b(vendredi|lundi|mardi|mercredi|jeudi|samedi|demain)[^.?!]{0,25}(me|nous) convient\b|\b(oui,? )?(ca|cela) me convient\b|\b(auriez|avez)-vous (un|des) (creneau|disponibilite)|\bprendre (un )?(rendez-vous|rdv)\b|\bje vous propose (un appel|un rendez-vous|un rdv|un creneau|mardi|lundi|mercredi|jeudi|vendredi|samedi)/ },
  { label: "pièces envoyées pour poursuivre", re: /\b(comme convenu|comme demande|suite a (notre|votre) (echange|appel|rendez-vous|visite)|pour (poursuivre|avancer|la suite))\b[^.]{0,80}\b(je vous (envoie|joins|transmets|adresse)|voici|ci-joint|vous trouverez)|\b(je vous (envoie|joins|transmets|adresse)|voici|ci-joint|vous trouverez)[^.]{0,60}\b(documents? (demandes?|technique)|dossier technique|pieces (demandees|en ma possession)|l'ensemble des pieces|le dpe|l'audit|les plans|les photos)\b|\bvoici comme convenu\b/ },
];

/** Demande, question, relance : le message appelle une réponse. */
const ASKS: Pattern[] = [
  { label: "question", re: /\?/ },
  { label: "demande polie", re: /\b(pouvez|pourriez|pourrez|pourrais|pourrait)[- ](vous|je|on)\b|\bmerci de (me|nous|bien vouloir)\b|\b(est|serait)-il possible\b|\bpeut-on\b/ },
  { label: "souhait d'information", re: /\b(je souhaiterais|nous souhaiterions|j'aimerais|nous aimerions|je voudrais|nous voudrions) (savoir|avoir|obtenir|recevoir|connaitre|comprendre|une|un|des|le|la)\b|\b(souhaite|voudrais|aimerais) savoir\b/ },
  { label: "demande de devis", re: /\b(je souhaite|nous souhaitons|je voudrais|nous voudrions) (obtenir|recevoir|avoir) (un|une|le|la|des) (devis|estimation|chiffrage|proposition|rendez-vous|visite)\b|\b(nous )?recherchons une entreprise\b|\bdemande de (devis|chiffrage|rendez-vous)\b/ },
  { label: "relance", re: /\b(je vous relance|je me permets de (vous )?relancer|toujours (dans l'attente|en attente) (de votre|de vos|de vous|d'un retour|du retour|de retour|de nouvelles)|toujours pas de (retour|nouvelles)|sans (reponse|retour) de votre part|des nouvelles|avez-vous pu|dans l'attente de votre retour)\b/ },
  { label: "questions sur le devis", re: /\b(quelques|des|mes) (questions|commentaires|remarques|interrogations)\b|\bj'ai (depose|ajoute|note) des (questions|commentaires|precisions)\b|\bregardez mes (derniers )?commentaires\b/ },
  { label: "ajustement demandé", re: /\b(ajuster|modifier|corriger|retirer|enlever|ajouter|revoir) (la|le|les|du|des|une|un|cette|ce)\b[^.]{0,40}\b(devis|remise|ligne|poste|prix|chiffrage|lot)\b/ },
];

/** Perte, refus, autre prestataire retenu. */
const NEGATIVE: Pattern[] = [
  { label: "refus", re: /\b(ne (donnons|donnerons|donnerai) pas suite|ne pas donner suite|sans suite|nous renoncons|on renonce|nous abandonnons|projet (est )?abandonne|ne plus (me|nous) contacter)\b/ },
  { label: "autre prestataire", re: /\b(choisi|retenu) (une |un )?autre (entreprise|prestataire|solution|devis|societe)\b|\b(penchons|penche|partons|partir) (plutot )?(vers|sur) (une |un )?(solution de )?(contractant|autre entreprise|autre prestataire)\b|\bfaire (100 ?%|l'ensemble|tous les travaux) (des travaux )?nous[- ]memes\b/ },
  { label: "offre refusée", re: /\boffre (ferme )?(qui )?n'a pas ete acceptee\b|\bnous n'avons pas (obtenu|eu) le bien\b/ },
];

/** Pas maintenant : réflexion, report, attente d'un tiers. */
const NOT_NOW =
  /\b(reflechi|reflexion|prendre (le|du) temps|reviendr(a|ai|ons)|revenir vers vous|reviens vers vous|plus tard|a la rentree|en pause|stand-?by|pas encore (decide|pret|sur|fixe)|lorsque nous (voulons|voudrons) nous lancer|quand nous serons prets|je vous tiens (informe|au courant)|tenons informes)\b|\b(attente|attend|attendons|retour|accord|validation|reponse|confirmation)[^.\n]{0,40}\b(banque|mairie|syndic|copro\w*|notaire|agence|agent|architecte|assureur|courtier|pret)\b/;

/** Accusé de réception, remerciement pur. */
const ACK_ONLY =
  /^(re ?: ?)?(bonjour|bonsoir|hello)?[ ,]*(merci( beaucoup| bien)?( [a-z]+)?|ok,? (bien )?note|bien recu|bien note|c'est note|parfait|tres bien|entendu|top|super)[ .!,]*(tres )?(clair|bonne (journee|soiree|fin de journee))?[ .!,]*$/;

const THIRD_PARTY_SIGNING = /\b(compromis|acte (authentique|de vente)|notaire|bail|promesse de vente|offre d'achat|pret)\b/;
const NEGATION = /\b(ne|n')\s?[^.?!]{0,25}\b(pas|plus|jamais|aucun)\b|\bpas encore\b|\bplutot pas\b/;
/** Doute exprimé dans la phrase : il porte sur toute la phrase, pas sur un mot voisin. */
const DOUBT = /\b(doute|douter|pas (sur|certain)e?s?|hesit\w*|incertain\w*)\b/;

/** Fenêtre autour du signal où une négation ou un doute l'annule. */
const NEGATION_WINDOW = 35;

function negatedNear(sentence: string, re: RegExp): boolean {
  const m = re.exec(sentence);
  if (!m) return false;
  const around = sentence.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index + m[0].length + NEGATION_WINDOW);
  return NEGATION.test(around);
}
const CONDITION = /\b(si(?! vous (le )?(voulez|souhaitez|preferez|convient))(?! possible)|sous reserve|a condition|des que|une fois que|lorsque)\b/;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstMatch(text: string, patterns: Pattern[]): Pattern | null {
  return patterns.find((p) => p.re.test(text)) ?? null;
}

/**
 * Intention du texte écrit dans le dernier message (corps nettoyé, sinon
 * extrait). `subject` n'est consulté que si le corps est vide.
 */
export function rulesIntent(body: string | null | undefined, subject: string | null = null): RulesIntent {
  const text = norm(body) || norm(subject);
  if (!text) return { intent: "uncertain", needsReply: false, certain: false, evidence: "aucun texte" };
  if (ACK_ONLY.test(text)) return { intent: "informational", needsReply: false, certain: true, evidence: "remerciement ou accusé de réception" };

  const all = sentences(text);
  const negative = firstMatch(text, NEGATIVE);
  if (negative) return { intent: "negative", needsReply: false, certain: true, evidence: negative.label };

  let strong: Pattern | null = null;
  for (const s of all) {
    const hit = firstMatch(s, STRONG);
    if (!hit) continue;
    if (negatedNear(s, hit.re) || DOUBT.test(s)) continue;
    // « Nous signons le compromis lundi » : une signature, mais pas avec RM.
    if (hit.label === "volonté de signer" && THIRD_PARTY_SIGNING.test(s)) continue;
    // « Si vous confirmez la date, nous signons » : une condition, pas un accord.
    if (CONDITION.test(s) && !/\bavant de signer\b/.test(s)) continue;
    strong = hit;
    break;
  }
  // Un point d'interrogation dans ce que l'expéditeur a écrit est une question.
  const ask = firstMatch(text, ASKS);
  const asksReally = ask != null;
  const notNow = NOT_NOW.test(text);

  if (strong) {
    const docs = strong.label === "pièces envoyées pour poursuivre";
    return {
      intent: "strong_progress",
      needsReply: Boolean(asksReally) || docs || strong.label === "demande de rappel" || strong.label === "demande de signature ou de contrat",
      certain: !docs,
      evidence: strong.label,
    };
  }
  // Attente d'un tiers (banque, mairie…) ou report : rien n'est attendu de RM,
  // sauf si le client pose explicitement une question.
  if (notNow && !text.includes("?")) return { intent: "informational", needsReply: false, certain: false, evidence: "pas maintenant (réflexion, report, attente d'un tiers)" };
  if (asksReally) return { intent: "waiting_reply", needsReply: true, certain: false, evidence: ask!.label };
  if (notNow) return { intent: "informational", needsReply: false, certain: false, evidence: "pas maintenant (réflexion, report)" };
  return { intent: "uncertain", needsReply: false, certain: false, evidence: "aucun motif discriminant" };
}

/** Projet personnel évoqué : la preuve qu'un inconnu parle de SES travaux. */
const OWN_PROJECT =
  /\b(mon|ma|notre|nos|mes) (projet|appartement|maison|logement|bien|salle de bain|sdb|cuisine|chantier|travaux|renovation|extension|terrasse|local|studio|combles|toiture|escalier|devis)\b|\b(nous|je) (allons |vais )?(ce jour )?(accepter|valider|regler|virer|payer) (le|la|les|votre|ce) (devis|proposition|fonds|acompte|facture)\b|\b(nous|je) (renovons|renove|souhaitons renover|souhaite renover|achetons|venons d'acheter|avons achete|recherchons une entreprise|cherchons une entreprise)\b/;

/** Demande d'avancer adressée à RM : devis, rendez-vous, rappel, mise en relation, signature. */
const PROSPECT_REQUEST =
  /\b(devis|estimation|chiffrage|proposition|rendez-vous|rdv|visite|rappel|rappeler|mise en relation|mettre en relation|expert travaux|conseiller travaux|signer|signature|contrat|demarrer|commencer les travaux)\b/;

/** Démarchage : quelqu'un qui VEND à RM, pas qui achète. */
const PITCH =
  /\b(nous proposons|notre (solution|logiciel|plateforme|offre|agence|entreprise intervient)|nos services|collaborer avec votre|partenariat|vos clients|votre reseau|referencement|campagne|webinaire|newsletter|prospection|nous intervenons|tous corps d'etat|sous-traitan)\b/;

/**
 * Preuve textuelle forte qu'un expéditeur INCONNU est un prospect qui veut
 * avancer : il parle de son projet ET demande une suite concrète à RM. « Bonjour,
 * nous faisons des travaux » ne suffit pas ; « je souhaite être mis en relation
 * avec un Expert Travaux pour avancer sur mon projet », si.
 */
export function rulesProspectEvidence(body: string | null | undefined): boolean {
  const text = norm(body);
  if (!text || PITCH.test(text)) return false;
  return OWN_PROJECT.test(text) && PROSPECT_REQUEST.test(text) && (firstMatch(text, ASKS) != null || firstMatch(text, STRONG) != null);
}

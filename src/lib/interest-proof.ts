/**
 * Preuve d'intérêt — la phrase du client qui prouve qu'il est intéressé,
 * engagé ou proche d'avancer.
 *
 * Fichier autonome (aucun import) : utilisé par les règles de classification,
 * par le garde-fou de la citation du modèle, par le rattrapage à la
 * synchronisation Gmail, par l'audit et par le harnais. Une seule définition.
 *
 * PRINCIPE. On ne cherche pas « une phrase du mail » : on cherche la phrase
 * qui, lue seule par un directeur régional, prouve l'intérêt. Cinq paliers,
 * dans l'ordre de force :
 *
 *   1. engagement concret     « je souhaite avancer », « on valide », « je signe »
 *   2. intention forte        « votre proposition nous convient », « nous sommes décidés »,
 *                             financement en cours, « vous êtes toujours dans la course »
 *   3. condition de décision  « si vous confirmez la date, nous avançons »
 *   4. question de closing    artisan, démarrage, signature, financement, acte, planning
 *   5. demande commerciale    « pouvez-vous m'envoyer le devis », « avez-vous pu avancer ? »
 *
 * Une phrase CONDITIONNELLE est jugée avant l'engagement qu'elle contient :
 * « si le planning tient, nous validons » est une condition, pas un accord.
 *
 * Ne sont JAMAIS retenues : formules de politesse, accusés de réception,
 * signatures automatiques, notifications et texte administratif. Quand rien de
 * probant n'existe, la réponse est null — l'écran dira alors qu'il n'y a pas de
 * preuve explicite, plutôt que d'inventer ou de montrer une phrase générique.
 *
 * Toute citation est un extrait EXACT du texte : la salutation d'ouverture
 * (« Bonjour Jonathan, ») est retirée en tête, rien d'autre n'est touché, et
 * le tout est tronqué au plus à 160 caractères sur un mot.
 */

export const QUOTE_MAX_LENGTH = 160;

export type ProofTier = 1 | 2 | 3 | 4 | 5;

export type InterestProof = {
  quote: string;
  tier: ProofTier;
  /** Palier en clair, pour les audits et les harnais. Jamais affiché seul. */
  label: string;
};

export const TIER_LABEL: Record<ProofTier, string> = {
  1: "engagement concret",
  2: "intention forte",
  3: "condition de décision",
  4: "question de closing",
  5: "demande commerciale",
};

// --- Paliers -----------------------------------------------------------------

const ENGAGEMENT =
  /(je souhaite avancer|nous souhaitons avancer|on souhaite avancer|souhait(e|ons) (donner suite|poursuivre|valider|signer|lancer|d[ée]marrer)|on valide|je valide|nous validons|c'est valid[ée]|je (veux|vais|souhaite|compte) signer|nous (voulons|allons|souhaitons|comptons) signer|on signe|je signe|nous signons|pr[êe]ts? (à|a) signer|bon pour accord|c'est (bon|ok|parfait) pour (moi|nous)|(envoyez|transmettez|faites|adressez)(-| )?(moi|nous)? (le|les|la|un|une|votre|vos) (document|devis|contrat|lien|proposition|facture|rib)|bloquez(-| )?(moi|nous)? (la|cette|une) date|r[ée]servez(-| )?(moi|nous)? (la|cette|une) date|nous allons partir avec vous|on part avec vous|nous partons avec vous|on y va|allons-y|c'est parti|nous donnons suite|je donne suite|lien de signature|acompte|je confirme (le|la|notre|mon|que nous|que je)|nous confirmons|feu vert|on lance|lancer les travaux|nous retenons votre|je retiens votre)/i;

const INTENTION =
  /((votre|la|cette) (proposition|offre|devis|estimation) (nous|me) (convient|va|pla[îi]t|correspond|int[ée]resse)|nous sommes d[ée]cid[ée]s|je suis d[ée]cid[ée]|nous avons d[ée]cid[ée] de|j'ai d[ée]cid[ée] de|(nous|on) pr[ée]f[ée]r(ons|e) (travailler|partir|avancer|continuer) avec vous|souhait(e|ons) travailler avec vous|retenir votre (offre|proposition|devis)|(tr[èe]s |vraiment |fortement )?int[ée]ress[ée]s? par|nous sommes (tr[èe]s )?int[ée]ress[ée]s|(me|nous) (int[ée]resse|convient|conviennent)|(le projet|la proposition|le devis|l'estimation) (me|nous) pla[îi]t|(ok|d'accord|parfait|c'est bon) pour (le |ce |la )?(lundi|mardi|mercredi|jeudi|vendredi|samedi|\d{1,2}\b)|[çc]a (nous|me) va|c'est ce qu'il nous faut|nous voulons avancer|on veut avancer|je veux avancer|toujours (dans la course|int[ée]ress[ée]s?|partants?|d'actualit[ée])|je vous confirme|nous vous confirmons|exactement ce (que|[àa] quoi)|correspond (tout [àa] fait|parfaitement)|(nous|on|je) (finalis|constitu|mont|d[ée]pos)(ons|e)[^.!?]{0,50}(pr[êe]t|financement|dossier bancaire)|demande de pr[êe]t[^.!?]{0,30}(en cours|d[ée]pos[ée]e|accept[ée]e|valid[ée]e)|(pr[êe]t|financement) (est |a [ée]t[ée] )?(accord[ée]|valid[ée]|obtenu|accept[ée])|(banque|financement|pr[êe]t)[^.!?]{0,60}([ée]tudi|instru|en cours|accord|valid|finalis))/i;

const CONDITION_VERBS =
  "nous avan[çc]ons|on avance|nous validons|on valide|je valide|nous partons|on part|nous signons|on signe|je signe|on y va|nous pouvons avancer|c'est (bon|ok)|nous confirmons|je confirme|nous donnons suite|je reviens vers vous|reviens vers vous|nous revenons vers vous|affiner le devis|on se recontacte|nous reprenons|on repart";
const CONDITION_HEADS = "\\bsi\\b|d[èe]s qu[e']|une fois qu[e']|une fois|[àa] condition qu[e']|sous r[ée]serve|d[èe]s (r[ée]ception|obtention|validation|accord)";
const CONDITION = new RegExp(
  `((${CONDITION_HEADS})[^.!?]{0,90}(${CONDITION_VERBS})|(${CONDITION_VERBS})[^.!?]{0,60}(${CONDITION_HEADS}))`,
  "i",
);

const CLOSING_TOPIC =
  /(\b\d{1,2} ?h ?\d{0,2}\b|artisan|d[ée]marr|commenc|d[ée]but des travaux|\bdate\b|planning|calendrier|d[ée]lai|signature|signer|financement|pr[êe]t|banque|acte (authentique|de vente)|notaire|disponib|livraison|intervention|quand (pouvez|pourriez|est-ce|pensez)|combien de temps|acompte|dur[ée]e des travaux|remise|geste commercial)/i;

const REQUEST_HEADS =
  "(pouvez|pourriez|pourrez|pouvez)(-| )vous|merci de (m'|nous |me |bien vouloir )|je souhaiterais|nous souhaiterions|j'aimerais|nous aimerions|je voudrais|nous voudrions|est-il possible|serait[- ]?t?[-' ]?il possible|pourrait-on|peut-on|je (vous|me permets de vous) relance|vous deviez (aussi |[ée]galement )?(me|nous)|(avez|auriez|aurez)(-| )vous (pu|eu|d[ée]j[àa]|des nouvelles|une id[ée]e|avanc[ée])|o[ùu] en (est|sommes|[êe]tes)|des nouvelles (du|de|concernant)";
const REQUEST_OBJECTS =
  "devis|estimation|rendez-vous|rdv|visite|planning|proposition|projet|travaux|chiffrage|prix|tarif|offre|contrat|documents?|plans?|reporter|d[ée]caler|nouveau (rendez-vous|cr[ée]neau)|autre (date|cr[ée]neau)|disponibilit[ée]s?|corriger|modifier|modifications?|ajustements?|corrections?|rappeler|rappel|contact";
const REQUEST = new RegExp(`(${REQUEST_HEADS})[^.!?]{0,120}(${REQUEST_OBJECTS})`, "i");

// --- Exclusions -----------------------------------------------------------------

/** Salutation d'ouverture, retirée en tête de phrase avant de juger. */
const GREETING = /^(bonjour|bonsoir|hello|salut|cher|ch[èe]re|madame|monsieur|mesdames|messieurs)\b[^,.!?]{0,40}[,.!]\s*/i;
/** Même chose sans ponctuation : « Bonjour Daravith Avez vous pu… » — le prénom, puis une majuscule. */
const GREETING_BARE = /^([Bb]onjour|[Bb]onsoir|[Hh]ello|[Ss]alut)\b(\s+[A-ZÀ-Ý][\wà-ÿ'.-]*){0,3}\s+(?=[A-ZÀ-Ý])/;

/** Formule de politesse en tête : n'est exclue que si la phrase ne dit rien d'autre. */
const POLITENESS =
  /^(bonjour|bonsoir|hello|madame|monsieur|mesdames|messieurs|cher|ch[èe]re|merci|cordialement|bien (à|a) vous|bonne (journ[ée]e|soir[ée]e|r[ée]ception|continuation|semaine)|belle journ[ée]e|je vous prie|salutations|sinc[èe]res|[àa] (tr[èe]s )?bient[ôo]t|au plaisir|dans l'attente de vous lire|excellente journ[ée]e|bien cordialement|tr[èe]s cordialement|respectueusement|amicalement|bonne fin de journ[ée]e|j'esp[èe]re que (vous|tu))\b/i;

const ACKNOWLEDGEMENT =
  /(bien re[çc]u|accus(e|ons|er) r[ée]ception|j'ai bien (re[çc]u|pris (note|connaissance))|nous avons bien (re[çc]u|pris)|merci pour (votre|ce|ces|cet|cette|l'|le|la)|je vous remercie|nous vous remercions|c'est not[ée]|bien not[ée]|je prends note|nous prenons note)/i;

const AUTO_SIGNATURE =
  /(envoy[ée] (depuis|de|[àa] partir de) mon|sent from my|t[ée]l[ée]charge[rz] outlook|obtenir outlook|get outlook|provenance\s*:|\biphone\b|\bandroid\b|\bsamsung\b|ce message et ses pi[èe]ces jointes|confidentialit[ée]|si vous n'[êe]tes pas le destinataire|pensez [àa] l'environnement|n'imprimez ce|sans virus)/i;

const ADMINISTRATIVE =
  /(vous a mentionn[ée]|a mentionn[ée]|mentioned you|vous a partag[ée]|shared with you|a partag[ée] (un|le|ce|un nouveau) (document|fichier|dossier)|docusign|yousign|vous a envoy[ée] un document|(examiner|consulter|signer) (le|ce) document|signer [ée]lectroniquement|please review|ouvrir le document|notification|no-?reply|ne pas r[ée]pondre|d[ée]sabonn|unsubscribe|^invitation\b|accept(er|[ée])? l'invitation|mise [àa] jour de l'[ée]v[ée]nement|google (docs|slides|sheets|agenda|calendar|meet)|facture n[°o]|r[ée]f[ée]rence\s*:|num[ée]ro de (dossier|commande)|mot de passe|code de v[ée]rification|https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]{2,})/i;

/** Ligne technique : très peu de lettres, ou un objet de message recopié. */
function isTechnical(sentence: string): boolean {
  const letters = (sentence.match(/[a-zà-ÿ]/gi) ?? []).length;
  return letters < sentence.length * 0.5 || /^(re|fwd|tr|fw)\s*:/i.test(sentence);
}

/** Exclusions dures : jamais retenues, quel que soit le palier. */
function isHardExcluded(sentence: string): boolean {
  return AUTO_SIGNATURE.test(sentence) || ADMINISTRATIVE.test(sentence) || isTechnical(sentence);
}

/** Exclusions douces : politesse et accusé de réception, sauf si la phrase engage. */
function isSoftExcluded(sentence: string): boolean {
  return (POLITENESS.test(sentence) && sentence.length <= 70) || ACKNOWLEDGEMENT.test(sentence);
}

// --- Découpage et présentation ----------------------------------------------------

export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/** Retire une ou deux salutations d'ouverture. Le reste est un extrait exact. */
export function stripGreeting(sentence: string): string {
  let s = sentence;
  for (let i = 0; i < 2; i += 1) {
    const next = s.replace(GREETING, "").replace(GREETING_BARE, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** Tronque proprement, sur un mot, avec une ellipse. */
export function clip(sentence: string): string {
  if (sentence.length <= QUOTE_MAX_LENGTH) return sentence;
  const cut = sentence.slice(0, QUOTE_MAX_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 60 ? cut.slice(0, space) : cut}…`;
}

/** Palier d'une phrase, ou null si elle ne prouve rien. Applique les exclusions. */
export function tierOf(sentence: string): ProofTier | null {
  const core = stripGreeting(sentence);
  if (core.length < 12 || isHardExcluded(core)) return null;
  if (CONDITION.test(core)) return 3;
  if (ENGAGEMENT.test(core)) return 1;
  if (INTENTION.test(core)) return 2;
  if (isSoftExcluded(core)) return null;
  if (core.includes("?") && CLOSING_TOPIC.test(core)) return 4;
  if (REQUEST.test(core)) return 5;
  return null;
}

/**
 * La preuve d'intérêt d'un texte : la phrase du meilleur palier, et à palier
 * égal la première dans le message. Null si aucune phrase ne prouve rien.
 */
export function selectInterestProof(text: string): InterestProof | null {
  let best: InterestProof | null = null;
  for (const sentence of sentencesOf(text)) {
    const tier = tierOf(sentence);
    if (tier == null) continue;
    if (!best || tier < best.tier) best = { quote: clip(stripGreeting(sentence)), tier, label: TIER_LABEL[tier] };
    if (best.tier === 1) break;
  }
  return best;
}

/**
 * Une citation proposée par le modèle n'est gardée que si elle prouve
 * quelque chose au sens ci-dessus. Le modèle propose, la règle dispose.
 */
export function acceptProof(candidate: string | null): InterestProof | null {
  if (!candidate) return null;
  const tier = tierOf(candidate.trim());
  return tier == null ? null : { quote: clip(stripGreeting(candidate.trim())), tier, label: TIER_LABEL[tier] };
}

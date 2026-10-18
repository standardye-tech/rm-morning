/**
 * Classification sémantique par règles déterministes — VARIANTE A.
 *
 * Aucun appel réseau, aucun modèle, aucun coût, aucune donnée qui sort. Le but
 * n'est pas de rivaliser avec un modèle de langue mais de mesurer honnêtement
 * jusqu'où des motifs métier explicites vont, pour savoir ce qu'une IA devrait
 * réellement apporter en plus.
 *
 * Deux principes structurent tout le fichier :
 *
 *   1. LE DERNIER SIGNAL PRIME. Un fil qui commence par « c'est trop cher » et
 *      finit par « envoyez le devis corrigé pour signature » vaut `signature`,
 *      pas `risque`. On classe donc le dernier message du fil, le reste ne
 *      servant que de contexte.
 *
 *   2. LE SILENCE NE PROUVE RIEN. Aucune règle ici ne regarde l'absence de
 *      message. Un dossier sans mail récent n'est pas classable — il n'est pas
 *      classé, point. Voir `classifyThread` : sans message, aucune sortie.
 *
 * Fichier autonome (aucun import) : exécutable par le harnais comme par
 * l'application.
 */

import { selectInterestProof } from "./interest-proof";
import { rulesIntent, rulesProspectEvidence, type CommercialIntent } from "./mail-intent";
import type { SenderRole } from "./sender-role";
export { QUOTE_MAX_LENGTH } from "./interest-proof";

export type SignalType = "signature" | "positif_bloque" | "risque" | "negatif" | "neutre";

export type Classification = {
  signalType: SignalType;
  /** Entre 0 et 1. Plafonnée : des règles ne sont jamais certaines. */
  confidence: number;
  /** Obstacle identifié, quand il y en a un. */
  blocker: string | null;
  /** Résumé court. Gabarit assumé côté règles — voir la note plus bas. */
  summary: string;
  /** Justification très courte, vérifiable. */
  reason: string;
  /** Date du signal retenu. */
  signalAt: string;
  /** `rules@1` ici ; un modèle inscrirait son propre identifiant. */
  classifier: string;
  /**
   * La phrase du message la plus parlante pour un manager : une demande, une
   * condition, une échéance, un engagement. Recopiée TEXTUELLEMENT, au plus
   * 160 caractères, jamais reformulée. Null quand rien ne s'y prête.
   */
  quote: string | null;
  /**
   * V2 — intention du MESSAGE (Bloc 1 = strong_progress, Bloc 2 = waiting_reply)
   * et besoin de réponse. Distincts de `signalType`, qui reste la mesure de
   * probabilité de signature consommée par le forecast.
   */
  intent?: CommercialIntent;
  needsReply?: boolean;
  /** Rôle proposé par le modèle, seulement quand le système ne le connaissait pas. */
  senderRole?: SenderRole | null;
  /** Expéditeur inconnu : preuve d'un projet personnel ET d'une demande d'avancer. */
  prospectEvidence?: boolean;
};

/** Message minimal nécessaire à la classification. */
export type ClassifiableMessage = {
  id: string;
  threadId: string;
  date: string;
  direction: "entrant" | "sortant" | "interne";
  subject: string;
  /** Extrait court fourni par Gmail. */
  snippet: string;
  /**
   * V2 — corps nettoyé du message (`mail-body.ts`), en mémoire seulement : lu
   * pour le dernier message humain entrant, jamais stocké. Absent = extrait.
   */
  body?: string | null;
  /** Expéditeur, pour choisir le dernier message humain utile du fil. */
  fromEmail?: string;
};

// --- Motifs métier ---------------------------------------------------------
//
// Chaque famille porte une étiquette lisible : c'est elle qui apparaît dans la
// justification, pour qu'une classification soit toujours traçable jusqu'au
// motif qui l'a produite.

type Marker = { label: string; pattern: RegExp };

/** Perte ou abandon explicite. Le plus fort : rien ne le contredit. */
const NEGATIVE: Marker[] = [
  { label: "opportunité perdue", pattern: /est perdue|opportunit[ée] perdue/i },
  { label: "piste abandonnée", pattern: /a [ée]t[ée] abandonn[ée]e?|piste abandonn[ée]e?/i },
  { label: "client injoignable", pattern: /ne r[ée]pond (pas|plus)/i },
  { label: "sans suite", pattern: /ne (donnons|donne) pas suite|sans suite|nous renon[çc]ons/i },
  { label: "concurrent retenu", pattern: /choisi (une |un )?autre (entreprise|prestataire|devis)|retenu un autre/i },
  { label: "projet abandonné", pattern: /projet (est )?abandonn[ée]|abandonne (le|notre) projet|on abandonne/i },
  { label: "financement refusé", pattern: /pr[êe]t refus[ée]|financement refus[ée]|pas (eu )?de pr[êe]t|cr[ée]dit refus[ée]/i },
  { label: "demande d'arrêt de contact", pattern: /ne plus (me|nous) contacter|d[ée]sinscri/i },
];

/** Engagement réel, ou dernière étape avant engagement. */
const SIGNATURE: Marker[] = [
  { label: "bon pour accord", pattern: /bon pour accord/i },
  { label: "promesse signée", pattern: /promesse sign[ée]e?/i },
  { label: "validation explicite", pattern: /c'est (bon|ok) pour (moi|nous)|je valide|nous validons|on valide/i },
  { label: "lien de signature demandé", pattern: /lien de signature|proc[ée]dure de signature|signer [ée]lectroniquement/i },
  { label: "facture d'acompte demandée", pattern: /facture d'acompte|acompte (à|a) r[ée]gler/i },
  { label: "RIB demandé pour régler", pattern: /\brib\b.{0,40}(r[ée]gl|virement|paiement)|pour (vous )?r[ée]gler/i },
  { label: "choix explicite de nous retenir", pattern: /on part (sur|avec vous)|nous partons (sur|avec vous)|on y va avec vous/i },
  { label: "engagement de signature", pattern: /je signe|nous signons|pr[êe]t (à|a) signer/i },
  { label: "dernière correction avant signature", pattern: /avant signature|avant (de |la )?signer|on y est presque/i },
];

/**
 * Obstacle. Décisif : il fait basculer un signal de signature vers
 * `positif_bloque`. C'est la garde contre le faux positif de signature le
 * plus coûteux — « accord de principe sous réserve de financement ».
 */
const BLOCKER: Marker[] = [
  { label: "financement", pattern: /pr[êe]t immo|pr[êe]ts? (immo|travaux|bancaire)|d[ée]marches? de pr[êe]t|contrat de pr[êe]t|financement|accord de principe bancaire|dossier bancaire|aupr[èe]s des banques|\bbanque\b/i },
  { label: "copropriété", pattern: /copropri[ée]t[ée]|syndic|assembl[ée]e g[ée]n[ée]rale|\bAG\b.{0,20}copro/i },
  { label: "document manquant", pattern: /document manquant|il (me |nous )?manque|je n'ai (rien|pas) re[çc]u|plus aucun document|pas en (ma|notre) possession|attestation .{0,30}demand/i },
  { label: "sous réserve", pattern: /sous r[ée]serve|(toujours )?en attente|dans l'attente de|d[èe]s que (j'aurai|nous aurons)/i },
  { label: "planning à confirmer", pattern: /(à|a) confirmer|planning .{0,20}(confirmer|caler)|date de d[ée]marrage .{0,20}(confirmer|d[ée]finir)/i },
  { label: "notaire", pattern: /chez le notaire|signature notari/i },
  { label: "acquisition du bien", pattern: /fait une offre|offre pour (la|le) (maison|appartement|bien)|compromis de vente/i },
];

/** Dégradation de la probabilité de signature, sans perte constatée. */
const RISK: Marker[] = [
  { label: "mise en concurrence", pattern: /autres? devis|selon les (autres )?devis|comparer? les (devis|offres)|mise en concurrence|autre (entreprise|prestataire)/i },
  { label: "prix jugé élevé", pattern: /trop (cher|[ée]lev[ée])|hors budget|d[ée]passe (notre|le) budget|budget (serr[ée]|limit[ée])/i },
  { label: "demande de remise", pattern: /remise|geste commercial|effort (commercial|sur le prix)|revoir le prix/i },
  { label: "hésitation", pattern: /nous r[ée]fl[ée]chissons|je r[ée]fl[ée]chis|h[ée]sit|pas encore d[ée]cid|on verra/i },
  { label: "report", pattern: /report[eé]|d[ée]caler|remettre (à|a) (la rentr[ée]e|plus tard)|(à|a) la rentr[ée]e/i },
  { label: "rendez-vous annulé", pattern: /rendez-vous annul[ée]|annul(e|ons) (le|notre) (rdv|rendez-vous)/i },
  { label: "relance restée sans réponse", pattern: /toujours pas de retour|sans r[ée]ponse depuis|pas eu de retour/i },
  { label: "changement de périmètre", pattern: /[ée]largir le p[ée]rim[èe]tre|changement de p[ée]rim[èe]tre|revoir le p[ée]rim[èe]tre/i },
];

/**
 * Client engagé mais dont la demande porte un obstacle implicite : une
 * modification, un ajustement, une correction à faire. Favorable, non conclu.
 */
const PENDING_POSITIVE: Marker[] = [
  { label: "accord de principe", pattern: /accord de principe|d'accord sur le principe/i },
  { label: "demande de modification du devis", pattern: /quelques? (modification|ajustement|correction)|modifications? (à|a) apporter|points? (à|a) ajuster|correction est n[ée]cessaire|ajout[ée] quelques notes|lignes? (à|a) (revoir|corriger|ajuster)/i },
  // Le verbe et le mot « devis » sont souvent séparés par une incise (« le
  // décomposer et m'adresser un devis d'isolation ») : on les cherche dans un
  // voisinage, pas côte à côte.
  { label: "demande de devis remanié", pattern: /devis[\s\S]{0,200}(d[ée]composer|scinder|s[ée]parer)|(d[ée]composer|scinder|s[ée]parer)[\s\S]{0,200}devis|devis (corrig[ée]|modifi[ée]|remani[ée])|nous souhaiterions avoir|(m'|nous )adresser un devis|pourriez-vous[^.!?]{0,120}devis/i },
  { label: "retour favorable sur le devis", pattern: /prix sont (très )?corrects|super boulot|[çc]a (me|nous) convient|int[ée]ress[ée]s? par/i },
];

const found = (text: string, markers: Marker[]): string[] =>
  markers.filter((m) => m.pattern.test(text)).map((m) => m.label);

/** Décode les entités HTML que Gmail laisse dans ses extraits. */
function decode(text: string): string {
  return text
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/**
 * Coupe la citation du message précédent. Un extrait Gmail recopie souvent le
 * fil antérieur ; le classer reviendrait à classer un signal déjà périmé.
 */
function withoutQuote(text: string): string {
  const cut = text.search(
    /\bLe \d{1,2} (janv|f[ée]vr|mars|avril|mai|juin|juil|ao[ûu]t|sept|oct|nov|d[ée]c)|\bLe (lun|mar|mer|jeu|ven|sam|dim)\.|\bOn \w{3}, \w{3} \d|From: |De : |-----Message d'origine/,
  );
  return cut > 40 ? text.slice(0, cut) : text;
}

const CONFIDENCE_CAP = 0.85;

function score(base: number, hits: number): number {
  return Math.min(CONFIDENCE_CAP, base + 0.08 * Math.max(0, hits - 1));
}

/**
 * Classe UN message. Le fil est traité par `classifyThread`, qui choisit le
 * message à classer.
 */
export function classifyMessage(message: ClassifiableMessage, options: { legacy?: boolean } = {}): Classification {
  const subject = decode(message.subject ?? "");
  const body = messageBody(message);
  const text = `${subject}\n${body}`;
  // V2 — L'OBJET EST UN CONTEXTE, PAS UN VERDICT. Les marqueurs négatifs, de
  // risque et d'obstacle ne lisent que ce que l'expéditeur a écrit : un objet
  // repris d'un message de RM (« Retour suite à la demande de remise ») classait
  // « risque » le client qui répondait « on signe ensemble » (audit du
  // 18/10/2026). L'objet ne sert que si le corps est vide.
  // Un message INTERNE (notification Salesforce, transfert d'un ET) porte son
  // fait dans l'objet, écrit par l'équipe : il reste lu en entier.
  // `legacy` : reprise d'un message antérieur au déploiement V2 — lecture
  // historique, objet compris.
  const written = !options.legacy && message.direction === "entrant" && body.trim() ? body : text;

  const negative = found(written, NEGATIVE);
  const signature = found(text, SIGNATURE);
  const blocker = found(written, BLOCKER);
  const risk = found(written, RISK);
  const pending = found(text, PENDING_POSITIVE);
  const intent = rulesIntent(body, subject);
  const prospectEvidence = rulesProspectEvidence(body);

  const make = (
    signalType: SignalType,
    confidence: number,
    reason: string,
    summary: string,
    blockerLabel: string | null = null,
  ): Classification => ({
    signalType,
    confidence: Number(confidence.toFixed(2)),
    blocker: blockerLabel,
    summary,
    reason,
    signalAt: message.date,
    classifier: "rules@1",
    // La citation est la PREUVE D'INTÉRÊT du message — pas la phrase du motif :
    // un client peut être classé « risque » et avoir écrit une phrase qui
    // engage. Sélection unique, partagée avec le rattrapage et le modèle.
    quote: selectInterestProof(body)?.quote ?? null,
    // Une signature ou une perte reconnues par les règles fixent l'intention.
    intent: signalType === "signature" ? "strong_progress" : signalType === "negatif" ? "negative" : intent.intent,
    needsReply: signalType === "negatif" ? false : intent.needsReply,
    prospectEvidence,
  });

  // 1. Perte explicite. Rien ne prime sur un abandon constaté.
  if (negative.length > 0) {
    return make(
      "negatif",
      score(0.8, negative.length),
      negative.join(", "),
      "Perte ou abandon explicitement constaté",
    );
  }

  // 2. Signal de signature — mais un obstacle le dégrade aussitôt.
  //    C'est ici que se joue le faux positif de signature le plus coûteux.
  if (signature.length > 0) {
    if (blocker.length > 0) {
      return make(
        "positif_bloque",
        score(0.75, signature.length + blocker.length),
        `${signature.join(", ")} — mais conditionné : ${blocker.join(", ")}`,
        `Accord exprimé, conditionné à : ${blocker.join(", ")}`,
        blocker[0],
      );
    }
    return make(
      "signature",
      score(0.75, signature.length),
      signature.join(", "),
      "Engagement exprimé ou dernière étape avant signature",
    );
  }

  // 3. Dégradation. Passe avant le positif : un client qui compare des devis
  //    reste un risque même s'il complimente le nôtre.
  if (risk.length > 0) {
    return make(
      "risque",
      score(0.65, risk.length),
      risk.join(", "),
      "Projet vivant, probabilité de signature en baisse",
      blocker[0] ?? null,
    );
  }

  // 4. Favorable mais bloqué. Un obstacle seul suffit : « démarches de prêt en
  //    cours » est un client qui avance, pas un client neutre.
  if (pending.length > 0 || blocker.length > 0) {
    const labels = [...pending, ...blocker];
    return make(
      "positif_bloque",
      score(0.6, labels.length),
      labels.join(", "),
      blocker.length > 0
        ? `Client engagé, en attente : ${blocker.join(", ")}`
        : "Client engagé, ajustements demandés",
      blocker[0] ?? "ajustement en cours",
    );
  }

  // 5. Rien de discriminant. On ne force pas : `neutre` est une vraie réponse.
  return make("neutre", 0.5, "aucun motif discriminant", "Échange sans effet clair sur la signature");
}

/**
 * Classe un fil. Le dernier message emporte la décision — y compris s'il vient
 * de l'équipe : « promesse signée » écrit par le commercial est un fait sur
 * l'affaire, pas une opinion.
 *
 * Renvoie `null` si le fil est vide. L'ABSENCE de message ne produit JAMAIS de
 * classification : le silence n'est pas un signal.
 */
/**
 * Le texte utile d'un message : le corps nettoyé quand il a été lu (V2), sinon
 * l'extrait décodé, sans la citation du fil antérieur.
 */
export function messageBody(message: ClassifiableMessage): string {
  if (message.body && message.body.trim()) return message.body;
  return withoutQuote(decode(message.snippet ?? ""));
}

/** Preuve d'intérêt d'un message. Sert au rattrapage à la synchronisation. */
export function extractQuoteFromMessage(message: ClassifiableMessage): string | null {
  return selectInterestProof(messageBody(message))?.quote ?? null;
}

export function classifyThread(
  messages: ClassifiableMessage[],
  targetId?: string | null,
  options: { legacy?: boolean } = {},
): Classification | null {
  if (messages.length === 0) return null;
  const ordered = [...messages].sort((a, b) => a.date.localeCompare(b.date));
  // V2 — le message classé est celui que la synchronisation désigne (le dernier
  // message humain entrant utile) ; à défaut, le dernier du fil.
  const target = (targetId && ordered.find((m) => m.id === targetId)) || ordered[ordered.length - 1];
  return classifyMessage(target, options);
}

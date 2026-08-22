/**
 * Filtrage déterministe du bruit e-mail.
 *
 * Aucune IA, aucun appel réseau, aucune lecture de corps de message : les
 * règles ne travaillent que sur des métadonnées (expéditeur, destinataires,
 * objet) et sur l'extrait court fourni par Gmail.
 *
 * Chaque règle porte un identifiant, pour que le rapport de validation dise
 * exactement laquelle a écarté quoi. Une règle qui écarte à tort se corrige
 * ici, seule, sans toucher au reste du moteur.
 *
 * Fichier volontairement autonome (aucun import) : il doit rester exécutable
 * par le harnais de validation comme par l'application.
 */

/** Domaine interne de l'entreprise. */
export const INTERNAL_DOMAIN = "renovationman.com";

/**
 * Boîtes des commerciaux suivis. Un message qui ne touche aucune d'elles est
 * hors périmètre : on ne lit jamais leurs boîtes, mais on sait reconnaître
 * leur adresse quand elle apparaît en destinataire ou en copie.
 */
export const TEAM_MAILBOXES: Record<string, string> = {
  "anthony.ramaherison@renovationman.com": "Anthony Ramaherison",
  "guillaume@renovationman.com": "Guillaume Fontaine",
  "mathis.coulon@renovationman.com": "Mathis Coulon",
  "daravith@renovationman.com": "Daravith Chan Fah",
  "vincent.bouzy@renovationman.com": "Vincent Bouzy",
  "jonathan.florville@renovationman.com": "Jonathan Florville",
  "david.bernstein@renovationman.com": "David Bernstein",
  "stephane.strat@renovationman.com": "Stéphane Strat",
  "valentin@renovationman.com": "Valentin Marion",
  "guillaume.huc@renovationman.com": "Guillaume Huc",
  "sami@renovationman.com": "Sami Lazari",
};

/**
 * Boîtes génériques de l'entreprise par lesquelles arrivent de vrais prospects.
 *
 * Un message reçu uniquement via `contact@` ne touche aucune boîte nominative :
 * il n'a pas encore de commercial affecté. Ce n'est pas une raison de l'écarter —
 * c'est au contraire souvent un lead entrant. Il est donc conservé, puis
 * rattaché normalement : niveau A si l'adresse du client est connue de
 * Salesforce, sinon niveau C avec `opportunity_id` nul, jamais forcé.
 */
export const GENERIC_INBOXES = ["contact@renovationman.com"];

/**
 * Mahery Raza et Vincent Da Silva font partie de l'équipe suivie — dans
 * Salesforce, le forecast, les statistiques et le Morning Brief — mais leurs
 * échanges clients ne transitent pas encore par la boîte lue ici. Leur absence
 * de cette table est donc normale et attendue : ce n'est ni un oubli, ni un
 * défaut de configuration. Le jour où leurs messages apparaîtront, il suffira
 * d'ajouter leur adresse ci-dessus. Ne jamais inventer d'adresse.
 */

/** Expéditeurs et domaines dont aucun message n'a d'effet sur une signature. */
const NOISE_DOMAINS = [
  // Plateformes grand public et divertissement
  "spotify.com", "ticketmaster.fr", "ticketac.com", "billetreduc.com", "mpg.football",
  "epingmastery.com", "hardloop.com", "carvertical.com", "gensdeconfiance.com",
  // Presse et veille
  "lexpress.fr", "tf1.fr", "batiactu.com", "pe-insights.com", "seranking.com",
  // Éditeurs logiciels et SaaS
  "capterra.com", "openai.com", "microsoft.com", "manus.im", "avigilon.com",
  "mcafee.com", "wetransfer.com", "slack.com", "qobra.co", "ilovesign.com",
  "kiwidiag.com", "crowdcube.eu", "crowdcube.com", "comencouleurs.com",
  // Petites annonces et notifications de service
  "leboncoin.fr", "support.whatsapp.com", "accounts.google.com",
  // Paiement et prestataires administratifs récurrents de l'entreprise :
  // domaines stables, pas des expéditeurs de passage.
  "paypal.fr", "paypal.com", "numbr.co", "mon-formaliste.fr",
  // Salons, démarchage et prospection sortante reçue sur les boîtes génériques
  "matterport.com", "realnewtech.com", "canalvienne.tv", "agencecga.fr",
  "recrutementidf.fr", "get-shiftcite.fr",
  // Assurance santé — démarchage
  "alan.com", "alan.eu",
  // Recrutement
  "hellowork.com", "candidaturespontanee.com",
];

/**
 * Expéditeurs purement techniques : serveur de messagerie, agrégateur de
 * notifications. Un résumé quotidien d'outil cite les mêmes formules qu'une
 * vraie notification commerciale — il ne doit donc jamais bénéficier de
 * l'allowlist, sans quoi il la déclenche à chaque envoi.
 */
const TECHNICAL_SENDER = /^(mailer[.\-_]?daemon|postmaster|chatter)$/i;

/** Adresses techniques Google dont aucun message n'est commercial. */
const GOOGLE_NOISE_LOCALS = [
  "calendar-notification", "google-maps-noreply", "drive-shares-dm-noreply", "no-reply",
];

export type MailMessage = {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** Extrait court fourni par Gmail. Jamais le corps complet. */
  snippet: string;
  /**
   * Le message porte-t-il un en-tête d'envoi en masse (`List-Unsubscribe`,
   * `Precedence: bulk`) ? Marqueur normalisé, bien plus fiable et bien plus
   * durable qu'une liste de domaines tenue à la main.
   */
  bulk?: boolean;
  /**
   * Valeur de `List-ID`. Indispensable : `contact@renovationman.com` n'est pas
   * une boîte mais un groupe Google. Tout ce qui y transite — y compris un
   * vrai prospect — reçoit `Precedence: list` et un `List-Unsubscribe` posé
   * par Google Groups, qui écrase ceux de l'expéditeur d'origine. Sans cette
   * distinction, le filtre d'envoi en masse supprimerait tous les leads
   * entrants du site.
   */
  listId?: string;
};

export type FilterVerdict = {
  kept: boolean;
  /** Identifiant de la règle qui a tranché. */
  rule: string;
  label: string;
};

const lower = (value: string) => (value ?? "").trim().toLowerCase();
const domainOf = (email: string) => lower(email).split("@")[1] ?? "";
const localOf = (email: string) => lower(email).split("@")[0] ?? "";

/** Toutes les adresses touchées par le message. */
export function participants(message: MailMessage): string[] {
  return [message.from, ...(message.to ?? []), ...(message.cc ?? [])].map(lower).filter(Boolean);
}

/** Commerciaux de l'équipe présents dans le message. */
export function teamMembersInvolved(message: MailMessage): string[] {
  const found = new Set<string>();
  for (const address of participants(message)) {
    const member = TEAM_MAILBOXES[address];
    if (member) found.add(member);
  }
  return [...found];
}

/** Le message passe-t-il par une boîte générique de l'entreprise ? */
export function usesGenericInbox(message: MailMessage): boolean {
  return participants(message).some((address) => GENERIC_INBOXES.includes(address));
}

/** Au moins un interlocuteur hors de l'entreprise ? */
function hasExternalParticipant(message: MailMessage): boolean {
  return participants(message).some((address) => domainOf(address) !== INTERNAL_DOMAIN);
}

/** Le message a-t-il transité par une liste de diffusion de l'entreprise ? */
function isInternalList(message: MailMessage): boolean {
  return lower(message.listId ?? "").includes(INTERNAL_DOMAIN);
}

const matches = (message: MailMessage, pattern: RegExp) =>
  pattern.test(message.subject) || pattern.test(message.snippet);

/**
 * Notifications internes réellement commerciales : elles doivent survivre au
 * filtre « échanges internes », qui les écarterait sinon.
 */
const COMMERCIAL_NOTIFICATION =
  /nouvelle piste|statut de la piste|piste abandonn|opportunit[ée] (perdue|gagn)|nouveau lead|promesse sign|bon pour accord/i;

/**
 * Acompte : un client qui réclame sa facture d'acompte est un client qui
 * s'engage. C'est l'un des signaux de signature les plus forts du métier —
 * il ne doit jamais tomber dans le filtre administratif.
 */
const DEPOSIT_INVOICE =
  /acompte|arrhes|premier versement|facture de d[ée]marrage|[ée]ch[ée]ancier de paiement/i;

/**
 * Pièces administratives et comptables : elles circulent en volume et ne
 * disent rien de l'avancement commercial d'une affaire.
 */
const ADMIN_MARKERS =
  /attestation (de |d')?(vigilance|assurance|fiscale|urssaf|tva)|urssaf|\bkbis\b|extrait k ?bis|assurance d[ée]cennale|responsabilit[ée] civile professionnelle|\brib\b|relev[ée] d'identit[ée] bancaire|note d'honoraires|expert[- ]comptable|pi[èe]ces comptables|d[ée]claration (de )?tva|bilan comptable|liasse fiscale|num[ée]ro de tva|greffe du tribunal|\burssaf\b|\brgpd\b|suppression (de |du )?(mon |votre )?compte et de/i;

/**
 * Facturation vue du côté fournisseur : réclamation de paiement, dépôt de
 * facture, relance d'impayé. Toujours conditionné à un marqueur explicite —
 * le mot « facture » seul ne suffit jamais à écarter.
 */
const SUPPLIER_INVOICE =
  /facture (fournisseur|artisan|sous[- ]traitant)|d[ée]p[ôo]t de facture|relance (de )?(paiement|facture)|\bimpay[ée]|mise en demeure|facture (n[°o]\s*\S+ )?(à|a) r[ée]gler|r[èe]glement de (nos|vos|la) factures?|bon de commande fournisseur|demande de paiement/i;

/**
 * Règles d'exclusion, évaluées dans l'ordre. La première qui répond gagne.
 * L'allowlist passe donc avant tout le reste.
 */
export const EXCLUSION_RULES: {
  id: string;
  label: string;
  /** true = le message est écarté. */
  test: (m: MailMessage) => boolean;
}[] = [
  // --- Allowlist : ces règles ne rejettent jamais, elles protègent. ---
  {
    id: "keep:notification-commerciale",
    label: "Notification interne à valeur commerciale (piste, opportunité, lead)",
    test: () => false,
  },

  // --- Périmètre ---
  {
    id: "hors-perimetre",
    label:
      "Ni commercial de l'équipe suivie, ni boîte générique de l'entreprise, parmi expéditeur, destinataires ou copies",
    // Une boîte générique (contact@) rattrape le message : c'est le canal
    // d'arrivée des leads non encore affectés. On exige tout de même un
    // interlocuteur externe, sinon il ne s'agit que de trafic interne.
    test: (m) =>
      teamMembersInvolved(m).length === 0 && !(usesGenericInbox(m) && hasExternalParticipant(m)),
  },

  // --- Bruit générique ---
  {
    id: "no-reply",
    label: "Expéditeur no-reply générique",
    test: (m) => /^(no[.\-_]?reply|donotreply|ne[.\-_]?pas[.\-_]?repondre)/i.test(localOf(m.from)),
  },
  {
    id: "notification-automatique",
    label: "Notification automatique d'un service tiers",
    test: (m) =>
      /^notifications?([.\-_]|$)/i.test(localOf(m.from)) && domainOf(m.from) !== INTERNAL_DOMAIN,
  },
  {
    id: "envoi-en-masse",
    label: "Envoi en masse déclaré par l'expéditeur (désinscription, Precedence: bulk)",
    // Un prospect qui écrit depuis sa boîte, un client qui répond à son
    // commercial, un artisan qui envoie un devis : aucun ne pose cet en-tête.
    // Seules les plateformes d'emailing le font.
    //
    // Exception impérative : une liste de diffusion de l'entreprise elle-même
    // n'est pas un envoi en masse. Google Groups appose ces mêmes en-têtes sur
    // TOUT ce qui traverse `contact@`, prospects compris. Le tri de ce qui
    // arrive par ce canal revient donc aux règles suivantes, pas à celle-ci.
    test: (m) => m.bulk === true && !isInternalList(m),
  },
  {
    id: "domaine-bruit",
    label: "Expéditeur d'un domaine sans enjeu commercial (newsletter, promotion, SaaS)",
    test: (m) => NOISE_DOMAINS.some((d) => domainOf(m.from) === d || domainOf(m.from).endsWith(`.${d}`)),
  },
  {
    id: "google-technique",
    label: "Notification technique Google (agenda, Drive, sécurité, Maps)",
    test: (m) =>
      domainOf(m.from).endsWith("google.com") &&
      GOOGLE_NOISE_LOCALS.some((l) => localOf(m.from).includes(l)),
  },

  // --- Catégories métier explicitement écartées ---
  {
    id: "recrutement",
    label: "Candidature ou recrutement",
    test: (m) => matches(m, /candidature|recrutement|\bCV\b|offre d'emploi|postule/i),
  },
  {
    id: "invitation-agenda",
    label: "Invitation ou modification technique d'agenda, sans annulation",
    // Une invitation, une réponse à invitation ou un simple déplacement
    // d'horaire ne disent rien d'une signature. Une ANNULATION, en revanche,
    // peut être un vrai signal : elle est donc épargnée ici et tranchée plus
    // tard, une fois qu'on sait si un client identifiable est concerné
    // (voir `isUnattributableAgendaCancellation`).
    test: (m) =>
      !isAgendaCancellation(m) &&
      /^(accept[ée]|refus[ée]|provisoire|invitation|invitation mise à jour|mis à jour|modifi[ée])\s*:/i.test(
        m.subject.trim(),
      ),
  },
  {
    id: "mediation-litige",
    label: "Médiation, expertise ou litige chantier",
    test: (m) =>
      matches(m, /m[ée]diation|expertise b[âa]timent|expert en b[âa]timent|litige|mandat_expertise/i),
  },
  {
    id: "administratif",
    label:
      "Pièce administrative, comptable ou facturation fournisseur, sans enjeu sur une signature",
    test: (m) => {
      // Exception d'abord : l'acompte est un signal client, jamais du bruit.
      if (matches(m, DEPOSIT_INVOICE)) return false;
      return matches(m, ADMIN_MARKERS) || matches(m, SUPPLIER_INVOICE);
    },
  },
  {
    id: "telephonie",
    label: "Notification du standard téléphonique : appel manqué, message vocal",
    // Le standard déverse ces notifications par dizaines chaque semaine. Elles
    // ne disent rien de l'avancement d'une affaire : le rappel effectif, lui,
    // laisse une trace dans Salesforce.
    test: (m) =>
      /^(fwd ?: ?|re ?: ?)*(appel manqu[ée]|message vocal|appel en absence)/i.test(
        m.subject.trim(),
      ),
  },
  {
    id: "retour-technique",
    label: "Retour technique de messagerie ou résumé automatique d'outil interne",
    test: (m) =>
      TECHNICAL_SENDER.test(localOf(m.from)) ||
      /^(delivery status notification|undelivered mail|mail delivery (failed|subsystem))/i.test(
        m.subject.trim(),
      ) ||
      /^votre r[ée]sum[ée] quotidien|^the transfer you received expired/i.test(m.subject.trim()),
  },
  {
    id: "chantier-execution",
    label: "Exécution de chantier : réserves, PV de réception, Consuel",
    test: (m) =>
      /^chantier\b/i.test(m.subject.trim()) ||
      /^re ?: ?chantier\b/i.test(m.subject.trim()) ||
      matches(
        m,
        /reprise (des )?r[ée]serves|PV (de |avec )?r[ée](ception|serves)|consuel|questionnaire client (à|a) mi[- ]chantier|questionnaire client de fin de chantier/i,
      ),
  },
  {
    id: "interne-sans-enjeu",
    label: "Échange interne sans impact sur le pipe",
    test: (m) =>
      domainOf(m.from) === INTERNAL_DOMAIN &&
      participants(m).every((a) => domainOf(a) === INTERNAL_DOMAIN) &&
      !COMMERCIAL_NOTIFICATION.test(`${m.subject} ${m.snippet}`),
  },
];

/**
 * Applique le filtrage. Un message conservé porte la règle « conserve ».
 */
export function filterMessage(message: MailMessage): FilterVerdict {
  // L'allowlist court-circuite : une notification commerciale interne passe,
  // même si une règle en aval l'aurait écartée. Sauf si l'expéditeur est un
  // agrégateur technique : son résumé quotidien recopie ces formules sans
  // qu'aucun événement commercial ne se soit produit.
  if (
    COMMERCIAL_NOTIFICATION.test(`${message.subject} ${message.snippet}`) &&
    !TECHNICAL_SENDER.test(localOf(message.from))
  ) {
    if (teamMembersInvolved(message).length > 0) {
      return {
        kept: true,
        rule: "keep:notification-commerciale",
        label: "Notification à valeur commerciale (piste, opportunité, lead)",
      };
    }
  }

  for (const rule of EXCLUSION_RULES) {
    if (rule.id.startsWith("keep:")) continue;
    if (rule.test(message)) return { kept: false, rule: rule.id, label: rule.label };
  }
  return { kept: true, rule: "conserve", label: "Conservé pour analyse" };
}

/**
 * Annulation ou déplacement subi d'un rendez-vous. Distingué d'une invitation
 * ordinaire parce qu'un client qui annule dit quelque chose — pas forcément
 * une mauvaise nouvelle, mais quelque chose. Le message doit atteindre la
 * couche de classification, qui seule tranchera.
 */
export function isAgendaCancellation(message: MailMessage): boolean {
  return /^(rendez-vous|[ée]v[ée]nement|invitation)\s+annul[ée]|^annul[ée]\s*:/i.test(
    message.subject.trim(),
  );
}

/**
 * Second filtre agenda, appliqué APRÈS rattachement. Une annulation n'est
 * conservée que si elle concerne quelqu'un d'identifiable : opportunité
 * rattachée, ou adresse connue de Salesforce. Sinon c'est du bruit d'agenda
 * comme un autre.
 *
 * On ne préjuge de rien ici : conserver n'est pas classer. L'annulation
 * n'est PAS transformée en signal négatif — elle est seulement autorisée à
 * poursuivre son chemin.
 */
export function isUnattributableAgendaCancellation(
  message: MailMessage,
  context: { hasOpportunity: boolean; senderIsKnownClient: boolean },
): boolean {
  if (!isAgendaCancellation(message)) return false;
  return !context.hasOpportunity && !context.senderIsKnownClient;
}

/**
 * Second filtre, appliqué APRÈS rattachement : un échange de suivi de chantier
 * sur une affaire déjà signée n'a plus d'enjeu commercial. Tant que l'affaire
 * n'est pas rattachée, on ne peut pas trancher — d'où deux temps.
 */
export function isSignedProjectFollowUp(message: MailMessage, opportunityIsSigned: boolean): boolean {
  if (!opportunityIsSigned) return false;
  return matches(
    message,
    /suivi chantier|reprise (des )?r[ée]serves|PV (de |avec )?r[ée](ception|serves)|remise des cl[ée]s|consuel|SAV/i,
  );
}

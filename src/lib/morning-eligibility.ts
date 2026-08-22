/**
 * Éligibilité d'un message au Morning commercial (C14, étage A).
 *
 * POURQUOI CET ÉTAGE EXISTE. Le triage historique répondait à une seule question :
 * « ce message exprime-t-il une intention commerciale ? ». Il le faisait bien —
 * trop bien. Un fournisseur pressé qui écrit « urgent, il faut valider avant
 * vendredi » coche tous les signaux d'un client motivé. L'audit C14 a compté
 * 27 messages retenus sur 49 qui ne venaient pas d'un client du pipe : artisans,
 * architectes, prospection SaaS, chantiers déjà signés, affaires perdues.
 *
 * On pose donc une question AVANT celle de l'intention :
 *
 *     ce message appartient-il au périmètre commercial de RM Morning ?
 *
 * Trois réponses possibles — oui, non, incertain — et jamais une seule d'entre
 * elles n'est déduite d'un mot-clé isolé. Les exclusions structurelles s'appuient
 * sur ce que C13 sait de l'interlocuteur : une affaire close, un chantier en
 * cours, une piste abandonnée sont des faits Salesforce, pas des impressions de
 * lecture. Un classifieur de tonalité ne peut pas les contredire.
 *
 * PRÉCISION AVANT VOLUME. Un message douteux vaut mieux en « incertain » qu'en
 * faux client chaud : Morning répond à « où aller chercher l'argent », et quinze
 * fausses pistes coûtent plus cher qu'un signal marginal manqué.
 *
 * Aucune dépendance : exécutable tel quel par le harnais de contrôle.
 */

export type EligibilityVerdict = "oui" | "non" | "incertain";

/** Le contexte que C13 fournit sur l'expéditeur. */
export type EligibilityContext = {
  /** Ce que le message désigne, tel que résolu par C13. */
  matchKind:
    | "affaire_pipe"
    | "affaire_hors_pipe"
    | "affaire_fermee"
    | "piste"
    | "contact"
    | "ambigu"
    | "inconnu"
    | null;
  /** Étape de l'affaire hors pipe ou close, telle que Salesforce la nomme. */
  externalStage?: string | null;
  /** Statut de la piste, quand le message en désigne une. */
  leadStatus?: string | null;
  /**
   * Étape de l'affaire du pipe, et son caractère terminal.
   *
   * Le rattachement C13 dit QUELLE affaire ; il ne dit pas si elle est encore
   * commercialement vivante. Une opportunité signée reste dans la table locale
   * jusqu'à sa clôture et ressort donc en « affaire du pipe » : sans ces deux
   * champs, une demande de planning de livraison sur un dossier déjà signé
   * remonterait comme une action commerciale.
   */
  dealStage?: string | null;
  dealIsTerminal?: boolean;
  direction?: string | null;
};

export type Eligibility = {
  verdict: EligibilityVerdict;
  /** Famille d'interlocuteur, pour le diagnostic. Jamais affichée à l'utilisateur. */
  family: string;
  /** Phrase courte et vérifiable. */
  reason: string;
};

const norm = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/[  ]/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Domaines de prospection entrante : éditeurs de logiciel, plateformes, agences.
 * Liste explicite plutôt que motif générique — un faux positif ici ferait
 * disparaître un vrai client.
 */
const PROSPECTION_DOMAIN =
  /@(go-kelvin|lumidb|buildpokeslide|sanctuary-pass|cmtd1|obat|hubspot|salesforce|pipedrive|indeed|welcometothejungle|linkedin|sendinblue|brevo|mailchimp)\./i;

/**
 * Domaines de métier du bâtiment et de la maîtrise d'œuvre.
 *
 * N'EXCLUT JAMAIS À LUI SEUL : un client peut parfaitement écrire depuis
 * l'adresse de son entreprise. Ce signal n'est retenu que combiné à l'absence
 * d'affaire du pipe, conformément à la consigne de ne pas trancher sur le seul
 * domaine.
 */
const TRADE_DOMAIN =
  /@[a-z0-9-]*(batiment|construction|renovation|habitat|artisan|menuiserie|charpent|couvert|plomb|electric|elec-|peinture|carrelage|archi|studio|atelier|ixina|cuisine|maitrise|ingenierie|bureau-?etude|solutions?)[a-z0-9-]*\./i;

/** Messageries grand public : indice qu'on parle à un particulier. */
const CONSUMER_DOMAIN =
  /@(gmail|hotmail|outlook|yahoo|orange|free|wanadoo|sfr|laposte|aol|icloud|me|live|msn|bbox|numericable|protonmail)\./i;

/** Sollicitations commerciales adressées à Renovation Man. */
const INBOUND_PITCH =
  /(offre de service|nos services|notre solution|notre logiciel|notre plateforme|partenariat|referencement|seo|prise de contact commerciale|demo|webinar|essai gratuit|profiter de|newsletter|desinscri)/;

/** Sujets d'exécution de chantier : suivi technique, service après-vente. */
const OPERATIONS =
  /(sav|service apres-?vente|malfacon|probleme (electricite|plomberie|chantier|technique)|travaux passes|reprise de chantier|finition|reserve de chantier|pv de reception|reception de chantier|planning chantier|intervention|depannage|garantie|echeance|facture|reglement|paiement du solde)/;

/**
 * Documents de conformité d'un intervenant : attestations d'assurance, de
 * vigilance URSSAF, pièces arrivant à échéance. Ce sont des sujets d'artisan ou
 * de sous-traitant, jamais des sujets de client.
 */
const COMPLIANCE_DOC =
  /(document (en fin de validite|arrivant a echeance)|fin de validite|attestation (d'|de )?(assurance|vigilance|urssaf|decennale)|kbis|rib fournisseur|piece administrative)/;

/**
 * Annonce explicite d'un NOUVEAU projet.
 *
 * Volontairement étroite. La consigne interdit de construire un moteur d'upsell
 * quand les données ne le permettent pas : on ne lève une exclusion structurelle
 * que sur une formulation sans ambiguïté, pas sur une tonalité enthousiaste.
 */
const NEW_PROJECT =
  /(nouveau projet|nouveau chantier|nouvelle maison|nouvel appartement|un autre bien|un deuxieme|une deuxieme|autre projet|autre chantier|nouveau devis pour|nouvelle demande de devis|nouvelle estimation pour)/;

/** Statuts de piste qui ne justifient aucune action commerciale. */
const DEAD_LEAD = /(abandon|perdue|doublon|injoignable|hors zone|non qualifi)/;

export function evaluateEligibility(
  message: {
    fromEmail: string | null;
    fromName?: string | null;
    subject: string | null;
    summary?: string | null;
  },
  context: EligibilityContext,
  internalDomain: string,
): Eligibility {
  const email = norm(message.fromEmail);
  const domain = email.split("@")[1] ?? "";
  const text = `${norm(message.subject)} ${norm(message.summary)}`;
  const announcesNewProject = NEW_PROJECT.test(text);

  // --- E1. Un salarié n'est jamais un client.
  if (domain && domain === internalDomain) {
    return { verdict: "non", family: "salarié RM", reason: "message d'un salarié de l'entreprise" };
  }
  if (context.direction && context.direction !== "entrant") {
    return {
      verdict: "non",
      family: "message sortant",
      reason: "message sortant ou interne, jamais une action client",
    };
  }

  // --- E2. Prospection adressée à Renovation Man.
  if (PROSPECTION_DOMAIN.test(email)) {
    return { verdict: "non", family: "prospection SaaS", reason: "sollicitation commerciale entrante" };
  }
  // Le motif de démarchage ne suffit pas seul : il n'exclut que si l'expéditeur
  // n'est rattaché à aucune affaire du pipe.
  if (INBOUND_PITCH.test(text) && context.matchKind !== "affaire_pipe") {
    return {
      verdict: "non",
      family: "prospection entrante",
      reason: "démarchage adressé à l'entreprise, sans affaire en cours",
    };
  }

  // Une affaire signée ou close n'est plus du pipe, quel que soit le libellé que
  // le rattachement lui a donné. On la traite exactement comme une affaire hors
  // pipe : identifiée, mais sans chiffre à aller chercher.
  const signedStage = /(^sign|chantier|travaux en cours|realis|fin du projet|perdue)/i.test(
    norm(context.dealStage),
  );
  const dealIsDead = context.matchKind === "affaire_pipe" && (context.dealIsTerminal || signedStage);

  switch (dealIsDead ? "affaire_hors_pipe" : context.matchKind) {
    // --- E3. Affaire du pipe : le cœur du périmètre.
    case "affaire_pipe":
      return { verdict: "oui", family: "client actif", reason: "affaire ouverte dans le pipe" };

    // --- E4. Affaire déjà signée. Le client existe, mais son argent aussi : il
    //     est acquis. Un suivi de chantier n'est pas une action commerciale.
    case "affaire_hors_pipe":
      if (announcesNewProject) {
        return {
          verdict: "oui",
          family: "client signé, nouveau projet",
          reason: "affaire déjà signée, mais un nouveau projet est explicitement annoncé",
        };
      }
      return {
        verdict: "non",
        family: "chantier en cours",
        reason: `affaire déjà signée (${context.externalStage ?? context.dealStage ?? "en cours"}) — suivi d'exécution`,
      };

    // --- E5. Affaire perdue ou terminée.
    case "affaire_fermee":
      if (announcesNewProject) {
        return {
          verdict: "oui",
          family: "ancien client, nouveau projet",
          reason: "affaire close, mais un nouveau projet est explicitement annoncé",
        };
      }
      return {
        verdict: "non",
        family: "affaire close",
        reason: `affaire close (${context.externalStage ?? "terminée"})`,
      };

    // --- E6. Pistes : la règle de statut de Monitoring Pistes s'applique.
    case "piste": {
      if (DEAD_LEAD.test(norm(context.leadStatus))) {
        if (announcesNewProject) {
          return {
            verdict: "incertain",
            family: "piste morte, nouveau projet",
            reason: "piste abandonnée mais nouveau projet évoqué — à qualifier",
          };
        }
        return {
          verdict: "non",
          family: "piste abandonnée",
          reason: `piste ${context.leadStatus ?? "abandonnée"}`,
        };
      }
      return { verdict: "oui", family: "piste active", reason: `piste ${context.leadStatus ?? "active"}` };
    }

    // --- E7. Contact Salesforce sans affaire : ni client actif, ni inconnu.
    //     Un domaine de métier tranche vers l'exclusion ; sinon on ne conclut pas.
    case "contact":
      if (TRADE_DOMAIN.test(email)) {
        return {
          verdict: "non",
          family: "artisan / partenaire",
          reason: "contact connu, domaine de métier, aucune affaire en cours",
        };
      }
      if (OPERATIONS.test(text) || COMPLIANCE_DOC.test(text)) {
        return {
          verdict: "non",
          family: "sujet d'exécution",
          reason: "contact sans affaire, sujet d'exécution ou de conformité",
        };
      }
      return {
        verdict: "incertain",
        family: "contact sans affaire",
        reason: "contact connu de Salesforce, sans affaire rattachée",
      };

    case "ambigu":
      return {
        verdict: "incertain",
        family: "rattachement ambigu",
        reason: "plusieurs affaires possibles, aucune ne se détache",
      };

    // --- E8. Aucune entité Salesforce. Le domaine devient le seul indice.
    default: {
      // Un expéditeur inconnu qui parle règlement, chantier ou conformité n'est
      // pas un prospect : c'est un intervenant. Le sujet suffit ici parce
      // qu'aucune affaire ne vient le contredire.
      if (OPERATIONS.test(text) || COMPLIANCE_DOC.test(text)) {
        return {
          verdict: "non",
          family: "sujet d'exécution",
          reason: "sujet d'exécution ou de conformité, expéditeur inconnu de Salesforce",
        };
      }
      if (TRADE_DOMAIN.test(email)) {
        return {
          verdict: "non",
          family: "artisan / fournisseur / partenaire",
          reason: "domaine de métier du bâtiment, inconnu de Salesforce",
        };
      }
      if (domain && !CONSUMER_DOMAIN.test(email)) {
        return {
          verdict: "incertain",
          family: "entreprise inconnue",
          reason: "adresse d'entreprise inconnue de Salesforce",
        };
      }
      // Particulier inconnu : ce peut être un vrai prospect que le CRM ignore
      // encore. On ne l'exclut pas, on ne l'affirme pas non plus.
      return {
        verdict: "incertain",
        family: "particulier inconnu",
        reason: "particulier absent de Salesforce",
      };
    }
  }
}

/**
 * Accusés de réception et remerciements (C14 §16).
 *
 * Même sur une affaire ouverte, tous les messages ne méritent pas une action :
 * « bien reçu, merci » n'appelle rien. Le motif est délibérément court et exige
 * que le message soit ENTIÈREMENT de cette nature — un remerciement suivi d'une
 * question reste une action.
 */
const ACKNOWLEDGEMENT =
  /^(re\s*:\s*)?(merci|bien recu|bien note|parfait|tres bien|ok|d'accord|noté|entendu|c'est note)[\s.!,]*$/;

export function isPureAcknowledgement(subject: string | null, summary: string | null): boolean {
  const s = norm(subject);
  const body = norm(summary);
  if (!body) return ACKNOWLEDGEMENT.test(s);
  // Le résumé porte l'essentiel : s'il ne contient ni demande ni question, et
  // qu'il tient en un remerciement, il n'y a pas d'action.
  const hasAsk = /(pouvez|pourriez|merci de|j'attends|quand|comment|est-ce que|\?)/.test(body);
  return !hasAsk && ACKNOWLEDGEMENT.test(body);
}

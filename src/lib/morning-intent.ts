/**
 * Intention commerciale d'un message éligible (C15, étage B').
 *
 * CE QUE C15 CORRIGE. L'étage d'intention historique cherchait une TONALITÉ : un
 * client enthousiaste, une volonté affichée d'avancer. Il manquait donc les
 * demandes formulées platement — « Demande de devis », « Planning prévisionnel »,
 * « Client demande une estimation » — qui sont pourtant les plus fréquentes et
 * souvent les plus importantes. Six vraies demandes de clients du pipe, dont une
 * à 123 k€ et une à 138 k€, tombaient en « aucune intention identifiable ».
 *
 * On distingue donc explicitement :
 *
 *     ce message a-t-il un ton chaud ?      ← ancienne question, insuffisante
 *     ce message exige-t-il une action ?    ← la bonne question
 *
 * « Pouvez-vous m'envoyer le devis ? » n'a aucun vocabulaire émotionnel et
 * appelle une action immédiate. « Merci beaucoup, très bonne journée » est
 * chaleureux et n'appelle rien.
 *
 * DÉTECTION STRUCTURÉE, PAS PAR MOT-CLÉ. Un objet — devis, planning, rendez-vous —
 * ne compte que s'il suit une FORME DE DEMANDE, dans une fenêtre courte. « Votre
 * devis a bien été reçu, merci » contient « devis » sans rien demander ; « Client
 * reçoit le devis, demande du temps pour l'examiner » contient « demande » et
 * « devis » sans demander de devis. Les deux sont correctement écartés.
 *
 * Cet étage s'exécute APRÈS le filtre d'éligibilité C14 : il peut donc faire
 * confiance au fait que l'expéditeur est un prospect ou un client actif, et se
 * concentrer sur ce qu'il demande. Aucune dépendance : testable tel quel.
 */

export type Intent =
  /** Le client demande explicitement quelque chose à Renovation Man. */
  | "action_required"
  /** Le client manifeste une volonté de progresser. */
  | "wants_to_advance"
  /** Le client attend une réponse ou une action de notre part. */
  | "waiting_for_rm"
  /** Accord, validation, décision, ou élément très proche d'une signature. */
  | "decisive_signal"
  /** Remerciement ou accusé de réception, sans demande. */
  | "acknowledgement_only"
  /** Aucun signal commercial exploitable. */
  | "neutral";

export type IntentResult = {
  intent: Intent;
  /** Ce que le client demande, en français, pour la colonne de lecture. */
  label: string | null;
  /** Comment l'intention a été établie. Sert au diagnostic, jamais à l'écran. */
  evidence: string;
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
 * Ce que le client peut demander. Chaque entrée porte le libellé lisible qui
 * apparaîtra dans Morning : c'est la même liste qui sert à détecter et à dire.
 */
const OBJECTS: { pattern: RegExp; label: string }[] = [
  { pattern: /devis/, label: "le devis" },
  { pattern: /estimation|chiffrage|budget|prix|tarif|montant/, label: "une estimation" },
  { pattern: /planning|calendrier|delai|echeancier|date de demarrage/, label: "un planning" },
  { pattern: /rendez-?vous|\brdv\b|visite|creneau|disponibilit|passage/, label: "un rendez-vous" },
  { pattern: /rappel|rappeler|telephone|appel/, label: "un rappel" },
  { pattern: /document|attestation|justificatif|plan\b|contrat|facture/, label: "un document" },
  { pattern: /modification|correction|corriger|modifier|ajuster|revoir|reviser/, label: "une modification" },
  { pattern: /precision|detail|information|renseignement|explication|confirmation/, label: "une précision" },
  { pattern: /reponse|retour|nouvelles|suite/, label: "une réponse" },
];

/**
 * Formes de demande. Le point d'interrogation n'y figure pas : il est traité
 * séparément, parce qu'une question a besoin d'un mot interrogatif pour ne pas
 * confondre « Votre devis est disponible ! » avec une demande.
 */
const REQUEST_FORM =
  /(pouvez-?vous|pourriez-?vous|peux-?tu|serait-?il possible|est-?il possible|auriez-?vous|avez-?vous|merci de (?:bien vouloir )?|merci d'|je (?:souhaite|souhaiterais|voudrais|aimerais|attends|demande)|nous (?:souhaitons|souhaiterions|voudrions|aimerions|attendons)|j'aimerais|demande (?:de |d'|du |des |une |un |le |la )?|en attente (?:de |d'|du )|dans l'attente (?:de |d'|du )|besoin (?:de |d'|du )|il (?:me |nous )?faudrait|quand|quel(?:le|s|les)?|comment|combien|ou est-ce|est-ce que)/;

/** Marqueurs de réception : ils neutralisent l'objet qui les accompagne. */
const RECEIVED =
  /(bien (?:ete |été )?re[cç]u(?:e|s|es)?|j'ai (?:bien )?re[cç]u|nous avons (?:bien )?re[cç]u|accuse reception|est disponible|a ete transmis|transmis|ci-joint|veuillez trouver|vous trouverez|merci pour (?:le |la |votre |vos ))/;

/** Remerciement pur, sans rien demander. */
const THANKS_ONLY =
  /^(re\s*:\s*)?(merci|grand merci|merci beaucoup|bien recu|bien note|parfait|tres bien|ok|d'accord|entendu|c'est note|bonne journee|bonne reception)[\s.!,·-]*$/;

/** Volonté explicite d'avancer. */
const ADVANCING =
  /(nous souhaitons avancer|je souhaite avancer|on avance|comment (?:avancons|on avance|procede|proceder|faire pour)|prochaine etape|on y va|c'est bon pour (?:moi|nous)|ca me va|ca nous va|ca convient|le devis (?:me|nous) convient|nous sommes d'accord|je suis d'accord|feu vert|lancer les travaux|demarrer)/;

/** Décision, validation, engagement. */
const DECISIVE =
  /(bon pour accord|je valide|nous validons|je signe|nous signons|pret a signer|lien de signature|acompte|je vous retiens|nous vous retenons|c'est signe|promesse signee)/;

/** Le client dit attendre, ou relance. */
const WAITING =
  /(relance|je vous relance|je me permets de vous relancer|sans reponse|pas eu de reponse|toujours pas|des nouvelles|du nouveau|j'attends|nous attendons|en attente de votre|toujours sans|deuxieme relance|2eme relance|reste (?:en attente|sans reponse))/;

/**
 * Une difficulté soulevée par le client, qui appelle une réponse de notre part.
 *
 * Distinct d'une hésitation : « je réfléchis » n'attend rien de nous, « j'ai un
 * problème qui impacte mon projet » si.
 */
const RAISES_ISSUE =
  /(problematique|probleme|difficulte|souci|blocage|imprevu|complication|contrainte|obstacle|impacte (?:son|le|mon|notre) projet|remet en cause)/;

/** Le client demande du temps, ou diffère : il n'attend rien de nous. */
const ASKS_FOR_TIME =
  /(demande du temps|prendre le temps|besoin de temps|je reflechis|nous reflechissons|reflexion|examiner|etudier (?:le|la|votre)|revenir vers vous|je reviens vers vous)/;

/** Cherche un objet dans la fenêtre qui suit une forme de demande. */
function objectAfterRequest(text: string): { label: string; evidence: string } | null {
  const form = new RegExp(REQUEST_FORM.source, "g");
  let m: RegExpExecArray | null;
  while ((m = form.exec(text)) != null) {
    // Fenêtre courte et volontairement asymétrique : l'objet suit la demande.
    // Sans cette contrainte, « reçoit le devis, demande du temps » compterait
    // comme une demande de devis.
    const window = text.slice(m.index + m[0].length, m.index + m[0].length + 45);
    for (const o of OBJECTS) {
      if (o.pattern.test(window)) {
        return { label: o.label, evidence: `« ${m[0].trim()} » suivi de ${o.label}` };
      }
    }
  }
  return null;
}

/** Question directe : un mot interrogatif et un point d'interrogation. */
function isDirectQuestion(text: string): boolean {
  if (!text.includes("?")) return false;
  return /(pouvez-?vous|pourriez-?vous|quand|quel|comment|combien|est-ce que|serait-il|auriez-vous|avez-vous|ou en)/.test(
    text,
  );
}

export function detectIntent(input: {
  subject: string | null;
  summary: string | null;
  /** Classification produite par le modèle. Sert d'appoint, jamais d'arbitre. */
  signalType?: string | null;
  /** Vrai quand l'expéditeur porte une affaire ouverte du pipe. */
  onActiveDeal?: boolean;
}): IntentResult {
  const subject = norm(input.subject);
  const summary = norm(input.summary);
  const text = `${subject} ${summary}`.trim();

  // --- Remerciement pur : ni sujet ni résumé ne portent autre chose.
  if ((THANKS_ONLY.test(subject) || !subject) && THANKS_ONLY.test(summary)) {
    return { intent: "acknowledgement_only", label: null, evidence: "remerciement seul" };
  }

  // --- Accusé de réception : le client dit avoir reçu, et ne demande rien.
  //     Vérifié AVANT la recherche de demande, parce que « votre devis a bien
  //     été reçu, merci » ne contient aucune forme de demande et tomberait
  //     sinon en « neutre » — juste dans le résultat, imprécis dans la raison.
  if (RECEIVED.test(text) && !REQUEST_FORM.test(text) && !isDirectQuestion(text)) {
    return { intent: "acknowledgement_only", label: null, evidence: "accuse réception, sans demande" };
  }

  // --- Décision ou engagement : le signal le plus fort.
  if (DECISIVE.test(text) || input.signalType === "signature") {
    return {
      intent: "decisive_signal",
      label: null,
      evidence: DECISIVE.test(text) ? "formulation d'engagement" : "classé signature",
    };
  }

  // --- Demande explicite. Prioritaire sur la tonalité : c'est tout l'objet de
  //     C15. Une demande claire ne doit pas dépendre d'une interprétation.
  const asked = objectAfterRequest(text);
  if (asked) {
    // Une réception qui neutralise TOUT le message : « votre devis a bien été
    // reçu, merci » n'appelle rien. Mais « bien reçu, pouvez-vous corriger ? »
    // reste une demande — d'où la vérification que la demande n'est pas seule.
    if (RECEIVED.test(text) && !isDirectQuestion(text) && !/pouvez|pourriez|merci de|besoin|il (?:me |nous )?faudrait|je (?:souhaite|voudrais|aimerais)/.test(text)) {
      return {
        intent: "acknowledgement_only",
        label: null,
        evidence: "objet mentionné mais reçu, aucune demande",
      };
    }
    return { intent: "action_required", label: asked.label, evidence: asked.evidence };
  }

  if (isDirectQuestion(text)) {
    return { intent: "action_required", label: "une réponse", evidence: "question directe" };
  }

  // --- Volonté d'avancer.
  if (ADVANCING.test(text)) {
    return { intent: "wants_to_advance", label: null, evidence: "volonté d'avancer explicite" };
  }

  // --- Relance ou attente déclarée.
  if (WAITING.test(text)) {
    return { intent: "waiting_for_rm", label: "une réponse", evidence: "relance ou attente déclarée" };
  }

  // --- Difficulté soulevée sur une affaire active : elle appelle une réponse
  //     commerciale. Un client qui demande seulement du temps, non : il ne nous
  //     attend pas, et l'annoncer comme tel serait faux à l'écran.
  if (input.onActiveDeal && RAISES_ISSUE.test(text) && !ASKS_FOR_TIME.test(text)) {
    return {
      intent: "waiting_for_rm",
      label: null,
      evidence: "difficulté soulevée sur une affaire ouverte",
    };
  }

  return { intent: "neutral", label: null, evidence: "aucune demande ni volonté identifiable" };
}

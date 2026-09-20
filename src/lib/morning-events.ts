/**
 * Morning V2 — triage des signaux mail en événements Morning.
 *
 * Ce fichier ne parle jamais à Gmail : la synchronisation existante écrit dans
 * `mail_signal`, et Morning se contente de trier ce qui y est déjà. Aucune
 * écriture Gmail, aucun corps de message stocké en plus.
 *
 * DEUX ÉTATS DISTINCTS, et c'est le cœur du besoin :
 *
 *   — le curseur de SYNCHRONISATION Gmail avance tout seul, fenêtre après
 *     fenêtre, sans trou (`mail_sync.window_start` = fenêtre précédente) ;
 *   — l'état de PRISE EN COMPTE est propre à RM Morning et porte sur un
 *     MESSAGE, pas sur un client. Le lu/non-lu de Gmail ne dit rien du travail
 *     commercial, et acquitter un client entier ferait perdre son message
 *     suivant.
 *
 * Conséquence voulue : un message acquitté ne revient jamais ; un nouveau
 * message du même client revient toujours.
 */

import { parisDate } from "./business-time";
import { getDb } from "./db";
import { INTERNAL_DOMAIN } from "./mail-rules";
import {
  evaluateEligibility,
  isPureAcknowledgement,
  type EligibilityContext,
} from "./morning-eligibility";
import { detectIntent } from "./morning-intent";
import { clientLabel } from "./vocabulary";
import { matchTeamMember } from "./normalize";

export type { MorningCategory, MorningEvent } from "./morning-types";
import type { MorningCategory, MorningEvent } from "./morning-types";

type SignalRow = {
  gmail_message_id: string;
  thread_id: string;
  sent_at: string | null;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  direction: string | null;
  opportunity_id: string | null;
  match_level: string | null;
  match_kind: string | null;
  lead_id: string | null;
  salesperson: string | null;
  lead_name: string | null;
  lead_owner: string | null;
  lead_status: string | null;
  contact_name: string | null;
  ext_name: string | null;
  ext_stage: string | null;
  ext_amount: number | null;
  ext_owner: string | null;
  /** Destinataires RM (D), JSON brut. Absent = ligne antérieure à cette donnée. */
  rm_to?: string | null;
  rm_cc?: string | null;
  signal_type: string;
  blocker: string | null;
  summary: string | null;
  quote: string | null;
  classifier: string | null;
  client: string | null;
  owner: string | null;
  gmv: number | null;
  stage: string | null;
  is_terminal: number | null;
  status: string | null;
  acknowledged_at: string | null;
  first_seen_at: string | null;
  category: string;
  reason: string | null;
};

/** Normalisation partagée avec le moteur de jalons, insécables comprises. */
function norm(value: string | null): string {
  return (value ?? "")
    .replace(/[  ]/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// --- Reconnaissance -------------------------------------------------------

/**
 * Notifications de plateforme et messages de service. Ce sont les faux positifs
 * les plus nombreux : sans ce filtre, « Vous avez un nouveau lead » remonterait
 * en tête du Morning tous les matins.
 */
const AUTOMATED =
  /vous avez un nouveau lead|notification automatique|ne pas repondre|no-?reply|newsletter|se desinscrire|votre mot de passe|creneau de rappel automatique|trustpilot|avis client/;

/** Le client relance, ou dit explicitement attendre. */
const WAITING =
  /relance|je vous relance|je me permets de vous relancer|sans reponse|pas eu de reponse|toujours pas|des nouvelles|du nouveau|avez-vous recu|auriez-vous|pourriez-vous m'envoyer|dans l'attente|j'attends|nous attendons|en attente de votre|pouvez-vous me rappeler|merci de me rappeler|deuxieme relance|2eme relance/;

/**
 * Le client propose un créneau et attend que RM confirme lequel (F, W6) :
 * « dites-moi ce qui vous convient » ne contient ni point d'interrogation ni
 * verbe de demande classique, mais RM doit répondre pour que le rendez-vous
 * se cale.
 */
const PROPOSES_SLOT =
  /(?:dites-moi|indiquez-moi|confirmez-moi|precisez-moi|faites-moi savoir)[^.?!]{0,40}(?:convient|arrange|preferez|choix)/;

/** Le client demande un document ou une correction pour pouvoir avancer. */
const NEEDS =
  /document|attestation|justificatif|devis (corrige|modifie|actualise)|corriger|correction|modifier|modification|ajuster|ajustement|rectifier|preciser/;

/**
 * Simple transmission, sans rien demander (F) : « voici », pièce jointe,
 * document déjà signé/disponible. Neutralise `NEEDS` quand ce dernier n'a
 * accroché qu'un nom de pièce mentionné en passant — jamais une vraie
 * demande, qui aurait de toute façon déjà été attrapée plus haut par
 * `detectIntent` ou par `WAITING`.
 */
const DELIVERY =
  /voici (?:le|la|les)|ci-joint|veuillez trouver|vous trouverez|je vous transmets|je vous envoie|en piece jointe|(?:document|devis|contrat) (?:est |a ete )?(?:signe|disponible|transmis)/;

/**
 * Le client exprime une volonté d'avancer.
 *
 * « convient » est volontairement restreint à SON propre accord (le devis, la
 * proposition, le budget... lui convient) : la forme nue laissait « dites-moi
 * ce qui VOUS convient » — une simple proposition de créneau — se faire
 * passer pour un accord commercial (F, W6).
 *
 * « signature » (nom nu) a été RETIRÉ (post-RC, audit production) : le mot
 * seul apparaît aussi bien dans un résumé négatif ou neutre (« échange sans
 * effet clair sur la signature ») que dans un signal positif, et faisait
 * remonter en chaud/attente des messages sans aucun rapport. Les formes
 * verbales (signer, signions…) restent, moins ambiguës ; « lien de
 * signature » reste couvert par `DECISIVE` (morning-intent.ts).
 */
const ADVANCING =
  /comment (avancons|on avance|procede|proceder|faire pour)|prochaine etape|on y va|c'est bon pour (moi|nous)|nous souhaitons avancer|je souhaite avancer|valider|validation|\bsign(?:er|ions|iez|ons|ez|erai\w*|eras\w*|era\b|erons|erez|eront)\b|bon pour accord|d'accord pour|(?:ca|le devis|la proposition|l'offre|le budget) (?:me |nous )?convient|ca me va|ca nous va|fixer un rendez-vous|prendre rendez-vous|caler un (rdv|rendez-vous)|disponible pour|reglement|paiement|acompte|contrat|quand[^.?!]{0,20}(?:demarrer|commencer)/;

/** Interlocuteurs qui ne sont pas le client final. */
const NOT_CLIENT = /artisan|fournisseur|partenaire|comptable|assurance|banque(?!.*client)/;

type Triage = { category: MorningCategory; reason: string; ignoredBecause: string | null };

/**
 * Le blocage, rendu lisible.
 *
 * Le classifieur produit le plus souvent une formule française, mais il lui
 * arrive de renvoyer un identifiant technique (`planning_a_confirmer`). On ne
 * maintient pas une table de correspondance qui vieillirait : on remet les
 * espaces et on met la première lettre en minuscule, ce qui traite aussi les
 * codes futurs.
 */
function readableBlocker(blocker: string | null): string | null {
  const v = (blocker ?? "").trim();
  if (!v) return null;
  const spaced = v.includes("_") ? v.replace(/_+/g, " ") : v;
  return spaced.charAt(0).toLowerCase() + spaced.slice(1);
}

/**
 * Triage d'un signal mail vers un bloc Morning.
 *
 * On s'appuie sur la classification déjà produite (`signal_type`) et sur le
 * résumé court, jamais sur le corps du message. La règle « attend une réponse »
 * est ajoutée ici : elle n'existait pas dans la taxonomie du Passage B, qui
 * mesurait l'intention commerciale et non l'attente.
 */
type TriageRow = {
  direction: string | null;
  subject: string | null;
  summary: string | null;
  blocker: string | null;
  /** Contexte C13. Absent lors d'un appel historique : le triage reste alors seul juge. */
  from_email?: string | null;
  match_kind?: string | null;
  opportunity_stage?: string | null;
  lead_status?: string | null;
  /** Étape et caractère terminal de l'affaire rattachée, quand elle existe. */
  stage?: string | null;
  is_terminal?: number | null;
  signal_type: string;
  /**
   * Propriétaires Salesforce bruts (E) — un seul est pertinent, choisi selon
   * `match_kind`. Non normalisés : `eligibilityOf` les fait passer par
   * `matchTeamMember` avant de les comparer à un nom d'équipe.
   */
  owner?: string | null;
  ext_owner?: string | null;
  lead_owner?: string | null;
  /** Destinataires RM (D), JSON brut tel que persisté dans `mail_signal`. */
  rm_to?: string | null;
  rm_cc?: string | null;
};

/**
 * Triage d'un message vers un bloc Morning.
 *
 * DEUX ÉTAGES depuis C14 : d'abord l'appartenance au périmètre commercial, puis
 * seulement l'intention. Un excellent classifieur de tonalité ne doit pas pouvoir
 * transformer un fournisseur pressé en client motivé.
 */
export function triage(row: TriageRow): Triage {
  const verdict = eligibilityOf(row);
  const result = classify(row, verdict);
  // Un interlocuteur non qualifié ne peut jamais être annoncé comme « client
  // chaud » : ce serait affirmer une motivation commerciale chez quelqu'un dont
  // on ignore s'il est client. Il reste visible comme client qui attend — un
  // fait vérifiable : il a écrit, nous n'avons pas répondu.
  if (verdict.verdict === "incertain" && result.category === "chaud") {
    return { ...result, category: "attente" };
  }
  return result;
}

/**
 * Propriétaire Salesforce de ce que le message désigne, normalisé sur le nom
 * d'équipe canonique — le même que celui de `TEAM_MAILBOXES` — pour être
 * comparable à un membre RM. Un seul champ est pertinent selon `match_kind` :
 * jamais `salesperson` (E), qui n'est qu'une approximation de rattachement.
 */
function dealOwnerOf(row: TriageRow): string | null {
  const raw =
    row.match_kind === "affaire_pipe"
      ? row.owner
      : row.match_kind === "affaire_hors_pipe" || row.match_kind === "affaire_fermee"
        ? row.ext_owner
        : row.match_kind === "piste"
          ? row.lead_owner
          : null;
  return raw ? (matchTeamMember(raw)?.name ?? null) : null;
}

/** Liste de noms d'équipe persistée en JSON (D). `null` = donnée absente, jamais « vide ». */
function parseTeamNames(json: string | null | undefined): string[] | null {
  if (json == null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function eligibilityOf(row: TriageRow) {
  return evaluateEligibility(
    { fromEmail: row.from_email ?? null, subject: row.subject, summary: row.summary },
    {
      matchKind: (row.match_kind ?? null) as EligibilityContext["matchKind"],
      externalStage: row.opportunity_stage ?? null,
      leadStatus: row.lead_status ?? null,
      dealStage: row.stage ?? null,
      dealIsTerminal: row.is_terminal === 1,
      direction: row.direction,
      ownerName: dealOwnerOf(row),
      rmTo: parseTeamNames(row.rm_to),
      rmCc: parseTeamNames(row.rm_cc),
    },
    INTERNAL_DOMAIN,
  );
}

function classify(row: TriageRow, eligibility: ReturnType<typeof eligibilityOf>): Triage {
  const text = `${norm(row.subject)} ${norm(row.summary)}`;

  if (row.direction !== "entrant") {
    return {
      category: "ignore",
      reason: "",
      ignoredBecause: row.direction === "interne" ? "échange interne" : "message sortant",
    };
  }
  if (AUTOMATED.test(text)) {
    return { category: "ignore", reason: "", ignoredBecause: "message automatique" };
  }

  // --- ÉTAGE A (C14). Le périmètre AVANT l'intention.
  //
  // Placé ici, après les notifications automatiques et avant toute lecture de
  // tonalité : un fournisseur qui écrit « urgent, il faut valider » coche tous
  // les signaux d'un client motivé, et seule une exclusion structurelle peut
  // l'arrêter. Le contexte vient de C13 — affaire close, chantier signé, piste
  // abandonnée sont des faits Salesforce, pas des impressions de lecture.
  if (eligibility.verdict === "non") {
    return { category: "hors_perimetre", reason: "", ignoredBecause: eligibility.reason };
  }
  // « Incertain » ne disparaît pas : il reste candidat, mais ne pourra jamais
  // devenir « chaud ». Un doute vaut mieux qu'un faux client motivé.

  // Un accusé de réception n'appelle aucune action, même sur une affaire ouverte.
  if (isPureAcknowledgement(row.subject, row.summary)) {
    return { category: "ignore", reason: "", ignoredBecause: "accusé de réception, sans demande" };
  }

  if (NOT_CLIENT.test(text) && !ADVANCING.test(text)) {
    return { category: "ignore", reason: "", ignoredBecause: "interlocuteur non client" };
  }
  if (row.signal_type === "negatif") {
    return { category: "ignore", reason: "", ignoredBecause: "le client ne donne pas suite" };
  }

  // --- Hiérarchie produit (F, priorité chaud > attente).
  //
  // Un engagement commercial FORT est l'information la plus importante d'un
  // message, même quand ce même message contient aussi une demande : « le
  // devis nous convient, pourriez-vous m'envoyer le lien pour signer ? » doit
  // se lire comme un accord qui appelle une accélération, pas comme une
  // simple relance. C'est pourquoi ces trois signaux — les plus déterministes
  // de l'engagement — sont désormais vérifiés AVANT `WAITING`.
  //
  // Ordre choisi pour limiter le risque de régression : `WAITING` reste
  // vérifié avant tout le reste (accusé de réception mis à part), donc une
  // relance qui ne porte AUCUN signal d'engagement continue de primer sur une
  // demande formulée platement, exactement comme avant F.
  if (row.signal_type === "signature") {
    return { category: "chaud", reason: "Prêt à signer ou dernière étape avant signature", ignoredBecause: null };
  }
  if (row.signal_type === "positif_bloque") {
    const blocker = readableBlocker(row.blocker);
    if (NEEDS.test(text)) {
      return {
        category: "chaud",
        reason: blocker
          ? `Souhaite avancer, demande une modification — ${blocker}`
          : "Souhaite avancer, demande une modification précise",
        ignoredBecause: null,
      };
    }
    return {
      category: "chaud",
      reason: blocker ? `Souhaite avancer — ${blocker}` : "Souhaite avancer",
      ignoredBecause: null,
    };
  }
  if (ADVANCING.test(text)) {
    return { category: "chaud", reason: "Souhaite avancer", ignoredBecause: null };
  }

  // Un client qui relance passe devant : il attend une réponse, et c'est plus
  // urgent qu'une intention d'avancer déjà entendue — SAUF si un engagement
  // fort vient d'être détecté ci-dessus, auquel cas on ne redescend jamais.
  if (WAITING.test(text)) {
    return {
      category: "attente",
      reason: NEEDS.test(text) ? "Relance et attend un document ou une correction" : "Relance, sans réponse de notre côté",
      ignoredBecause: null,
    };
  }
  if (PROPOSES_SLOT.test(text)) {
    return { category: "attente", reason: "Propose un créneau, attend une confirmation", ignoredBecause: null };
  }

  // --- ÉTAGE B' (C15). La demande, avant l'abandon.
  //
  // Placé ici, après les règles de tonalité et AVANT le rejet final : les
  // motifs ci-dessus attrapent les messages chauds, celui-ci rattrape les
  // demandes formulées platement. « Demande de devis », « Planning
  // prévisionnel », « Client demande une estimation » n'ont aucun vocabulaire
  // émotionnel et sont pourtant les demandes les plus fréquentes.
  //
  // La détection est structurée, jamais par mot-clé isolé : l'objet doit suivre
  // une forme de demande. C'est ce qui distingue « pouvez-vous envoyer le
  // devis » de « votre devis a bien été reçu ».
  const intent = detectIntent({
    subject: row.subject,
    summary: row.summary,
    signalType: row.signal_type,
    onActiveDeal: row.match_kind === "affaire_pipe",
  });
  if (intent.intent === "acknowledgement_only") {
    return { category: "ignore", reason: "", ignoredBecause: "accusé de réception, sans demande" };
  }
  if (intent.intent === "action_required") {
    // Le client demande quelque chose : c'est nous qu'il attend.
    return {
      category: "attente",
      reason: intent.label ? `Demande ${intent.label}` : "Demande une action de notre part",
      ignoredBecause: null,
    };
  }
  if (intent.intent === "waiting_for_rm") {
    return {
      category: "attente",
      reason: "Signale une difficulté qui appelle une réponse",
      ignoredBecause: null,
    };
  }
  if (intent.intent === "wants_to_advance") {
    return { category: "chaud", reason: "Souhaite avancer", ignoredBecause: null };
  }

  // Dernier filet, jamais sur une simple transmission (F, W7) : « voici le
  // document signé » contient « document » sans rien demander, et aurait déjà
  // été attrapé plus haut par `detectIntent` si une vraie demande existait.
  if (NEEDS.test(text) && !DELIVERY.test(text)) {
    return { category: "attente", reason: "Attend un document ou une correction", ignoredBecause: null };
  }
  if (row.signal_type === "risque") {
    return { category: "ignore", reason: "", ignoredBecause: "signal de risque, sans demande explicite" };
  }
  return { category: "ignore", reason: "", ignoredBecause: "aucune intention identifiable" };
}

// --- Ce que dit le client ---------------------------------------------------

/** Les résumés des règles sont des gabarits : ils ne disent rien de ce client-là. */
const RULES_CLASSIFIER = /^rules/;

/** Ce qu'on écrit quand le message a été relu et qu'aucune phrase ne prouve un intérêt. */
export const NO_PROOF = "Pas de preuve d'intérêt explicite dans le dernier message";

/**
 * « (attend : …) » — ce que le client attend, déduit du motif du triage.
 * Court, sans verbe redondant, jamais un code.
 */
export function expectationOf(reason: string | null): string | null {
  const r = (reason ?? "").trim();
  if (!r) return null;
  let m: RegExpExecArray | null;
  if ((m = /^Demande (.+)$/i.exec(r))) return `attend : ${m[1]}`;
  if ((m = /^Attend (.+)$/i.exec(r))) return `attend : ${m[1]}`;
  if (/^Relance/i.test(r)) return "attend : une réponse";
  if (/signer|signature/i.test(r)) return "attend : la signature";
  if ((m = /^Souhaite avancer(?:, demande une modification[^—]*)?(?: — (.+))?$/i.exec(r))) {
    return m[1] ? `attend : ${m[1]}` : "attend : la prochaine étape";
  }
  return "attend : une réponse";
}

/**
 * Compose la colonne « Preuve d'intérêt ».
 *
 * Trois états, et ils ne se confondent pas :
 *   — citation      : le message a été relu et une phrase prouve l'intérêt ;
 *   — aucune        : le message a été relu (quote = chaîne vide) et rien ne
 *                     prouve un intérêt explicite — on le dit, on n'invente pas ;
 *   — non analysé   : message antérieur à la citation (quote = null), rattrapé
 *                     à la prochaine synchronisation ; en attendant, le résumé
 *                     fidèle du modèle, sinon le motif du triage.
 */
export function whatClientSays(row: {
  reason: string | null;
  quote: string | null;
  summary: string | null;
  classifier: string | null;
}): { said: string; expects: string | null; quote: string | null; proof: "citation" | "aucune" | "non_analyse" } {
  const reason = (row.reason ?? "").trim();
  const expects = expectationOf(reason);

  if (row.quote != null) {
    const quote = row.quote.trim();
    if (quote) return { said: `« ${quote} »`, expects, quote, proof: "citation" };
    return { said: NO_PROOF, expects, quote: null, proof: "aucune" };
  }

  const summary = (row.summary ?? "").trim();
  const fromModel = summary && row.classifier && !RULES_CLASSIFIER.test(row.classifier);
  if (fromModel && summary.toLowerCase() !== reason.toLowerCase()) {
    return { said: summary, expects, quote: null, proof: "non_analyse" };
  }
  return { said: reason, expects: null, quote: null, proof: "non_analyse" };
}

/**
 * Fils des événements Morning encore ouverts dont on n'a pas la phrase du
 * client. Sert au rattrapage à la synchronisation Gmail : le message est relu
 * (métadonnées et extrait, comme toujours) et sa phrase parlante extraite par
 * les règles, sans appel au modèle.
 */
export function threadsNeedingQuote(limit = 80): string[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT DISTINCT m.thread_id
           FROM morning_event e
           JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
          WHERE e.status <> 'pris_en_compte'
            AND e.category IN ('chaud', 'attente')
            AND m.direction = 'entrant'
            AND m.quote IS NULL
          ORDER BY e.sent_at DESC
          LIMIT ?`,
      )
      .all(limit) as { thread_id: string }[]
  ).map((r) => r.thread_id);
}

// --- Persistance ----------------------------------------------------------

/**
 * Recalcule les événements Morning depuis `mail_signal` et les persiste.
 *
 * Idempotent : l'état de prise en compte déjà enregistré n'est jamais écrasé.
 * Le triage, lui, est recalculé — si la règle s'améliore, un message écarté à
 * tort réapparaît, ce qui est le comportement souhaitable.
 */
export function syncMorningEvents(now = new Date()): { seen: number; created: number } {
  const db = getDb();
  const rows = db
    .prepare(
      // Le contexte C13 est joint ici : sans lui, l'étage d'éligibilité n'aurait
      // aucun fait Salesforce sur lequel s'appuyer et retomberait sur des
      // heuristiques de domaine.
      `SELECT m.gmail_message_id, m.thread_id, m.sent_at, m.direction, m.subject, m.summary,
              m.blocker, m.signal_type, m.from_email, m.match_kind, m.opportunity_id,
              m.rm_to, m.rm_cc,
              d.opportunity_stage, d.lead_status, d.opportunity_owner AS ext_owner, d.lead_owner,
              o.stage, o.is_terminal, o.owner
         FROM mail_signal m
         LEFT JOIN mail_directory d ON d.email = lower(m.from_email)
         LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id`,
    )
    .all() as SignalRow[];

  const insert = db.prepare(
    `INSERT INTO morning_event
       (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level,
        status, acknowledged_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)
     ON CONFLICT(gmail_message_id) DO UPDATE SET category = excluded.category, reason = excluded.reason`,
  );

  let created = 0;
  const existing = new Set(
    (db.prepare("SELECT gmail_message_id FROM morning_event").all() as { gmail_message_id: string }[]).map(
      (r) => r.gmail_message_id,
    ),
  );
  const iso = now.toISOString();
  for (const r of rows) {
    const t = triage(r);
    if (!existing.has(r.gmail_message_id)) created += 1;
    insert.run(
      r.gmail_message_id,
      r.thread_id,
      r.sent_at,
      t.category,
      t.category === "chaud" || t.category === "attente" ? t.reason : (t.ignoredBecause ?? "écarté"),
      iso,
    );
  }
  return { seen: rows.length, created };
}

/**
 * « Tout marquer comme lu » : acquitte d'un coup tous les messages encore
 * ouverts d'un bloc, ou des deux. La liste est RECALCULÉE ICI, jamais reçue du
 * navigateur — même règle que le « Tout lire » du Monitoring. Même écriture que
 * l'acquittement unitaire : un message déjà pris en compte n'est pas réécrit,
 * sa date d'acquittement d'origine est conservée.
 */
export function acknowledgeAllEvents(
  category: "chaud" | "attente" | null,
  now = new Date(),
): { changed: number; messageIds: string[] } {
  const db = getDb();
  const categories = category ? [category] : ["chaud", "attente"];
  const marks = categories.map(() => "?").join(", ");
  const messageIds = (
    db
      .prepare(
        `SELECT gmail_message_id FROM morning_event
          WHERE status <> 'pris_en_compte' AND category IN (${marks})`,
      )
      .all(...categories) as { gmail_message_id: string }[]
  ).map((r) => r.gmail_message_id);
  if (messageIds.length === 0) return { changed: 0, messageIds };
  const r = db
    .prepare(
      `UPDATE morning_event SET status = 'pris_en_compte', acknowledged_at = ?
        WHERE status <> 'pris_en_compte' AND category IN (${marks})`,
    )
    .run(now.toISOString(), ...categories);
  return { changed: Number(r.changes), messageIds };
}

/** Marque un message comme pris en compte. Porte sur ce message seul. */
export function acknowledgeEvent(messageId: string, now = new Date()): boolean {
  const db = getDb();
  const r = db
    .prepare(
      "UPDATE morning_event SET status = 'pris_en_compte', acknowledged_at = ? WHERE gmail_message_id = ? AND status <> 'pris_en_compte'",
    )
    .run(now.toISOString(), messageId);
  return Number(r.changes) > 0;
}

/**
 * Le plan du jour, coché.
 *
 * L'état porte sur une JOURNÉE, et c'est la seule différence avec « Pris en
 * compte » : un message acquitté ne revient jamais, alors qu'une action du plan
 * est reconstruite chaque matin depuis les données du jour. Une affaire décisive
 * traitée aujourd'hui doit pouvoir revenir demain si elle est toujours décisive
 * et toujours en attente — sinon RM Morning cesserait de la signaler pour la
 * seule raison qu'on l'a lue une fois.
 *
 * La clé est celle produite par `buildMorningPlan` (« decisive:006... »), stable
 * pour une même affaire et un même motif.
 */
export function markActionDone(actionKey: string, now = new Date()): boolean {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO morning_action_done (action_key, done_on, done_at) VALUES (?, ?, ?)
       ON CONFLICT(action_key, done_on) DO NOTHING`,
    )
    .run(actionKey, parisDate(now), now.toISOString());
  return Number(r.changes) > 0;
}

/**
 * « Tout traiter » du Plan : traite les situations que l'écran affiche, et
 * uniquement elles.
 *
 * `planned` est le Plan recalculé côté serveur ; `shownKeys` les clés que le
 * navigateur affichait au moment du geste. L'intersection garantit qu'aucune
 * situation qu'aucun œil n'a vue n'est marquée traitée — ni une huitième qui
 * aurait remplacé une situation entre-temps, ni une situation hors du Plan.
 * Sans `shownKeys` (appel ancien), le Plan recalculé est traité tel quel : il
 * est lui-même plafonné.
 *
 * Chaque situation suit le double effet de « action_faite » : traitée pour la
 * journée, message acquitté quand il y en a un.
 */
export function completeShownActions(
  planned: { key: string; messageId: string | null }[],
  shownKeys: ReadonlySet<string> | null,
  now = new Date(),
): number {
  let changed = 0;
  for (const a of planned) {
    if (shownKeys && !shownKeys.has(a.key)) continue;
    if (markActionDone(a.key, now)) changed += 1;
    if (a.messageId) acknowledgeEvent(a.messageId);
  }
  return changed;
}

/** Clés des actions déjà faites aujourd'hui. */
export function doneActionKeys(now = new Date()): Set<string> {
  const db = getDb();
  const rows = db
    .prepare("SELECT action_key FROM morning_action_done WHERE done_on = ?")
    .all(parisDate(now)) as { action_key: string }[];
  return new Set(rows.map((r) => r.action_key));
}

/**
 * Les événements à présenter ce matin.
 *
 * Tout ce qui n'est pas encore pris en compte remonte, quelle que soit la
 * date : ne pas avoir ouvert RM Morning hier ne doit pas faire perdre un
 * message. Il n'existe plus de notion de « lu / non lu » ici (H) — seulement
 * « à traiter / traité », portée par `acknowledged`.
 */
export function loadMorningEvents(): { events: MorningEvent[] } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.gmail_message_id, e.thread_id, e.sent_at, e.category, e.reason, e.status,
              e.acknowledged_at, e.first_seen_at,
              m.from_email, m.from_name, m.match_level, m.match_kind, m.lead_id,
              m.salesperson, m.opportunity_id, m.summary, m.quote, m.classifier,
              o.client_contact AS client, o.owner, o.gmv, o.stage, o.is_terminal,
              d.lead_name, d.lead_owner, d.lead_status, d.contact_name,
              d.opportunity_name AS ext_name, d.opportunity_stage AS ext_stage,
              d.opportunity_amount AS ext_amount, d.opportunity_owner AS ext_owner
         FROM morning_event e
         JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
         LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id
         LEFT JOIN mail_directory d ON d.email = lower(m.from_email)
        WHERE e.category IN ('chaud', 'attente')
        ORDER BY e.sent_at DESC`,
    )
    .all() as SignalRow[];

  const activeWaiting = activeWaitingMessageIds();
  const latestHot = latestHotMessageIds();

  const events = rows.map((r): MorningEvent => {
    const level = r.match_level ?? "C";
    const kind = (r.match_kind ?? (r.opportunity_id ? "affaire_pipe" : "inconnu")) as MorningEvent["matchKind"];
    // Le nom du client vient d'abord de l'affaire du pipe, puis de l'annuaire —
    // une piste ou un contact identifié vaut mieux qu'une adresse brute.
    // L'ordre va du plus précis au plus général : l'affaire du pipe, puis ce que
    // C13 a résolu, puis l'en-tête du message. Le repli final nomme le manque
    // plutôt que d'afficher une adresse technique ou une case vide.
    const client = clientLabel(
      r.client ?? r.lead_name ?? r.contact_name ?? r.ext_name ?? r.from_name ?? r.from_email,
    );
    const says = whatClientSays(r);
    return {
      messageId: r.gmail_message_id,
      threadId: r.thread_id,
      sentAt: r.sent_at,
      category: r.category as MorningCategory,
      reason: r.reason ?? "",
      said: says.said,
      expects: says.expects,
      quote: says.quote,
      ignoredBecause: null,
      client,
      fromEmail: r.from_email,
      // Le commercial vient de l'opportunité rattachée quand elle existe ; à
      // défaut de celui déduit par le rapprochement mail, et seulement s'il
      // appartient à l'équipe.
      salesperson:
        (r.owner ? matchTeamMember(r.owner)?.name : null) ??
        (r.ext_owner ? matchTeamMember(r.ext_owner)?.name : null) ??
        (r.lead_owner ? matchTeamMember(r.lead_owner)?.name : null) ??
        (r.salesperson ? matchTeamMember(r.salesperson)?.name : null) ??
        null,
      opportunityId: r.opportunity_id,
      leadId: r.lead_id ?? null,
      matchKind: kind,
      attachment: level === "A" ? "certain" : level === "B" ? "probable" : "a_verifier",
      // GMV du PIPE uniquement. Une affaire signée en chantier a bien un montant,
      // mais l'afficher ici ferait croire à du chiffre encore à aller chercher :
      // Morning répond à « où est l'argent à conquérir », pas « qu'avons-nous
      // déjà vendu ». Le montant hors pipe reste visible dans la situation.
      gmv: kind === "affaire_pipe" ? r.gmv : null,
      externalAmount: kind === "affaire_hors_pipe" ? (r.ext_amount ?? null) : null,
      externalStage: r.ext_stage ?? null,
      leadStatus: r.lead_status ?? null,
      stage: kind === "affaire_pipe" ? r.stage : null,
      acknowledged: r.status === "pris_en_compte",
      acknowledgedAt: r.acknowledged_at,
      // Non pertinent hors « attente » : vrai par défaut pour ne rien filtrer
      // d'autre que ce que cette notion concerne.
      awaitingReply: r.category !== "attente" || activeWaiting.has(r.gmail_message_id),
      // Non pertinent hors « chaud » (G) : vrai par défaut pour les autres
      // catégories, pour ne filtrer que ce que cette notion concerne.
      isLatestHotInThread: r.category !== "chaud" || latestHot.has(r.gmail_message_id),
    };
  });

  return { events };
}

// --- Fraîcheur du fil (F) ----------------------------------------------------

/**
 * Dernier message SORTANT de chaque fil.
 *
 * UNE SEULE définition de « le fil a reçu une réponse RM », partagée par le
 * Bloc 2 du Morning (`loadMorningEvents`) et par `canonicalClientAttend()`
 * (Monitoring) : avant F, cette même logique était écrite deux fois — une
 * fois en SQL dans `canonicalClientAttend`, jamais dans le Bloc 2 lui-même,
 * ce qui laissait une attente déjà répondue s'afficher indéfiniment tant
 * qu'elle n'était pas acquittée à la main.
 */
export function latestOutboundByThread(): Map<string, string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT thread_id, MAX(sent_at) AS latest FROM mail_signal
        WHERE direction = 'sortant' AND sent_at IS NOT NULL
        GROUP BY thread_id`,
    )
    .all() as { thread_id: string; latest: string }[];
  return new Map(rows.map((r) => [r.thread_id, r.latest]));
}

/**
 * Le fil est-il resté sans réponse RM après ce message ?
 *
 * `sentAt` nul ne peut être comparé à rien : on considère alors l'attente
 * encore active plutôt que de faire disparaître à tort un message dont la
 * date est inconnue.
 */
export function isThreadStillWaiting(
  threadId: string,
  sentAt: string | null,
  latestOutbound: Map<string, string>,
): boolean {
  if (!sentAt) return true;
  const latest = latestOutbound.get(threadId);
  return !latest || latest <= sentAt;
}

/**
 * Parmi des messages d'UNE MÊME catégorie, ceux qui sont la plus récente
 * occurrence de leur fil. Brique commune à la déduplication du Bloc 2
 * (attente) et du Bloc 1 (chaud, G) : plusieurs signaux successifs sur le
 * même sujet, dans le même fil, ne sont pas des situations distinctes — seule
 * la plus récente décrit la situation commerciale actuelle.
 */
function latestByThread(rows: { id: string; thread_id: string; sent_at: string | null }[]): Set<string> {
  const latest = new Map<string, string>();
  for (const r of rows) {
    const current = latest.get(r.thread_id);
    const at = r.sent_at ?? "";
    if (current === undefined || at > current) latest.set(r.thread_id, at);
  }
  const result = new Set<string>();
  for (const r of rows) {
    if ((r.sent_at ?? "") >= (latest.get(r.thread_id) ?? "")) result.add(r.id);
  }
  return result;
}

function eventRowsOfCategory(category: "chaud" | "attente"): { id: string; thread_id: string; sent_at: string | null }[] {
  return getDb()
    .prepare(
      `SELECT e.gmail_message_id AS id, m.thread_id AS thread_id, m.sent_at AS sent_at
         FROM morning_event e
         JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
        WHERE e.category = ?`,
    )
    .all(category) as { id: string; thread_id: string; sent_at: string | null }[];
}

/**
 * Messages « chaud » qui sont la plus récente occurrence de leur fil (G,
 * audit F-bis : 2 threads sur 21 portaient plusieurs événements chauds
 * simultanés). Déduplication AU NIVEAU DU THREAD seulement — jamais par
 * affaire : une même opportunité peut porter plusieurs fils réellement
 * distincts, et chacun garde sa propre plus récente occurrence.
 */
export function latestHotMessageIds(): Set<string> {
  return latestByThread(eventRowsOfCategory("chaud"));
}

/**
 * Messages « attente » réellement actifs — UNE SEULE définition (F, audit des
 * 43 attentes affichées), consommée par le Bloc 2 du Morning
 * (`loadMorningEvents`) et par `canonicalClientAttend()` (Monitoring) : elles
 * ne peuvent plus diverger.
 *
 * Un message `attente` est actif quand :
 *   — aucune réponse RM plus récente n'existe dans son fil
 *     (`isThreadStillWaiting`) ;
 *   — ET il est la PLUS RÉCENTE relance « attente » de ce fil. Plusieurs
 *     relances non répondues sur le même sujet ne sont pas trois attentes
 *     distinctes : c'est une seule conversation qui n'a toujours pas de
 *     réponse, et une seule ligne suffit à le dire. Les précédentes ne sont
 *     ni supprimées ni réinterprétées — seule la LECTURE ne les affiche plus.
 */
export function activeWaitingMessageIds(): Set<string> {
  const rows = eventRowsOfCategory("attente");
  const latestOutbound = latestOutboundByThread();
  const latestInThread = latestByThread(rows);

  const active = new Set<string>();
  for (const r of rows) {
    if (!isThreadStillWaiting(r.thread_id, r.sent_at, latestOutbound)) continue;
    if (!latestInThread.has(r.id)) continue;
    active.add(r.id);
  }
  return active;
}

// --- Vérité canonique « client attend » (C) --------------------------------

export type CanonicalClientAttend = {
  opportunityId: string;
  /** Date d'envoi du message qui fonde l'attente. */
  sentAt: string | null;
};

/**
 * Opportunités actuellement en attente réelle d'une réponse RM, telles que le
 * Morning les juge — et LUI SEUL. `opportunity-metrics.ts` consomme ce
 * résultat ; il ne recalcule jamais une attente d'origine e-mail de son côté.
 *
 * Un événement compte pour une affaire quand :
 *   — sa catégorie est « attente » (verdict du Morning : périmètre commercial
 *     via `morning-eligibility`, puis intention via `morning-intent` et les
 *     règles de `triage()` — jamais rejoué ici, seulement lu) ;
 *   — son rattachement à CETTE affaire est de confiance suffisante (niveau A
 *     ou B). Un niveau C reste affiché dans le Morning avec un badge « à
 *     vérifier », lu par un humain qui juge sur pièces ; il n'est pas assez
 *     sûr pour être attaché automatiquement à une affaire précise, et ne doit
 *     surtout pas ressusciter l'ancienne règle de délai que ce mécanisme
 *     remplace ;
 *   — le message est actif au sens d'`activeWaitingMessageIds` — LA MÊME
 *     fonction que le Bloc 2 : les deux ne peuvent plus diverger (F), y
 *     compris pour la déduplication des relances successives d'un même fil.
 *
 * `status` (« pris_en_compte ») n'entre JAMAIS dans ce calcul : c'est un état
 * UTILISATEUR — le geste de Sami ou d'un commercial sur SA liste de tâches. Il
 * ne dit rien de la réalité du fil. Un message traité alors que le client
 * n'a toujours reçu aucune réponse reste une attente active pour Monitoring ;
 * inversement, un message jamais acquitté dont le fil montre une réponse plus
 * récente n'en est plus une. Les deux notions sont volontairement disjointes.
 */
export function canonicalClientAttend(): Map<string, CanonicalClientAttend> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.gmail_message_id AS id, m.opportunity_id AS opportunity_id, m.sent_at AS sent_at
         FROM morning_event e
         JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
        WHERE e.category = 'attente'
          AND m.opportunity_id IS NOT NULL
          AND m.match_level IN ('A', 'B')
        ORDER BY m.sent_at ASC`,
    )
    .all() as { id: string; opportunity_id: string; sent_at: string | null }[];

  const active = activeWaitingMessageIds();

  // Ordre croissant, puis écrasement : le message le plus récent gagne quand
  // plusieurs attentes actives existent sur la même affaire.
  const map = new Map<string, CanonicalClientAttend>();
  for (const r of rows) {
    if (!active.has(r.id)) continue;
    map.set(r.opportunity_id, { opportunityId: r.opportunity_id, sentAt: r.sent_at });
  }
  return map;
}

/** Motifs d'exclusion, pour rendre compte de ce que Morning n'a pas retenu. */
export function ignoredSummary(): { reason: string; count: number }[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT reason, COUNT(*) count FROM morning_event
        WHERE category = 'ignore' GROUP BY reason ORDER BY count DESC`,
    )
    .all() as { reason: string; count: number }[];
}

/**
 * Messages écartés parce qu'ils sortent du périmètre commercial (C14).
 *
 * Distinct des messages simplement sans intention : ceux-ci viennent
 * d'interlocuteurs qui ne sont pas des clients, ou de dossiers déjà clos. Le
 * compteur vit dans Données, pas dans Morning — c'est un diagnostic, et
 * l'afficher au manager le ramènerait précisément au bruit qu'on vient de
 * retirer.
 */
export function outOfScopeSummary(): { total: number; reasons: { reason: string; count: number }[] } {
  const db = getDb();
  const reasons = db
    .prepare(
      `SELECT reason, COUNT(*) count FROM morning_event
        WHERE category = 'hors_perimetre' GROUP BY reason ORDER BY count DESC`,
    )
    .all() as { reason: string; count: number }[];
  return { total: reasons.reduce((t, r) => t + r.count, 0), reasons };
}

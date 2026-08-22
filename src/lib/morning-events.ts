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
  signal_type: string;
  blocker: string | null;
  summary: string | null;
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

/** Le client demande un document ou une correction pour pouvoir avancer. */
const NEEDS =
  /document|attestation|justificatif|devis (corrige|modifie|actualise)|corriger|correction|modifier|modification|ajuster|ajustement|rectifier|preciser/;

/** Le client exprime une volonté d'avancer. */
const ADVANCING =
  /comment (avancons|on avance|procede|proceder|faire pour)|prochaine etape|on y va|c'est bon pour (moi|nous)|nous souhaitons avancer|je souhaite avancer|valider|validation|signer|signature|bon pour accord|d'accord pour|convient|ca me va|ca nous va|fixer un rendez-vous|prendre rendez-vous|caler un (rdv|rendez-vous)|disponible pour|reglement|paiement|acompte|contrat/;

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

  // Un client qui relance passe devant : il attend une réponse, et c'est plus
  // urgent qu'une intention d'avancer déjà entendue.
  if (WAITING.test(text)) {
    return {
      category: "attente",
      reason: NEEDS.test(text) ? "Relance et attend un document ou une correction" : "Relance, sans réponse de notre côté",
      ignoredBecause: null,
    };
  }

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

  if (NEEDS.test(text)) {
    return { category: "attente", reason: "Attend un document ou une correction", ignoredBecause: null };
  }
  if (row.signal_type === "risque") {
    return { category: "ignore", reason: "", ignoredBecause: "signal de risque, sans demande explicite" };
  }
  return { category: "ignore", reason: "", ignoredBecause: "aucune intention identifiable" };
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
              d.opportunity_stage, d.lead_status,
              o.stage, o.is_terminal
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
    .run(actionKey, now.toISOString().slice(0, 10), now.toISOString());
  return Number(r.changes) > 0;
}

/** Clés des actions déjà faites aujourd'hui. */
export function doneActionKeys(now = new Date()): Set<string> {
  const db = getDb();
  const rows = db
    .prepare("SELECT action_key FROM morning_action_done WHERE done_on = ?")
    .all(now.toISOString().slice(0, 10)) as { action_key: string }[];
  return new Set(rows.map((r) => r.action_key));
}

export function lastMorningRead(): string | null {
  const db = getDb();
  const row = db.prepare("SELECT last_read_at FROM morning_state WHERE id = 1").get() as
    | { last_read_at: string | null }
    | undefined;
  return row?.last_read_at ?? null;
}

export function markMorningRead(now = new Date()): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO morning_state (id, last_read_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_read_at = excluded.last_read_at",
  ).run(now.toISOString());
}

/**
 * Les événements à présenter ce matin.
 *
 * Tout ce qui n'est pas encore pris en compte remonte, quelle que soit la date :
 * ne pas avoir ouvert RM Morning hier ne doit pas faire perdre un message. La
 * dernière lecture ne sert qu'à dire ce qui est *nouveau* depuis, pas à filtrer.
 */
export function loadMorningEvents(): { events: MorningEvent[]; lastRead: string | null } {
  const db = getDb();
  const lastRead = lastMorningRead();
  const rows = db
    .prepare(
      `SELECT e.gmail_message_id, e.thread_id, e.sent_at, e.category, e.reason, e.status,
              e.acknowledged_at, e.first_seen_at,
              m.from_email, m.from_name, m.match_level, m.match_kind, m.lead_id,
              m.salesperson, m.opportunity_id,
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
    return {
      messageId: r.gmail_message_id,
      threadId: r.thread_id,
      sentAt: r.sent_at,
      category: r.category as MorningCategory,
      reason: r.reason ?? "",
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
      isNew: lastRead == null || (r.sent_at ?? "") > lastRead,
    };
  });

  return { events, lastRead };
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

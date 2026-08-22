/**
 * Persistance des signaux mail et du curseur de synchronisation.
 *
 * Règle absolue : aucun corps de message n'entre ici. On y écrit des
 * identifiants Gmail, des métadonnées d'en-tête (expéditeur, objet, date), le
 * verdict du filtre et le rattachement A/B/C. Rien d'autre.
 *
 * L'écriture est idempotente : `INSERT ... ON CONFLICT DO NOTHING` sur la clé
 * `gmail_message_id`. Le chevauchement de deux heures entre deux fenêtres ne
 * peut donc pas produire de doublon.
 */

import { getDb, queryAll, queryOne } from "./db";

export type MailSignalRow = {
  gmailMessageId: string;
  threadId: string;
  sentAt: string | null;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  direction: "entrant" | "sortant" | "interne";
  filterRule: string;
  opportunityId: string | null;
  matchLevel: "A" | "B" | "C";
  matchReason: string;
  salesperson: string | null;
};

/**
 * Enregistre un signal. Renvoie true s'il s'agit d'une nouvelle ligne, false
 * si le message était déjà connu — c'est ce booléen qui prouve l'absence de
 * doublon lors de la seconde synchronisation.
 */
export function insertSignal(signal: MailSignalRow, syncId: number): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO mail_signal (
         gmail_message_id, thread_id, sent_at, from_email, from_name, subject,
         direction, filter_rule, opportunity_id, match_level, match_reason,
         salesperson, signal_type, signal_confidence, blocker, summary,
         classifier, analyzed_at, sync_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (gmail_message_id) DO NOTHING`,
    )
    .run(
      signal.gmailMessageId,
      signal.threadId,
      signal.sentAt,
      signal.fromEmail,
      signal.fromName,
      signal.subject,
      signal.direction,
      signal.filterRule,
      signal.opportunityId,
      signal.matchLevel,
      signal.matchReason,
      signal.salesperson,
      // Passage A : aucune classification sémantique. Les colonnes existent,
      // elles restent vides jusqu'au Passage B.
      "non_classifie",
      null,
      null,
      null,
      null,
      null,
      syncId,
    );
  return result.changes > 0;
}

/**
 * Écrit la classification courante d'un fil sur toutes ses lignes. La
 * classification est un état DE FIL, pas de message : les lignes portent donc
 * toutes le même verdict, et lire le signal courant d'une opportunité revient
 * à prendre sa ligne la plus récente.
 *
 * Aucun corps de message n'est écrit ici — seulement le verdict, sa confiance,
 * l'obstacle, un résumé court et l'identité du classifieur.
 */
export function updateThreadClassification(
  threadId: string,
  classification: {
    signalType: string;
    confidence: number;
    blocker: string | null;
    summary: string;
    classifier: string;
  },
): void {
  getDb()
    .prepare(
      `UPDATE mail_signal
          SET signal_type = ?, signal_confidence = ?, blocker = ?, summary = ?,
              classifier = ?, analyzed_at = ?
        WHERE thread_id = ?`,
    )
    .run(
      classification.signalType,
      classification.confidence,
      classification.blocker,
      classification.summary.slice(0, 200),
      classification.classifier,
      new Date().toISOString(),
      threadId,
    );
}

/**
 * Signal Gmail courant par opportunité, pour le Morning Brief.
 *
 * FILTRE STRUCTURANT : seuls les niveaux A et B sont retournés. Un fil de
 * niveau C n'a pas de rattachement fiable — il reste stocké, classifié et
 * historisé, mais ne doit jamais influencer un score, une alerte, une action
 * ou le forecast. C'est ce qui protège le brief des faux `positif_bloque` sur
 * les leads trop amont, les fournisseurs et l'administratif.
 */
export type OpportunityMailSignal = {
  opportunityId: string;
  threadId: string;
  matchLevel: "A" | "B";
  signalType: string;
  confidence: number;
  blocker: string | null;
  summary: string | null;
  classifier: string | null;
  sentAt: string | null;
  subject: string | null;
};

export function latestSignalByOpportunity(): Map<string, OpportunityMailSignal> {
  const rows = queryAll<{
    opportunity_id: string;
    thread_id: string;
    match_level: string;
    signal_type: string;
    signal_confidence: number | null;
    blocker: string | null;
    summary: string | null;
    classifier: string | null;
    sent_at: string | null;
    subject: string | null;
  }>(
    `SELECT opportunity_id, thread_id, match_level, signal_type, signal_confidence,
            blocker, summary, classifier, sent_at, subject
       FROM mail_signal
      WHERE opportunity_id IS NOT NULL
        AND match_level IN ('A','B')
        AND signal_type IS NOT NULL
      ORDER BY sent_at ASC`,
  );

  // Ordre croissant : la dernière écriture gagne, donc le message le plus
  // récent de chaque opportunité.
  const byOpportunity = new Map<string, OpportunityMailSignal>();
  for (const r of rows) {
    byOpportunity.set(r.opportunity_id, {
      opportunityId: r.opportunity_id,
      threadId: r.thread_id,
      matchLevel: r.match_level as "A" | "B",
      signalType: r.signal_type,
      confidence: Number(r.signal_confidence ?? 0),
      blocker: r.blocker,
      summary: r.summary,
      classifier: r.classifier,
      sentAt: r.sent_at,
      subject: r.subject,
    });
  }
  return byOpportunity;
}

/** Compte des fils de niveau C écartés du Morning Brief, pour le rendre visible. */
export function ignoredUncertainThreads(): number {
  const row = queryOne<{ n: number }>(
    "SELECT COUNT(DISTINCT thread_id) AS n FROM mail_signal WHERE match_level = 'C'",
  );
  return Number(row?.n ?? 0);
}

/**
 * Fils déjà rattachés de façon certaine. Permet au niveau A de se propager
 * d'un message à l'autre d'une même conversation, y compris entre deux
 * synchronisations.
 */
export function certainThreadLinks(): Map<string, string> {
  const rows = queryAll<{ thread_id: string; opportunity_id: string }>(
    `SELECT thread_id, opportunity_id
       FROM mail_signal
      WHERE match_level = 'A' AND opportunity_id IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.thread_id, r.opportunity_id]));
}

// --- Journal de synchronisation --------------------------------------------

export type MailSyncRow = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  windowStart: string;
  windowEnd: string;
  seen: number;
  excluded: number;
  kept: number;
  matchedCertain: number;
  matchedProbable: number;
  matchedUncertain: number;
  errors: string[];
};

export function startSync(windowStart: string, windowEnd: string): number {
  const result = getDb()
    .prepare(
      `INSERT INTO mail_sync (started_at, window_start, window_end)
       VALUES (?,?,?)`,
    )
    .run(new Date().toISOString(), windowStart, windowEnd);
  return Number(result.lastInsertRowid);
}

export function finishSync(
  id: number,
  counters: {
    seen: number;
    excluded: number;
    kept: number;
    matchedCertain: number;
    matchedProbable: number;
    matchedUncertain: number;
    errors: string[];
  },
): void {
  getDb()
    .prepare(
      `UPDATE mail_sync
          SET finished_at = ?, seen = ?, excluded = ?, kept = ?,
              matched_certain = ?, matched_probable = ?, matched_uncertain = ?,
              errors = ?
        WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      counters.seen,
      counters.excluded,
      counters.kept,
      counters.matchedCertain,
      counters.matchedProbable,
      counters.matchedUncertain,
      JSON.stringify(counters.errors),
      id,
    );
}

function toSyncRow(r: Record<string, unknown>): MailSyncRow {
  return {
    id: Number(r.id),
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    windowStart: String(r.window_start),
    windowEnd: String(r.window_end),
    seen: Number(r.seen),
    excluded: Number(r.excluded),
    kept: Number(r.kept),
    matchedCertain: Number(r.matched_certain),
    matchedProbable: Number(r.matched_probable),
    matchedUncertain: Number(r.matched_uncertain),
    errors: JSON.parse(String(r.errors ?? "[]")) as string[],
  };
}

/**
 * Dernière synchronisation terminée. C'est le curseur : la fenêtre suivante
 * repart de son `window_end`, moins le chevauchement de sécurité. Stocké en
 * base, il survit donc au redémarrage du serveur.
 */
export function lastCompletedSync(): MailSyncRow | null {
  const row = queryOne<Record<string, unknown>>(
    `SELECT * FROM mail_sync
      WHERE finished_at IS NOT NULL
      ORDER BY window_end DESC, id DESC
      LIMIT 1`,
  );
  return row ? toSyncRow(row) : null;
}

/** Dernière synchronisation, terminée ou non — pour l'affichage. */
export function latestSync(): MailSyncRow | null {
  const row = queryOne<Record<string, unknown>>(
    "SELECT * FROM mail_sync ORDER BY id DESC LIMIT 1",
  );
  return row ? toSyncRow(row) : null;
}

/** Total de signaux stockés, tous passages confondus. */
export function mailSignalCount(): number {
  const row = queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM mail_signal");
  return Number(row?.n ?? 0);
}

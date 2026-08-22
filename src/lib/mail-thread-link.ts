/**
 * Mémoire de rattachement par fil, et validations manuelles.
 *
 * RÈGLE CENTRALE : le fil primer sur l'expéditeur. Un même client peut avoir
 * plusieurs projets, et une nouvelle conversation doit pouvoir désigner une autre
 * affaire que la précédente. Une mémoire par adresse seule ferait rattacher tout
 * nouveau message au dossier le plus anciennement connu.
 *
 * Une validation manuelle porte sur le fil, n'est jamais écrasée par une inférence
 * automatique, et survit à toutes les synchronisations suivantes.
 *
 * Écrit uniquement dans `mail_thread_link`.
 */

import { getDb } from "./db";

export type ThreadLink = {
  threadId: string;
  opportunityId: string | null;
  leadId: string | null;
  kind: string;
  source: string;
  confidence: "certain" | "probable" | "a_verifier";
  isManual: boolean;
  confirmedAt: string;
};

type Row = {
  thread_id: string;
  opportunity_id: string | null;
  lead_id: string | null;
  kind: string;
  source: string;
  confidence: string;
  is_manual: number;
  confirmed_at: string;
};

const hydrate = (r: Row): ThreadLink => ({
  threadId: r.thread_id,
  opportunityId: r.opportunity_id,
  leadId: r.lead_id,
  kind: r.kind,
  source: r.source,
  confidence: r.confidence as ThreadLink["confidence"],
  isManual: r.is_manual === 1,
  confirmedAt: r.confirmed_at,
});

export function loadThreadLinks(): Map<string, ThreadLink> {
  const rows = getDb().prepare("SELECT * FROM mail_thread_link").all() as Row[];
  return new Map(rows.map((r) => [r.thread_id, hydrate(r)]));
}

export function getThreadLink(threadId: string): ThreadLink | null {
  const row = getDb()
    .prepare("SELECT * FROM mail_thread_link WHERE thread_id = ?")
    .get(threadId) as Row | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Enregistre un rattachement automatique.
 *
 * Ne touche JAMAIS un fil validé à la main : c'est la seule protection contre une
 * synchronisation qui déferait le travail du manager. Ne rétrograde pas non plus
 * un rattachement certain vers un rattachement plus faible — il faudrait une
 * nouvelle preuve, pas une simple relecture.
 */
export function rememberThread(link: Omit<ThreadLink, "isManual" | "confirmedAt">, now = new Date()): void {
  const db = getDb();
  const existing = getThreadLink(link.threadId);
  if (existing?.isManual) return;
  if (existing?.confidence === "certain" && link.confidence !== "certain") return;

  const at = now.toISOString();
  db.prepare(
    `INSERT INTO mail_thread_link
       (thread_id, opportunity_id, lead_id, kind, source, confidence, is_manual,
        confirmed_at, first_linked_at)
     VALUES (?,?,?,?,?,?,0,?,?)
     ON CONFLICT(thread_id) DO UPDATE SET
       opportunity_id = excluded.opportunity_id, lead_id = excluded.lead_id,
       kind = excluded.kind, source = excluded.source, confidence = excluded.confidence,
       confirmed_at = excluded.confirmed_at`,
  ).run(
    link.threadId,
    link.opportunityId,
    link.leadId,
    link.kind,
    link.source,
    link.confidence,
    at,
    at,
  );
}

/**
 * Validation manuelle d'un fil par le manager.
 *
 * Marquée `is_manual`, donc définitive tant qu'elle n'est pas explicitement
 * modifiée. Les messages du fil, présents et futurs, en héritent.
 */
export function linkThreadManually(
  threadId: string,
  target: { opportunityId?: string | null; leadId?: string | null },
  now = new Date(),
): void {
  const at = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO mail_thread_link
         (thread_id, opportunity_id, lead_id, kind, source, confidence, is_manual,
          confirmed_at, first_linked_at)
       VALUES (?,?,?,?,'manuel','certain',1,?,?)
       ON CONFLICT(thread_id) DO UPDATE SET
         opportunity_id = excluded.opportunity_id, lead_id = excluded.lead_id,
         kind = excluded.kind, source = 'manuel', confidence = 'certain', is_manual = 1,
         confirmed_at = excluded.confirmed_at`,
    )
    .run(
      threadId,
      target.opportunityId ?? null,
      target.leadId ?? null,
      target.opportunityId ? "affaire_pipe" : "piste",
      at,
      at,
    );
}

/**
 * Mémoire par expéditeur : les affaires auxquelles cette adresse a déjà été
 * rattachée avec certitude, par fil.
 *
 * Utilisée en dernier recours et jamais pour conclure « certain » : c'est un
 * indice, pas une preuve. Restreinte aux affaires encore ouvertes — rattacher une
 * nouvelle conversation à un projet terminé sous prétexte que l'adresse est la
 * même serait précisément l'erreur à éviter.
 */
export function senderMemory(email: string): { opportunityId: string; threads: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT t.opportunity_id AS id, COUNT(DISTINCT t.thread_id) AS threads
         FROM mail_thread_link t
         JOIN mail_signal s ON s.thread_id = t.thread_id
         JOIN opportunity o ON o.opportunity_id = t.opportunity_id
        WHERE lower(s.from_email) = ?
          AND t.confidence = 'certain'
          AND t.opportunity_id IS NOT NULL
          AND o.is_terminal = 0
        GROUP BY t.opportunity_id
        ORDER BY threads DESC`,
    )
    .all(email.toLowerCase()) as { id: string; threads: number }[];
  return rows.map((r) => ({ opportunityId: r.id, threads: r.threads }));
}

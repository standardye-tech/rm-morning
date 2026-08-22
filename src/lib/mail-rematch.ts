/**
 * Relance du rattachement sur les messages déjà stockés.
 *
 * POURQUOI. L'annuaire se rafraîchit après coup : une adresse vue pour la première
 * fois n'est résolue qu'ensuite. Sans cette relance, un client parfaitement
 * identifiable resterait « affaire non identifiée » jusqu'au passage suivant.
 *
 * Ne réinterroge PAS Gmail. Travaille sur les champs conservés dans
 * `mail_signal` — identifiants, adresse, objet, commercial — conformément à la
 * règle de minimisation : les corps complets ne sont pas stockés, et ne sont donc
 * pas rejouables. Conséquence assumée : le rattachement par contenu n'est pas
 * possible ici, seulement par adresse, nom, fil et annuaire.
 *
 * Idempotent. Ne dégrade jamais un rattachement : un message déjà rattaché de
 * façon certaine n'est pas retouché, et une validation manuelle est intouchable.
 */

import { INTERNAL_DOMAIN } from "./mail-rules";
import { getDb } from "./db";
import { loadDirectory } from "./mail-directory";
import type { MailMessage } from "./mail-rules";
import { buildOpportunityIndex, matchMessage, type MatchableOpportunity } from "./mail-match";
import { loadThreadLinks, rememberThread, senderMemory } from "./mail-thread-link";

export type RematchSummary = {
  examined: number;
  improved: number;
  unchanged: number;
  byLevel: Record<string, number>;
  byKind: Record<string, number>;
};

type SignalRow = {
  gmail_message_id: string;
  thread_id: string;
  sent_at: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  direction: string | null;
  opportunity_id: string | null;
  match_level: string | null;
  match_kind: string | null;
  lead_id: string | null;
  salesperson: string | null;
};

function loadMatchable(): MatchableOpportunity[] {
  return (
    getDb()
      .prepare(
        `SELECT opportunity_id, client_email, client_contact, name, owner, stage,
                is_signed, is_active
           FROM opportunity`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    opportunityId: String(r.opportunity_id),
    clientEmail: (r.client_email as string | null) ?? null,
    clientContact: (r.client_contact as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    owner: String(r.owner ?? ""),
    stage: (r.stage as string | null) ?? null,
    isSigned: r.is_signed === 1,
    isActive: r.is_active === 1,
  }));
}

/** Rang d'un niveau, pour ne jamais rétrograder un rattachement. */
const RANK: Record<string, number> = { A: 3, B: 2, C: 1 };

export function rematchSignals(): RematchSummary {
  const db = getDb();
  const index = buildOpportunityIndex(loadMatchable());
  const directory = loadDirectory();
  const threadLinks = loadThreadLinks();

  const rows = db
    .prepare(
      `SELECT gmail_message_id, thread_id, sent_at, from_email, from_name, subject,
              direction, opportunity_id, match_level, match_kind, lead_id, salesperson
         FROM mail_signal ORDER BY sent_at ASC`,
    )
    .all() as SignalRow[];

  const update = db.prepare(
    `UPDATE mail_signal
        SET opportunity_id = ?, match_level = ?, match_reason = ?, match_kind = ?, lead_id = ?
      WHERE gmail_message_id = ?`,
  );

  const byLevel: Record<string, number> = { A: 0, B: 0, C: 0 };
  const byKind: Record<string, number> = {};
  let improved = 0;
  let unchanged = 0;

  db.exec("BEGIN");
  try {
    for (const r of rows) {
      // Le message reconstitué depuis ce qui est conservé. `to` et `cc` ne sont pas
      // stockés : le commercial vient de la colonne dédiée, renseignée à la lecture.
      const message: MailMessage = {
        id: r.gmail_message_id,
        threadId: r.thread_id,
        date: r.sent_at,
        from: r.from_email ?? "",
        to: [],
        cc: [],
        subject: r.subject ?? "",
        snippet: "",
      } as MailMessage;

      const match = matchMessage(message, index, {
        internalDomain: INTERNAL_DOMAIN,
        teamMembers: r.salesperson ? [r.salesperson] : [],
        threadLink: threadLinks.get(r.thread_id) ?? null,
        directory,
        senderMemory: senderMemory(r.from_email ?? ""),
        fromName: r.from_name,
      });

      byLevel[match.level] = (byLevel[match.level] ?? 0) + 1;
      byKind[match.kind] = (byKind[match.kind] ?? 0) + 1;

      const before = RANK[r.match_level ?? "C"] ?? 1;
      const after = RANK[match.level] ?? 1;
      const identifiedNow = match.opportunityId != null || match.leadId != null;
      // On n'écrit que si le rattachement s'améliore, ou s'il change de cible à
      // niveau égal en apportant une raison. Jamais de dégradation.
      // On écrit quand le rattachement progresse, quand il change de cible à niveau
      // égal, ou simplement quand la nature du rattachement n'était pas encore
      // enregistrée. Jamais de dégradation : `after >= before` est exigé partout.
      const changed =
        match.kind !== (r.match_kind ?? null) ||
        match.opportunityId !== r.opportunity_id ||
        match.leadId !== r.lead_id;
      // La mémoire du fil est alimentée dès qu'un rattachement tient, MÊME si la
      // ligne n'a pas besoin d'être réécrite. Sans cela, un message déjà correct
      // ne reconstituait pas le lien, et les messages suivants du même fil
      // perdaient la propagation — observé après un nettoyage des liens.
      if (match.level !== "C" && (match.opportunityId || match.leadId)) {
        const confidence = match.level === "A" ? ("certain" as const) : ("probable" as const);
        rememberThread({
          threadId: r.thread_id,
          opportunityId: match.opportunityId,
          leadId: match.leadId,
          kind: match.kind,
          source: "annuaire",
          confidence,
        });
        threadLinks.set(r.thread_id, {
          threadId: r.thread_id,
          source: "annuaire",
          opportunityId: match.opportunityId,
          leadId: match.leadId,
          kind: match.kind,
          confidence,
          isManual: false,
          confirmedAt: new Date().toISOString(),
        });
      }

      if (after > before || (after === before && changed && (identifiedNow || r.match_kind == null))) {
        update.run(
          match.opportunityId, match.level, match.reason, match.kind, match.leadId,
          r.gmail_message_id,
        );
        improved += 1;
      } else {
        unchanged += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { examined: rows.length, improved, unchanged, byLevel, byKind };
}

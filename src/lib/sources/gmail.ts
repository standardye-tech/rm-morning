/**
 * Source Gmail — LECTURE SEULE.
 *
 * Implémente `MailSource` et ajoute la synchronisation incrémentale.
 *
 * Ce qui est lu à l'API : la liste des identifiants de messages d'une fenêtre
 * temporelle, puis pour chacun le format `metadata` — en-têtes From/To/Cc/
 * Subject/Date et l'extrait court fourni par Gmail. Jamais `format=full`,
 * jamais le corps, jamais les pièces jointes.
 *
 * Ce qui est écrit en base : identifiants, métadonnées d'en-tête, verdict du
 * filtre, rattachement. Le contenu des messages ne quitte pas la mémoire du
 * processus, le temps de la décision.
 *
 * Aucune fonction d'envoi, de modification, de suppression, d'archivage ou
 * d'étiquetage n'existe dans ce fichier — c'est volontaire.
 */

import { GMAIL_SYNC, GOOGLE_OAUTH } from "../config";
import { getAccessToken } from "../google-oauth";
import { queryAll } from "../db";
import {
  finishSync,
  insertSignal,
  lastCompletedSync,
  startSync,
  updateThreadClassification,
} from "../mail-store";
import { classifyHybrid, type ClassificationSource } from "../mail-classify-hybrid";
import type { ClassifiableMessage } from "../mail-classify";
import {
  INTERNAL_DOMAIN,
  filterMessage,
  isSignedProjectFollowUp,
  isUnattributableAgendaCancellation,
  teamMembersInvolved,
  type MailMessage,
} from "../mail-rules";
import { loadDirectory } from "../mail-directory";
import { loadThreadLinks, rememberThread, senderMemory } from "../mail-thread-link";
import {
  buildOpportunityIndex,
  matchMessage,
  type MatchableOpportunity,
} from "../mail-match";
import type { MailSignal, MailSource } from "./mail";

// --- Appels HTTP ------------------------------------------------------------

async function gmailGet<T>(pathAndQuery: string): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`${GOOGLE_OAUTH.gmailApi}/users/me/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(`Gmail ${response.status} — ${detail?.error?.message ?? "erreur"}`);
  }
  return (await response.json()) as T;
}

type GmailListResponse = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
};

type GmailMessageResponse = {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
};

/** Identifiants des messages d'une fenêtre. Pagine jusqu'au garde-fou. */
async function listMessageIds(from: Date, to: Date): Promise<string[]> {
  // `after`/`before` en secondes Unix : Gmail les interprète sans ambiguïté de
  // fuseau, contrairement aux dates en clair.
  const after = Math.floor(from.getTime() / 1000);
  const before = Math.ceil(to.getTime() / 1000);
  const query = encodeURIComponent(`after:${after} before:${before}`);

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = `messages?q=${query}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await gmailGet<GmailListResponse>(page);
    for (const message of data.messages ?? []) {
      ids.push(message.id);
      if (ids.length >= GMAIL_SYNC.maxMessagesPerRun) return ids;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

/** Adresses d'un en-tête « Nom <adresse>, autre@exemple.fr ». */
function parseAddresses(value: string): { email: string; name: string }[] {
  const found: { email: string; name: string }[] = [];
  const pattern = /(?:"?([^"<,]*?)"?\s*)?<([^>]+)>|([^\s,;<>]+@[^\s,;<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const email = (match[2] ?? match[3] ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    found.push({ email, name: (match[1] ?? "").trim() });
  }
  return found;
}

const domainOf = (email: string) => email.split("@")[1] ?? "";

/** Message Gmail réduit à ce dont les règles ont besoin. */
async function fetchMessage(
  id: string,
): Promise<{ message: MailMessage; fromName: string } | null> {
  const data = await gmailGet<GmailMessageResponse>(
    `messages/${id}?format=metadata` +
      "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc" +
      "&metadataHeaders=Subject&metadataHeaders=Date" +
      // Marqueurs d'envoi en masse : des en-têtes, pas du contenu.
      "&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence&metadataHeaders=List-Id",
  );

  const headers = new Map(
    (data.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  const from = parseAddresses(headers.get("from") ?? "");
  if (from.length === 0) return null;

  return {
    fromName: from[0].name,
    message: {
      id: data.id,
      threadId: data.threadId,
      date: data.internalDate
        ? new Date(Number(data.internalDate)).toISOString()
        : new Date(headers.get("date") ?? Date.now()).toISOString(),
      from: from[0].email,
      to: parseAddresses(headers.get("to") ?? "").map((a) => a.email),
      cc: parseAddresses(headers.get("cc") ?? "").map((a) => a.email),
      subject: headers.get("subject") ?? "",
      // Extrait court fourni par Gmail, jamais le corps complet.
      snippet: data.snippet ?? "",
      bulk:
        headers.has("list-unsubscribe") ||
        /^(bulk|list|junk)$/i.test((headers.get("precedence") ?? "").trim()),
      listId: headers.get("list-id") ?? undefined,
    },
  };
}

/**
 * Messages d'un fil, en mémoire, pour la reclassification.
 *
 * Le contenu n'étant jamais stocké, le contexte d'un fil doit être relu à la
 * demande. On ne garde que les derniers messages : la classification ne
 * regarde jamais plus loin que le signal courant et son antécédent immédiat.
 */
async function fetchThreadMessages(threadId: string): Promise<ClassifiableMessage[]> {
  const data = await gmailGet<{ messages?: GmailMessageResponse[] }>(
    `threads/${threadId}?format=metadata` +
      "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date",
  );

  return (data.messages ?? [])
    .map((m) => {
      const headers = new Map(
        (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
      );
      const from = parseAddresses(headers.get("from") ?? "")[0]?.email ?? "";
      const to = parseAddresses(headers.get("to") ?? "").map((a) => a.email);
      const allInternal = [from, ...to].every((a) => domainOf(a) === INTERNAL_DOMAIN);
      return {
        id: m.id,
        threadId: m.threadId,
        date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "",
        direction: allInternal
          ? ("interne" as const)
          : domainOf(from) === INTERNAL_DOMAIN
            ? ("sortant" as const)
            : ("entrant" as const),
        subject: headers.get("subject") ?? "",
        snippet: m.snippet ?? "",
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-3);
}

/** Exécute une fonction sur chaque élément, quelques-uns à la fois. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Opportunités du périmètre ---------------------------------------------

function loadMatchable(): MatchableOpportunity[] {
  return queryAll<{
    opportunity_id: string;
    name: string | null;
    client_email: string | null;
    client_contact: string | null;
    owner: string;
    stage: string | null;
    is_signed: number;
    is_active: number;
  }>(
    `SELECT opportunity_id, name, client_email, client_contact, owner, stage,
            is_signed, is_active
       FROM opportunity`,
  ).map((r) => ({
    opportunityId: r.opportunity_id,
    name: r.name,
    clientEmail: r.client_email,
    clientContact: r.client_contact,
    owner: r.owner,
    stage: r.stage,
    isSigned: r.is_signed === 1,
    isActive: r.is_active === 1,
  }));
}

// --- Synchronisation --------------------------------------------------------

export type SyncReport = {
  syncId: number;
  windowStart: string;
  windowEnd: string;
  bootstrap: boolean;
  seen: number;
  excluded: number;
  kept: number;
  inserted: number;
  duplicates: number;
  matchedCertain: number;
  matchedProbable: number;
  matchedUncertain: number;
  /** Détail des règles ayant écarté des messages, pour l'audit. */
  exclusionsByRule: Record<string, number>;
  errors: string[];
  durationMs: number;
  /** Classification : combien de fils, et par quel chemin. */
  classified: number;
  bySource: Record<ClassificationSource, number>;
  clamped: number;
  inputTokens: number;
  outputTokens: number;
  classifyMs: number;
};

/**
 * Fenêtre à interroger. Sans curseur, on prend la fenêtre de démarrage ;
 * sinon on repart de la fin de la dernière synchronisation terminée, moins le
 * chevauchement de sécurité.
 */
export function nextWindow(now = new Date()): { start: Date; end: Date; bootstrap: boolean } {
  const last = lastCompletedSync();
  if (!last) {
    const start = new Date(now.getTime() - GMAIL_SYNC.bootstrapDays * 86_400_000);
    return { start, end: now, bootstrap: true };
  }
  const start = new Date(
    new Date(last.windowEnd).getTime() - GMAIL_SYNC.overlapHours * 3_600_000,
  );
  return { start, end: now, bootstrap: false };
}

export class GmailSource implements MailSource {
  readonly kind = "gmail-api";

  /**
   * Lit une fenêtre et rend les messages, sans rien écrire. Utilisé par
   * `sync()` et par le harnais de validation : les deux passent donc par
   * exactement le même code de lecture et de parsing.
   */
  async readWindow(
    start: Date,
    end: Date,
    onError?: (message: string) => void,
  ): Promise<{ message: MailMessage; fromName: string }[]> {
    const ids = await listMessageIds(start, end);
    const fetched = await mapLimited(ids, GMAIL_SYNC.concurrency, async (id) => {
      try {
        return await fetchMessage(id);
      } catch (cause) {
        onError?.(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    });
    return fetched.filter((f): f is NonNullable<typeof f> => f !== null);
  }

  /**
   * Un passage de synchronisation. Ne relit jamais toute la boîte : seule la
   * fenêtre calculée par `nextWindow` est interrogée.
   */
  async sync(now = new Date()): Promise<SyncReport> {
    const startedAt = Date.now();
    const { start, end, bootstrap } = nextWindow(now);
    const syncId = startSync(start.toISOString(), end.toISOString());

    const errors: string[] = [];
    const exclusionsByRule: Record<string, number> = {};
    let seen = 0;
    let excluded = 0;
    let kept = 0;
    let inserted = 0;
    let duplicates = 0;
    const levels = { A: 0, B: 0, C: 0 };
    // Fils touchés par ce passage → stade Salesforce, pour la classification.
    const touchedThreads = new Map<string, string | null>();
    let classified = 0;
    let clamped = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const bySource: Record<ClassificationSource, number> = {
      rules: 0,
      model: 0,
      rules_fallback: 0,
    };

    try {
      const fetched = await this.readWindow(start, end, (message) => errors.push(message));
      seen = fetched.length;

      const index = buildOpportunityIndex(loadMatchable());
      const byId = new Map(index.all.map((o) => [o.opportunityId, o]));
      // Adresses clients connues de Salesforce : sert à décider si une
      // annulation de rendez-vous concerne quelqu'un d'identifiable.
      const knownClientEmails = new Set(
        index.all.map((o) => (o.clientEmail ?? "").toLowerCase()).filter(Boolean),
      );
      // C13 — trois mémoires, du plus fort au plus faible : le fil (avec ses
      // validations manuelles), l'annuaire des adresses résolues vers Salesforce,
      // puis l'expéditeur. L'annuaire est rafraîchi juste avant, pour que les
      // adresses vues au passage précédent soient déjà résolues.
      const threadLinks = loadThreadLinks();
      const directory = loadDirectory();

      // Traitement séquentiel : le rattachement de niveau A doit pouvoir se
      // propager aux messages suivants du même fil, dans l'ordre chronologique.
      const ordered = [...fetched].sort((a, b) => a.message.date.localeCompare(b.message.date));

      for (const { message, fromName } of ordered) {
        const verdict = filterMessage(message);
        if (!verdict.kept) {
          excluded += 1;
          exclusionsByRule[verdict.rule] = (exclusionsByRule[verdict.rule] ?? 0) + 1;
          continue;
        }

        const teamMembers = teamMembersInvolved(message);
        const match = matchMessage(message, index, {
          internalDomain: INTERNAL_DOMAIN,
          teamMembers,
          threadLink: threadLinks.get(message.threadId) ?? null,
          directory,
          senderMemory: senderMemory(message.from),
          fromName,
        });

        const opportunity = match.opportunityId ? byId.get(match.opportunityId) : undefined;

        // Second filtre agenda : une annulation ne survit que si quelqu'un
        // d'identifiable est derrière.
        if (
          isUnattributableAgendaCancellation(message, {
            hasOpportunity: Boolean(match.opportunityId),
            senderIsKnownClient: knownClientEmails.has(message.from),
          })
        ) {
          excluded += 1;
          exclusionsByRule["agenda-annulation-sans-client"] =
            (exclusionsByRule["agenda-annulation-sans-client"] ?? 0) + 1;
          continue;
        }

        // Second filtre : suivi de chantier sur une affaire déjà signée. Il ne
        // peut être tranché qu'une fois l'opportunité connue.
        if (opportunity && isSignedProjectFollowUp(message, opportunity.isSigned)) {
          excluded += 1;
          exclusionsByRule["chantier-affaire-signee"] =
            (exclusionsByRule["chantier-affaire-signee"] ?? 0) + 1;
          continue;
        }

        // La mémoire du fil est persistée, et se propage aux messages suivants du
        // même fil dans ce même passage. `rememberThread` protège les validations
        // manuelles et ne rétrograde jamais un rattachement certain.
        if (match.level !== "C" && (match.opportunityId || match.leadId)) {
          const remembered = {
            threadId: message.threadId,
            opportunityId: match.opportunityId,
            leadId: match.leadId,
            kind: match.kind,
            source: match.isManual ? "manuel" : "automatique",
            confidence: (match.level === "A" ? "certain" : "probable") as
              | "certain"
              | "probable"
              | "a_verifier",
          };
          rememberThread(remembered);
          threadLinks.set(message.threadId, {
            ...remembered,
            isManual: match.isManual,
            confirmedAt: new Date().toISOString(),
          });
        }

        kept += 1;
        levels[match.level] += 1;

        const fromDomain = domainOf(message.from);
        const allInternal = [message.from, ...message.to, ...(message.cc ?? [])].every(
          (a) => domainOf(a) === INTERNAL_DOMAIN,
        );

        const isNew = insertSignal(
          {
            gmailMessageId: message.id,
            threadId: message.threadId,
            sentAt: message.date,
            fromEmail: message.from,
            fromName: fromName || null,
            subject: message.subject || null,
            direction: allInternal
              ? "interne"
              : fromDomain === INTERNAL_DOMAIN
                ? "sortant"
                : "entrant",
            filterRule: verdict.rule,
            opportunityId: match.opportunityId,
            matchLevel: match.level,
            matchReason: match.reason,
            salesperson: opportunity?.owner ?? teamMembers[0] ?? null,
          },
          syncId,
        );
        if (isNew) inserted += 1;
        else duplicates += 1;

        // Seuls les fils touchés par ce passage seront reclassés : on ne
        // rejoue jamais tout l'historique.
        touchedThreads.set(message.threadId, opportunity?.stage ?? null);
      }
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    }

    // --- Classification hybride bridée des fils touchés.
    const classifyStart = Date.now();
    await mapLimited([...touchedThreads.entries()], GMAIL_SYNC.classifyConcurrency, async ([threadId, stage]) => {
      try {
        const thread = await fetchThreadMessages(threadId);
        const result = await classifyHybrid(thread, { stage });
        if (!result) return;

        updateThreadClassification(threadId, {
          signalType: result.classification.signalType,
          confidence: result.classification.confidence,
          blocker: result.classification.blocker,
          summary: result.classification.summary,
          classifier: result.classification.classifier,
        });

        classified += 1;
        bySource[result.source] += 1;
        if (result.clamped) clamped += 1;
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
      } catch (cause) {
        // Une classification qui échoue n'invalide pas la synchronisation :
        // le message reste stocké, simplement `non_classifie`.
        errors.push(
          `classification ${threadId.slice(-6)} : ${cause instanceof Error ? cause.message : cause}`,
        );
      }
    });
    const classifyMs = Date.now() - classifyStart;

    finishSync(syncId, {
      seen,
      excluded,
      kept,
      matchedCertain: levels.A,
      matchedProbable: levels.B,
      matchedUncertain: levels.C,
      errors,
    });

    return {
      syncId,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      bootstrap,
      seen,
      excluded,
      kept,
      inserted,
      duplicates,
      matchedCertain: levels.A,
      matchedProbable: levels.B,
      matchedUncertain: levels.C,
      exclusionsByRule,
      errors,
      durationMs: Date.now() - startedAt,
      classified,
      bySource,
      clamped,
      inputTokens,
      outputTokens,
      classifyMs,
    };
  }

  /**
   * Contrat `MailSource`, alimenté depuis les signaux déjà stockés — aucun
   * appel réseau. Volontairement NON branché au Morning Brief à ce stade :
   * le Passage A ne modifie ni le Top 3, ni les alertes, ni les actions.
   */
  async fetchSignals(contactEmails: string[]): Promise<MailSignal[]> {
    if (contactEmails.length === 0) return [];
    const wanted = new Set(contactEmails.map((e) => e.trim().toLowerCase()));
    const rows = queryAll<{
      opportunity_id: string | null;
      from_email: string | null;
      sent_at: string | null;
      direction: string | null;
      subject: string | null;
    }>(
      `SELECT opportunity_id, from_email, sent_at, direction, subject
         FROM mail_signal
        WHERE from_email IS NOT NULL
        ORDER BY sent_at DESC`,
    );

    const latest = new Map<string, MailSignal>();
    for (const row of rows) {
      const email = (row.from_email ?? "").toLowerCase();
      if (!wanted.has(email) || latest.has(email)) continue;
      latest.set(email, {
        opportunityId: row.opportunity_id,
        contactEmail: email,
        lastExchangeAt: row.sent_at,
        awaitingClientReply: row.direction === "sortant",
        subject: row.subject,
      });
    }
    return [...latest.values()];
  }
}

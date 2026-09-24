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
  setThreadQuote,
} from "../mail-store";
import { extractQuoteFromMessage, messageBody } from "../mail-classify";
import { selectInterestProof } from "../interest-proof";
import {
  AI_BUDGET_REACHED,
  classifyHybrid,
  type ClassificationSource,
  type ModelBudget,
} from "../mail-classify-hybrid";
import type { AiOrigin } from "../ai-usage";
import { threadsNeedingQuote, whatClientSays } from "../morning-events";
import type { ClassifiableMessage } from "../mail-classify";
import {
  INTERNAL_DOMAIN,
  filterMessage,
  isSignedProjectFollowUp,
  isUnattributableAgendaCancellation,
  teamMembersInCc,
  teamMembersInTo,
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

/**
 * Erreur Gmail, avec le code HTTP conservé : c'est lui qui dit si l'échec est
 * PASSAGER ou DÉFINITIF, et donc s'il vaut la peine d'être rejoué.
 */
class GmailHttpError extends Error {
  // Champ déclaré puis affecté, et NON une propriété de paramètre : les harnais
  // de validation tournent sous `--experimental-strip-types`, qui retire les
  // types sans les compiler et rejette `constructor(readonly status: number)`.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GmailHttpError";
    this.status = status;
  }
}

/**
 * L'échec est-il passager ?
 *
 *   429 / 5xx        surcharge ou panne momentanée de Google ;
 *   403 « quota »    limite PAR MINUTE atteinte — elle se rouvre d'elle-même.
 *
 * Un 403 de PERMISSION, lui, est définitif : rejouer ne ferait que consommer
 * du quota pour rien. On distingue les deux sur le message de Google, seul
 * élément qui les sépare.
 *
 * 404 est définitif aussi : le message a disparu entre la liste et la lecture.
 */
const TRANSIENT_403 = /quota|rate limit|rateLimitExceeded|userRateLimitExceeded|backend/i;

function isTransient(error: unknown): boolean {
  if (error instanceof GmailHttpError) {
    if (error.status === 429 || error.status >= 500) return true;
    return error.status === 403 && TRANSIENT_403.test(error.message);
  }
  // Coupure réseau, DNS, socket fermée : rien de définitif là-dedans.
  return error instanceof TypeError;
}

/**
 * REPRISE BORNÉE, ET SURTOUT COLLECTIVE.
 *
 * La limite que l'on rencontre en pratique n'est pas par requête : c'est
 * « Units per minute per user », une enveloppe PARTAGÉE par tous les appels du
 * compte. Un rattrapage de huit jours lit ~600 messages puis relit ~450 fils ;
 * à huit lectures en parallèle, la cadence dépasse l'enveloppe et Google
 * répond 403.
 *
 * Rejouer chacun dans son coin ne suffit donc pas — les sept autres continuent
 * de tirer pendant qu'un seul patiente, et l'enveloppe ne se rouvre jamais.
 * D'où une PAUSE PARTAGÉE : dès qu'un appel se voit refuser pour quota, tous
 * les appels suivants attendent la même échéance. La cadence retombe d'un coup,
 * la fenêtre se rouvre, et les tentatives suivantes passent.
 *
 * Bornée dans les deux sens : quatre reprises au plus, attentes plafonnées à
 * 20 s, soit une quarantaine de secondes dans le pire des cas — très en deçà
 * du délai de l'étape. Le bruit ajouté évite que les huit lectures ne
 * repartent exactement à l'unisson.
 *
 * Hors saturation, ce mécanisme est totalement inerte : aucune attente n'est
 * introduite tant qu'aucun 403 de quota n'est survenu.
 */
const GMAIL_RETRY = { attempts: 5, baseDelayMs: 2000, maxDelayMs: 20_000 } as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Échéance avant laquelle plus aucun appel Gmail ne doit partir. */
let quotaPauseUntil = 0;

async function gmailGet<T>(pathAndQuery: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GMAIL_RETRY.attempts; attempt++) {
    // Une saturation constatée par UN appel freine TOUS les autres.
    const pause = quotaPauseUntil - Date.now();
    if (pause > 0) await wait(pause);

    try {
      return await gmailGetOnce<T>(pathAndQuery);
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === GMAIL_RETRY.attempts) break;
      const backoff =
        Math.min(GMAIL_RETRY.baseDelayMs * 2 ** (attempt - 1), GMAIL_RETRY.maxDelayMs) +
        Math.random() * GMAIL_RETRY.baseDelayMs;
      // `Math.max` : on ne raccourcit jamais une pause déjà décidée par un
      // appel plus malchanceux, on ne fait que la prolonger si besoin.
      quotaPauseUntil = Math.max(quotaPauseUntil, Date.now() + backoff);
      await wait(backoff);
    }
  }
  throw lastError;
}

async function gmailGetOnce<T>(pathAndQuery: string): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`${GOOGLE_OAUTH.gmailApi}/users/me/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new GmailHttpError(
      response.status,
      `Gmail ${response.status} — ${detail?.error?.message ?? "erreur"}`,
    );
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
/** Fils relus par passage pour le rattrapage de la phrase du client. */
const QUOTE_BACKFILL_LIMIT = 80;

export async function fetchThreadMessages(threadId: string): Promise<ClassifiableMessage[]> {
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

/**
 * Classe un fil TEL QUE LA SYNCHRO LE FAIT : relecture Gmail en lecture seule
 * (métadonnées + extrait), classification hybride bridée, citation du client.
 * Partagé par la synchronisation et par le retraitement des fils récents
 * (`scripts/reclassify-mail-threads.mjs`) : une seule définition.
 *
 * La citation est « la phrase du CLIENT » : hors verdict du modèle, elle est
 * extraite du dernier message entrant, jamais d'une réponse de RM qui
 * clôturerait le fil (holdout du 24/09/2026, même règle que le rattrapage).
 */
export async function classifyThreadForStore(
  threadId: string,
  stage: string | null,
  origin: AiOrigin = "synchro",
  budget?: ModelBudget,
) {
  const thread = await fetchThreadMessages(threadId);
  const result = await classifyHybrid(thread, { stage, origin }, budget);
  if (!result) return null;
  const lastInbound = thread.filter((m) => m.direction === "entrant").pop();
  const quote =
    result.source === "model"
      ? (result.classification.quote ?? null)
      : lastInbound
        ? extractQuoteFromMessage(lastInbound)
        : null;
  return {
    result,
    stored: {
      signalType: result.classification.signalType,
      confidence: result.classification.confidence,
      blocker: result.classification.blocker,
      summary: result.classification.summary,
      classifier: result.classification.classifier,
      quote,
    },
  };
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

/** Un échec d'appel Gmail, rattaché à ce sur quoi il portait. */
export type MailFailure = {
  /** Identifiant du message ou du fil concerné. */
  id: string;
  /** Message d'erreur de Google, tel quel. Jamais de contenu de message. */
  reason: string;
};

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

  /**
   * TROIS NATURES D'ÉCHEC, QU'IL NE FAUT PAS CONFONDRE.
   *
   * Elles étaient autrefois versées dans un seul tableau, résumé à l'écran par
   * « N message(s) illisible(s) ignoré(s) ». Le libellé était faux deux fois sur
   * trois : aucun de ces échecs ne vient d'un contenu illisible — ni HTML
   * particulier, ni encodage, ni pièce jointe — mais toujours d'un refus de
   * l'API Gmail, et un fil non classé n'est pas un message perdu.
   */

  /** Messages JAMAIS LUS : le signal est absent de la base. Impact réel. */
  unreadMessages: MailFailure[];
  /**
   * Fils dont la relecture a échoué : les messages SONT stockés, seule leur
   * qualification manque. Impact moindre, mais réel — d'où un libellé distinct.
   */
  unclassifiedThreads: MailFailure[];
  /** Panne de la passe de lecture entière. Rien n'a pu être fait. */
  failure: string | null;
  /**
   * Messages sans expéditeur exploitable, écartés à la lecture. AUCUN impact :
   * sans adresse, aucune règle ni aucun rattachement n'est possible. Compté
   * pour la visibilité, jamais remonté en avertissement.
   */
  withoutSender: number;

  /**
   * Union des trois, sous forme de texte : c'est ce que conserve `mail_sync`
   * et ce qu'affiche l'écran « Données ». Le détail technique reste donc
   * accessible pour diagnostiquer, même quand rien n'est remonté à l'écran.
   */
  errors: string[];
  durationMs: number;
  /** Classification : combien de fils, et par quel chemin. */
  classified: number;
  bySource: Record<ClassificationSource, number>;
  clamped: number;
  inputTokens: number;
  outputTokens: number;
  /** Requêtes envoyées au modèle par ce passage (tentatives, réussies ou non). */
  aiCalls: number;
  /** Fils classés par les règles faute de budget IA restant. */
  aiBudgetSkipped: number;
  classifyMs: number;
};

/**
 * Fenêtre à interroger. Sans curseur, on prend la fenêtre de démarrage ;
 * sinon on repart de la fin de la dernière synchronisation terminée, moins le
 * chevauchement de sécurité.
 */
export type InterestProofAudit = {
  threadId: string;
  client: string;
  category: string;
  subject: string | null;
  /** Ce que l'écran montre aujourd'hui pour ce message. */
  before: string;
  /** La preuve d'intérêt retenue, ou null. */
  after: string | null;
  tier: string | null;
  /** Texte utile du dernier message client, pour juger la fidélité à l'œil. */
  text: string;
};

/**
 * Audit LECTURE SEULE de la preuve d'intérêt sur les événements Morning
 * ouverts : relit les fils auprès de Gmail (métadonnées et extrait, comme la
 * synchronisation), applique la sélection et rend l'avant / après. N'écrit
 * rien, n'appelle aucun modèle.
 */
export async function auditInterestProofs(limit = 25): Promise<InterestProofAudit[]> {
  const rows = queryAll<{
    thread_id: string;
    subject: string | null;
    category: string;
    reason: string | null;
    summary: string | null;
    classifier: string | null;
    quote: string | null;
    client: string | null;
  }>(
    `SELECT m.thread_id, m.subject, e.category, e.reason, m.summary, m.classifier, m.quote,
            COALESCE(o.client_contact, m.from_name, m.from_email) AS client
       FROM morning_event e
       JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
       LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id
      WHERE e.status <> 'pris_en_compte' AND e.category IN ('chaud', 'attente')
      ORDER BY e.sent_at DESC`,
  );
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.thread_id) ? false : (seen.add(r.thread_id), true))).slice(0, limit);

  return mapLimited(unique, GMAIL_SYNC.classifyConcurrency, async (r) => {
    const thread = await fetchThreadMessages(r.thread_id);
    const last = thread.filter((m) => m.direction === "entrant").pop() ?? thread[thread.length - 1];
    const text = last ? messageBody(last) : "";
    const proof = text ? selectInterestProof(text) : null;
    return {
      threadId: r.thread_id,
      client: r.client ?? "Client non identifié",
      category: r.category,
      subject: r.subject,
      before: whatClientSays({ reason: r.reason, quote: null, summary: r.summary, classifier: r.classifier }).said,
      after: proof?.quote ?? null,
      tier: proof?.label ?? null,
      text,
    };
  });
}

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
    watch: {
      /** Le message n'a pas pu être lu : signal absent de la base. */
      onUnread?: (failure: MailFailure) => void;
      /** Le message a été lu, mais sans expéditeur exploitable : sans portée. */
      onWithoutSender?: (id: string) => void;
    } = {},
  ): Promise<{ message: MailMessage; fromName: string }[]> {
    const ids = await listMessageIds(start, end);
    const fetched = await mapLimited(ids, GMAIL_SYNC.concurrency, async (id) => {
      try {
        const message = await fetchMessage(id);
        // `null` n'est pas un échec : Gmail a répondu, l'en-tête `From` ne
        // porte simplement aucune adresse. Rien n'est perdu, rien à signaler.
        if (message === null) watch.onWithoutSender?.(id);
        return message;
      } catch (cause) {
        watch.onUnread?.({
          id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
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

    const unreadMessages: MailFailure[] = [];
    const unclassifiedThreads: MailFailure[] = [];
    let withoutSender = 0;
    let failure: string | null = null;
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
      const fetched = await this.readWindow(start, end, {
        onUnread: (f) => unreadMessages.push(f),
        onWithoutSender: () => {
          withoutSender++;
        },
      });
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
        // D — destinataires RM, à part : `teamMembers` ci-dessus fusionne
        // from/to/cc et ne dit pas QUI est destinataire principal. La règle
        // d'exclusion Sami (E) a besoin de cette distinction.
        const rmTo = teamMembersInTo(message);
        const rmCc = teamMembersInCc(message);
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
            rmTo,
            rmCc,
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
      failure = cause instanceof Error ? cause.message : String(cause);
    }

    // --- Classification hybride bridée des fils touchés.
    const classifyStart = Date.now();
    // Motifs de repli du modèle, comptés par fil. Jusqu'au 24/09/2026 ils étaient
    // calculés puis jetés : un crédit API épuisé a ainsi fait basculer 98 % des
    // fils en `rules_fallback` pendant dix jours sans aucune trace.
    const modelFallbacks = new Map<string, number>();
    // Garde-fou de coût : au plus `maxModelCallsPerRun` appels par passage.
    const budget: ModelBudget = { remaining: GMAIL_SYNC.maxModelCallsPerRun };
    let aiBudgetSkipped = 0;
    await mapLimited([...touchedThreads.entries()], GMAIL_SYNC.classifyConcurrency, async ([threadId, stage]) => {
      try {
        const classified_ = await classifyThreadForStore(threadId, stage, "synchro", budget);
        if (!classified_) return;
        const { result, stored } = classified_;
        updateThreadClassification(threadId, stored);

        classified += 1;
        bySource[result.source] += 1;
        if (result.fallbackReason === AI_BUDGET_REACHED) {
          aiBudgetSkipped += 1;
        } else if (result.fallbackReason) {
          modelFallbacks.set(result.fallbackReason, (modelFallbacks.get(result.fallbackReason) ?? 0) + 1);
        }
        if (result.clamped) clamped += 1;
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
      } catch (cause) {
        // Une classification qui échoue n'invalide pas la synchronisation :
        // le message reste stocké, simplement `non_classifie`. Ce n'est donc
        // PAS un message illisible, et ce compteur-ci le dit.
        //
        // `classifyHybrid` ne lève jamais — tout échec du modèle rend la main
        // aux règles. Ce qui atterrit ici vient forcément de la relecture du
        // fil auprès de Gmail.
        unclassifiedThreads.push({
          id: threadId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
    const classifyMs = Date.now() - classifyStart;
    const aiCalls = GMAIL_SYNC.maxModelCallsPerRun - budget.remaining;

    // --- Rattrapage de la phrase du client sur les événements Morning ouverts.
    //
    // Les messages classés avant l'existence de la citation n'en ont pas. On
    // relit leur fil — métadonnées et extrait, jamais le corps — et on en
    // extrait la phrase par les règles, SANS appel au modèle. Borné, et jamais
    // bloquant : un échec laisse la colonne vide et la ligne retombe sur le
    // résumé. Une chaîne vide marque « cherché, rien trouvé » pour ne pas
    // relire le même fil à chaque passage.
    const backfill = threadsNeedingQuote(QUOTE_BACKFILL_LIMIT).filter((t) => !touchedThreads.has(t));
    await mapLimited(backfill, GMAIL_SYNC.classifyConcurrency, async (threadId) => {
      try {
        const thread = await fetchThreadMessages(threadId);
        const last = thread.filter((m) => m.direction === "entrant").pop() ?? thread[thread.length - 1];
        setThreadQuote(threadId, last ? extractQuoteFromMessage(last) : null);
      } catch {
        // Rien à consigner : la synchronisation n'en dépend pas.
      }
    });

    // Trace technique unique, conservée en base et affichée par l'écran
    // « Données ». Chaque ligne est PRÉFIXÉE de sa nature : c'est ce qui permet
    // de diagnostiquer plus tard sans relire le code.
    for (const [reason, n] of modelFallbacks) {
      // Journal sûr : fournisseur, modèle, statut, type d'erreur. Jamais la clé ni un email.
      console.warn(`[gmail] repli du modèle sur les règles : ${reason} — ${n} fil(s)`);
    }
    if (aiBudgetSkipped > 0) {
      console.warn(
        `[gmail] ${AI_BUDGET_REACHED} (${GMAIL_SYNC.maxModelCallsPerRun} appels) — ${aiBudgetSkipped} fil(s) classé(s) par les règles`,
      );
    }
    const errors: string[] = [
      ...(failure ? [`lecture : ${failure}`] : []),
      ...(aiBudgetSkipped > 0
        ? [`${AI_BUDGET_REACHED} (${GMAIL_SYNC.maxModelCallsPerRun} appels) : ${aiBudgetSkipped} fil(s) classé(s) par les règles`]
        : []),
      ...[...modelFallbacks].map(([reason, n]) => `modèle indisponible (${reason}) : ${n} fil(s) classé(s) par les règles`),
      ...unreadMessages.map((f) => `message ${f.id} non lu : ${f.reason}`),
      ...unclassifiedThreads.map((f) => `fil ${f.id} non classé : ${f.reason}`),
    ];

    finishSync(syncId, {
      seen,
      excluded,
      kept,
      matchedCertain: levels.A,
      matchedProbable: levels.B,
      matchedUncertain: levels.C,
      errors,
      aiCalls,
      aiBudgetReached: aiBudgetSkipped > 0,
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
      unreadMessages,
      unclassifiedThreads,
      failure,
      withoutSender,
      errors,
      durationMs: Date.now() - startedAt,
      classified,
      bySource,
      clamped,
      inputTokens,
      outputTokens,
      aiCalls,
      aiBudgetSkipped,
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

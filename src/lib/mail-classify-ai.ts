/**
 * Classification sémantique par modèle — appelée UNIQUEMENT via
 * `classifyHybrid` (synchro Gmail et scripts manuels). C'est le seul appel à un
 * LLM de l'application ; chaque requête envoyée est consignée dans le registre
 * de consommation (`ai-usage.ts`).
 *
 * Minimisation des données — c'est la partie qui compte :
 *
 *   ENVOYÉ  : objet, dernier message utile nettoyé (tronqué), au plus deux
 *             messages de contexte réduits à 400 caractères, stade Salesforce,
 *             confiance forecast si connue.
 *   JAMAIS  : fil complet, pièces jointes, signatures, historique, adresses
 *             e-mail, noms de clients, numéros de téléphone.
 *
 * Rien de ce qui est envoyé n'est stocké en base. La réponse seule l'est, et
 * seulement sous forme structurée.
 */

import { recordAiCall, type AiOrigin } from "./ai-usage";
import { acceptProof, selectInterestProof } from "./interest-proof";
import type { Classification, ClassifiableMessage, SignalType } from "./mail-classify";

/** Modèle visé : le plus petit qui sache lire une nuance commerciale. */
export const AI_MODEL = "claude-haiku-4-5-20251001";

/**
 * Échec du modèle, décrit SANS contenu : fournisseur, modèle, statut HTTP et
 * type d'erreur. C'est tout ce qui est journalisé (jamais la clé, jamais le
 * texte d'un email). Panne du 14/09/2026 : 400 `invalid_request_error`, crédit
 * du compte API épuisé — restée invisible parce que ce motif était avalé.
 */
export class ClassifierUnavailableError extends Error {
  // Champs déclarés puis affectés (harnais sous --experimental-strip-types).
  readonly status: number | null;
  readonly errorType: string;

  constructor(message: string, status: number | null = null, errorType = "indisponible") {
    super(message);
    this.name = "ClassifierUnavailableError";
    this.status = status;
    this.errorType = errorType;
  }
}

/** Motif de repli, sûr à journaliser : « anthropic/<modèle> 400 invalid_request_error — … ». */
export function fallbackLabel(cause: unknown): string {
  if (cause instanceof ClassifierUnavailableError) {
    return `anthropic/${AI_MODEL} ${cause.status ?? "—"} ${cause.errorType}${cause.status != null ? ` — ${cause.message.slice(0, 90)}` : ""}`;
  }
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/délai de \d+ ms dépassé/.test(text)) return `anthropic/${AI_MODEL} — timeout`;
  return `anthropic/${AI_MODEL} — ${cause instanceof Error ? cause.name : "erreur"} (réseau ou exception)`;
}

// --- Nettoyage et minimisation ---------------------------------------------

const SIGNATURE_BLOCK =
  /(cordialement|bien (à|a) vous|bonne (journée|réception)|sentiments? d[ée]vou[ée]s?|envoy[ée] (à|a) partir de|sent from|--\s*$)/i;

/** Retire citation, bloc de signature et coordonnées. */
export function cleanForModel(text: string): string {
  let cleaned = text
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

  // Citation du message précédent.
  const quote = cleaned.search(
    /\bLe \d{1,2} (janv|f[ée]vr|mars|avril|mai|juin|juil|ao[ûu]t|sept|oct|nov|d[ée]c)|\bLe (lun|mar|mer|jeu|ven|sam|dim)\.|\bOn \w{3}, \w{3} \d|From: |De : |-----Message d'origine/,
  );
  if (quote > 40) cleaned = cleaned.slice(0, quote);

  // Bloc de signature.
  const signature = cleaned.search(SIGNATURE_BLOCK);
  if (signature > 60) cleaned = cleaned.slice(0, signature);

  // Coordonnées : inutiles à la classification, sensibles hors de chez nous.
  cleaned = cleaned
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[adresse]")
    .replace(/(?:\+33|0)\s?[1-9](?:[\s.-]?\d{2}){4}/g, "[téléphone]")
    .replace(/https?:\/\/\S+/g, "[lien]");

  return cleaned.replace(/\s+/g, " ").trim();
}

export type ThreadContext = {
  /** Stade Salesforce de l'opportunité rattachée, s'il y en a une. */
  stage?: string | null;
  /** Confiance déclarée au forecast, entre 0 et 1. */
  forecastConfidence?: number | null;
  /** Qui déclenche l'appel, pour le registre de consommation. Jamais envoyé au modèle. */
  origin?: AiOrigin;
};

export type ModelPayload = {
  subject: string;
  lastMessage: string;
  lastDirection: string;
  context: string[];
  stage: string | null;
  forecastConfidence: number | null;
};

const MAX_LAST = 1200;
const MAX_CONTEXT = 400;

/**
 * Construit exactement ce qui partirait au modèle. Exporté pour être affiché
 * et audité sans rien envoyer.
 */
export function buildPayload(
  messages: ClassifiableMessage[],
  context: ThreadContext = {},
): ModelPayload {
  const ordered = [...messages].sort((a, b) => a.date.localeCompare(b.date));
  const last = ordered[ordered.length - 1];
  // Au plus deux messages antérieurs, très courts : de quoi lever une
  // ambiguïté de chronologie, pas de quoi reconstituer la conversation.
  const previous = ordered.slice(-3, -1);

  return {
    subject: cleanForModel(last.subject ?? "").slice(0, 200),
    lastMessage: cleanForModel(last.snippet ?? "").slice(0, MAX_LAST),
    lastDirection: last.direction,
    context: previous.map((m) => cleanForModel(m.snippet ?? "").slice(0, MAX_CONTEXT)),
    stage: context.stage ?? null,
    forecastConfidence: context.forecastConfidence ?? null,
  };
}

// --- Consigne ---------------------------------------------------------------

export const SYSTEM_PROMPT = `Tu classes des échanges commerciaux d'un courtier en travaux de rénovation.

Rends UNIQUEMENT un objet JSON, sans texte autour :
{"signal_type": ..., "confidence": ..., "blocker": ..., "summary": ..., "reason": ..., "quote": ...}

signal_type vaut exactement l'une de ces valeurs :
- "signature"      : engagement réel ou dernière étape avant engagement (bon pour accord, validation explicite, demande de lien de signature, de facture d'acompte ou de RIB pour régler, dernière correction avant signature, choix explicite de nous retenir).
- "positif_bloque" : client favorable mais un obstacle subsiste (accord de principe, attente de financement ou de copropriété, document manquant, modification technique, planning à confirmer, audit ou étude externe en attente, décision suspendue à un dernier élément).
- "risque"         : le projet existe toujours mais la probabilité de signer se dégrade (prix jugé élevé, demande de remise, mise en concurrence, hésitation, report, rendez-vous annulé, changement important de périmètre).
- "negatif"        : perte ou abandon explicite (concurrent retenu, projet abandonné, financement définitivement refusé, refus, demande de ne plus être contacté).
- "neutre"         : information commerciale utile, sans effet clair sur la probabilité de signature.

Règles impératives :
1. Un accord CONDITIONNÉ n'est jamais "signature". « C'est d'accord sous réserve du financement » vaut "positif_bloque".
2. Une demande de dernière correction avant signature PEUT valoir "signature" : « avant de signer, corrigez cette ligne » est un client qui va signer.
3. Une hésitation n'est jamais "negatif". « Nous réfléchissons encore » vaut "risque".
4. Un rendez-vous annulé vaut "risque", pas "negatif" — sauf refus explicite accompagnant l'annulation.
5. Ne déduis jamais rien de l'absence de message. Tu ne juges que ce qui est écrit ; le silence n'est pas un signal.
6. Le dernier signal client pertinent prime sur les précédents. MAIS un dernier message purement logistique ou technique (« voici les documents en pièce jointe », « bien reçu », « voici le lien ») n'efface PAS un signal commercial fort porté par le message précédent : dans ce cas, classe d'après ce signal antérieur.
7. Distingue l'auteur : un client, un commercial de l'équipe, ou une notification automatique. Une information interne ou technique ne devient jamais un signal client. En revanche, un commercial qui rapporte un fait sur l'affaire (« promesse signée ») est une information recevable.
8. Si le contexte est ambigu, BAISSE la confidence plutôt que d'inventer une catégorie. "neutre" avec une confidence basse est une bonne réponse.
9. confidence est un nombre entre 0 et 1. blocker est une courte étiquette ou null.
10. summary fait au plus 90 caractères. reason au plus 120 caractères.
11. Ne traite comme signal commercial que ce qui vient d'un PROSPECT ou d'un CLIENT au sujet d'une affaire commerciale active ou d'une nouvelle opportunité crédible. Les messages d'artisans, de fournisseurs, d'architectes, de partenaires, de prestataires, ainsi que le démarchage adressé à Renovation Man (logiciel, référencement, recrutement, partenariat non demandé), sont "neutre" avec une confidence basse — quelle que soit leur urgence apparente.
12. Un suivi d'exécution de chantier déjà signé — service après-vente, malfaçon, planning de travaux, règlement d'échéance — n'est pas un signal commercial. Il vaut "neutre", sauf si le message annonce explicitement un NOUVEAU projet.
13. Le summary doit TOUJOURS dire ce que le client DEMANDE quand il demande quelque chose, avec le verbe de demande et son objet : « demande le devis », « demande un planning prévisionnel », « demande un rendez-vous », « demande une modification du devis ». Une demande formulée platement compte autant qu'une demande enthousiaste : « pouvez-vous m'envoyer le devis » exige une action, même sans aucun mot chaleureux. À l'inverse, si le client ne fait qu'accuser réception, dis-le : « accuse réception du devis, sans demande ».
14. Ne confonds pas la tonalité et l'action. Un message neutre qui demande quelque chose reste une demande ; un message chaleureux qui ne demande rien n'en est pas une.
15. quote est la PREUVE D'INTÉRÊT : la phrase du DERNIER message qui prouve que le client est intéressé, engagé ou proche d'avancer, recopiée MOT POUR MOT depuis le texte fourni, au plus 160 caractères, sans rien reformuler ni compléter. Ordre de priorité : (1) engagement concret — « je souhaite avancer », « on valide », « je veux signer », « envoyez-moi le document », « bloquez-moi la date », « nous allons partir avec vous » ; (2) intention forte — « votre proposition nous convient », « nous sommes décidés », « nous préférons travailler avec vous » ; (3) condition de décision — « si vous confirmez X, nous avançons » ; (4) question de closing — disponibilité artisan, date de démarrage, signature, financement, acte authentique, planning ; (5) à défaut seulement, la phrase la plus engageante. Ne choisis JAMAIS une formule de politesse, un accusé de réception, une phrase neutre, une signature automatique ni un texte administratif. null si aucune phrase ne prouve un intérêt, ou si l'auteur n'est pas le client.`;

export function buildUserMessage(payload: ModelPayload): string {
  const lines = [
    `Objet : ${payload.subject}`,
    `Dernier message (${payload.lastDirection}) : ${payload.lastMessage}`,
  ];
  if (payload.context.length > 0) {
    lines.push(`Contexte antérieur bref : ${payload.context.join(" | ")}`);
  }
  if (payload.stage) lines.push(`Stade Salesforce : ${payload.stage}`);
  if (payload.forecastConfidence != null) {
    lines.push(`Confiance forecast : ${payload.forecastConfidence}`);
  }
  return lines.join("\n");
}

// --- Appel ------------------------------------------------------------------

const VALID: SignalType[] = ["signature", "positif_bloque", "risque", "negatif", "neutre"];

const foldForMatch = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u00b4`]/g, "'")
    .replace(/[\u00ab\u00bb"\u201c\u201d]/g, "")
    .replace(/[^a-z0-9?!' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Une citation n'est retenue QUE si elle figure réellement dans le texte
 * envoyé au modèle. C'est la garde contre la phrase inventée : le modèle
 * propose, le texte d'origine dispose. Comparaison tolérante à la casse, aux
 * accents et à la ponctuation, jamais au contenu.
 */
export function verifyQuote(candidate: unknown, source: string): string | null {
  if (typeof candidate !== "string") return null;
  const quote = candidate
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\u00ab"\u201c\s]+|[\u00bb"\u201d\s]+$/g, "");
  if (quote.length < 8) return null;
  const folded = foldForMatch(quote);
  if (!folded || !foldForMatch(source).includes(folded)) return null;
  return quote.slice(0, 160);
}

/**
 * Appelle le modèle. Lève si aucune clé n'est configurée — jamais de clé en
 * dur, jamais de repli silencieux sur un autre fournisseur.
 */
export type ModelCall = {
  classification: Classification;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

/** Variante mesurée : renvoie aussi la consommation et la latence réelles. */
export async function classifyWithModelDetailed(
  messages: ClassifiableMessage[],
  context: ThreadContext = {},
  /** Annulation RÉELLE de la requête HTTP (délai dépassé) : aucun appel orphelin. */
  signal?: AbortSignal,
): Promise<ModelCall> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClassifierUnavailableError(
      "ANTHROPIC_API_KEY absente. Ajoutez-la à .env.local pour activer la variante modèle.",
      null,
      "cle_absente",
    );
  }

  const payload = buildPayload(messages, context);
  const startedAt = Date.now();
  const origin = context.origin ?? "verification";
  const noUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  let status = 0;
  let body: {
    content?: { text?: string }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 400,
        // Classification, pas rédaction : on veut le même verdict à chaque
        // appel, sinon la mesure n'est pas reproductible.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(payload) }],
      }),
      signal,
    });
    status = response.status;

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: { type?: string; message?: string };
      } | null;
      // Le message d'erreur de l'API ne contient ni la clé ni le contenu envoyé.
      throw new ClassifierUnavailableError(
        detail?.error?.message ?? "erreur",
        response.status,
        detail?.error?.type ?? "http_error",
      );
    }
    body = (await response.json()) as typeof body;
  } catch (cause) {
    // Requête envoyée puis refusée, annulée (délai dépassé) ou coupée : comptée
    // comme appel en échec, sans tokens — aucun n'a été rapporté par l'API.
    recordAiCall(AI_MODEL, origin, false, noUsage);
    throw cause;
  }
  const latencyMs = Date.now() - startedAt;
  const usage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    cacheCreationTokens: body.usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
  };
  const raw = body.content?.[0]?.text ?? "";
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    recordAiCall(AI_MODEL, origin, false, usage);
    throw new ClassifierUnavailableError("Réponse du modèle illisible (JSON invalide).", status, "reponse_illisible");
  }

  const signalType = VALID.includes(parsed.signal_type as SignalType)
    ? (parsed.signal_type as SignalType)
    : "neutre";
  const ordered = [...messages].sort((a, b) => a.date.localeCompare(b.date));
  recordAiCall(AI_MODEL, origin, true, usage);

  return {
    classification: {
      signalType,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
      blocker: (parsed.blocker as string) || null,
      summary: String(parsed.summary ?? "").slice(0, 120),
      reason: String(parsed.reason ?? "").slice(0, 160),
      signalAt: ordered[ordered.length - 1].date,
      classifier: AI_MODEL,
      // Le modèle propose ; la citation doit figurer dans le texte ET prouver
      // un intérêt au sens des règles. Sinon, la sélection par règles sur le
      // même texte fait foi — jamais une phrase inventée ni une politesse.
      quote:
        acceptProof(verifyQuote(parsed.quote, `${payload.subject} ${payload.lastMessage}`))?.quote ??
        selectInterestProof(payload.lastMessage)?.quote ??
        null,
    },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs,
  };
}

/** Classification seule, sans instrumentation. */
export async function classifyWithModel(
  messages: ClassifiableMessage[],
  context: ThreadContext = {},
): Promise<Classification> {
  return (await classifyWithModelDetailed(messages, context)).classification;
}

/**
 * Classification sémantique par modèle — VARIANTE B. PRÉPARÉE, NON BRANCHÉE.
 *
 * Ce module n'est appelé par aucune page, aucune route, aucun import de
 * l'application. Il existe pour être mesuré face aux règles, et pour que le
 * jour où la comparaison justifie un modèle, il ne reste qu'à l'appeler.
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

import type { Classification, ClassifiableMessage, SignalType } from "./mail-classify";

/** Modèle visé : le plus petit qui sache lire une nuance commerciale. */
export const AI_MODEL = "claude-haiku-4-5-20251001";

export class ClassifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierUnavailableError";
  }
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
{"signal_type": ..., "confidence": ..., "blocker": ..., "summary": ..., "reason": ...}

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
14. Ne confonds pas la tonalité et l'action. Un message neutre qui demande quelque chose reste une demande ; un message chaleureux qui ne demande rien n'en est pas une.`;

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
): Promise<ModelCall> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClassifierUnavailableError(
      "ANTHROPIC_API_KEY absente. Ajoutez-la à .env.local pour activer la variante modèle.",
    );
  }

  const payload = buildPayload(messages, context);
  const startedAt = Date.now();
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
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ClassifierUnavailableError(
      `Le modèle a répondu ${response.status} — ${detail?.error?.message ?? "erreur"}`,
    );
  }

  const body = (await response.json()) as {
    content?: { text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const latencyMs = Date.now() - startedAt;
  const raw = body.content?.[0]?.text ?? "";
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new ClassifierUnavailableError("Réponse du modèle illisible (JSON invalide).");
  }

  const signalType = VALID.includes(parsed.signal_type as SignalType)
    ? (parsed.signal_type as SignalType)
    : "neutre";
  const ordered = [...messages].sort((a, b) => a.date.localeCompare(b.date));

  return {
    classification: {
      signalType,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
      blocker: (parsed.blocker as string) || null,
      summary: String(parsed.summary ?? "").slice(0, 120),
      reason: String(parsed.reason ?? "").slice(0, 160),
      signalAt: ordered[ordered.length - 1].date,
      classifier: AI_MODEL,
    },
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
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

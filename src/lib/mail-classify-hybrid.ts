/**
 * Classification hybride bridée — VARIANTE D, celle retenue en production.
 *
 * Mesurée sur le corpus annoté, restreint aux affaires rattachées à une
 * opportunité (les seules qui influencent le Morning Brief) :
 *   règles seules     18/20 = 90 %   positif_bloque 7/9
 *   hybride bridé     19/20 = 95 %   positif_bloque 9/9, précision 100 %
 *
 * Trois principes, dans cet ordre :
 *
 *   1. AUTORITÉ DES RÈGLES. Seules les règles locales peuvent prononcer
 *      `signature` ou `negatif`. Ce sont les deux verdicts qui déclenchent les
 *      décisions les plus lourdes, et les règles y sont à 100 % de précision.
 *      Si le modèle propose l'un des deux, sa promotion est ignorée.
 *
 *   2. ESCALADE ÉTROITE. Le modèle n'est appelé que là où les règles sont
 *      faibles : verdict `neutre`, ou confiance ≤ 0,6. Ailleurs, aucun appel,
 *      aucun coût, aucune donnée qui sort.
 *
 *   3. REPLI SYSTÉMATIQUE. Toute défaillance du modèle — délai dépassé, JSON
 *      invalide, erreur API, quota, indisponibilité — rend la main aux règles.
 *      Ni la synchronisation Gmail ni le Morning Brief ne peuvent être bloqués
 *      par l'indisponibilité d'un service tiers.
 */

import { classifyThread, type Classification, type ClassifiableMessage } from "./mail-classify";
import {
  classifyWithModelDetailed,
  fallbackLabel,
  isPermanentProviderError,
  type ThreadContext,
} from "./mail-classify-ai";
import { isAutomaticNotification } from "./mail-rules";

/** Seuil d'escalade. Au-dessus, le verdict des règles est jugé assez sûr. */
export const ESCALATION_CONFIDENCE = 0.6;

/**
 * Délai au-delà duquel on renonce au modèle et on garde les règles. La requête
 * HTTP est alors réellement ANNULÉE (AbortController) : aucun appel orphelin ne
 * continue — ni facturé, ni consommé — après le repli.
 */
export const MODEL_TIMEOUT_MS = 8000;

export type ClassificationSource = "rules" | "model" | "rules_fallback";

export type HybridResult = {
  classification: Classification;
  /** D'où vient réellement le verdict retenu. */
  source: ClassificationSource;
  /** Le modèle a-t-il été appelé ? */
  escalated: boolean;
  /** Sa promotion en `signature`/`negatif` a-t-elle été refusée ? */
  clamped: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Motif du repli, quand il y en a un. Jamais la charge utile. */
  fallbackReason: string | null;
};

const EMPTY = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };

/** Motif de repli quand le budget d'appels d'un passage est épuisé. */
export const AI_BUDGET_REACHED = "budget IA de la synchronisation atteint";

/** Motif de repli quand le coupe-circuit du passage est ouvert. */
export const AI_PROVIDER_HALTED = "appels IA suspendus pour cette synchronisation";

/**
 * Budget d'appels au modèle, partagé par tous les fils d'un même passage.
 * Décrémenté AVANT l'appel (tentative comptée, même si elle échoue) ; la
 * lecture et l'écriture sont synchrones, donc sûres malgré la concurrence.
 *
 * Coupe-circuit : une erreur PERMANENTE du fournisseur (crédit épuisé, clé
 * invalide ou sans droits) ouvre `halted` — plus aucun appel pour le reste du
 * passage, les fils restants prennent le repli des règles (provisoire, donc
 * repris au passage suivant). Tant qu'aucune réponse n'a confirmé que le
 * fournisseur accepte nos requêtes (`verified`), les appels passent UN PAR UN
 * (`gate`) : sans cela, les fils classés en parallèle enverraient plusieurs
 * requêtes vouées au même refus avant que le premier ne revienne. Une erreur
 * transitoire (délai, 5xx, réseau) n'ouvre pas le coupe-circuit.
 */
export type ModelBudget = {
  remaining: number;
  halted?: string | null;
  verified?: boolean;
  gate?: Promise<void>;
};

export function newModelBudget(remaining: number): ModelBudget {
  return { remaining, halted: null, verified: false };
}

/**
 * Classe l'état courant d'un fil. Ne lève jamais : en cas de problème, le
 * verdict des règles est renvoyé avec `source: "rules_fallback"`.
 */
export async function classifyHybrid(
  messages: ClassifiableMessage[],
  context: ThreadContext = {},
  budget?: ModelBudget,
): Promise<HybridResult | null> {
  const rules = classifyThread(messages);
  if (!rules) return null;

  const needsModel =
    rules.signalType === "neutre" || rules.confidence <= ESCALATION_CONFIDENCE;

  if (!needsModel) {
    return {
      classification: { ...rules, classifier: "rules" },
      source: "rules",
      escalated: false,
      clamped: false,
      ...EMPTY,
      fallbackReason: null,
    };
  }

  // Notification automatique certaine (gabarit Salesforce) : les règles
  // suffisent, le modèle n'a rien à y lire.
  const last = [...messages].sort((a, b) => a.date.localeCompare(b.date)).pop();
  if (last && isAutomaticNotification(last)) {
    return {
      classification: { ...rules, classifier: "rules" },
      source: "rules",
      escalated: false,
      clamped: false,
      ...EMPTY,
      fallbackReason: null,
    };
  }

  if (!budget) return callModel(messages, context, rules);
  if (budget.verified) return guardedCall(messages, context, rules, budget);

  // Fournisseur pas encore confirmé dans ce passage : un appel à la fois.
  const previous = budget.gate ?? Promise.resolve();
  let release: () => void = () => {};
  budget.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  if (budget.verified) {
    // Confirmé pendant l'attente : inutile de faire patienter les suivants.
    release();
    return guardedCall(messages, context, rules, budget);
  }
  try {
    return await guardedCall(messages, context, rules, budget);
  } finally {
    release();
  }
}

function rulesFallback(rules: Classification, reason: string): HybridResult {
  return {
    classification: { ...rules, classifier: "rules_fallback" },
    source: "rules_fallback",
    escalated: false,
    clamped: false,
    ...EMPTY,
    fallbackReason: reason,
  };
}

/** Appel soumis au coupe-circuit et au budget du passage. */
async function guardedCall(
  messages: ClassifiableMessage[],
  context: ThreadContext,
  rules: Classification,
  budget: ModelBudget,
): Promise<HybridResult> {
  if (budget.halted) return rulesFallback(rules, AI_PROVIDER_HALTED);
  // Garde-fou de coût : budget épuisé → verdict des règles, aucun appel.
  if (budget.remaining <= 0) return rulesFallback(rules, AI_BUDGET_REACHED);
  budget.remaining -= 1;
  return callModel(messages, context, rules, budget);
}

async function callModel(
  messages: ClassifiableMessage[],
  context: ThreadContext,
  rules: Classification,
  budget?: ModelBudget,
): Promise<HybridResult> {
  const controller = new AbortController();
  try {
    const call = await withTimeout(
      classifyWithModelDetailed(messages, context, controller.signal),
      MODEL_TIMEOUT_MS,
      () => controller.abort(),
    );
    if (budget) budget.verified = true;

    // Bridage : le modèle n'a pas autorité pour prononcer une signature ni
    // une perte. Sa proposition est écartée, le verdict des règles reprend.
    if (call.classification.signalType === "signature" || call.classification.signalType === "negatif") {
      return {
        classification: { ...rules, classifier: "rules" },
        source: "rules",
        escalated: true,
        clamped: true,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        latencyMs: call.latencyMs,
        fallbackReason: null,
      };
    }

    return {
      classification: call.classification,
      source: "model",
      escalated: true,
      clamped: false,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
      fallbackReason: null,
    };
  } catch (cause) {
    if (budget) {
      if (isPermanentProviderError(cause)) {
        // Crédit épuisé, clé refusée : inutile d'insister dans ce passage.
        budget.halted = fallbackLabel(cause);
      } else {
        // Délai, 5xx, réponse illisible, coupure réseau : rien de permanent.
        // Le parallélisme reprend (sérialiser un fournisseur lent coûterait
        // 8 s par fil sans rien protéger).
        budget.verified = true;
      }
    }
    // Toute défaillance rend la main aux règles, sans interrompre l'appelant.
    return {
      classification: { ...rules, classifier: "rules_fallback" },
      source: "rules_fallback",
      escalated: true,
      clamped: false,
      ...EMPTY,
      // Motif sûr (fournisseur, modèle, statut, type) : jamais la clé ni le texte.
      fallbackReason: fallbackLabel(cause),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Motif d'abord (le repli est étiqueté « timeout »), annulation ensuite.
      reject(new Error(`délai de ${ms} ms dépassé`));
      onTimeout();
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

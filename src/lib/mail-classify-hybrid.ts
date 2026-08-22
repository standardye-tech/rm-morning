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
import { classifyWithModelDetailed, type ThreadContext } from "./mail-classify-ai";

/** Seuil d'escalade. Au-dessus, le verdict des règles est jugé assez sûr. */
export const ESCALATION_CONFIDENCE = 0.6;

/** Délai au-delà duquel on renonce au modèle et on garde les règles. */
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

/**
 * Classe l'état courant d'un fil. Ne lève jamais : en cas de problème, le
 * verdict des règles est renvoyé avec `source: "rules_fallback"`.
 */
export async function classifyHybrid(
  messages: ClassifiableMessage[],
  context: ThreadContext = {},
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

  try {
    const call = await withTimeout(
      classifyWithModelDetailed(messages, context),
      MODEL_TIMEOUT_MS,
    );

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
    // Toute défaillance rend la main aux règles, sans interrompre l'appelant.
    return {
      classification: { ...rules, classifier: "rules_fallback" },
      source: "rules_fallback",
      escalated: true,
      clamped: false,
      ...EMPTY,
      fallbackReason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`délai de ${ms} ms dépassé`)), ms);
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

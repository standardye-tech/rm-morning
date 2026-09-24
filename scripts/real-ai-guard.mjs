/**
 * Garde-fou des scripts de vérification : AUCUN appel réel à Anthropic sans
 * autorisation explicite.
 *
 *   ALLOW_REAL_AI_CALLS=1 npm run …     autorise les appels réels (facturés)
 *
 * Sans cette variable, toute requête vers api.anthropic.com est interceptée
 * AVANT de partir et échoue comme une panne du modèle : le code testé prend son
 * repli sur les règles, exactement comme en production pendant une panne. Rien
 * ne sort, rien n'est facturé.
 *
 * `mail:model-check` et `mail:reclassify` ne passent PAS par ici : ce sont des
 * opérations réelles, lancées à la main et documentées comme telles.
 */

export const REAL_AI_ALLOWED = process.env.ALLOW_REAL_AI_CALLS === "1";

/** Installe le garde-fou ; renvoie true si les appels réels sont autorisés. */
export function guardRealAiCalls(scriptName) {
  if (REAL_AI_ALLOWED) {
    console.log(`[${scriptName}] ALLOW_REAL_AI_CALLS=1 : appels Anthropic RÉELS autorisés (facturés).`);
    return true;
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url instanceof Request ? url.url : url).includes("api.anthropic.com")) {
      throw new Error("appel Anthropic bloqué par le garde-fou des scripts (ALLOW_REAL_AI_CALLS absent)");
    }
    return realFetch(url, init);
  };
  console.log(
    `[${scriptName}] appels Anthropic réels BLOQUÉS — le modèle est remplacé par son repli. ` +
      "ALLOW_REAL_AI_CALLS=1 pour les autoriser.",
  );
  return false;
}

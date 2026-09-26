/**
 * Comptage et affichage de `mail:model-check` — séparés du script pour être
 * testés (`npm run mail:model-check-verify`).
 *
 * Piège corrigé le 26/09/2026 : un verdict du modèle écarté au profit des
 * règles (promotion en signature/négatif refusée) revient avec
 * `source: "rules"`. L'appel a pourtant eu lieu. Le compter comme « sans appel »
 * annonçait 18 appels quand le registre de consommation en consignait 19.
 * On lit donc `escalated`/`clamped`, jamais `source` seul, et le nombre
 * d'appels vient des requêtes réellement envoyées, pas d'une déduction.
 */

export function newModelCheckTally() {
  return {
    tested: 0,
    /** Réponses du modèle reçues et exploitées (verdict retenu ou écarté). */
    modelOk: 0,
    /** Verdict du modèle retenu. */
    modelKept: 0,
    /** Verdict du modèle écarté au profit des règles — appel bien effectué. */
    modelDiscarded: 0,
    /** Repli sur les règles après échec du modèle (erreur, délai, réponse illisible). */
    fallbacks: 0,
    /** Fils classés par les règles sans aucun appel IA. */
    noCall: 0,
    /** Lecture Gmail impossible : fil non testé. */
    readErrors: 0,
    /** Motif → nombre. Motifs sûrs (fournisseur, modèle, statut, type) : jamais de contenu. */
    reasons: new Map(),
  };
}

/** Consigne le résultat de `classifyHybrid` pour un fil (null : aucun verdict, fil ignoré). */
export function tallyResult(tally, result) {
  if (!result) return;
  tally.tested += 1;
  if (result.source === "rules_fallback") {
    tally.fallbacks += 1;
  } else if (result.escalated) {
    tally.modelOk += 1;
    if (result.clamped) tally.modelDiscarded += 1;
    else tally.modelKept += 1;
  } else {
    tally.noCall += 1;
  }
  if (result.fallbackReason) addReason(tally, result.fallbackReason);
}

export function tallyReadError(tally, error) {
  tally.readErrors += 1;
  addReason(tally, `lecture Gmail : ${error instanceof Error ? error.name : "erreur"}`);
}

function addReason(tally, reason) {
  tally.reasons.set(reason, (tally.reasons.get(reason) ?? 0) + 1);
}

/**
 * Enveloppe `fetch` pour compter les requêtes réellement envoyées à Anthropic,
 * réussies ou non. Renvoie un compteur lu à la fin du contrôle.
 */
export function countAnthropicRequests() {
  const counter = { requests: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (String(url instanceof Request ? url.url : url).includes("api.anthropic.com")) counter.requests += 1;
    return realFetch(url, init);
  };
  return counter;
}

/** Lignes du rapport. `requests` : requêtes Anthropic réellement envoyées. */
export function formatModelCheckReport(tally, requests) {
  const lines = [
    `fils testés ${tally.tested} | erreurs de lecture Gmail ${tally.readErrors}`,
    `appels Anthropic effectués ${requests}`,
    `  réponses réussies ${tally.modelOk} (verdict retenu ${tally.modelKept} | verdict écarté au profit des règles ${tally.modelDiscarded})`,
    `  replis sur les règles après échec du modèle ${tally.fallbacks}`,
    `classés sans aucun appel IA ${tally.noCall}`,
  ];
  if (requests > 0) lines.push(`taux de succès des appels : ${Math.round((tally.modelOk / requests) * 100)} %`);
  // Chaque réponse exploitée est une requête envoyée : l'inverse trahirait un
  // comptage faux. (Un repli peut n'avoir envoyé aucune requête : clé absente.)
  if (tally.modelOk > requests || requests > tally.modelOk + tally.fallbacks) {
    lines.push(`ÉCART : ${requests} requête(s) envoyée(s) pour ${tally.modelOk} réponse(s) et ${tally.fallbacks} repli(s)`);
  }
  for (const [reason, n] of tally.reasons) lines.push(`  motif : ${reason} — ${n}`);
  return lines;
}

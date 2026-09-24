/**
 * Consommation IA — registre agrégé et SEUL endroit où vivent les tarifs.
 *
 * Tout appel à un modèle passe par `recordAiCall` (aujourd'hui : le scanner
 * email, `mail-classify-ai.ts`). Seuls des compteurs sont conservés, par jour
 * (Europe/Paris), modèle et origine : jamais de contenu d'email, d'adresse ni
 * de clé.
 *
 * Le coût n'est pas stocké : il est recalculé à la lecture à partir des
 * tokens. Changer un tarif ici corrige donc aussi l'historique affiché.
 */

import { parisDate } from "./business-time";
import { getDb, queryAll } from "./db";

/**
 * Tarifs publics Anthropic, en dollars par million de tokens (tarif API
 * direct, relevé le 24/09/2026). Écriture en cache : ×1,25 du tarif d'entrée
 * (TTL 5 min) ; lecture en cache : ×0,1.
 */
export const AI_PRICING_USD_PER_MTOK: Record<
  string,
  { label: string; input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-haiku-4-5-20251001": { label: "Haiku 4.5", input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

/** Coût en dollars ; `null` si le modèle n'a pas de tarif connu — jamais un zéro inventé. */
export function aiCostUsd(model: string, usage: AiUsage): number | null {
  const price = AI_PRICING_USD_PER_MTOK[model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheCreationTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
    1_000_000
  );
}

/** Origine de l'appel : synchro de l'application ou script lancé à la main. */
export type AiOrigin = "synchro" | "retraitement" | "controle" | "verification";

/**
 * Consigne un appel envoyé. `ok: false` = la requête est partie mais a échoué
 * (erreur HTTP, réponse illisible) : elle compte comme appel, tokens à zéro
 * sauf si l'API en a facturé. Ne lève jamais : le registre ne doit pas pouvoir
 * casser une classification.
 */
export function recordAiCall(model: string, origin: AiOrigin, ok: boolean, usage: AiUsage, now = new Date()): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_usage_daily
           (day, model, origin, calls, failures, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
         VALUES (?,?,?,1,?,?,?,?,?)
         ON CONFLICT(day, model, origin) DO UPDATE SET
           calls = calls + 1,
           failures = failures + excluded.failures,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens`,
      )
      .run(
        parisDate(now),
        model,
        origin,
        ok ? 0 : 1,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationTokens,
        usage.cacheReadTokens,
      );
  } catch {
    // Registre indisponible (base en lecture seule, verrou) : l'appel a eu
    // lieu quand même, la classification continue.
  }
}

export type AiUsageTotals = AiUsage & {
  calls: number;
  failures: number;
  /** `null` si au moins un modèle consommé n'a pas de tarif connu. */
  costUsd: number | null;
};

function totals(rows: Record<string, unknown>[]): AiUsageTotals {
  const t: AiUsageTotals = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  for (const r of rows) {
    const usage: AiUsage = {
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheCreationTokens: Number(r.cache_creation_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
    };
    t.calls += Number(r.calls);
    t.failures += Number(r.failures);
    t.inputTokens += usage.inputTokens;
    t.outputTokens += usage.outputTokens;
    t.cacheCreationTokens += usage.cacheCreationTokens;
    t.cacheReadTokens += usage.cacheReadTokens;
    const cost = aiCostUsd(String(r.model), usage);
    t.costUsd = cost == null || t.costUsd == null ? null : t.costUsd + cost;
  }
  return t;
}

/** Consommation du jour et du mois en cours (heure de Paris), tous modèles et origines. */
export function aiUsageSummary(now = new Date()): { models: string[]; today: AiUsageTotals; month: AiUsageTotals } {
  const day = parisDate(now);
  const rows = queryAll<Record<string, unknown>>(
    "SELECT * FROM ai_usage_daily WHERE day LIKE ?",
    `${day.slice(0, 7)}-%`,
  );
  return {
    models: [...new Set(rows.map((r) => String(r.model)))],
    today: totals(rows.filter((r) => r.day === day)),
    month: totals(rows),
  };
}

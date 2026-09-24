/**
 * Contrôle du classifieur mail par modèle — pipeline EXACT de la synchro.
 *
 *   npm run mail:model-check              (20 fils récents)
 *   npm run mail:model-check -- 40        (40 fils)
 *
 * Pour chaque fil récent déjà connu en base : relecture Gmail en LECTURE SEULE
 * (métadonnées + extrait, `fetchThreadMessages`), puis `classifyHybrid` — le
 * même appel que la synchronisation. Aucune classification n'est écrite, ni en base ni dans
 * Gmail. Aucun contenu d'email n'est affiché : seulement les compteurs et les
 * motifs de repli (fournisseur, modèle, statut, type d'erreur).
 *
 * COÛT : au plus N appels réels au modèle (un par fil escaladé), consignés
 * dans le registre de consommation IA avec l'origine « controle ».
 *
 * Créé après la panne du 14/09/2026 (crédit API épuisé, 98 % des fils en
 * `rules_fallback` sans aucune trace) : c'est la preuve à rejouer après tout
 * rechargement ou changement de clé.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const limit = Number(process.argv[2] ?? 20);
const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { fetchThreadMessages } = await import(lib("sources/gmail"));
const { classifyHybrid } = await import(lib("mail-classify-hybrid"));

const threads = getDb()
  .prepare(
    `SELECT m.thread_id, MAX(m.sent_at) AS last, MAX(o.stage) AS stage
       FROM mail_signal m LEFT JOIN opportunity o ON o.opportunity_id = m.opportunity_id
      WHERE m.direction = 'entrant'
      GROUP BY m.thread_id ORDER BY last DESC LIMIT ?`,
  )
  .all(limit);

const counts = { tested: 0, model: 0, rules: 0, rules_fallback: 0, errors: 0 };
const reasons = new Map();
for (const t of threads) {
  try {
    const thread = await fetchThreadMessages(t.thread_id);
    const result = await classifyHybrid(thread, { stage: t.stage ?? null, origin: "controle" });
    if (!result) continue;
    counts.tested += 1;
    counts[result.source] += 1;
    if (result.fallbackReason) reasons.set(result.fallbackReason, (reasons.get(result.fallbackReason) ?? 0) + 1);
  } catch (e) {
    counts.errors += 1;
    const r = `lecture Gmail : ${e instanceof Error ? e.name : "erreur"}`;
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
}

const escalated = counts.model + counts.rules_fallback;
console.log(`\nfils testés ${counts.tested} | modèle ${counts.model} | repli ${counts.rules_fallback} | règles sûres (sans appel) ${counts.rules} | erreurs ${counts.errors}`);
if (escalated > 0) console.log(`taux de succès du modèle sur les fils escaladés : ${Math.round((counts.model / escalated) * 100)} %`);
for (const [r, n] of reasons) console.log(`  motif : ${r} — ${n}`);

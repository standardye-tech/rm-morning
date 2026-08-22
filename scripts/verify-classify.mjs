/**
 * Comparaison des trois approches de classification — Passage B, évaluation.
 *
 *   node --experimental-strip-types --experimental-loader ./scripts/ts-resolver.mjs \
 *        --env-file=.env.local scripts/verify-classify.mjs
 *
 *   A. règles déterministes seules      (src/lib/mail-classify.ts)
 *   B. modèle systématique              (src/lib/mail-classify-ai.ts)
 *   C. hybride : règles, puis modèle sur les seuls verdicts `neutre`
 *      ou de confiance ≤ 0,6
 *
 * Référence : scripts/annotations-passage-b.json.
 *
 * LECTURE SEULE. Rien n'est écrit en base. Aucune charge utile n'est
 * journalisée : seuls des compteurs, des identifiants de fil tronqués, des
 * catégories, des latences et des nombres de jetons sortent d'ici.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { classifyThread } = await import(lib("mail-classify"));
const { classifyWithModelDetailed, buildPayload, buildUserMessage, AI_MODEL } = await import(
  lib("mail-classify-ai")
);
const { getAccessToken } = await import(lib("google-oauth"));

/** Tarifs publics Haiku 4.5, en dollars par million de jetons. */
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;

const ESCALATE_CONFIDENCE = 0.6;

const annotations = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "scripts/annotations-passage-b.json"), "utf8"),
);

// --- Reconstitution des fils. Le contenu reste en mémoire.
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const rows = db
  .prepare(
    `SELECT s.gmail_message_id, s.thread_id, s.sent_at, s.subject, s.direction,
            o.stage AS opp_stage
       FROM mail_signal s
       LEFT JOIN opportunity o ON o.opportunity_id = s.opportunity_id
      ORDER BY s.thread_id, s.sent_at`,
  )
  .all();
db.close();

const token = await getAccessToken();
const api = "https://gmail.googleapis.com/gmail/v1/users/me";
const enriched = [];
for (let i = 0; i < rows.length; i += 8) {
  const batch = await Promise.all(
    rows.slice(i, i + 8).map(async (r) => {
      const m = await (
        await fetch(`${api}/messages/${r.gmail_message_id}?format=metadata`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      return { ...r, snippet: m.snippet ?? "" };
    }),
  );
  enriched.push(...batch);
}

const threads = new Map();
for (const r of enriched) {
  if (!threads.has(r.thread_id)) threads.set(r.thread_id, []);
  threads.get(r.thread_id).push({
    id: r.gmail_message_id,
    threadId: r.thread_id,
    date: r.sent_at,
    direction: r.direction,
    subject: r.subject ?? "",
    snippet: r.snippet,
    stage: r.opp_stage,
  });
}

const CATEGORIES = ["signature", "positif_bloque", "risque", "negatif", "neutre"];
const key = (tid) => tid.slice(-6);

const cases = [];
for (const [tid, msgs] of threads) {
  const truth = annotations[key(tid)];
  if (truth) cases.push({ tid, msgs, truth });
}
const scored = cases.filter((c) => c.truth !== "bruit");

// --- A. Règles.
for (const c of cases) c.rules = classifyThread(c.msgs);

// --- B. Modèle systématique.
const usage = { calls: 0, retries: 0, input: 0, output: 0, latencies: [] };
let modelError = null;

/** Trois tentatives : un échec réseau ne doit pas trouer la mesure. */
async function callModel(c) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await classifyWithModelDetailed(c.msgs, { stage: c.msgs[0].stage });
      usage.calls += 1;
      usage.input += result.inputTokens;
      usage.output += result.outputTokens;
      usage.latencies.push(result.latencyMs);
      return result.classification;
    } catch (cause) {
      lastError = cause;
      usage.retries += 1;
      if (attempt === 3) {
        console.log(
          `  [${key(c.tid)}] échec définitif : ${cause instanceof Error ? cause.message : cause}`,
        );
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError;
}

const CONCURRENCY = 4;
async function runAll(items, fn) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          await fn(item);
        } catch (cause) {
          modelError = cause instanceof Error ? cause.message : String(cause);
        }
      }
    }),
  );
}

const wallStart = Date.now();
await runAll(scored, async (c) => {
  c.ai = await callModel(c);
});
const wallMs = Date.now() - wallStart;

// --- C. Hybride : on réutilise la réponse déjà obtenue, sans rappeler l'API.
let escalated = 0;
for (const c of scored) {
  const needsModel =
    c.rules.signalType === "neutre" || c.rules.confidence <= ESCALATE_CONFIDENCE;
  if (needsModel && c.ai) {
    c.hybrid = c.ai;
    escalated += 1;
  } else {
    c.hybrid = c.rules;
  }
}

// --- D. Hybride bridé : même escalade, mais le modèle n'a PAS le droit de
//        promouvoir un fil en `signature` ni de le condamner en `negatif`.
//        Ces deux verdicts restent le monopole des règles, qui y sont à
//        100 % de précision. Le modèle ne peut que nuancer le ventre mou.
let clamped = 0;
for (const c of scored) {
  const needsModel = c.rules.signalType === "neutre" || c.rules.confidence <= ESCALATE_CONFIDENCE;
  if (!needsModel || !c.ai) {
    c.clampedHybrid = c.rules;
    continue;
  }
  if (c.ai.signalType === "signature" || c.ai.signalType === "negatif") {
    c.clampedHybrid = c.rules;
    clamped += 1;
  } else {
    c.clampedHybrid = c.ai;
  }
}

// --- Mesures.
function matrixOf(pick) {
  const m = {};
  for (const t of CATEGORIES) m[t] = {};
  for (const c of scored) {
    const got = pick(c)?.signalType;
    if (!got) continue;
    m[c.truth][got] = (m[c.truth][got] ?? 0) + 1;
  }
  return m;
}

function report(label, pick) {
  const m = matrixOf(pick);
  let correct = 0;
  const errors = [];
  for (const c of scored) {
    const got = pick(c)?.signalType;
    if (!got) continue;
    if (got === c.truth) correct += 1;
    else errors.push({ ...c, got });
  }

  // Dénominateur = fils réellement classés. Un appel manquant ne doit pas
  // gonfler artificiellement le taux d'une variante.
  const counted = scored.filter((c) => pick(c)?.signalType).length;
  console.log(`\n=== ${label} ===`);
  console.log(`  exactitude : ${correct}/${counted} = ${((correct / counted) * 100).toFixed(1)} %`);
  if (counted !== scored.length) {
    console.log(`  ATTENTION : ${scored.length - counted} fil(s) sans verdict du modèle`);
  }
  console.log("\n  matrice (ligne = vérité, colonne = prédit)");
  console.log(`    ${"".padEnd(15)}${CATEGORIES.map((c) => c.slice(0, 6).padStart(8)).join("")}`);
  for (const t of CATEGORIES) {
    console.log(
      `    ${t.padEnd(15)}${CATEGORIES.map((p) => String(m[t][p] ?? "·").padStart(8)).join("")}`,
    );
  }

  console.log("\n  précision / rappel par catégorie");
  for (const t of CATEGORIES) {
    const tp = m[t][t] ?? 0;
    const predicted = CATEGORIES.reduce((s, v) => s + (m[v][t] ?? 0), 0);
    const actual = CATEGORIES.reduce((s, v) => s + (m[t][v] ?? 0), 0);
    const p = predicted ? ((tp / predicted) * 100).toFixed(0) + " %" : "—";
    const r = actual ? ((tp / actual) * 100).toFixed(0) + " %" : "—";
    console.log(
      `    ${t.padEnd(15)} précision ${String(p).padStart(5)} (${tp}/${predicted})   rappel ${String(r).padStart(5)} (${tp}/${actual})`,
    );
  }

  const fpSig = errors.filter((e) => e.got === "signature");
  const fnSig = errors.filter((e) => e.truth === "signature");
  const riskAsNeg = errors.filter((e) => e.truth === "risque" && e.got === "negatif");
  const negAsRisk = errors.filter((e) => e.truth === "negatif" && e.got === "risque");
  const pbAsNeutral = errors.filter((e) => e.truth === "positif_bloque" && e.got === "neutre");

  console.log("\n  erreurs critiques");
  console.log(`    faux positif signature     : ${fpSig.length}`);
  for (const e of fpSig) console.log(`        [${key(e.tid)}] vérité ${e.truth}`);
  console.log(`    faux négatif signature     : ${fnSig.length}`);
  for (const e of fnSig) console.log(`        [${key(e.tid)}] prédit ${e.got}`);
  console.log(`    risque classé négatif      : ${riskAsNeg.length}`);
  console.log(`    négatif classé risque      : ${negAsRisk.length}`);
  console.log(`    positif_bloque → neutre    : ${pbAsNeutral.length}`);
  for (const e of pbAsNeutral) console.log(`        [${key(e.tid)}]`);

  return { correct, errors };
}

console.log(`\nModèle : ${AI_MODEL}`);
console.log(`Échantillon : ${cases.length} fils annotés, ${scored.length} classables`);
if (modelError) console.log(`Erreur modèle rencontrée : ${modelError}`);

const A = report("A — RÈGLES SEULES", (c) => c.rules);
const B = report(`B — ${AI_MODEL} SYSTÉMATIQUE`, (c) => c.ai);
const C = report(`C — HYBRIDE (escalade si neutre ou confiance ≤ ${ESCALATE_CONFIDENCE})`, (c) => c.hybrid);
const D = report(
  "D — HYBRIDE BRIDÉ (le modèle ne peut ni promouvoir en signature, ni condamner en negatif)",
  (c) => c.clampedHybrid,
);
void D;

// --- Population réellement exploitable par le Morning Brief : un fil non
//     rattaché à une opportunité ne peut produire aucune action nommée.
//     C'est sur cette population que la comparaison décide vraiment.
const attached = scored.filter((c) => c.msgs.some((m) => m.stage));
console.log(
  `\n=== Restreint aux fils RATTACHÉS à une opportunité (${attached.length}/${scored.length}) ===`,
);
console.log("  seuls ces fils peuvent alimenter une action nommée du Morning Brief\n");
for (const [label, pick] of [
  ["A — règles", (c) => c.rules],
  ["B — modèle", (c) => c.ai],
  ["C — hybride", (c) => c.hybrid],
  ["D — hybride bridé", (c) => c.clampedHybrid],
]) {
  const ok = attached.filter((c) => pick(c)?.signalType === c.truth).length;
  const pbTrue = attached.filter((c) => c.truth === "positif_bloque");
  const pbFound = pbTrue.filter((c) => pick(c)?.signalType === "positif_bloque").length;
  const pbPredicted = attached.filter((c) => pick(c)?.signalType === "positif_bloque").length;
  console.log(
    `  ${label.padEnd(20)} exactitude ${ok}/${attached.length} = ${((ok / attached.length) * 100).toFixed(1)} %` +
      `   positif_bloque ${pbFound}/${pbTrue.length} trouvés, ${pbPredicted} annoncés`,
  );
}

// --- Ce que le modèle change, dans les deux sens.
console.log("\n=== Cas CORRIGÉS par le modèle (règles fausses → modèle juste) ===");
for (const c of scored) {
  if (c.ai?.signalType === c.truth && c.rules.signalType !== c.truth) {
    console.log(`  [${key(c.tid)}] ${c.rules.signalType} → ${c.truth}`);
    console.log(`      « ${c.msgs.at(-1).subject.slice(0, 62)} »`);
    console.log(`      modèle : ${c.ai.reason.slice(0, 110)}`);
  }
}
console.log("\n=== Cas DÉGRADÉS par le modèle (règles justes → modèle faux) ===");
for (const c of scored) {
  if (c.rules.signalType === c.truth && c.ai && c.ai.signalType !== c.truth) {
    console.log(`  [${key(c.tid)}] ${c.truth} → ${c.ai.signalType}  (confiance ${c.ai.confidence})`);
    console.log(`      « ${c.msgs.at(-1).subject.slice(0, 62)} »`);
    console.log(`      modèle : ${c.ai.reason.slice(0, 110)}`);
  }
}

// --- Cas prioritaires désignés.
console.log("\n=== Cas prioritaires ===");
for (const k of ["469ae6", "608c6d", "bf5436", "894bee"]) {
  const c = scored.find((x) => key(x.tid) === k);
  if (!c) continue;
  console.log(
    `  [${k}] vérité ${c.truth} | règles ${c.rules.signalType} | modèle ${c.ai?.signalType ?? "—"} (${c.ai?.confidence ?? "—"})`,
  );
  if (c.ai) console.log(`      ${c.ai.reason.slice(0, 120)}`);
}

// --- Consommation et coût.
const avgLatency = usage.latencies.reduce((s, v) => s + v, 0) / (usage.latencies.length || 1);
const costIn = (usage.input / 1e6) * PRICE_IN;
const costOut = (usage.output / 1e6) * PRICE_OUT;
const total = costIn + costOut;
const perThread = total / (usage.calls || 1);

console.log("\n=== Consommation réelle du test ===");
console.log(`  appels API réussis    : ${usage.calls} (pour ${scored.length} fils)`);
console.log(`  reprises après échec  : ${usage.retries}`);
console.log(`  jetons entrée         : ${usage.input}`);
console.log(`  jetons sortie         : ${usage.output}`);
console.log(`  coût total            : ${total.toFixed(4)} $`);
console.log(`  coût par fil          : ${perThread.toFixed(5)} $`);
console.log(`  latence moyenne       : ${avgLatency.toFixed(0)} ms`);
console.log(
  `  latence médiane       : ${[...usage.latencies].sort((a, b) => a - b)[Math.floor(usage.latencies.length / 2)]} ms`,
);
console.log(`  durée totale (4 en //) : ${(wallMs / 1000).toFixed(1)} s`);
console.log(`  escalades en hybride  : ${escalated}/${scored.length}`);
console.log(`  verdicts modèle bridés : ${clamped} (rendus aux règles en variante D)`);

console.log("\n=== Extrapolation ===");
for (const perDay of [30, 100]) {
  console.log(`  ${perDay} mails utiles/jour`);
  for (const [mode, factor] of [
    ["IA systématique", 1],
    ["hybride", escalated / scored.length],
  ]) {
    const day = perThread * perDay * factor;
    console.log(
      `    ${mode.padEnd(16)} ${day.toFixed(3)} $/jour   ${(day * 30).toFixed(2)} $/mois   ${(day * 365).toFixed(2)} $/an`,
    );
  }
}

// --- Exemple de charge utile, pour audit.
console.log("\n=== Charge utile type envoyée au modèle (audit) ===");
const example = scored.find((c) => c.truth === "positif_bloque");
if (example) {
  const text = buildUserMessage(buildPayload(example.msgs, { stage: example.msgs[0].stage }));
  for (const line of text.split("\n")) console.log(`  | ${line.slice(0, 140)}`);
  console.log(`  longueur : ${text.length} caractères`);
}
console.log("");
void A;
void B;
void C;

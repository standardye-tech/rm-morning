/**
 * Tests de fuite d'information sur le dataset Expected GMV.
 *
 *   npm run dataset:leakage
 *
 * Les cinq catégories exigées. Chacune est un test automatique, chiffré, dont
 * l'écart toléré est nul. Un seul échec invalide le dataset.
 *
 * LECTURE SEULE.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { POST_SIGNATURE_STAGES } = await import(lib("expected-gmv-dataset"));

const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const rows = db
  .prepare(
    `SELECT observation_date, opportunity_id, stage, actual_signature_at, days_to_signature,
            signed_within_7d, signed_by_month_end, final_outcome,
            estimation_sent_at, devis_sent_at, estimation_relance_at, devis_relance_at,
            kanban_month, kanban_history_available, milestones_available, dataset_split
       FROM expected_gmv_observation`,
  )
  .all();
db.close();

console.log(`\n  observations analysées : ${rows.length}\n`);
let failures = 0;
const check = (label, bad, detail = "") => {
  const ok = bad === 0;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label} — ${bad} cas${detail ? ` · ${detail}` : ""}`);
};

const T = (r) => new Date(`${r.observation_date}T12:00:00Z`).getTime();
const DAY = 864e5;

// --- 1. Fuite de signature.
//
// Aucune observation ne peut exister le jour de la signature ni après : à cet
// instant, l'issue est déjà connue et la « prédiction » serait une lecture.
const onOrAfterSignature = rows.filter(
  (r) => r.actual_signature_at && new Date(r.actual_signature_at).getTime() <= T(r),
).length;
check("1a. aucune observation le jour de la signature ou après", onOrAfterSignature);

const negativeDelay = rows.filter((r) => r.days_to_signature != null && r.days_to_signature <= 0).length;
check("1b. days_to_signature strictement positif quand renseigné", negativeDelay);

// Cohérence des labels avec la date réelle.
const badLabel7 = rows.filter((r) => {
  const sig = r.actual_signature_at ? new Date(r.actual_signature_at).getTime() : null;
  const expected = sig != null && sig > T(r) && sig <= T(r) + 7 * DAY ? 1 : 0;
  return r.signed_within_7d !== expected;
}).length;
check("1c. signed_within_7d recalculable exactement", badLabel7);

const badLabelMonth = rows.filter((r) => {
  const sig = r.actual_signature_at ? new Date(r.actual_signature_at).getTime() : null;
  const d = new Date(T(r));
  const end = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999).getTime();
  const expected = sig != null && sig > T(r) && sig <= end ? 1 : 0;
  return r.signed_by_month_end !== expected;
}).length;
check("1d. signed_by_month_end recalculable exactement", badLabelMonth);

const labelWithoutSignature = rows.filter(
  (r) => (r.signed_within_7d === 1 || r.signed_by_month_end === 1) && !r.actual_signature_at,
).length;
check("1e. aucun label positif sans date de signature", labelWithoutSignature);

// --- 2. Fuite d'étape.
//
// Une étape post-signature dans une feature serait la confirmation d'une
// signature déjà acquise, donc un label déguisé.
const post = new Set(POST_SIGNATURE_STAGES);
const postStage = rows.filter((r) => r.stage && post.has(r.stage)).length;
check("2a. aucune étape post-signature en feature", postStage);

const lostStage = rows.filter((r) => r.stage === "Affaire perdue").length;
check("2b. aucune étape « Affaire perdue » en feature", lostStage);

// Recalcul indépendant de l'étape à T depuis le cache d'extraction brut.
const cache = path.resolve(process.cwd(), "data/dataset-cache/history.json");
if (existsSync(cache)) {
  const history = JSON.parse(readFileSync(cache, "utf8"));
  const byOpp = new Map();
  for (const h of history) {
    if (!h.stageChanged || !h.stage) continue;
    if (!byOpp.has(h.id)) byOpp.set(h.id, []);
    byOpp.get(h.id).push(h);
  }
  for (const list of byOpp.values()) list.sort((a, b) => a.at.localeCompare(b.at));

  let mismatch = 0;
  let usedFuture = 0;
  for (const r of rows) {
    const list = byOpp.get(r.opportunity_id) ?? [];
    const past = list.filter((h) => new Date(h.at).getTime() <= T(r));
    const expected = past.length ? past[past.length - 1].stage : null;
    if (expected !== r.stage) mismatch += 1;
    // L'étape stockée ne doit jamais correspondre uniquement à une transition future.
    const future = list.filter((h) => new Date(h.at).getTime() > T(r));
    if (!past.length && future.some((h) => h.stage === r.stage) && r.stage) usedFuture += 1;
  }
  check("2c. étape à T identique au recalcul indépendant", mismatch);
  check("2d. aucune étape issue d'une transition future", usedFuture);
} else {
  console.log("  info  2c/2d. cache d'extraction absent — recalcul indépendant non exécuté");
}

// --- 3. Fuite d'activité : aucun jalon daté après T.
const futureMilestone = rows.filter((r) => {
  for (const field of ["estimation_sent_at", "devis_sent_at", "estimation_relance_at", "devis_relance_at"]) {
    if (r[field] && new Date(r[field]).getTime() > T(r)) return true;
  }
  return false;
}).length;
check("3a. aucun jalon daté après la date d'observation", futureMilestone);

const milestoneBeforeCoverage = rows.filter(
  (r) => r.milestones_available === 0 && (r.estimation_sent_at || r.devis_sent_at),
).length;
check("3b. aucun jalon renseigné hors période de couverture", milestoneBeforeCoverage);

// --- 4. Fuite Perspective : le déclaratif historique n'existe pas, donc
//        aucune colonne Kanban ne doit être renseignée.
const kanbanFilled = rows.filter((r) => r.kanban_month != null || r.kanban_history_available === 1).length;
check("4. aucune donnée Kanban injectée (historique inexistant)", kanbanFilled);

// --- 5. Fuite commerciale : aucune métrique agrégée du commercial n'existe
//        encore dans le dataset. Le test vérifie cette absence, car une telle
//        variable calculée sur l'ensemble de la période serait la fuite la plus
//        difficile à détecter ensuite.
const forbidden = ["owner_signature_rate", "owner_slippage_rate", "owner_reliability"];
const dbCheck = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const columns = dbCheck
  .prepare("SELECT name FROM pragma_table_info('expected_gmv_observation')")
  .all()
  .map((c) => c.name);
dbCheck.close();
const present = forbidden.filter((f) => columns.includes(f)).length;
check("5. aucune métrique agrégée du commercial (fuite potentielle)", present, `${columns.length} colonnes`);

// --- Split temporel : contrôle de bon ordre.
const splits = {};
for (const r of rows) {
  splits[r.dataset_split] = splits[r.dataset_split] ?? { min: r.observation_date, max: r.observation_date, n: 0 };
  const s = splits[r.dataset_split];
  s.n += 1;
  if (r.observation_date < s.min) s.min = r.observation_date;
  if (r.observation_date > s.max) s.max = r.observation_date;
}
console.log("\n  découpage temporel (sur la date d'observation) :");
for (const [k, v] of Object.entries(splits)) {
  console.log(`    ${k.padEnd(11)} ${String(v.n).padStart(6)} obs · ${v.min} → ${v.max}`);
}
const order = ["train", "validation", "test"].filter((k) => splits[k]);
let overlap = 0;
for (let i = 1; i < order.length; i += 1) {
  if (splits[order[i]].min <= splits[order[i - 1]].max) overlap += 1;
}
check("6. aucun chevauchement chronologique entre les splits", overlap);

// Une même opportunité traversant plusieurs périodes : documenté, pas bloquant.
const oppSplits = new Map();
for (const r of rows) {
  if (!oppSplits.has(r.opportunity_id)) oppSplits.set(r.opportunity_id, new Set());
  oppSplits.get(r.opportunity_id).add(r.dataset_split);
}
const crossing = [...oppSplits.values()].filter((s) => s.size > 1).length;
console.log(
  `\n  info  opportunités présentes dans plusieurs périodes : ${crossing}/${oppSplits.size} — attendu et documenté, à arbitrer en C5`,
);

console.log(`\n  ${failures === 0 ? "Aucune fuite détectée." : `${failures} test(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

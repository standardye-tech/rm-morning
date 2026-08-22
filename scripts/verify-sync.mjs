/**
 * Contrôles de l'actualisation globale (C12 §31).
 *
 *   npm run sync:verify            contrôles seuls, sur le dernier run existant
 *   npm run sync:verify -- --run   lance un VRAI run complet puis contrôle tout
 *
 * Les scénarios d'échec ne sont pas simulés par un drapeau caché dans le code de
 * production : l'orchestrateur accepte une liste d'étapes, et cette suite lui en
 * fournit une dont une étape échoue volontairement. Ce qui est testé est donc bien
 * la vraie mécanique de verrou, d'ordre et de statut.
 *
 * Écrit dans `global_sync_run` — c'est inévitable, puisque c'est l'objet du test.
 * Les runs de contrôle portent `trigger_kind = 'verify'` et se distinguent donc
 * des actualisations réelles dans l'historique.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { startGlobalSync, runGlobalSyncToCompletion, SyncBusyError } = await import(
  lib("sync/orchestrator")
);
const store = await import(lib("sync/store"));
const { buildSteps } = await import(lib("sync/steps"));
const { getDb } = await import(lib("db"));
const { lastCompletedSync } = await import(lib("mail-store"));
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { buildExpectedM1 } = await import(lib("expected-m1"));
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { officialSignedGmv } = await import(lib("official-signed"));

const db = getDb();
const doRun = process.argv.includes("--run");

let failures = 0;
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const count = (sql, ...p) => db.prepare(sql).get(...p).n;
const kEur = (v) => `${Math.round((v ?? 0) / 1000).toLocaleString("fr-FR")} k€`;

/** Étape factice, pour éprouver l'orchestrateur sans toucher aux connecteurs. */
const fake = (key, label, blocking, behaviour) => ({
  key,
  label,
  group: "Finalisation",
  blocking,
  timeoutMs: 5000,
  run: async () => {
    if (behaviour === "fail") throw new Error("panne simulée");
    if (behaviour === "slow") await new Promise((r) => setTimeout(r, 1500));
    return { detail: "ok" };
  },
});

// ── 1. Un run complet réussi ────────────────────────────────────────────────
console.log("\n════ ACTUALISATION GLOBALE ════\n");


let real = null;
if (doRun) {
  console.log("  lancement d'une actualisation complète réelle…\n");
  const t0 = Date.now();
  real = await runGlobalSyncToCompletion("verify");
  console.log(`  ${"étape".padEnd(32)}${"statut".padEnd(10)}${"durée".padStart(9)}`);
  for (const s of real.steps) {
    console.log(
      `  ${s.label.padEnd(32)}${s.status.padEnd(10)}` +
        `${(s.durationMs == null ? "—" : `${(s.durationMs / 1000).toFixed(1)} s`).padStart(9)}`,
    );
    if (s.detail) console.log(`      ${s.detail}`);
    if (s.error) console.log(`      erreur : ${s.error}`);
  }
  console.log(`\n  statut final : ${real.status} · durée totale ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} else {
  // Sans --run on juge le dernier run COMPLET, pas le dernier tout court : les
  // scénarios d'échec de cette même suite laissent volontairement un run en échec
  // derrière eux, et le prendre pour référence ferait échouer le contrôle 1 sans
  // qu'il se passe quoi que ce soit d'anormal.
  real = store.lastCompleteRun();
  console.log("  (aucun run lancé — contrôles sur le dernier run complet ; --run pour en lancer un)");
}

console.log("\n──── CONTRÔLES ────\n");

check(
  "1. un run complet existe et n'est pas en échec bloquant",
  real != null && (real.status === "success" || real.status === "warning"),
  real ? `statut ${real.status}` : "aucun run",
);

// ── 2. Ordre des étapes ─────────────────────────────────────────────────────
const declared = buildSteps().map((s) => s.key);
const EXPECTED_ORDER = [
  "salesforce-opportunites",
  "jalons-opportunites",
  "salesforce-pistes",
  "travaux",
  "perspective",
  "emails",
  "historisation",
  "expected-m",
  "projection-m1",
  "suggestions-m1",
  // Le classement Performance se recalcule depuis toutes les sources ci-dessus :
  // il vient après la dernière d'entre elles, avant le contrôle final.
  "performance",
  "finalisation",
];
check(
  "2. ordre des étapes conforme aux dépendances",
  declared.join(">") === EXPECTED_ORDER.join(">"),
  declared.join(" → "),
);

const pos = (key) => declared.indexOf(key);
check(
  "2b. le classement Performance suit toutes ses sources",
  pos("performance") > pos("travaux") &&
    pos("performance") > pos("salesforce-pistes") &&
    pos("performance") > pos("jalons-opportunites") &&
    pos("performance") > pos("expected-m") &&
    pos("performance") > pos("projection-m1"),
);
check(
  "2c. le classement Performance n'est pas bloquant",
  buildSteps().find((s) => s.key === "performance")?.blocking === false,
);
check(
  "3. la prévision du mois passe après les opportunités",
  pos("expected-m") > pos("salesforce-opportunites"),
);
check(
  "4. la projection M+1 passe après les opportunités et les Travaux",
  pos("projection-m1") > pos("salesforce-opportunites") && pos("projection-m1") > pos("travaux"),
);
check(
  "5. les suggestions sont historisées après le calcul M+1",
  pos("suggestions-m1") > pos("projection-m1"),
);
// C12.1 — les jalons complètent les opportunités : ils ne peuvent pas précéder
// leur import, et un échec de leur côté ne doit pas condamner le pilotage.
check(
  "5b. les jalons sont calculés après l'import des opportunités",
  pos("jalons-opportunites") > pos("salesforce-opportunites"),
);
check(
  "5c. les jalons ne sont pas bloquants",
  buildSteps().find((s) => s.key === "jalons-opportunites")?.blocking === false,
);

// ── 6. « Pris en compte » conservé ──────────────────────────────────────────
//
// Contrôle RÉEL, pas une simple comparaison de compteurs : sans événement déjà
// pris en compte dans la base, une inégalité large passerait au vert sans rien
// démontrer. On marque donc un événement, on relance l'étape qui recalcule les
// alertes, on vérifie, puis on remet l'état d'origine.
{
  const victim = db
    .prepare("SELECT gmail_message_id id, status, acknowledged_at FROM morning_event LIMIT 1")
    .get();
  if (!victim) {
    check("6. statut « Pris en compte » conservé", false, "aucune alerte Morning en base");
  } else {
    const { acknowledgeEvent } = await import(lib("morning-events"));
    const { syncMorningEvents } = await import(lib("morning-events"));
    acknowledgeEvent(victim.id);
    const marked = db
      .prepare("SELECT status, acknowledged_at FROM morning_event WHERE gmail_message_id = ?")
      .get(victim.id);
    syncMorningEvents();
    const after = db
      .prepare("SELECT status, acknowledged_at FROM morning_event WHERE gmail_message_id = ?")
      .get(victim.id);
    check(
      "6. statut « Pris en compte » et sa date survivent au recalcul des alertes",
      marked.status !== "nouveau" &&
        after.status === marked.status &&
        after.acknowledged_at === marked.acknowledged_at,
      `${marked.status} → ${after.status} · date ${after.acknowledged_at === marked.acknowledged_at ? "conservée" : "modifiée"}`,
    );
    // Remise à l'état initial : ce contrôle ne doit pas laisser de trace.
    db.prepare(
      "UPDATE morning_event SET status = ?, acknowledged_at = ? WHERE gmail_message_id = ?",
    ).run(victim.status, victim.acknowledged_at, victim.id);
  }
}

// ── 7. Double run immédiat sans doublon ─────────────────────────────────────
if (doRun) {
  const mid = {
    travaux: count("SELECT COUNT(*) n FROM travaux"),
    suggestions: count("SELECT COUNT(*) n FROM expected_m1_suggestion"),
    signatures: count("SELECT COUNT(*) n FROM signature_event"),
    events: count("SELECT COUNT(*) n FROM morning_event"),
    snapshots: count("SELECT COUNT(*) n FROM opportunity_snapshot"),
    perspective: count("SELECT COUNT(*) n FROM forecast_snapshot"),
  };
  console.log("\n  second run immédiat, pour éprouver l'idempotence…");
  const second = await runGlobalSyncToCompletion("verify");
  const after = {
    travaux: count("SELECT COUNT(*) n FROM travaux"),
    suggestions: count("SELECT COUNT(*) n FROM expected_m1_suggestion"),
    signatures: count("SELECT COUNT(*) n FROM signature_event"),
    events: count("SELECT COUNT(*) n FROM morning_event"),
    snapshots: count("SELECT COUNT(*) n FROM opportunity_snapshot"),
    perspective: count("SELECT COUNT(*) n FROM forecast_snapshot"),
    jalons: count("SELECT COUNT(*) n FROM opportunity WHERE milestone_status IS NOT NULL"),
    anomalies: count(
      "SELECT COUNT(*) n FROM opportunity WHERE milestone_status NOT IN ('normal','') AND milestone_status IS NOT NULL",
    ),
  };
  const drifted = Object.keys(mid).filter((k) => after[k] !== mid[k]);
  check(
    "7. double run immédiat : aucun doublon",
    drifted.length === 0 && (second.status === "success" || second.status === "warning"),
    drifted.length === 0
      ? `Travaux ${after.travaux} · suggestions ${after.suggestions} · snapshots ${after.snapshots}` +
        ` · Perspective ${after.perspective} · alertes ${after.events}`
      : drifted.map((k) => `${k} ${mid[k]}→${after[k]}`).join(" · "),
  );
} else {
  console.log("  (7. idempotence : nécessite --run)");
}

// ── 8. Deux runs simultanés refusés ─────────────────────────────────────────
{
  const { done } = startGlobalSync("verify", [fake("lent", "Étape lente", false, "slow")]);
  let refused = false;
  let refusedRunId = null;
  try {
    startGlobalSync("verify", [fake("second", "Second", false, "ok")]);
  } catch (error) {
    refused = error instanceof SyncBusyError;
    refusedRunId = error?.runId ?? null;
  }
  await done;
  check(
    "8. une seconde actualisation simultanée est refusée",
    refused,
    refused ? `verrou tenu par le run ${refusedRunId}` : "la seconde a démarré",
  );
}

// ── 9. Échec Gmail sans perte de curseur ────────────────────────────────────
{
  const cursorBefore = lastCompletedSync()?.windowEnd ?? null;
  const run = await runGlobalSyncToCompletion("verify", [
    fake("emails", "Emails", false, "fail"),
    fake("finalisation", "Finalisation", true, "ok"),
  ]);
  const cursorAfter = lastCompletedSync()?.windowEnd ?? null;
  check(
    "9. échec Emails : curseur conservé, statut partiel",
    run.status === "warning" && cursorBefore === cursorAfter,
    `statut ${run.status} · curseur ${cursorAfter ?? "aucun"}`,
  );
  check(
    "9b. l'étape suivante s'exécute quand même après un échec non bloquant",
    run.steps.find((s) => s.key === "finalisation")?.status === "success",
  );
}

// ── 10. Échec bloquant signalé, suite interrompue ───────────────────────────
{
  const run = await runGlobalSyncToCompletion("verify", [
    fake("bloquante", "Étape indispensable", true, "fail"),
    fake("suivante", "Étape suivante", true, "ok"),
  ]);
  check(
    "10. échec bloquant : statut en échec et suite interrompue",
    run.status === "failed" &&
      run.steps.find((s) => s.key === "suivante")?.status === "skipped" &&
      run.error != null,
    `statut ${run.status} · ${run.error ?? ""}`,
  );
}

// ── 11. Dernier run réussi conservé après un échec ──────────────────────────
{
  const lastComplete = store.lastCompleteRun();
  const latest = store.latestRun();
  check(
    "11. le dernier run réussi survit à un échec postérieur",
    lastComplete != null && latest != null && lastComplete.id !== latest.id && latest.status === "failed",
    lastComplete
      ? `dernier complet ${lastComplete.id} (${lastComplete.status}) · dernière tentative ${latest.id} (${latest.status})`
      : "aucun run complet",
  );
}

// ── 12. Verrou mort levé, jamais permanent ──────────────────────────────────
{
  const now = new Date();
  const stale = new Date(now.getTime() - (store.HEARTBEAT_TIMEOUT_MS + 60_000)).toISOString();
  db.prepare(
    `INSERT INTO global_sync_run (started_at, heartbeat_at, status, trigger_kind)
     VALUES (?, ?, 'running', 'verify')`,
  ).run(stale, stale);
  const zombie = db.prepare("SELECT last_insert_rowid() id").get().id;
  const active = store.activeRun(now);
  const closed = store.getRun(zombie);
  check(
    "12. un verrou dont le battement s'est tu est levé",
    active == null && closed.status === "failed",
    `run ${zombie} refermé en ${closed.status}`,
  );
}

// ── 13. Aucun garde-fou « périmé » après succès ─────────────────────────────
{
  const snap = buildExpectedGmvSnapshot();
  const m1 = buildExpectedM1();
  check(
    "13. la prévision du mois n'est pas antérieure au dernier import",
    snap != null && !snap.supersededByImport,
    snap == null ? "absente" : snap.supersededByImport ? "périmée" : `scorée ${snap.scoredAt}`,
  );
  check(
    "13b. la projection M+1 n'est pas antérieure au dernier import",
    m1 != null && !m1.supersededByImport,
    m1 == null ? "absente" : m1.supersededByImport ? "périmée" : `générée ${m1.generatedAt}`,
  );
}

// ── 14. Signé officiel calculable ───────────────────────────────────────────
{
  const month = new Date().toISOString().slice(0, 7);
  let ok = false;
  let detail = "";
  try {
    const official = officialSignedGmv(month);
    ok = Number.isFinite(official.gmv);
    detail = `${month} · ${kEur(official.gmv)} sur ${official.lines} ligne(s)`;
  } catch (error) {
    detail = error.message;
  }
  check("14. Signé officiel calculable après import Travaux", ok, detail);
}

// ── 15. M+2 ne produit aucune ligne jaune ───────────────────────────────────
{
  const m2 = buildForecastV2(2);
  check(
    "15. M+2 ne produit aucune affaire à challenger",
    m2.examine.length === 0 && m2.expectedM1 == null,
    `${m2.examine.length} suggestion(s)`,
  );
}

// ── 16. Cohérence des versions enregistrées ─────────────────────────────────
if (real && (real.status === "success" || real.status === "warning")) {
  const s = real.sources;
  const need = [
    "opportunityImportId",
    "milestonesComputedAt",
    "travauxImportedAt",
    "expectedScoredAt",
    "m1GeneratedAt",
  ];
  const missing = need.filter((k) => s[k] == null);
  check(
    "16. versions des sources enregistrées dans le run",
    missing.length === 0,
    missing.length === 0
      ? `import ${s.opportunityImportId} · Travaux ${String(s.travauxImportedAt).slice(0, 16)}` +
        ` · Expected ${String(s.expectedScoredAt).slice(0, 16)} · M+1 ${String(s.m1GeneratedAt).slice(0, 16)}`
      : `manquant : ${missing.join(", ")}`,
  );
  check(
    "16b. la prévision porte sur l'import du run",
    s.expectedSourceImportAt != null &&
      s.opportunityImportedAt != null &&
      s.expectedSourceImportAt >= s.opportunityImportedAt,
    `import ${String(s.opportunityImportedAt).slice(0, 19)} · source du scoring ${String(s.expectedSourceImportAt).slice(0, 19)}`,
  );
}

// ── 17. Snapshots par import : les journées à plusieurs imports restent lisibles
{
  const runs = count("SELECT COUNT(DISTINCT import_id) n FROM opportunity_snapshot_run");
  const days = count("SELECT COUNT(DISTINCT snapshot_date) n FROM opportunity_snapshot_run");
  const rows = count("SELECT COUNT(*) n FROM opportunity_snapshot_run");
  check(
    "17. accumulation des snapshots par import",
    rows > 0,
    `${rows} ligne(s) · ${runs} import(s) distinct(s) sur ${days} journée(s)`,
  );
}

console.log(
  failures === 0
    ? `\n  ${total} contrôles au vert.\n`
    : `\n  ${failures} contrôle(s) en échec sur ${total}.\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles de l'infrastructure cloud (Phase 1).
 *
 *   npm run cloud:verify
 *
 * Cette suite ne teste AUCUNE règle métier : elle vérifie les garde-fous ajoutés
 * pour l'hébergement, et vérifie surtout qu'ils ne changent rien en local.
 *
 * Chaque contrôle tourne dans un PROCESSUS SÉPARÉ, relancé par ce script avec
 * `--probe=<nom>`. C'est indispensable : `getDb()` mémorise son instance et
 * `config.ts` lit ses variables d'environnement au chargement du module. Tester
 * plusieurs configurations dans un seul processus donnerait des résultats faux.
 *
 * La base de production n'est JAMAIS ouverte en écriture ici. Les contrôles qui
 * ont besoin de vraies données travaillent sur une copie produite par
 * `VACUUM INTO`, dans un dossier temporaire détruit à la fin.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const NODE_TS = [
  "--experimental-strip-types",
  "--experimental-loader",
  "./scripts/ts-resolver.mjs",
];

const REAL_DB = path.resolve(process.cwd(), "data/rm-morning.db");

/**
 * Fichiers hors base exigés en production, dans l'ordre où l'entrypoint les cherche.
 * Doit rester synchronisé avec `docker-entrypoint.sh` et `/api/health`.
 */
const VOLUME_FILES = [
  "dataset-cache/history.json",
  "dataset-cache/opportunities.json",
  "expected-gmv/model-7d.joblib",
  "expected-gmv/model-monthend.joblib",
  "expected-gmv/forecast-evaluation.json",
  "expected-gmv/evaluation.json",
];

// ---------------------------------------------------------------------------
// Sondes — exécutées dans un sous-processus, une seule par processus.
// ---------------------------------------------------------------------------

const say = (ok, detail) => {
  process.stdout.write(`\n__RESULT__${JSON.stringify({ ok, detail })}\n`);
};

const PROBES = {
  /** RM_REQUIRE_DB=1 : getDb doit refuser et ne rien créer. */
  async "guard-refuse"() {
    const target = process.env.RM_DB_PATH;
    const { getDb } = await import("../src/lib/db.ts");
    try {
      getDb();
      return say(false, "getDb() a réussi alors que la base est absente");
    } catch (error) {
      const created = existsSync(target);
      if (created) return say(false, "getDb() a levé, mais un fichier a quand même été créé");
      return say(true, `refus correct — ${String(error.message).slice(0, 90)}…`);
    }
  },

  /** Sans RM_REQUIRE_DB : comportement de développement inchangé, la base s'amorce. */
  async "guard-dev"() {
    const target = process.env.RM_DB_PATH;
    if (process.env.RM_REQUIRE_DB) return say(false, "RM_REQUIRE_DB aurait dû être absent");
    const { getDb } = await import("../src/lib/db.ts");
    getDb();
    return existsSync(target)
      ? say(true, "base amorcée comme avant")
      : say(false, "aucune base créée : le comportement local a changé");
  },

  /** WAL conservé, busy_timeout posé. */
  async "pragmas"() {
    const { getDb } = await import("../src/lib/db.ts");
    const db = getDb();
    const journal = db.prepare("PRAGMA journal_mode").get();
    const busy = db.prepare("PRAGMA busy_timeout").get();
    const fk = db.prepare("PRAGMA foreign_keys").get();
    const mode = String(journal.journal_mode).toLowerCase();
    const timeout = Number(busy.timeout ?? busy.busy_timeout);
    const okAll = mode === "wal" && timeout === 5000 && Number(fk.foreign_keys) === 1;
    return say(
      okAll,
      `journal_mode=${mode} · busy_timeout=${timeout} · foreign_keys=${fk.foreign_keys}`,
    );
  },

  /** Un RM_DB_PATH absolu doit être honoré tel quel, pas concaténé au cwd. */
  async "abs-path"() {
    const target = process.env.RM_DB_PATH;
    const { DB_PATH } = await import("../src/lib/config.ts");
    const { getDb } = await import("../src/lib/db.ts");
    getDb();
    const resolved = path.resolve(process.cwd(), DB_PATH);
    return resolved === path.resolve(target) && existsSync(target)
      ? say(true, `chemin absolu honoré — ${target}`)
      : say(false, `attendu ${target}, obtenu ${resolved}`);
  },

  /** Mode cloud, base absente : la sonde doit rendre 503 et le dire. */
  async "health-503"() {
    const { GET } = await import("../src/app/api/health/route.ts");
    const res = await GET();
    const body = await res.json();
    const named =
      body.checks?.fichierBase?.ok === false || body.checks?.baseNonVide?.ok === false;
    return res.status === 503 && body.status === "degraded" && named
      ? say(true, "503 rendu, cause nommée dans les contrôles")
      : say(false, `status=${res.status} body.status=${body.status}`);
  },

  /** Volume complet et base peuplée : la sonde doit rendre 200. */
  async "health-200"() {
    const { GET } = await import("../src/app/api/health/route.ts");
    const res = await GET();
    const body = await res.json();
    const failed = Object.entries(body.checks ?? {})
      .filter(([, c]) => !c.ok)
      .map(([k]) => k);
    return res.status === 200 && body.status === "ok" && body.opportunites > 0
      ? say(true, `200 rendu · ${body.opportunites} opportunité(s) · ${Object.keys(body.checks).length} contrôles`)
      : say(false, `status=${res.status} · échecs : ${failed.join(", ") || "aucun"}`);
  },

  /** Les surcharges d'environnement fonctionnent, et les valeurs locales ne bougent pas. */
  async "config-overrides"() {
    const { GOOGLE_SHEETS, GOOGLE_OAUTH } = await import("../src/lib/config.ts");
    const okKey = GOOGLE_SHEETS.keyFile === "/run/secrets/google-service-account.json";
    const okUri = GOOGLE_OAUTH.redirectUri === "https://exemple.test/api/google/callback";
    return okKey && okUri
      ? say(true, "keyFile et redirectUri suivent l'environnement")
      : say(false, `keyFile=${GOOGLE_SHEETS.keyFile} · redirectUri=${GOOGLE_OAUTH.redirectUri}`);
  },

  /** Sans variables, les valeurs locales historiques sont conservées à l'identique. */
  async "config-defaults"() {
    const { GOOGLE_SHEETS, GOOGLE_OAUTH, DB_PATH } = await import("../src/lib/config.ts");
    const okKey = GOOGLE_SHEETS.keyFile === "data/google-service-account.json";
    const okUri = GOOGLE_OAUTH.redirectUri === "http://localhost:3001/api/google/callback";
    const okDb = DB_PATH === "data/rm-morning.db";
    return okKey && okUri && okDb
      ? say(true, "valeurs locales identiques à la v1.0.0")
      : say(false, `keyFile=${GOOGLE_SHEETS.keyFile} · uri=${GOOGLE_OAUTH.redirectUri} · db=${DB_PATH}`);
  },

  /** Invariants métier : rien de ce que la Phase 1 touche ne doit les déplacer. */
  async "invariants"() {
    const c = await import("../src/lib/config.ts");
    const problems = [];
    if (c.PERFORMANCE_MODEL_VERSION !== "v3-ytd") {
      problems.push(`PERFORMANCE_MODEL_VERSION=${c.PERFORMANCE_MODEL_VERSION}`);
    }
    if (c.DB_PATH !== "data/rm-morning.db") problems.push(`DB_PATH=${c.DB_PATH}`);
    // Le périmètre commercial n'est plus une constante : il se règle depuis
    // l'écran Données et vit en base. On vérifie donc qu'il existe, pas qu'il
    // compte un nombre figé de membres — sinon toute évolution d'équipe
    // ferait échouer le contrôle de déploiement.
    const { loadTeam } = await import("../src/lib/team-store.ts");
    const team = loadTeam();
    if (team.length === 0) problems.push("périmètre commercial vide");
    return problems.length === 0
      ? say(true, `PERFORMANCE_MODEL_VERSION=v3-ytd · ${team.length} commerciaux suivis`)
      : say(false, problems.join(" · "));
  },

  /** Le proxy laisse passer la sonde, refuse le reste, et rend du JSON aux API. */
  async "proxy"() {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy.ts");

    const call = (url, init) => proxy(new NextRequest(new URL(url), init));

    const health = await call("https://rm.test/api/health");
    const okHealth = !health || health.status === 200;

    const page = await call("https://rm.test/performance");
    const okPage =
      page.status === 307 &&
      String(page.headers.get("location")).includes("/rm-login");

    const api = await call("https://rm.test/api/morning", { method: "POST" });
    const okApi =
      api.status === 401 && String(api.headers.get("content-type")).includes("json");

    const login = await call("https://rm.test/rm-login");
    const okLogin = login.status === 200;

    const okAll = okHealth && okPage && okApi && okLogin;
    return say(
      okAll,
      `health=${okHealth ? "passe" : "KO"} · page=${page.status} · api=${api.status} · login=${login.status}`,
    );
  },

  /**
   * Le résumé d'erreur conserve la CAUSE, pas seulement « Command failed », et
   * masque tout ce qui ressemble à un secret. Éprouvé par l'orchestrateur réel,
   * avec une étape qui échoue volontairement — pas en appelant une fonction
   * privée.
   */
  async "erreur-lisible"() {
    const { runGlobalSyncToCompletion } = await import("../src/lib/sync/orchestrator.ts");
    const { getDb } = await import("../src/lib/db.ts");

    const FAUX_JETON = "force://PlatformCLI::FAUX_JETON_DE_TEST@exemple.my.salesforce.com";
    const run = await runGlobalSyncToCompletion("verify", [
      {
        key: "sonde",
        label: "Étape en échec",
        group: "Contrôle",
        blocking: true,
        timeoutMs: 30_000,
        run: async () => {
          throw new Error(
            `Command failed: python scripts/exemple.py\n` +
              `  File "/app/scripts/exemple.py", line 209, in reliability\n` +
              `URL utilisée : ${FAUX_JETON}\n` +
              `FileNotFoundError: [Errno 2] No such file or directory: '/data/absent.json'`,
          );
        },
      },
    ]);

    const recorded = getDb()
      .prepare("SELECT error FROM global_sync_step WHERE run_id = ? AND step_key = 'sonde'")
      .get(run.id).error;

    const gardeCause = recorded.includes("FileNotFoundError");
    const gardePremiere = recorded.includes("Command failed");
    const fuite = recorded.includes("FAUX_JETON_DE_TEST") || recorded.includes("force://");
    const borne = recorded.length <= 600;

    return gardeCause && gardePremiere && !fuite && borne
      ? say(true, `cause conservée, secret masqué, ${recorded.length} caractères`)
      : say(
          false,
          `cause=${gardeCause} première=${gardePremiere} fuite=${fuite} borné=${borne} · ${recorded.slice(0, 120)}`,
        );
  },

  /**
   * Le battement doit avancer PENDANT une étape longue, sinon le garde-fou
   * déclare mort un run vivant — exactement l'incident du 23/08.
   */
  async "battement-pendant-etape"() {
    const { startGlobalSync } = await import("../src/lib/sync/orchestrator.ts");
    const { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } = await import("../src/lib/sync/store.ts");
    const { getDb } = await import("../src/lib/db.ts");

    // L'étape dure plus de deux intervalles : le minuteur doit battre au moins
    // une fois AVANT qu'elle ne se termine.
    const attente = HEARTBEAT_INTERVAL_MS * 2 + 4_000;
    const { run, done } = startGlobalSync("verify", [
      {
        key: "sonde-lente",
        label: "Étape lente",
        group: "Contrôle",
        blocking: false,
        timeoutMs: attente + 30_000,
        run: async () => {
          await new Promise((r) => setTimeout(r, attente));
          return { detail: "terminée" };
        },
      },
    ]);

    const lire = () =>
      getDb()
        .prepare("SELECT r.heartbeat_at h, s.status st FROM global_sync_run r JOIN global_sync_step s ON s.run_id = r.id WHERE r.id = ?")
        .get(run.id);

    const depart = new Date(lire().h).getTime();

    // Observation EN VOL : on relève le battement pendant que l'étape tourne
    // encore. C'est le seul relevé qui prouve le minuteur — celui d'après
    // l'étape serait produit de toute façon par le battement de fin.
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS + 3_000));
    const enVol = lire();
    const avance = new Date(enVol.h).getTime() - depart;
    const encoreEnCours = enVol.st === "running";

    await done;

    if (!encoreEnCours) return say(false, "l'étape était déjà finie : relevé non concluant");
    return avance >= HEARTBEAT_INTERVAL_MS * 0.8 && HEARTBEAT_INTERVAL_MS < HEARTBEAT_TIMEOUT_MS
      ? say(true, `battement avancé de ${(avance / 1000).toFixed(0)} s alors que l'étape tournait encore`)
      : say(false, `battement figé (+${(avance / 1000).toFixed(0)} s) pendant l'étape — le minuteur n'a pas tourné`);
  },

  /** La CLI Salesforce doit être tuée à expiration, avec un message exploitable. */
  async "timeout-salesforce"() {
    const { ApiSalesforceSource, SalesforceAuthError } = await import(
      "../src/lib/sources/api-salesforce.ts"
    );
    const t0 = Date.now();
    try {
      await new ApiSalesforceSource().fetch();
      return say(false, "aucune erreur alors que le délai était fixé à 1 ms");
    } catch (error) {
      const ms = Date.now() - t0;
      if (error instanceof SalesforceAuthError) {
        return say(true, "CLI Salesforce absente ici — chemin non éprouvé, sans objet hors conteneur");
      }
      const bon = /n'a pas répondu en/.test(error.message);
      return bon
        ? say(true, `tuée et signalée en ${ms} ms — « ${error.message.slice(0, 70)}… »`)
        : say(false, `message inattendu : ${error.message.slice(0, 140)}`);
    }
  },

  /**
   * En développement, sans secrets configurés, le proxy doit être transparent.
   * Et en production sans secrets, il doit au contraire tout fermer : une erreur
   * de configuration ne doit jamais rendre l'application publique.
   */
  async "proxy-fallback"() {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy.ts");
    const res = await proxy(new NextRequest(new URL("https://rm.test/performance")));

    if (process.env.NODE_ENV === "production") {
      return res.status === 503
        ? say(true, "production sans secrets : fermé (503)")
        : say(false, `production sans secrets : ${res.status} — l'application serait ouverte`);
    }
    // `NextResponse.next()` porte l'en-tête interne de continuation.
    const passes = res.status === 200 && res.headers.has("x-middleware-next");
    return passes
      ? say(true, "développement sans secrets : transparent, comportement v1.0.0")
      : say(false, `développement : status=${res.status}, le proxy s'interpose`);
  },
};

const probeName = process.argv.find((a) => a.startsWith("--probe="))?.slice(8);
if (probeName) {
  const fn = PROBES[probeName];
  if (!fn) {
    say(false, `sonde inconnue : ${probeName}`);
  } else {
    try {
      await fn();
    } catch (error) {
      say(false, `exception — ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Harnais
// ---------------------------------------------------------------------------

console.log("\n  RM MORNING — CONTRÔLES CLOUD\n");

const tmp = mkdtempSync(path.join(os.tmpdir(), "rm-cloud-"));
let failures = 0;
let total = 0;

function run(label, probe, env) {
  total += 1;
  const clean = { ...process.env };
  // Repartir d'un environnement propre : ces variables décident du comportement.
  for (const k of [
    "RM_REQUIRE_DB",
    "RM_DB_PATH",
    "RM_DATA_DIR",
    "GOOGLE_SERVICE_ACCOUNT_FILE",
    "RM_PUBLIC_URL",
    "RM_AUTH_PASSWORD",
    "RM_AUTH_SECRET",
  ]) {
    delete clean[k];
  }

  const res = spawnSync(
    process.execPath,
    [...NODE_TS, "scripts/verify-cloud.mjs", `--probe=${probe}`],
    { env: { ...clean, ...env }, encoding: "utf8", cwd: process.cwd() },
  );

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const marker = out.lastIndexOf("__RESULT__");
  let ok = false;
  let detail;

  if (marker === -1) {
    detail = `aucun résultat — ${out.trim().split("\n").pop()?.slice(0, 130) ?? "sortie vide"}`;
  } else {
    try {
      const parsed = JSON.parse(out.slice(marker + 10).split("\n")[0]);
      ok = parsed.ok;
      detail = parsed.detail;
    } catch {
      detail = "résultat illisible";
    }
  }

  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// --- Garde anti-base vide --------------------------------------------------
console.log("  Garde anti-base vide");
run("refuse de créer une base en production", "guard-refuse", {
  RM_REQUIRE_DB: "1",
  RM_DB_PATH: path.join(tmp, "absente.db"),
});
run("amorce toujours la base en local", "guard-dev", {
  RM_DB_PATH: path.join(tmp, "locale.db"),
});

// --- SQLite ----------------------------------------------------------------
console.log("\n  SQLite");
run("WAL conservé, busy_timeout à 5 s", "pragmas", {
  RM_DB_PATH: path.join(tmp, "pragmas.db"),
});
run("RM_DB_PATH absolu honoré", "abs-path", {
  RM_DB_PATH: path.join(tmp, "abs", "rm-morning.db"),
});

// --- Volume de production, reconstitué -------------------------------------
console.log("\n  Volume de production");
const vol = path.join(tmp, "data");
mkdirSync(path.join(vol, "dataset-cache"), { recursive: true });
mkdirSync(path.join(vol, "expected-gmv"), { recursive: true });
writeFileSync(path.join(vol, ".rm-volume-ok"), "");
for (const f of VOLUME_FILES) writeFileSync(path.join(vol, f), "{}");

let copied = false;
try {
  const src = new DatabaseSync(REAL_DB, { readOnly: true });
  src.exec(`VACUUM INTO '${path.join(vol, "rm-morning.db").replace(/\\/g, "/")}'`);
  src.close();
  copied = true;
} catch (error) {
  console.log(`  ÉCHEC copie de la base de référence — ${String(error.message).slice(0, 110)}`);
  failures += 1;
  total += 1;
}

run("503 si la base de production manque", "health-503", {
  RM_REQUIRE_DB: "1",
  RM_DATA_DIR: vol,
  RM_DB_PATH: path.join(tmp, "jamais.db"),
});

if (copied) {
  run("200 si volume complet et base peuplée", "health-200", {
    RM_REQUIRE_DB: "1",
    RM_DATA_DIR: vol,
    RM_DB_PATH: path.join(vol, "rm-morning.db"),
  });
}

// --- dataset-cache réel ----------------------------------------------------
total += 1;
const missing = VOLUME_FILES.filter(
  (f) => !existsSync(path.resolve(process.cwd(), "data", f)),
);
if (missing.length) failures += 1;
console.log(
  `  ${missing.length ? "ÉCHEC" : "ok   "} fichiers à transférer présents en local` +
    (missing.length ? ` — manquants : ${missing.join(", ")}` : ` — ${VOLUME_FILES.length} fichiers`),
);

// --- Cohérence des trois listes de fichiers requis --------------------------
//
// La panne du 23/08 vient d'un fichier lu par le scoring mais absent des gardes.
// Corriger une liste sans corriger les deux autres reproduirait exactement le
// même trou : ce contrôle interdit la dérive.
total += 1;
{
  const paths = (file) => {
    const src = readFileSync(path.resolve(process.cwd(), file), "utf8");
    return new Set(src.match(/(?:dataset-cache|expected-gmv)\/[A-Za-z0-9._-]+/g) ?? []);
  };
  const entrypoint = paths("docker-entrypoint.sh");
  const health = paths("src/app/api/health/route.ts");
  const here = new Set(VOLUME_FILES);
  const diff = (a, b) => [...a].filter((x) => !b.has(x));
  const problems = [
    ...diff(here, entrypoint).map((f) => `absent de l'entrypoint : ${f}`),
    ...diff(here, health).map((f) => `absent de /api/health : ${f}`),
    ...diff(entrypoint, here).map((f) => `dans l'entrypoint seulement : ${f}`),
    ...diff(health, here).map((f) => `dans /api/health seulement : ${f}`),
  ];
  if (problems.length) failures += 1;
  console.log(
    `\n  Cohérence des gardes\n  ${problems.length ? "ÉCHEC" : "ok   "} entrypoint, /api/health et cette suite listent les mêmes fichiers` +
      (problems.length ? ` — ${problems.join(" · ")}` : ` — ${here.size} fichiers`),
  );
}

// --- Variables de bridage de la CLI Salesforce ------------------------------
//
// Le nom exact importe : SF_AUTOUPDATE_DISABLE n'empêche PAS le processus
// `sf update --autoupdate`, seul SF_DISABLE_AUTOUPDATE le fait. Les deux se
// ressemblent assez pour être reconfondus un jour.
total += 1;
{
  const dockerfile = readFileSync(path.resolve(process.cwd(), "Dockerfile"), "utf8");
  const attendues = ["SF_DISABLE_TELEMETRY=true", "SF_DISABLE_AUTOUPDATE=true"];
  const manquantes = attendues.filter(
    (v) => !new RegExp(`^\\s*(ENV\\s+)?${v.replace("=", "=")}`, "m").test(dockerfile),
  );
  if (manquantes.length) failures += 1;
  console.log(
    `\n  CLI Salesforce\n  ${manquantes.length ? "ÉCHEC" : "ok   "} le Dockerfile bride télémétrie et autoupdate` +
      (manquantes.length ? ` — manquant : ${manquantes.join(", ")}` : " — 2 variables déclarées"),
  );
}

// --- Configuration ---------------------------------------------------------
console.log("\n  Configuration");
run("surcharges d'environnement actives", "config-overrides", {
  GOOGLE_SERVICE_ACCOUNT_FILE: "/run/secrets/google-service-account.json",
  RM_PUBLIC_URL: "https://exemple.test",
});
run("valeurs locales inchangées sans variables", "config-defaults", {});
run("invariants métier intacts", "invariants", {});

// --- Orchestration : robustesse ---------------------------------------------
// Chaque sonde travaille sur une base neuve en dossier temporaire : aucune
// écriture dans la base de travail, contrairement à `sync:verify`.
console.log("\n  Orchestration");
run("le résumé d'erreur garde la cause et masque les secrets", "erreur-lisible", {
  RM_DB_PATH: path.join(tmp, "orch1.db"),
});
run("le battement avance pendant une étape longue", "battement-pendant-etape", {
  RM_DB_PATH: path.join(tmp, "orch2.db"),
});
run("la CLI Salesforce est tuée à expiration", "timeout-salesforce", {
  RM_DB_PATH: path.join(tmp, "orch3.db"),
  RM_SF_CLI_TIMEOUT_MS: "1",
});

// --- Accès privé -----------------------------------------------------------
console.log("\n  Accès privé");
run("proxy : sonde ouverte, reste fermé", "proxy", {
  NODE_ENV: "production",
  RM_AUTH_PASSWORD: "mot-de-passe-de-test-uniquement",
  RM_AUTH_SECRET: "secret-de-test-uniquement",
});
run("sans secrets en local : transparent", "proxy-fallback", { NODE_ENV: "development" });
run("sans secrets en production : fermé", "proxy-fallback", { NODE_ENV: "production" });

rmSync(tmp, { recursive: true, force: true });

console.log(
  `\n  ${failures === 0 ? "TOUT EST VERT" : `${failures} ÉCHEC(S)`} — ${total - failures}/${total}\n`,
);
process.exit(failures === 0 ? 0 : 1);

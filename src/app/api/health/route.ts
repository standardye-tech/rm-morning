import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";

import { DB_PATH } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Sonde de santé — troisième garde contre la base vide.
 *
 * Fly interroge cette route toutes les 30 s. Tant qu'elle répond 503, le trafic
 * n'est PAS basculé sur la nouvelle machine : un déploiement qui aurait perdu son
 * volume échoue au lieu d'être servi, et la machine précédente reste en place.
 *
 * AUCUN APPEL EXTERNE ICI. Ni Salesforce, ni Gmail, ni Sheets, ni Anthropic :
 * une sonde qui interroge un tiers transforme la panne du tiers en panne de
 * l'application, et 2 880 appels par jour épuiseraient des quotas pour rien. On
 * ne vérifie que ce dont le conteneur est responsable.
 *
 * Cette route est la SEULE exemptée d'authentification (voir `src/proxy.ts`).
 * Elle ne divulgue aucun chiffre d'affaires : des booléens, des noms de tables,
 * et un décompte d'opportunités qui sert justement à prouver que la base n'est
 * pas vide.
 */

type Check = { ok: boolean; detail: string };

/** Tables sans lesquelles aucun écran ne se construit. */
const REQUIRED_TABLES = [
  "opportunity",
  "travaux",
  "expected_gmv_score",
  "global_sync_run",
  "performance_snapshot",
] as const;

/**
 * Fichiers hors base dont dépend l'actualisation, et qui vivent sur le volume.
 *
 * Relevé exhaustif des lectures du chemin d'actualisation, et non des seuls
 * fichiers évidents. Les deux artefacts d'évaluation sont lus par `reliability()`
 * à la toute fin de `expected_gmv_score.py --phase score`, sans garde : leur
 * absence laissait le scoring tourner en entier avant d'échouer.
 */
const REQUIRED_FILES = [
  "dataset-cache/history.json",
  "dataset-cache/opportunities.json",
  "expected-gmv/model-7d.joblib",
  "expected-gmv/model-monthend.joblib",
  "expected-gmv/forecast-evaluation.json",
  "expected-gmv/evaluation.json",
] as const;

export async function GET() {
  const checks: Record<string, Check> = {};
  // En développement il n'y a ni volume ni sentinelle, et c'est normal : les
  // contrôles d'infrastructure ne s'appliquent qu'au conteneur de production.
  const cloud = process.env.RM_REQUIRE_DB === "1";
  const dataDir = process.env.RM_DATA_DIR ?? null;

  if (cloud && dataDir) {
    const mounted = existsSync(/* turbopackIgnore: true */ dataDir);
    checks.volume = {
      ok: mounted,
      detail: mounted ? `${dataDir} monté` : `${dataDir} absent — volume non monté`,
    };
    // `turbopackIgnore` : ces chemins ne sont connus qu'à l'exécution. Sans le
    // marqueur, Turbopack embarque tout le projet dans la sortie serveur « au cas
    // où ». Même convention que `db.ts` et `sheets-api-forecast.ts`.
    const sentinel = path.join(/* turbopackIgnore: true */ dataDir, ".rm-volume-ok");
    checks.sentinelle = {
      ok: existsSync(sentinel),
      detail: existsSync(sentinel) ? "présente" : `${sentinel} absente — volume non amorcé`,
    };
    for (const rel of REQUIRED_FILES) {
      const full = path.join(/* turbopackIgnore: true */ dataDir, rel);
      checks[`fichier:${rel}`] = {
        ok: existsSync(full),
        detail: existsSync(full) ? "présent" : "absent — le scoring échouerait",
      };
    }
  } else {
    checks.volume = { ok: true, detail: "hors production — contrôle non applicable" };
  }

  const dbFile = path.resolve(/* turbopackIgnore: true */ process.cwd(), DB_PATH);
  checks.fichierBase = {
    ok: existsSync(dbFile),
    detail: existsSync(dbFile) ? dbFile : `${dbFile} absent`,
  };

  let opportunites: number | null = null;

  try {
    // Import différé : `getDb()` lève si `RM_REQUIRE_DB=1` et que la base manque.
    // C'est précisément le cas que la sonde doit rapporter, pas propager.
    const { queryAll, queryOne } = await import("@/lib/db");

    const present = new Set(
      queryAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).map((r) => r.name),
    );
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    checks.schema = {
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${REQUIRED_TABLES.length} tables clés présentes`
          : `tables manquantes : ${missing.join(", ")}`,
    };

    const row = queryOne<{ n: number }>("SELECT COUNT(*) n FROM opportunity");
    opportunites = row?.n ?? 0;
    // Une base lisible mais vide est le scénario redouté : elle n'est pas
    // « en cours de remplissage », elle est la mauvaise base.
    checks.baseNonVide = {
      ok: opportunites > 0,
      detail:
        opportunites > 0
          ? `${opportunites} opportunité(s)`
          : "0 opportunité — base vide, ce n'est pas la base de production",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.schema = { ok: false, detail: `base inaccessible — ${message.slice(0, 200)}` };
    checks.baseNonVide = { ok: false, detail: "non évaluable" };
  }

  const ok = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      env: cloud ? "production" : "local",
      opportunites,
      checks,
      at: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}

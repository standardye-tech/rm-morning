/**
 * État persistant de l'actualisation globale.
 *
 * Toute la mécanique de verrou et de progression vit en base, jamais en mémoire.
 * Raison : un processus Next.js redémarre — en développement il redémarre même à
 * chaque modification de fichier. Un verrou en mémoire disparaîtrait alors sans
 * qu'aucune trace ne dise qu'une actualisation avait été interrompue, et
 * l'interface affirmerait que tout est à jour.
 *
 * Lecture et écriture locales SQLite uniquement.
 */

import { getDb } from "../db";

export type SyncStatus = "running" | "success" | "warning" | "failed";
export type StepStatus = "pending" | "running" | "success" | "warning" | "skipped" | "failed";

/**
 * Versions exactes des données produites par une actualisation.
 *
 * Répond à « sur quelles versions ce Morning a-t-il été construit ? ». Chaque
 * champ est nul tant que l'étape correspondante n'a pas abouti.
 */
export type SyncSources = {
  opportunityImportId?: number | null;
  opportunityImportedAt?: string | null;
  /** Quand les jalons d'opportunité ont été recalculés, et sur quel import. */
  milestonesComputedAt?: string | null;
  leadImportedAt?: string | null;
  travauxImportedAt?: string | null;
  perspectiveSnapshotDate?: string | null;
  gmailCursorAt?: string | null;
  gmailLastMessageAt?: string | null;
  expectedScoredAt?: string | null;
  expectedSourceImportAt?: string | null;
  m1GeneratedAt?: string | null;
  officialSignedMonth?: string | null;
  officialSignedGmv?: number | null;
  /** Quand le classement Performance a été recalculé, et sous quelle version. */
  performanceComputedAt?: string | null;
  performanceModelVersion?: string | null;
};

export type SyncStepState = {
  key: string;
  position: number;
  label: string;
  blocking: boolean;
  status: StepStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  detail: string | null;
  error: string | null;
};

export type SyncRunState = {
  id: number;
  startedAt: string;
  completedAt: string | null;
  heartbeatAt: string;
  status: SyncStatus;
  currentStep: string | null;
  durationMs: number | null;
  triggerKind: string;
  error: string | null;
  warnings: string[];
  sources: SyncSources;
  steps: SyncStepState[];
};

/**
 * Au-delà de ce silence, un run « en cours » est considéré mort.
 *
 * Cinq minutes laissent une marge confortable sans transformer un plantage en
 * verrou permanent.
 */
export const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Cadence du battement PENDANT une étape.
 *
 * Le battement n'était autrefois réécrit qu'aux changements d'étape, en
 * supposant qu'aucune étape ne dépasse cinq minutes. Le 23/08 cette hypothèse a
 * cédé : la machine étant bridée par son quota CPU, « Pistes Salesforce » a duré
 * 347 s, et le garde-fou a déclaré mort un run parfaitement vivant — qui s'est
 * d'ailleurs terminé avec succès quatre minutes plus tard.
 *
 * Le battement mesure désormais la vitalité réelle du processus, et non la
 * granularité des étapes. Quinze secondes : vingt fois moins que le seuil, pour
 * une écriture SQLite négligeable.
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 1000;

type RunRow = {
  id: number;
  started_at: string;
  completed_at: string | null;
  heartbeat_at: string;
  status: string;
  current_step: string | null;
  duration_ms: number | null;
  trigger_kind: string;
  error: string | null;
  warnings: string;
  sources: string;
};

type StepRow = {
  step_key: string;
  position: number;
  label: string;
  blocking: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  detail: string | null;
  error: string | null;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function hydrate(row: RunRow): SyncRunState {
  const steps = (
    getDb()
      .prepare("SELECT * FROM global_sync_step WHERE run_id = ? ORDER BY position")
      .all(row.id) as StepRow[]
  ).map((s) => ({
    key: s.step_key,
    position: s.position,
    label: s.label,
    blocking: s.blocking === 1,
    status: s.status as StepStatus,
    startedAt: s.started_at,
    completedAt: s.completed_at,
    durationMs: s.duration_ms,
    detail: s.detail,
    error: s.error,
  }));
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    status: row.status as SyncStatus,
    currentStep: row.current_step,
    durationMs: row.duration_ms,
    triggerKind: row.trigger_kind,
    error: row.error,
    warnings: parseJson<string[]>(row.warnings, []),
    sources: parseJson<SyncSources>(row.sources, {}),
    steps,
  };
}

export function getRun(id: number): SyncRunState | null {
  const row = getDb().prepare("SELECT * FROM global_sync_run WHERE id = ?").get(id) as
    | RunRow
    | undefined;
  return row ? hydrate(row) : null;
}

export function latestRun(): SyncRunState | null {
  const row = getDb()
    .prepare("SELECT * FROM global_sync_run ORDER BY id DESC LIMIT 1")
    .get() as RunRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Les runs de la suite de contrôles ne sont pas des actualisations.
 *
 * Ils exécutent des étapes factices pour éprouver le verrou et les statuts, et
 * n'importent aucune donnée. Les faire apparaître comme « dernière actualisation
 * complète » ferait affirmer à l'interface une fraîcheur qui n'existe pas.
 */
const REAL_RUN = "trigger_kind <> 'verify'";

/**
 * Dernière actualisation COMPLÈTE, conservée séparément d'un échec.
 *
 * « Terminée avec avertissement » compte comme complète : les étapes
 * indispensables ont abouti, seule une source non bloquante manque.
 */
export function lastCompleteRun(): SyncRunState | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM global_sync_run
        WHERE status IN ('success','warning') AND ${REAL_RUN}
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as RunRow | undefined;
  return row ? hydrate(row) : null;
}

export function recentRuns(limit = 20): SyncRunState[] {
  return (
    getDb()
      .prepare(`SELECT * FROM global_sync_run WHERE ${REAL_RUN} ORDER BY id DESC LIMIT ?`)
      .all(limit) as RunRow[]
  ).map(hydrate);
}

/** Dernière tentative RÉELLE, réussie ou non. Sert à dire « échec à telle heure ». */
export function lastRealRun(): SyncRunState | null {
  const row = getDb()
    .prepare(`SELECT * FROM global_sync_run WHERE ${REAL_RUN} ORDER BY id DESC LIMIT 1`)
    .get() as RunRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Le run actif, ou null. Referme au passage tout run dont le battement s'est tu.
 *
 * Appelée avant chaque démarrage : c'est le seul endroit où un verrou mort est
 * levé, et il l'est en le marquant en échec, jamais en le supprimant.
 */
export function activeRun(now = new Date()): SyncRunState | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM global_sync_run WHERE status = 'running' ORDER BY id DESC LIMIT 1")
    .get() as RunRow | undefined;
  if (!row) return null;

  const silent = now.getTime() - new Date(row.heartbeat_at).getTime();
  if (silent > HEARTBEAT_TIMEOUT_MS) {
    db.prepare(
      `UPDATE global_sync_run
          SET status = 'failed', completed_at = ?, duration_ms = ?,
              error = ?
        WHERE id = ?`,
    ).run(
      now.toISOString(),
      now.getTime() - new Date(row.started_at).getTime(),
      "Actualisation interrompue : le processus ne répond plus.",
      row.id,
    );
    db.prepare(
      "UPDATE global_sync_step SET status = 'failed', error = ? WHERE run_id = ? AND status = 'running'",
    ).run("Interrompue", row.id);
    db.prepare(
      "UPDATE global_sync_step SET status = 'skipped' WHERE run_id = ? AND status = 'pending'",
    ).run(row.id);
    return null;
  }
  return hydrate(row);
}

export function createRun(
  steps: { key: string; label: string; blocking: boolean }[],
  triggerKind: string,
  now = new Date(),
): SyncRunState {
  const db = getDb();
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO global_sync_run (started_at, heartbeat_at, status, current_step, trigger_kind)
     VALUES (?, ?, 'running', ?, ?)`,
  ).run(at, at, steps[0]?.key ?? null, triggerKind);
  const id = (db.prepare("SELECT last_insert_rowid() id").get() as { id: number }).id;

  const insert = db.prepare(
    `INSERT INTO global_sync_step (run_id, step_key, position, label, blocking, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  );
  steps.forEach((s, i) => insert.run(id, s.key, i, s.label, s.blocking ? 1 : 0));
  return getRun(id)!;
}

export function beat(runId: number, currentStep: string | null, now = new Date()): void {
  getDb()
    .prepare("UPDATE global_sync_run SET heartbeat_at = ?, current_step = ? WHERE id = ?")
    .run(now.toISOString(), currentStep, runId);
}

export function startStep(runId: number, key: string, now = new Date()): void {
  getDb()
    .prepare(
      "UPDATE global_sync_step SET status = 'running', started_at = ? WHERE run_id = ? AND step_key = ?",
    )
    .run(now.toISOString(), runId, key);
  beat(runId, key, now);
}

export function finishStep(
  runId: number,
  key: string,
  status: StepStatus,
  detail: string | null,
  error: string | null,
  now = new Date(),
): void {
  const db = getDb();
  const row = db
    .prepare("SELECT started_at FROM global_sync_step WHERE run_id = ? AND step_key = ?")
    .get(runId, key) as { started_at: string | null } | undefined;
  const duration = row?.started_at ? now.getTime() - new Date(row.started_at).getTime() : null;
  db.prepare(
    `UPDATE global_sync_step
        SET status = ?, completed_at = ?, duration_ms = ?, detail = ?, error = ?
      WHERE run_id = ? AND step_key = ?`,
  ).run(status, now.toISOString(), duration, detail, error, runId, key);
  beat(runId, key, now);
}

export function mergeSources(runId: number, patch: SyncSources): void {
  const db = getDb();
  const row = db.prepare("SELECT sources FROM global_sync_run WHERE id = ?").get(runId) as
    | { sources: string }
    | undefined;
  const merged = { ...parseJson<SyncSources>(row?.sources ?? "{}", {}), ...patch };
  db.prepare("UPDATE global_sync_run SET sources = ? WHERE id = ?").run(
    JSON.stringify(merged),
    runId,
  );
}

export function completeRun(
  runId: number,
  status: SyncStatus,
  warnings: string[],
  error: string | null,
  now = new Date(),
): void {
  const db = getDb();
  const row = db.prepare("SELECT started_at FROM global_sync_run WHERE id = ?").get(runId) as
    | { started_at: string }
    | undefined;
  db.prepare(
    `UPDATE global_sync_run
        SET status = ?, completed_at = ?, duration_ms = ?, current_step = NULL,
            warnings = ?, error = ?
      WHERE id = ?`,
  ).run(
    status,
    now.toISOString(),
    row ? now.getTime() - new Date(row.started_at).getTime() : null,
    JSON.stringify(warnings),
    error,
    runId,
  );
}

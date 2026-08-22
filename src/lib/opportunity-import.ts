/**
 * Import des jalons d'opportunités — C2.
 *
 * Lecture seule Salesforce. Complète les opportunités déjà importées avec
 * leurs jalons, sans jamais les recréer : ce module ne touche qu'aux colonnes
 * de jalon.
 */

import { OPPORTUNITY_MONITORING } from "./config";
import { getDb, queryAll } from "./db";
import { latestSignalByOpportunity } from "./mail-store";
import {
  countMilestoneEvidence,
  evaluateOpportunity,
  MILESTONE_ANOMALIES,
  type MilestoneThresholds,
  type OppEvent,
  type OppTask,
} from "./opportunity-milestones";
import { runSoql } from "./sources/api-salesforce";

export const MILESTONE_THRESHOLDS: MilestoneThresholds = {
  estimationSlaDays: OPPORTUNITY_MONITORING.estimationSlaDays,
  devisSlaDays: OPPORTUNITY_MONITORING.devisSlaDays,
  dormantAfterDays: OPPORTUNITY_MONITORING.dormantAfterDays,
  clientWaitingAfterDays: OPPORTUNITY_MONITORING.clientWaitingAfterDays,
};

export type MilestoneImportSummary = {
  opportunities: number;
  byStatus: Record<string, number>;
  byNextEvent: Record<string, number>;
  newExceptions: number;
  legacyBacklog: number;
  firstRun: boolean;
  coverage: Record<string, number>;
  degraded: string[];
  durationMs: number;
};

const BATCH = 200;
const quote = (ids: string[]) => ids.map((i) => `'${i}'`).join(",");

/**
 * Salesforce renvoie des identifiants sur 18 caractères ; la base stocke la
 * forme canonique sur 15, comme partout ailleurs dans RM Morning. Sans cette
 * réduction, la jointure activité → opportunité échoue silencieusement et
 * toutes les opportunités paraissent dormantes.
 */
const shortId = (id: string) => (id ?? "").slice(0, 15);

type SfTask = {
  WhatId: string;
  Subject: string | null;
  Description: string | null;
  TaskSubtype: string | null;
  CreatedDate: string;
  CompletedDateTime: string | null;
};
type SfEvent = {
  WhatId: string;
  Subject: string | null;
  StartDateTime: string | null;
  IsAllDayEvent: boolean;
};

export async function importOpportunityMilestones(now = new Date()): Promise<MilestoneImportSummary> {
  const startedAt = Date.now();
  const db = getDb();

  const opportunities = queryAll<{
    opportunity_id: string;
    stage: string | null;
    gmv: number | null;
    standby_until: string | null;
    is_active: number;
  }>(
    // Périmètre : tout ce qui n'est pas terminé. Le stand-by DOIT en faire
    // partie — sans lui, la règle « stand-by expiré » ne pourrait jamais se
    // déclencher, puisque `is_active` exclut ces dossiers par construction.
    `SELECT opportunity_id, stage, gmv, standby_until, is_active
       FROM opportunity WHERE is_terminal = 0`,
  );

  const ids = opportunities.map((o) => o.opportunity_id);
  const tasksBy = new Map<string, OppTask[]>();
  const eventsBy = new Map<string, OppEvent[]>();

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = quote(ids.slice(i, i + BATCH));
    if (!batch) continue;
    const tasks = await runSoql<SfTask>(
      "SELECT WhatId, Subject, Description, TaskSubtype, CreatedDate, CompletedDateTime " +
        `FROM Task WHERE WhatId IN (${batch})`,
    );
    for (const t of tasks) {
      const key = shortId(t.WhatId);
      const list = tasksBy.get(key) ?? [];
      list.push({
        subject: t.Subject,
        description: t.Description,
        subtype: t.TaskSubtype,
        at: t.CompletedDateTime ?? t.CreatedDate,
      });
      tasksBy.set(key, list);
    }
    const events = await runSoql<SfEvent>(
      `SELECT WhatId, Subject, StartDateTime, IsAllDayEvent FROM Event WHERE WhatId IN (${batch})`,
    );
    for (const e of events) {
      if (!e.StartDateTime) continue;
      const key = shortId(e.WhatId);
      const list = eventsBy.get(key) ?? [];
      list.push({ subject: e.Subject, startAt: e.StartDateTime, isAllDay: Boolean(e.IsAllDayEvent) });
      eventsBy.set(key, list);
    }
  }

  // Contrôle de couverture des libellés — alerte technique, pas commerciale.
  const coverage = countMilestoneEvidence(
    opportunities.map((o) => ({
      tasks: tasksBy.get(o.opportunity_id) ?? [],
      events: eventsBy.get(o.opportunity_id) ?? [],
    })),
  );
  const degraded = Object.entries(OPPORTUNITY_MONITORING.minEvidence)
    .filter(([key, min]) => (coverage[key] ?? 0) < min)
    .map(([key]) => key);

  db.prepare(
    "INSERT OR REPLACE INTO milestone_coverage (checked_at, counters, degraded) VALUES (?,?,?)",
  ).run(now.toISOString(), JSON.stringify(coverage), JSON.stringify(degraded));

  // Frontière dette / exception, distincte de celle des pistes.
  const state = db
    .prepare("SELECT opportunities_activated_at AS at FROM monitoring_state WHERE id = 1")
    .get() as { at: string | null } | undefined;
  const firstRun = !state?.at;
  if (firstRun) {
    db.prepare(
      `INSERT INTO monitoring_state (id, activated_at, opportunities_activated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET opportunities_activated_at = excluded.opportunities_activated_at`,
    ).run(now.toISOString(), now.toISOString());
  }

  // Seules les anomalies DÉJÀ constatées comptent : une ligne existante mais
  // sans `milestone_anomaly_since` n'est pas un antécédent.
  const previous = new Map(
    queryAll<{ opportunity_id: string; since: string | null; legacy: number | null }>(
      `SELECT opportunity_id, milestone_anomaly_since AS since, milestone_is_legacy AS legacy
         FROM opportunity WHERE milestone_anomaly_since IS NOT NULL`,
    ).map((r) => [r.opportunity_id, { since: r.since, legacy: Number(r.legacy) === 1 }]),
  );

  const mailSignals = latestSignalByOpportunity();
  const byStatus: Record<string, number> = {};
  const byNextEvent: Record<string, number> = {};
  const snapshotDate = now.toISOString().slice(0, 10);

  const update = db.prepare(
    `UPDATE opportunity SET
       estimation_sent_at = ?, estimation_relance_at = ?, devis_sent_at = ?, devis_relance_at = ?,
       last_visit_at = ?, next_visit_at = ?, visit_kind = ?, last_human_action_at = ?,
       next_expected_event = ?, next_expected_due_at = ?, milestone_status = ?,
       milestone_reason = ?, milestone_lateness_hours = ?, client_waiting = ?,
       milestone_anomaly_since = ?, milestone_is_legacy = ?
     WHERE opportunity_id = ?`,
  );
  const snapshot = db.prepare(
    `UPDATE opportunity_snapshot SET milestone_status = ?, next_expected_event = ?,
            milestone_lateness_hours = ?, milestone_is_legacy = ?
      WHERE snapshot_date = ? AND opportunity_id = ?`,
  );

  for (const o of opportunities) {
    const signal = mailSignals.get(o.opportunity_id);
    const verdict = evaluateOpportunity(
      {
        opportunityId: o.opportunity_id,
        stage: o.stage,
        amount: o.gmv,
        standbyUntil: o.standby_until,
        isActive: o.is_active === 1,
        tasks: tasksBy.get(o.opportunity_id) ?? [],
        events: eventsBy.get(o.opportunity_id) ?? [],
        mailSignal: signal
          ? { direction: "entrant", signalType: signal.signalType, sentAt: signal.sentAt }
          : null,
      },
      MILESTONE_THRESHOLDS,
      now.getTime(),
    );

    const isAnomaly = MILESTONE_ANOMALIES.includes(verdict.milestoneStatus);
    const before = previous.get(o.opportunity_id);
    const anomalySince = isAnomaly ? (before?.since ?? now.toISOString()) : null;
    const isLegacy = isAnomaly ? (before?.legacy ?? firstRun) : false;

    byStatus[verdict.milestoneStatus] = (byStatus[verdict.milestoneStatus] ?? 0) + 1;
    if (verdict.nextExpectedEvent) {
      byNextEvent[verdict.nextExpectedEvent] = (byNextEvent[verdict.nextExpectedEvent] ?? 0) + 1;
    }

    update.run(
      verdict.estimationSentAt, verdict.estimationRelanceAt, verdict.devisSentAt,
      verdict.devisRelanceAt, verdict.lastVisitAt, verdict.nextVisitAt, verdict.visitKind,
      verdict.lastHumanActionAt, verdict.nextExpectedEvent, verdict.nextExpectedDueAt,
      verdict.milestoneStatus, verdict.milestoneReason, verdict.latenessHours,
      verdict.clientWaiting ? 1 : 0, anomalySince, isLegacy ? 1 : 0, o.opportunity_id,
    );
    snapshot.run(
      verdict.milestoneStatus, verdict.nextExpectedEvent, verdict.latenessHours,
      isLegacy ? 1 : 0, snapshotDate, o.opportunity_id,
    );
  }

  const counts = queryAll<{ legacy: number; n: number }>(
    `SELECT milestone_is_legacy AS legacy, COUNT(*) AS n FROM opportunity
      WHERE is_terminal = 0 AND milestone_status IN
            ('sla_estimation','sla_devis','client_attend','dormant_candidate','standby_expire')
      GROUP BY milestone_is_legacy`,
  );
  let newExceptions = 0;
  let legacyBacklog = 0;
  for (const c of counts) {
    if (Number(c.legacy) === 1) legacyBacklog = Number(c.n);
    else newExceptions = Number(c.n);
  }

  return {
    opportunities: opportunities.length,
    byStatus,
    byNextEvent,
    newExceptions,
    legacyBacklog,
    firstRun,
    coverage,
    degraded,
    durationMs: Date.now() - startedAt,
  };
}

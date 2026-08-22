/**
 * Fraîcheur de chaque source, lue directement à la source et non au journal.
 *
 * Distinction importante : le run global dit ce que la DERNIÈRE actualisation a
 * produit ; ce module dit dans quel état la base se trouve MAINTENANT. Les deux
 * peuvent différer — un import lancé à la main depuis Données, un run partiel —
 * et c'est justement ce que le diagnostic doit montrer.
 *
 * Lecture seule.
 */

import { getDb } from "../db";
import { buildExpectedGmvSnapshot } from "../expected-gmv-live";
import { buildExpectedM1 } from "../expected-m1";
import { latestSync } from "../mail-store";
import { officialSignedGmv } from "../official-signed";
import { lastCompleteRun } from "./store";

export type SourceFreshness = {
  key: string;
  label: string;
  /** ok = à jour ; stale = en retard sur une autre source ; absent = jamais produit. */
  state: "ok" | "stale" | "absent";
  at: string | null;
  volume: string | null;
  note: string | null;
};

export type FreshnessReport = {
  lastCompleteAt: string | null;
  lastCompleteStatus: string | null;
  lastCompleteDurationMs: number | null;
  sources: SourceFreshness[];
};

function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function freshnessReport(): FreshnessReport {
  const complete = lastCompleteRun();

  const opp = one<{ imported_at: string; total_rows: number; team_rows: number }>(
    `SELECT imported_at, total_rows, team_rows FROM import_run
      WHERE source_kind IN ('api','file','manual') ORDER BY id DESC LIMIT 1`,
  );
  const leads = one<{ imported_at: string; total_rows: number }>(
    `SELECT imported_at, total_rows FROM import_run
      WHERE source_kind LIKE 'leads%' ORDER BY id DESC LIMIT 1`,
  );
  const travaux = one<{ at: string; n: number }>(
    "SELECT MAX(last_import_at) at, COUNT(*) n FROM travaux",
  );
  const perspective = one<{ at: string; n: number }>(
    "SELECT MAX(snapshot_date) at, COUNT(*) n FROM forecast_snapshot",
  );
  const mail = latestSync();
  const snap = buildExpectedGmvSnapshot();
  const m1 = buildExpectedM1();

  const month = new Date().toISOString().slice(0, 7);
  let signed: { gmv: number; lines: number } | null = null;
  try {
    const official = officialSignedGmv(month);
    signed = { gmv: official.gmv, lines: official.lines };
  } catch {
    signed = null;
  }

  const sources: SourceFreshness[] = [
    {
      key: "opportunites",
      label: "Opportunités Salesforce",
      state: opp ? "ok" : "absent",
      at: opp?.imported_at ?? null,
      volume: opp ? `${opp.team_rows} sur ${opp.total_rows} lues` : null,
      note: null,
    },
    {
      key: "pistes",
      label: "Pistes Salesforce",
      state: leads ? "ok" : "absent",
      at: leads?.imported_at ?? null,
      volume: leads ? `${leads.total_rows} piste(s)` : null,
      note: null,
    },
    {
      key: "travaux",
      label: "Travaux",
      state: travaux?.at ? "ok" : "absent",
      at: travaux?.at ?? null,
      volume: travaux ? `${travaux.n} ligne(s)` : null,
      note: signed
        ? `Signé officiel du mois : ${Math.round(signed.gmv / 1000)} k€ sur ${signed.lines} ligne(s)`
        : "Signé officiel non calculable",
    },
    {
      key: "perspective",
      label: "Perspective",
      state: perspective?.at ? "ok" : "absent",
      at: perspective?.at ?? null,
      volume: perspective ? `${perspective.n} ligne(s)` : null,
      // La Perspective est hebdomadaire : une date de plusieurs jours n'est pas
      // une panne, c'est sa cadence. On l'énonce sans la qualifier.
      note: "Photographie hebdomadaire du déclaratif — sa date est celle du Sheet.",
    },
    {
      key: "emails",
      label: "Emails",
      state: mail ? (mail.finishedAt ? "ok" : "stale") : "absent",
      at: mail?.windowEnd ?? null,
      volume: mail ? `${mail.kept} message(s) retenu(s) au dernier passage` : null,
      note: mail?.finishedAt ? null : "Dernier passage non terminé : le curseur précédent est conservé.",
    },
    {
      key: "expected-m",
      label: "Prévision du mois",
      // LE contrôle central : une prévision plus ancienne que le dernier import
      // décrit un pipe que la base n'a plus.
      state: snap == null ? "absent" : snap.supersededByImport ? "stale" : "ok",
      at: snap?.scoredAt ?? null,
      volume: snap ? `${snap.region.count} affaire(s) scorée(s)` : null,
      note:
        snap == null
          ? null
          : snap.supersededByImport
            ? "Antérieure au dernier import : à recalculer."
            : `Prévision de fin de mois ${Math.round(snap.region.expectedFinish / 1000)} k€`,
    },
    {
      key: "projection-m1",
      label: "Projection du mois prochain",
      state: m1 == null ? "absent" : m1.supersededByImport ? "stale" : "ok",
      at: m1?.generatedAt ?? null,
      volume: m1 ? `${m1.scoredCount} affaire(s) scorée(s)` : null,
      note:
        m1 == null
          ? null
          : m1.supersededByImport
            ? "Antérieure au dernier import : à recalculer."
            : `${m1.targetMonthLabel} · ${Math.round(m1.projection / 1000)} k€ · confiance ${m1.confidence}`,
    },
  ];

  return {
    lastCompleteAt: complete?.completedAt ?? null,
    lastCompleteStatus: complete?.status ?? null,
    lastCompleteDurationMs: complete?.durationMs ?? null,
    sources,
  };
}

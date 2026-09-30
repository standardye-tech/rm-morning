import { ExpectedReliabilityBlock } from "@/components/expected-reliability";
import {
  ExpectedForecastDetail,
  ExpectedGmvBySalesperson,
  ExpectedGmvChallenge,
  ExpectedGmvFreshness,
  ExpectedGmvHorizons,
  ExpectedGmvLimits,
} from "@/components/expected-gmv";
import { M1OverviewBlock } from "@/components/m1-overview";
import { Card, EmptyState } from "@/components/ui";
import { parisDate } from "@/lib/business-time";
import {
  buildConstruireM1,
  FUTURE_SHARE_M1,
  FUTURE_SHARE_M2,
  nextBusinessMonth,
} from "@/lib/build-m1";
import { buildExpectedGmvSnapshot } from "@/lib/expected-gmv-live";
import { buildExpectedReliability } from "@/lib/expected-reliability-view";
import { monthLabel } from "@/lib/forecast-board";
import { buildForecastV2, expectedChallengers } from "@/lib/forecast-v2";
import { buildM1Trajectory } from "@/lib/m1-trajectory";
import { officialMonthlyReference } from "@/lib/official-signed";

export const dynamic = "force-dynamic";

/**
 * Expected GMV — ce que RM Morning prévoit, pourquoi, avec quel niveau de
 * fiabilité, et quelles affaires peuvent modifier l'atterrissage.
 *
 * Deux vues du même écran :
 *   — « Ce mois-ci » : synthèse M / M+1 / M+2, fiabilité mesurée, affaires à
 *     challenger (> 15 %), puis le détail en lecture métier ;
 *   — « mois prochain » : une seule section « Octobre — où en est-on ? »
 *     (objectif, déclaratif, perspective ajustée, prévision, manque, rythme,
 *     trajectoire, écart commerciaux / RM Morning, affaires suggérées).
 *
 * Lot de simplification : plus de filtres ni de tris ici — l'exploration affaire
 * par affaire (« Affaires scorées ») n'est plus rendue ; le scoring reste le
 * moteur de toutes ces lectures.
 */
export default async function ExpectedGmvPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const m1View = query.vue === "m1";
  const nextLabel = monthLabel(nextBusinessMonth());

  const tabs = (
    <div className="mt-3 flex w-fit gap-1 rounded-lg bg-canvas p-1 ring-1 ring-line">
      {[
        { href: "/expected-gmv", label: "Ce mois-ci", active: !m1View },
        { href: "/expected-gmv?vue=m1", label: `Mois prochain — ${nextLabel}`, active: m1View },
      ].map((t) => (
        <a
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={`inline-flex min-h-9 items-center rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5 ${
            t.active ? "bg-surface font-medium text-ink" : "text-ink-soft hover:bg-surface hover:text-ink"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );

  if (m1View) {
    const m1 = await buildConstruireM1();
    return (
      <div className="space-y-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expected GMV</h1>
          {tabs}
        </div>
        <M1OverviewBlock data={m1} trajectory={buildM1Trajectory(m1, parisDate())} />
      </div>
    );
  }

  const snap = buildExpectedGmvSnapshot();
  if (!snap) {
    return (
      <div className="py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Expected GMV</h1>
        {tabs}
        <Card className="mt-6">
          <EmptyState>
            Aucun scoring disponible. Lancer la commande npm <code>expected:score</code> après un import Salesforce pour
            produire la prévision.
          </EmptyState>
        </Card>
      </div>
    );
  }

  // Une seule source pour la prévision commerciale et les affaires à challenger :
  // Forecast V2. Les horizons suivants viennent de la MÊME source que Forecast.
  const board = buildForecastV2(0);
  const boardM1 = buildForecastV2(1);
  const boardM2 = buildForecastV2(2);
  const reliability = buildExpectedReliability();
  const challengers = expectedChallengers(board);

  const m1Declarative = {
    label: boardM1.monthLabel,
    kanbanGmv: boardM1.region.kanbanGmv,
    kanbanCount: boardM1.region.count,
    perspectiveGmv: boardM1.region.perspectiveSnapshotGmv,
    futureShare: FUTURE_SHARE_M1,
  };
  const m2Declarative = {
    label: boardM2.monthLabel,
    kanbanGmv: boardM2.region.kanbanGmv,
    kanbanCount: boardM2.region.count,
    perspectiveGmv: boardM2.region.perspectiveSnapshotGmv,
    futureShare: FUTURE_SHARE_M2,
  };
  const m1Suggestions = {
    count: boardM1.examine.length,
    gmv: boardM1.examine.reduce((t, e) => t + (e.row.gmv ?? 0), 0),
  };

  return (
    <div className="space-y-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expected GMV</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Où RM Morning pense que nous allons finir, pourquoi, et avec quelle fiabilité. Cette estimation est
            indépendante de ce que les commerciaux annoncent : elle repose sur l&apos;historique des affaires.
          </p>
          {tabs}
        </div>
        <p className="text-xs text-ink-faint md:text-right">
          Calculé le{" "}
          {new Date(snap.scoredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
        </p>
      </div>

      <ExpectedGmvFreshness snap={snap} />

      <ExpectedGmvHorizons
        snap={snap}
        commercial={board.region.commercialLanding}
        commercialCount={board.region.declaredOpenCount}
        m1={boardM1.expectedM1}
        m1Declarative={m1Declarative}
        m1Suggestions={m1Suggestions}
        m2={m2Declarative}
        reference={officialMonthlyReference(12)}
      />

      <ExpectedReliabilityBlock view={reliability} />

      <ExpectedGmvChallenge items={challengers} />

      <details className="group rounded-xl border border-line bg-surface">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium hover:bg-canvas md:px-6">
          Voir le détail de la prévision
          <span className="ml-2 text-xs font-normal text-ink-faint">
            ce qui est signé, ce qui reste probable, d&apos;où vient la prévision
          </span>
        </summary>
        <div className="space-y-6 border-t border-line p-4">
          <ExpectedForecastDetail snap={snap} />
          <ExpectedGmvBySalesperson rows={snap.salespeople.filter((s) => s.count > 0 || s.signedGmv > 0)} region={snap.region} />
          <ExpectedGmvLimits outOfScopeShare={0.064} />
        </div>
      </details>

      {snap.issues.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-ink-faint md:px-6">
          <summary className="cursor-pointer list-none underline decoration-dotted">
            {snap.issues.length} remarque(s) sur le calcul
          </summary>
          <ul className="mt-2 space-y-1">
            {snap.issues.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

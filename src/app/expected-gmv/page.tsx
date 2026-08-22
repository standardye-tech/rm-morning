import { ExpectedGmvChallenge } from "@/components/expected-gmv";
import {
  ExpectedGmvBacktest,
  ExpectedGmvBySalesperson,
  ExpectedGmvFreshness,
  ExpectedGmvHorizons,
  ExpectedGmvLimits,
  ExpectedGmvOpportunities,
  ExpectedGmvReliabilityCard,
  ExpectedGmvSummary,
} from "@/components/expected-gmv";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import { buildExpectedGmvSnapshot, type ExpectedGmvOpportunity } from "@/lib/expected-gmv-live";
import { buildForecastV2 } from "@/lib/forecast-v2";
import { officialMonthlyReference } from "@/lib/official-signed";

export const dynamic = "force-dynamic";

/**
 * Expected GMV — lecture de la prévision statistique, Région → Commercial →
 * Opportunité.
 *
 * Cet écran n'arbitre pas le déclaratif : il ne confronte pas Kanban et
 * Perspective, il explique une estimation. La confrontation complète appartient
 * à Forecast, qui n'est pas touché ici.
 *
 * Les deux horizons sont deux lectures, pas deux moitiés d'un même chiffre. Le
 * sélecteur d'horizon change ce qui est mis en avant et le tri par défaut ; il
 * ne masque jamais l'autre colonne, pour qu'on puisse voir qu'une affaire très
 * probable et une affaire très contributive ne sont pas la même chose.
 */

const HORIZONS = [
  { key: "mois", label: "Fin de mois" },
  { key: "7j", label: "7 jours" },
] as const;

const SORTS = [
  { key: "probabilite", label: "Plus susceptibles de signer" },
  { key: "contribution", label: "Plus fort GMV probable" },
  { key: "gmv", label: "GMV" },
] as const;

const ROW_LIMIT = 60;

export default async function ExpectedGmvPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const horizon = query.horizon === "7j" ? "7j" : "mois";
  const ownerFilter = typeof query.commercial === "string" ? query.commercial : null;
  const stageFilter = typeof query.etape === "string" ? query.etape : null;
  const sort =
    query.tri === "probabilite" || query.tri === "gmv" ? query.tri : "contribution";
  const showAll = query.tout === "1";
  const detail = query.detail === "1";

  const snap = buildExpectedGmvSnapshot();
  // Une seule source pour la prévision commerciale et pour les affaires à
  // challenger : Forecast V2. Les deux écrans montrent donc exactement les mêmes
  // lignes jaunes, et le même total annoncé par l'équipe.
  const board = snap ? buildForecastV2(0) : null;
  // Les horizons suivants viennent de la MÊME source que Forecast : la projection
  // M+1, ses lignes jaunes et le déclaratif M+2 ne sont calculés qu'une fois dans
  // l'application. Les deux écrans ne peuvent donc pas diverger.
  const boardM1 = buildForecastV2(1);
  const boardM2 = buildForecastV2(2);

  const link = (params: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    if (horizon !== "mois") sp.set("horizon", horizon);
    if (ownerFilter) sp.set("commercial", ownerFilter);
    if (stageFilter) sp.set("etape", stageFilter);
    if (sort !== "contribution") sp.set("tri", sort);
    if (showAll) sp.set("tout", "1");
    if (detail) sp.set("detail", "1");
    for (const [k, v] of Object.entries(params)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    return `/expected-gmv${sp.toString() ? `?${sp}` : ""}`;
  };

  const tab = (isActive: boolean) =>
    `inline-flex min-h-9 items-center rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5 ${
      isActive ? "bg-surface font-medium text-ink" : "text-ink-soft hover:bg-surface hover:text-ink"
    }`;
  const chip = (isActive: boolean) =>
    `inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs transition-colors md:min-h-0 md:py-1 ${
      isActive ? "bg-surface font-medium text-ink" : "text-ink-soft hover:bg-surface hover:text-ink"
    }`;

  if (!snap) {
    return (
      <div className="py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Expected GMV</h1>
        <Card className="mt-6">
          <EmptyState>
            Aucun scoring disponible. Lancer la commande npm <code>expected:score</code> après un
            import Salesforce pour produire la prévision.
          </EmptyState>
        </Card>
      </div>
    );
  }

  // Les filtres s'appliquent aux LIGNES ; les sous-totaux et le total Région
  // sont ensuite resommés depuis ces mêmes lignes. Un seul chemin de calcul,
  // donc jamais d'écart entre les trois niveaux (EC1, EC2).
  const kept = snap.opportunities.filter(
    (o) =>
      (!ownerFilter || o.owner === ownerFilter) && (!stageFilter || (o.stage ?? "—") === stageFilter),
  );
  const filtered = ownerFilter !== null || stageFilter !== null;

  const salespeople = snap.salespeople
    .filter((s) => !ownerFilter || s.salesperson === ownerFilter)
    .map((s) => {
      const own = kept.filter((o) => o.owner === s.salesperson);
      const expectedMonthEnd = own.reduce((t, o) => t + o.expectedMonthEnd, 0);
      return {
        ...s,
        count: own.length,
        openGmv: own.reduce((t, o) => t + o.gmv, 0),
        expected7d: own.reduce((t, o) => t + o.expected7d, 0),
        expectedMonthEnd,
        expectedFinish: s.signedGmv + expectedMonthEnd,
        opportunities: own,
      };
    })
    .filter((s) => s.count > 0 || s.signedGmv > 0);

  const signedGmv = salespeople.reduce((t, s) => t + s.signedGmv, 0);
  const expectedRemaining = salespeople.reduce((t, s) => t + s.expectedMonthEnd, 0);
  const region = filtered
    ? {
        ...snap.region,
        count: salespeople.reduce((t, s) => t + s.count, 0),
        openGmv: salespeople.reduce((t, s) => t + s.openGmv, 0),
        expected7d: salespeople.reduce((t, s) => t + s.expected7d, 0),
        signedGmv,
        expectedRemaining,
        expectedFinish: signedGmv + expectedRemaining,
      }
    : snap.region;

  const value = (o: ExpectedGmvOpportunity) => {
    if (sort === "gmv") return o.gmv;
    if (sort === "probabilite") return horizon === "7j" ? o.p7d : o.pMonthEnd;
    return horizon === "7j" ? o.expected7d : o.expectedMonthEnd;
  };
  const sorted = kept.slice().sort((a, b) => value(b) - value(a));
  const rows = showAll ? sorted : sorted.slice(0, ROW_LIMIT);

  const stages = [...new Set(snap.opportunities.map((o) => o.stage ?? "—"))].sort((a, b) =>
    a.localeCompare(b, "fr"),
  );

  // Part du GMV venue d'affaires pas encore créées, RECALCULÉE en C8.1 sur la
  // vérité officielle Travaux : 46 % pour le mois suivant, 61 % pour celui
  // d'après. Les valeurs de C8 (29 % et 54 %) étaient mesurées sur les montants
  // d'opportunités et sous-estimaient le pipe futur, parce que les avenants et
  // les annulations s'accrochent à des affaires créées après l'observation.
  const FUTURE_SHARE_M1 = "46 %";
  const FUTURE_SHARE_M2 = "61 %";
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
  // Douze mois et non vingt-quatre : c'est exactement la fenêtre qui sert de socle
  // à la projection M+1, donc le repère M+2 et la baseline M+1 disent la même
  // chose du même historique.
  const reference = officialMonthlyReference(12);
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
            Où RM Morning pense que nous allons finir, et pourquoi. Cette estimation est
            indépendante de ce que les commerciaux annoncent : elle repose uniquement sur
            l&apos;historique des affaires.
          </p>
        </div>
        {/*
          Aligné à droite quand il y a de la place à sa droite, et sur le texte
          quand il n'y en a pas : à 375 px, le `text-right` seul produisait deux
          lignes flottant au milieu de l'écran, sans rapport visible avec quoi
          que ce soit.
        */}
        <p className="text-xs text-ink-faint md:text-right">
          {snap.modelVersion} · Scoré le{" "}
          {new Date(snap.scoredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
        </p>
      </div>

      <ExpectedGmvFreshness snap={snap} />

      <ExpectedGmvHorizons
        snap={snap}
        commercial={board ? board.region.signedGmvActual + board.region.kanbanGmv : null}
        commercialCount={board ? board.region.count : null}
        m1={boardM1.expectedM1}
        m1Declarative={m1Declarative}
        m1Suggestions={m1Suggestions}
        m2={m2Declarative}
        reference={reference}
      />

      {board && board.examine.length > 0 ? (
        <ExpectedGmvChallenge items={board.examine} limit={8} />
      ) : null}

      {/*
        Tout le reste est du détail. Deux dépliables seulement : ce qui compose
        la prévision, et comment elle est calculée. Le premier niveau de la page
        ne doit pas ressembler à une interface de data science.
      */}
      <details className="group rounded-xl border border-line bg-surface" open={detail}>
        <summary className="cursor-pointer list-none px-4 md:px-6 py-3 text-sm font-medium hover:bg-canvas">
          Voir le détail de la prévision
          <span className="ml-1 group-open:hidden" aria-hidden>
            &#9656;
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            &#9662;
          </span>
          <span className="ml-2 text-xs font-normal text-ink-faint">
            prochaines signatures, répartition par commercial, toutes les affaires suivies
          </span>
        </summary>
        <div className="space-y-6 border-t border-line p-4">
          <ExpectedGmvSummary snap={{ ...snap, region }} />
          <ExpectedGmvBySalesperson rows={salespeople} region={region} horizon={horizon} />

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-lg bg-canvas p-1 ring-1 ring-line">
              {HORIZONS.map((h) => (
                <a
                  key={h.key}
                  href={link({ horizon: h.key === "mois" ? null : h.key })}
                  className={tab(horizon === h.key)}
                >
                  {h.label}
                </a>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg bg-canvas p-1 ring-1 ring-line">
              {SORTS.map((so) => (
                <a
                  key={so.key}
                  href={link({ tri: so.key === "contribution" ? null : so.key })}
                  className={chip(sort === so.key)}
                >
                  {so.label}
                </a>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
              Commercial
            </span>
            <div className="flex flex-wrap gap-1 rounded-lg bg-canvas p-1 ring-1 ring-line">
              <a href={link({ commercial: null })} className={chip(!ownerFilter)}>
                Tous
              </a>
              {snap.salespeople.map((sp) => (
                <a
                  key={sp.salesperson}
                  href={link({ commercial: sp.salesperson })}
                  className={chip(ownerFilter === sp.salesperson)}
                >
                  {sp.salesperson}
                </a>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
              Étape
            </span>
            <div className="flex flex-wrap gap-1 rounded-lg bg-canvas p-1 ring-1 ring-line">
              <a href={link({ etape: null })} className={chip(!stageFilter)}>
                Toutes
              </a>
              {stages.map((st) => (
                <a key={st} href={link({ etape: st })} className={chip(stageFilter === st)}>
                  {st}
                </a>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <Card>
              <SectionTitle eyebrow="Niveau opportunité" title="Affaires suivies" />
              <EmptyState>Aucune affaire ne correspond à ces filtres.</EmptyState>
            </Card>
          ) : (
            <ExpectedGmvOpportunities
            rows={rows}
            horizon={horizon}
            total={kept.length}
            challenged={new Set((board?.examine ?? []).map((e) => e.row.opportunityId))}
          />
          )}

          {!showAll && sorted.length > ROW_LIMIT ? (
            <p className="text-center text-xs text-ink-faint">
              <a href={link({ tout: "1" })} className="-my-2 inline-block py-2 underline decoration-dotted hover:text-ink md:my-0 md:py-0">
                Voir toutes les affaires estimées ({sorted.length}) &#9662;
              </a>
            </p>
          ) : null}
          {showAll && sorted.length > ROW_LIMIT ? (
            <p className="text-center text-xs text-ink-faint">
              <a href={link({ tout: null })} className="-my-2 inline-block py-2 underline decoration-dotted hover:text-ink md:my-0 md:py-0">
                Replier sur les {ROW_LIMIT} premières &#9652;
              </a>
            </p>
          ) : null}
        </div>
      </details>

      <details id="backtest" className="group scroll-mt-6 rounded-xl border border-line bg-surface">
        <summary className="cursor-pointer list-none px-4 md:px-6 py-3 text-sm font-medium hover:bg-canvas">
          Comprendre comment RM Morning calcule
          <span className="ml-1 group-open:hidden" aria-hidden>
            &#9656;
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            &#9662;
          </span>
          <span className="ml-2 text-xs font-normal text-ink-faint">
            performance passée, fiabilité, limites, modèles utilisés
          </span>
        </summary>
        <div className="space-y-6 border-t border-line p-4">
          <ExpectedGmvReliabilityCard rel={snap.reliability} />
          <ExpectedGmvBacktest rel={snap.reliability} />
          <ExpectedGmvLimits outOfScopeShare={0.064} />
        </div>
      </details>

      {snap.issues.length > 0 ? (
        <Card>
          <SectionTitle eyebrow="Contrôle" title="Anomalies du scoring" />
          <ul className="space-y-1 px-4 md:px-6 py-4 text-xs text-ink-soft">
            {snap.issues.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

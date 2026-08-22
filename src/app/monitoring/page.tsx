import Link from "next/link";

import { LeadSummary, LeadTodo, OwnerTable } from "@/components/monitoring";
import {
  ExceptionBlock,
  OpportunityOwnerTable,
  OpportunitySummary,
  ValueBlock,
} from "@/components/monitoring-opportunities";
import {
  computeOpportunityMetrics,
  loadMilestoneOpportunities,
  reactivableDeals,
} from "@/lib/opportunity-metrics";
import { Card, EmptyState } from "@/components/ui";
import { computeLeadMetrics, type Period } from "@/lib/lead-metrics";
import { leadMonitoringView, opportunityMonitoringView } from "@/lib/monitoring-view";
import { loadLeads, monitoringActivatedAt } from "@/lib/lead-store";

export const dynamic = "force-dynamic";

/**
 * Monitoring — management opérationnel.
 *
 * Une seule page, plusieurs vues. « Pistes » est la première ; « Opportunités »
 * et « Équipe » sont annoncées mais non développées, pour que l'architecture
 * accueille la suite sans créer un onglet par métrique.
 */
const VIEWS = [
  { key: "pistes", label: "Pistes", ready: true },
  { key: "opportunites", label: "Opportunités", ready: true },
  { key: "equipe", label: "Équipe", ready: false },
] as const;

const PERIODS: Period[] = ["7j", "30j", "mois"];

/**
 * Enveloppe dépliable des tableaux par commercial.
 *
 * Le tableau lui-même n'est pas modifié : seuls les calculs de C1 et C2 y font
 * autorité et ils restent intacts. Ce qui change est sa place — après ce qu'il
 * faut traiter, et replié par défaut.
 */
function CollapsedSummary({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group mt-6 rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer list-none px-4 md:px-6 py-3 text-sm font-medium hover:bg-canvas">
        {title}
        <span className="ml-1 group-open:hidden" aria-hidden>
          ▸
        </span>
        <span className="ml-1 hidden group-open:inline" aria-hidden>
          ▾
        </span>
        <span className="ml-2 text-xs font-normal text-ink-faint">{hint}</span>
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}

export default async function MonitoringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const view = typeof query.vue === "string" ? query.vue : "pistes";
  const period: Period =
    query.periode === "7j" || query.periode === "30j" ? query.periode : "mois";
  const ownerFilter = typeof query.commercial === "string" ? query.commercial : null;

  const activatedAt = monitoringActivatedAt();
  const allLeads = loadLeads();
  const leads = ownerFilter ? allLeads.filter((l) => l.owner === ownerFilter) : allLeads;
  const metrics = computeLeadMetrics(leads, period);
  // Les listes à traiter passent par la vue de lecture : elles ne montrent que
  // ce qui n'a pas encore été lu, ou ce qui a changé depuis. Les KPI, eux,
  // restent calculés sur le stock complet — lire une anomalie ne la fait pas
  // disparaître des compteurs.
  const leadView = leadMonitoringView(ownerFilter);

  const allOpportunities = loadMilestoneOpportunities();
  const opportunities = ownerFilter
    ? allOpportunities.filter((o) => o.owner === ownerFilter)
    : allOpportunities;
  const oppMetrics = computeOpportunityMetrics(opportunities);
  const opportunityView = opportunityMonitoringView(ownerFilter);
  const reactivable = reactivableDeals(opportunities);

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Management opérationnel — le détail vit ici, le Morning reste un résumé.
            {activatedAt
              ? ` Observation depuis le ${new Date(activatedAt).toLocaleDateString("fr-FR")}.`
              : ""}
          </p>
        </div>
      </div>



      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1">
          {VIEWS.map((v) =>
            v.ready ? (
              <Link
                key={v.key}
                href={`/monitoring?vue=${v.key}&periode=${period}`}
                className={`inline-flex min-h-9 items-center rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5 ${
                  view === v.key
                    ? "bg-surface font-medium text-ink"
                    : "text-ink-soft hover:bg-surface hover:text-ink"
                }`}
              >
                {v.label}
              </Link>
            ) : (
              <span
                key={v.key}
                className="inline-flex min-h-9 cursor-not-allowed items-center rounded-md px-3 py-2 text-sm text-ink-faint md:min-h-0 md:py-1.5"
                title="Vue prévue, non développée"
              >
                {v.label}
              </span>
            ),
          )}
        </nav>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/monitoring?vue=${view}&periode=${p}${ownerFilter ? `&commercial=${encodeURIComponent(ownerFilter)}` : ""}`}
              className={`inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs transition-colors md:min-h-0 md:py-1 ${
                period === p
                  ? "bg-surface font-medium text-ink"
                  : "text-ink-soft hover:bg-surface hover:text-ink"
              }`}
            >
              {p === "mois" ? "mois en cours" : p}
            </Link>
          ))}
        </div>
      </div>

      {ownerFilter ? (
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-ink-soft">
            Filtré sur <span className="font-medium text-ink">{ownerFilter}</span>
          </span>
          <Link
            href={`/monitoring?vue=${view}&periode=${period}`}
            className="text-xs text-ink-faint underline hover:text-ink"
          >
            retirer le filtre
          </Link>
        </div>
      ) : null}

      {view === "opportunites" ? (
        opportunities.length === 0 ? (
          <Card className="mt-6">
            <EmptyState>
              Aucun jalon calculé. Lancez « Actualiser RM Morning » pour activer le Monitoring
              Opportunités.
            </EmptyState>
          </Card>
        ) : (
          <>
            {/*
              Ordre d'usage : ce qu'il faut traiter d'abord, l'analyse par
              commercial ensuite. Le tableau par commercial monopolisait l'écran
              alors qu'il répond à une autre question — qui a du retard, pas
              quelle affaire débloquer.
            */}
            <div className="mt-6">
              <OpportunitySummary metrics={oppMetrics} />
            </div>
            <ValueBlock view={opportunityView} owner={ownerFilter} />
            <ExceptionBlock items={opportunityView.exceptions} reactivable={reactivable} />
            <CollapsedSummary
              title="Synthèse par commercial"
              hint={`${oppMetrics.owners.length} commerciaux · retards et affaires suivies`}
            >
              <OpportunityOwnerTable owners={oppMetrics.owners} />
            </CollapsedSummary>
          </>
        )
      ) : view !== "pistes" ? (
        <Card className="mt-6">
          <EmptyState>
            Vue prévue pour une phase ultérieure. Le moteur de jalons est déjà partagé avec les
            pistes et les opportunités.
          </EmptyState>
        </Card>
      ) : allLeads.length === 0 ? (
        <Card className="mt-6">
          <EmptyState>
            Aucune piste importée. Lancez « Actualiser RM Morning » pour activer le Monitoring.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mt-6">
            <LeadSummary metrics={metrics} />
          </div>
          <LeadTodo view={leadView} owner={ownerFilter} />
          <CollapsedSummary
            title="Synthèse par commercial"
            hint={`${metrics.owners.length} commerciaux · First Calls, échéances, conversions`}
          >
            <OwnerTable owners={metrics.owners} />
          </CollapsedSummary>
        </>
      )}
    </div>
  );
}

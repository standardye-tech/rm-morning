import { formatEurShort } from "@/lib/normalize";
import {
  MILESTONE_LABEL,
  NEXT_EVENT_LABEL,
  type MilestoneStatus,
} from "@/lib/opportunity-milestones";
import type {
  OwnerOpportunityMetrics,
  TeamOpportunityMetrics,
} from "@/lib/opportunity-metrics";
import type { ExceptionEntry, OpportunityMonitoringView } from "@/lib/monitoring-view";
import { AllHandled, ChangeLine, ToutLireButton } from "./monitoring-read";
import { Badge, Card, EmptyState, SectionTitle, Stat } from "./ui";

const TONE: Record<MilestoneStatus, "neutral" | "positive" | "warning" | "danger"> = {
  a_venir: "positive",
  normal: "neutral",
  standby: "neutral",
  standby_expire: "warning",
  sla_estimation: "warning",
  sla_devis: "warning",
  client_attend: "danger",
  dormant_candidate: "neutral",
};

/**
 * Bandeau. L'ordre des tuiles porte la philosophie du produit : la valeur
 * d'abord, les exceptions en dernier.
 *
 * `divide-y` autant que `divide-x` : à six tuiles la bande se replie sur deux
 * ou trois rangées sous `lg`, et sans filet horizontal les deux étages de KPI
 * se touchaient. C'est la grille de la bande du Morning, à l'identique.
 */
export function OpportunitySummary({ metrics }: { metrics: TeamOpportunityMetrics }) {
  return (
    <Card className="grid grid-cols-2 divide-x divide-y divide-line md:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
      <Stat label="Opportunités actives" value={`${metrics.active}`} />
      <Stat label="GMV actif" value={formatEurShort(metrics.activeGmv)} />
      <Stat
        label="GMV débloquable"
        value={formatEurShort(metrics.unlockableGmv)}
        tone="positive"
        hint="action concrète possible"
      />
      <Stat
        label="GMV dormant"
        value={formatEurShort(metrics.dormantGmv)}
        hint="candidats à réactiver"
      />
      <Stat
        label="GMV en stand-by"
        value={formatEurShort(metrics.standbyGmv)}
        hint="protégé, sans alerte"
      />
      <Stat
        label="Exceptions nouvelles"
        value={`${metrics.newExceptions}`}
        tone={metrics.newExceptions > 0 ? "warning" : "positive"}
        hint={`${metrics.legacyBacklog} en dette héritée`}
      />
    </Card>
  );
}

/**
 * Bloc valeur — la raison d'être de C2, placé avant les exceptions.
 *
 * Filtré par l'état de lecture, comme les pistes : une opportunité lue et
 * inchangée disparaît, et revient dès qu'une information de décision bouge —
 * étape, GMV, mois de signature annoncé, jalon, stand-by.
 */
export function ValueBlock({
  view,
  owner,
}: {
  view: OpportunityMonitoringView;
  owner: string | null;
}) {
  const { items } = view;
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Valeur"
        title="À débloquer maintenant"
        aside={
          <div className="flex flex-wrap items-center gap-3">
            <span>
              {view.visibleCount} opportunité(s) à traiter
              {view.changedCount > 0 ? ` · ${view.changedCount} modifiée(s) depuis la lecture` : ""}
              {view.readCount > 0 ? ` · ${view.readCount} déjà lue(s)` : ""}
            </span>
            <ToutLireButton scope="opportunite" owner={owner} count={view.activeCount - view.readCount} />
          </div>
        }
      />
      {items.length === 0 ? (
        view.activeCount > 0 || view.readCount > 0 ? (
          <AllHandled
            readCount={view.readCount}
            lastReadAt={view.lastReadAt}
            what="opportunités"
          />
        ) : (
          <EmptyState>Aucun blocage actionnable identifié aujourd&apos;hui.</EmptyState>
        )
      ) : (
        <ul className="divide-y divide-line">
          {items.map(({ opportunity: o, action, verdict }) => (
            <li key={o.opportunityId} className="px-4 md:px-6 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-[15px] font-medium">{o.client ?? o.opportunityId}</p>
                <p className="tabular text-[15px] font-semibold">{formatEurShort(o.gmv)}</p>
              </div>
              <p className="mt-0.5 text-xs text-ink-soft">
                {o.owner} · {o.stage}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge tone={TONE[o.milestoneStatus]}>{MILESTONE_LABEL[o.milestoneStatus]}</Badge>
                <Badge>{action}</Badge>
                {o.isLegacy ? (
                  <Badge>
                    <span title="Retard déjà présent au démarrage du Monitoring">retard initial</span>
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1.5 text-xs text-ink-soft">{o.milestoneReason}</p>
              <ChangeLine verdict={verdict} />
              {o.nextExpectedEvent ? (
                <p className="mt-0.5 text-xs text-ink-faint">
                  Prochain jalon attendu : {NEXT_EVENT_LABEL[o.nextExpectedEvent]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Tableau par commercial.
 *
 * PAS de `Card` : ce tableau n'est rendu qu'à l'intérieur du dépliable
 * « Synthèse par commercial », qui porte déjà le cadre, le fond et les coins
 * arrondis. Une carte imbriquée y dessinait un second filet exactement sur
 * celui du parent et laissait 24 px de blanc sous la ligne de séparation.
 */
export function OpportunityOwnerTable({ owners }: { owners: OwnerOpportunityMetrics[] }) {
  const active = owners.filter((o) => o.active > 0);
  return (
    <section>
      <SectionTitle title="Par commercial" aside={`${active.length} commerciaux`} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Commercial</th>
              <th className="px-3 py-2 text-right font-medium">Opps</th>
              <th className="px-3 py-2 text-right font-medium">GMV</th>
              <th className="px-3 py-2 text-right font-medium">Estim. sans relance</th>
              <th className="px-3 py-2 text-right font-medium">Devis sans relance</th>
              <th className="px-3 py-2 text-right font-medium">Client attend</th>
              <th className="px-3 py-2 text-right font-medium">Sans mouvement</th>
              <th className="px-3 py-2 text-right font-medium">GMV concerné</th>
              <th className="px-4 md:px-6 py-2 font-medium">État</th>
            </tr>
          </thead>
          <tbody>
            {active
              .sort((a, b) => b.newExceptions - a.newExceptions || b.gmv - a.gmv)
              .map((o) => (
                <tr key={o.owner} className="border-b border-line last:border-0">
                  <td className="px-4 md:px-6 py-2.5 font-medium">{o.owner}</td>
                  <td className="tabular px-3 py-2.5 text-right">{o.active}</td>
                  <td className="tabular px-3 py-2.5 text-right">{formatEurShort(o.gmv)}</td>
                  <td className="tabular px-3 py-2.5 text-right">
                    {o.estimationWithoutRelance || "—"}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">{o.devisWithoutRelance || "—"}</td>
                  <td
                    className={`tabular px-3 py-2.5 text-right ${o.clientWaiting > 0 ? "font-semibold text-danger" : "text-ink-faint"}`}
                  >
                    {o.clientWaiting || "—"}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-faint">
                    {o.dormantCandidates || "—"}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">{formatEurShort(o.anomalyGmv)}</td>
                  <td className="px-4 md:px-6 py-2.5">
                    <Badge
                      tone={
                        o.state === "action requise"
                          ? "danger"
                          : o.state === "à surveiller"
                            ? "warning"
                            : "positive"
                      }
                    >
                      {o.state}
                    </Badge>
                    <p className="mt-1 text-xs text-ink-faint">{o.stateReason}</p>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 md:px-6 py-3 text-xs leading-relaxed text-ink-faint">
        « Client attend » n&apos;est renseigné que lorsqu&apos;un signal Gmail fiable le démontre :
        son absence ne prouve rien, la couverture étant partielle. « Commercial attend le client »
        n&apos;est pas mesurable aujourd&apos;hui et n&apos;est donc pas affiché.
      </p>
    </section>
  );
}

/** Exceptions de suivi — secondaires, affichées après la valeur. */
export function ExceptionBlock({
  items,
  reactivable,
}: {
  items: ExceptionEntry[];
  reactivable: { opportunityId: string; client: string | null; owner: string; stage: string | null; gmv: number | null }[];
}) {
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Secondaire"
        title="Exceptions de suivi"
        aside={`${items.length} affichées`}
      />
      {items.length === 0 ? (
        <EmptyState>Aucune exception de suivi à relire.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map(({ opportunity: o, verdict }) => (
            <li key={o.opportunityId} className="px-4 md:px-6 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{o.client ?? o.opportunityId}</p>
                  <p className="text-xs text-ink-faint">
                    {o.owner} · {MILESTONE_LABEL[o.milestoneStatus]}
                    {o.isLegacy ? " · retard initial" : ""}
                  </p>
                </div>
                <p className="tabular text-sm">{formatEurShort(o.gmv)}</p>
              </div>
              <ChangeLine verdict={verdict} />
            </li>
          ))}
        </ul>
      )}
      {reactivable.length > 0 ? (
        <div className="border-t border-line px-4 md:px-6 py-4">
          <p className="text-xs font-medium">Gros dossiers dormants, potentiellement réactivables</p>
          <ul className="mt-2 space-y-1">
            {reactivable.map((o) => (
              <li key={o.opportunityId} className="flex justify-between gap-4 text-xs">
                <span className="truncate text-ink-soft">
                  {o.client} — {o.owner} — {o.stage}
                </span>
                <span className="tabular font-medium">{formatEurShort(o.gmv)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Un dossier ancien n&apos;est pas seulement un défaut de suivi : c&apos;est aussi du GMV
            possiblement récupérable.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

import { SalesforceRecordLink } from "@/components/salesforce-link";
import { OPERATIONAL_LABEL, type LeadOperationalStatus } from "@/lib/lead-rules";
import type { OwnerLeadMetrics, TeamLeadMetrics } from "@/lib/lead-metrics";
import type { LeadMonitoringView } from "@/lib/monitoring-view";
import { monitoringSummary } from "@/lib/monitoring-wording";
import { SortableTable } from "@/components/sortable-table";
import { ChangeLine, ReadMark, ToutLireButton, TraiteButton } from "./monitoring-read";
import { Badge, Card, EmptyState, SectionTitle, Stat } from "./ui";

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} %`);
const hours = (v: number | null) =>
  v == null ? "—" : v < 48 ? `${Math.round(v)} h` : `${Math.round(v / 24)} j`;

const STATUS_TONE: Record<LeadOperationalStatus, "neutral" | "positive" | "warning" | "danger"> = {
  a_venir: "positive",
  normal: "neutral",
  a_traiter: "warning",
  en_retard: "warning",
  critique: "danger",
  sans_rendez_vous: "warning",
  convertie: "positive",
  abandonnee: "neutral",
};

/**
 * Bandeau équipe.
 *
 * Sept compteurs de poids égal repoussaient le bloc « À traiter maintenant » à
 * plus de 450 px du haut : le manager lisait des volumes avant de voir les
 * anomalies. Les trois compteurs d'ANOMALIE restent donc en tête ; les quatre
 * mesures de volume et de rythme passent en ligne secondaire. Aucune métrique
 * n'est retirée, seule leur hiérarchie change.
 */
export function LeadSummary({ metrics }: { metrics: TeamLeadMetrics }) {
  return (
    <Card>
      <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat
          label="Nouvelles exceptions"
          value={`${metrics.newExceptions}`}
          tone={metrics.newExceptions > 0 ? "warning" : "positive"}
          hint="depuis l'activation"
        />
        <Stat
          label="First Calls manqués"
          value={`${metrics.firstCallsMissed}`}
          tone={metrics.firstCallsMissed > 0 ? "danger" : "positive"}
          hint="passés, non consignés"
        />
        <Stat
          label="Dette héritée"
          value={`${metrics.legacyBacklog}`}
          hint="constatée au démarrage"
        />
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-1 border-t border-line px-4 md:px-6 py-2 text-xs text-ink-faint">
        <span>
          Pistes reçues <span className="tabular text-ink-soft">{metrics.received}</span>{" "}
          {metrics.periodLabel}
        </span>
        <span>
          Ouvertes <span className="tabular text-ink-soft">{metrics.open}</span>
        </span>
        <span>
          Conversion <span className="tabular text-ink-soft">{pct(metrics.conversionRate)}</span>
        </span>
        <span>
          Délai First Call{" "}
          <span className="tabular text-ink-soft">
            {hours(metrics.medianCreationToFirstCallHours)}
          </span>
        </span>
      </div>
    </Card>
  );
}

/**
 * Tableau par commercial. Chaque verdict est justifié en clair.
 *
 * PAS de `Card` : ce tableau n'est rendu qu'à l'intérieur du dépliable
 * « Synthèse par commercial », qui porte déjà le cadre, le fond et les coins
 * arrondis. Une carte imbriquée y dessinait un second filet exactement sur
 * celui du parent et laissait 24 px de blanc sous la ligne de séparation.
 */
export function OwnerTable({ owners }: { owners: OwnerLeadMetrics[] }) {
  const active = owners.filter((o) => o.received > 0 || o.newExceptions > 0 || o.legacyBacklog > 0);

  return (
    <section>
      <SectionTitle
        title="Par commercial"
        aside={`${active.length} commerciaux avec activité`}
      />
      {active.length === 0 ? (
        <EmptyState>Aucune piste sur la période.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          {/* Lot de simplification (D) : chaque colonne se trie d'un clic. */}
          <SortableTable
            className="w-full min-w-[1000px] text-sm md:min-w-[880px]"
            columns={[
              { label: "Commercial", type: "text", className: "px-4 md:px-6" },
              { label: "Reçues", type: "number", align: "right" },
              { label: "Nouvelle", type: "number", align: "right" },
              { label: "À confirmer", type: "number", align: "right" },
              { label: "Converties", type: "number", align: "right" },
              { label: "Conv.", type: "number", align: "right" },
              { label: "FC manqués", type: "number", align: "right" },
              { label: "En retard", type: "number", align: "right" },
              { label: "Critiques", type: "number", align: "right" },
              { label: "Dette", type: "number", align: "right" },
              { label: "État", type: "text", className: "px-4 md:px-6" },
            ]}
            rows={active
              .sort((a, b) => b.newExceptions - a.newExceptions || b.received - a.received)
              .map((o) => ({
                key: o.owner,
                sort: [o.owner, o.received, o.nouvelles, o.aConfirmer, o.converted, o.conversionRate, o.firstCallsMissed, o.dueOverdueLate, o.dueOverdueCritical, o.legacyBacklog, o.state],
                cells: [
                  <td key="owner" className="px-4 md:px-6 py-2.5 font-medium">{o.owner}</td>,
                  <td key="received" className="tabular px-3 py-2.5 text-right">{o.received}</td>,
                  <td key="nouvelles" className="tabular px-3 py-2.5 text-right">{o.nouvelles}</td>,
                  <td key="aconfirmer" className="tabular px-3 py-2.5 text-right">{o.aConfirmer}</td>,
                  <td key="converted" className="tabular px-3 py-2.5 text-right">{o.converted}</td>,
                  <td key="conv" className="tabular px-3 py-2.5 text-right">{pct(o.conversionRate)}</td>,
                  <td
                    key="fc"
                    className={`tabular px-3 py-2.5 text-right ${o.firstCallsMissed > 0 ? "font-semibold text-danger" : "text-ink-faint"}`}
                  >
                    {o.firstCallsMissed || "—"}
                  </td>,
                  <td key="late" className="tabular px-3 py-2.5 text-right">{o.dueOverdueLate || "—"}</td>,
                  <td
                    key="critical"
                    className={`tabular px-3 py-2.5 text-right ${o.dueOverdueCritical > 0 ? "text-warning" : "text-ink-faint"}`}
                  >
                    {o.dueOverdueCritical || "—"}
                  </td>,
                  <td key="backlog" className="tabular px-3 py-2.5 text-right text-ink-faint">
                    {o.legacyBacklog || "—"}
                  </td>,
                  <td key="state" className="px-4 md:px-6 py-2.5">
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
                  </td>,
                ],
              }))}
          />
        </div>
      )}
      <p className="border-t border-line px-4 md:px-6 py-3 text-xs leading-relaxed text-ink-faint">
        Le taux de conversion est brut : il ne tient compte ni du canal, ni de la zone, ni de la
        prestation. Un écart pose une question, il ne conclut rien. Les verdicts sont produits par
        trois règles visibles, ramenées au volume reçu — il n&apos;y a pas de note.
      </p>
    </section>
  );
}

/**
 * Bloc « À traiter maintenant ». Le stock ancien y est volontairement contingenté.
 *
 * Une liste d'ACTIONS : seule une piste traitée en sort. Une piste lue reste
 * affichée, marquée lue, tant que son action est ouverte ; si une information
 * de décision bouge, la valeur modifiée est mise en évidence.
 */
export function LeadTodo({ view, owner }: { view: LeadMonitoringView; owner: string | null }) {
  const { items } = view;
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Priorité"
        title="À traiter maintenant"
        aside={
          <div className="flex flex-wrap items-center gap-3">
            <span>{monitoringSummary("piste", view)}</span>
            <ToutLireButton scope="piste" owner={owner} count={view.activeCount - view.readCount - view.treatedCount} />
          </div>
        }
      />
      {items.length === 0 ? (
        <EmptyState>
          {view.treatedCount > 0
            ? "Tout est traité : aucune action ouverte sur les pistes."
            : "Aucune piste en anomalie. Les échéances sont tenues."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map(({ lead, reason, verdict }) => (
            <li key={lead.leadId} className="px-4 md:px-6 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-[15px] font-medium"><SalesforceRecordLink recordId={lead.leadId}>{lead.name ?? lead.leadId}</SalesforceRecordLink></p>
                <div className="flex shrink-0 items-center gap-3">
                  <p className="text-xs text-ink-soft">{lead.owner}</p>
                  <ReadMark scope="piste" itemId={lead.leadId} verdict={verdict} />
                  <TraiteButton scope="piste" itemId={lead.leadId} />
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[lead.operationalStatus]}>
                  {OPERATIONAL_LABEL[lead.operationalStatus]}
                </Badge>
                <Badge>{reason}</Badge>
                {lead.isLegacy ? (
                  <Badge>
                    <span title="Retard déjà présent au démarrage du Monitoring">retard initial</span>
                  </Badge>
                ) : null}
                <span className="text-xs text-ink-faint">
                  {lead.latenessHours < 48
                    ? `${lead.latenessHours} h de retard`
                    : `${Math.round(lead.latenessHours / 24)} j de retard`}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-ink-soft">{lead.flagReason}</p>
              <ChangeLine verdict={verdict} />
              <p className="mt-0.5 text-xs text-ink-faint">
                {lead.firstCallAt
                  ? `First Call ${new Date(lead.firstCallAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`
                  : "aucun First Call"}
                {lead.recallDate
                  ? ` · échéance ${new Date(lead.recallDate).toLocaleDateString("fr-FR")}`
                  : ""}
                {` · Salesforce : ${lead.status}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

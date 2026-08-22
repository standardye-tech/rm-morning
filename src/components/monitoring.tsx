import { OPERATIONAL_LABEL, type LeadOperationalStatus } from "@/lib/lead-rules";
import type { OwnerLeadMetrics, TeamLeadMetrics } from "@/lib/lead-metrics";
import type { LeadMonitoringView } from "@/lib/monitoring-view";
import { AllHandled, ChangeLine, ToutLireButton } from "./monitoring-read";
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
          <table className="w-full min-w-[1000px] text-sm md:min-w-[880px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 md:px-6 py-2 font-medium">Commercial</th>
                <th className="px-3 py-2 text-right font-medium">Reçues</th>
                <th className="px-3 py-2 text-right font-medium">Nouvelle</th>
                <th className="px-3 py-2 text-right font-medium">À confirmer</th>
                <th className="px-3 py-2 text-right font-medium">Converties</th>
                <th className="px-3 py-2 text-right font-medium">Conv.</th>
                <th className="px-3 py-2 text-right font-medium">FC manqués</th>
                <th className="px-3 py-2 text-right font-medium">En retard</th>
                <th className="px-3 py-2 text-right font-medium">Critiques</th>
                <th className="px-3 py-2 text-right font-medium">Dette</th>
                <th className="px-4 md:px-6 py-2 font-medium">État</th>
              </tr>
            </thead>
            <tbody>
              {active
                .sort((a, b) => b.newExceptions - a.newExceptions || b.received - a.received)
                .map((o) => (
                  <tr key={o.owner} className="border-b border-line last:border-0">
                    <td className="px-4 md:px-6 py-2.5 font-medium">{o.owner}</td>
                    <td className="tabular px-3 py-2.5 text-right">{o.received}</td>
                    <td className="tabular px-3 py-2.5 text-right">{o.nouvelles}</td>
                    <td className="tabular px-3 py-2.5 text-right">{o.aConfirmer}</td>
                    <td className="tabular px-3 py-2.5 text-right">{o.converted}</td>
                    <td className="tabular px-3 py-2.5 text-right">{pct(o.conversionRate)}</td>
                    <td
                      className={`tabular px-3 py-2.5 text-right ${o.firstCallsMissed > 0 ? "font-semibold text-danger" : "text-ink-faint"}`}
                    >
                      {o.firstCallsMissed || "—"}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{o.dueOverdueLate || "—"}</td>
                    <td
                      className={`tabular px-3 py-2.5 text-right ${o.dueOverdueCritical > 0 ? "text-warning" : "text-ink-faint"}`}
                    >
                      {o.dueOverdueCritical || "—"}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-ink-faint">
                      {o.legacyBacklog || "—"}
                    </td>
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
 * Depuis le Lot A, la liste est FILTRÉE PAR L'ÉTAT DE LECTURE : une piste lue et
 * inchangée n'y figure plus, et revient dès qu'une de ses informations de
 * décision bouge — avec la valeur modifiée mise en évidence. C'est ce qui permet
 * à la liste d'atteindre réellement zéro.
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
            <span>
              {view.visibleCount} piste(s) à traiter
              {view.changedCount > 0 ? ` · ${view.changedCount} modifiée(s) depuis la lecture` : ""}
              {view.readCount > 0 ? ` · ${view.readCount} déjà lue(s)` : ""}
            </span>
            <ToutLireButton scope="piste" owner={owner} count={view.activeCount - view.readCount} />
          </div>
        }
      />
      {items.length === 0 ? (
        view.activeCount > 0 || view.readCount > 0 ? (
          <AllHandled readCount={view.readCount} lastReadAt={view.lastReadAt} what="pistes" />
        ) : (
          <EmptyState>Aucune piste en anomalie. Les échéances sont tenues.</EmptyState>
        )
      ) : (
        <ul className="divide-y divide-line">
          {items.map(({ lead, reason, verdict }) => (
            <li key={lead.leadId} className="px-4 md:px-6 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-[15px] font-medium">{lead.name ?? lead.leadId}</p>
                <p className="text-xs text-ink-soft">{lead.owner}</p>
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

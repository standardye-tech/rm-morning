import { Card, EmptyState, SectionTitle } from "@/components/ui";
import { formatEurShort, formatFrenchDate } from "@/lib/normalize";
import { listImports, listSnapshotDays } from "@/lib/repository";

export const dynamic = "force-dynamic";

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
});

export default function HistoriquePage() {
  const days = listSnapshotDays();
  const imports = listImports();

  return (
    <div className="py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Historique</h1>
      <p className="mt-1 max-w-3xl text-sm text-ink-soft">
        Un snapshot par jour d&apos;import. Les jours passés ne sont jamais écrasés — c&apos;est
        cette base qui permettra plus tard de calculer les taux de transformation réels.
      </p>
      {/*
        Précision ajoutée à l'audit V1 : cette page compte des OPPORTUNITÉS, pas des
        euros signés. Sans cette phrase, la colonne « Signées » se lit comme le
        réalisé du mois, alors que le GMV officiel se mesure sur les lignes Travaux
        et vaut tout autre chose.
      */}
      <p className="mt-1 max-w-3xl text-xs text-ink-faint">
        Cette page compte des opportunités et leur GMV de pipe. Elle ne mesure pas le chiffre signé
        : le GMV officiel se lit sur les lignes Travaux, et il apparaît sur Forecast et Expected
        GMV.
      </p>

      <Card className="mt-6">
        <SectionTitle title="Snapshots quotidiens" aside={`${days.length} jour(s)`} />
        {days.length === 0 ? (
          <EmptyState>Aucun snapshot enregistré.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm md:min-w-0">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                  <th className="px-4 md:px-6 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 text-right font-medium">Opportunités</th>
                  <th className="px-3 py-2.5 text-right font-medium">Actives</th>
                  <th className="px-3 py-2.5 text-right font-medium">GMV active</th>
                  <th className="px-3 py-2.5 text-right font-medium">Opportunités signées</th>
                  <th className="px-4 md:px-6 py-2.5 text-right font-medium">Stand-by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {days.map((day) => (
                  <tr key={day.snapshotDate}>
                    <td className="px-4 md:px-6 py-2.5 font-medium">
                      {formatFrenchDate(day.snapshotDate)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{day.opportunities}</td>
                    <td className="tabular px-3 py-2.5 text-right">{day.activeOpportunities}</td>
                    <td className="tabular px-3 py-2.5 text-right font-medium">
                      {formatEurShort(day.activeGmv)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-ink-soft">
                      {day.signedOpportunities}
                    </td>
                    <td className="tabular px-4 md:px-6 py-2.5 text-right text-ink-soft">
                      {day.standbyOpportunities}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <SectionTitle title="Imports" aside={`${imports.length}`} />
        {imports.length === 0 ? (
          <EmptyState>Aucun import.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {imports.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 md:px-6 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{run.fileName ?? run.sourceLabel}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {DATE_TIME.format(new Date(run.importedAt))} · source {run.sourceKind} ·
                    snapshot {formatFrenchDate(run.snapshotDate)}
                  </p>
                </div>
                <p className="text-xs text-ink-soft">
                  {run.totalRows} lignes lues · {run.teamRows} retenues · {run.activeRows} actives
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

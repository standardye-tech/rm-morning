import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui";
import type { ConstruireM1 } from "@/lib/build-m1";
import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { formatFrenchDate } from "@/lib/normalize";
import { LABEL, kEur } from "@/lib/vocabulary";

/**
 * « Construire M+1 » — vue M+1 d'Expected GMV.
 *
 * Six chiffres, chacun lu du moteur qui le produit (voir `build-m1.ts`), puis les
 * affaires déjà identifiées. Aucun KPI concurrent : la couverture et le manque se
 * mesurent sur la SEULE prévision RM Morning M+1, et seulement si un objectif a
 * été saisi dans Données.
 *
 * La prévision M+1 n'est PAS la somme des affaires listées dessous : elle intègre
 * une composante statistique d'affaires qui n'existent pas encore. Le bloc le dit,
 * et le total des affaires identifiées porte la mention « n'est pas la prévision ».
 */

const LIMIT = 15;

function Row({
  label,
  value,
  hint,
  strong,
  muted,
}: {
  label: string;
  value: string;
  hint?: string | null;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5 md:px-6">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="text-right">
        <span className={`tabular ${strong ? "text-base font-semibold" : "text-sm font-medium"} ${muted ? "text-ink-faint" : ""}`}>{value}</span>
        {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      </dd>
    </div>
  );
}

const pct = (n: number) => `${Math.round(n * 100)} %`;

export function ConstruireM1Block({ data }: { data: ConstruireM1 }) {
  const { objective, coverage, forecast, adjusted } = data;
  const noObjective = objective == null;
  const uncomputable = noObjective
    ? "Objectif non renseigné"
    : forecast == null
      ? "Prévision M+1 indisponible"
      : null;

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle eyebrow="Expected GMV · vue M+1" title={`Construire ${data.monthLabel}`} aside={forecast ? `${LABEL.confidence} ${forecast.confidence}` : undefined} />
        <dl className="divide-y divide-line">
          <Row
            label="Objectif M+1"
            value={objective ? kEur(objective.amount) : "Objectif non renseigné"}
            muted={noObjective}
            hint={
              objective
                ? `saisi le ${formatFrenchDate(objective.updatedAt.slice(0, 10))}`
                : "À saisir dans Données · Objectif mensuel de la Région"
            }
          />
          <Row
            label="Déclaratif commerciaux M+1"
            value={kEur(data.declared.gmv)}
            hint={`Projection Kanban · ${data.declared.count} affaire(s) prévue(s)`}
          />
          <Row
            label={`${LABEL.adjustedPerspective} M+1`}
            value={adjusted.ok ? kEur(adjusted.value.gmv) : "—"}
            muted={!adjusted.ok}
            hint={
              adjusted.ok
                ? adjusted.value.source === "snapshot" && adjusted.value.snapshotDate
                  ? `Analyse régionale · snapshot du ${formatFrenchDate(adjusted.value.snapshotDate).slice(0, 5)} · ${adjusted.value.count} affaires`
                  : `Analyse régionale · sélection manuelle · ${adjusted.value.count} affaires`
                : `Analyse régionale · ${adjusted.reason}`
            }
          />
          <Row
            label="Prévision RM Morning M+1"
            value={forecast ? kEur(forecast.projection) : "—"}
            strong
            muted={forecast == null}
            hint={
              forecast
                ? `${LABEL.indicativeRange} ${kEur(forecast.rangeLo)} – ${kEur(forecast.rangeHi)}`
                : (data.forecastUnavailableReason ?? "indisponible")
            }
          />
          <Row
            label="Couverture de l'objectif"
            value={coverage ? pct(coverage.ratio) : "—"}
            muted={!coverage}
            hint={coverage ? "prévision RM Morning ÷ objectif" : uncomputable}
          />
          <Row
            label="Manque à construire"
            value={coverage ? (coverage.missing > 0 ? kEur(coverage.missing) : "Objectif couvert") : "—"}
            muted={!coverage}
            hint={coverage ? (coverage.surplus > 0 ? `${kEur(coverage.surplus)} au-dessus de l'objectif` : "objectif − prévision RM Morning") : uncomputable}
          />
        </dl>
        <p className="border-t border-line px-4 py-3 text-xs text-ink-faint md:px-6">
          La prévision M+1 <span className="font-medium text-ink-soft">n&apos;est pas la somme des affaires listées ci-dessous</span> :
          elle part du niveau historique de l&apos;équipe, ajusté selon la force du pipe, et intègre du GMV d&apos;affaires qui
          n&apos;existent pas encore — {data.futureShare} du GMV d&apos;un mois M+1, historiquement. Le moteur n&apos;expose pas de
          ventilation « pipe identifié / GMV futur » du chiffre du jour : aucune n&apos;est affichée.
        </p>
      </Card>

      <Card>
        <SectionTitle
          eyebrow="Pipe identifié"
          title="Affaires qui construisent M+1"
          aside={`${data.identified.count} affaire(s) · ${kEur(data.identified.gmv)} de GMV`}
        />
        {data.deals.length === 0 ? (
          <EmptyState>Aucune affaire n&apos;est encore identifiée pour {data.monthLabel}.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                  <th className="px-4 py-2.5 font-medium md:px-6">Commercial</th>
                  <th className="px-3 py-2.5 font-medium">Affaire</th>
                  <th className="px-3 py-2.5 text-right font-medium">GMV</th>
                  <th className="px-3 py-2.5 font-medium">Stade</th>
                  <th className="px-3 py-2.5 font-medium">Kanban M+1</th>
                  <th className="px-3 py-2.5 text-right font-medium">Probabilité M+1</th>
                  <th className="px-4 py-2.5 font-medium md:px-6">Challenge</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.deals.slice(0, LIMIT).map((d) => (
                  <tr key={d.opportunityId} className="align-top">
                    <td className="px-4 py-2.5 text-xs text-ink-soft md:px-6">{d.ownerFirstName}</td>
                    <td className="px-3 py-2.5 font-medium">
                      <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{kEur(d.gmv)}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-soft">{d.stage ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {d.declaredOnM1 ? <Badge tone="positive">Prévue</Badge> : <Badge tone="neutral">Suggérée RM Morning</Badge>}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-xs">
                      {d.probability == null ? "—" : `${(d.probability * 100).toFixed(d.probability < 0.1 ? 1 : 0).replace(".", ",")} %`}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-soft md:px-6">{d.challenge ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-faint md:px-6">
          {data.deals.length > LIMIT ? `${LIMIT} plus grosses affaires affichées sur ${data.deals.length}. ` : ""}
          Ce total ({kEur(data.identified.gmv)}) est du GMV en pipe, pas la prévision : la prévision RM Morning M+1 est un
          chiffre distinct, calculé sur l&apos;historique et sur la force du pipe.
        </p>
      </Card>

      {data.issues.length > 0 ? (
        <ul className="space-y-1 px-1 text-xs text-ink-faint">
          {data.issues.map((i, k) => (
            <li key={k}>{i}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

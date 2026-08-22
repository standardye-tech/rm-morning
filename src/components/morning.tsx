import { formatEur, formatEurShort, formatFrenchDate } from "@/lib/normalize";
import type { WeekForecast } from "@/lib/forecast";
import { GMAIL_SIGNAL_LABEL } from "@/lib/scoring";
import type { Alert, MorningAction, ScoredDeal } from "@/lib/scoring";
import { Badge, Card, EmptyState, SectionTitle } from "./ui";

/** Bloc 1 — les opportunités les plus proches de signer d'après Salesforce. */
export function TopDeals({ deals }: { deals: ScoredDeal[] }) {
  return (
    <Card>
      <SectionTitle
        eyebrow="Bloc 1"
        title="Top 3 à signer"
        aside="Les plus proches de signer d'après Salesforce"
      />
      {deals.length === 0 ? (
        <EmptyState>Aucune opportunité active à afficher.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {deals.map((deal, index) => (
            <li key={deal.opportunity.opportunityId} className="flex gap-4 px-4 md:px-6 py-4">
              <span className="tabular mt-0.5 text-sm font-semibold text-ink-faint">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="truncate text-[15px] font-medium">{deal.client}</p>
                  <p className="tabular text-[15px] font-semibold">{formatEur(deal.gmv)}</p>
                </div>
                <p className="mt-0.5 text-xs text-ink-soft">{deal.owner}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {deal.kanbanRaw ? (
                    <Badge>{deal.kanbanRaw}</Badge>
                  ) : (
                    <Badge tone="warning">Sans projection Kanban</Badge>
                  )}
                  <Badge
                    tone={
                      deal.confidence === "élevée"
                        ? "positive"
                        : deal.confidence === "moyenne"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    Confiance {deal.confidence}
                  </Badge>
                  {deal.mailSignal && deal.mailAdjustment !== 0 ? (
                    <Badge
                      tone={
                        deal.mailAdjustment > 0
                          ? "positive"
                          : deal.mailSignal.signalType === "negatif"
                            ? "danger"
                            : "warning"
                      }
                    >
                      Gmail · {GMAIL_SIGNAL_LABEL[deal.mailSignal.signalType] ?? deal.mailSignal.signalType}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-ink-soft">{deal.reason}</p>
                {deal.mailSignal?.summary && deal.mailAdjustment !== 0 ? (
                  <p className="mt-1 text-xs text-ink-faint">{deal.mailSignal.summary}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 md:px-6 py-3 text-xs leading-relaxed text-ink-faint">
        Classement établi sur les signaux Salesforce (étape, Projection Kanban, fraîcheur
        d&apos;activité), ajusté par le dernier signal Gmail lorsqu&apos;il est rattaché de
        façon fiable. La confiance déclarée au forecast n&apos;entre pas dans ce tri. Ce
        n&apos;est pas une prédiction.
      </p>
    </Card>
  );
}

/** Bloc 2 — forecast de la semaine, adossé au snapshot hebdomadaire du Sheet. */
export function WeekForecastBlock({ forecast }: { forecast: WeekForecast }) {
  const variation = forecast.variationGmv ?? 0;
  const tone = variation > 0 ? "text-positive" : variation < 0 ? "text-danger" : "text-ink-soft";

  return (
    <Card>
      <SectionTitle
        eyebrow="Bloc 2"
        title="Forecast de la semaine"
        aside={
          forecast.mode === "sheet"
            ? `snapshot du ${formatFrenchDate(forecast.referenceDate)}`
            : "vue provisoire"
        }
      />

      {forecast.mode === "salesforce-only" ? (
        <div className="px-4 md:px-6 py-4">
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
            Projection Kanban — {forecast.monthLabel}
          </p>
          <p className="tabular mt-1 text-2xl font-semibold tracking-tight">
            {formatEurShort(forecast.kanbanGmv)}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Aucun snapshot hebdomadaire disponible pour {forecast.monthLabel}. Lancez
            l&apos;import du forecast depuis la page Données.
          </p>
        </div>
      ) : (
        <>
          <dl className="divide-y divide-line">
            <div className="flex items-baseline justify-between px-4 md:px-6 py-2.5">
              <dt className="text-xs text-ink-soft">
                Projeté au {formatFrenchDate(forecast.referenceDate)}
              </dt>
              <dd className="tabular text-sm font-medium">
                {formatEurShort(forecast.snapshotGmv)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between px-4 md:px-6 py-2.5">
              <dt className="text-xs text-ink-soft">Projection actuelle</dt>
              <dd className="tabular text-sm font-semibold">
                {formatEurShort(forecast.currentGmv)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between px-4 md:px-6 py-2.5">
              <dt className="text-xs text-ink-soft">Écart</dt>
              <dd className={`tabular text-sm font-semibold ${tone}`}>
                {variation > 0 ? "+" : ""}
                {formatEurShort(variation)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between px-4 md:px-6 py-2.5">
              <dt className="text-xs text-ink-soft">Renforcé</dt>
              <dd className="tabular text-sm">
                {forecast.strengthened.length + forecast.won.length || "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between px-4 md:px-6 py-2.5">
              <dt className="text-xs text-ink-soft">Fragilisé / repoussé</dt>
              <dd className="tabular text-sm">
                {forecast.weakened.length + forecast.postponed.length || "—"}
              </dd>
            </div>
          </dl>

          {forecast.toChallenge.length > 0 ? (
            <div className="border-t border-line px-4 md:px-6 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
                À challenger
              </p>
              <ul className="mt-2 space-y-2">
                {forecast.toChallenge.map((item) => (
                  <li key={`${item.opportunityId}-${item.detail}`}>
                    <p className="truncate text-xs font-medium">{item.client}</p>
                    <p className="text-xs text-ink-soft">
                      {item.owner} · {item.detail}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {forecast.gaps.length > 0 ? (
            <p className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-warning">
              {forecast.gaps.length} affaire{forecast.gaps.length > 1 ? "s" : ""} du forecast sans
              correspondance Salesforce — à investiguer, voir la page Données.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Bloc 3 — alertes. */
export function AlertsBlock({ alerts }: { alerts: Alert[] }) {
  return (
    <Card>
      <SectionTitle eyebrow="Bloc 3" title="Alertes" />
      {alerts.length === 0 ? (
        <EmptyState>Pas d&apos;alerte majeure ce matin.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {alerts.map((alert) => (
            <li key={alert.title} className="px-4 md:px-6 py-3.5">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    alert.level === "critique"
                      ? "bg-danger"
                      : alert.level === "vigilance"
                        ? "bg-warning"
                        : "bg-ink-faint"
                  }`}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug">{alert.title}</p>
                  <p className="mt-0.5 text-xs text-ink-soft">{alert.detail}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Bloc 4 — les actions du matin. Le bloc le plus important visuellement. */
/** Nombre de lignes visibles avant dépliage. Ce n'est plus un plafond. */
const VISIBLE_ACTIONS = 6;

/**
 * Le plan d'action du matin.
 *
 * L'interface n'impose plus « cinq actions » : elle affiche les premières et
 * déplie le reste. Le moteur actuel en produit encore au maximum cinq — c'est
 * une limite de `buildActions`, pas de cet écran, et elle tombera avec le
 * scoring Morning V2. Le titre ne promet donc plus un nombre.
 */
export function ActionsBlock({ actions }: { actions: MorningAction[] }) {
  const head = actions.slice(0, VISIBLE_ACTIONS);
  const rest = actions.slice(VISIBLE_ACTIONS);
  return (
    <Card className="ring-1 ring-ink/5">
      <SectionTitle
        eyebrow="Plan du jour"
        title="À faire aujourd'hui"
        aside={actions.length > 0 ? `${actions.length} action(s)` : undefined}
      />
      {actions.length === 0 ? (
        <EmptyState>Rien de prioritaire à lancer ce matin.</EmptyState>
      ) : (
        <>
          <ol className="divide-y divide-line">
            {head.map((action, index) => (
              <ActionRow key={action.text} action={action} index={index} />
            ))}
          </ol>
          {rest.length > 0 ? (
            <details className="group border-t border-line">
              <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-sm text-ink-soft hover:text-ink">
                <span className="underline decoration-dotted">
                  Voir toutes les actions ({actions.length})
                </span>
                <span className="ml-1 group-open:hidden" aria-hidden>
                  ▸
                </span>
                <span className="ml-1 hidden group-open:inline" aria-hidden>
                  ▾
                </span>
              </summary>
              <ol className="divide-y divide-line border-t border-line">
                {rest.map((action, index) => (
                  <ActionRow key={action.text} action={action} index={index + VISIBLE_ACTIONS} />
                ))}
              </ol>
            </details>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ActionRow({ action, index }: { action: MorningAction; index: number }) {
  return (
    <li className="flex gap-4 px-4 md:px-6 py-4">
      <span className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-canvas text-xs font-semibold text-ink-soft">
        {index + 1}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] leading-snug">{action.text}</p>
        <p className="mt-1 text-xs text-ink-faint">{action.context}</p>
      </div>
    </li>
  );
}

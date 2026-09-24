import { Badge, Card, EmptyState } from "@/components/ui";
import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { m1GapDeals, type ConstruireM1 } from "@/lib/build-m1";
import type { M1Trajectory, SeriesKey, Trend, TrendReading } from "@/lib/m1-trajectory";
import { formatFrenchDate } from "@/lib/normalize";
import { kEur } from "@/lib/vocabulary";

/**
 * « Octobre 2026 — où en est-on ? » — vue M+1 d'Expected GMV, lot de
 * simplification (F1 à F4, F12).
 *
 * UNE seule section, là où il y avait « Construire octobre » puis « Trajectoire
 * de construction » qui répétaient objectif, prévision, perspective ajustée et
 * manque. Chaque chiffre n'apparaît qu'une fois ; la trajectoire ne montre que
 * l'historique, l'écart est expliqué affaire par affaire, et les affaires
 * suggérées par RM Morning complètent la lecture.
 *
 * Tous les chiffres sont lus des moteurs existants (`build-m1.ts`,
 * `m1-trajectory.ts`) : aucun calcul ici.
 */

const DDMM = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const oneDecimal = (n: number) => n.toFixed(1).replace(".", ",");
const pct = (n: number) => `${Math.round(n * 100)} %`;
const pctFine = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0).replace(".", ",")} %`;

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthOf = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1];
const previousMonthOf = (month: string) => MONTHS[(Number(month.slice(5, 7)) + 10) % 12];
/** « d'octobre », « de septembre ». */
const ofMonth = (m: string) => (/^[aeiouyâéèêëîïôûùüh]/i.test(m) ? `d'${m}` : `de ${m}`);

/** Les séries, dites en français — « pour octobre », jamais « M+1 ». */
const SERIES_LABEL: Record<SeriesKey, (m: string) => string> = {
  rmMorning: (m) => `Ce que RM Morning prévoyait pour ${m}`,
  declared: (m) => `Ce que les commerciaux annonçaient pour ${m}`,
  identified: (m) => `GMV d'affaires déjà identifiées pour ${m}`,
  adjusted: (m) => `Ta perspective ajustée pour ${m}`,
};

const TREND: Record<Trend, { arrow: string; word: string }> = {
  up: { arrow: "↗", word: "monte" },
  flat: { arrow: "→", word: "stagne" },
  down: { arrow: "↘", word: "recule" },
};

function signedK(delta: number): string {
  const k = kEur(Math.abs(delta));
  return delta > 0 ? `+${k}` : delta < 0 ? `−${k}` : k;
}

function Reading({ reading }: { reading: TrendReading | null }) {
  if (!reading) return <span className="text-ink-faint">—</span>;
  const t = TREND[reading.trend];
  return (
    <span title={`du ${DDMM(reading.from)} au ${DDMM(reading.to)}`}>
      <span aria-hidden>{t.arrow}</span> {t.word}
      <span className="tabular ml-1 text-xs text-ink-faint">{signedK(reading.delta)}</span>
    </span>
  );
}

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
        <span className={`tabular ${strong ? "text-base font-semibold" : "text-sm font-medium"} ${muted ? "text-ink-faint" : ""}`}>
          {value}
        </span>
        {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      </dd>
    </div>
  );
}

function Subsection({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-1 pt-4 md:px-6">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {aside ? <span className="text-xs text-ink-faint">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** Lignes d'écart affichées d'emblée ; les suivantes restent à un clic. */
const GAP_VISIBLE = 8;

function GapRow({ d }: { d: ReturnType<typeof m1GapDeals>[number] }) {
  return (
    <tr className="align-top">
      <td className="px-4 py-2 text-xs text-ink-soft md:px-6">{d.ownerFirstName}</td>
      <td className="px-3 py-2 font-medium">
        <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
      </td>
      <td className="tabular px-3 py-2 text-right">{kEur(d.gmv)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">{d.kanbanRaw ?? "—"}</td>
      <td className="tabular px-3 py-2 text-right">{d.probability == null ? "—" : pctFine(d.probability)}</td>
      <td className="tabular px-3 py-2 text-right text-xs text-ink-soft">
        {d.perspectiveConfidence == null ? "—" : pct(d.perspectiveConfidence)}
      </td>
      <td className="px-4 py-2 text-xs text-ink-soft md:px-6">{d.reading ?? "—"}</td>
    </tr>
  );
}

export function M1OverviewBlock({ data, trajectory }: { data: ConstruireM1; trajectory: M1Trajectory }) {
  const m = monthOf(data.month);
  const during = previousMonthOf(data.month);
  const t = trajectory;
  const { objective, coverage, forecast, adjusted } = data;
  const uncomputable = objective == null ? "Objectif non renseigné" : forecast == null ? "Prévision indisponible" : null;
  const weeksLabel = `${oneDecimal(t.daysLeft / 7)} semaine(s)`;

  const gapDeals = m1GapDeals(data.deals);
  const gap = forecast ? data.declared.gmv - forecast.projection : null;
  const suggested = data.deals.filter((d) => !d.declaredOnM1);
  const title = `${m.charAt(0).toUpperCase()}${m.slice(1)} ${data.month.slice(0, 4)} — où en est-on ?`;

  return (
    <Card>
      <div className="px-4 pt-4 md:px-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">Expected GMV · mois prochain</p>
        <h2 className="mt-0.5 text-lg font-semibold tracking-tight">{title}</h2>
      </div>

      <dl className="mt-2 divide-y divide-line">
        <Row
          label={`Objectif ${m}`}
          value={objective ? kEur(objective.amount) : "Objectif non renseigné"}
          muted={!objective}
          hint={objective ? `saisi le ${formatFrenchDate(objective.updatedAt.slice(0, 10))}` : "À saisir dans Données · Objectif mensuel de la Région"}
        />
        <Row
          label={`Ce que les commerciaux annoncent pour ${m}`}
          value={kEur(data.declared.gmv)}
          hint={`Projection Kanban · ${data.declared.count} affaire(s)`}
        />
        <Row
          label={`Ta perspective ajustée pour ${m}`}
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
          label={`Ce que RM Morning prévoit pour ${m}`}
          value={forecast ? kEur(forecast.projection) : "—"}
          strong
          muted={!forecast}
          hint={forecast ? `fourchette indicative ${kEur(forecast.rangeLo)} – ${kEur(forecast.rangeHi)}` : (data.forecastUnavailableReason ?? "indisponible")}
        />
        <Row
          label="Il manque pour atteindre l'objectif"
          value={coverage ? (coverage.missing > 0 ? kEur(coverage.missing) : "Objectif couvert") : "—"}
          strong={!!coverage && coverage.missing > 0}
          muted={!coverage}
          hint={coverage ? (coverage.surplus > 0 ? `${kEur(coverage.surplus)} au-dessus de l'objectif` : "objectif − ce que RM Morning prévoit") : uncomputable}
        />
        <Row
          label="Couverture de l'objectif"
          value={coverage ? pct(coverage.ratio) : "—"}
          muted={!coverage}
          hint={coverage ? "ce que RM Morning prévoit ÷ objectif" : uncomputable}
        />
        <Row
          label={`Jours restants avant le 1er ${m}`}
          value={t.daysLeft > 0 ? `${t.daysLeft} jour(s)` : `${m} a commencé`}
          hint={t.daysLeft > 0 ? weeksLabel : null}
        />
        <Row
          label="Rythme mathématique nécessaire"
          value={t.pace ? `${kEur(t.pace.weekly)} / semaine` : "—"}
          hint={
            t.pace && t.missing != null
              ? `${kEur(t.missing)} à construire en ${weeksLabel} — un calcul, pas une prédiction`
              : t.covered
                ? "aucun rythme requis : l'objectif est déjà couvert"
                : "non calculable sans objectif et prévision"
          }
        />
      </dl>

      <Subsection
        title={`Comment notre vision ${ofMonth(m)} a évolué pendant ${during}`}
        aside={t.history ? `du ${DDMM(t.history.firstDate)} au ${DDMM(t.history.lastDate)}` : "historique indisponible"}
      >
        {t.history ? (
          <>
            <p className="px-4 pb-2 text-xs text-ink-faint md:px-6">
              Chaque colonne montre ce que nous pensions {ofMonth(m)} à cette date {ofMonth(during)}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                    <th className="px-4 py-2 font-medium md:px-6" />
                    {t.history.checkpoints.map((d) => (
                      <th key={d} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                        Vue au {DDMM(d)}
                      </th>
                    ))}
                    <th className="px-3 py-2 font-medium">Sur 7 jours</th>
                    <th className="px-4 py-2 font-medium md:px-6">Depuis le {DDMM(t.history.firstDate)}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {t.history.series.map((s) => (
                    <tr key={s.key}>
                      <td className="px-4 py-2.5 md:px-6">
                        {SERIES_LABEL[s.key](m)}
                        {s.unavailableReason ? <span className="block text-xs text-ink-faint">historique indisponible</span> : null}
                      </td>
                      {s.values.map((v, i) => (
                        <td key={t.history!.checkpoints[i]} className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                          {v == null ? "—" : kEur(v)}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <Reading reading={s.week} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 md:px-6">
                        <Reading reading={s.window} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.notes.length > 0 ? (
              <div className="space-y-1 px-4 py-2 text-xs text-ink-faint md:px-6">
                {t.notes.map((n) => (
                  <p key={n}>{n}</p>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState>Pas encore d&apos;historique pour {m}.</EmptyState>
        )}
      </Subsection>

      {forecast && gap != null ? (
        <Subsection
          title={
            gap >= 0
              ? `Pourquoi RM Morning prévoit ${kEur(forecast.projection)} alors que les commerciaux annoncent ${kEur(data.declared.gmv)} ?`
              : `Pourquoi RM Morning prévoit plus (${kEur(forecast.projection)}) que les commerciaux n'annoncent (${kEur(data.declared.gmv)}) ?`
          }
        >
          <p className="px-4 pb-2 text-sm md:px-6">
            Écart actuel : <span className="tabular font-semibold">{kEur(Math.abs(gap))}</span>
          </p>
          {gap > 0 && gapDeals.length > 0 ? (
            <>
              <p className="px-4 pb-2 text-xs text-ink-soft md:px-6">
                Principales affaires annoncées pour {m} mais jugées moins solides par RM Morning, par enjeu (la part de
                leur GMV que RM Morning n&apos;attend pas sur {m}) :
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                      <th className="px-4 py-2 font-medium md:px-6">Commercial</th>
                      <th className="px-3 py-2 font-medium">Affaire</th>
                      <th className="px-3 py-2 text-right font-medium">GMV</th>
                      <th className="px-3 py-2 font-medium">Projection Kanban</th>
                      <th className="px-3 py-2 text-right font-medium">Probabilité RM Morning</th>
                      <th className="px-3 py-2 text-right font-medium">Confiance ET</th>
                      <th className="px-4 py-2 font-medium md:px-6">Suivi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {gapDeals.slice(0, GAP_VISIBLE).map((d) => (
                      <GapRow key={d.opportunityId} d={d} />
                    ))}
                  </tbody>
                </table>
              </div>
              {gapDeals.length > GAP_VISIBLE ? (
                <details className="border-t border-line">
                  <summary className="cursor-pointer list-none px-4 py-2.5 text-xs text-ink-soft underline decoration-dotted md:px-6">
                    Voir les {gapDeals.length - GAP_VISIBLE} autres affaires annoncées (
                    {kEur(gapDeals.slice(GAP_VISIBLE).reduce((t, d) => t + d.stake, 0))} d&apos;enjeu)
                  </summary>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[46rem] text-sm">
                      <tbody className="divide-y divide-line">
                        {gapDeals.slice(GAP_VISIBLE).map((d) => (
                          <GapRow key={d.opportunityId} d={d} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
          <p className="px-4 py-3 text-xs text-ink-faint md:px-6">
            Ces affaires n&apos;additionnent pas l&apos;écart : la prévision RM Morning ne se construit pas affaire par
            affaire. Elle part du niveau historique de l&apos;équipe, ajusté par la force du pipe, et intègre du GMV
            d&apos;affaires qui n&apos;existent pas encore — {data.futureShare} du GMV d&apos;un mois suivant, historiquement.
          </p>
        </Subsection>
      ) : null}

      <Subsection
        title={`Affaires que RM Morning suggère d'ajouter à ${m}`}
        aside={`${suggested.length} affaire(s) · ${data.identified.count} identifiée(s) au total, ${kEur(data.identified.gmv)} de GMV`}
      >
        {suggested.length === 0 ? (
          <EmptyState>
            Aucune affaire non annoncée n&apos;a une chance réelle de signer en {m}. Les {data.declared.count} affaires
            annoncées sont détaillées ci-dessus.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                  <th className="px-4 py-2 font-medium md:px-6">Commercial</th>
                  <th className="px-3 py-2 font-medium">Affaire</th>
                  <th className="px-3 py-2 text-right font-medium">GMV</th>
                  <th className="px-3 py-2 font-medium">Stade</th>
                  <th className="px-3 py-2 text-right font-medium">Probabilité {m}</th>
                  <th className="px-4 py-2 font-medium md:px-6">Pourquoi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {suggested.map((d) => (
                  <tr key={d.opportunityId} className="align-top">
                    <td className="px-4 py-2 text-xs text-ink-soft md:px-6">{d.ownerFirstName}</td>
                    <td className="px-3 py-2 font-medium">
                      <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
                    </td>
                    <td className="tabular px-3 py-2 text-right">{kEur(d.gmv)}</td>
                    <td className="px-3 py-2 text-xs text-ink-soft">{d.stage ?? "—"}</td>
                    <td className="tabular px-3 py-2 text-right">{d.probability == null ? "—" : pctFine(d.probability)}</td>
                    <td className="px-4 py-2 text-xs md:px-6">
                      <Badge tone="warning">Suggérée RM Morning</Badge>
                      {d.challenge ? <span className="ml-1 text-ink-faint">{d.challenge}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-faint md:px-6">
          Le GMV identifié ({kEur(data.identified.gmv)}, annoncé et suggéré) n&apos;est pas la prévision : ce que RM
          Morning prévoit pour {m} est un chiffre distinct, calculé sur l&apos;historique et la force du pipe.
        </p>
      </Subsection>

      {data.issues.length > 0 ? (
        <ul className="space-y-1 border-t border-line px-4 py-3 text-xs text-ink-faint md:px-6">
          {data.issues.map((i, k) => (
            <li key={k}>{i}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

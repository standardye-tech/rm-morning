import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import Link from "next/link";

import { Badge, Card, EmptyState, SectionTitle, Stat } from "@/components/ui";
import {
  ATTENTION_LABEL,
  PERFORMANCE_LABEL,
  type AttentionLevel,
  type AttentionVerdict,
  type PerformanceLevel,
  type Recommendation,
} from "@/lib/attention";
import { OBJECTIVE_LABEL, type BigDeal } from "@/lib/big-deals";
import type { WeekSlotKind } from "@/lib/config";
import type { PlannedSlot, WeekItem } from "@/lib/week-plan";
import type { WeekView } from "@/lib/week";
import { kEur } from "@/lib/vocabulary";

/**
 * « Ma semaine » — les blocs de lecture.
 *
 * PARTI PRIS : peu de texte, des codes couleur évidents, et pour chaque
 * intervention la même grille — pourquoi, combien de temps, quoi obtenir.
 * Le vert, l'orange et le rouge ne sont jamais décoratifs : ce sont les trois
 * niveaux d'attention managériale. La Performance, elle, n'a pas de rouge.
 */

const ATTENTION_DOT: Record<AttentionLevel, string> = {
  vert: "bg-positive",
  orange: "bg-warning",
  rouge: "bg-danger",
};

const PERFORMANCE_DOT: Record<PerformanceLevel, string> = {
  vert: "bg-positive",
  neutre: "bg-ink-faint",
  orange: "bg-warning",
};

const ATTENTION_TONE: Record<AttentionLevel, "positive" | "warning" | "danger"> = {
  vert: "positive",
  orange: "warning",
  rouge: "danger",
};

/** Pastille de statut. Un point de couleur et un libellé lisible par un lecteur d'écran. */
export function Dot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const KIND_ICON: Record<WeekSlotKind, string> = {
  et_rouge: "",
  et_orange: "",
  gros_dossier: "🔥",
  affaire_semaine: "🎯",
  candidatures: "📋",
  entretiens: "🗣️",
  sourcing_et: "🔎",
  sourcing_archi: "🔎",
};

function ItemMarker({ item }: { item: WeekItem }) {
  if (item.kind === "et_rouge") return <Dot className={ATTENTION_DOT.rouge} label="ET prioritaire" />;
  if (item.kind === "et_orange") return <Dot className={ATTENTION_DOT.orange} label="ET orange" />;
  return (
    <span aria-hidden className="text-sm leading-none">
      {KIND_ICON[item.kind]}
    </span>
  );
}

// --- Bandeau de synthèse ---------------------------------------------------

export function WeekSummaryBand({ view }: { view: WeekView }) {
  const s = view.summary;
  return (
    <Card className="mt-6">
      <div className="grid grid-cols-2 divide-x divide-line md:grid-cols-5">
        <Stat label="ET prioritaires" value={String(s.red)} tone={s.red > 0 ? "danger" : "neutral"} hint="intervention prioritaire" />
        <Stat label="ET à surveiller" value={String(s.orange)} tone={s.orange > 0 ? "warning" : "neutral"} hint="intervention utile" />
        <Stat label="Gros dossiers" value={String(s.bigDeals)} hint={`≥ ${kEur(100_000)} · à closer, débloquer, accélérer`} />
        <Stat label="Affaire de la semaine" value={String(s.dealOfWeek)} hint={s.dealOfWeek ? "sélectionnée" : "à choisir"} />
        <Stat label="Candidatures" value={String(s.candidatures)} hint="à traiter cette semaine" />
      </div>
    </Card>
  );
}

// --- Recommandation : Regarder où / Rechercher quoi / Obtenir quoi -----------

function RecommendationLines({ r, compact = false }: { r: Recommendation; compact?: boolean }) {
  return (
    <dl className={`grid gap-x-4 gap-y-0.5 text-xs ${compact ? "" : "sm:grid-cols-[auto_1fr]"}`}>
      <dt className="text-ink-faint">Regarder où</dt>
      <dd className="text-ink-soft">{r.lookWhere}</dd>
      <dt className="text-ink-faint">Rechercher quoi</dt>
      <dd className="text-ink-soft">{r.lookFor}</dd>
      <dt className="text-ink-faint">Obtenir quoi</dt>
      <dd className="text-ink">{r.obtain}</dd>
    </dl>
  );
}

// --- À traiter cette semaine -------------------------------------------------

export function WeekActions({ items }: { items: WeekItem[] }) {
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Priorités"
        title="À traiter cette semaine"
        aside="ET rouge · gros dossier urgent · affaire de la semaine · ET orange · candidatures"
      />
      {items.length === 0 ? (
        <EmptyState>Aucune intervention recommandée cette semaine. C&apos;est une bonne nouvelle.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.key} className="px-4 py-3 md:px-6 md:py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <ItemMarker item={item} />
                  {item.href ? (
                    <Link href={item.href} className="hover:underline">
                      {item.title}
                    </Link>
                  ) : (
                    item.title
                  )}
                </span>
                {item.who !== item.title ? <span className="text-xs text-ink-faint">{item.who}</span> : null}
                {item.urgent && item.kind === "gros_dossier" ? <Badge tone="danger">urgent</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-ink-soft">{item.reason}</p>
              <p className="mt-1 text-xs">
                <span className="text-ink-faint">Recommandation : </span>
                <span className="tabular font-medium">{item.recommendation.minutes} min</span>
                <span className="text-ink-faint"> · Action : </span>
                <span className="font-medium">{item.recommendation.action}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- Experts Travaux : Performance ≠ Attention ------------------------------

export function TeamAttention({ verdicts }: { verdicts: AttentionVerdict[] }) {
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Experts Travaux"
        title="Performance et attention managériale"
        aside="Deux lectures distinctes : comment il va, et si vous devez intervenir."
      />
      {verdicts.length === 0 ? (
        <EmptyState>Aucun commercial dans le périmètre.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-[0.04em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
                <th className="px-4 py-2 md:px-6">ET</th>
                <th className="px-3 py-2">Performance</th>
                <th className="px-3 py-2">Attention</th>
                <th className="px-3 py-2">Pourquoi</th>
                <th className="px-4 py-2 text-right md:px-6">Temps</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {verdicts.map((v) => (
                <tr key={v.salesperson} className="align-top">
                  <td className="px-4 py-2.5 font-medium md:px-6">
                    <Link
                      href={`/performance?commercial=${encodeURIComponent(v.salesperson)}`}
                      className="hover:underline"
                    >
                      {v.firstName}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Dot className={PERFORMANCE_DOT[v.performance.level]} label={PERFORMANCE_LABEL[v.performance.level]} />
                    <span className="ml-1.5 text-xs text-ink-soft">
                      {v.performance.score != null ? <span className="tabular">{v.performance.score.toFixed(0)}</span> : "—"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={ATTENTION_TONE[v.attention.level]}>
                      <Dot className={ATTENTION_DOT[v.attention.level]} label="" />
                      <span className="ml-1">{ATTENTION_LABEL[v.attention.level]}</span>
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    {v.reasons.length === 0 ? (
                      <span className="text-xs text-ink-faint">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {v.reasons.map((r) => (
                          <li key={r.key} className="text-xs">
                            <span className={r.weight === "fort" ? "font-medium text-ink" : "text-ink-soft"}>{r.label}</span>
                            <span className="text-ink-faint"> · {r.detail}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-xs md:px-6">
                    {v.recommendation ? `${v.recommendation.minutes} min` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- Gros dossiers -------------------------------------------------------------

export function BigDeals({ deals }: { deals: BigDeal[] }) {
  return (
    <Card className="mt-6">
      <SectionTitle eyebrow="🔥 Gros dossiers" title="À accélérer, débloquer, closer ou arbitrer" aside={`≥ ${kEur(100_000)}, dossier avancé, probable, bloqué ou déclaré ce mois`} />
      {deals.length === 0 ? (
        <EmptyState>Aucun gros dossier ne réclame d&apos;intervention cette semaine.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {deals.map((d) => (
            <li key={d.opportunityId} className="px-4 py-3 md:px-6 md:py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-semibold">
                  <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
                </span>
                <span className="tabular text-sm font-medium">{kEur(d.gmv)}</span>
                {/* Le nom de l'affaire ouvre Salesforce ; l'accès au Forecast du commercial passe par son prénom. */}
                <Link href={`/forecast?commercial=${encodeURIComponent(d.owner)}`} className="text-xs text-ink-faint hover:underline">
                  {d.firstName}
                </Link>
                <Badge tone={d.urgent ? "danger" : "neutral"}>{OBJECTIVE_LABEL[d.objective]}</Badge>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{d.reason}</p>
              <p className="mt-1 text-xs">
                <span className="text-ink-faint">Recommandation : </span>
                <span className="tabular font-medium">{d.recommendation.minutes} min</span>
                <span className="text-ink-faint"> · Action : </span>
                <span className="font-medium">{d.recommendation.action}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- Planning recommandé ----------------------------------------------------------

export function WeekPlanning({ planning }: { planning: PlannedSlot[] }) {
  const days = [...new Set(planning.map((s) => s.day))];
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Planning recommandé"
        title="Vos créneaux-types, remplis seulement quand c'est utile"
        aside="Heure · avec qui · regarder où · rechercher quoi · obtenir quoi"
      />
      <div className="divide-y divide-line">
        {days.map((day) => (
          <div key={day} className="px-4 py-3 md:px-6 md:py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint md:text-[11px]">
              {planning.find((s) => s.day === day)?.dayLabel}
            </p>
            <ul className="mt-2 space-y-3">
              {planning
                .filter((s) => s.day === day)
                .map((slot) => (
                  <li key={`${slot.day}-${slot.time}`} className="grid gap-x-4 gap-y-1 sm:grid-cols-[4.5rem_1fr]">
                    <span className="tabular text-sm font-medium">{slot.time}</span>
                    <div className="min-w-0">
                      {slot.item ? (
                        <>
                          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span className="text-ink-faint">{slot.kindLabel}</span>
                            <span aria-hidden className="text-ink-faint">→</span>
                            <span className="inline-flex items-center gap-2 font-semibold">
                              <ItemMarker item={slot.item} />
                              {slot.item.href ? (
                                <Link href={slot.item.href} className="hover:underline">
                                  {slot.item.title}
                                </Link>
                              ) : (
                                slot.item.title
                              )}
                            </span>
                            {slot.item.who !== slot.item.title ? (
                              <span className="text-xs text-ink-faint">{slot.item.who}</span>
                            ) : null}
                            {slot.reassigned ? <Badge tone="neutral">créneau réaffecté</Badge> : null}
                          </p>
                          <p className="mt-0.5 text-xs">
                            <span className="text-ink-faint">Pourquoi : </span>
                            <span className="text-ink-soft">{slot.item.reason}</span>
                            <span className="text-ink-faint"> · </span>
                            <span className="tabular">{slot.item.recommendation.minutes} min</span>
                          </p>
                          <div className="mt-1">
                            <RecommendationLines r={slot.item.recommendation} />
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="text-sm">
                            <span className="text-ink-faint">{slot.kindLabel}</span>
                            {slot.kind === "sourcing_et" || slot.kind === "sourcing_archi" ? null : (
                              <>
                                <span aria-hidden className="text-ink-faint"> → </span>
                                <span className="font-medium text-ink-soft">Créneau disponible</span>
                              </>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-soft">{slot.note}</p>
                          {slot.suggestion ? <p className="mt-0.5 text-xs text-ink-faint">{slot.suggestion}</p> : null}
                        </>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- Limites de lecture ------------------------------------------------------------

export function WeekNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="mt-6 space-y-1 text-xs text-ink-faint">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

export function WeekEmpty() {
  return (
    <Card className="mt-6">
      <EmptyState>
        Aucune donnée importée. Lancez « Actualiser RM Morning » depuis l&apos;en-tête : la semaine se construit à
        partir de Salesforce, de la Perspective et du Monitoring.
      </EmptyState>
    </Card>
  );
}

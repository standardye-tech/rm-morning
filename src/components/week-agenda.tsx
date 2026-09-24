"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import type { ScheduledCard } from "@/lib/week-agenda";
import type { WeekAgendaView } from "@/lib/week-agenda-view";

/**
 * « Ma semaine » — le planning recommandé (lot de simplification, B).
 *
 * Une carte = un ET, lisible en cinq secondes : qui, pourquoi, quoi traiter,
 * sur quelles affaires. Trois gestes seulement : cocher un sujet, placer un ET
 * dans un créneau, rétablir. Tout le reste est calculé côté serveur.
 */

const DAY = ["", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];

const LEVEL_DOT: Record<ScheduledCard["level"], string> = {
  rouge: "bg-danger",
  orange: "bg-warning",
  vert: "bg-ink-faint",
};

const LEVEL_LABEL: Record<ScheduledCard["level"], string> = {
  rouge: "intervention prioritaire",
  orange: "intervention utile",
  vert: "sujets de la semaine",
};

async function post(body: object): Promise<boolean> {
  const r = await fetch("/api/semaine/agenda", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

type Filter = "aujourdhui" | "demain" | "semaine";

export function WeekAgendaBoard({ view }: { view: WeekAgendaView }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(() => new Set(view.doneKeys));
  const [filter, setFilter] = useState<Filter>("semaine");

  const act = (body: object, optimistic?: () => void) => {
    optimistic?.();
    startTransition(async () => {
      await post(body);
      router.refresh();
    });
  };
  const check = (key: string) => act({ action: "traiter", key }, () => setDone((d) => new Set(d).add(key)));

  const today = view.todayDay;
  const visibleDay = filter === "aujourdhui" ? today : filter === "demain" && today != null ? today + 1 : null;
  const timeline =
    filter === "semaine" ? view.timeline : view.timeline.filter((c) => c.slot?.day === visibleDay);

  // Compteurs recalculés avec les coches optimistes, pour réagir sans attendre.
  const optimistic = [...done].filter((k) => !view.doneKeys.includes(k)).length;
  const counts = {
    total: view.counts.total,
    done: view.counts.done + optimistic,
    remaining: view.counts.remaining - optimistic,
  };

  const chip = (active: boolean) =>
    `inline-flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm transition-colors md:min-h-0 ${
      active ? "bg-canvas font-medium text-ink ring-1 ring-line" : "text-ink-soft hover:bg-canvas"
    }`;

  return (
    <div className="mt-6 space-y-6">
      <Card>
        <SectionTitle
          eyebrow="Ma semaine"
          title="Planning recommandé"
          aside={
            <span className="tabular">
              {counts.total} sujet{counts.total > 1 ? "s" : ""} à traiter · {counts.done} terminé
              {counts.done > 1 ? "s" : ""} · {counts.remaining} restant{counts.remaining > 1 ? "s" : ""}
            </span>
          }
        />
        <div className="flex flex-wrap gap-1 border-b border-line px-4 pb-3 md:px-6" role="group" aria-label="Période">
          {today != null ? (
            <>
              <button type="button" aria-pressed={filter === "aujourdhui"} className={chip(filter === "aujourdhui")} onClick={() => setFilter("aujourdhui")}>
                Aujourd&apos;hui
              </button>
              {today < 5 ? (
                <button type="button" aria-pressed={filter === "demain"} className={chip(filter === "demain")} onClick={() => setFilter("demain")}>
                  Demain
                </button>
              ) : null}
            </>
          ) : null}
          <button type="button" aria-pressed={filter === "semaine"} className={chip(filter === "semaine")} onClick={() => setFilter("semaine")}>
            Toute la semaine
          </button>
        </div>
        {timeline.length === 0 ? (
          <EmptyState>
            {filter === "semaine"
              ? "Aucun ET à placer d'office dans la grille cette semaine."
              : "Aucun ET planifié ce jour-là."}
          </EmptyState>
        ) : (
          <ol className="divide-y divide-line">
            {timeline.map((c) => (
              <li key={c.owner}>
                <AgendaCardView
                  card={c}
                  done={done}
                  busy={busy}
                  onCheck={check}
                  heading={`${c.slot!.time ?? "horaire à caler"} — ${c.owner.toUpperCase()}`}
                  dayLabel={filter === "semaine" ? DAY[c.slot!.day] : null}
                  footer={
                    c.placedBy === "manuel" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act({ action: "retirer", owner: c.owner })}
                        className="text-xs text-ink-faint underline decoration-dotted hover:text-ink disabled:opacity-50"
                      >
                        Retirer du créneau
                      </button>
                    ) : null
                  }
                />
              </li>
            ))}
          </ol>
        )}
      </Card>

      {view.toPlace.length > 0 ? (
        <Card>
          <SectionTitle
            eyebrow="Sans créneau"
            title="À placer cette semaine"
            aside={`${view.toPlace.length} ET`}
          />
          <p className="px-4 pb-2 text-xs text-ink-faint md:px-6">
            ET à voir cette semaine, sans créneau libre dans la grille ou sans urgence particulière. Aucun horaire
            n&apos;est inventé : choisissez un créneau proposé, ou un jour à caler vous-même.
          </p>
          <ol className="divide-y divide-line border-t border-line">
            {view.toPlace.map((c) => (
              <li key={c.owner}>
                <AgendaCardView
                  card={c}
                  done={done}
                  busy={busy}
                  onCheck={check}
                  heading={c.owner.toUpperCase()}
                  dayLabel={null}
                  footer={<PlaceControl owner={c.owner} options={view.placeOptions} busy={busy} onPlace={(value) => act({ action: "placer", owner: c.owner, value })} />}
                />
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <details className="group rounded-xl border border-line bg-surface">
        <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
          Terminés cette semaine
          <span className="ml-2 text-xs font-normal text-ink-faint">
            Voir les sujets traités ({view.done.length})
          </span>
        </summary>
        {view.done.length === 0 ? (
          <div className="border-t border-line">
            <EmptyState>Aucun sujet traité pour l&apos;instant cette semaine.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {view.done.map((d) => (
              <li key={d.key} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm md:px-6">
                <span>
                  <span className="text-ink-faint">{d.owner} · </span>
                  <span className="text-ink-soft line-through decoration-ink-faint/60">{d.label}</span>
                </span>
                <span className="flex items-center gap-3 text-xs text-ink-faint">
                  {new Date(d.doneAt).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act({ action: "retablir", key: d.key }, () =>
                        setDone((s) => {
                          const n = new Set(s);
                          n.delete(d.key);
                          return n;
                        }),
                      )
                    }
                    className="underline decoration-dotted hover:text-ink disabled:opacity-50"
                  >
                    Rétablir
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      {view.notes.length > 0 ? (
        <ul className="space-y-1 px-1 text-xs text-ink-faint">
          {view.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AgendaCardView({
  card,
  done,
  busy,
  onCheck,
  heading,
  dayLabel,
  footer,
}: {
  card: ScheduledCard;
  done: Set<string>;
  busy: boolean;
  onCheck: (key: string) => void;
  heading: string;
  dayLabel: string | null;
  footer: React.ReactNode;
}) {
  const active = card.tasks.filter((t) => !done.has(t.key));
  return (
    <article className="px-4 py-4 md:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${LEVEL_DOT[card.level]}`} />
          <span className="sr-only">{LEVEL_LABEL[card.level]}</span>
          {dayLabel ? <span className="font-normal text-ink-soft">{dayLabel}</span> : null}
          <span className="tabular">{heading}</span>
        </h3>
        <span className="text-xs text-ink-faint">{LEVEL_LABEL[card.level]}</span>
      </header>

      <div className="mt-2 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">Pourquoi le voir</p>
          <p className="tabular mt-0.5 text-sm">{card.why ?? "Momentum 7 jours indisponible"}</p>
          {card.attention ? <p className="mt-0.5 text-xs text-ink-soft">{card.attention}</p> : null}
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">À traiter</p>
          {active.length === 0 ? (
            <p className="mt-0.5 text-sm text-positive">✓ Tous les sujets de la semaine sont traités</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {active.map((t) => (
                <li key={t.key}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-current"
                      disabled={busy}
                      checked={false}
                      onChange={() => onCheck(t.key)}
                    />
                    <span>{t.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-sm">
        {card.keyDeals.length > 0 ? (
          <p className="text-ink-soft">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">Affaires clés </span>
            {card.keyDeals.map((d, i) => (
              <span key={d.opportunityId}>
                {i > 0 ? " · " : ""}
                <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
              </span>
            ))}
          </p>
        ) : (
          <span />
        )}
        <p className="flex flex-wrap items-center gap-4 text-xs">
          <Link href={`/forecast?commercial=${encodeURIComponent(card.owner)}`} className="underline decoration-dotted underline-offset-2 hover:text-ink">
            Ouvrir son Forecast
          </Link>
          <Link href={`/performance?commercial=${encodeURIComponent(card.owner)}`} className="underline decoration-dotted underline-offset-2 hover:text-ink">
            Voir Performance
          </Link>
          {footer}
        </p>
      </div>
    </article>
  );
}

function PlaceControl({
  owner,
  options,
  busy,
  onPlace,
}: {
  owner: string;
  options: { value: string; label: string }[];
  busy: boolean;
  onPlace: (value: string) => void;
}) {
  const [value, setValue] = useState(options[0]?.value ?? "");
  if (options.length === 0) return <span className="text-ink-faint">Plus de jour ouvré cette semaine</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <label className="sr-only" htmlFor={`place-${owner}`}>
        Créneau pour {owner}
      </label>
      <select
        id={`place-${owner}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-md border border-line bg-surface px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !value}
        onClick={() => onPlace(value)}
        className="rounded-md border border-line px-2.5 py-1 font-medium text-ink hover:bg-canvas disabled:opacity-50"
      >
        Placer dans l&apos;agenda
      </button>
    </span>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { Card, EmptyState } from "@/components/ui";
import type { ScheduledCard } from "@/lib/week-agenda";
import type { WeekAgendaView } from "@/lib/week-agenda-view";

/**
 * « Ma semaine » — le planning recommandé (lot de simplification, B).
 *
 * Une carte = un ET, lisible en cinq secondes : qui, pourquoi, quoi traiter,
 * sur quelles affaires. Trois gestes seulement : cocher un sujet, placer un ET
 * dans un créneau, rétablir. Tout le reste est calculé côté serveur.
 *
 * Mise en page (lot UI du 27/09/2026) : pleine largeur desktop ; chaque carte
 * planifiée pend à une timeline (jour, heure) et se lit en trois zones —
 * Pourquoi le voir | À traiter | Affaires clés et liens — empilées sur mobile.
 * Hiérarchie : nom de l'ET, puis sujets, puis motif, puis affaires, puis le reste.
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

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** Petit intitulé de zone, en capitales discrètes. */
function ZoneLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-faint">{children}</p>;
}

/** Lien secondaire, cliquable confortablement sans dominer les sujets. */
const secondaryButton =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-line px-3 text-[13px] text-ink-soft transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50";

export function WeekAgendaBoard({ view, subtitle }: { view: WeekAgendaView; subtitle: string }) {
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

  // Un ET dont le dernier sujet vient d'être coché quitte le planning sans
  // attendre le serveur ; il y revient si un sujet est rétabli.
  const hasActive = (c: ScheduledCard) => c.tasks.some((t) => !done.has(t.key));
  const today = view.todayDay;
  const visibleDay = filter === "aujourdhui" ? today : filter === "demain" && today != null ? today + 1 : null;
  const timeline = view.timeline.filter((c) => hasActive(c) && (filter === "semaine" || c.slot?.day === visibleDay));
  const toPlace = view.toPlace.filter(hasActive);

  // Compteurs recalculés avec les coches optimistes, pour réagir sans attendre.
  const optimistic = [...done].filter((k) => !view.doneKeys.includes(k)).length;
  const counts = {
    total: view.counts.total,
    done: view.counts.done + optimistic,
    remaining: view.counts.remaining - optimistic,
  };

  const chip = (active: boolean) =>
    `inline-flex min-h-10 items-center rounded-lg px-4 text-sm transition-colors ${
      active ? "bg-ink font-medium text-surface" : "bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas hover:text-ink"
    }`;

  return (
    <div className="space-y-8">
      {/* En-tête : où j'en suis, puis la période. */}
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">Ma semaine</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Planning recommandé</h1>
        <p className="tabular mt-2 text-base text-ink">
          {plural(counts.total, "sujet")} à traiter · {plural(counts.done, "terminé")} ·{" "}
          <span className="font-semibold">{plural(counts.remaining, "restant")}</span>
        </p>
        <p className="mt-1 text-sm text-ink-faint">{subtitle}</p>
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Période">
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
      </header>

      {/* Planning : une timeline de créneaux, une carte par ET. */}
      {timeline.length === 0 ? (
        <Card>
          <EmptyState>
            {filter === "semaine" ? "Aucun ET à placer d'office dans la grille cette semaine." : "Aucun ET planifié ce jour-là."}
          </EmptyState>
        </Card>
      ) : (
        <ol className="space-y-4">
          {timeline.map((c, i) => {
            const day = c.slot!.day;
            const firstOfDay = i === 0 || timeline[i - 1].slot!.day !== day;
            return (
              <li key={c.owner}>
                {filter === "semaine" && firstOfDay ? (
                  <h2 className={`mb-3 text-sm font-semibold uppercase tracking-[0.1em] text-ink-soft ${i > 0 ? "mt-8" : ""}`}>
                    {DAY[day]}
                  </h2>
                ) : null}
                <div className="md:grid md:grid-cols-[5.5rem_minmax(0,1fr)] md:gap-4">
                  <TimelineSlot time={c.slot!.time!} level={c.level} />
                  <PlannedCard
                    card={c}
                    done={done}
                    busy={busy}
                    onCheck={check}
                    time={c.slot!.time!}
                    extra={
                      c.placedBy === "manuel" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act({ action: "retirer", owner: c.owner })}
                          className="text-[13px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-50"
                        >
                          Retirer du créneau
                        </button>
                      ) : null
                    }
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* À placer : cartes compactes, deux par ligne sur desktop. */}
      {toPlace.length > 0 ? (
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-semibold tracking-tight">À placer cette semaine</h2>
            <span className="text-sm text-ink-faint">{toPlace.length} ET</span>
          </div>
          <p className="mt-1 text-sm text-ink-faint">
            ET à voir cette semaine, sans créneau libre dans la grille ou sans urgence particulière. Aucun horaire
            n&apos;est inventé : choisissez un créneau libre pour l&apos;ajouter au planning.
          </p>
          <ul className="mt-4 grid gap-4 lg:grid-cols-2">
            {toPlace.map((c) => (
              <li key={c.owner}>
                <ToPlaceCard
                  card={c}
                  done={done}
                  busy={busy}
                  onCheck={check}
                  options={view.placeOptions}
                  onPlace={(value) => act({ action: "placer", owner: c.owner, value })}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Terminés : fermé par défaut. */}
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-canvas md:px-6">
          <span className="text-base font-medium">Terminés cette semaine</span>
          <span className="text-sm text-ink-soft">
            Voir les sujets traités
            <span className="tabular ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-ink ring-1 ring-line">
              {view.done.length}
            </span>
          </span>
          <span aria-hidden className="ml-auto text-ink-faint transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        {view.done.length === 0 ? (
          <div className="border-t border-line">
            <EmptyState>Aucun sujet traité pour l&apos;instant cette semaine.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {view.done.map((d) => (
              <li key={d.key} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-[15px] md:px-6">
                <span>
                  <span className="text-ink-faint">{d.owner} · </span>
                  <span className="text-ink-soft line-through decoration-ink-faint/60">{d.label}</span>
                </span>
                <span className="flex items-center gap-3 text-[13px] text-ink-faint">
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
        <ul className="space-y-1 px-1 text-[13px] text-ink-faint">
          {view.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Le créneau, à gauche de la carte sur desktop ; au-dessus sur mobile. */
function TimelineSlot({ time, level }: { time: string; level: ScheduledCard["level"] }) {
  return (
    <div className="mb-2 flex items-center gap-2 md:relative md:mb-0 md:flex-col md:items-end md:gap-1 md:pt-5">
      <span className="tabular text-lg font-semibold tracking-tight md:text-xl">{time}</span>
      <span className="flex items-center gap-1.5 text-xs text-ink-faint">
        <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${LEVEL_DOT[level]}`} />
        <span className="md:hidden">{LEVEL_LABEL[level]}</span>
      </span>
    </div>
  );
}

function TaskList({
  tasks,
  busy,
  onCheck,
  compact = false,
}: {
  tasks: ScheduledCard["tasks"];
  busy: boolean;
  onCheck: (key: string) => void;
  compact?: boolean;
}) {
  return (
    <ul className={compact ? "space-y-2" : "space-y-3"}>
      {tasks.map((t) => (
        <li key={t.key}>
          <label className={`flex cursor-pointer items-start gap-3 ${compact ? "text-sm" : "text-base leading-snug"}`}>
            <input
              type="checkbox"
              className={`shrink-0 accent-current ${compact ? "mt-0.5 h-4 w-4" : "mt-0.5 h-5 w-5"}`}
              disabled={busy}
              checked={false}
              onChange={() => onCheck(t.key)}
            />
            <span>{t.label}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function OwnerLinks({ owner }: { owner: string }) {
  return (
    <>
      <Link href={`/forecast?commercial=${encodeURIComponent(owner)}`} className={secondaryButton}>
        Ouvrir son Forecast
      </Link>
      <Link href={`/performance?commercial=${encodeURIComponent(owner)}`} className={secondaryButton}>
        Voir Performance
      </Link>
    </>
  );
}

function PlannedCard({
  card,
  done,
  busy,
  onCheck,
  time,
  extra,
}: {
  card: ScheduledCard;
  done: Set<string>;
  busy: boolean;
  onCheck: (key: string) => void;
  time: string;
  extra: React.ReactNode;
}) {
  const active = card.tasks.filter((t) => !done.has(t.key));
  return (
    <Card>
      <article>
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-4 md:px-6">
          <h3 className="text-xl font-semibold tracking-tight">
            <span className="sr-only">{time} — </span>
            {card.owner.toUpperCase()}
          </h3>
          <span className="flex items-baseline gap-3">
            <span className="hidden text-[13px] text-ink-faint md:inline">{LEVEL_LABEL[card.level]}</span>
            <span className="tabular text-sm font-medium text-ink-soft">
              {plural(active.length, "sujet")} restant{active.length > 1 ? "s" : ""}
            </span>
          </span>
        </header>

        <div className="grid gap-6 px-4 py-5 md:px-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,9fr)_minmax(0,5fr)] lg:gap-8">
          <div>
            <ZoneLabel>Pourquoi le voir</ZoneLabel>
            <p className="tabular mt-2 text-[15px]">{card.why ?? "Momentum 7 jours indisponible"}</p>
            {card.attention ? <p className="mt-1.5 text-sm text-ink-soft">{card.attention}</p> : null}
          </div>

          <div>
            <ZoneLabel>À traiter</ZoneLabel>
            <div className="mt-2">
              <TaskList tasks={active} busy={busy} onCheck={onCheck} />
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:border-l lg:border-line lg:pl-8">
            <div>
              <ZoneLabel>Affaires clés</ZoneLabel>
              {card.keyDeals.length > 0 ? (
                <ul className="mt-2 space-y-1.5 text-[15px]">
                  {card.keyDeals.map((d) => (
                    <li key={d.opportunityId}>
                      <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-faint">Aucune affaire à ouvrir</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <OwnerLinks owner={card.owner} />
              {extra}
            </div>
          </div>
        </div>
      </article>
    </Card>
  );
}

function ToPlaceCard({
  card,
  done,
  busy,
  onCheck,
  options,
  onPlace,
}: {
  card: ScheduledCard;
  done: Set<string>;
  busy: boolean;
  onCheck: (key: string) => void;
  options: { value: string; label: string }[];
  onPlace: (value: string) => void;
}) {
  const active = card.tasks.filter((t) => !done.has(t.key));
  return (
    <Card className="flex h-full flex-col">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-4 md:px-5">
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${LEVEL_DOT[card.level]}`} />
          <span className="sr-only">{LEVEL_LABEL[card.level]}</span>
          {card.owner.toUpperCase()}
        </h3>
        <span className="tabular text-sm text-ink-soft">
          {plural(active.length, "sujet")}
        </span>
      </header>
      <div className="flex-1 px-4 pb-3 pt-3 md:px-5">
        <TaskList tasks={active} busy={busy} onCheck={onCheck} compact />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 md:px-5">
        <PlaceControl owner={card.owner} options={options} busy={busy} onPlace={onPlace} />
        <span className="ml-auto flex flex-wrap gap-2">
          <OwnerLinks owner={card.owner} />
        </span>
      </div>
    </Card>
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
  // Après une actualisation, le créneau retenu peut avoir été pris : on ne
  // soumet qu'un créneau encore proposé, jamais une valeur périmée.
  const selected = options.some((o) => o.value === value) ? value : (options[0]?.value ?? "");
  if (options.length === 0) return <span className="text-sm text-ink-faint">Aucun créneau libre cette semaine</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`place-${owner}`}>
        Créneau pour {owner}
      </label>
      <select
        id={`place-${owner}`}
        value={selected}
        onChange={(e) => setValue(e.target.value)}
        className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !selected}
        onClick={() => onPlace(selected)}
        className="inline-flex min-h-9 items-center rounded-md bg-ink px-3 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
      >
        Placer dans l&apos;agenda
      </button>
    </span>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Card, SectionTitle } from "@/components/ui";
import type { DealCandidate, DealOfWeekView } from "@/lib/week";
import { kEur } from "@/lib/vocabulary";

/**
 * 🎯 Affaire de la semaine — choix manuel.
 *
 * Un menu déroulant des affaires actives, regroupées par Expert Travaux, un
 * commentaire facultatif, un bouton. L'affaire reste sélectionnée d'une
 * semaine à l'autre tant qu'elle n'est pas close ou remplacée : c'est un
 * support de management, pas un rappel du lundi.
 */

type Props = {
  current: DealOfWeekView | null;
  candidates: DealCandidate[];
};

export function DealOfWeek({ current, candidates }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(current == null);
  const [choice, setChoice] = useState("");
  const [comment, setComment] = useState("");

  const byOwner = new Map<string, DealCandidate[]>();
  for (const c of candidates) {
    const list = byOwner.get(c.firstName);
    if (list) list.push(c);
    else byOwner.set(c.firstName, [c]);
  }

  async function post(body: object) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/semaine/affaire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) setError(payload.error ?? "L'opération a échoué.");
      else {
        setPicking(false);
        setChoice("");
        setComment("");
        router.refresh();
      }
    } catch {
      setError("Le serveur n'a pas répondu.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="🎯 Affaire de la semaine"
        title="Une affaire pour challenger la méthode d'un ET"
        aside="Pas forcément un gros dossier : une affaire qui démarre convient très bien."
      />
      <div className="px-4 py-3 md:px-6 md:py-4">
        {current ? (
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">
                {current.firstName} – {current.client}
              </span>
              {current.gmv != null ? <span className="tabular text-sm font-medium">{kEur(current.gmv)}</span> : null}
              {current.stage ? <span className="text-xs text-ink-faint">{current.stage}</span> : null}
              {current.inactiveReason ? <Badge tone="warning">{current.inactiveReason}</Badge> : null}
            </div>
            {current.record.comment ? (
              <p className="mt-1 text-sm text-ink-soft">{current.record.comment}</p>
            ) : null}
            <p className="mt-1 text-xs text-ink-faint">
              Choisie le {new Date(current.record.selectedAt).toLocaleDateString("fr-FR")} ·{" "}
              <span className="tabular">{current.recommendation.minutes} min</span> · {current.recommendation.action}
            </p>
            <p className="mt-2 text-xs text-ink-faint">À challenger : {current.axes.join(" · ")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setPicking((v) => !v)}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-canvas disabled:opacity-50"
              >
                {picking ? "Annuler" : "Changer d'affaire"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => post({ action: "cloturer", id: current.record.id })}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-canvas hover:text-danger disabled:opacity-50"
              >
                Clore
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Aucune affaire sélectionnée. Choisissez-en une ci-dessous.</p>
        )}

        {picking ? (
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (choice) post({ action: "selectionner", opportunityId: choice, comment });
            }}
          >
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
              aria-label="Affaire à sélectionner"
            >
              <option value="">Choisir une affaire…</option>
              {[...byOwner.entries()].map(([firstName, list]) => (
                <optgroup key={firstName} label={firstName}>
                  {list.map((c) => (
                    <option key={c.opportunityId} value={c.opportunityId}>
                      {c.client} · {kEur(c.gmv)}
                      {c.stage ? ` · ${c.stage}` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Pourquoi cette affaire (facultatif)"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy || !choice}
              className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50"
            >
              Sélectionner
            </button>
          </form>
        ) : null}
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}

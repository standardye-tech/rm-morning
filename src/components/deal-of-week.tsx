"use client";

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Card, SectionTitle } from "@/components/ui";
import { DEAL_OF_WEEK_ANGLES } from "@/lib/config";
import type { Recommendation, RecommendationSet } from "@/lib/deal-of-week-recommend";
import type { DealCandidate, DealOfWeekView } from "@/lib/week";
import { kEur } from "@/lib/vocabulary";

/**
 * 🎯 Affaire recommandée de la semaine — « RM Morning propose, Sami arbitre ».
 *
 * Le parcours normal tient en trois secondes : une affaire recommandée, sa
 * raison, son angle, et trois gestes — choisir, voir les alternatives, ignorer
 * la semaine. Le choix manuel parmi tout le pipe existe encore, mais derrière
 * une action secondaire : c'est une solution de secours, pas l'interface.
 *
 * Une fois choisie, une carte dit qui, quoi, combien, à quelle étape, sous
 * quel angle et ce que le point doit obtenir.
 */

type Props = {
  current: DealOfWeekView | null;
  recommendation: RecommendationSet | null;
  ignoredThisWeek: boolean;
  candidates: DealCandidate[];
};

const ANGLES = DEAL_OF_WEEK_ANGLES;

type Mode = "lecture" | "angle" | "manuel";

function Suggestion({
  r,
  primary,
  busy,
  onChoose,
}: {
  r: Recommendation;
  primary: boolean;
  busy: boolean;
  onChoose: (r: Recommendation) => void;
}) {
  const c = r.candidate;
  return (
    <div className={primary ? "" : "border-t border-line pt-3"}>
      <p className={`${primary ? "text-[15px]" : "text-sm"} font-semibold`}>
        {c.firstName} — <SalesforceOpportunityLink opportunityId={c.opportunityId}>{c.client}</SalesforceOpportunityLink> — {kEur(c.gmv)}
        {c.stage ? <span className="font-normal text-ink-soft"> — {c.stage}</span> : null}
      </p>
      <p className="mt-1 text-sm text-ink-soft">{r.reason}</p>
      <p className="mt-1 text-xs">
        <span className="text-ink-faint">Angle suggéré : </span>
        <span className="font-medium">{r.angleLabel}</span>
        {c.attention ? (
          <span className="text-ink-faint">
            {" "}
            · ET {c.attention === "rouge" ? "prioritaire" : c.attention === "orange" ? "à surveiller" : "performant"}
          </span>
        ) : null}
      </p>
      <div className="mt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose(r)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            primary ? "bg-ink text-surface" : "border border-line text-ink-soft hover:bg-canvas"
          }`}
        >
          {primary ? "Choisir cette affaire" : "Choisir celle-ci"}
        </button>
      </div>
    </div>
  );
}

export function DealOfWeek({ current, recommendation, ignoredThisWeek, candidates }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("lecture");
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [choice, setChoice] = useState("");
  const [angle, setAngle] = useState<string>(current?.record.angle ?? ANGLES[1].key);
  const [note, setNote] = useState(current?.record.comment ?? "");

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
        setMode("lecture");
        setChoice("");
        setShowAlternatives(false);
        router.refresh();
      }
    } catch {
      setError("Le serveur n'a pas répondu.");
    } finally {
      setBusy(false);
    }
  }

  const choose = (r: Recommendation) =>
    post({ action: "selectionner", opportunityId: r.candidate.opportunityId, angle: r.angle, comment: "" });

  const secondary = (label: string, onClick: () => void, danger = false) => (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-canvas disabled:opacity-50 ${danger ? "hover:text-danger" : ""}`}
    >
      {label}
    </button>
  );

  const angleSelect = (
    <select
      value={angle}
      onChange={(e) => setAngle(e.target.value)}
      aria-label="Angle de challenge"
      className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
    >
      {ANGLES.map((a) => (
        <option key={a.key} value={a.key}>
          {a.label}
        </option>
      ))}
    </select>
  );

  const noteInput = (
    <input
      type="text"
      value={note}
      onChange={(e) => setNote(e.target.value)}
      placeholder="Note courte (facultatif)"
      maxLength={140}
      aria-label="Note"
      className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
    />
  );

  // --- Mode manuel : le secours, jamais le parcours normal --------------------
  const manualForm = (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) post({ action: "selectionner", opportunityId: choice, angle, comment: note });
      }}
    >
      <label className="text-xs text-ink-faint" htmlFor="dow-affaire">
        Affaire
      </label>
      <select
        id="dow-affaire"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
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
      <label className="mt-1 text-xs text-ink-faint">Angle de challenge</label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {angleSelect}
        {noteInput}
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || !choice}
          className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50"
        >
          Sélectionner
        </button>
        {secondary("Annuler", () => setMode("lecture"))}
      </div>
    </form>
  );

  let body;
  if (mode === "manuel") {
    body = manualForm;
  } else if (current) {
    body = (
      <div>
        <p className="text-sm font-semibold">
          {current.firstName} — <SalesforceOpportunityLink opportunityId={current.record.opportunityId}>{current.client}</SalesforceOpportunityLink>
          {current.gmv != null ? ` — ${kEur(current.gmv)}` : ""}
          {current.stage ? <span className="font-normal text-ink-soft"> — {current.stage}</span> : null}
        </p>
        {current.inactiveReason ? (
          <p className="mt-1">
            <Badge tone="warning">{current.inactiveReason}</Badge>
          </p>
        ) : null}
        <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-faint">Angle</dt>
          <dd className="font-medium">{current.angleLabel}</dd>
          <dt className="text-ink-faint">Objectif</dt>
          <dd className="text-ink">{current.objective}</dd>
          {current.record.comment ? (
            <>
              <dt className="text-ink-faint">Note</dt>
              <dd className="text-ink-soft">{current.record.comment}</dd>
            </>
          ) : null}
        </dl>
        {mode === "angle" ? (
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(e) => {
              e.preventDefault();
              post({ action: "modifier", id: current.record.id, angle, comment: note });
            }}
          >
            {angleSelect}
            {noteInput}
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50"
            >
              Enregistrer
            </button>
            {secondary("Annuler", () => setMode("lecture"))}
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {secondary("Changer d'angle", () => setMode("angle"))}
            {secondary("Changer d'affaire", () => setMode("manuel"))}
            {secondary("Clore", () => post({ action: "cloturer", id: current.record.id }), true)}
          </div>
        )}
      </div>
    );
  } else if (ignoredThisWeek) {
    body = (
      <div>
        <p className="text-sm text-ink-soft">Semaine sans affaire de la semaine : recommandation ignorée.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {secondary("Reprendre la recommandation", () => post({ action: "reprendre" }))}
          {secondary("Choisir manuellement", () => setMode("manuel"))}
        </div>
      </div>
    );
  } else if (recommendation) {
    const { primary, alternatives } = recommendation;
    body = (
      <div className="space-y-3">
        <Suggestion r={primary} primary busy={busy} onChoose={choose} />
        {showAlternatives
          ? alternatives.map((r) => <Suggestion key={r.candidate.opportunityId} r={r} primary={false} busy={busy} onChoose={choose} />)
          : null}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {alternatives.length > 0
            ? secondary(
                showAlternatives
                  ? "Masquer les alternatives"
                  : `Voir ${alternatives.length === 1 ? "l'alternative" : `les ${alternatives.length} alternatives`}`,
                () => setShowAlternatives((v) => !v),
              )
            : null}
          {secondary("Ignorer cette semaine", () => post({ action: "ignorer", opportunityId: primary.candidate.opportunityId }), true)}
          {secondary("Choisir manuellement", () => setMode("manuel"))}
        </div>
      </div>
    );
  } else {
    body = (
      <div>
        <p className="text-sm text-ink-soft">
          Aucune affaire ne se prête au challenge cette semaine : rien d&apos;actif, de récent et de significatif hors gros dossiers.
        </p>
        <div className="mt-3">{secondary("Choisir manuellement", () => setMode("manuel"))}</div>
      </div>
    );
  }

  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="🎯 Affaire de la semaine"
        title={current ? "Une affaire pour challenger la méthode d'un ET" : "Affaire recommandée de la semaine"}
        aside={
          !current && recommendation && mode !== "manuel"
            ? "RM Morning propose, vous arbitrez."
            : undefined
        }
      />
      <div className="px-4 py-3 md:px-6 md:py-4">
        {body}
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}

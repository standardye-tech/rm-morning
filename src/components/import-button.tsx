"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Outcome =
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string }
  | { kind: "login"; message: string; command: string };

/**
 * Déclenche un import. `source` vaut « api » (synchronisation Salesforce, action
 * principale) ou « file » (relecture du dernier export, fallback).
 */
export function ImportButton({
  label,
  source = "api",
  variant = "primary",
  endpoint = "import",
}: {
  label: string;
  source?: "api" | "file" | "gviz";
  variant?: "primary" | "secondary";
  /** « import » = opportunités Salesforce, « forecast » = snapshots du Sheet. */
  endpoint?: "import" | "forecast" | "leads" | "opportunities";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function run() {
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch(`/api/${endpoint}?source=${source}`, { method: "POST" });
      const payload = await response.json();

      if (response.status === 401 && payload.needsLogin) {
        setOutcome({ kind: "login", message: payload.error, command: payload.loginCommand });
      } else if (response.status === 403 && payload.needsSharing) {
        setOutcome({ kind: "error", message: payload.detail ?? payload.error });
      } else if (!response.ok) {
        setOutcome({ kind: "error", message: payload.error ?? "L'import a échoué." });
      } else {
        const seconds = (payload.durationMs / 1000).toFixed(1).replace(".", ",");
        if (endpoint === "opportunities") {
          setOutcome({
            kind: "ok",
            message:
              `${payload.opportunities} opportunités analysées, ${payload.newExceptions} exceptions nouvelles, ` +
              `${payload.legacyBacklog} en dette — en ${seconds} s.` +
              (payload.degraded.length ? ` ⚠ couverture dégradée : ${payload.degraded.join(", ")}` : ""),
          });
          router.refresh();
          return;
        }
        if (endpoint === "leads") {
          setOutcome({
            kind: "ok",
            message:
              `${payload.totalLeads} pistes importées, ${payload.newExceptions} exceptions nouvelles, ` +
              `${payload.legacyBacklog} en dette héritée — en ${seconds} s.`,
          });
          router.refresh();
          return;
        }
        setOutcome({
          kind: "ok",
          message:
            endpoint === "forecast"
              ? `${payload.totalLines} lignes lues, ${payload.teamLines} pour l'équipe, ` +
                `${payload.snapshotDates.length} snapshots — en ${seconds} s.`
              : `${payload.totalRows} opportunités lues, ${payload.teamRows} pour l'équipe, ` +
                `${payload.activeRows} actives — en ${seconds} s.`,
        });
        router.refresh();
      }
    } catch (cause) {
      setOutcome({
        kind: "error",
        message: cause instanceof Error ? cause.message : "L'import a échoué.",
      });
    } finally {
      setBusy(false);
    }
  }

  const style =
    variant === "primary"
      ? "bg-ink text-white hover:opacity-90"
      : "border border-line-strong bg-surface text-ink-soft hover:text-ink";

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity disabled:opacity-50 ${style}`}
      >
        {busy ? "Synchronisation…" : label}
      </button>

      {outcome?.kind === "ok" ? (
        <span className="text-xs text-positive">{outcome.message}</span>
      ) : null}
      {outcome?.kind === "error" ? (
        <span className="text-xs text-danger">{outcome.message}</span>
      ) : null}
      {outcome?.kind === "login" ? (
        <div className="rounded-lg border border-line bg-canvas px-3 py-2">
          <p className="text-xs font-medium text-warning">{outcome.message}</p>
          <p className="mt-1 text-xs text-ink-soft">
            Lancez cette commande dans un terminal, puis réessayez :
          </p>
          <code className="mt-1 block font-mono text-xs text-ink">{outcome.command}</code>
        </div>
      ) : null}
    </div>
  );
}

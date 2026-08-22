"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Outcome =
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string }
  | { kind: "auth"; message: string };

/** Déclenche une synchronisation Gmail incrémentale. Lecture seule. */
export function GmailSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function run() {
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch("/api/gmail/sync", { method: "POST" });
      const payload = await response.json();

      if (response.status === 401 && payload.needsAuth) {
        setOutcome({ kind: "auth", message: payload.detail ?? payload.error });
      } else if (!response.ok) {
        setOutcome({ kind: "error", message: payload.error ?? "La synchronisation a échoué." });
      } else {
        const seconds = (payload.durationMs / 1000).toFixed(1).replace(".", ",");
        const nouveaux =
          payload.duplicates > 0 ? `, ${payload.duplicates} déjà connus` : "";
        setOutcome({
          kind: "ok",
          message:
            `${payload.seen} messages vus, ${payload.excluded} écartés, ${payload.kept} conservés ` +
            `(A ${payload.matchedCertain} · B ${payload.matchedProbable} · C ${payload.matchedUncertain})` +
            `${nouveaux} — en ${seconds} s.`,
        });
        router.refresh();
      }
    } catch (cause) {
      setOutcome({
        kind: "error",
        message: cause instanceof Error ? cause.message : "La synchronisation a échoué.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-lg bg-ink px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Synchronisation…" : "Synchroniser Gmail"}
      </button>

      {outcome?.kind === "ok" ? (
        <span className="text-xs text-positive">{outcome.message}</span>
      ) : null}
      {outcome?.kind === "error" ? (
        <span className="text-xs text-danger">{outcome.message}</span>
      ) : null}
      {outcome?.kind === "auth" ? (
        <span className="text-xs text-warning">{outcome.message}</span>
      ) : null}
    </div>
  );
}

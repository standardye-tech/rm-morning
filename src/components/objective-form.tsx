"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Saisie de l'objectif mensuel de la Région.
 *
 * Une ligne par mois (M à M+3) : un montant en euros, un bouton. Aucun objectif
 * par défaut : une ligne vide se lit « non renseigné », et les écrans qui en
 * dépendent (Construire M+1) n'inventent alors ni couverture ni déficit.
 */

export type ObjectiveRow = {
  month: string;
  label: string;
  amount: number | null;
  updatedAt: string | null;
};

const eur = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

export function ObjectiveForm({ rows }: { rows: ObjectiveRow[] }) {
  const router = useRouter();
  const [current, setCurrent] = useState(rows);
  const [drafts, setDrafts] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((r) => [r.month, r.amount == null ? "" : String(Math.round(r.amount))])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", month: string, amount?: string) {
    setBusy(month);
    setError(null);
    try {
      const res = await fetch("/api/objective", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "POST" ? { month, amount } : { month }),
      });
      const data = (await res.json()) as { error?: string; objectives?: { month: string; amount: number; updatedAt: string }[] };
      if (!res.ok || data.error) throw new Error(data.error ?? "Enregistrement impossible.");
      const byMonth = new Map((data.objectives ?? []).map((o) => [o.month, o]));
      setCurrent((rs) =>
        rs.map((r) => ({ ...r, amount: byMonth.get(r.month)?.amount ?? null, updatedAt: byMonth.get(r.month)?.updatedAt ?? null })),
      );
      if (method === "DELETE") setDrafts((d) => ({ ...d, [month]: "" }));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <ul className="divide-y divide-line">
        {current.map((r) => (
          <li key={r.month} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <span className="w-32 text-sm font-medium capitalize">{r.label}</span>
            <span className={`w-44 text-xs ${r.amount == null ? "text-ink-faint" : "text-ink-soft"}`}>
              {r.amount == null ? "Objectif non renseigné" : `Objectif ${eur(r.amount)}`}
            </span>
            <input
              inputMode="numeric"
              aria-label={`Objectif ${r.label}, en euros`}
              placeholder="Montant en €"
              value={drafts[r.month] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [r.month]: e.target.value }))}
              className="tabular w-36 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm"
            />
            <button
              type="button"
              disabled={busy === r.month || !(drafts[r.month] ?? "").trim()}
              onClick={() => call("POST", r.month, drafts[r.month])}
              className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-40"
            >
              Enregistrer
            </button>
            {r.amount != null ? (
              <button
                type="button"
                disabled={busy === r.month}
                onClick={() => call("DELETE", r.month)}
                className="text-xs text-ink-faint underline decoration-dotted hover:text-ink"
              >
                Retirer
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

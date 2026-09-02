"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Gestion du périmètre commercial RM Morning.
 *
 * Volontairement minuscule : une liste, une croix par ligne, un menu déroulant
 * pour ajouter. Ce n'est pas un écran RH — c'est le réglage du périmètre, et il
 * vit là où vivent les autres réglages de données.
 *
 * L'ajout se fait par CHOIX, jamais par saisie : les noms proposés sont ceux
 * réellement rencontrés dans Salesforce et dans le classeur Perspective, ce qui
 * évite d'un coup les fautes, les accents, la casse et les doublons.
 */

export type TeamMemberView = {
  key: string;
  name: string;
  firstName: string;
  territory?: "idf";
  active: boolean;
};

export type CandidateView = {
  key: string;
  name: string;
  sources: string[];
  known: boolean;
};

export function TeamScope({
  members,
  candidates,
}: {
  members: TeamMemberView[];
  candidates: CandidateView[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState("");
  /*
    La liste est tenue localement à partir de la RÉPONSE de l'API, et pas
    seulement du rendu serveur. L'écran Données sonde Salesforce, Gmail et
    Google Sheets à chaque rendu : attendre `router.refresh()` laissait
    plusieurs secondes pendant lesquelles un commercial retiré restait affiché,
    et on ne savait pas si le clic avait été pris en compte.
  */
  const [current, setCurrent] = useState(members);

  const active = current.filter((m) => m.active);
  const removed = current.filter((m) => !m.active);
  // Un nom déjà actif n'a pas à être reproposé ; un nom retiré, si — c'est ainsi
  // qu'on réintègre quelqu'un sans rien ressaisir.
  const activeKeys = new Set(active.map((m) => m.key));
  const options = [
    ...removed.map((m) => ({ key: m.key, name: m.name, note: "précédemment retiré" })),
    ...candidates
      .filter((c) => !activeKeys.has(c.key) && !removed.some((m) => m.key === c.key))
      .map((c) => ({ key: c.key, name: c.name, note: c.sources.join(", ") })),
  ];

  async function call(method: "POST" | "DELETE", body: object, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const response = await fetch("/api/team", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) setError(payload.error ?? "L'opération a échoué.");
      else {
        setCurrent(payload.members as TeamMemberView[]);
        setChoice("");
        setAdding(false);
        // Le reste de la page — compteurs, fraîcheur — se remet à jour ensuite.
        router.refresh();
      }
    } catch {
      setError("Le serveur n'a pas répondu.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line">
        {active.map((member) => (
          <li key={member.key} className="flex items-center justify-between gap-3 py-1.5">
            <span className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="text-positive" aria-hidden>
                ✓
              </span>
              <span className="truncate">{member.name}</span>
              {member.territory === "idf" ? (
                <span className="shrink-0 text-xs text-ink-faint">Île-de-France seule</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => call("DELETE", { key: member.key }, member.key)}
              disabled={busy !== null}
              className="shrink-0 rounded px-2 py-0.5 text-xs text-ink-faint hover:bg-canvas hover:text-danger disabled:opacity-50"
              aria-label={`Retirer ${member.name} du périmètre`}
            >
              Retirer
            </button>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          >
            <option value="">Choisir un commercial…</option>
            {options.map((o) => (
              <option key={o.key} value={o.name}>
                {o.name}
                {o.note ? ` — ${o.note}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!choice || busy !== null}
            onClick={() => call("POST", { name: choice }, "add")}
            className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-faint"
          >
            {busy === "add" ? "Ajout…" : "Ajouter"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setChoice("");
            }}
            className="rounded-md px-2 py-1.5 text-sm text-ink-faint hover:text-ink"
          >
            Annuler
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-canvas"
        >
          + Ajouter un commercial
        </button>
      )}

      {options.length === 0 && adding ? (
        <p className="text-xs text-ink-faint">
          Aucun autre commercial connu pour l&apos;instant. La liste se remplit à chaque
          actualisation, avec les noms vus dans Salesforce et dans le classeur Perspective.
        </p>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <p className="text-xs text-ink-faint">
        Ce périmètre commande Salesforce, Perspective, Forecast, Performance et les analyses.
        Retirer un commercial ne supprime aucune donnée : elle est seulement mise de côté, et
        réapparaît si on le réajoute. Le changement s&apos;applique à la prochaine actualisation.
      </p>
    </div>
  );
}

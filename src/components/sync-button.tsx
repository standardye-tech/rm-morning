"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  RUN_STATUS_LABEL,
  STEP_GROUP,
  SYNC_GROUPS,
  humanDuration,
  humanTime,
  type StepStatus,
  type SyncGroup,
  type SyncStatus,
} from "@/lib/sync/labels";

/**
 * Le bouton unique d'actualisation.
 *
 * Point d'entrée unique de l'application : il vit dans le header, pas dans chaque
 * page. L'utilisateur n'a rien à savoir de l'ordre des étapes ni des commandes
 * sous-jacentes — il clique, il attend, il lit le résultat.
 *
 * Interrogation simple, une fois par seconde pendant l'actualisation. Pas de
 * websocket : la durée se compte en dizaines de secondes et l'écran n'a besoin
 * que d'un état grossier.
 */

type Step = {
  key: string;
  label: string;
  blocking: boolean;
  status: StepStatus;
  durationMs: number | null;
  detail: string | null;
  error: string | null;
};

type Run = {
  id: number;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  currentStep: string | null;
  durationMs: number | null;
  error: string | null;
  warnings: string[];
  steps: Step[];
};

export type SyncSnapshot = { active: number | null; run: Run | null; lastComplete: Run | null };
type Payload = SyncSnapshot;

/** État d'un groupe : celui de la plus « avancée en gravité » de ses étapes. */
function groupStatus(steps: Step[], group: SyncGroup): StepStatus | null {
  const own = steps.filter((s) => STEP_GROUP[s.key] === group);
  if (own.length === 0) return null;
  if (own.some((s) => s.status === "failed")) return "failed";
  if (own.some((s) => s.status === "running")) return "running";
  if (own.every((s) => s.status === "skipped")) return "skipped";
  if (own.some((s) => s.status === "pending")) return "pending";
  if (own.some((s) => s.status === "warning")) return "warning";
  return "success";
}

const MARK: Record<StepStatus, string> = {
  pending: "·",
  running: "…",
  success: "✓",
  warning: "!",
  skipped: "–",
  failed: "✕",
};

const TONE: Record<StepStatus, string> = {
  pending: "text-ink-faint",
  running: "text-ink",
  success: "text-positive",
  warning: "text-warning",
  skipped: "text-ink-faint",
  failed: "text-danger",
};

/**
 * L'état initial vient du rendu serveur, pas d'une requête au montage : le header
 * est présent sur toutes les pages, et interroger l'API à chaque navigation pour
 * afficher une heure serait du gaspillage. On n'interroge que pendant une
 * actualisation.
 */
export function SyncButton({ initial }: { initial: Payload }) {
  const router = useRouter();
  const [payload, setPayload] = useState<Payload>(initial);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sync", { cache: "no-store" });
      if (r.ok) setPayload((await r.json()) as Payload);
    } catch {
      // Le serveur redémarre parfois en développement : réessayer au prochain tour.
    }
  }, []);

  const run = payload.run;
  const running = payload.active != null;

  // Interrogation pendant l'actualisation seulement : inutile de solliciter le
  // serveur en permanence quand rien ne se passe.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [running, load]);

  // Rafraîchissement des pages à la fin, sans F5 : les écrans sont rendus côté
  // serveur, un simple refresh du routeur les reconstruit sur le nouvel état.
  // On ne pose aucun état ici — seule une référence est mutée, puis le routeur
  // rafraîchi : c'est le seul effet de bord légitime de ce composant.
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      return;
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      router.refresh();
    }
  }, [running, router]);

  async function start() {
    setStarting(true);
    setMessage(null);
    try {
      const r = await fetch("/api/sync", { method: "POST" });
      const body = await r.json();
      if (r.status === 409) setMessage("Une actualisation est déjà en cours.");
      else if (!r.ok) setMessage(body.error ?? "L'actualisation n'a pas pu démarrer.");
      await load();
    } catch {
      setMessage("Le serveur n'a pas répondu.");
    } finally {
      setStarting(false);
    }
  }

  const last = payload.lastComplete;
  const disabled = starting || running;

  return (
    <div className="relative flex shrink-0 items-center gap-3">
      <div className="hidden text-right text-xs leading-tight text-ink-faint xl:block">
        {running ? (
          <span className="text-ink-soft">Actualisation en cours…</span>
        ) : run == null ? (
          <span>Jamais actualisé</span>
        ) : run.status === "failed" ? (
          // Après un échec, les deux informations comptent : ce qui reste valide à
          // l'écran, et le fait que la dernière tentative n'a pas abouti.
          <>
            <span className="block text-danger">
              Dernière tentative : échec à {humanTime(run.completedAt)}
            </span>
            <span className="block">
              Dernière actualisation complète : {humanTime(last?.completedAt)}
            </span>
          </>
        ) : run.status === "warning" ? (
          <>
            <span className="block text-warning">
              Actualisation partielle — {humanTime(run.completedAt)}
            </span>
            <span className="block">{run.warnings[0] ?? ""}</span>
          </>
        ) : (
          <>
            <span className="block text-ink-soft">
              RM Morning est à jour — {humanTime(run.completedAt)}
            </span>
            <span className="block">Actualisé en {humanDuration(run.durationMs)}</span>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={start}
        disabled={disabled}
        className={`h-10 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors lg:h-auto lg:py-1.5 ${
          disabled
            ? "cursor-not-allowed bg-canvas text-ink-faint"
            : "bg-ink text-surface hover:opacity-90"
        }`}
      >
        {/*
          Le libellé complet nomme l'application parce que, sur le bureau, le
          bouton voisine six onglets. Sur mobile il est seul dans sa rangée :
          « Actualiser » suffit, et « Actualiser RM Morning » ne tenait pas.
        */}
        <span className="lg:hidden">{running ? "Actualisation…" : "Actualiser"}</span>
        <span className="hidden lg:inline">
          {running ? "Actualisation…" : "Actualiser RM Morning"}
        </span>
      </button>

      {/*
        Panneau d'avancement. Visible pendant l'actualisation, et conservé après
        coup lorsqu'il y a quelque chose à dire — un échec ou un avertissement ne
        doit pas disparaître avant d'avoir été lu.
      */}
      {run && (running || run.status === "failed" || run.status === "warning") ? (
        <div className="absolute right-0 top-full z-20 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-4 shadow-lg">
          <p className="text-sm font-medium">
            {RUN_STATUS_LABEL[run.status]}
            {run.status === "success" ? ` — ${humanTime(run.completedAt)}` : ""}
          </p>
          {run.durationMs != null ? (
            <p className="mt-0.5 text-xs text-ink-faint">
              Actualisé en {humanDuration(run.durationMs)}
            </p>
          ) : null}

          <ul className="mt-3 space-y-1">
            {SYNC_GROUPS.map((group) => {
              const status = groupStatus(run.steps, group);
              if (status == null) return null;
              return (
                <li key={group} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className={status === "pending" ? "text-ink-faint" : "text-ink-soft"}>
                    {group}
                  </span>
                  <span className={`font-medium ${TONE[status]}`} aria-hidden>
                    {MARK[status]}
                  </span>
                </li>
              );
            })}
          </ul>

          {run.status === "failed" ? (
            <p className="mt-3 border-t border-line pt-2 text-xs text-danger">
              {run.error ?? "Étape indispensable en échec."} Les dernières données valides restent
              affichées.
            </p>
          ) : null}
          {run.warnings.length > 0 ? (
            <ul className="mt-3 space-y-1 border-t border-line pt-2">
              {run.warnings.map((w, i) => (
                <li key={i} className="text-xs text-warning">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <div className="absolute right-0 top-full z-20 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-3 text-xs text-ink-soft shadow-lg">
          {message}
        </div>
      ) : null}
    </div>
  );
}

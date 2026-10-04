"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { FieldChange, MonitoringScope, ReadVerdict } from "@/lib/monitoring-read";
import { markReadLabel } from "@/lib/monitoring-wording";
import { formatEurShort, formatFrenchDate } from "@/lib/normalize";

/**
 * Le geste « Tout lire », et la façon de montrer ce qui a bougé depuis.
 *
 * Composant client pour une seule raison : le geste doit se voir aussitôt.
 * `router.refresh()` recharge la page côté serveur — les listes se
 * reconstruisent avec l'état de lecture qui vient d'être écrit : mêmes lignes,
 * marquées lues, compteurs de non-lus à zéro.
 */

const MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

/** Une valeur suivie, telle qu'on la lit — jamais une chaîne technique. */
function formatValue(value: string | null, kind: FieldChange["kind"]): string {
  if (value == null || value === "") return "—";
  switch (kind) {
    case "date":
      return formatFrenchDate(value.slice(0, 10)) ?? value;
    case "mois": {
      const [y, m] = value.split("-");
      return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : value;
    }
    case "euros":
      return formatEurShort(Number(value));
    default:
      return value;
  }
}

/**
 * Ce qui a changé, et rien d'autre.
 *
 * La carte entière n'est pas surlignée : ce serait dire « tout est nouveau »
 * alors qu'un seul champ a bougé, et l'œil ne saurait pas où regarder. Seule la
 * NOUVELLE valeur est mise en évidence ; l'ancienne reste lisible à côté, barrée,
 * parce que le glissement lui-même est l'information — passer du 15 au 30 n'a
 * pas le même sens que d'avoir toujours été au 30.
 */
export function ChangeLine({ verdict }: { verdict: ReadVerdict }) {
  if (verdict.status !== "modifie" || verdict.changes.length === 0) return null;
  return (
    <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-faint">
      <span>Depuis votre lecture :</span>
      {verdict.changes.map((c) => (
        <span key={c.label} className="inline-flex items-baseline gap-1.5">
          <span className="text-ink-soft">{c.label}</span>
          <span className="text-ink-faint line-through">{formatValue(c.before, c.kind)}</span>
          <span aria-hidden>→</span>
          <span className="rounded bg-change-soft px-1.5 py-0.5 font-medium text-change">
            {formatValue(c.after, c.kind)}
          </span>
        </span>
      ))}
    </p>
  );
}

export function ToutLireButton({
  scope,
  owner,
  count,
}: {
  scope: MonitoringScope;
  owner: string | null;
  /**
   * Éléments RESTANT à lire. Zéro = le bouton disparaît.
   *
   * Ce n'est pas le nombre d'éléments que le geste acquittera — il en réécrit
   * aussi la signature de ceux déjà lus, ce qui est sans effet visible. Un
   * bouton doit annoncer ce qu'il change pour l'utilisateur, pas ce qu'il écrit
   * en base : « Marquer les 54 comme lues » à côté de « 0 à traiter » serait un
   * contresens. Ce nombre peut différer du nombre d'actions ouvertes.
   */
  count: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  if (count === 0) return null;

  return (
    <button
      type="button"
      disabled={pending || sent}
      onClick={() => {
        setSent(true);
        start(async () => {
          await fetch("/api/monitoring", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "tout_lire", scope, owner }),
          });
          // La liste se vide côté serveur : on relit la page plutôt que de la
          // masquer localement, pour que l'écran affiché soit exactement l'état
          // enregistré — et non une illusion qui disparaîtrait au rechargement.
          router.refresh();
          setSent(false);
        });
      }}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50 md:min-h-0"
    >
      {pending || sent ? "Lecture…" : markReadLabel(count)}
    </button>
  );
}

/**
 * Lecture d'une seule ligne.
 *
 * Jusqu'ici, « Tout lire » était le seul geste possible : impossible d'acquitter
 * une piste ou une opportunité sans acquitter tout le périmètre avec elle. Ce
 * bouton porte sur l'identifiant de la ligne seule ; les autres restent
 * inchangées, lues ou non.
 */
export function LireButton({ scope, itemId }: { scope: MonitoringScope; itemId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  return (
    <button
      type="button"
      disabled={pending || sent}
      onClick={() => {
        setSent(true);
        start(async () => {
          await fetch("/api/monitoring", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "lire", scope, itemId }),
          });
          // Même logique que « Tout lire » : on relit la page côté serveur
          // plutôt que de masquer la ligne localement.
          router.refresh();
          setSent(false);
        });
      }}
      className="inline-flex h-7 shrink-0 items-center rounded border border-line px-2 text-xs text-ink-soft transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50"
    >
      {pending || sent ? "…" : "Lu"}
    </button>
  );
}

/**
 * « Lu » tant que la ligne n'est pas lue ; ensuite une simple marque « Lue » :
 * la ligne reste affichée tant que son action est ouverte (Lu ≠ Traité).
 */
export function ReadMark({ scope, itemId, verdict }: { scope: MonitoringScope; itemId: string; verdict: ReadVerdict }) {
  if (verdict.status === "lu") return <span className="text-xs text-ink-faint">Lue</span>;
  return <LireButton scope={scope} itemId={itemId} />;
}

/**
 * « Traité » : l'action de la ligne est gérée — distinct de « Lu ».
 *
 * « Lu » acquitte une notification (la ligne revient si un champ bouge) ;
 * « Traité » ferme l'action elle-même dans l'état partagé de RM Morning : elle
 * disparaît aussi du Morning et de Ma semaine quand ils montrent la même. Un
 * nouvel événement (nouveau message, nouvelle échéance) la fera revenir.
 */
export function TraiteButton({ scope, itemId }: { scope: MonitoringScope; itemId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  return (
    <button
      type="button"
      disabled={pending || sent}
      title="Action gérée : elle disparaît de toutes les surfaces de RM Morning"
      onClick={() => {
        setSent(true);
        start(async () => {
          await fetch("/api/monitoring", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "traiter", scope, itemId }),
          });
          router.refresh();
          setSent(false);
        });
      }}
      className="inline-flex h-7 shrink-0 items-center rounded border border-line px-2 text-xs text-ink-soft transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50"
    >
      {pending || sent ? "…" : "Traité"}
    </button>
  );
}

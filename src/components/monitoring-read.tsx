"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { FieldChange, MonitoringScope, ReadVerdict } from "@/lib/monitoring-read";
import { formatEurShort, formatFrenchDate } from "@/lib/normalize";

/**
 * Le geste « Tout lire », et la façon de montrer ce qui a bougé depuis.
 *
 * Composant client pour une seule raison : le bouton doit vider la liste sous
 * les yeux de l'utilisateur. `router.refresh()` recharge la page côté serveur —
 * les listes se reconstruisent avec l'état de lecture qui vient d'être écrit, et
 * l'écran passe au message « Tout est traité » sans navigation.
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
   * en base : « Tout lire (54) » à côté de « 0 à traiter » serait un contresens.
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
      {pending || sent ? "Lecture…" : `Tout lire (${count})`}
    </button>
  );
}

/**
 * L'état « rien à traiter ».
 *
 * Le point du Lot A : le travail du Monitoring ne se termine jamais tout seul,
 * il faut donc que RM Morning sache dire qu'il est fait. Le message rappelle ce
 * qui a été lu et quand, pour que « vide » ne se confonde jamais avec « en
 * panne » ou « pas encore chargé ».
 */
export function AllHandled({
  readCount,
  lastReadAt,
  what,
}: {
  readCount: number;
  lastReadAt: string | null;
  what: string;
}) {
  return (
    <div className="px-4 py-8 text-center md:px-6">
      {/*
        Une marque, pas une bannière. Le travail du Monitoring ne se termine
        jamais de lui-même : atteindre zéro mérite d'être vu de loin, et une
        ligne de texte vert se confondait avec un état vide ordinaire. Le ✓ est
        celui que Morning emploie déjà pour « traité » et « fait » ; la pastille
        reprend le rond des numéros du plan du jour. Rien de plus : un bandeau
        pleine largeur ferait de l'absence de travail l'élément le plus lourd
        de l'écran.
      */}
      <span
        aria-hidden
        className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-positive-soft text-sm text-positive"
      >
        ✓
      </span>
      <p className="text-[15px] font-medium text-positive">Tout est traité.</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-ink-faint">
        {readCount > 0
          ? `${readCount} ${what} lue(s)`
          : `Aucune ${what.replace(/s$/, "")} en anomalie`}
        {lastReadAt
          ? ` · dernière lecture le ${new Date(lastReadAt).toLocaleString("fr-FR", {
              dateStyle: "short",
              timeStyle: "short",
            })}`
          : ""}
        . Elles reviendront ici si une information change.
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Le tableau du classement, triable.
 *
 * COMPOSANT CLIENT pour une seule raison : trier ne doit rien demander au
 * serveur. Les treize lignes sont déjà là, et « qui est le meilleur en
 * Pistes ? » doit se répondre en un clic, pas en un aller-retour réseau et un
 * rechargement de page qui perdrait la position de lecture.
 *
 * LE RANG NE SE RENUMÉROTE JAMAIS. Il est transmis avec la ligne et affiché tel
 * quel : trier par Pipeline peut donc mettre en tête un commercial classé 5e.
 * C'est voulu — la colonne Rang répond à « où est-il au classement », le tri
 * répond à « qui est le meilleur sur ce critère ». Renuméroter mélangerait les
 * deux questions et ferait croire à un second classement.
 */

/** Ligne aplatie : tout ce que le tableau affiche, et rien de plus. */
export type PerformanceTableRow = {
  rank: number;
  salesperson: string;
  score: number;
  signed: number;
  leads: number;
  deals: number;
  pipeline: number;
  /** Momentum de la fenêtre récente. Nul si la trajectoire n'est pas mesurable. */
  momentum: number | null;
  /** Écart de production entre les deux fenêtres, en points. */
  delta: number | null;
  rankChange: number | null;
};

type SortKey = keyof Omit<PerformanceTableRow, "salesperson"> | "salesperson";

const COLUMNS: {
  key: SortKey;
  label: string;
  align: "left" | "right";
  width: string;
  /** Sens du premier clic. Une métrique se lit du meilleur au moins bon. */
  firstDirection: "asc" | "desc";
  title?: string;
}[] = [
  { key: "rank", label: "Rang", align: "left", width: "w-14", firstDirection: "asc" },
  { key: "salesperson", label: "Commercial", align: "left", width: "", firstDirection: "asc" },
  { key: "score", label: "Score YTD", align: "right", width: "w-24", firstDirection: "desc" },
  { key: "signed", label: "Signé", align: "right", width: "w-16", firstDirection: "desc" },
  { key: "leads", label: "Pistes", align: "right", width: "w-16", firstDirection: "desc" },
  { key: "deals", label: "Opps", align: "right", width: "w-16", firstDirection: "desc" },
  { key: "pipeline", label: "Pipeline", align: "right", width: "w-20", firstDirection: "desc" },
  {
    key: "momentum",
    label: "Momentum 3 mois",
    align: "right",
    width: "w-28",
    firstDirection: "desc",
    title: "Production signée des 3 derniers mois clôturés, sur 100",
  },
  {
    key: "delta",
    label: "Dynamique",
    align: "right",
    width: "w-24",
    firstDirection: "desc",
    title: "Écart avec les 3 mois précédents, en points",
  },
  {
    key: "rankChange",
    label: "Évol. rang",
    align: "right",
    width: "w-24",
    firstDirection: "desc",
    title: "Places gagnées depuis la photo précédente du même modèle",
  },
];

function scoreTone(value: number): string {
  if (value >= 70) return "text-positive";
  if (value >= 45) return "text-ink";
  return "text-warning";
}

function Trend({ change }: { change: number | null }) {
  if (change == null) return <span className="text-xs text-ink-faint">nouveau</span>;
  if (change === 0) return <span className="text-xs text-ink-faint">=</span>;
  const up = change > 0;
  return (
    <span className={`text-xs font-medium ${up ? "text-positive" : "text-warning"}`}>
      {up ? "↑" : "↓"} {Math.abs(change)}
    </span>
  );
}

function Dynamic({ delta, seuil }: { delta: number | null; seuil: number }) {
  if (delta == null) return <span className="text-xs text-ink-faint">—</span>;
  if (Math.abs(delta) < seuil) return <span className="text-xs text-ink-faint">Stable</span>;
  const up = delta > 0;
  return (
    <span className={`tabular text-xs font-medium ${up ? "text-positive" : "text-warning"}`}>
      {up ? "+" : "−"}
      {Math.abs(delta).toFixed(0)}
    </span>
  );
}

export function PerformanceTable({
  rows,
  selected,
  seuil,
}: {
  rows: PerformanceTableRow[];
  selected: string | null;
  seuil: number;
}) {
  // Tri initial : le classement naturel, c'est-à-dire le rang. Trier sur le rang
  // plutôt que sur le score donne exactement le même ordre tout en conservant
  // les égalités déjà départagées par le moteur.
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "rank",
    direction: "asc",
  });

  const column = COLUMNS.find((c) => c.key === sort.key)!;
  const sorted = [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    // Une valeur absente se range toujours en dernier, quel que soit le sens :
    // « pas de tendance » n'est ni la meilleure ni la pire des performances.
    if (x == null && y == null) return a.salesperson.localeCompare(b.salesperson, "fr");
    if (x == null) return 1;
    if (y == null) return -1;
    const cmp =
      typeof x === "string" && typeof y === "string"
        ? x.localeCompare(y, "fr")
        : Number(x) - Number(y);
    // À égalité, l'ordre du classement tranche : le tableau ne doit jamais
    // changer d'aspect entre deux affichages des mêmes données.
    return (sort.direction === "asc" ? cmp : -cmp) || a.rank - b.rank;
  });

  const onSort = (key: SortKey) => {
    const def = COLUMNS.find((c) => c.key === key)!.firstDirection;
    setSort((s) =>
      s.key === key
        ? { key, direction: s.direction === "asc" ? "desc" : "asc" }
        : { key, direction: def },
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[60rem] text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-faint">
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={`${c.width} px-3 py-2 font-medium ${
                    c.align === "right" ? "text-right" : "text-left"
                  } ${c.key === "rank" ? "pl-4 md:pl-6" : ""} ${
                    c.key === "rankChange" ? "pr-4 md:pr-6" : ""
                  }`}
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSort(c.key)}
                    title={c.title ?? `Trier par ${c.label}`}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-ink ${
                      active ? "text-ink" : ""
                    }`}
                  >
                    {c.label}
                    {/*
                      La direction n'apparaît que sur la colonne active. Un
                      chevron sur les dix en-têtes ferait dix invitations
                      simultanées et n'indiquerait plus rien.
                    */}
                    <span aria-hidden className={active ? "" : "invisible"}>
                      {sort.direction === "asc" ? "↑" : "↓"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.salesperson}
              className={`border-b border-line/70 last:border-0 ${
                selected === row.salesperson ? "bg-canvas" : "hover:bg-canvas/60"
              }`}
            >
              <td className="tabular px-3 py-2 pl-4 font-semibold md:pl-6">{row.rank}</td>
              <td className="px-3 py-2">
                <Link
                  href={
                    selected === row.salesperson
                      ? "/performance"
                      : `/performance?commercial=${encodeURIComponent(row.salesperson)}`
                  }
                  className="font-medium underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  {row.salesperson}
                </Link>
              </td>
              <td className={`tabular px-3 py-2 text-right font-semibold ${scoreTone(row.score)}`}>
                {row.score.toFixed(0)}
                <span className="text-xs font-normal text-ink-faint">/100</span>
              </td>
              <td className="tabular px-3 py-2 text-right text-ink-soft">{row.signed}</td>
              <td className="tabular px-3 py-2 text-right text-ink-soft">{row.leads}</td>
              <td className="tabular px-3 py-2 text-right text-ink-soft">{row.deals}</td>
              <td className="tabular px-3 py-2 text-right text-ink-soft">{row.pipeline}</td>
              <td className="tabular px-3 py-2 text-right text-ink-soft">
                {row.momentum == null ? "—" : row.momentum.toFixed(0)}
              </td>
              <td className="px-3 py-2 text-right">
                <Dynamic delta={row.delta} seuil={seuil} />
              </td>
              <td className="px-3 py-2 pr-4 text-right md:pr-6">
                <Trend change={row.rankChange} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

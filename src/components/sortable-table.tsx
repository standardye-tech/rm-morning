"use client";

import { useState, type ReactNode } from "react";

/**
 * Tableau triable par en-tête (lot de simplification, D).
 *
 * Les cellules arrivent déjà rendues par le composant serveur — liens,
 * pastilles, mises en forme restent intacts — avec, à côté, la VALEUR de tri de
 * chaque colonne : un nombre trie numériquement (vide en dernier), un texte
 * alphabétiquement (ordre français). Premier clic : décroissant pour un
 * nombre, croissant pour un texte ; second clic : l'inverse. Sans clic, l'ordre
 * reçu du serveur est conservé.
 */

export type SortableColumn = {
  label: ReactNode;
  type: "number" | "text";
  align?: "left" | "right";
  className?: string;
};

export type SortableRow = {
  key: string;
  cells: ReactNode[];
  /** Une valeur par colonne ; `null` = vide, toujours en dernier. */
  sort: (number | string | null)[];
};

type Sort = { column: number; direction: "asc" | "desc" } | null;

export function SortableTable({
  columns,
  rows,
  className = "w-full text-sm",
}: {
  columns: SortableColumn[];
  rows: SortableRow[];
  className?: string;
}) {
  const [sort, setSort] = useState<Sort>(null);

  const sorted = sort == null ? rows : [...rows].sort((a, b) => compare(a.sort[sort.column], b.sort[sort.column], sort.direction));

  const toggle = (column: number) =>
    setSort((cur) =>
      cur?.column === column
        ? { column, direction: cur.direction === "asc" ? "desc" : "asc" }
        : { column, direction: columns[column].type === "number" ? "desc" : "asc" },
    );

  return (
    <table className={className}>
      <thead>
        <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
          {columns.map((c, i) => {
            const active = sort?.column === i;
            return (
              <th
                key={i}
                scope="col"
                aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : "none"}
                className={`py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.className ?? "px-3"}`}
              >
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink ${active ? "text-ink" : ""}`}
                  title={`Trier par ${typeof c.label === "string" ? c.label.toLowerCase() : "cette colonne"}`}
                >
                  {c.label}
                  <span aria-hidden className={`text-[10px] ${active ? "" : "opacity-0"}`}>
                    {active && sort!.direction === "asc" ? "▲" : "▼"}
                  </span>
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.key} className="border-b border-line last:border-0">
            {r.cells}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Tri stable : vides en dernier quel que soit le sens. */
export function compare(a: number | string | null, b: number | string | null, direction: "asc" | "desc"): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const d =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "fr", { sensitivity: "base", numeric: true });
  return direction === "asc" ? d : -d;
}

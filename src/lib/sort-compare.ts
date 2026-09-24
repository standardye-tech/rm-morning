/**
 * Comparaison de tri des tableaux (lot de simplification, D) — pure, partagée
 * par le composant `SortableTable` et ses contrôles.
 *
 * Un nombre trie numériquement, un texte en ordre français (accents et casse
 * ignorés, chiffres dans l'ordre naturel). Les valeurs vides vont TOUJOURS en
 * dernier, quel que soit le sens.
 */
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

/**
 * Planning recommandé — « Ma semaine ».
 *
 * Ce n'est PAS un agenda : c'est l'affectation des interventions recommandées
 * aux créneaux-types que le directeur régional a réservés dans son agenda
 * (`WEEK_SLOTS`). Google Calendar reste la source de vérité de la semaine.
 *
 * PUR. Deux passes, et l'ordre compte :
 *   1. chaque créneau reçoit le meilleur élément de SON type ;
 *   2. les créneaux réaffectables restés vides prennent, dans l'ordre de
 *      `WEEK_FALLBACK_ORDER`, ce qui reste : ET rouge, gros dossier urgent,
 *      affaire de la semaine, ET orange, candidatures.
 * Sans la première passe, le créneau ET du lundi absorberait l'affaire de la
 * semaine et celui du jeudi resterait vide.
 *
 * Un créneau sans candidat est affiché DISPONIBLE. C'est un résultat, pas un
 * échec : l'application optimise le temps, elle ne le remplit pas.
 */

import {
  WEEK_FALLBACK_ORDER,
  WEEK_REASSIGNABLE,
  type WeekSlot,
  type WeekSlotKind,
} from "./config";
import type { Recommendation } from "./attention";

export type WeekItemKind = WeekSlotKind;

export type WeekItem = {
  /** Identifiant stable : « et:Anthony Ramaherison », « deal:0068… ». */
  key: string;
  kind: WeekItemKind;
  urgent: boolean;
  /** Classement à l'intérieur du type : plus haut = passe avant. */
  score: number;
  title: string;
  /** Avec qui. */
  who: string;
  /** Pourquoi, en une ligne. */
  reason: string;
  recommendation: Recommendation;
  href: string | null;
};

export type PlannedSlot = {
  day: WeekSlot["day"];
  dayLabel: string;
  time: string;
  kind: WeekSlotKind;
  kindLabel: string;
  item: WeekItem | null;
  /** Le créneau porte un élément d'un autre type que le sien. */
  reassigned: boolean;
  /** Créneau fixe (sourcing) : texte d'accompagnement, pas d'élément. */
  note: string | null;
  /** Créneau disponible : ce que RM Morning propose d'en faire, ou rien. */
  suggestion: string | null;
};

export const DAY_LABEL: Record<WeekSlot["day"], string> = {
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
};

export const KIND_LABEL: Record<WeekSlotKind, string> = {
  et_rouge: "ET prioritaire",
  et_orange: "ET Orange",
  gros_dossier: "Gros dossier",
  affaire_semaine: "Affaire de la semaine",
  candidatures: "Candidatures",
  entretiens: "Entretiens",
  sourcing_et: "Sourcing ET",
  sourcing_archi: "Sourcing Archis",
};

/** Ce qu'on affiche quand le type du créneau n'a aucun candidat. */
export const EMPTY_LABEL: Record<WeekSlotKind, string> = {
  et_rouge: "Aucun ET ne nécessite d'intervention prioritaire.",
  et_orange: "Aucun autre ET ne nécessite de point ciblé.",
  gros_dossier: "Aucun gros dossier à traiter.",
  affaire_semaine: "Aucune affaire de la semaine sélectionnée.",
  candidatures: "Aucune candidature à traiter.",
  entretiens: "Aucun entretien prévu.",
  sourcing_et: "Aucun contact ET en attente dans le radar : prospection libre.",
  sourcing_archi: "Aucun contact architecte en attente dans le radar : prospection libre.",
};

/**
 * Ordre du bloc « À traiter cette semaine » : ET rouge, gros dossier urgent,
 * affaire de la semaine, ET orange, candidatures et entretiens. Le sourcing
 * n'y figure pas (rien à traiter, seulement à mener), ni les gros dossiers non
 * urgents, qui restent dans leur bloc et servent de suggestion de repli.
 */
export function actionRank(item: WeekItem): number {
  switch (item.kind) {
    case "et_rouge":
      return 1;
    case "gros_dossier":
      return item.urgent ? 2 : 9;
    case "affaire_semaine":
      return 3;
    case "et_orange":
      return 4;
    case "candidatures":
    case "entretiens":
      return 5;
    default:
      return 9;
  }
}

export function orderActions(items: WeekItem[]): WeekItem[] {
  return items
    .filter((i) => actionRank(i) < 9)
    .sort((a, b) => actionRank(a) - actionRank(b) || b.score - a.score || a.title.localeCompare(b.title, "fr"));
}

function chronological(slots: WeekSlot[]): WeekSlot[] {
  return [...slots].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

function take(pool: WeekItem[], predicate: (i: WeekItem) => boolean): WeekItem | null {
  const sorted = pool.filter(predicate).sort((a, b) => b.score - a.score);
  const chosen = sorted[0] ?? null;
  if (chosen) pool.splice(pool.indexOf(chosen), 1);
  return chosen;
}

export function planWeek(
  slots: WeekSlot[],
  items: WeekItem[],
  /** Texte des créneaux fixes (sourcing), par type. */
  fixedNotes: Partial<Record<WeekSlotKind, string>> = {},
): PlannedSlot[] {
  const pool = [...items];
  const ordered = chronological(slots);

  // Passe 1 — chaque créneau prend son propre type.
  const planned: PlannedSlot[] = ordered.map((slot) => {
    const fixed = slot.kind === "sourcing_et" || slot.kind === "sourcing_archi";
    const item = fixed ? null : take(pool, (i) => i.kind === slot.kind);
    return {
      day: slot.day,
      dayLabel: DAY_LABEL[slot.day],
      time: slot.time,
      kind: slot.kind,
      kindLabel: KIND_LABEL[slot.kind],
      item,
      reassigned: false,
      note: fixed ? (fixedNotes[slot.kind] ?? EMPTY_LABEL[slot.kind]) : null,
      suggestion: null,
    };
  });

  // Passe 2 — réaffectation des créneaux vides, dans l'ordre chronologique.
  for (const slot of planned) {
    if (slot.item || !WEEK_REASSIGNABLE.includes(slot.kind)) continue;
    for (const kind of WEEK_FALLBACK_ORDER) {
      const item = take(pool, (i) => i.kind === kind && (kind !== "gros_dossier" || i.urgent));
      if (item) {
        slot.item = item;
        slot.reassigned = kind !== slot.kind;
        break;
      }
    }
  }

  // Créneaux restés disponibles : une suggestion douce, jamais un remplissage.
  for (const slot of planned) {
    if (slot.item || slot.note) continue;
    const bigDeal = pool.find((i) => i.kind === "gros_dossier");
    const candidature = pool.find((i) => i.kind === "candidatures");
    slot.note = EMPTY_LABEL[slot.kind];
    slot.suggestion = bigDeal
      ? `Si le temps le permet : avancer « ${bigDeal.title} » (${bigDeal.who}).`
      : candidature
        ? `Si le temps le permet : ${candidature.title.toLowerCase()}.`
        : items.some((i) => i.kind === "affaire_semaine")
          ? "Si le temps le permet : préparer l'affaire de la semaine, ou sourcing."
          : "Si le temps le permet : sourcing ET ou architectes.";
  }

  return planned;
}

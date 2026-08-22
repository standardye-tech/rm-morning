/**
 * Libellés de l'actualisation, sans aucune dépendance.
 *
 * Existe pour la même raison que `forecast-labels` : le bouton est un composant
 * client et ne doit importer aucun module qui touche la base — un seul import de
 * `node:sqlite` côté navigateur fait tomber le compilateur.
 *
 * VOCABULAIRE. Aucun terme d'ingénierie ne doit apparaître à l'écran : ni
 * pipeline, ni ETL, ni orchestration. Un directeur régional lit « Salesforce »,
 * « Travaux », « Perspective », « Emails », « Prévisions », « Finalisation ».
 */

export type SyncStatus = "running" | "success" | "warning" | "failed";
export type StepStatus = "pending" | "running" | "success" | "warning" | "skipped" | "failed";

/** Les six groupes affichés pendant l'actualisation, dans l'ordre. */
export const SYNC_GROUPS = [
  "Salesforce",
  "Travaux",
  "Perspective",
  "Emails",
  "Prévisions",
  "Finalisation",
] as const;

export type SyncGroup = (typeof SYNC_GROUPS)[number];

/**
 * À quel groupe appartient chaque étape.
 *
 * Les étapes restent fines côté serveur — c'est ce qui permet de dire précisément
 * ce qui a échoué — mais l'écran en montre six lignes, pas dix.
 */
export const STEP_GROUP: Record<string, SyncGroup> = {
  "salesforce-opportunites": "Salesforce",
  "jalons-opportunites": "Salesforce",
  "salesforce-pistes": "Salesforce",
  travaux: "Travaux",
  perspective: "Perspective",
  emails: "Emails",
  historisation: "Finalisation",
  "expected-m": "Prévisions",
  "projection-m1": "Prévisions",
  "suggestions-m1": "Prévisions",
  finalisation: "Finalisation",
};

export const RUN_STATUS_LABEL: Record<SyncStatus, string> = {
  running: "Actualisation en cours",
  success: "RM Morning est à jour",
  warning: "Actualisation partielle",
  failed: "Actualisation interrompue",
};

/** Durée lisible : « 38 s », « 2 min 05 ». */
export function humanDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
}

/** Heure courte, telle qu'on la lit dans une phrase : « à jour — 18:42 ». */
export function humanTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function humanDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  // Certaines sources ne portent qu'une date — la Perspective est datée au jour.
  // Lui ajouter une heure inventée (« 02:00 ») laisserait croire à une précision
  // qu'elle n'a pas.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

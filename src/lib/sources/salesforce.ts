/**
 * Abstraction de la source Salesforce.
 *
 * Le reste de l'application ne connaît QUE ce contrat. Remplacer l'export
 * manuel par l'API Salesforce ne doit toucher aucun autre fichier que
 * `manual-salesforce.ts` / `api-salesforce.ts`.
 */

/**
 * Une opportunité telle que fournie par la source, en valeurs brutes (chaînes).
 * La normalisation (montants, dates, Kanban) est faite en aval, une seule fois,
 * pour que toutes les sources bénéficient du même traitement.
 *
 * Tous les champs sont optionnels : le parseur doit tolérer les colonnes absentes.
 */
export type RawOpportunity = {
  opportunityId: string | null;
  name: string | null;
  clientContact: string | null;
  /** Adresse e-mail du contact client — clé de rattachement des mails. */
  clientEmail: string | null;
  ownerName: string | null;
  gmv: string | null;
  stage: string | null;
  probability: string | null;
  kanbanProjection: string | null;
  createdAt: string | null;
  leadCreatedAt: string | null;
  quoteSignatureDate: string | null;
  lastActivityAt: string | null;
  lastModifiedAt: string | null;
  postalCode: string | null;
  city: string | null;
  acquisitionChannel: string | null;
  leadSource: string | null;
  service: string | null;
  standByUntil: string | null;
  /** Drapeau booléen Salesforce, complément de la date. Absent de l'export fichier. */
  standByFlag: string | null;
};

/** Les champs attendus, dans l'ordre d'affichage de la page Données. */
export const RAW_FIELDS: (keyof RawOpportunity)[] = [
  "opportunityId",
  "name",
  "clientContact",
  "clientEmail",
  "ownerName",
  "gmv",
  "stage",
  "probability",
  "kanbanProjection",
  "createdAt",
  "leadCreatedAt",
  "quoteSignatureDate",
  "lastActivityAt",
  "lastModifiedAt",
  "postalCode",
  "city",
  "acquisitionChannel",
  "leadSource",
  "service",
  "standByUntil",
  "standByFlag",
];

/** Libellés lisibles des champs, pour la page Données. */
export const RAW_FIELD_LABELS: Record<keyof RawOpportunity, string> = {
  opportunityId: "ID opportunité",
  name: "Nom opportunité",
  clientContact: "Client / contact",
  clientEmail: "E-mail client",
  ownerName: "Propriétaire",
  gmv: "GMV",
  stage: "Étape",
  probability: "Probabilité",
  kanbanProjection: "Projection Kanban",
  createdAt: "Date de création opportunité",
  leadCreatedAt: "Date de création de la piste",
  quoteSignatureDate: "Date de signature du devis",
  lastActivityAt: "Date dernière activité",
  lastModifiedAt: "Date dernière modification",
  postalCode: "CP",
  city: "Ville",
  acquisitionChannel: "Canal d'acquisition",
  leadSource: "Lead Source",
  service: "Prestation",
  standByUntil: "En stand-by jusqu'au",
  standByFlag: "En stand-by (drapeau)",
};

/** Anomalie rencontrée pendant la lecture de la source. */
export type ParseIssue = {
  /** Numéro de ligne dans la source, si applicable. */
  row?: number;
  message: string;
};

export type SalesforceFetchResult = {
  /** Identifiant technique de la source (« manual », « api »). */
  sourceKind: string;
  /** Description lisible (nom du fichier, URL de l'org…). */
  sourceLabel: string;
  /** Nom du fichier importé, si la source en a un. */
  fileName: string | null;
  fetchedAt: Date;
  /** Champs du contrat effectivement trouvés dans la source. */
  detectedFields: (keyof RawOpportunity)[];
  /** Champs du contrat absents de la source. */
  missingFields: (keyof RawOpportunity)[];
  /** En-têtes bruts rencontrés (utile pour diagnostiquer un libellé inconnu). */
  rawHeaders: string[];
  rows: RawOpportunity[];
  issues: ParseIssue[];
};

export interface SalesforceSource {
  readonly kind: string;
  fetch(): Promise<SalesforceFetchResult>;
}

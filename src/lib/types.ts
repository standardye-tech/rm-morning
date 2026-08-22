/**
 * Modèle métier de RM Morning, indépendant de la source et du stockage.
 */

export type Opportunity = {
  opportunityId: string;
  name: string | null;
  clientContact: string | null;
  /** Adresse e-mail du contact client, normalisée en minuscules. */
  clientEmail: string | null;
  /** Nom canonique du commercial (membre de l'équipe suivie). */
  owner: string;
  /** Nom tel qu'écrit dans Salesforce, conservé pour traçabilité. */
  ownerRaw: string | null;
  gmv: number | null;
  stage: string | null;
  probability: number | null;

  /** Projection Kanban : brut conservé, décomposition quand elle est possible. */
  kanbanRaw: string | null;
  kanbanColor: string | null;
  kanbanColorRaw: string | null;
  kanbanMonth: number | null;
  kanbanYear: number | null;

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

  /** Date de réveil du stand-by, conservée même une fois échue. */
  standbyUntil: string | null;
  /** Drapeau Salesforce `En_stand_by__c`. null si la source ne le fournit pas. */
  standbyFlag: boolean | null;

  isSigned: boolean;
  isTerminal: boolean;
  /**
   * Date du premier import où la source ne publiait plus l'affaire. Non nulle =
   * sortie du périmètre actif (abandon, annulation, reprise hors équipe). Elle
   * est alors aussi `isTerminal` : le pipe n'a pas à connaître ce détail, seuls
   * l'audit et la page Données s'y intéressent.
   */
  absentSince: string | null;
  absentReason: string | null;
  /** Stand-by encore en cours à la date de référence. */
  isStandby: boolean;
  /** Pipe actif = ni terminé, ni en stand-by en cours. */
  isActive: boolean;
};

export type ImportRun = {
  id: number;
  importedAt: string;
  snapshotDate: string;
  sourceKind: string;
  sourceLabel: string;
  fileName: string | null;
  totalRows: number;
  teamRows: number;
  activeRows: number;
  signedRows: number;
  standbyRows: number;
  detectedFields: string[];
  missingFields: string[];
  rawHeaders: string[];
  issues: { row?: number; message: string }[];
};

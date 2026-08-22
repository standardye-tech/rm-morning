/**
 * Types et libellés Morning, sans aucune dépendance.
 *
 * Ce fichier existe pour une raison précise : les composants Morning sont des
 * composants client (ils portent le bouton « Pris en compte »), et ils ne
 * doivent donc importer aucun module qui touche la base. Types, libellés et
 * formatage de durée vivent ici ; la lecture SQLite reste dans
 * `morning-events` et `morning-priority`.
 */

/**
 * Catégories internes du triage.
 *
 * `hors_perimetre` est distinct d'`ignore` : le premier dit « ce n'est pas un
 * sujet commercial », le second « aucune intention identifiable chez un
 * interlocuteur pourtant recevable ». Les distinguer permet de mesurer ce que le
 * nettoyage C14 retire, et de le retrouver plus tard si l'on se trompait.
 * Ni l'un ni l'autre n'apparaît dans l'interface.
 */
export type MorningCategory = "chaud" | "attente" | "ignore" | "hors_perimetre";

export type MorningEvent = {
  messageId: string;
  threadId: string;
  sentAt: string | null;
  category: MorningCategory;
  /** Ce que dit le client, en français simple. Jamais un code de classe. */
  reason: string;
  /** Pourquoi le message a été écarté, quand il l'a été. */
  ignoredBecause: string | null;
  client: string | null;
  fromEmail: string | null;
  salesperson: string | null;
  opportunityId: string | null;
  /** Piste désignée quand aucune affaire n'existe. */
  leadId: string | null;
  /**
   * Ce que le message désigne réellement (C13). Distinction essentielle : une
   * affaire du pipe porte du GMV à aller chercher ; une affaire signée en
   * chantier, une affaire close ou une piste n'en portent pas, mais elles
   * identifient l'interlocuteur, ce qui suffit à router le message.
   */
  matchKind:
    | "affaire_pipe"
    | "affaire_hors_pipe"
    | "affaire_fermee"
    | "piste"
    | "contact"
    | "ambigu"
    | "inconnu";
  /** Montant d'une affaire hors pipe. Jamais additionné au GMV du pipe. */
  externalAmount: number | null;
  externalStage: string | null;
  leadStatus: string | null;
  /** « certain » / « probable » / « à vérifier ». Jamais un code A/B/C. */
  attachment: "certain" | "probable" | "a_verifier";
  gmv: number | null;
  stage: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  isNew: boolean;
};

export type MorningReason =
  | "client_motive"
  | "client_attend"
  | "affaire_decisive"
  | "a_challenger_vivante"
  | "proche_signature";

export const REASON_LABEL: Record<MorningReason, string> = {
  client_motive: "Le client veut avancer",
  client_attend: "Le client attend une réponse",
  affaire_decisive: "Affaire décisive pour le mois",
  a_challenger_vivante: "Affaire à challenger, et le client donne signe de vie",
  proche_signature: "Proche de la signature",
};

export type MorningAction = {
  key: string;
  reason: MorningReason;
  /** Pourquoi maintenant, en une phrase. */
  why: string;
  /** Ce qu'il faut faire, à l'impératif. */
  todo: string;
  client: string;
  salesperson: string | null;
  gmv: number | null;
  stage: string | null;
  /** Indicateurs utiles, déjà formatés en langage métier. */
  facts: string[];
  /** Le message à l'origine, quand il y en a un : permet de l'acquitter. */
  messageId: string | null;
  receivedAt: string | null;
  opportunityId: string | null;
  /** Interne, jamais affiché. */
  score: number;
};

const HOURS = 36e5;

/** « Reçu il y a … » en français, sans jargon de durée. */
/**
 * Ancienneté du message, sous une forme courte.
 *
 * Le mot « reçu » a disparu : la colonne s'appelle déjà « Reçu », et le répéter
 * sur chaque ligne allongeait la cellule sans rien apprendre. Les libellés sont
 * assez courts pour tenir sur une ligne, ce qui est la condition d'une hauteur
 * de ligne constante.
 */
export function received(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const h = (now.getTime() - new Date(iso).getTime()) / HOURS;
  if (h < 1) return "à l'instant";
  if (h < 5) return `il y a ${Math.round(h)} h`;
  if (h < 12) return "ce matin";
  if (h < 24) return "hier";
  const d = Math.round(h / 24);
  return d <= 1 ? "hier" : `il y a ${d} j`;
}

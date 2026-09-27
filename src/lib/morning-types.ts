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
  /** Motif du triage, en français simple. Jamais un code de classe. */
  reason: string;
  /**
   * Ce que dit le client, tel qu'on l'affiche : sa phrase citée quand on l'a,
   * sinon le résumé fidèle du classifieur, sinon le motif du triage. Jamais
   * une phrase inventée.
   */
  said: string;
  /** Ce qu'il attend, très court, pour la parenthèse du bloc 2. Null si redondant. */
  expects: string | null;
  /** La phrase citée seule, quand elle existe. */
  quote: string | null;
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
  /**
   * L'attente est-elle encore active (F) ? Vrai pour tout ce qui n'est pas
   * une catégorie « attente », et pour une attente sans réponse RM
   * postérieure dans le fil. Faux uniquement quand RM a répondu depuis —
   * INDÉPENDANT de `acknowledged` : un message traité par Sami reste une
   * attente active tant que le client n'a pas reçu de réponse, et un message
   * jamais acquitté cesse d'être une attente dès qu'une réponse existe.
   */
  awaitingReply: boolean;
  /**
   * Ce message chaud est-il la plus récente occurrence de son fil (G) ? Vrai
   * pour tout ce qui n'est pas « chaud ». Plusieurs signaux chauds successifs
   * du même fil ne sont pas des opportunités distinctes — seul le plus
   * récent décrit la situation commerciale actuelle.
   */
  isLatestHotInThread: boolean;
};

/**
 * Raison d'entrée d'une affaire dans le Plan du jour (une famille = une raison).
 *
 *   securiser   A — annoncée sur M, RM Morning la juge fragile ou bloquée
 *   basculer    B — prévue M+1, peut signer sur M
 *   bloque      C — gros GMV bloqué
 *   upside      D — hors forecast, crédible (pMonthEnd ou signal dur)
 *   divergence  E — annoncée sur M, RM Morning nettement en dessous
 */
export type MorningReason = "securiser" | "basculer" | "bloque" | "upside" | "divergence";

export const REASON_LABEL: Record<MorningReason, string> = {
  securiser: "GMV annoncé à sécuriser",
  basculer: "Peut basculer de M+1 sur M",
  bloque: "Gros GMV bloqué",
  upside: "Hors forecast crédible",
  divergence: "Écart Forecast / RM Morning",
};

/** Ce que le manager demande, en un mot : l'étiquette affichée sur la ligne. */
export const ASK_LABEL: Record<MorningReason, string> = {
  securiser: "À sécuriser",
  basculer: "Peut basculer",
  bloque: "À débloquer",
  upside: "À challenger",
  divergence: "À challenger",
};

/** Famille de la situation. C'est aussi le libellé de catégorie du journal. */
export type PlanFamily = MorningReason;

/** D'où vient le signal principal. */
export type MorningSource = "gmail" | "forecast" | "salesforce";

/**
 * Une ligne du Plan = UNE affaire (un OpportunityId).
 */
export type MorningAction = {
  /** ActionKey `plan:<OpportunityId>:<motif>:<semaine>` (voir `action-keys.ts`) : partagée avec « Ma semaine ». */
  key: string;
  reason: MorningReason;
  /** Famille de l'affaire (identique à `reason`). */
  category: PlanFamily;
  /** Signal principal : le forecast déclaré, ou l'état Salesforce. */
  source: MorningSource;
  /** Pourquoi cette affaire peut modifier l'atterrissage, en une phrase. */
  why: string;
  /** Ce qu'il faut faire, à l'impératif. */
  todo: string;
  /** « Commercial — Client » : ce que le manager lit d'abord. */
  title: string;
  /** « GMV · stade · raison » : tirée uniquement des données qui ont compté au score. */
  detail: string;
  client: string;
  /** Commercial de l'affaire : qui challenger. */
  owner: string | null;
  ownerFirstName: string | null;
  /** Identique à `owner` : conservé pour les lecteurs existants. */
  salesperson: string | null;
  /** GMV RÉELLE de l'affaire (jamais plafonnée). */
  gmv: number | null;
  stage: string | null;
  /** Indicateurs utiles, déjà formatés en langage métier. */
  facts: string[];
  /** Toujours nul : le Plan ne porte plus de message (les Blocs 1 et 2 s'en chargent). */
  messageId: string | null;
  receivedAt: string | null;
  opportunityId: string | null;
  /** Une seule affaire : conservé pour les lecteurs existants. */
  opportunityIds: string[];
  /** Impact en euros (voir `MORNING_PLAN`), score de tri. Interne, jamais affiché. */
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

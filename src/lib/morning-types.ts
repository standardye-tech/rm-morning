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

export type MorningReason =
  | "client_motive"
  | "client_attend"
  | "affaire_decisive"
  | "a_challenger_vivante"
  | "a_challenger_figee"
  | "proche_signature"
  | "pipe_faible"
  | "affaires_figees";

export const REASON_LABEL: Record<MorningReason, string> = {
  client_motive: "Le client veut avancer",
  client_attend: "Le client attend une réponse",
  affaire_decisive: "Affaire décisive pour le mois",
  a_challenger_vivante: "Affaire à challenger, et le client donne signe de vie",
  a_challenger_figee: "Affaire à challenger, sans mouvement",
  proche_signature: "Proche de la signature",
  pipe_faible: "Pipe insuffisant",
  affaires_figees: "Affaires figées",
};

/**
 * Ce que le manager demande, en un mot : c'est l'étiquette affichée sur la
 * ligne. Sami ne relance pas les clients, il fait relancer.
 */
export const ASK_LABEL: Record<MorningReason, string> = {
  client_motive: "Faire traiter",
  client_attend: "Faire répondre",
  affaire_decisive: "Challenger",
  a_challenger_vivante: "Challenger",
  a_challenger_figee: "Challenger",
  proche_signature: "Sécuriser",
  pipe_faible: "Reconstituer le pipe",
  affaires_figees: "Débloquer",
};

/** Famille de la situation. C'est aussi le préfixe de `key`. */
export type PlanFamily =
  | "chaud"
  | "attente"
  | "decisive"
  | "challenge"
  | "signature"
  | "pipe_faible"
  | "figees";

/** D'où vient le signal principal. */
export type MorningSource = "gmail" | "forecast" | "salesforce";

export type MorningAction = {
  key: string;
  reason: MorningReason;
  /** Famille de la situation (chaud, attente, decisive, …). */
  category: PlanFamily;
  /** Signal principal : un mail, le forecast déclaré, ou l'état Salesforce. */
  source: MorningSource;
  /** Pourquoi maintenant, en une phrase. */
  why: string;
  /** Ce qu'il faut faire, à l'impératif. */
  todo: string;
  /** « Commercial — situation » : ce que le manager lit d'abord. */
  title: string;
  /** Justification courte, tirée uniquement des données qui ont compté au score. */
  detail: string;
  /** Vide pour une situation qui ne porte sur aucune affaire précise. */
  client: string;
  /** Commercial concerné. Null seulement si le message n'a pu être rattaché. */
  owner: string | null;
  ownerFirstName: string | null;
  /** Identique à `owner` : conservé pour les lecteurs existants. */
  salesperson: string | null;
  gmv: number | null;
  stage: string | null;
  /** Indicateurs utiles, déjà formatés en langage métier. */
  facts: string[];
  /** Le message à l'origine, quand il y en a un : permet de l'acquitter. */
  messageId: string | null;
  receivedAt: string | null;
  opportunityId: string | null;
  /**
   * Toutes les affaires que cette situation couvre : une seule pour une affaire,
   * plusieurs pour « 3 affaires figées ». Sert à ne jamais compter deux fois la
   * même affaire dans le Plan.
   */
  opportunityIds: string[];
  /**
   * Situations nées d'un mail seulement : les motifs managériaux qui ont donné
   * accès au Plan (voir `MORNING_PLAN.mailMotive`). Jamais vide dans le Plan.
   */
  motives?: string[];
  /**
   * Étiquette du badge quand le motif dominant n'est pas la famille du mail
   * (« Challenger », « Sécuriser », « Débloquer »). Absente : `ASK_LABEL[reason]`.
   */
  ask?: string;
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

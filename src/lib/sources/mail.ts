/**
 * Contrat de la source mail (Gmail).
 *
 * Non branché au premier passage : ni OAuth, ni appel réseau. L'interface est
 * figée pour que le scoring puisse plus tard consommer des signaux mail
 * (relance sans réponse, échange récent, devis envoyé…) sans être réécrit.
 */

export type MailSignal = {
  /** Opportunité concernée si elle a pu être rapprochée. */
  opportunityId: string | null;
  /** Adresse du contact client. */
  contactEmail: string | null;
  /** Date ISO du dernier échange. */
  lastExchangeAt: string | null;
  /** Le dernier message part-il de nous et reste-t-il sans réponse ? */
  awaitingClientReply: boolean;
  subject: string | null;
};

export interface MailSource {
  readonly kind: string;
  /** Signaux mail pour un ensemble d'adresses de contact. */
  fetchSignals(contactEmails: string[]): Promise<MailSignal[]>;
}

/** Implémentation vide : aucun signal, tant que Gmail n'est pas connecté. */
export class NoMailSource implements MailSource {
  readonly kind = "none";

  async fetchSignals(): Promise<MailSignal[]> {
    return [];
  }
}

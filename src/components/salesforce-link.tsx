import type { ReactNode } from "react";

import { salesforceRecordUrl } from "@/lib/salesforce-link";

/**
 * Le nom d'un enregistrement Salesforce (affaire, piste), cliquable vers sa fiche
 * (nouvel onglet).
 *
 * Règle produit : partout où un élément affiché correspond à un enregistrement
 * Salesforce qui porte un Id, son nom est ce lien. Style volontairement discret —
 * un pointillé sous le texte, pas de bouton, pas d'icône — pour ne pas alourdir les
 * lignes. Sans Id exploitable, le texte reste du texte : aucun faux lien.
 *
 * Composant sans état : utilisable dans les composants serveur comme client.
 */
export function SalesforceRecordLink({
  recordId,
  children,
  className = "",
}: {
  recordId: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const href = salesforceRecordUrl(recordId);
  if (!href) return <span className={className || undefined}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Ouvrir la fiche dans Salesforce"
      className={`underline decoration-dotted decoration-ink-faint underline-offset-2 hover:decoration-ink-soft ${className}`}
    >
      {children}
    </a>
  );
}

/**
 * Nom d'usage pour une AFFAIRE : le même composant, sous la propriété
 * `opportunityId`. Aucune logique n'y est dupliquée.
 */
export function SalesforceOpportunityLink({
  opportunityId,
  children,
  className,
}: {
  opportunityId: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SalesforceRecordLink recordId={opportunityId} className={className}>
      {children}
    </SalesforceRecordLink>
  );
}

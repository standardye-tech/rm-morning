import type { ReactNode } from "react";

import { salesforceOpportunityUrl } from "@/lib/salesforce-link";

/**
 * Le nom d'une affaire, cliquable vers sa fiche Salesforce (nouvel onglet).
 *
 * Règle produit : partout où un élément affiché correspond à une Opportunity qui
 * porte un `OpportunityId`, le nom est ce lien. Style volontairement discret — un
 * pointillé sous le texte, pas de bouton, pas d'icône — pour ne pas alourdir les
 * lignes. Sans identifiant exploitable, le texte reste du texte : aucun faux lien.
 *
 * Composant sans état : utilisable dans les composants serveur comme client.
 */
export function SalesforceOpportunityLink({
  opportunityId,
  children,
  className = "",
}: {
  opportunityId: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const href = salesforceOpportunityUrl(opportunityId);
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

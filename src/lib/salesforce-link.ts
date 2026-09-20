/**
 * Lien vers une fiche Opportunity Salesforce — LE point unique de construction
 * d'URL de RM Morning.
 *
 * Aucun composant ne compose lui-même une URL Salesforce : ils passent par ici
 * (ou par `SalesforceOpportunityLink`, qui s'appuie sur cette fonction).
 *
 * Base : `SF_INSTANCE_URL` si elle est définie, sinon le domaine de l'org
 * (`SALESFORCE_RECORD_BASE`, non secret). Dans un composant client, la variable
 * d'environnement n'est pas visible du navigateur : le domaine de l'org est alors
 * utilisé, ce qui est sans effet tant qu'il n'y a qu'une org.
 *
 * Rend `null` quand il n'y a pas d'identifiant exploitable : l'appelant affiche
 * alors du texte simple, jamais un faux lien.
 */

import { SALESFORCE_RECORD_BASE } from "./config";

/** Un Id Salesforce fait 15 ou 18 caractères alphanumériques. */
const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export function salesforceOpportunityUrl(opportunityId: string | null | undefined): string | null {
  const id = (opportunityId ?? "").trim();
  if (!SALESFORCE_ID.test(id)) return null;
  const base = (SALESFORCE_RECORD_BASE || "").replace(/\/+$/, "");
  return `${base}/${id}`;
}

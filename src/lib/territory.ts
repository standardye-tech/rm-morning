/**
 * Périmètre TERRITORIAL du Morning Brief.
 *
 * Un membre de l'équipe peut être suivi par le DR d'Île-de-France sans que
 * toutes ses affaires relèvent de ce périmètre : Valentin Marion, par exemple,
 * porte des dossiers en Bretagne, qui appartiennent à un autre DR. Ces
 * dossiers ne sont pas des anomalies — ils sont simplement hors périmètre.
 *
 * CHAMP RETENU, et pourquoi celui-là.
 *
 * Le seul champ structuré fiable est le CODE POSTAL du compte
 * (`Account.BillingPostalCode`, stocké dans `opportunity.postal_code`).
 *
 * Ont été écartés, après vérification sur les données réelles :
 *   — la colonne « DR » du classeur Perspective : elle porte la direction
 *     régionale du COMMERCIAL, pas celle du chantier. Les dossiers bretons de
 *     Valentin Marion (Christelle LE HERITTE, 56600 Lanester ; Alexis REUCHE,
 *     56440 Languidic) y sont tous étiquetés « Île-de-France ». Elle ne
 *     discrimine donc rien ;
 *   — la ville : texte libre, parfois vide (14 dossiers hors IDF en ont une,
 *     mais un autre n'en a aucune) ;
 *   — le nom de l'opportunité : explicitement exclu, ce n'est pas une donnée.
 *
 * PRINCIPE DE PRUDENCE. On n'exclut que sur PREUVE POSITIVE d'être hors
 * territoire. Un code postal absent ou illisible laisse l'affaire dans le
 * périmètre : une donnée manquante ne doit jamais faire disparaître du chiffre.
 */

/** Départements d'Île-de-France, dans l'ordre officiel. */
export const IDF_DEPARTMENTS = ["75", "77", "78", "91", "92", "93", "94", "95"] as const;

const IDF = new Set<string>(IDF_DEPARTMENTS);

export type Territory =
  /** Preuve positive : le code postal est francilien. */
  | "idf"
  /** Preuve positive : le code postal existe et n'est pas francilien. */
  | "hors-idf"
  /** Aucune preuve : code postal absent, vide ou illisible. */
  | "inconnu";

/**
 * Territoire d'un code postal français.
 *
 * Les deux premiers chiffres suffisent : aucun département francilien ne
 * partage son préfixe avec un département d'une autre région.
 */
export function territoryOfPostalCode(postalCode: string | null | undefined): Territory {
  const digits = (postalCode ?? "").replace(/\D/gu, "");
  if (digits.length < 2) return "inconnu";
  return IDF.has(digits.slice(0, 2)) ? "idf" : "hors-idf";
}

/**
 * Restriction territoriale d'un membre d'équipe.
 * `null` — aucune restriction : toutes ses affaires sont dans le périmètre.
 * `"idf"` — seules ses affaires franciliennes le sont.
 */
export type TerritoryScope = "idf" | null;

/**
 * L'affaire est-elle dans le périmètre de ce membre ?
 *
 * Sans restriction, toujours oui. Avec la restriction « idf », non uniquement
 * si le code postal prouve que le chantier est hors Île-de-France.
 */
export function isInTerritoryScope(
  scope: TerritoryScope,
  postalCode: string | null | undefined,
): boolean {
  if (scope !== "idf") return true;
  return territoryOfPostalCode(postalCode) !== "hors-idf";
}

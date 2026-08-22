/**
 * Rattachement d'un message à une affaire Salesforce.
 *
 * PRINCIPE, inchangé depuis l'origine : on ne devine jamais. Un cas ambigu reste
 * ambigu, il est stocké comme tel et ne peut rien déclencher seul. Le critère n'est
 * pas de maximiser le taux de rattachement mais le taux de rattachement FIABLE :
 * un GMV attribué au mauvais client est pire qu'une affaire non identifiée.
 *
 * Cascade, du plus décisif au plus faible :
 *
 *   1. validation manuelle du fil — définitive, jamais recalculée ;
 *   2. mémoire du fil — un message antérieur a déjà tranché ;
 *   3. adresse exacte d'une affaire du pipe ;
 *   4. annuaire Salesforce — piste, contact, ou affaire hors pipe (C13) ;
 *   5. mémoire de l'expéditeur, restreinte aux affaires ouvertes ;
 *   6. nom du client plus commercial destinataire.
 *
 * NIVEAUX conservés pour l'application : A certain, B probable, C à vérifier.
 *
 * Fichier sans dépendance de base de données : l'annuaire et la mémoire des fils
 * lui sont passés. Le harnais de validation l'exécute donc exactement comme
 * l'application.
 */

import type { MailMessage } from "./mail-rules";

export type MatchableOpportunity = {
  opportunityId: string;
  clientEmail: string | null;
  clientContact: string | null;
  /** Nom de l'opportunité — porte souvent le patronyme quand le contact manque. */
  name: string | null;
  owner: string;
  stage: string | null;
  isSigned: boolean;
  isActive: boolean;
};

export type MatchLevel = "A" | "B" | "C";

/** Ce que le message désigne, quand ce n'est pas une affaire du pipe. */
export type MatchKind =
  | "affaire_pipe"
  | "affaire_hors_pipe"
  | "affaire_fermee"
  | "piste"
  | "contact"
  | "ambigu"
  | "inconnu";

export type MatchResult = {
  level: MatchLevel;
  opportunityId: string | null;
  /** Piste désignée quand aucune affaire n'existe. */
  leadId: string | null;
  kind: MatchKind;
  /** Explication courte et vérifiable du rattachement. */
  reason: string;
  /** Opportunités candidates quand plusieurs restent possibles. */
  candidates: string[];
  /** Vrai quand le rattachement vient d'une validation du manager. */
  isManual: boolean;
};

export type OpportunityIndex = {
  byEmail: Map<string, MatchableOpportunity[]>;
  all: MatchableOpportunity[];
};

/** Entrée d'annuaire, réduite à ce dont le moteur a besoin. */
export type DirectoryLookup = {
  kind: MatchKind;
  confidence: "certain" | "probable" | "a_verifier";
  reason: string;
  opportunityId: string | null;
  leadId: string | null;
  candidates: string[];
};

export type ThreadLookup = {
  opportunityId: string | null;
  leadId: string | null;
  kind: string;
  confidence: "certain" | "probable" | "a_verifier";
  isManual: boolean;
};

const lower = (value: string) => (value ?? "").trim().toLowerCase();
const domainOf = (email: string) => lower(email).split("@")[1] ?? "";

export function buildOpportunityIndex(opportunities: MatchableOpportunity[]): OpportunityIndex {
  const byEmail = new Map<string, MatchableOpportunity[]>();
  for (const opportunity of opportunities) {
    const email = lower(opportunity.clientEmail ?? "");
    if (!email) continue;
    const bucket = byEmail.get(email);
    if (bucket) bucket.push(opportunity);
    else byEmail.set(email, [opportunity]);
  }
  return { byEmail, all: opportunities };
}

/** Adresses externes du message : ni l'entreprise, ni les robots. */
function externalAddresses(message: MailMessage, internalDomain: string): string[] {
  const all = [message.from, ...(message.to ?? []), ...(message.cc ?? [])].map(lower);
  return [...new Set(all)].filter(
    (address) =>
      address &&
      domainOf(address) !== internalDomain &&
      !/^(no[.\-_]?reply|noreply|donotreply|notifications?)/i.test(address.split("@")[0] ?? ""),
  );
}

/**
 * Jetons comparables d'un nom : sans accents, sans casse, tirets et points
 * traités comme des séparateurs.
 *
 * « Jean-Pierre DURAND », « Jean Pierre Durand » et « jean.pierre.durand@… »
 * produisent donc les mêmes jetons. Les civilités et les particules sont écartées :
 * elles ne discriminent rien.
 */
const CIVILITY = new Set([
  "monsieur", "madame", "mademoiselle", "mr", "mme", "mlle", "m", "dr",
  "de", "du", "des", "le", "la", "les", "van", "von", "el", "al", "da", "di",
]);

export function nameTokens(value: string): string[] {
  return lower(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 3 && !CIVILITY.has(token));
}

/**
 * Patronyme retenu pour une opportunité : le contact s'il existe, sinon la partie
 * « personne » du nom d'opportunité, avant le tiret de prestation.
 */
function personName(opportunity: MatchableOpportunity): string {
  if (opportunity.clientContact) return opportunity.clientContact;
  return (opportunity.name ?? "").split(/\s+[-–—]\s+/)[0];
}

/**
 * Le message porte-t-il le nom de ce client ?
 *
 * CORRIGÉ EN C13. L'ancienne règle cherchait le jeton le plus long du nom client
 * dans l'OBJET du message. Elle rapprochait « Relance document en fin de validité »
 * d'un client nommé LANCE, et un message de « thomas.pasquier@… » de n'importe quel
 * client prénommé Thomas. Deux corrections :
 *
 *   — l'objet du message n'est plus utilisé. Il contient du français courant, et
 *     aucune règle de longueur ne distingue « Relance » d'un patronyme ;
 *   — la comparaison porte sur le nom d'affichage et la partie locale de l'adresse,
 *     et exige DEUX jetons communs (prénom et nom) ou un jeton de six lettres au
 *     moins. Un prénom seul ne suffit plus.
 */
function nameAgrees(client: string, senderName: string, senderLocal: string): string | null {
  const clientList = nameTokens(client);
  if (clientList.length === 0) return null;
  const senderTokens = new Set([
    ...nameTokens(senderName),
    ...nameTokens(senderLocal.replace(/[._\-+]+/g, " ")),
  ]);
  const shared = clientList.filter((t) => senderTokens.has(t));
  // Prénom ET nom : c'est le seul cas vraiment convaincant.
  if (shared.length >= 2) return shared.join(" ");
  // Un seul jeton commun n'est retenu que s'il s'agit du PATRONYME du client —
  // le dernier jeton de son nom — et qu'il est assez long. Un prénom partagé ne
  // vaut rien : « Thomas Pasquier » ne doit pas rejoindre l'affaire de « Thomas
  // Berger », ce que la longueur seule ne suffisait pas à empêcher.
  const surname = clientList[clientList.length - 1];
  if (shared.length === 1 && shared[0] === surname && surname.length >= 5) return surname;
  return null;
}

export function matchMessage(
  message: MailMessage,
  index: OpportunityIndex,
  options: {
    internalDomain: string;
    /** Commerciaux de l'équipe présents dans le message. */
    teamMembers: string[];
    /** Rattachement déjà mémorisé pour ce fil. */
    threadLink?: ThreadLookup | null;
    /** Annuaire des adresses résolues vers Salesforce. */
    directory?: Map<string, DirectoryLookup>;
    /** Affaires ouvertes déjà rattachées à cet expéditeur, par fil. */
    senderMemory?: { opportunityId: string; threads: number }[];
    /** Nom d'affichage de l'expéditeur, quand Gmail le fournit. */
    fromName?: string | null;
  },
): MatchResult {
  const none = (kind: MatchKind, reason: string, candidates: string[] = []): MatchResult => ({
    level: "C",
    opportunityId: null,
    leadId: null,
    kind,
    reason,
    candidates,
    isManual: false,
  });

  // --- 1 & 2. Le fil a déjà tranché.
  const link = options.threadLink;
  if (link && (link.opportunityId || link.leadId)) {
    return {
      level: link.confidence === "certain" ? "A" : "B",
      opportunityId: link.opportunityId,
      leadId: link.leadId,
      kind: link.kind as MatchKind,
      reason: link.isManual
        ? "affaire choisie par le manager pour ce fil"
        : "fil déjà rattaché par un message antérieur",
      candidates: [],
      isManual: link.isManual,
    };
  }

  const addresses = externalAddresses(message, options.internalDomain);

  // --- 3. Une adresse externe correspond à exactement une affaire du pipe.
  const exact: { address: string; opportunity: MatchableOpportunity }[] = [];
  const ambiguous: { address: string; opportunities: MatchableOpportunity[] }[] = [];
  for (const address of addresses) {
    const found = index.byEmail.get(address);
    if (!found || found.length === 0) continue;
    if (found.length === 1) exact.push({ address, opportunity: found[0] });
    else ambiguous.push({ address, opportunities: found });
  }

  if (exact.length === 1) {
    return {
      level: "A",
      opportunityId: exact[0].opportunity.opportunityId,
      leadId: null,
      kind: "affaire_pipe",
      reason: `adresse client unique (${exact[0].address})`,
      candidates: [],
      isManual: false,
    };
  }
  if (exact.length > 1) {
    return none(
      "ambigu",
      `${exact.length} adresses clients différentes dans le même message`,
      exact.map((e) => e.opportunity.opportunityId),
    );
  }

  // Adresse partagée par plusieurs affaires du pipe, départagée par le commercial.
  if (ambiguous.length === 1) {
    const pool = ambiguous[0].opportunities;
    const byOwner = pool.filter((o) => options.teamMembers.includes(o.owner));
    if (byOwner.length === 1) {
      return {
        level: "B",
        opportunityId: byOwner[0].opportunityId,
        leadId: null,
        kind: "affaire_pipe",
        reason: `adresse partagée (${ambiguous[0].address}), départagée par le commercial ${byOwner[0].owner}`,
        candidates: pool.map((o) => o.opportunityId),
        isManual: false,
      };
    }
    return none(
      "ambigu",
      `adresse partagée par ${pool.length} affaires, aucun départage possible`,
      pool.map((o) => o.opportunityId),
    );
  }

  // --- 4. L'annuaire Salesforce. C'est l'apport de C13 : il sait reconnaître un
  //     client dont l'affaire est signée, terminée, ou encore à l'état de piste —
  //     autant de cas que la table du pipe ne peut pas contenir.
  // L'annuaire ne s'applique qu'à un expéditeur EXTERNE : une adresse de
  // l'entreprise ne désigne jamais un client, même si elle existe par ailleurs
  // comme contact dans Salesforce.
  const senderEmail = lower(message.from);
  const entry =
    domainOf(senderEmail) === options.internalDomain
      ? undefined
      : options.directory?.get(senderEmail);
  if (entry && entry.kind !== "inconnu") {
    // Une affaire hors pipe ou fermée est une identification VALIDE, mais elle ne
    // porte aucun GMV à aller chercher. Le niveau reste A quand l'annuaire est
    // certain : la question « qui est-ce ? » est tranchée, c'est ce que Morning
    // demande. Le `kind` dit ensuite ce qu'on peut en faire.
    const level: MatchLevel = entry.confidence === "certain" ? "A" : entry.confidence === "probable" ? "B" : "C";
    if (level !== "C") {
      return {
        level,
        opportunityId: entry.opportunityId,
        leadId: entry.leadId,
        kind: entry.kind,
        reason: entry.reason,
        candidates: entry.candidates,
        isManual: false,
      };
    }
    return none(entry.kind, entry.reason, entry.candidates);
  }

  // --- 5. Mémoire de l'expéditeur, restreinte aux affaires ouvertes. Jamais
  //     « certain » : la même adresse peut porter un nouveau projet.
  const memory = options.senderMemory ?? [];
  if (memory.length === 1) {
    return {
      level: "B",
      opportunityId: memory[0].opportunityId,
      leadId: null,
      kind: "affaire_pipe",
      reason: `même adresse déjà rattachée à cette affaire sur ${memory[0].threads} fil(s)`,
      candidates: [],
      isManual: false,
    };
  }
  if (memory.length > 1) {
    return none(
      "ambigu",
      `cette adresse a déjà été rattachée à ${memory.length} affaires ouvertes`,
      memory.map((m) => m.opportunityId),
    );
  }

  // --- 6. Nom du client et commercial destinataire.
  if (options.teamMembers.length > 0) {
    const senderIsInternal = domainOf(message.from) === options.internalDomain;
    const senderLocal = senderIsInternal ? "" : lower(message.from).split("@")[0];
    const senderName = options.fromName ?? "";
    // Un patronyme qui est aussi le nom d'un commercial ne discrimine rien.
    const teamTokens = new Set(options.teamMembers.flatMap((m) => nameTokens(m)));

    const hits: { opportunity: MatchableOpportunity; shared: string }[] = [];
    for (const opportunity of index.all) {
      if (!options.teamMembers.includes(opportunity.owner)) continue;
      const shared = nameAgrees(personName(opportunity), senderName, senderLocal);
      if (!shared) continue;
      if (shared.split(" ").every((t) => teamTokens.has(t))) continue;
      hits.push({ opportunity, shared });
    }
    if (hits.length === 1) {
      return {
        level: "B",
        opportunityId: hits[0].opportunity.opportunityId,
        leadId: null,
        kind: "affaire_pipe",
        reason: `nom « ${hits[0].shared} » reconnu, une seule affaire de ${hits[0].opportunity.owner} correspond`,
        candidates: [],
        isManual: false,
      };
    }
    if (hits.length > 1) {
      return none(
        "ambigu",
        `${hits.length} affaires portent le même nom de client`,
        hits.map((h) => h.opportunity.opportunityId),
      );
    }
  }

  if (entry) return none(entry.kind, entry.reason, entry.candidates);
  return none(
    "inconnu",
    addresses.length === 0
      ? "aucune adresse externe exploitable"
      : "adresse inconnue de Salesforce, et aucun nom reconnu",
  );
}

/**
 * Rôle de l'EXPÉDITEUR d'un message — scanner mail V2 (18/10/2026).
 *
 * POURQUOI CE MODULE. Jusqu'ici, le rattachement d'un message à une affaire
 * servait aussi à dire QUI écrivait : un architecte, un artisan ou un
 * fournisseur répondant dans le fil d'un client héritait de son affaire, donc
 * de son statut de « client actif » (audit du 18/10/2026 : 13 non-clients sur
 * 7 jours). Le rattachement dit DE QUEL PROJET parle le message ; ce module dit
 * QUI parle. Les deux ne se déduisent plus l'un de l'autre.
 *
 * ORDRE DE DÉCISION, du plus certain au plus faible :
 *
 *   1. exclusions déterministes : salarié, automate (no-reply, anti-spam,
 *      réponse automatique, notification d'outil), envoi en masse ;
 *   2. type d'enregistrement Salesforce de L'ADRESSE de l'expéditeur
 *      (Contact / Piste : Artisan, MOE, Apporteur d'affaires, Client) — le
 *      rôle canonique, qui l'emporte sur toute heuristique ;
 *   3. client ou prospect identifié par SA PROPRE adresse (affaire, piste,
 *      email client de l'opportunité) ;
 *   4. domaines de fournisseurs, de prescripteurs et de métiers du bâtiment ;
 *   5. fil client + nom de l'expéditeur conforme au client de l'affaire ;
 *   6. sinon : inconnu. Un inconnu n'est ni exclu ni affirmé client : il ne
 *      devient candidat que sur preuve textuelle forte (voir le classifieur).
 *
 * Le modèle n'est jamais consulté pour une identité que ce module connaît avec
 * certitude. Aucune dépendance de base : testable tel quel.
 */

import { nameAgrees, personName, type MatchableOpportunity } from "./mail-match";
import { isAutomaticReply, isNoiseDomain } from "./mail-rules";

export type SenderRole =
  | "customer"
  | "prospect"
  | "artisan"
  | "supplier"
  | "partner"
  | "internal"
  | "automatic"
  | "newsletter"
  | "unknown";

/** Rôles qui peuvent alimenter les Blocs 1 et 2. */
export const CLIENT_ROLES: readonly SenderRole[] = ["customer", "prospect"];

/** Rôles exclus de façon certaine, avant toute analyse d'intention. */
export const EXCLUDED_ROLES: readonly SenderRole[] = [
  "artisan",
  "supplier",
  "partner",
  "internal",
  "automatic",
  "newsletter",
];

export type SenderQualification = {
  role: SenderRole;
  /** Vrai quand le rôle est établi par un fait (règle certaine ou Salesforce). */
  certain: boolean;
  /** Phrase courte et vérifiable. Jamais affichée au manager. */
  reason: string;
};

/** Ce que l'annuaire Salesforce sait de L'ADRESSE de l'expéditeur. */
export type SenderDirectory = {
  /** `resolved_kind` de `mail_directory`. */
  kind: string;
  /** Type d'enregistrement du Contact Salesforce, s'il existe. */
  contactRecordType?: string | null;
  /** Type d'enregistrement de la Piste Salesforce, s'il existe. */
  leadRecordType?: string | null;
};

export type SenderInput = {
  fromEmail: string;
  fromName?: string | null;
  subject?: string | null;
  /** Extrait ou corps : sert seulement à reconnaître une réponse automatique. */
  text?: string | null;
  /** En-tête d'envoi en masse hors liste interne. */
  bulk?: boolean;
  internalDomain: string;
  /** Annuaire pour l'adresse de l'expéditeur, s'il existe. */
  directory?: SenderDirectory | null;
  /** L'adresse de l'expéditeur est l'email client d'une opportunité du pipe. */
  isOpportunityClientEmail?: boolean;
  /**
   * Le nom ou la partie locale de l'expéditeur concorde avec le client de
   * l'affaire du fil (prénom + nom, ou patronyme ≥ 5 lettres).
   */
  nameMatchesDealClient?: boolean;
};

const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const localOf = (email: string) => lower(email).split("@")[0] ?? "";
const domainOf = (email: string) => lower(email).split("@")[1] ?? "";

/** Automates par la partie locale de l'adresse. */
const AUTOMATIC_LOCAL =
  /^(no[.\-_]?reply|noreply|donotreply|do[.\-_]not[.\-_]reply|ne[.\-_]?pas[.\-_]?repondre|notifications?|notify|mailer[.\-_]?daemon|postmaster|chatter|calendar-notification|[a-z0-9.\-_]*-noreply|bounce[s]?|automated|alerts?|commandesnoreply)([.\-_+]|$)/i;

/** Notifications d'outils : la voix d'un système, jamais du client. */
const TOOL_DOMAIN =
  /(^|\.)(docs\.google\.com|trello\.com|docusign\.net|docusign\.com|notion\.com|slack\.com|go-kelvin\.com|pennylane\.com|tiime\.fr|calendly\.com|hubspot\.com|salesforce\.com|qobra\.co)$/i;

/** Objet d'une réponse d'agenda : générée par le calendrier, pas écrite. */
const CALENDAR_REPLY =
  /^(accepted|accept[ée]|declined|refus[ée]|tentative|accept[ée] provisoirement|nouvel horaire propos[ée]|invitation|invitation mise [àa] jour|updated invitation)\s*:/i;

/** Fournisseurs et négoces : ils vendent à RM ou aux artisans, jamais le contraire. */
const SUPPLIER_DOMAIN =
  /(^|\.)(pointp\.fr|theogam\.fr|jeldwen\.com|jeld-wen\.fr|leroymerlin\.fr|castorama\.fr|cedeo\.fr|brico[a-z]*\.fr|lapeyre\.fr|plum-living\.com|plumliving\.com|tollens\.fr|zolpan\.fr|richard-diffusion\.fr|atlantiqueouvertures\.com|atlouv\.fr|kiloutou\.fr|loxam\.fr|gedimat\.fr|bigmat\.fr|dispano\.fr|sfic\.fr|rexel\.fr|sonepar\.fr)$/i;

/** Prescripteurs : agents immobiliers, réseaux d'apporteurs. Partenaires, pas clients. */
const PRESCRIBER_DOMAIN =
  /(^|\.)(iadfrance\.fr|safti\.fr|capifrance\.fr|optimhome\.com|megagence\.com|hosman\.co|proprietes-privees\.com|telemaque-renovation\.fr)$/i;

/**
 * Domaines de métier du bâtiment et de la maîtrise d'œuvre. Un client peut
 * écrire depuis l'adresse de son entreprise : ce signal ne joue donc qu'APRÈS
 * l'identification Salesforce, jamais contre elle.
 */
const TRADE_DOMAIN =
  /^[a-z0-9-]*(batiment|construction|renovation|renov|habitat|artisan|menuiserie|charpent|couvert|plomb|electric|elec-|peinture|carrelage|archi|atelier|ixina|cuisine|maitrise|ingenierie|bureau-?etude|bet-|isolation|chauffage|thermi|maconnerie|tce)[a-z0-9-]*\./i;

/** Type d'enregistrement Salesforce → rôle. `null` = « Client » ou inconnu : à trancher plus loin. */
function roleOfRecordType(recordType: string | null | undefined): SenderRole | null {
  const rt = lower(recordType).normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!rt) return null;
  if (rt === "artisan") return "artisan";
  if (rt === "moe" || rt.includes("maitre d") || rt.includes("architecte")) return "partner";
  if (rt.includes("apporteur") || rt.includes("partenaire") || rt.includes("prescripteur")) return "partner";
  if (rt.includes("fournisseur")) return "supplier";
  return null;
}

const CLIENT_KINDS = new Set(["affaire_pipe", "affaire_hors_pipe", "affaire_fermee"]);

/** Justifications d'un rôle client PROBABLE (non certain) — le modèle peut alors le corriger. */
const REASON_CONTACT_CLIENT = "contact Salesforce de type Client, sans affaire";
const REASON_NAME_MATCH = "nom conforme au client de l'affaire du fil";

/**
 * Rôle relu en base : est-il certain ? Seules deux justifications de client
 * sont probables ; tout le reste est un fait (règle certaine ou Salesforce).
 */
export function isCertainRole(role: string | null | undefined, reason: string | null | undefined): boolean {
  if (!role || role === "unknown") return false;
  if (reason === "lu par le modèle") return false;
  return reason !== REASON_CONTACT_CLIENT && reason !== REASON_NAME_MATCH;
}

export function qualifySender(input: SenderInput): SenderQualification {
  const email = lower(input.fromEmail);
  const domain = domainOf(email);
  const local = localOf(email);
  const subject = input.subject ?? "";

  // --- 1. Exclusions déterministes certaines.
  if (domain && domain === lower(input.internalDomain)) {
    return { role: "internal", certain: true, reason: "adresse de l'entreprise" };
  }
  if (AUTOMATIC_LOCAL.test(local)) {
    return { role: "automatic", certain: true, reason: "adresse d'automate (no-reply, notification)" };
  }
  if (isAutomaticReply({ from: email, subject, snippet: input.text ?? "" })) {
    return { role: "automatic", certain: true, reason: "réponse automatique ou défi anti-spam" };
  }
  if (TOOL_DOMAIN.test(domain)) {
    return { role: "automatic", certain: true, reason: "notification d'un outil tiers" };
  }
  if (CALENDAR_REPLY.test(subject.trim())) {
    return { role: "automatic", certain: true, reason: "réponse d'agenda générée" };
  }
  if (input.bulk || isNoiseDomain(email)) {
    return { role: "newsletter", certain: true, reason: "envoi en masse ou domaine sans enjeu commercial" };
  }

  // --- 2. Rôle canonique Salesforce de l'adresse.
  const dir = input.directory ?? null;
  const fromRecord = roleOfRecordType(dir?.contactRecordType) ?? roleOfRecordType(dir?.leadRecordType);
  if (fromRecord) {
    return {
      role: fromRecord,
      certain: true,
      reason: `Salesforce : ${dir?.contactRecordType ?? dir?.leadRecordType}`,
    };
  }

  // --- 3. Client ou prospect identifié par SA PROPRE adresse.
  if (input.isOpportunityClientEmail) {
    return { role: "customer", certain: true, reason: "adresse client d'une opportunité" };
  }
  if (dir && CLIENT_KINDS.has(dir.kind)) {
    return { role: "customer", certain: true, reason: "adresse rattachée à une opportunité Salesforce" };
  }
  if (dir && dir.kind === "piste") {
    return { role: "prospect", certain: true, reason: "adresse d'une piste Salesforce" };
  }
  if (dir && dir.kind === "contact" && lower(dir.contactRecordType) === "client") {
    return { role: "customer", certain: false, reason: REASON_CONTACT_CLIENT };
  }

  // --- 4. Domaines connus.
  if (SUPPLIER_DOMAIN.test(domain)) {
    return { role: "supplier", certain: true, reason: "domaine de fournisseur ou de négoce" };
  }
  if (PRESCRIBER_DOMAIN.test(domain)) {
    return { role: "partner", certain: true, reason: "domaine de prescripteur (agence, apporteur)" };
  }
  if (TRADE_DOMAIN.test(domain) || /\.archi$/.test(domain)) {
    return { role: "artisan", certain: false, reason: "domaine de métier du bâtiment, inconnu comme client" };
  }

  // --- 5. Fil client, et l'expéditeur porte le nom du client de l'affaire.
  if (input.nameMatchesDealClient) {
    return { role: "customer", certain: false, reason: REASON_NAME_MATCH };
  }

  // --- 6. Contact Salesforce sans type ni affaire : rien ne prouve un client.
  if (dir && dir.kind === "contact") {
    return { role: "unknown", certain: false, reason: "contact Salesforce sans affaire ni type" };
  }
  return { role: "unknown", certain: false, reason: "adresse inconnue de Salesforce" };
}

/**
 * Qualifie l'expéditeur d'un message à partir de ce que la synchronisation et
 * le rattachement savent : l'annuaire POUR SON ADRESSE, les adresses clients du
 * pipe, et l'affaire du fil (pour la seule concordance de nom). Partagé par la
 * synchronisation Gmail et par la relance du rattachement : une seule règle.
 */
export function qualifyMessageSender(input: {
  fromEmail: string;
  fromName?: string | null;
  subject?: string | null;
  snippet?: string | null;
  bulk?: boolean;
  internalDomain: string;
  directory?: Map<string, SenderDirectory> | null;
  /** Adresses clients des opportunités du pipe, en minuscules. */
  opportunityClientEmails: ReadonlySet<string>;
  /** Affaire désignée par le rattachement (fil, adresse, annuaire), s'il y en a une. */
  dealOpportunity?: MatchableOpportunity | null;
  /** Nom de l'affaire ou de la piste désignée, quand l'opportunité n'est pas dans le pipe local. */
  dealPersonName?: string | null;
}): SenderQualification {
  const email = lower(input.fromEmail);
  const client = input.dealOpportunity ? personName(input.dealOpportunity) : (input.dealPersonName ?? "");
  const nameMatchesDealClient = client
    ? nameAgrees(client, input.fromName ?? "", localOf(email).replace(/[._\-+]+/g, " ")) != null
    : false;
  return qualifySender({
    fromEmail: email,
    fromName: input.fromName,
    subject: input.subject,
    text: input.snippet,
    bulk: input.bulk,
    internalDomain: input.internalDomain,
    directory: input.directory?.get(email) ?? null,
    isOpportunityClientEmail: input.opportunityClientEmails.has(email),
    nameMatchesDealClient,
  });
}

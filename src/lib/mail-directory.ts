/**
 * Annuaire des adresses vues dans Gmail, résolues vers Salesforce.
 *
 * POURQUOI CETTE COUCHE EXISTE. La table `opportunity` ne contient que le pipe
 * courant — 348 lignes en périmètre pré-signature. L'audit C13 a montré que sur
 * 25 messages non rattachés, AUCUN ne concernait une affaire du pipe : ils
 * parlaient de chantiers en cours, de projets terminés, de pistes non converties,
 * ou venaient d'artisans et de fournisseurs. Le moteur n'avait donc rien manqué —
 * il lui manquait les données pour savoir de qui il s'agissait.
 *
 * Cet annuaire va chercher, POUR LES SEULES ADRESSES RÉELLEMENT VUES, ce que
 * Salesforce sait : une Piste, un Contact, une Opportunité, et son état. Ciblé et
 * non exhaustif : l'org compte 86 000 pistes et 37 650 contacts, et les résoudre
 * toutes n'apporterait rien de plus.
 *
 * `resolved_kind` porte l'information décisive pour Morning : une affaire signée
 * en chantier n'est pas du pipe à aller chercher, et ne doit jamais être présentée
 * comme telle.
 *
 * LECTURE SEULE Salesforce. Écrit uniquement dans `mail_directory`.
 */

import { getDb } from "./db";
import { INTERNAL_DOMAIN } from "./mail-rules";
import { matchTeamMember } from "./normalize";
import { runSoql } from "./sources/api-salesforce";

/** Ce que l'adresse désigne, du plus exploitable au moins exploitable. */
export type ResolvedKind =
  /** Affaire du pipe courant : Morning peut en exploiter GMV, étape, Expected. */
  | "affaire_pipe"
  /** Affaire signée, en chantier ou livrée. Identifiée, mais hors du pipe. */
  | "affaire_hors_pipe"
  /** Affaire perdue ou projet clos. */
  | "affaire_fermee"
  /** Piste encore ouverte, jamais convertie. */
  | "piste"
  /** Contact connu, sans affaire rattachable. */
  | "contact"
  /** Plusieurs affaires possibles, aucune ne se détache. */
  | "ambigu"
  /** Ni piste, ni contact : très probablement pas un client. */
  | "inconnu";

export type DirectoryEntry = {
  email: string;
  kind: ResolvedKind;
  confidence: "certain" | "probable" | "a_verifier";
  reason: string;
  opportunityId: string | null;
  opportunityName: string | null;
  opportunityStage: string | null;
  opportunityIsClosed: boolean;
  opportunityAmount: number | null;
  opportunityOwner: string | null;
  leadId: string | null;
  leadName: string | null;
  leadOwner: string | null;
  leadStatus: string | null;
  contactId: string | null;
  contactName: string | null;
  candidates: string[];
};

type SfLead = {
  Id: string;
  Email: string | null;
  Name: string | null;
  Status: string | null;
  IsConverted: boolean;
  ConvertedOpportunityId: string | null;
  Owner?: { Name?: string };
};

type SfContact = { Id: string; Email: string | null; Name: string | null };
type SfRole = { OpportunityId: string; ContactId: string };
type SfOpportunity = {
  Id: string;
  Name: string | null;
  StageName: string | null;
  IsClosed: boolean;
  Amount: number | null;
  CreatedDate: string | null;
  Owner?: { Name?: string };
};

const quote = (v: string) => `'${v.replace(/'/g, "")}'`;
const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Adresses à résoudre : celles vues dans Gmail et pas encore dans l'annuaire, plus
 * celles dont la résolution est trop ancienne pour être fiable.
 */
export function addressesToResolve(maxAgeHours = 24): string[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT lower(s.from_email) AS email
         FROM mail_signal s
         LEFT JOIN mail_directory d ON d.email = lower(s.from_email)
        WHERE s.from_email IS NOT NULL AND s.from_email <> ''
          AND (d.email IS NULL OR d.refreshed_at < ?)`,
    )
    .all(cutoff) as { email: string }[];
  // Les adresses de l'entreprise ne sont jamais des clients. Sans ce filtre, un
  // commercial figurant par ailleurs comme Contact dans Salesforce se retrouvait
  // résolu en « affaire close » — observé sur une adresse interne en C13.
  return rows
    .map((r) => r.email)
    .filter((e) => e && !e.endsWith(`@${INTERNAL_DOMAIN}`));
}

export type DirectoryRefresh = {
  requested: number;
  resolved: number;
  byKind: Record<string, number>;
};

/**
 * Interroge Salesforce pour les adresses données et met l'annuaire à jour.
 *
 * Trois requêtes par lot d'adresses, plus une pour l'état des opportunités
 * atteignables. Le volume reste faible : quelques dizaines d'adresses par
 * semaine.
 */
export async function refreshDirectory(emails: string[]): Promise<DirectoryRefresh> {
  const byKind: Record<string, number> = {};
  if (emails.length === 0) return { requested: 0, resolved: 0, byKind };

  const leads: SfLead[] = [];
  const contacts: SfContact[] = [];
  for (const batch of chunk(emails, 150)) {
    const list = batch.map(quote).join(",");
    leads.push(
      ...(await runSoql<SfLead>(
        `SELECT Id, Email, Name, Status, IsConverted, ConvertedOpportunityId, Owner.Name
           FROM Lead WHERE Email IN (${list})`,
      )),
    );
    contacts.push(
      ...(await runSoql<SfContact>(`SELECT Id, Email, Name FROM Contact WHERE Email IN (${list})`)),
    );
  }

  // La chaîne relationnelle : Contact → OpportunityContactRole → Opportunity.
  const roles: SfRole[] = [];
  for (const batch of chunk(contacts.map((c) => c.Id), 150)) {
    if (batch.length === 0) continue;
    roles.push(
      ...(await runSoql<SfRole>(
        `SELECT OpportunityId, ContactId FROM OpportunityContactRole
           WHERE ContactId IN (${batch.map(quote).join(",")})`,
      )),
    );
  }

  const oppIds = new Set<string>();
  for (const l of leads) if (l.ConvertedOpportunityId) oppIds.add(l.ConvertedOpportunityId);
  for (const r of roles) oppIds.add(r.OpportunityId);

  const opportunities: SfOpportunity[] = [];
  for (const batch of chunk([...oppIds], 150)) {
    if (batch.length === 0) continue;
    opportunities.push(
      ...(await runSoql<SfOpportunity>(
        `SELECT Id, Name, StageName, IsClosed, Amount, CreatedDate, Owner.Name
           FROM Opportunity WHERE Id IN (${batch.map(quote).join(",")})`,
      )),
    );
  }

  const db = getDb();
  const inPipe = new Set(
    (db.prepare("SELECT opportunity_id id FROM opportunity WHERE is_terminal = 0").all() as {
      id: string;
    }[]).map((r) => r.id),
  );
  const oppById = new Map(opportunities.map((o) => [o.Id, o]));
  const leadsByEmail = new Map<string, SfLead[]>();
  for (const l of leads) {
    const k = (l.Email ?? "").toLowerCase();
    if (!k) continue;
    if (!leadsByEmail.has(k)) leadsByEmail.set(k, []);
    leadsByEmail.get(k)!.push(l);
  }
  const contactByEmail = new Map(
    contacts.filter((c) => c.Email).map((c) => [c.Email!.toLowerCase(), c]),
  );
  const oppsByContact = new Map<string, string[]>();
  for (const r of roles) {
    if (!oppsByContact.has(r.ContactId)) oppsByContact.set(r.ContactId, []);
    oppsByContact.get(r.ContactId)!.push(r.OpportunityId);
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO mail_directory
       (email, resolved_kind, confidence, reason, opportunity_id, opportunity_name,
        opportunity_stage, opportunity_is_closed, opportunity_amount, opportunity_owner,
        lead_id, lead_name, lead_owner, lead_status, contact_id, contact_name,
        candidates, first_seen_at, refreshed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET
       resolved_kind = excluded.resolved_kind, confidence = excluded.confidence,
       reason = excluded.reason, opportunity_id = excluded.opportunity_id,
       opportunity_name = excluded.opportunity_name, opportunity_stage = excluded.opportunity_stage,
       opportunity_is_closed = excluded.opportunity_is_closed,
       opportunity_amount = excluded.opportunity_amount,
       opportunity_owner = excluded.opportunity_owner,
       lead_id = excluded.lead_id, lead_name = excluded.lead_name,
       lead_owner = excluded.lead_owner, lead_status = excluded.lead_status,
       contact_id = excluded.contact_id, contact_name = excluded.contact_name,
       candidates = excluded.candidates, refreshed_at = excluded.refreshed_at`,
  );

  db.exec("BEGIN");
  try {
    for (const email of emails) {
      const entry = resolve(email, {
        leads: leadsByEmail.get(email) ?? [],
        contact: contactByEmail.get(email) ?? null,
        oppsByContact,
        oppById,
        inPipe,
      });
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      upsert.run(
        entry.email,
        entry.kind,
        entry.confidence,
        entry.reason,
        entry.opportunityId,
        entry.opportunityName,
        entry.opportunityStage,
        entry.opportunityIsClosed ? 1 : 0,
        entry.opportunityAmount,
        entry.opportunityOwner,
        entry.leadId,
        entry.leadName,
        entry.leadOwner,
        entry.leadStatus,
        entry.contactId,
        entry.contactName,
        JSON.stringify(entry.candidates),
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { requested: emails.length, resolved: emails.length, byKind };
}

/**
 * Choisit ce que l'adresse désigne.
 *
 * Ordre de préférence, et c'est le cœur de la règle : une affaire du PIPE l'emporte
 * toujours sur une affaire signée, qui l'emporte sur une affaire fermée. Une
 * affaire ancienne ou close ne prend jamais le dessus sur une affaire ouverte —
 * sans cela, un client qui écrit pour un nouveau projet verrait son message
 * rattaché à son chantier de 2022.
 */
function resolve(
  email: string,
  ctx: {
    leads: SfLead[];
    contact: SfContact | null;
    oppsByContact: Map<string, string[]>;
    oppById: Map<string, SfOpportunity>;
    inPipe: Set<string>;
  },
): DirectoryEntry {
  const base: DirectoryEntry = {
    email,
    kind: "inconnu",
    confidence: "a_verifier",
    reason: "aucune piste et aucun contact ne porte cette adresse",
    opportunityId: null,
    opportunityName: null,
    opportunityStage: null,
    opportunityIsClosed: false,
    opportunityAmount: null,
    opportunityOwner: null,
    leadId: null,
    leadName: null,
    leadOwner: null,
    leadStatus: null,
    contactId: null,
    contactName: null,
    candidates: [],
  };

  if (ctx.contact) {
    base.contactId = ctx.contact.Id;
    base.contactName = ctx.contact.Name;
  }

  // Toutes les opportunités atteignables, dédoublonnées.
  const reachable = new Set<string>();
  for (const l of ctx.leads) if (l.ConvertedOpportunityId) reachable.add(l.ConvertedOpportunityId);
  if (ctx.contact) for (const id of ctx.oppsByContact.get(ctx.contact.Id) ?? []) reachable.add(id);
  const opps = [...reachable].map((id) => ctx.oppById.get(id)).filter(Boolean) as SfOpportunity[];

  const recent = (a: SfOpportunity, b: SfOpportunity) =>
    String(b.CreatedDate ?? "").localeCompare(String(a.CreatedDate ?? ""));
  const pipe = opps.filter((o) => ctx.inPipe.has(o.Id.slice(0, 15))).sort(recent);
  const openOutside = opps
    .filter((o) => !o.IsClosed && !ctx.inPipe.has(o.Id.slice(0, 15)))
    .sort(recent);
  const closed = opps.filter((o) => o.IsClosed).sort(recent);

  const attach = (o: SfOpportunity, kind: ResolvedKind, reason: string, others: SfOpportunity[]) => ({
    ...base,
    kind,
    confidence: others.length > 1 ? ("a_verifier" as const) : ("certain" as const),
    reason,
    opportunityId: o.Id.slice(0, 15),
    opportunityName: o.Name,
    opportunityStage: o.StageName,
    opportunityIsClosed: o.IsClosed,
    opportunityAmount: o.Amount,
    opportunityOwner: matchTeamMember(o.Owner?.Name ?? null)?.name ?? o.Owner?.Name ?? null,
    candidates: others.map((x) => x.Id.slice(0, 15)),
    leadId: ctx.leads[0]?.Id ?? null,
    leadName: ctx.leads[0]?.Name ?? null,
    leadOwner: matchTeamMember(ctx.leads[0]?.Owner?.Name ?? null)?.name ?? null,
    leadStatus: ctx.leads[0]?.Status ?? null,
  });

  if (pipe.length > 0) {
    return attach(
      pipe[0],
      "affaire_pipe",
      pipe.length > 1
        ? `${pipe.length} affaires ouvertes portent cette adresse`
        : "adresse rattachée à une affaire du pipe",
      pipe,
    );
  }
  if (openOutside.length > 0) {
    return attach(
      openOutside[0],
      "affaire_hors_pipe",
      `affaire signée, hors pipe (${openOutside[0].StageName ?? "étape inconnue"})`,
      openOutside,
    );
  }
  if (closed.length > 0) {
    return attach(
      closed[0],
      "affaire_fermee",
      `affaire close (${closed[0].StageName ?? "étape inconnue"})`,
      closed,
    );
  }

  // Aucune opportunité : reste la piste, puis le contact.
  const openLeads = ctx.leads.filter((l) => !l.IsConverted);
  if (openLeads.length > 0) {
    const l = openLeads[0];
    return {
      ...base,
      kind: "piste",
      confidence: openLeads.length === 1 ? "certain" : "a_verifier",
      reason:
        openLeads.length === 1
          ? `piste ${l.Status ?? ""}`.trim()
          : `${openLeads.length} pistes portent cette adresse`,
      leadId: l.Id,
      leadName: l.Name,
      leadOwner: matchTeamMember(l.Owner?.Name ?? null)?.name ?? null,
      leadStatus: l.Status,
      candidates: openLeads.map((x) => x.Id),
    };
  }
  if (ctx.leads.length > 0) {
    const l = ctx.leads[0];
    return {
      ...base,
      kind: "contact",
      confidence: "certain",
      reason: "piste convertie, sans affaire retrouvée",
      leadId: l.Id,
      leadName: l.Name,
      leadOwner: matchTeamMember(l.Owner?.Name ?? null)?.name ?? null,
      leadStatus: l.Status,
    };
  }
  if (ctx.contact) {
    return { ...base, kind: "contact", confidence: "certain", reason: "contact connu, sans affaire" };
  }
  return base;
}

/** Lit l'annuaire en mémoire, indexé par adresse. */
export function loadDirectory(): Map<string, DirectoryEntry> {
  const rows = getDb().prepare("SELECT * FROM mail_directory").all() as Record<string, unknown>[];
  const out = new Map<string, DirectoryEntry>();
  for (const r of rows) {
    out.set(String(r.email), {
      email: String(r.email),
      kind: String(r.resolved_kind) as ResolvedKind,
      confidence: String(r.confidence) as DirectoryEntry["confidence"],
      reason: String(r.reason),
      opportunityId: (r.opportunity_id as string | null) ?? null,
      opportunityName: (r.opportunity_name as string | null) ?? null,
      opportunityStage: (r.opportunity_stage as string | null) ?? null,
      opportunityIsClosed: r.opportunity_is_closed === 1,
      opportunityAmount: (r.opportunity_amount as number | null) ?? null,
      opportunityOwner: (r.opportunity_owner as string | null) ?? null,
      leadId: (r.lead_id as string | null) ?? null,
      leadName: (r.lead_name as string | null) ?? null,
      leadOwner: (r.lead_owner as string | null) ?? null,
      leadStatus: (r.lead_status as string | null) ?? null,
      contactId: (r.contact_id as string | null) ?? null,
      contactName: (r.contact_name as string | null) ?? null,
      candidates: JSON.parse(String(r.candidates ?? "[]")) as string[],
    });
  }
  return out;
}

/**
 * Source Salesforce des pistes — LECTURE SEULE.
 *
 * Trois lectures, aucune écriture :
 *   1. les `Lead` de l'équipe sur la fenêtre d'import, avec leurs `Event` ;
 *   2. les `Task` de ces pistes, par lots (la clause IN a une limite).
 *
 * L'authentification est déléguée à la CLI Salesforce déjà connectée, comme
 * pour les opportunités : RM Morning ne détient ni ne journalise aucun jeton.
 */

import { LEAD_MONITORING } from "../config";
import { runSoql } from "./api-salesforce";
import type { LeadEvent, LeadTask } from "../lead-rules";

export type RawLead = {
  leadId: string;
  name: string | null;
  ownerRaw: string;
  status: string;
  /** Adresse de la piste. C13 : elle existe dans Salesforce et n'était pas lue. */
  email: string | null;
  createdAt: string;
  recallDate: string | null;
  convertedDate: string | null;
  convertedOpportunityId: string | null;
  abandonedAt: string | null;
  abandonReason: string | null;
  acquisitionChannel: string | null;
  service: string | null;
  postalCode: string | null;
  city: string | null;
  events: LeadEvent[];
  tasks: LeadTask[];
};

type SfLead = {
  Id: string;
  Name: string | null;
  Email: string | null;
  Status: string;
  CreatedDate: string;
  ARecontacter__c: string | null;
  ConvertedDate: string | null;
  ConvertedOpportunityId: string | null;
  Date_d_abandon_de_la_piste__c: string | null;
  Raison_de_l_abandon_de_la_piste__c: string | null;
  Canal_d_acquisition__c: string | null;
  Prestation__c: string | null;
  PostalCode: string | null;
  City: string | null;
  Owner?: { Name?: string };
  Events?: { records?: SfEvent[] };
};

type SfEvent = { StartDateTime: string | null; IsAllDayEvent: boolean; Subject: string | null };

type SfTask = {
  WhoId: string;
  Subject: string | null;
  Description: string | null;
  TaskSubtype: string | null;
  CreatedDate: string;
  CompletedDateTime: string | null;
  OwnerId: string | null;
};

const quote = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(",");

/** Noms d'agents Salesforce du périmètre, alias compris. */
export function salesforceOwnerNames(
  team: readonly { name: string; aliases?: string[] }[],
): string[] {
  return team.flatMap((m) => [m.name, ...(m.aliases ?? [])]);
}

export async function fetchLeads(ownerNames: string[]): Promise<RawLead[]> {
  const soql =
    "SELECT Id, Name, Email, Status, Owner.Name, CreatedDate, ARecontacter__c, ConvertedDate, " +
    "ConvertedOpportunityId, Date_d_abandon_de_la_piste__c, Raison_de_l_abandon_de_la_piste__c, " +
    "Canal_d_acquisition__c, Prestation__c, PostalCode, City, " +
    "(SELECT StartDateTime, IsAllDayEvent, Subject FROM Events) " +
    `FROM Lead WHERE CreatedDate = LAST_N_DAYS:${LEAD_MONITORING.importWindowDays} ` +
    `AND Owner.Name IN (${quote(ownerNames)}) ORDER BY CreatedDate DESC`;

  const leads = await runSoql<SfLead>(soql);

  // Les tâches ne peuvent pas être ramenées en sous-requête (limite de
  // profondeur SOQL) : on les récupère par lots d'identifiants.
  const tasksByLead = await fetchTasks(leads.map((l) => l.Id));

  return leads.map((l) => ({
    leadId: l.Id,
    name: l.Name,
    email: l.Email,
    ownerRaw: l.Owner?.Name ?? "",
    status: l.Status,
    createdAt: l.CreatedDate,
    recallDate: l.ARecontacter__c,
    convertedDate: l.ConvertedDate,
    convertedOpportunityId: l.ConvertedOpportunityId,
    abandonedAt: l.Date_d_abandon_de_la_piste__c,
    abandonReason: l.Raison_de_l_abandon_de_la_piste__c,
    acquisitionChannel: l.Canal_d_acquisition__c,
    service: l.Prestation__c,
    postalCode: l.PostalCode,
    city: l.City,
    events: (l.Events?.records ?? [])
      .filter((e) => e.StartDateTime)
      .map((e) => ({
        startAt: e.StartDateTime as string,
        isAllDay: Boolean(e.IsAllDayEvent),
        subject: e.Subject,
      })),
    tasks: tasksByLead.get(l.Id) ?? [],
  }));
}

const TASK_BATCH = 300;

async function fetchTasks(leadIds: string[]): Promise<Map<string, LeadTask[]>> {
  const byLead = new Map<string, LeadTask[]>();
  for (let i = 0; i < leadIds.length; i += TASK_BATCH) {
    const batch = leadIds.slice(i, i + TASK_BATCH);
    if (batch.length === 0) continue;
    const rows = await runSoql<SfTask>(
      "SELECT WhoId, Subject, Description, TaskSubtype, CreatedDate, CompletedDateTime, OwnerId " +
        `FROM Task WHERE WhoId IN (${quote(batch)})`,
    );
    for (const t of rows) {
      const list = byLead.get(t.WhoId) ?? [];
      list.push({
        subtype: t.TaskSubtype,
        subject: t.Subject,
        description: t.Description,
        at: t.CompletedDateTime ?? t.CreatedDate,
        ownerId: t.OwnerId,
      });
      byLead.set(t.WhoId, list);
    }
  }
  return byLead;
}

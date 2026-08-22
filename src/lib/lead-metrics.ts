/**
 * KPI du Monitoring Pistes.
 *
 * Agrégations calculées à la volée depuis `lead` : à ce volume (quelques
 * milliers de lignes) une pré-agrégation n'apporterait rien et figerait des
 * définitions qu'on veut encore pouvoir discuter.
 *
 * Aucun score global : on expose des dimensions séparées et explicables. Un
 * écart doit poser une question, pas produire une condamnation — d'où la
 * présence systématique du volume traité à côté de chaque compteur.
 */

import { LEAD_MONITORING, TEAM } from "./config";
import { ANOMALY_STATUSES, type LeadOperationalStatus } from "./lead-rules";
import type { StoredLead } from "./lead-store";

export type Period = "7j" | "30j" | "mois";

export const PERIOD_LABEL: Record<Period, string> = {
  "7j": "7 jours",
  "30j": "30 jours",
  mois: "mois en cours",
};

export function periodStart(period: Period, reference = new Date()): Date {
  if (period === "mois") return new Date(reference.getFullYear(), reference.getMonth(), 1);
  const days = period === "7j" ? 7 : 30;
  return new Date(reference.getTime() - days * 864e5);
}

export type OwnerLeadMetrics = {
  owner: string;
  firstName: string;
  received: number;
  nouvelles: number;
  aConfirmer: number;
  converted: number;
  abandoned: number;
  conversionRate: number | null;
  firstCallsPlanned: number;
  firstCallsPast: number;
  firstCallsConsigned: number;
  firstCallsMissed: number;
  dueFuture: number;
  dueOverdue: number;
  dueOverdueCompliant: number;
  dueOverdueLate: number;
  dueOverdueCritical: number;
  withoutAppointment: number;
  medianCreationToFirstCallHours: number | null;
  medianFirstCallToActionHours: number | null;
  legacyBacklog: number;
  newExceptions: number;
  /** Verdict explicable, jamais une note. */
  state: "sain" | "à surveiller" | "action requise";
  stateReason: string;
};

export type TeamLeadMetrics = {
  period: Period;
  periodLabel: string;
  received: number;
  open: number;
  converted: number;
  conversionRate: number | null;
  newExceptions: number;
  legacyBacklog: number;
  firstCallsMissed: number;
  dueOverdue: number;
  withoutAppointment: number;
  medianCreationToFirstCallHours: number | null;
  owners: OwnerLeadMetrics[];
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const HOUR = 36e5;
const hoursBetween = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const delta = (new Date(b).getTime() - new Date(a).getTime()) / HOUR;
  return Number.isFinite(delta) ? delta : null;
};

const isAnomaly = (s: LeadOperationalStatus) => ANOMALY_STATUSES.includes(s);

/**
 * Verdict par commercial.
 *
 * Trois règles seulement, toutes visibles à l'écran, et toutes ramenées au
 * volume reçu : 3 manquements sur 15 pistes n'est pas 3 sur 150.
 */
function verdict(m: Omit<OwnerLeadMetrics, "state" | "stateReason">): {
  state: OwnerLeadMetrics["state"];
  stateReason: string;
} {
  const live = m.newExceptions;
  const rate = m.received > 0 ? live / m.received : 0;

  if (m.firstCallsMissed >= 3 || (live >= 5 && rate > 0.15)) {
    return {
      state: "action requise",
      stateReason:
        m.firstCallsMissed >= 3
          ? `${m.firstCallsMissed} First Calls passés sans consignation`
          : `${live} exceptions nouvelles sur ${m.received} pistes reçues`,
    };
  }
  if (m.firstCallsMissed > 0 || live >= 2) {
    return {
      state: "à surveiller",
      stateReason:
        m.firstCallsMissed > 0
          ? `${m.firstCallsMissed} First Call sans consignation`
          : `${live} exceptions nouvelles`,
    };
  }
  return { state: "sain", stateReason: "échéances respectées sur la période" };
}

export function computeLeadMetrics(
  leads: StoredLead[],
  period: Period,
  reference = new Date(),
): TeamLeadMetrics {
  const from = periodStart(period, reference).getTime();
  const inPeriod = leads.filter((l) => new Date(l.createdAt).getTime() >= from);
  const now = reference.getTime();

  const owners: OwnerLeadMetrics[] = TEAM.map((member) => {
    const mine = inPeriod.filter((l) => l.owner === member.name);
    // Les anomalies se comptent sur le stock ouvert, pas sur la seule période :
    // une piste de mars encore en retard reste un problème aujourd'hui.
    const mineAll = leads.filter((l) => l.owner === member.name);

    const converted = mine.filter((l) => l.operationalStatus === "convertie").length;
    const firstCallsPast = mine.filter(
      (l) => l.firstCallAt && new Date(l.firstCallAt).getTime() < now,
    );
    // Une piste convertie ou abandonnée n'a plus d'échéance à tenir : la
    // compter gonflerait le chiffre sans rien signaler.
    const stillOpen = mineAll.filter(
      (l) => l.operationalStatus !== "convertie" && l.operationalStatus !== "abandonnee",
    );
    const overdue = stillOpen.filter(
      (l) => l.recallDate && new Date(`${l.recallDate}T23:59:59`).getTime() < now,
    );

    const base = {
      owner: member.name,
      firstName: member.firstName,
      received: mine.length,
      nouvelles: mine.filter((l) => l.status === "Nouvelle piste").length,
      aConfirmer: mine.filter((l) => l.status === "A confirmer").length,
      converted,
      abandoned: mine.filter((l) => l.operationalStatus === "abandonnee").length,
      conversionRate: mine.length > 0 ? converted / mine.length : null,
      firstCallsPlanned: mineAll.filter((l) => l.nextAppointmentAt).length,
      firstCallsPast: firstCallsPast.length,
      firstCallsConsigned: firstCallsPast.filter((l) => l.consignedAt).length,
      firstCallsMissed: mineAll.filter((l) => l.firstCallMissed).length,
      dueFuture: stillOpen.filter(
        (l) => l.recallDate && new Date(`${l.recallDate}T23:59:59`).getTime() >= now,
      ).length,
      dueOverdue: overdue.length,
      dueOverdueCompliant: overdue.filter((l) => !isAnomaly(l.operationalStatus)).length,
      dueOverdueLate: overdue.filter((l) => l.operationalStatus === "en_retard").length,
      dueOverdueCritical: overdue.filter((l) => l.operationalStatus === "critique").length,
      withoutAppointment: mineAll.filter((l) => l.operationalStatus === "sans_rendez_vous").length,
      medianCreationToFirstCallHours: median(
        mine
          .map((l) => hoursBetween(l.createdAt, l.firstCallAt))
          .filter((v): v is number => v !== null && v >= 0),
      ),
      medianFirstCallToActionHours: median(
        mine
          .map((l) => hoursBetween(l.firstCallAt, l.consignedAt))
          .filter((v): v is number => v !== null && v >= 0),
      ),
      legacyBacklog: mineAll.filter((l) => isAnomaly(l.operationalStatus) && l.isLegacy).length,
      newExceptions: mineAll.filter((l) => isAnomaly(l.operationalStatus) && !l.isLegacy).length,
    };

    return { ...base, ...verdict(base) };
  });

  const converted = inPeriod.filter((l) => l.operationalStatus === "convertie").length;

  return {
    period,
    periodLabel: PERIOD_LABEL[period],
    received: inPeriod.length,
    open: leads.filter(
      (l) => l.operationalStatus !== "convertie" && l.operationalStatus !== "abandonnee",
    ).length,
    converted,
    conversionRate: inPeriod.length > 0 ? converted / inPeriod.length : null,
    newExceptions: owners.reduce((s, o) => s + o.newExceptions, 0),
    legacyBacklog: owners.reduce((s, o) => s + o.legacyBacklog, 0),
    firstCallsMissed: owners.reduce((s, o) => s + o.firstCallsMissed, 0),
    dueOverdue: owners.reduce((s, o) => s + o.dueOverdueLate + o.dueOverdueCritical, 0),
    withoutAppointment: owners.reduce((s, o) => s + o.withoutAppointment, 0),
    medianCreationToFirstCallHours: median(
      inPeriod
        .map((l) => hoursBetween(l.createdAt, l.firstCallAt))
        .filter((v): v is number => v !== null && v >= 0),
    ),
    owners,
  };
}

export type TodoItem = {
  lead: StoredLead;
  priority: number;
  reason: string;
};

/**
 * Bloc « À traiter maintenant ».
 *
 * L'ordre suit la priorité métier : un First Call manqué récent passe avant
 * une dette de trois mois. La dette reste visible dans le tableau par
 * commercial, elle ne doit pas confisquer ce bloc — d'où le quota.
 */
export function buildLeadTodo(
  leads: StoredLead[],
  limit: number = LEAD_MONITORING.maxTodoItems,
): TodoItem[] {
  const candidates: TodoItem[] = [];

  for (const lead of leads) {
    if (!isAnomaly(lead.operationalStatus)) continue;
    const days = lead.latenessHours / 24;

    if (lead.firstCallMissed) {
      candidates.push({ lead, priority: days <= 7 ? 5 : 4, reason: "First Call sans consignation" });
    } else if (lead.operationalStatus === "a_traiter") {
      candidates.push({ lead, priority: 4.5, reason: "échéance dépassée" });
    } else if (lead.operationalStatus === "en_retard") {
      candidates.push({ lead, priority: 3.5, reason: "échéance dépassée depuis plus de 24 h" });
    } else if (lead.operationalStatus === "critique") {
      candidates.push({ lead, priority: lead.isLegacy ? 1.5 : 3, reason: "échéance très dépassée" });
    } else if (lead.operationalStatus === "sans_rendez_vous") {
      candidates.push({ lead, priority: lead.isLegacy ? 1 : 2, reason: "aucun rendez-vous programmé" });
    }
  }

  const byPriority = (a: TodoItem, b: TodoItem) =>
    b.priority - a.priority || b.lead.latenessHours - a.lead.latenessHours;

  // Les exceptions réellement observées passent d'abord et sans limite : ce
  // sont elles qui appellent une action aujourd'hui.
  const fresh = candidates.filter((c) => !c.lead.isLegacy).sort(byPriority);
  const legacy = candidates.filter((c) => c.lead.isLegacy).sort(byPriority);

  const picked = fresh.slice(0, limit);

  // La dette héritée complète les places restantes. Elle ne chasse jamais une
  // exception nouvelle, mais elle ne laisse pas non plus le bloc vide au
  // démarrage, quand tout le stock est par construction hérité.
  for (const c of legacy) {
    if (picked.length >= limit) break;
    picked.push(c);
  }
  return picked;
}

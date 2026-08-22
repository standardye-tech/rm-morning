/**
 * Règles opérationnelles des pistes.
 *
 * PRINCIPE CENTRAL, valable ici comme plus tard pour les opportunités :
 * le moteur ne juge JAMAIS l'inactivité brute. Il juge la séquence
 *
 *     un jalon devait avoir lieu
 *   + son échéance est passée
 *   + la suite attendue n'est pas constatée
 *
 * Une piste calme dont l'échéance est future est normale. Une piste très
 * active dont l'échéance est dépassée sans acte valide ne l'est pas.
 *
 * Ce qui vaut preuve, et ce qui n'en est pas :
 *   — `Task.Description` sur un sous-type `Call`/`Task` : consignation réelle ;
 *   — `Event.Description` : gabarit automatique, jamais une preuve ;
 *   — `LastActivityDate` : circulaire (le rendez-vous l'alimente), interdit ;
 *   — les e-mails automatiques : jamais une relance.
 *
 * Fichier autonome (aucun import) : les seuils sont injectés, de sorte qu'une
 * autre direction régionale puisse le réutiliser tel quel.
 */

export type LeadStatus = "Nouvelle piste" | "A confirmer" | "Convertie" | "Abandonnée";

/** État opérationnel calculé par RM Morning, distinct du statut Salesforce. */
export type LeadOperationalStatus =
  | "a_venir"
  | "normal"
  | "a_traiter"
  | "en_retard"
  | "critique"
  | "sans_rendez_vous"
  | "convertie"
  | "abandonnee";

export const OPERATIONAL_LABEL: Record<LeadOperationalStatus, string> = {
  a_venir: "À venir",
  normal: "Normal",
  a_traiter: "À traiter",
  en_retard: "En retard",
  critique: "Critique",
  sans_rendez_vous: "Sans rendez-vous",
  convertie: "Convertie",
  abandonnee: "Abandonnée",
};

/** Un état opérationnel qui appelle une intervention. */
export const ANOMALY_STATUSES: LeadOperationalStatus[] = [
  "a_traiter",
  "en_retard",
  "critique",
  "sans_rendez_vous",
];

export type LeadEvent = {
  startAt: string;
  isAllDay: boolean;
  subject: string | null;
};

export type LeadTask = {
  /** `Call`, `Task` ou `Email`. */
  subtype: string | null;
  subject: string | null;
  description: string | null;
  /** `CompletedDateTime`, à défaut `CreatedDate`. */
  at: string;
  ownerId: string | null;
};

export type LeadInput = {
  leadId: string;
  status: LeadStatus | string;
  createdAt: string;
  /** `ARecontacter__c` — échéance métier, posée à l'entrée en « A confirmer ». */
  recallDate: string | null;
  convertedDate: string | null;
  abandonedAt: string | null;
  events: LeadEvent[];
  tasks: LeadTask[];
};

export type LeadThresholds = {
  noAppointmentGraceHours: number;
  lateAfterHours: number;
  criticalAfterHours: number;
  automatedTaskPattern: RegExp;
  minConsignationLength: number;
};

export type LeadVerdict = {
  operationalStatus: LeadOperationalStatus;
  /** Phrase courte et vérifiable expliquant le verdict. */
  reason: string;
  /** Retard en heures par rapport à l'échéance manquée. 0 si aucun retard. */
  latenessHours: number;
  /** Premier rendez-vous horodaté, passé ou futur. */
  firstCallAt: string | null;
  /** Prochain vrai créneau à venir : le seul bouclier reconnu. */
  nextAppointmentAt: string | null;
  /** Consignation du First Call, si elle existe. */
  consignedAt: string | null;
  consignedBy: string | null;
  /** Dernière action humaine valide constatée. */
  lastValidActionAt: string | null;
  /** Le First Call est-il passé sans consignation, piste encore « Nouvelle » ? */
  firstCallMissed: boolean;
};

const ms = (v: string | null) => (v ? new Date(v).getTime() : null);
/** Une date seule vaut jusqu'à la fin de sa journée : l'échéance n'expire pas à minuit. */
const endOfDay = (v: string | null) => (v ? new Date(`${v}T23:59:59`).getTime() : null);
const HOUR = 36e5;

/** Rendez-vous réels : un événement « toute la journée » n'est pas un créneau. */
function timedEvents(lead: LeadInput): LeadEvent[] {
  return lead.events
    .filter((e) => e.startAt && !e.isAllDay)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/**
 * Acte humain valide. Un e-mail ne compte que s'il est commercial : les envois
 * automatiques de la plateforme représentent la moitié du volume et ne
 * prouvent aucun traitement.
 */
export function isValidAction(task: LeadTask, thresholds: LeadThresholds): boolean {
  if (task.subtype === "Call" || task.subtype === "Task") return true;
  if (task.subtype === "Email") return !thresholds.automatedTaskPattern.test(task.subject ?? "");
  return false;
}

/** Consignation : un acte humain porteur d'un compte rendu écrit. */
export function isConsignation(task: LeadTask, thresholds: LeadThresholds): boolean {
  if (task.subtype !== "Call" && task.subtype !== "Task") return false;
  return (task.description ?? "").trim().length >= thresholds.minConsignationLength;
}

/**
 * Verdict opérationnel d'une piste.
 *
 * L'ordre des tests EST la règle métier : issue définitive, puis bouclier,
 * puis First Call manqué, puis échéance, puis absence de rendez-vous.
 */
export function evaluateLead(
  lead: LeadInput,
  thresholds: LeadThresholds,
  now: number = Date.now(),
): LeadVerdict {
  const events = timedEvents(lead);
  const firstCall = events[0] ?? null;
  const firstCallAt = firstCall?.startAt ?? null;
  const nextAppointment = events.find((e) => (ms(e.startAt) ?? 0) > now) ?? null;

  const consignationTask = lead.tasks
    .filter((t) => isConsignation(t, thresholds))
    .sort((a, b) => a.at.localeCompare(b.at))
    .find((t) => !firstCallAt || (ms(t.at) ?? 0) > (ms(firstCallAt) ?? 0) - 2 * HOUR);

  const validActions = lead.tasks
    .filter((t) => isValidAction(t, thresholds))
    .sort((a, b) => a.at.localeCompare(b.at));
  const lastValidActionAt = validActions.length ? validActions[validActions.length - 1].at : null;

  const base = {
    firstCallAt,
    nextAppointmentAt: nextAppointment?.startAt ?? null,
    consignedAt: consignationTask?.at ?? null,
    consignedBy: consignationTask?.ownerId ?? null,
    lastValidActionAt,
    firstCallMissed: false,
    latenessHours: 0,
  };

  // 1. Issue définitive : la piste est sortie du champ du monitoring.
  if (lead.status === "Convertie" || lead.convertedDate) {
    return { ...base, operationalStatus: "convertie", reason: "piste convertie en opportunité" };
  }
  if (lead.status === "Abandonnée" || lead.abandonedAt) {
    return { ...base, operationalStatus: "abandonnee", reason: "piste abandonnée" };
  }

  // 2. Bouclier. Un vrai créneau futur protège intégralement le commercial :
  //    il n'a aucune raison de contacter le client avant l'heure convenue.
  if (nextAppointment) {
    return {
      ...base,
      operationalStatus: "a_venir",
      reason: `rendez-vous prévu le ${formatDate(nextAppointment.startAt)}`,
    };
  }

  // 3. First Call manqué. Le cas le plus grave : l'heure est passée, la piste
  //    n'a pas bougé de « Nouvelle piste » et rien n'a été consigné.
  if (
    lead.status === "Nouvelle piste" &&
    firstCallAt &&
    (ms(firstCallAt) ?? 0) < now &&
    !consignationTask
  ) {
    const lateness = (now - (ms(firstCallAt) ?? now)) / HOUR;
    return {
      ...base,
      operationalStatus: lateness >= thresholds.criticalAfterHours ? "critique" : "en_retard",
      reason: `First Call du ${formatDate(firstCallAt)} passé, statut toujours « Nouvelle piste », aucune consignation`,
      latenessHours: Math.round(lateness),
      firstCallMissed: true,
    };
  }

  // 4. Échéance métier. C'est le déclencheur principal — jamais l'âge du statut.
  const due = endOfDay(lead.recallDate);
  if (due !== null) {
    if (due > now) {
      return {
        ...base,
        operationalStatus: "normal",
        reason: `échéance de rappel au ${formatDate(lead.recallDate!)}, non échue`,
      };
    }
    // Une action valide le jour de l'échéance ou après vaut traitement.
    const acted = validActions.some((t) => (ms(t.at) ?? 0) >= due - 24 * HOUR);
    if (acted) {
      return {
        ...base,
        operationalStatus: "normal",
        reason: `échéance du ${formatDate(lead.recallDate!)} suivie d'une action`,
      };
    }
    const lateness = (now - due) / HOUR;
    return {
      ...base,
      operationalStatus:
        lateness >= thresholds.criticalAfterHours
          ? "critique"
          : lateness >= thresholds.lateAfterHours
            ? "en_retard"
            : "a_traiter",
      reason: `échéance du ${formatDate(lead.recallDate!)} dépassée, aucune action valide depuis`,
      latenessHours: Math.round(lateness),
    };
  }

  // 5. Aucune échéance et aucun créneau à venir. Après le délai de grâce,
  //    la piste doit être organisée.
  const age = (now - (ms(lead.createdAt) ?? now)) / HOUR;
  if (!firstCallAt && age > thresholds.noAppointmentGraceHours) {
    return {
      ...base,
      operationalStatus: "sans_rendez_vous",
      reason: `créée il y a ${Math.round(age / 24)} j, aucun rendez-vous programmé`,
      latenessHours: Math.round(age - thresholds.noAppointmentGraceHours),
    };
  }

  return {
    ...base,
    operationalStatus: "normal",
    reason: firstCallAt ? "First Call traité" : "piste récente, dans le délai de grâce",
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

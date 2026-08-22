/**
 * Moteur de jalons des opportunités — C2.
 *
 * Même principe que pour les pistes : on ne juge JAMAIS l'inactivité brute.
 * On juge la séquence « un jalon devait avoir lieu · l'échéance est passée ·
 * la suite attendue n'a pas été constatée ».
 *
 * Les jalons ne vivent pas dans des champs dédiés mais dans des LIBELLÉS de
 * tâches et d'événements Salesforce — c'est ce que l'audit a établi. Cette
 * dépendance est fragile par nature : `countMilestoneEvidence` existe pour
 * détecter qu'un template a été renommé, avant que le moteur ne devienne
 * silencieusement aveugle.
 *
 * Fichier autonome (aucun import) : les seuils sont injectés, pour qu'une
 * autre direction régionale puisse le réutiliser tel quel.
 */

export type OppTask = {
  subject: string | null;
  description: string | null;
  subtype: string | null;
  at: string;
};

export type OppEvent = {
  subject: string | null;
  startAt: string;
  isAllDay: boolean;
};

export type OppMailSignal = {
  direction: string;
  signalType: string;
  sentAt: string | null;
};

export type OpportunityInput = {
  opportunityId: string;
  stage: string | null;
  amount: number | null;
  standbyUntil: string | null;
  isActive: boolean;
  tasks: OppTask[];
  events: OppEvent[];
  /** Signal Gmail rattaché en A ou B. Absent = aucune conclusion possible. */
  mailSignal?: OppMailSignal | null;
};

export type MilestoneThresholds = {
  /** Délai maximal avant la PREMIÈRE relance après envoi, en jours. */
  estimationSlaDays: number;
  devisSlaDays: number;
  /** Sans jalon ni action humaine au-delà, l'opportunité devient candidate. */
  dormantAfterDays: number;
  /** Au-delà, un client sans réponse est signalé. */
  clientWaitingAfterDays: number;
};

export type MilestoneStatus =
  | "a_venir"
  | "normal"
  | "standby"
  | "standby_expire"
  | "sla_estimation"
  | "sla_devis"
  | "client_attend"
  | "dormant_candidate";

export const MILESTONE_LABEL: Record<MilestoneStatus, string> = {
  a_venir: "Jalon à venir",
  normal: "Normal",
  standby: "Stand-by",
  standby_expire: "Stand-by expiré",
  sla_estimation: "Estimation sans relance",
  sla_devis: "Devis sans relance",
  client_attend: "Client en attente",
  dormant_candidate: "Dormant candidat",
};

/** Statuts qui constituent une exception de suivi. */
export const MILESTONE_ANOMALIES: MilestoneStatus[] = [
  "sla_estimation",
  "sla_devis",
  "client_attend",
  "dormant_candidate",
  "standby_expire",
];

export type NextExpectedEvent =
  | "estimation_a_envoyer"
  | "relance_estimation"
  | "visite_expert_travaux"
  | "visite_artisan"
  | "devis_a_envoyer"
  | "relance_devis"
  | "signature"
  | "reveil_standby"
  | "rendez_vous_client"
  | null;

export const NEXT_EVENT_LABEL: Record<NonNullable<NextExpectedEvent>, string> = {
  estimation_a_envoyer: "estimation à envoyer",
  relance_estimation: "relance estimation",
  visite_expert_travaux: "visite Expert Travaux",
  visite_artisan: "visite artisan",
  devis_a_envoyer: "devis à envoyer",
  relance_devis: "relance devis",
  signature: "signature à obtenir",
  reveil_standby: "réveil stand-by",
  rendez_vous_client: "rendez-vous client",
};

export type MilestoneVerdict = {
  estimationSentAt: string | null;
  estimationRelanceAt: string | null;
  devisSentAt: string | null;
  devisRelanceAt: string | null;
  lastVisitAt: string | null;
  nextVisitAt: string | null;
  visitKind: string | null;
  lastHumanActionAt: string | null;
  nextExpectedEvent: NextExpectedEvent;
  nextExpectedDueAt: string | null;
  milestoneStatus: MilestoneStatus;
  milestoneReason: string;
  latenessHours: number;
  clientWaiting: boolean;
};

// --- Reconnaissance des libellés Salesforce --------------------------------

/**
 * Normalisation défensive. Les libellés Salesforce contiennent des espaces
 * insécables (U+00A0), des apostrophes typographiques et des emoji : sans ce
 * nettoyage, les motifs échouent silencieusement — c'est arrivé pendant
 * l'audit.
 */
export function normalizeLabel(value: string | null): string {
  return (value ?? "")
    .replace(/[  ]/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** E-mails de plateforme : jamais une preuve d'acte commercial. */
const AUTOMATED =
  /creneau de rappel|bienvenue chez|est disponible|mot de passe|nouveau message|ameliorer notre|nous vous avons selectionne|decouvrez notre artisan|decouvrez votre super estimation|trustpilot|rendez-vous reserve/;

/** Tâches purement internes : préparer un devis n'est pas relancer un client. */
const INTERNAL_TASK =
  /^(faire estimation|faire devis|envoyer devis|envoyer esti|rdv artisan|rdv expert travaux|visite artisan|revue d)/;

export const ESTIMATION_SENT = (t: OppTask) =>
  /votre estimation est disponible/.test(normalizeLabel(t.subject));
export const DEVIS_SENT = (t: OppTask) =>
  /votre devis est disponible/.test(normalizeLabel(t.subject));

const DEDICATED_RELANCE = (t: OppTask) =>
  /rappel client suite a envoi/.test(normalizeLabel(t.subject));
const FIRST_CALL = (t: OppTask) => /^1er appel client/.test(normalizeLabel(t.subject));

/**
 * Relance commerciale valide, selon la définition métier arbitrée :
 * tâche de rappel dédiée, appel consigné, e-mail sortant non automatique, ou
 * tâche générique dont le libellé démontre explicitement une relance client.
 *
 * Les réponses (« Re: ») sont écartées : Salesforce n'enregistre pas le sens
 * de circulation d'un e-mail, et une réponse est plus probablement entrante.
 * On préfère sous-estimer la conformité que d'inventer une preuve.
 */
export function isClientRelance(task: OppTask): boolean {
  const subject = normalizeLabel(task.subject);
  if (DEDICATED_RELANCE(task)) return true;
  if (task.subtype === "Call" && !FIRST_CALL(task)) {
    return (task.description ?? "").trim().length >= 15;
  }
  if (task.subtype === "Email") {
    return !AUTOMATED.test(subject) && !/^e-mail : re ?:/.test(subject);
  }
  if (task.subtype === "Task" && !INTERNAL_TASK.test(subject) && !FIRST_CALL(task)) {
    return /relance|rappel client|recontacter|rappeler|demande de rappel/.test(
      `${subject} ${normalizeLabel(task.description)}`,
    );
  }
  return false;
}

const VISITE_ET = (e: OppEvent) =>
  /visite expert travaux|rdv et\b|rdv expert travaux/.test(normalizeLabel(e.subject));
const VISITE_ARTISAN = (e: OppEvent) =>
  /visite artisan|rdv artisan/.test(normalizeLabel(e.subject));
/**
 * Revues d'estimation et de devis : jalons SECONDAIRES, jugés internes tant
 * qu'aucune preuve ne les rattache à une échéance client. Ils ne protègent
 * d'aucun retard et ne deviennent jamais le prochain jalon attendu.
 */
const INTERNAL_REVIEW = (e: OppEvent) =>
  /revue d'estimation|revue de devis/.test(normalizeLabel(e.subject));

const DAY = 864e5;
const HOUR = 36e5;
const ms = (v: string | null) => (v ? new Date(v).getTime() : null);

export function evaluateOpportunity(
  opp: OpportunityInput,
  thresholds: MilestoneThresholds,
  now: number = Date.now(),
): MilestoneVerdict {
  const tasks = [...opp.tasks].sort((a, b) => a.at.localeCompare(b.at));
  const events = [...opp.events]
    .filter((e) => e.startAt && !INTERNAL_REVIEW(e))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  const estimationSentAt = tasks.find(ESTIMATION_SENT)?.at ?? null;
  const devisSentAt = tasks.find(DEVIS_SENT)?.at ?? null;

  const relanceAfter = (from: string | null) =>
    from ? (tasks.find((t) => isClientRelance(t) && (ms(t.at) ?? 0) > (ms(from) ?? 0))?.at ?? null) : null;
  const estimationRelanceAt = relanceAfter(estimationSentAt);
  const devisRelanceAt = relanceAfter(devisSentAt);

  const humanActions = tasks.filter(isClientRelance);
  const lastHumanActionAt = humanActions.length ? humanActions[humanActions.length - 1].at : null;

  const pastVisits = events.filter((e) => (ms(e.startAt) ?? 0) <= now);
  const nextVisit = events.find((e) => (ms(e.startAt) ?? 0) > now) ?? null;
  const lastVisit = pastVisits[pastVisits.length - 1] ?? null;
  const visitKindOf = (e: OppEvent | null) =>
    !e ? null : VISITE_ET(e) ? "expert travaux" : VISITE_ARTISAN(e) ? "artisan" : "rendez-vous client";

  const base = {
    estimationSentAt,
    estimationRelanceAt,
    devisSentAt,
    devisRelanceAt,
    lastVisitAt: lastVisit?.startAt ?? null,
    nextVisitAt: nextVisit?.startAt ?? null,
    visitKind: visitKindOf(nextVisit ?? lastVisit),
    lastHumanActionAt,
    latenessHours: 0,
    clientWaiting: false,
  };

  // --- Prochain jalon attendu. C'est la colonne vertébrale du moteur :
  //     tant qu'un jalon est connu, on ne raisonne jamais sur l'âge.
  const standbyUntil = ms(opp.standbyUntil);
  let nextExpectedEvent: NextExpectedEvent = null;
  let nextExpectedDueAt: string | null = null;

  if (standbyUntil && standbyUntil > now) {
    nextExpectedEvent = "reveil_standby";
    nextExpectedDueAt = opp.standbyUntil;
  } else if (nextVisit) {
    nextExpectedEvent = VISITE_ET(nextVisit)
      ? "visite_expert_travaux"
      : VISITE_ARTISAN(nextVisit)
        ? "visite_artisan"
        : "rendez_vous_client";
    nextExpectedDueAt = nextVisit.startAt;
  } else if (devisSentAt && !devisRelanceAt) {
    nextExpectedEvent = "relance_devis";
    nextExpectedDueAt = new Date((ms(devisSentAt) ?? now) + thresholds.devisSlaDays * DAY).toISOString();
  } else if (estimationSentAt && !estimationRelanceAt) {
    nextExpectedEvent = "relance_estimation";
    nextExpectedDueAt = new Date(
      (ms(estimationSentAt) ?? now) + thresholds.estimationSlaDays * DAY,
    ).toISOString();
  } else if (opp.stage === "Etude dossier") {
    nextExpectedEvent = "estimation_a_envoyer";
  } else if (opp.stage === "Visite artisan") {
    nextExpectedEvent = "visite_artisan";
  } else if (opp.stage === "Examen devis") {
    nextExpectedEvent = devisSentAt ? "relance_devis" : "devis_a_envoyer";
  } else if (opp.stage === "Signature") {
    nextExpectedEvent = "signature";
  } else if (estimationSentAt) {
    nextExpectedEvent = "relance_estimation";
  }

  const withNext = { ...base, nextExpectedEvent, nextExpectedDueAt };

  // --- Verdict. L'ordre EST la règle métier.

  // 1. Stand-by : bouclier absolu tant qu'il court.
  if (standbyUntil && standbyUntil > now) {
    return { ...withNext, milestoneStatus: "standby", milestoneReason: `stand-by jusqu'au ${fmt(opp.standbyUntil)}` };
  }
  if (standbyUntil && standbyUntil <= now && !hasActionAfter(tasks, standbyUntil)) {
    return {
      ...withNext,
      milestoneStatus: "standby_expire",
      milestoneReason: `stand-by expiré le ${fmt(opp.standbyUntil)}, aucune reprise constatée`,
      latenessHours: Math.round((now - standbyUntil) / HOUR),
    };
  }

  // 2. Jalon futur connu : le commercial est protégé jusqu'à l'échéance.
  if (nextVisit) {
    return {
      ...withNext,
      milestoneStatus: "a_venir",
      milestoneReason: `${visitKindOf(nextVisit)} le ${fmt(nextVisit.startAt)}`,
    };
  }

  // 3. SLA : une PREMIÈRE relance est due dans les N jours suivant l'envoi.
  //    Une fois faite, le SLA est satisfait — on n'impose pas un cycle.
  const slaBreach = (
    sentAt: string | null,
    relanceAt: string | null,
    days: number,
  ): number | null => {
    if (!sentAt || relanceAt) return null;
    const due = (ms(sentAt) ?? now) + days * DAY;
    return now > due ? now - due : null;
  };

  const devisLate = slaBreach(devisSentAt, devisRelanceAt, thresholds.devisSlaDays);
  if (devisLate !== null) {
    return {
      ...withNext,
      milestoneStatus: "sla_devis",
      milestoneReason: `devis envoyé le ${fmt(devisSentAt)}, aucune relance dans les ${thresholds.devisSlaDays} jours`,
      latenessHours: Math.round(devisLate / HOUR),
    };
  }
  const estimLate = slaBreach(estimationSentAt, estimationRelanceAt, thresholds.estimationSlaDays);
  if (estimLate !== null) {
    return {
      ...withNext,
      milestoneStatus: "sla_estimation",
      milestoneReason: `estimation envoyée le ${fmt(estimationSentAt)}, aucune relance dans les ${thresholds.estimationSlaDays} jours`,
      latenessHours: Math.round(estimLate / HOUR),
    };
  }

  // 4. Le client attend. Signal POSITIF, uniquement quand Gmail le démontre :
  //    son absence ne prouve rien, la couverture n'étant que partielle.
  if (opp.mailSignal?.direction === "entrant" && opp.mailSignal.sentAt) {
    const waiting = (now - (ms(opp.mailSignal.sentAt) ?? now)) / DAY;
    const answered = hasActionAfter(tasks, ms(opp.mailSignal.sentAt) ?? 0);
    if (waiting > thresholds.clientWaitingAfterDays && !answered) {
      return {
        ...withNext,
        milestoneStatus: "client_attend",
        milestoneReason: `dernier message client le ${fmt(opp.mailSignal.sentAt)}, sans réponse constatée`,
        latenessHours: Math.round(waiting * 24),
        clientWaiting: true,
      };
    }
  }

  // 5. Dernier recours seulement : aucun jalon futur, aucun stand-by, aucune
  //    action humaine depuis longtemps. On dit « candidat », pas « en faute ».
  const idleDays = lastHumanActionAt ? (now - (ms(lastHumanActionAt) ?? now)) / DAY : Infinity;
  if (!nextExpectedDueAt && idleDays > thresholds.dormantAfterDays) {
    return {
      ...withNext,
      milestoneStatus: "dormant_candidate",
      milestoneReason: lastHumanActionAt
        ? `aucun jalon prévu, dernière action client il y a ${Math.round(idleDays)} j`
        : "aucun jalon prévu, aucune action client constatée",
      latenessHours: Number.isFinite(idleDays) ? Math.round(idleDays * 24) : 0,
    };
  }

  return { ...withNext, milestoneStatus: "normal", milestoneReason: "process suivi" };
}

function hasActionAfter(tasks: OppTask[], since: number): boolean {
  return tasks.some((t) => isClientRelance(t) && (ms(t.at) ?? 0) > since);
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR");
}

/**
 * Contrôle de couverture des templates Salesforce.
 *
 * Le moteur repose sur des libellés. Si un template est renommé, la détection
 * tombe à zéro sans erreur visible. Ce compteur est journalisé à chaque import
 * pour rendre la panne détectable — c'est une alerte TECHNIQUE, à ne jamais
 * mélanger avec les exceptions commerciales.
 */
export function countMilestoneEvidence(
  opportunities: { tasks: OppTask[]; events: OppEvent[] }[],
): Record<string, number> {
  const counters: Record<string, number> = {
    estimation_envoyee: 0,
    devis_envoye: 0,
    rappel_dedie: 0,
    appel_consigne: 0,
    visite_expert_travaux: 0,
    visite_artisan: 0,
  };
  for (const o of opportunities) {
    for (const t of o.tasks) {
      if (ESTIMATION_SENT(t)) counters.estimation_envoyee += 1;
      if (DEVIS_SENT(t)) counters.devis_envoye += 1;
      if (DEDICATED_RELANCE(t)) counters.rappel_dedie += 1;
      if (t.subtype === "Call" && (t.description ?? "").trim().length >= 15) {
        counters.appel_consigne += 1;
      }
    }
    for (const e of o.events) {
      if (VISITE_ET(e)) counters.visite_expert_travaux += 1;
      if (VISITE_ARTISAN(e)) counters.visite_artisan += 1;
    }
  }
  return counters;
}

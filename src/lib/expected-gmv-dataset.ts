/**
 * Dataset historique Expected GMV — C4.
 *
 * AUCUN MODÈLE ICI. Ce fichier ne fait que reconstruire, pour une date T,
 * l'état d'une opportunité tel qu'il était réellement connu ce jour-là.
 *
 * RÈGLE DE CONCEPTION FONDAMENTALE, à laquelle tout le reste est subordonné :
 *
 *     « Si nous étions le 10 juin 2025 avec uniquement les données
 *       disponibles ce jour-là, qu'aurait pu savoir RM Morning ? »
 *
 * Aucune valeur postérieure à T n'entre dans une feature. Les seules données
 * futures autorisées sont les LABELS, et elles sont nommées comme telles.
 *
 * Sources et profondeurs, mesurées à l'audit :
 *   — étape et montant : `OpportunityHistory`, remonte à 2020, couverture 100 % ;
 *   — signature réelle : première transition vers un état post-signature,
 *     100 % de couverture, écart 0,0 j contre `Date_etape_signe__c` ;
 *   — jalons (estimation, devis, visites) : denses seulement depuis 2025-07 ;
 *   — Projection Kanban : AUCUN historique exploitable (le classeur Perspective
 *     ne conserve que quatre mois glissants). Colonnes présentes, valeurs
 *     nulles, drapeau à faux. Jamais fabriquées.
 *
 * Fichier autonome (aucun import) : testable et réutilisable tel quel.
 */

/** Étapes qui prouvent qu'une signature a déjà eu lieu. */
export const POST_SIGNATURE_STAGES = [
  "Signé",
  "Chantier en cours",
  "Chantier terminé",
  "Fin du projet",
] as const;

/** Étape terminale négative. */
export const LOST_STAGE = "Affaire perdue";

/**
 * Étapes exploitables pour PRÉDIRE une signature.
 *
 * Les étapes de chantier en sont exclues : elles confirment une signature
 * passée, elles ne l'annoncent pas. Une observation portant l'une d'elles
 * serait une fuite de label déguisée en feature.
 */
export const PREDICTIVE_STAGES = [
  "Etude dossier",
  "Examen estimation",
  "Visite artisan",
  "Examen devis",
  "Signature",
] as const;

export type StageTransition = {
  stage: string | null;
  amount: number | null;
  at: string;
  /** L'étape a-t-elle réellement changé sur cette ligne ? */
  stageChanged: boolean;
};

export type DatedActivity = {
  subject: string | null;
  description: string | null;
  subtype: string | null;
  at: string;
};

export type DatedEvent = {
  subject: string | null;
  startAt: string;
  isAllDay: boolean;
};

export type DatasetOpportunity = {
  opportunityId: string;
  owner: string;
  createdAt: string;
  acquisitionChannel: string | null;
  leadSource: string | null;
  service: string | null;
  postalCode: string | null;
  city: string | null;
  history: StageTransition[];
  tasks: DatedActivity[];
  events: DatedEvent[];
};

export type DatasetConfig = {
  /** Début de la fenêtre d'observation. */
  from: string;
  /** Fin de la fenêtre (exclue si postérieure à aujourd'hui). */
  to: string;
  /** Date à partir de laquelle les jalons sont réellement tracés. */
  milestonesFrom: string;
  /** Date à partir de laquelle des snapshots Perspective existent. */
  kanbanFrom: string;
  /** Bornes du découpage temporel, sur la DATE D'OBSERVATION. */
  trainUntil: string;
  validationUntil: string;
};

export type Observation = {
  observationDate: string;
  opportunityId: string;
  owner: string;
  observationKind: "weekly" | "milestone";

  stage: string | null;
  amount: number | null;
  ageDays: number;
  daysInStage: number | null;
  stageChanges: number;

  acquisitionChannel: string | null;
  leadSource: string | null;
  service: string | null;
  postalCode: string | null;
  city: string | null;

  month: number;
  isoWeek: number;
  dayOfMonth: number;
  daysLeftInMonth: number;

  estimationSentAt: string | null;
  daysSinceEstimation: number | null;
  estimationRelanceAt: string | null;
  estimationRelanceDelayDays: number | null;
  devisSentAt: string | null;
  daysSinceDevis: number | null;
  devisRelanceAt: string | null;
  devisRelanceDelayDays: number | null;
  visitEtPast: number | null;
  visitEtFuture: number | null;
  visitArtisanPast: number | null;
  visitArtisanFuture: number | null;

  /** Toujours nul : aucun historique de Projection Kanban n'existe. */
  kanbanMonth: null;
  kanbanWeeksOnMonth: null;

  milestonesAvailable: boolean;
  kanbanHistoryAvailable: boolean;
  gmailAvailable: boolean;
  standbyAvailable: boolean;

  signedWithin7d: 0 | 1;
  signedByMonthEnd: 0 | 1;
  actualSignatureAt: string | null;
  daysToSignature: number | null;
  finalOutcome: "signed" | "lost" | "open";

  datasetSplit: "train" | "validation" | "test";
};

const DAY = 864e5;
const ms = (v: string) => new Date(v).getTime();
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Instant canonique d'une observation : midi UTC du jour concerné.
 *
 * Indispensable : la date d'observation est stockée en « AAAA-MM-JJ » et relue
 * à midi. Comparer la borne terminale à l'horodatage brut de génération
 * laissait passer des observations postérieures à l'issue — c'est le test de
 * fuite 2b qui l'a révélé.
 */
const noon = (t: number) => ms(`${iso(t)}T12:00:00Z`);

/** Numéro de semaine ISO. */
function isoWeekOf(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7);
}

function endOfMonth(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
}

// --- Reconnaissance des jalons. Mêmes motifs que le moteur C2, y compris la
//     normalisation des espaces insécables qui avait fait échouer l'audit.
function normalize(value: string | null): string {
  return (value ?? "")
    .replace(/[  ]/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const AUTOMATED =
  /creneau de rappel|bienvenue chez|est disponible|mot de passe|nouveau message|ameliorer notre|nous vous avons selectionne|decouvrez notre artisan|decouvrez votre super estimation|trustpilot|rendez-vous reserve/;
const INTERNAL_TASK =
  /^(faire estimation|faire devis|envoyer devis|envoyer esti|rdv artisan|rdv expert travaux|visite artisan|revue d)/;

const isEstimationSent = (t: DatedActivity) => /votre estimation est disponible/.test(normalize(t.subject));
const isDevisSent = (t: DatedActivity) => /votre devis est disponible/.test(normalize(t.subject));
const isVisitEt = (e: DatedEvent) => /visite expert travaux|rdv et\b|rdv expert travaux/.test(normalize(e.subject));
const isVisitArtisan = (e: DatedEvent) => /visite artisan|rdv artisan/.test(normalize(e.subject));

/** Relance commerciale valide — définition arbitrée au Passage C2. */
function isRelance(t: DatedActivity): boolean {
  const subject = normalize(t.subject);
  if (/rappel client suite a envoi/.test(subject)) return true;
  if (t.subtype === "Call" && !/^1er appel client/.test(subject)) {
    return (t.description ?? "").trim().length >= 15;
  }
  if (t.subtype === "Email") return !AUTOMATED.test(subject) && !/^e-mail : re ?:/.test(subject);
  if (t.subtype === "Task" && !INTERNAL_TASK.test(subject)) {
    return /relance|rappel client|recontacter|rappeler|demande de rappel/.test(
      `${subject} ${normalize(t.description)}`,
    );
  }
  return false;
}

export type Outcome = {
  finalOutcome: "signed" | "lost" | "open";
  /** Date de l'issue. Borne SUPÉRIEURE STRICTE des observations. */
  terminalAt: number | null;
  actualSignatureAt: string | null;
};

/**
 * Issue réelle d'une opportunité, reconstruite depuis les transitions.
 *
 * La signature est la PREMIÈRE entrée dans un état post-signature — contrôlé à
 * 100 % de couverture et 0,0 jour d'écart contre `Date_etape_signe__c`.
 * `DateSignatureDevis__c` n'est pas utilisée : elle est renseignée même sur les
 * affaires perdues et se décale jusqu'à 3,3 jours au p90.
 */
export function resolveOutcome(opportunity: DatasetOpportunity): Outcome {
  const changes = opportunity.history
    .filter((h) => h.stageChanged && h.stage)
    .sort((a, b) => a.at.localeCompare(b.at));

  const post = new Set<string>(POST_SIGNATURE_STAGES);
  const signatures = changes.filter((h) => post.has(h.stage as string));
  const lost = changes.find((h) => h.stage === LOST_STAGE) ?? null;

  // UNE SIGNATURE RÉELLE L'EMPORTE SUR UNE PERTE ANTÉRIEURE.
  //
  // La règle précédente donnait la victoire au premier état terminal : une
  // affaire passée en « Affaire perdue » restait perdue même si elle avait été
  // relancée et signée ensuite. C'est faux, et l'audit C10 l'a prouvé sur SCI
  // ÉTOILE — perdue le 30/07/2026, signée le 10/08/2026, donc absente du signé
  // de RM Morning alors que le rapport officiel la comptait.
  //
  // Vingt opportunités sont dans ce cas sur l'historique. Aucune fuite n'est
  // introduite : la date retenue est celle d'une vraie transition, et les
  // observations continuent de s'arrêter strictement avant elle.
  const first = signatures[0] ?? null;
  if (first && (!lost || first.at <= lost.at)) {
    return { finalOutcome: "signed", terminalAt: ms(first.at), actualSignatureAt: first.at };
  }
  if (lost) {
    const revived = signatures.find((h) => h.at > lost.at) ?? null;
    if (revived) {
      return { finalOutcome: "signed", terminalAt: ms(revived.at), actualSignatureAt: revived.at };
    }
    return { finalOutcome: "lost", terminalAt: ms(lost.at), actualSignatureAt: null };
  }
  return { finalOutcome: "open", terminalAt: null, actualSignatureAt: null };
}

/** État à T, reconstruit des seules transitions antérieures ou égales à T. */
function stateAt(opportunity: DatasetOpportunity, t: number) {
  const past = opportunity.history.filter((h) => ms(h.at) <= t);
  const stageRows = past.filter((h) => h.stageChanged && h.stage);
  const lastStage = stageRows[stageRows.length - 1] ?? null;
  const amountRows = past.filter((h) => h.amount != null);
  const lastAmount = amountRows[amountRows.length - 1] ?? null;
  return {
    stage: lastStage?.stage ?? null,
    stageSince: lastStage ? ms(lastStage.at) : null,
    stageChanges: stageRows.length,
    amount: lastAmount?.amount ?? null,
  };
}

/**
 * Dates d'observation : tous les lundis de la fenêtre de vie commerciale, plus
 * le lendemain de chaque jalon significatif.
 *
 * Fréquence arbitrée à l'audit : l'hebdomadaire produit le même taux de
 * positifs que le quotidien (1,87 %) pour sept fois moins de lignes ; la
 * densification événementielle rattrape la dynamique des sept jours là où elle
 * se joue réellement.
 */
export function observationDates(
  opportunity: DatasetOpportunity,
  outcome: Outcome,
  config: DatasetConfig,
  now = Date.now(),
): { at: number; kind: "weekly" | "milestone" }[] {
  const created = ms(opportunity.createdAt);
  const start = Math.max(created, ms(config.from));
  // Borne SUPÉRIEURE STRICTE : aucune observation le jour de l'issue ni après.
  const hardEnd = Math.min(outcome.terminalAt ?? now, ms(config.to), now);
  if (hardEnd <= start) return [];

  const dates = new Map<string, "weekly" | "milestone">();

  // Lundis, ancrés à midi UTC et comparés à la borne dans cette même unité.
  const first = new Date(start);
  const shift = (8 - (first.getDay() || 7)) % 7;
  for (let t = start + shift * DAY; t < hardEnd; t += 7 * DAY) {
    const at = noon(t);
    if (at > start && at < hardEnd) dates.set(iso(t), "weekly");
  }

  // Lendemain des jalons, uniquement quand les jalons sont tracés.
  if (start >= ms(config.milestonesFrom)) {
    const marks: number[] = [];
    for (const task of opportunity.tasks) {
      if (isEstimationSent(task) || isDevisSent(task)) marks.push(ms(task.at));
    }
    for (const event of opportunity.events) {
      if (isVisitEt(event) || isVisitArtisan(event)) marks.push(ms(event.startAt));
    }
    for (const mark of marks) {
      const at = noon(mark + DAY);
      if (at > start && at < hardEnd && !dates.has(iso(at))) dates.set(iso(at), "milestone");
    }
  }

  return [...dates.entries()]
    .map(([date, kind]) => ({ at: ms(`${date}T12:00:00Z`), kind }))
    .filter(({ at }) => at < hardEnd)
    .sort((a, b) => a.at - b.at);
}

/** Construit toutes les observations d'une opportunité. */
export function buildObservations(
  opportunity: DatasetOpportunity,
  config: DatasetConfig,
  now = Date.now(),
): Observation[] {
  const outcome = resolveOutcome(opportunity);
  const created = ms(opportunity.createdAt);
  const signatureAt = outcome.actualSignatureAt ? ms(outcome.actualSignatureAt) : null;
  const milestonesFrom = ms(config.milestonesFrom);
  const kanbanFrom = ms(config.kanbanFrom);

  const results: Observation[] = [];

  for (const { at: t, kind } of observationDates(opportunity, outcome, config, now)) {
    const state = stateAt(opportunity, t);

    // Une étape de chantier ne prédit pas une signature : elle la confirme.
    // Une telle observation serait une fuite. Elle ne peut normalement pas
    // survenir puisque les observations s'arrêtent avant l'issue, mais le
    // garde-fou reste explicite.
    if (state.stage && (POST_SIGNATURE_STAGES as readonly string[]).includes(state.stage)) continue;

    // Même raisonnement pour « Affaire perdue ». Depuis la correction C10, une
    // affaire perdue puis signée porte son issue à la SECONDE date : la borne
    // terminale ne coupe donc plus la période perdue, et l'affaire produisait
    // des observations portant l'étape « Affaire perdue » en feature. Or ce jour
    // -là, RM Morning ne l'aurait pas scorée : elle était sortie du pipe actif.
    if (state.stage === LOST_STAGE) continue;

    const milestonesAvailable = t >= milestonesFrom;
    const day = new Date(t);

    // Jalons : STRICTEMENT antérieurs ou égaux à T.
    const pastTasks = milestonesAvailable ? opportunity.tasks.filter((x) => ms(x.at) <= t) : [];
    const estimation = pastTasks.filter(isEstimationSent).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
    const devis = pastTasks.filter(isDevisSent).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
    const relanceAfter = (from: string | null) =>
      from ? (pastTasks.filter((x) => isRelance(x) && ms(x.at) > ms(from)).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null) : null;
    const estimationRelance = relanceAfter(estimation?.at ?? null);
    const devisRelance = relanceAfter(devis?.at ?? null);

    const visits = milestonesAvailable ? opportunity.events : [];
    const countVisits = (pred: (e: DatedEvent) => boolean, past: boolean) =>
      visits.filter((e) => pred(e) && (past ? ms(e.startAt) <= t : ms(e.startAt) > t)).length;

    const days = (a: number, b: number) => Math.round((a - b) / DAY);

    results.push({
      observationDate: iso(t),
      opportunityId: opportunity.opportunityId,
      owner: opportunity.owner,
      observationKind: kind,

      stage: state.stage,
      amount: state.amount,
      ageDays: days(t, created),
      daysInStage: state.stageSince == null ? null : days(t, state.stageSince),
      stageChanges: state.stageChanges,

      acquisitionChannel: opportunity.acquisitionChannel,
      leadSource: opportunity.leadSource,
      service: opportunity.service,
      postalCode: opportunity.postalCode,
      city: opportunity.city,

      month: day.getMonth() + 1,
      isoWeek: isoWeekOf(day),
      dayOfMonth: day.getDate(),
      daysLeftInMonth: Math.max(0, Math.round((endOfMonth(t) - t) / DAY)),

      estimationSentAt: estimation?.at ?? null,
      daysSinceEstimation: estimation ? days(t, ms(estimation.at)) : null,
      estimationRelanceAt: estimationRelance?.at ?? null,
      estimationRelanceDelayDays:
        estimation && estimationRelance ? days(ms(estimationRelance.at), ms(estimation.at)) : null,
      devisSentAt: devis?.at ?? null,
      daysSinceDevis: devis ? days(t, ms(devis.at)) : null,
      devisRelanceAt: devisRelance?.at ?? null,
      devisRelanceDelayDays: devis && devisRelance ? days(ms(devisRelance.at), ms(devis.at)) : null,
      visitEtPast: milestonesAvailable ? countVisits(isVisitEt, true) : null,
      visitEtFuture: milestonesAvailable ? countVisits(isVisitEt, false) : null,
      visitArtisanPast: milestonesAvailable ? countVisits(isVisitArtisan, true) : null,
      visitArtisanFuture: milestonesAvailable ? countVisits(isVisitArtisan, false) : null,

      kanbanMonth: null,
      kanbanWeeksOnMonth: null,

      milestonesAvailable,
      // Les snapshots existent depuis le 13/07/2026, mais cinq semaines ne
      // permettent aucune feature exploitable : le drapeau reste faux.
      kanbanHistoryAvailable: false && t >= kanbanFrom,
      gmailAvailable: false,
      // `En_stand_by_jusqu_au__c` n'est pas suivi en historique de champs :
      // l'état stand-by à une date passée est irrécupérable.
      standbyAvailable: false,

      signedWithin7d: signatureAt != null && signatureAt > t && signatureAt <= t + 7 * DAY ? 1 : 0,
      signedByMonthEnd: signatureAt != null && signatureAt > t && signatureAt <= endOfMonth(t) ? 1 : 0,
      actualSignatureAt: outcome.actualSignatureAt,
      // Fractionnaire : une signature 10 heures après T vaut 0,42 jour, pas 0.
      // L'arrondi entier produisait des délais nuls sur des signatures futures.
      daysToSignature:
        signatureAt == null ? null : Math.round(((signatureAt - t) / DAY) * 100) / 100,
      finalOutcome: outcome.finalOutcome,

      datasetSplit:
        iso(t) <= config.trainUntil
          ? "train"
          : iso(t) <= config.validationUntil
            ? "validation"
            : "test",
    });
  }

  return results;
}

// --- Observation « aujourd'hui », pour le scoring live -----------------------

/**
 * Features d'une opportunité à l'instant présent, sans label.
 *
 * Volontairement dans ce fichier et non dans un script de scoring : c'est
 * `stateAt` qui définit ce que veut dire « étape à une date », « temps dans
 * l'étape » et « nombre de changements d'étape ». En réécrire une variante
 * ailleurs finirait par produire deux définitions divergentes, et le modèle
 * serait alors scoré sur des features qui ne sont pas celles de son
 * apprentissage.
 *
 * `current` porte l'état réellement importé de Salesforce, plus frais que
 * l'extraction d'historique. Quand les deux concordent, le temps dans l'étape
 * est daté d'une vraie transition. Quand ils divergent, l'entrée dans l'étape
 * courante n'est pas connue : le temps dans l'étape reste nul, comme le fait
 * déjà le dataset pour une opportunité sans transition. Le borner à l'instant
 * d'extraction reviendrait à affirmer « changement d'étape il y a deux heures »,
 * ce qui est un signal fort et faux ; `stageSource` permet de les compter.
 */
export type TodayFeatures = {
  opportunityId: string;
  owner: string;
  stage: string | null;
  amount: number | null;
  ageDays: number;
  daysInStage: number | null;
  stageChanges: number;
  acquisitionChannel: string | null;
  leadSource: string | null;
  service: string | null;
  postalCode: string | null;
  city: string | null;
  month: number;
  isoWeek: number;
  dayOfMonth: number;
  daysLeftInMonth: number;
  stageSource: "transition" | "import";
  stageSince: string | null;
};

export function buildTodayFeatures(
  opportunity: DatasetOpportunity,
  current: { stage: string | null; amount: number | null },
  at: number,
): TodayFeatures {
  const state = stateAt(opportunity, at);
  const days = (a: number, b: number) => Math.round((a - b) / DAY);
  const day = new Date(at);

  const matches = state.stage != null && state.stage === current.stage;
  const since = matches ? state.stageSince : null;
  const changes = matches ? state.stageChanges : state.stageChanges + 1;

  return {
    opportunityId: opportunity.opportunityId,
    owner: opportunity.owner,
    stage: current.stage,
    amount: current.amount,
    ageDays: days(at, ms(opportunity.createdAt)),
    daysInStage: since == null ? null : Math.max(0, days(at, since)),
    stageChanges: changes,
    acquisitionChannel: opportunity.acquisitionChannel,
    leadSource: opportunity.leadSource,
    service: opportunity.service,
    postalCode: opportunity.postalCode,
    city: opportunity.city,
    month: day.getMonth() + 1,
    isoWeek: isoWeekOf(day),
    dayOfMonth: day.getDate(),
    daysLeftInMonth: Math.max(0, Math.round((endOfMonth(at) - at) / DAY)),
    stageSource: matches ? "transition" : "import",
    stageSince: since == null ? null : new Date(since).toISOString(),
  };
}

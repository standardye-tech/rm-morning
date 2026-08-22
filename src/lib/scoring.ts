/**
 * Règles de scoring, volontairement simples et explicables.
 *
 * Aucune de ces règles n'est un modèle prédictif : ce sont des heuristiques
 * lisibles sur les seules données Salesforce disponibles aujourd'hui. Chaque
 * sortie porte la raison qui l'a produite, pour pouvoir être contestée.
 */

import { TEAM, THRESHOLDS } from "./config";
import {
  daysSinceActivity,
  ageInDays,
  isAdvancedStage,
  isBigDeal,
  type OwnerMetrics,
  type PipelineMetrics,
} from "./metrics";
import {
  formatEurShort,
  formatFrenchDate,
  kanbanColorWeight,
  kanbanPeriodLabel,
  MONTH_LABELS,
} from "./normalize";
import type { WeekForecast } from "./forecast";
import type { Opportunity } from "./types";

const firstNameOf = (owner: string) =>
  TEAM.find((m) => m.name === owner)?.firstName ?? owner.split(" ")[0];

const clientOf = (o: Opportunity) => o.clientContact ?? o.name ?? o.opportunityId;

/** Accord au pluriel : plural(2, "affaire") → "affaires". */
const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  count > 1 ? pluralForm : singular;

/** « 1 commercial » / « 4 commerciaux ». */
const commerciaux = (count: number) => `${count} ${plural(count, "commercial", "commerciaux")}`;

/**
 * Priorité d'affichage par type d'alerte. Le tri se fait d'abord sur le niveau,
 * puis sur cette priorité, puis sur la GMV : un montant en euros et un nombre de
 * commerciaux ne sont pas comparables directement.
 */
const ALERT_PRIORITY = {
  forecastGap: 110,
  standbyEntered: 100,
  forecastPostponed: 95,
  dormantBigDeal: 90,
  advancedNoProjection: 70,
  ownerNoProjection: 60,
  lowPipe: 50,
  standbyExited: 40,
  forecastConfidenceDrop: 85,
  veryOldStock: 30,
  gmailContradiction: 120,
  gmailNegative: 105,
  gmailRisk: 80,
  gmailUndervalued: 45,
} as const;

// --- Poids du montant -----------------------------------------------------

/**
 * Contribution progressive du montant, entre 0 et 1, sans aucun seuil.
 *
 * Échelle logarithmique : ce qui compte est l'ordre de grandeur, pas l'euro.
 *   10 k€ → 0,33   ·   50 k€ → 0,57   ·   100 k€ → 0,67   ·   1 M€ → 1,00
 *
 * Une affaire de 120 k€ pèse donc un peu plus qu'une de 90 k€, et nettement
 * plus qu'une de 9 k€ — mais sans qu'aucune valeur ne fasse basculer
 * brutalement d'un régime à un autre.
 */
export function gmvWeight(gmv: number | null): number {
  if (!gmv || gmv <= 0) return 0;
  return Math.max(0, Math.min(1, Math.log10(gmv / 1000) / 3));
}

// --- Contribution Gmail ---------------------------------------------------

/**
 * Effet d'un signal Gmail sur le score de proximité de signature.
 *
 * Volontairement petit et lisible : le score Salesforce reste la base, Gmail
 * l'ajuste. Aucune pondération opaque. Le score final est borné à [0, 1].
 *
 * Ces contributions ne s'appliquent QU'AUX opportunités portant un signal de
 * niveau A ou B — le filtre est appliqué en amont, dans
 * `latestSignalByOpportunity()`. Un fil de niveau C n'atteint jamais ce code.
 */
export const GMAIL_SCORE_EFFECT: Record<string, number> = {
  // Le client s'engage : c'est le signal le plus fort dont on dispose.
  signature: 0.2,
  // Favorable mais bloqué : léger, car l'obstacle peut durer.
  positif_bloque: 0.08,
  // Dégradation : suffisant pour faire sortir un dossier limite du Top 3.
  risque: -0.12,
  // Perte annoncée : doit écraser un bon score Salesforce devenu obsolète.
  negatif: -0.3,
  neutre: 0,
};

/** Libellé court d'un signal, pour l'affichage. */
export const GMAIL_SIGNAL_LABEL: Record<string, string> = {
  signature: "signature en vue",
  positif_bloque: "favorable, bloqué",
  risque: "signal de risque",
  negatif: "signal négatif",
  neutre: "échange neutre",
};

/** Signal Gmail attaché à une opportunité, tel que consommé par le moteur. */
export type MailSignalForScoring = {
  opportunityId: string;
  matchLevel: "A" | "B";
  signalType: string;
  confidence: number;
  blocker: string | null;
  summary: string | null;
  sentAt: string | null;
};

export type MailSignalIndex = Map<string, MailSignalForScoring>;

// --- Bloc 1 : opportunités les plus proches de signer ---------------------

export type ScoredDeal = {
  opportunity: Opportunity;
  owner: string;
  ownerFirstName: string;
  client: string;
  gmv: number | null;
  kanbanRaw: string | null;
  kanbanLabel: string | null;
  score: number;
  /**
   * Score de classement : la proximité, majorée par le montant. Sert au tri
   * du Top 3. La proximité affichée reste `score`.
   */
  rankScore: number;
  confidence: "élevée" | "moyenne" | "faible";
  /** Raison courte : pourquoi cette opportunité ressort. */
  reason: string;
  /** Signal Gmail retenu, quand il existe et qu'il est de niveau A ou B. */
  mailSignal: MailSignalForScoring | null;
  /** Ajustement Gmail réellement appliqué au score. 0 si aucun. */
  mailAdjustment: number;
};

/**
 * Proximité de signature :
 *   40 % l'avancement de l'étape, 35 % la Projection Kanban, 25 % la fraîcheur,
 *   ajustée par le dernier signal Gmail rattaché de façon fiable.
 *
 * Le CLASSEMENT, lui, majore cette proximité par le montant :
 *
 *     rankScore = proximité × (1 + GMV_RANK_WEIGHT × gmvWeight(GMV))
 *
 * La majoration est MULTIPLICATIVE, et c'est le point important : elle est
 * proportionnelle à la proximité. Une grosse affaire encore loin de signer a
 * une proximité faible, donc une majoration faible — le montant seul ne peut
 * pas la faire remonter. À l'inverse, entre deux affaires également mûres,
 * c'est la plus grosse qui passe devant.
 */
const GMV_RANK_WEIGHT = 0.3;

export function scoreDeals(
  opportunities: Opportunity[],
  metrics: PipelineMetrics,
  mailSignals?: MailSignalIndex,
): ScoredDeal[] {
  const { referenceDate, currentMonth, currentYear } = metrics;

  return opportunities
    .filter((o) => o.isActive)
    .map((o) => {
      const reasons: string[] = [];

      // 1. Avancement.
      const stageScore = (o.probability ?? 0) / 100;
      if (o.stage) reasons.push(`${o.stage}${o.probability ? ` (${o.probability} %)` : ""}`);

      // 2. Projection Kanban.
      let periodScore = 0;
      let kanbanLabel: string | null = null;
      if (o.kanbanMonth && o.kanbanYear) {
        const distance =
          (o.kanbanYear - currentYear) * 12 + (o.kanbanMonth - currentMonth);
        periodScore = distance <= 0 ? 1 : distance === 1 ? 0.55 : 0.25;
        kanbanLabel = kanbanPeriodLabel(o.kanbanMonth, o.kanbanYear);
        reasons.push(`projetée ${kanbanLabel}`);
      }
      // La couleur module la confiance sans jamais annuler la projection :
      // sa signification exacte n'est pas connue (voir config.KANBAN_COLORS).
      const colorFactor = o.kanbanColorRaw
        ? kanbanColorWeight(o.kanbanColor, o.kanbanColorRaw)
        : 0.5;
      const kanbanScore = periodScore * (0.5 + 0.5 * colorFactor);

      // 3. Fraîcheur.
      const days = daysSinceActivity(o, referenceDate);
      let activityScore = 0;
      if (days !== null) {
        const elapsed = Math.max(days, 0); // une activité planifiée compte comme récente
        activityScore = elapsed <= 7 ? 1 : elapsed <= 14 ? 0.8 : elapsed <= 30 ? 0.5 : elapsed <= 60 ? 0.2 : 0;
        if (elapsed <= 14) reasons.push(`activité il y a ${elapsed} j`);
      }

      const salesforceScore = 0.4 * stageScore + 0.35 * kanbanScore + 0.25 * activityScore;

      // Ajustement Gmail. Un signal de signature n'est retenu que sur une
      // affaire active et hors stand-by : annoncer une signature imminente sur
      // un dossier gelé serait faux.
      const signal = mailSignals?.get(o.opportunityId) ?? null;
      let mailAdjustment = 0;
      if (signal) {
        const effect = GMAIL_SCORE_EFFECT[signal.signalType] ?? 0;
        const applicable =
          signal.signalType !== "signature" || (o.isActive && !o.isStandby);
        if (applicable && effect !== 0) {
          mailAdjustment = effect;
          reasons.push(`Gmail : ${GMAIL_SIGNAL_LABEL[signal.signalType] ?? signal.signalType}`);
        }
      }

      const score = Math.max(0, Math.min(1, salesforceScore + mailAdjustment));
      const rankScore = score * (1 + GMV_RANK_WEIGHT * gmvWeight(o.gmv));

      return {
        opportunity: o,
        owner: o.owner,
        ownerFirstName: firstNameOf(o.owner),
        client: clientOf(o),
        gmv: o.gmv,
        kanbanRaw: o.kanbanRaw,
        kanbanLabel,
        score,
        rankScore,
        confidence: score >= 0.6 ? "élevée" : score >= 0.4 ? "moyenne" : "faible",
        reason: reasons.slice(0, 3).join(" · "),
        mailSignal: signal,
        mailAdjustment,
      } satisfies ScoredDeal;
    })
    .sort((a, b) => b.rankScore - a.rankScore || (b.gmv ?? 0) - (a.gmv ?? 0));
}

// --- Bloc 3 : alertes -----------------------------------------------------

export type AlertLevel = "critique" | "vigilance" | "info";

export type Alert = {
  level: AlertLevel;
  title: string;
  detail: string;
  /** Priorité du type d'alerte (voir ALERT_PRIORITY), non affichée. */
  priority: number;
  /** GMV concernée, utilisée en dernier critère de tri. Non affichée. */
  weight: number;
};

export type StandbyTransition = {
  entered: Opportunity[];
  exited: Opportunity[];
};

export function buildAlerts(
  opportunities: Opportunity[],
  metrics: PipelineMetrics,
  transitions: StandbyTransition | null,
  forecast?: WeekForecast,
  mailSignals?: MailSignalIndex,
): Alert[] {
  const { referenceDate } = metrics;
  const candidates: Alert[] = [];
  const active = opportunities.filter((o) => o.isActive);

  // --- Contradictions Gmail / Salesforce / forecast.
  //
  // Gmail ne corrige jamais le Sheet ni Salesforce : il signale une
  // divergence, et c'est un humain qui tranche. Aucune écriture nulle part.
  if (mailSignals && mailSignals.size > 0) {
    const forecasted = new Set(
      [
        ...(forecast?.strengthened ?? []),
        ...(forecast?.weakened ?? []),
        ...(forecast?.postponed ?? []),
      ]
        .map((m) => m.opportunityId)
        .filter((id): id is string => Boolean(id)),
    );

    for (const o of active) {
      const signal = mailSignals.get(o.opportunityId);
      if (!signal) continue;
      const client = clientOf(o);
      const who = firstNameOf(o.owner);
      const amount = formatEurShort(o.gmv);

      if (signal.signalType === "negatif") {
        const inForecast = forecasted.has(o.opportunityId);
        candidates.push({
          level: "critique",
          title: inForecast
            ? `Contradiction : ${client} annoncée au forecast, signal négatif en mail`
            : `Signal négatif sur ${client}`,
          detail: inForecast
            ? `${amount}, portée par ${who}, toujours au forecast alors que le dernier échange indique un abandon. ${signal.summary ?? ""} À vérifier avant de maintenir la prévision.`.trim()
            : `${amount}, portée par ${who}. ${signal.summary ?? "Le dernier échange indique un abandon."} L'opportunité est encore active dans Salesforce.`,
          priority: inForecast ? ALERT_PRIORITY.gmailContradiction : ALERT_PRIORITY.gmailNegative,
          weight: o.gmv ?? 0,
        });
      } else if (signal.signalType === "risque" && (o.gmv ?? 0) >= THRESHOLDS.bigDealGmv) {
        candidates.push({
          level: "vigilance",
          title: `${client} à challenger : signal de risque`,
          detail: `${amount}, portée par ${who}. ${signal.summary ?? "Le dernier échange dégrade la probabilité de signature."}`,
          priority: ALERT_PRIORITY.gmailRisk,
          weight: o.gmv ?? 0,
        });
      } else if (
        signal.signalType === "signature" &&
        !forecasted.has(o.opportunityId) &&
        (o.gmv ?? 0) >= THRESHOLDS.bigDealGmv
      ) {
        candidates.push({
          level: "info",
          title: `${client} probablement sous-estimée au forecast`,
          detail: `${amount}, portée par ${who}. Le dernier échange annonce un engagement, mais l'affaire n'apparaît pas dans les mouvements du forecast.`,
          priority: ALERT_PRIORITY.gmailUndervalued,
          weight: o.gmv ?? 0,
        });
      }
    }
  }

  // 0. Écarts issus du forecast hebdomadaire, quand le Sheet est branché.
  if (forecast?.mode === "sheet") {
    // Affaire projetée qui n'a plus de correspondance Salesforce.
    // À investiguer — surtout pas comptée perdue d'office.
    const bigGaps = forecast.gaps.filter(
      (g) => (g.projectedGmv ?? 0) >= THRESHOLDS.bigDealGmv / 2,
    );
    if (bigGaps.length > 0) {
      const worst = bigGaps[0];
      candidates.push({
        level: "critique",
        title: `${worst.label} — projetée ${formatEurShort(worst.projectedGmv)}, introuvable dans Salesforce`,
        detail:
          `${worst.owner} · ${worst.reason}` +
          (bigGaps.length > 1 ? ` — et ${bigGaps.length - 1} autre${plural(bigGaps.length - 1, "")}.` : ". À investiguer."),
        priority: ALERT_PRIORITY.forecastGap,
        weight: worst.projectedGmv ?? 0,
      });
    }

    // Affaire repoussée hors du mois forecasté.
    const bigPostponed = forecast.postponed.filter((m) => (m.gmv ?? 0) >= THRESHOLDS.bigDealGmv);
    if (bigPostponed.length > 0) {
      const worst = bigPostponed[0];
      candidates.push({
        level: "critique",
        title: `${worst.client} sort du mois — ${formatEurShort(worst.gmv)}`,
        detail: `${worst.owner} · ${worst.detail}.`,
        priority: ALERT_PRIORITY.forecastPostponed,
        weight: Math.abs(worst.impact),
      });
    }

    // Confiance fortement réduite sur une affaire importante.
    const confidenceDrops = forecast.weakened.filter(
      (m) => /confiance/.test(m.detail) && (m.gmv ?? 0) >= THRESHOLDS.bigDealGmv,
    );
    if (confidenceDrops.length > 0) {
      const worst = confidenceDrops[0];
      candidates.push({
        level: "vigilance",
        title: `Confiance en baisse sur ${worst.client} — ${formatEurShort(worst.gmv)}`,
        detail: `${worst.owner} · ${worst.detail}.`,
        priority: ALERT_PRIORITY.forecastConfidenceDrop,
        weight: Math.abs(worst.impact),
      });
    }
  }

  // 1. Grosse opportunité sans activité récente.
  const dormant = active
    .filter((o) => isBigDeal(o))
    .map((o) => ({ o, days: daysSinceActivity(o, referenceDate) }))
    .filter((x): x is { o: Opportunity; days: number } => x.days !== null && x.days > THRESHOLDS.staleDays)
    .sort((a, b) => (b.o.gmv ?? 0) - (a.o.gmv ?? 0));

  if (dormant.length > 0) {
    const worst = dormant[0];
    const others = dormant.length - 1;
    candidates.push({
      level: worst.days > THRESHOLDS.veryStaleDays ? "critique" : "vigilance",
      title: `${clientOf(worst.o)} — ${formatEurShort(worst.o.gmv)} sans activité depuis ${worst.days} j`,
      detail:
        `${worst.o.owner} · ${worst.o.stage ?? "étape inconnue"}` +
        (others > 0
          ? ` — et ${others} autre${plural(others, "")} grosse${plural(others, "")} ${plural(others, "affaire")} ${plural(others, "dormante")}.`
          : "."),
      priority: ALERT_PRIORITY.dormantBigDeal,
      weight: worst.o.gmv ?? 0,
    });
  }

  // 2. Entrée en stand-by d'une opportunité importante (nécessite un historique).
  const enteredBig = (transitions?.entered ?? []).filter(isBigDeal).sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0));
  if (enteredBig.length > 0) {
    const worst = enteredBig[0];
    candidates.push({
      level: "critique",
      title: `${clientOf(worst)} passée en stand-by — ${formatEurShort(worst.gmv)}`,
      detail: `${worst.owner} · réveil prévu le ${formatFrenchDate(worst.standbyUntil)}.`,
      priority: ALERT_PRIORITY.standbyEntered,
      weight: worst.gmv ?? 0,
    });
  }

  // 3. Sortie de stand-by : l'affaire revient dans le pipe.
  const exited = transitions?.exited ?? [];
  if (exited.length > 0) {
    const worst = [...exited].sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0))[0];
    candidates.push({
      level: "info",
      title: `${exited.length} ${plural(exited.length, "affaire")} ${plural(exited.length, "sortie")} de stand-by`,
      detail: `Dont ${clientOf(worst)} (${formatEurShort(worst.gmv)}, ${worst.owner}) — à relancer.`,
      priority: ALERT_PRIORITY.standbyExited,
      weight: worst.gmv ?? 0,
    });
  }

  // 4. Pipe actif faible.
  const lowPipe = metrics.owners
    .filter((o) => o.activeCount > 0 && o.activeGmv < THRESHOLDS.activeGmvLow)
    .sort((a, b) => a.activeGmv - b.activeGmv);
  if (lowPipe.length > 0) {
    candidates.push({
      level: "vigilance",
      title: `${commerciaux(lowPipe.length)} sous le repère de stock`,
      detail:
        lowPipe.slice(0, 3).map((o) => `${o.owner} ${formatEurShort(o.activeGmv)}`).join(" · ") +
        (lowPipe.length > 3 ? ` et ${lowPipe.length - 3} autre${plural(lowPipe.length - 3, "")}` : "") +
        ` — repère provisoire ${formatEurShort(THRESHOLDS.activeGmvLow)}.`,
      priority: ALERT_PRIORITY.lowPipe,
      weight: lowPipe[0].activeGmv,
    });
  }

  // 5. Commercial sans aucune projection sur le mois courant.
  const noProjection = metrics.owners
    .filter((o) => o.activeCount > 0 && o.projectedThisMonthCount === 0)
    .sort((a, b) => b.activeGmv - a.activeGmv);
  if (noProjection.length > 0) {
    candidates.push({
      level: "vigilance",
      title: `${commerciaux(noProjection.length)} sans projection sur ${MONTH_LABELS[metrics.currentMonth - 1]}`,
      detail:
        noProjection.slice(0, 3).map((o) => `${o.owner} (${o.activeCount} opp actives)`).join(" · ") +
        (noProjection.length > 3 ? ` et ${noProjection.length - 3} autre${plural(noProjection.length - 3, "")}.` : "."),
      priority: ALERT_PRIORITY.ownerNoProjection,
      weight: noProjection[0].activeGmv,
    });
  }

  // 6. Phase avancée, GMV importante, sans Projection Kanban.
  //    Volontairement restreint : l'absence de projection seule n'est pas une alerte.
  const advancedNoProjection = active
    .filter((o) => isAdvancedStage(o.stage) && !o.kanbanRaw && isBigDeal(o))
    .sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0));
  if (advancedNoProjection.length > 0) {
    const worst = advancedNoProjection[0];
    candidates.push({
      level: "vigilance",
      title: `${advancedNoProjection.length} ${plural(advancedNoProjection.length, "affaire")} ${plural(advancedNoProjection.length, "avancée")} sans projection Kanban`,
      detail: `La plus grosse : ${clientOf(worst)} — ${formatEurShort(worst.gmv)}, ${worst.stage}, ${worst.owner}.`,
      priority: ALERT_PRIORITY.advancedNoProjection,
      weight: worst.gmv ?? 0,
    });
  }

  // 7. Stock très ancien encore actif.
  const veryOld = active
    .filter((o) => {
      const age = ageInDays(o, referenceDate);
      return age !== null && age > THRESHOLDS.oldStockDays && isBigDeal(o);
    })
    .sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0));
  if (veryOld.length > 0) {
    const worst = veryOld[0];
    candidates.push({
      level: "info",
      title: `${veryOld.length} ${plural(veryOld.length, "grosse")} ${plural(veryOld.length, "affaire")} de plus d'un an dans le pipe`,
      detail: `La plus grosse : ${clientOf(worst)} — ${formatEurShort(worst.gmv)}, ${worst.owner}. À qualifier ou à sortir.`,
      priority: ALERT_PRIORITY.veryOldStock,
      weight: worst.gmv ?? 0,
    });
  }

  const order: Record<AlertLevel, number> = { critique: 0, vigilance: 1, info: 2 };
  return candidates
    .sort(
      (a, b) =>
        order[a.level] - order[b.level] || b.priority - a.priority || b.weight - a.weight,
    )
    .slice(0, THRESHOLDS.maxAlerts);
}

// --- Bloc 4 : actions du matin -------------------------------------------

/**
 * Anomalie de pistes remontée au Morning.
 *
 * Le Morning sert d'abord à créer de la valeur : faire signer, débloquer du
 * GMV, sauver un dossier. La discipline opérationnelle vient APRÈS. Ces
 * anomalies sont donc agrégées par commercial — jamais listées piste par
 * piste — et plafonnées, pour ne jamais évincer une affaire actionnable.
 */
export type LeadAnomalySummary = {
  owner: string;
  firstName: string;
  firstCallsMissed: number;
  overdue: number;
};

/**
 * Opportunité à débloquer, remontée du Monitoring C2.
 *
 * Ne remonte au Morning que si le GMV le justifie : la création de valeur
 * prime, une anomalie administrative mineure reste dans Monitoring.
 */
export type UnlockableOpportunity = {
  opportunityId: string;
  client: string;
  owner: string;
  gmv: number | null;
  action: string;
  reason: string;
};

export type MorningAction = {
  text: string;
  owner: string;
  /** Contexte court affiché sous l'action. */
  context: string;
};

/**
 * Cinq actions concrètes maximum, chacune rattachée à un commercial et,
 * quand c'est possible, à une opportunité précise. Deux actions au plus
 * par commercial, pour ne pas concentrer la matinée sur une seule personne.
 */
type ActionCandidate = MorningAction & {
  /** Palier de priorité, puis montant pour départager dans un même palier. */
  tier: number;
  amount: number;
  opportunityId: string | null;
  /** L'action vient-elle d'un signal Gmail ? Sert à plafonner leur part. */
  fromMail: boolean;
  /** L'action vient-elle du Monitoring Pistes ? Plafonnée séparément. */
  fromLeads: boolean;
};

/**
 * Part maximale des actions issues de Gmail. Le mail est un signal de plus,
 * pas le seul : le brief doit continuer à remonter les affaires dormantes et
 * les écarts de forecast même lors d'une semaine très bavarde.
 */
const MAX_MAIL_ACTIONS = 3;

/**
 * Part maximale des actions issues du Monitoring Pistes. Le Morning n'est pas
 * un tableau de discipline : deux lignes au plus, jamais davantage.
 */
const MAX_LEAD_ACTIONS = 2;

/**
 * Cinq actions concrètes maximum, chacune rattachée à un commercial et, quand
 * c'est possible, à une opportunité précise.
 *
 * On rassemble d'abord tous les candidats, puis on trie par palier et par
 * montant : une affaire dormante à 800 k€ ne doit jamais être évincée par un
 * écart de forecast à 6 k€. Deux actions au plus par commercial, pour ne pas
 * concentrer la matinée sur une seule personne.
 */
export function buildActions(
  opportunities: Opportunity[],
  metrics: PipelineMetrics,
  topDeals: ScoredDeal[],
  transitions: StandbyTransition | null,
  forecast?: WeekForecast,
  mailSignals?: MailSignalIndex,
  leadAnomalies?: LeadAnomalySummary[],
  unlockable?: UnlockableOpportunity[],
): MorningAction[] {
  const { referenceDate } = metrics;
  const active = opportunities.filter((o) => o.isActive);
  const candidates: ActionCandidate[] = [];

  const add = (
    /** Palier de priorité. Entier pour les actions Salesforce, continu pour Gmail. */
    tier: number,
    amount: number,
    owner: string,
    opportunityId: string | null,
    text: string,
    context: string,
    fromMail = false,
    fromLeads = false,
  ) => candidates.push({ tier, amount, owner, opportunityId, text, context, fromMail, fromLeads });

  // --- Actions issues de Gmail.
  //
  // C'est le bloc que le Passage B devait servir : un signal mail ne vaut que
  // s'il produit un geste concret, nommé, attribué. Chaque action porte donc
  // une opportunité, un commercial et la raison de sa remontée.
  //
  // Ne concerne que les signaux de niveau A ou B : le filtre est appliqué en
  // amont, un fil de niveau C n'arrive jamais ici.
  //
  // PRIORITÉ SANS SEUIL. Le palier d'une action Gmail est un nombre continu :
  //
  //     palier = force du signal
  //            + montant       (progressif, log, jusqu'à +1,0)
  //            + poids forecast (+0,3 si l'affaire est engagée au forecast)
  //            + actionnabilité (+0,2 si un obstacle précis est nommé)
  //
  // Une signature à 9 k€ et une signature à 500 k€ ne se départagent donc plus
  // par un seuil, mais par un écart continu. Les paliers Salesforce existants
  // (entiers 1 à 5) restent comparables : les actions Gmail s'y intercalent.
  if (mailSignals && mailSignals.size > 0) {
    // Affaires sur lesquelles un commercial s'est engagé au forecast : un
    // signal mail y est plus lourd de conséquences qu'ailleurs.
    const inForecast = new Set(
      [
        ...(forecast?.strengthened ?? []),
        ...(forecast?.weakened ?? []),
        ...(forecast?.postponed ?? []),
      ]
        .map((m) => m.opportunityId)
        .filter((id): id is string => Boolean(id)),
    );

    for (const o of active) {
      const signal = mailSignals.get(o.opportunityId);
      if (!signal) continue;
      const client = clientOf(o);
      const who = firstNameOf(o.owner);
      const amount = formatEurShort(o.gmv);
      const since = signal.sentAt
        ? `dernier échange le ${new Date(signal.sentAt).toLocaleDateString("fr-FR")}`
        : "d'après le dernier échange";

      // Force propre au signal, puis les trois majorations continues.
      const strength =
        signal.signalType === "negatif"
          ? 4.2
          : signal.signalType === "signature"
            ? 4.0
            : signal.signalType === "positif_bloque"
              ? 3.5
              : 3.0;
      const priority =
        strength +
        gmvWeight(o.gmv) +
        (inForecast.has(o.opportunityId) ? 0.3 : 0) +
        (signal.blocker ? 0.2 : 0);

      if (signal.signalType === "signature" && !o.isStandby) {
        add(
          priority,
          o.gmv ?? 0,
          o.owner,
          o.opportunityId,
          `Sécuriser la signature de ${client} aujourd'hui avec ${who} : ${amount}.`,
          `Gmail — ${signal.summary ?? "engagement exprimé par le client"} (${since})`,
          true,
        );
      } else if (signal.signalType === "negatif") {
        add(
          priority,
          o.gmv ?? 0,
          o.owner,
          o.opportunityId,
          `Vérifier immédiatement le maintien au forecast de ${client} avec ${who} : ${amount}.`,
          `Gmail — ${signal.summary ?? "le dernier échange indique un abandon"} (${since})`,
          true,
        );
      } else if (signal.signalType === "positif_bloque") {
        const blocker = signal.blocker ?? "le point en suspens";
        add(
          priority,
          o.gmv ?? 0,
          o.owner,
          o.opportunityId,
          `Appeler ${client} pour débloquer ${blocker} — avec ${who}, ${amount}.`,
          `Gmail — ${signal.summary ?? "client favorable, un obstacle subsiste"} (${since})`,
          true,
        );
      } else if (signal.signalType === "risque") {
        const priceIssue = /prix|remise|budget|cher|tarif/i.test(
          `${signal.blocker ?? ""} ${signal.summary ?? ""}`,
        );
        add(
          priority,
          o.gmv ?? 0,
          o.owner,
          o.opportunityId,
          priceIssue
            ? `Challenger le positionnement prix de ${client} avec ${who} : ${amount}.`
            : `Reprendre la main sur ${client} avec ${who} : ${amount}.`,
          `Gmail — ${signal.summary ?? "la probabilité de signature se dégrade"} (${since})`,
          true,
        );
      }
    }
  }

  // --- Opportunités à débloquer (Monitoring C2).
  //
  // C'est de la création de valeur, pas de la discipline : le palier suit donc
  // le montant, comme les actions Gmail, et non un palier plancher.
  for (const o of unlockable ?? []) {
    add(
      3.5 + gmvWeight(o.gmv),
      o.gmv ?? 0,
      o.owner,
      o.opportunityId,
      `${o.action} — ${o.client} avec ${firstNameOf(o.owner)}, ${formatEurShort(o.gmv)}.`,
      `Monitoring — ${o.reason}`,
    );
  }

  // --- Discipline opérationnelle, en dernier recours.
  //
  // Palier volontairement bas : une anomalie de traitement ne doit jamais
  // passer devant une affaire à signer. Elle ne remonte que si le motif est
  // sérieux — plusieurs First Calls manqués, ou un stock d'échéances dépassées.
  for (const anomaly of leadAnomalies ?? []) {
    if (anomaly.firstCallsMissed >= 2) {
      add(
        2.5,
        0,
        anomaly.owner,
        null,
        `Faire le point avec ${anomaly.firstName} : ${anomaly.firstCallsMissed} First Calls passés sans consignation.`,
        "Monitoring Pistes — le détail est dans l'onglet Monitoring",
        false,
        true,
      );
    } else if (anomaly.overdue >= 3) {
      add(
        2,
        0,
        anomaly.owner,
        null,
        `${anomaly.overdue} pistes de ${anomaly.firstName} ont une échéance de rappel dépassée sans suite.`,
        "Monitoring Pistes — le détail est dans l'onglet Monitoring",
        false,
        true,
      );
    }
  }

  // Palier 5 — verrouiller la meilleure opportunité du jour.
  const best = topDeals[0];
  if (best && best.score >= 0.4) {
    add(
      5,
      best.gmv ?? 0,
      best.owner,
      best.opportunity.opportunityId,
      `Verrouiller ${best.client} avec ${best.ownerFirstName} : ${formatEurShort(best.gmv)}${best.kanbanLabel ? `, projetée ${best.kanbanLabel}` : ""}.`,
      `${best.opportunity.stage ?? "étape inconnue"} · confiance ${best.confidence}`,
    );
  }

  // Palier 4 — mouvements du forecast hebdomadaire : le commercial s'est engagé
  //            sur ces affaires, l'écart est donc directement actionnable.
  if (forecast?.mode === "sheet") {
    for (const item of forecast.toChallenge) {
      add(
        4,
        Math.abs(item.impact),
        item.owner,
        item.opportunityId,
        `Challenger ${firstNameOf(item.owner)} sur ${item.client} : ${item.detail}.`,
        `Forecast du ${formatFrenchDate(forecast.referenceDate)}`,
      );
    }
    // Seuls les écarts matériels méritent une des cinq actions ; les autres
    // restent visibles dans le Bloc 2 et sur la page Données.
    for (const gap of forecast.gaps) {
      if ((gap.projectedGmv ?? 0) < THRESHOLDS.bigDealGmv / 2) continue;
      add(
        4,
        gap.projectedGmv ?? 0,
        gap.owner,
        gap.opportunityId,
        `Tirer au clair avec ${firstNameOf(gap.owner)} le sort de ${gap.label} : ${formatEurShort(gap.projectedGmv)} projetés, introuvable dans Salesforce.`,
        "Écart forecast / Salesforce — à investiguer",
      );
    }
  }

  // Palier 4 — stand-by fraîchement posé sur une affaire importante.
  for (const o of (transitions?.entered ?? []).filter(isBigDeal)) {
    add(
      4,
      o.gmv ?? 0,
      o.owner,
      o.opportunityId,
      `Vérifier avec ${firstNameOf(o.owner)} le stand-by de ${clientOf(o)} : ${formatEurShort(o.gmv)} gelés jusqu'au ${formatFrenchDate(o.standbyUntil)}.`,
      "Nouvelle entrée en stand-by",
    );
  }

  // Palier 3 — grosses affaires dormantes.
  const dormant = active
    .filter(isBigDeal)
    .map((o) => ({ o, days: daysSinceActivity(o, referenceDate) }))
    .filter((x): x is { o: Opportunity; days: number } => x.days !== null && x.days > THRESHOLDS.staleDays);
  for (const { o, days } of dormant) {
    add(
      3,
      o.gmv ?? 0,
      o.owner,
      o.opportunityId,
      `Challenger ${firstNameOf(o.owner)} sur ${clientOf(o)} : ${formatEurShort(o.gmv)} en ${o.stage ?? "étape inconnue"}, sans activité depuis ${days} j.`,
      `Dernière activité le ${formatFrenchDate(o.lastActivityAt)}`,
    );
  }

  // Palier 2 — affaires avancées et importantes sans projection Kanban.
  for (const o of active.filter((o) => isAdvancedStage(o.stage) && !o.kanbanRaw && isBigDeal(o))) {
    add(
      2,
      o.gmv ?? 0,
      o.owner,
      o.opportunityId,
      `Demander à ${firstNameOf(o.owner)} une date de signature sur ${clientOf(o)} : ${formatEurShort(o.gmv)} en ${o.stage}, sans projection Kanban.`,
      "Phase avancée, aucune projection renseignée",
    );
  }

  // Palier 1 — réveils de stand-by, puis point de stock.
  for (const o of transitions?.exited ?? []) {
    add(
      1,
      o.gmv ?? 0,
      o.owner,
      o.opportunityId,
      `Relancer ${clientOf(o)} avec ${firstNameOf(o.owner)} : sortie de stand-by, ${formatEurShort(o.gmv)} de retour dans le pipe.`,
      "Sortie de stand-by",
    );
  }
  for (const owner of metrics.owners.filter(
    (o) => o.activeCount > 0 && o.activeGmv < THRESHOLDS.activeGmvLow,
  )) {
    add(
      1,
      THRESHOLDS.activeGmvLow - owner.activeGmv,
      owner.owner,
      null,
      `Faire le point stock avec ${firstNameOf(owner.owner)} : ${formatEurShort(owner.activeGmv)} de pipe actif sur ${owner.activeCount} opportunités.`,
      `Repère provisoire : ${formatEurShort(THRESHOLDS.activeGmvLow)}`,
    );
  }

  // Sélection : palier décroissant, puis montant décroissant.
  const actions: MorningAction[] = [];
  const usedOpportunities = new Set<string>();
  const perOwner = new Map<string, number>();
  let mailActions = 0;
  let leadActions = 0;

  for (const candidate of candidates.sort((a, b) => b.tier - a.tier || b.amount - a.amount)) {
    if (actions.length >= THRESHOLDS.maxActions) break;
    if (candidate.opportunityId && usedOpportunities.has(candidate.opportunityId)) continue;
    if ((perOwner.get(candidate.owner) ?? 0) >= 2) continue;
    if (candidate.fromMail && mailActions >= MAX_MAIL_ACTIONS) continue;
    if (candidate.fromMail) mailActions += 1;
    if (candidate.fromLeads && leadActions >= MAX_LEAD_ACTIONS) continue;
    if (candidate.fromLeads) leadActions += 1;
    if (candidate.opportunityId) usedOpportunities.add(candidate.opportunityId);
    perOwner.set(candidate.owner, (perOwner.get(candidate.owner) ?? 0) + 1);
    actions.push({ text: candidate.text, owner: candidate.owner, context: candidate.context });
  }

  return actions;
}

/** Repère de stock : renvoie le statut d'un commercial vis-à-vis du benchmark. */
export function stockStatus(owner: OwnerMetrics): "confortable" | "limite" | "bas" {
  if (owner.activeGmv >= THRESHOLDS.activeGmvComfortable) return "confortable";
  if (owner.activeGmv >= THRESHOLDS.activeGmvLow) return "limite";
  return "bas";
}

/**
 * Morning V2 — priorité d'action du matin.
 *
 * RÈGLE FONDATRICE, qui distingue Morning de tous les autres écrans :
 *
 *     une affaire statistiquement forte n'est pas une affaire chaude.
 *
 * Un dossier à fort Expected mais silencieux depuis trois relances est
 * intéressant pour Forecast et pour Expected GMV ; il n'a rien à faire en tête
 * du Morning. À l'inverse, un dossier moyen dont le client vient d'écrire
 * « nous souhaitons avancer » est la première chose à traiter aujourd'hui.
 *
 * La priorité Morning est donc une grandeur OPÉRATIONNELLE, distincte de la
 * probabilité Expected. Gmail entre ici, et seulement ici : la probabilité
 * statistique n'est jamais modifiée par un signal mail — elle n'a pas été
 * entraînée avec, et rien ne permet encore de le backtester.
 *
 * Le score numérique existe pour trier ; il n'est jamais affiché. L'utilisateur
 * lit une raison, pas une formule.
 */

import { ATTENTION, MORNING_PLAN, MORNING_PRIORITY } from "./config";
import { parisDate } from "./business-time";
import { buildExpectedGmvSnapshot, type ExpectedGmvOpportunity } from "./expected-gmv-live";
import { buildForecastV2, type ForecastV2Row } from "./forecast-v2";
import { computeMetrics } from "./metrics";
import { doneActionKeys, loadMorningEvents, type MorningEvent } from "./morning-events";
import {
  absenceSignals,
  hasManagerialMotive,
  joinDetail,
  mailMotives,
  mailWording,
  selectSituations,
  type AbsenceSignals,
} from "./morning-plan-select";
import { loadOpportunities } from "./repository";
import { loadStageStability } from "./stage-history";
import { isStagnant, movementText, stagnantDeals } from "./stagnation";
import { loadTeam } from "./team-store";
import type { Opportunity } from "./types";
import { clientLabel, kEur } from "./vocabulary";

export type { MorningAction, MorningReason } from "./morning-types";
export { ASK_LABEL, REASON_LABEL, received } from "./morning-types";
import type { MorningAction } from "./morning-types";
import { received } from "./morning-types";

const HOURS = 36e5;

function hoursSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return (now.getTime() - new Date(iso).getTime()) / HOURS;
}

/**
 * Poids de la fraîcheur du signal client. Un message de ce matin vaut beaucoup
 * plus qu'un message de la semaine dernière : c'est la différence entre une
 * conversation en cours et un dossier à reprendre.
 */
function freshness(iso: string | null, now: Date): number {
  const h = hoursSince(iso, now);
  if (h == null) return 0;
  if (h <= 24) return 1;
  if (h <= 72) return 0.7;
  if (h <= 168) return 0.4;
  return 0.15;
}

/** Poids du GMV, progressif et plafonné : pas de seuil dur. */
function weightGmv(gmv: number | null): number {
  if (!gmv || gmv <= 0) return 0;
  return Math.min(1, Math.log10(1 + gmv / 1000) / Math.log10(1 + MORNING_PRIORITY.gmvReference / 1000));
}

/** Poids du GMV d'une situation par commercial : même courbe, saturation plus haute. */
function weightOwnerGmv(gmv: number | null): number {
  if (!gmv || gmv <= 0) return 0;
  return Math.min(1, Math.log10(1 + gmv / 1000) / Math.log10(1 + MORNING_PLAN.ownerGmvReference / 1000));
}

export type MorningPlan = {
  /**
   * Les situations à traiter maintenant. Jamais plus de `MORNING_PLAN.maxSituations`
   * PAR JOUR, traitées comprises : le budget du jour est `maxSituations` moins
   * celles que Sami a déjà marquées « traitées » aujourd'hui. Traiter une
   * situation ne fait donc jamais remonter la huitième — le Plan ne devient pas
   * un tapis roulant.
   */
  actions: MorningAction[];
  /** Situations marquées « traitées » aujourd'hui. Comptées, jamais listées. */
  doneToday: number;
  /**
   * Le vivier avant sélection : combien de situations candidates, par famille, et
   * leurs clés. Observation (journal, contrôles), jamais affiché.
   */
  pool: {
    total: number;
    byCategory: Record<string, number>;
    keys: string[];
    /** Messages chauds / en attente écartés du Plan faute de motif managérial : ils restent dans les Blocs 1 et 2. */
    mailWithoutMotive: number;
  };
  hot: MorningEvent[];
  waiting: MorningEvent[];
  /** Affaires écartées du haut de Morning faute de signe de vie. */
  silentButStrong: { client: string; salesperson: string; gmv: number | null; expected: number }[];
};

type OwnerAbsence = AbsenceSignals & {
  stagnant: Opportunity[];
  activeGmv: number;
  activeCount: number;
};

/**
 * Construit le plan du matin.
 *
 * Le Plan est une liste COURTE de situations managériales, recalculée en entier
 * depuis l'état courant : aucune tâche persistante, aucun report. Cinq familles
 * portent sur une affaire (client qui parle, client qui attend, affaire
 * décisive, affaire à challenger, proche de la signature) et deux sur un
 * commercial (pipe insuffisant, affaires figées), reprises d'`attention.ts`.
 *
 * Aucune anomalie de suivi n'entre ici du seul fait qu'elle existe : les
 * relances manquées, First Calls et dossiers dormants restent dans Monitoring.
 *
 * Une affaire lourde n'est pas une situation parce qu'elle est lourde : il faut
 * qu'elle appelle le manager (à challenger, figée, ou le client parle). Une
 * grosse affaire qui avance normalement chez un commercial autonome n'occupe
 * pas le Plan.
 */
export function buildMorningPlan(now = new Date()): MorningPlan {
  const today = parisDate(now);
  const { events } = loadMorningEvents();
  const snapshot = buildExpectedGmvSnapshot();
  const board = buildForecastV2(0, null, now);

  const team = loadTeam();
  const firstNameOf = new Map<string, string>(team.map((m) => [m.name, m.firstName]));
  const excludedOwners = new Set<string>(ATTENTION.excluded);
  const opportunities = loadOpportunities();
  const oppById = new Map(opportunities.map((o) => [o.opportunityId, o]));
  const stability = loadStageStability(today);

  const expectedById = new Map<string, ExpectedGmvOpportunity>(
    (snapshot?.opportunities ?? []).map((o) => [o.opportunityId, o]),
  );
  const rowById = new Map<string, ForecastV2Row>(
    board.salespeople.flatMap((s) => s.opportunities).map((o) => [o.opportunityId, o]),
  );
  const challengeIds = new Set(board.examine.map((e) => e.row.opportunityId));
  const challengeById = new Map(board.examine.map((e) => [e.row.opportunityId, e]));
  const perspectiveIds = new Set(
    board.salespeople
      .flatMap((s) => s.opportunities)
      .filter((o) => o.perspectiveMonth === board.month)
      .map((o) => o.opportunityId),
  );
  const kanbanIds = new Set(
    board.salespeople
      .flatMap((s) => s.opportunities)
      .filter((o) => !o.outsideKanban)
      .map((o) => o.opportunityId),
  );

  const pending = events.filter((e) => !e.acknowledged);
  // G — plusieurs signaux chauds successifs du même fil ne sont pas des
  // opportunités distinctes : `isLatestHotInThread` (mutualisée avec
  // `loadMorningEvents`) ne garde que le plus récent. L'historique
  // (`morning_event`) n'est jamais réécrit — seul l'AFFICHAGE en tient compte.
  const hot = pending.filter((e) => e.category === "chaud" && e.isLatestHotInThread);
  // F — une réponse RM postérieure éteint l'attente, indépendamment de
  // l'acquittement : `awaitingReply` porte cette fraîcheur de fil, partagée
  // avec `canonicalClientAttend()`. L'historique (`category`) n'est jamais
  // réécrit — seul l'AFFICHAGE du Bloc 2 (et donc l'action du Plan qui en
  // découle) en tient compte.
  const waiting = pending.filter((e) => e.category === "attente" && e.awaitingReply);

  const spoke = new Map<string, MorningEvent>();
  for (const e of pending) if (e.opportunityId) spoke.set(e.opportunityId, e);

  // --- Absences de signal par commercial. Calculées d'abord : « N affaires
  //     figées » remplace les situations individuelles « figée » de ces affaires.
  const absence = new Map<string, OwnerAbsence>();
  const pipeByOwner = new Map(computeMetrics(opportunities, today).owners.map((o) => [o.owner, o]));
  for (const member of team) {
    if (excludedOwners.has(member.name)) continue;
    const mine = opportunities.filter((o) => o.isActive && o.owner === member.name);
    const stagnant = stagnantDeals(mine, stability, today);
    const pipeRow = pipeByOwner.get(member.name);
    const activeGmv = pipeRow?.activeGmv ?? 0;
    const signals = absenceSignals({
      salesperson: member.name,
      firstName: member.firstName,
      activeCount: mine.length,
      activeGmv,
      staleCount: pipeRow?.staleCount ?? 0,
      stagnant: {
        count: stagnant.length,
        minProvenDays: stagnant.length
          ? Math.min(...stagnant.map((o) => stability.get(o.opportunityId)!.provenDays))
          : 0,
        examples: stagnant.slice(0, 3).map((o) => clientLabel(o.clientContact, o.name)),
      },
    });
    absence.set(member.name, { ...signals, stagnant, activeGmv, activeCount: mine.length });
  }
  /** Affaires déjà couvertes par une situation « N affaires figées » : pas de doublon individuel. */
  const coveredByFrozen = new Set<string>();
  for (const a of absence.values()) {
    if (a.frozen) for (const o of a.stagnant) coveredByFrozen.add(o.opportunityId);
  }

  const candidates: MorningAction[] = [];
  const seen = new Set<string>();
  let mailWithoutMotive = 0;

  /**
   * Formulation d'une situation née d'un mail : le motif managérial dominant
   * donne le titre et le badge ; le mail n'est qu'un signal de fraîcheur.
   */
  const mailWordingOf = (e: MorningEvent, family: "chaud" | "attente", first: string, client: string) => {
    const id = e.opportunityId;
    const opp = id ? oppById.get(id) : undefined;
    const h = hoursSince(e.sentAt, now);
    return mailWording({
      family,
      first,
      client,
      gmv: e.gmv,
      stage: e.stage,
      inChallenge: !!id && challengeIds.has(id),
      challengeKind: id ? (challengeById.get(id)?.kind ?? null) : null,
      stalled: opp ? isStagnant(opp, stability, today) : false,
      waitDays: h == null ? null : h / 24,
      hours: h,
      moveText: moveText(id),
      expectedText: expectedText(id),
      receivedText: received(e.sentAt, now),
    });
  };

  /** Motifs managériaux d'un message client (voir `MORNING_PLAN.mailMotive`). */
  const motivesOf = (e: MorningEvent, family: "chaud" | "attente"): string[] => {
    const id = e.opportunityId;
    const opp = id ? oppById.get(id) : undefined;
    const h = hoursSince(e.sentAt, now);
    return mailMotives({
      family,
      gmv: e.gmv,
      stage: e.stage,
      inChallenge: !!id && challengeIds.has(id),
      stalled: opp ? isStagnant(opp, stability, today) : false,
      waitDays: h == null ? null : h / 24,
    });
  };

  const who = (owner: string | null) => ({
    owner,
    ownerFirstName: owner ? (firstNameOf.get(owner) ?? owner.split(" ")[0]) : null,
    salesperson: owner,
  });
  const nameOf = (first: string | null) => first ?? "Commercial à identifier";
  const expectedText = (id: string | null): string | null => {
    const e = id ? expectedById.get(id) : undefined;
    return e ? `${(e.pMonthEnd * 100).toFixed(0)} % de chance de signer ce mois` : null;
  };
  const moveText = (id: string | null): string | null => {
    const o = id ? oppById.get(id) : undefined;
    return o ? movementText(o, stability, today) : null;
  };

  /** Indicateurs affichables d'une affaire, en langage métier. */
  const factsOf = (id: string | null): string[] => {
    if (!id) return ["Affaire non identifiée"];
    const f: string[] = [];
    const e = expectedById.get(id);
    const r = rowById.get(id);
    if (e) {
      f.push(`${(e.pMonthEnd * 100).toFixed(1).replace(".", ",")} % de chance de signer ce mois`);
      if (e.expectedMonthEnd > 0) f.push(`GMV probable ${Math.round(e.expectedMonthEnd / 1000)} k€`);
      if (e.frozenMonthEnd) f.push("gelée au-delà du mois");
    }
    if (kanbanIds.has(id)) f.push("prévue par le commercial sur le mois");
    if (perspectiveIds.has(id)) f.push("présente dans la dernière Perspective");
    if (challengeIds.has(id)) f.push("affaire à challenger");
    if (r?.nextExpectedLabel) f.push(`prochaine étape : ${r.nextExpectedLabel}`);
    return f;
  };

  const push = (a: MorningAction) => {
    if (seen.has(a.key)) return;
    seen.add(a.key);
    candidates.push(a);
  };

  // 1. Client explicitement motivé. La priorité la plus haute du Morning :
  //    quelqu'un a dit qu'il voulait avancer, et il attend.
  for (const e of hot) {
    const id = e.opportunityId;
    const exp = id ? expectedById.get(id) : undefined;
    const o = who(e.salesperson);
    const client = e.client ?? "Client non identifié";
    // Porte d'entrée : sans motif managérial fort, le message reste dans le Bloc 1.
    const motives = motivesOf(e, "chaud");
    if (motives.length === 0) {
      mailWithoutMotive += 1;
      continue;
    }
    const wording = mailWordingOf(e, "chaud", nameOf(o.ownerFirstName), client);
    push({
      key: `chaud:${e.messageId}`,
      reason: "client_motive",
      category: "chaud",
      source: "gmail",
      why: e.reason,
      todo: e.salesperson
        ? `Appeler ${e.salesperson} pour qu'il traite ce client aujourd'hui`
        : "Identifier le commercial et faire traiter la demande aujourd'hui",
      title: wording.title,
      detail: wording.detail,
      ...(wording.ask ? { ask: wording.ask } : {}),
      motives,
      client,
      ...o,
      gmv: e.gmv,
      stage: e.stage,
      facts: [received(e.sentAt, now), ...factsOf(id)],
      messageId: e.messageId,
      receivedAt: e.sentAt,
      opportunityId: id,
      opportunityIds: id ? [id] : [],
      score:
        MORNING_PRIORITY.weightMotivated +
        MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) +
        MORNING_PRIORITY.weightGmv * weightGmv(e.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0) +
        (id && kanbanIds.has(id) ? MORNING_PRIORITY.bonusKanban : 0) +
        (id && challengeIds.has(id) ? MORNING_PRIORITY.bonusChallenge : 0),
    });
  }

  // 2. Client qui attend une réponse. Moins fort qu'une intention d'avancer,
  //    mais plus urgent : le silence de notre côté est le problème.
  for (const e of waiting) {
    const id = e.opportunityId;
    const exp = id ? expectedById.get(id) : undefined;
    const o = who(e.salesperson);
    const client = e.client ?? "Client non identifié";
    // Porte d'entrée : sans motif managérial fort, le message reste dans le Bloc 2.
    const motives = motivesOf(e, "attente");
    if (motives.length === 0) {
      mailWithoutMotive += 1;
      continue;
    }
    const wording = mailWordingOf(e, "attente", nameOf(o.ownerFirstName), client);
    push({
      key: `attente:${e.messageId}`,
      reason: "client_attend",
      category: "attente",
      source: "gmail",
      why: e.reason,
      todo: e.salesperson
        ? `Faire répondre ${e.salesperson} aujourd'hui`
        : "Identifier le commercial et faire répondre aujourd'hui",
      title: wording.title,
      detail: wording.detail,
      ...(wording.ask ? { ask: wording.ask } : {}),
      motives,
      client,
      ...o,
      gmv: e.gmv,
      stage: e.stage,
      facts: [received(e.sentAt, now), ...factsOf(id)],
      messageId: e.messageId,
      receivedAt: e.sentAt,
      opportunityId: id,
      opportunityIds: id ? [id] : [],
      score:
        MORNING_PRIORITY.weightWaiting +
        MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) +
        MORNING_PRIORITY.weightGmv * weightGmv(e.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0) +
        (id && kanbanIds.has(id) ? MORNING_PRIORITY.bonusKanban : 0),
    });
  }

  // 3. Affaires décisives pour le mois : présentes dans Perspective ou prévues
  //    par le commercial, et suffisamment lourdes. Elles n'entrent QUE si un
  //    motif managérial les appelle — à challenger, figée, ou client qui écrit.
  //    Le poids seul ne suffit plus : une grosse affaire qui avance normalement
  //    chez un commercial autonome n'a pas besoin du manager aujourd'hui.
  for (const row of board.salespeople.flatMap((s) => s.opportunities)) {
    const id = row.opportunityId;
    if (excludedOwners.has(row.owner)) continue;
    const exp = expectedById.get(id);
    const decisive =
      (kanbanIds.has(id) || perspectiveIds.has(id)) &&
      (row.gmv ?? 0) >= MORNING_PRIORITY.decisiveGmv &&
      !row.frozenMonthEnd;
    if (!decisive) continue;
    const e = spoke.get(id);
    const opp = oppById.get(id);
    const stalled = opp ? isStagnant(opp, stability, today) : false;
    if (!hasManagerialMotive({ inChallenge: challengeIds.has(id), stalled, clientSpoke: !!e })) continue;
    // Le pipe figé du commercial est déjà porté, en une ligne, par « N affaires figées ».
    if (stalled && !e && !challengeIds.has(id) && coveredByFrozen.has(id)) continue;
    const o = who(row.owner);
    push({
      key: `decisive:${id}`,
      reason: "affaire_decisive",
      category: "decisive",
      source: "forecast",
      why: e
        ? `Pèse lourd sur le mois, et le client vient d'écrire`
        : "Pèse lourd sur le mois et engage la prévision de l'équipe",
      todo: `Obtenir de ${row.owner} un point précis sur cette affaire`,
      title: `${nameOf(o.ownerFirstName)} — ${row.client} pèse sur le mois`,
      detail: joinDetail([
        row.gmv != null && kEur(row.gmv),
        row.stage,
        e && `client a écrit ${received(e.sentAt, now)}`,
        moveText(id),
        challengeIds.has(id) && "à challenger",
        expectedText(id),
      ]),
      client: row.client,
      ...o,
      gmv: row.gmv,
      stage: row.stage,
      facts: [...(e ? [received(e.sentAt, now)] : []), ...factsOf(id)],
      messageId: e?.messageId ?? null,
      receivedAt: e?.sentAt ?? null,
      opportunityId: id,
      opportunityIds: [id],
      score:
        MORNING_PRIORITY.weightDecisive +
        MORNING_PRIORITY.weightGmv * weightGmv(row.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0) +
        (e ? MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) : 0) +
        (stalled ? MORNING_PLAN.bonusStalled : 0) +
        (challengeIds.has(id) ? MORNING_PRIORITY.bonusChallenge : 0),
    });
  }

  // 4. Affaire à challenger. Vivante (le client écrit) ou figée (aucun mouvement
  //    depuis au moins 14 jours). Une affaire jaune silencieuse ET qui avance
  //    reste dans Forecast : elle n'est pas actionnable ce matin. La liste
  //    « À challenger » n'est pas recalculée ici, elle est lue.
  for (const item of board.examine) {
    const id = item.row.opportunityId;
    if (excludedOwners.has(item.row.owner)) continue;
    const e = spoke.get(id);
    const opp = oppById.get(id);
    const stalled = opp ? isStagnant(opp, stability, today) : false;
    if (!e && !stalled) continue;
    if (!e && coveredByFrozen.has(id)) continue;
    const exp = expectedById.get(id);
    const o = who(item.row.owner);
    push({
      key: `challenge:${id}`,
      reason: e ? "a_challenger_vivante" : "a_challenger_figee",
      category: "challenge",
      source: "forecast",
      why: e ? `${item.reason}, et le client vient d'écrire` : `${item.reason}, et l'affaire ne bouge plus`,
      todo: `Décider avec ${item.row.owner} si l'affaire rentre sur le mois`,
      title: e
        ? `${nameOf(o.ownerFirstName)} — ${item.row.client} à challenger, le client a écrit`
        : `${nameOf(o.ownerFirstName)} — ${item.row.client} à challenger, sans mouvement`,
      detail: joinDetail([
        item.row.gmv != null && kEur(item.row.gmv),
        item.row.stage,
        e && `client a écrit ${received(e.sentAt, now)}`,
        moveText(id),
        item.reason,
      ]),
      client: item.row.client,
      ...o,
      gmv: item.row.gmv,
      stage: item.row.stage,
      facts: [...(e ? [received(e.sentAt, now)] : []), ...factsOf(id)],
      messageId: e?.messageId ?? null,
      receivedAt: e?.sentAt ?? null,
      opportunityId: id,
      opportunityIds: [id],
      score:
        MORNING_PRIORITY.weightChallenge +
        (e ? MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) : 0) +
        MORNING_PRIORITY.weightGmv * weightGmv(item.row.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0) +
        (stalled ? MORNING_PLAN.bonusStalled : 0),
    });
  }

  // 5. Proche de la signature et encore vivante. L'étape Signature est le seul
  //    cas où l'absence de mail ne disqualifie pas : le dossier est au bout.
  for (const o of snapshot?.opportunities ?? []) {
    if (o.stage !== "Signature" || o.frozenMonthEnd) continue;
    if (excludedOwners.has(o.owner)) continue;
    const e = spoke.get(o.opportunityId);
    const w = who(o.owner);
    const client = o.client ?? o.opportunityId;
    push({
      key: `signature:${o.opportunityId}`,
      reason: "proche_signature",
      category: "signature",
      source: "salesforce",
      why: e ? "En signature, et le client vient d'écrire" : "En étape Signature",
      todo: `Vérifier avec ${o.owner} ce qui manque pour signer`,
      title: `${nameOf(w.ownerFirstName)} — ${client} en signature, à sécuriser`,
      detail: joinDetail([
        kEur(o.gmv),
        o.stage,
        e && `client a écrit ${received(e.sentAt, now)}`,
        moveText(o.opportunityId),
        expectedText(o.opportunityId),
      ]),
      client,
      ...w,
      gmv: o.gmv,
      stage: o.stage,
      facts: [...(e ? [received(e.sentAt, now)] : []), ...factsOf(o.opportunityId)],
      messageId: e?.messageId ?? null,
      receivedAt: e?.sentAt ?? null,
      opportunityId: o.opportunityId,
      opportunityIds: [o.opportunityId],
      score:
        MORNING_PRIORITY.weightSignature +
        MORNING_PRIORITY.weightGmv * weightGmv(o.gmv) +
        MORNING_PRIORITY.weightExpected * o.pMonthEnd +
        (e ? MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) : 0),
    });
  }

  // 6. Absences de signal, par commercial. Un commercial au pipe faible ne
  //    produit aucun mail, aucune affaire décisive : sans cette famille il
  //    resterait invisible, alors que son silence est justement le sujet.
  //    Les règles et les seuils sont ceux d'`attention.ts`, pas une copie.
  for (const [name, a] of absence) {
    const first = firstNameOf.get(name) ?? name.split(" ")[0];
    if (a.frozen && a.stagnant.length > 0) {
      const gmv = a.stagnant.reduce((t, o) => t + (o.gmv ?? 0), 0);
      const share = a.activeCount > 0 ? Math.round((a.stagnant.length / a.activeCount) * 100) : 0;
      push({
        key: `figees:${name}`,
        reason: "affaires_figees",
        category: "figees",
        source: "salesforce",
        why: a.frozen.detail,
        todo: `Challenger ${name} sur les prochaines étapes de ses affaires figées`,
        title: `${first} — ${a.stagnant.length} affaires figées · ${kEur(gmv)} concernés`,
        detail: joinDetail([
          a.frozen.detail,
          `${share} % du pipe actif`,
          a.stagnant
            .slice(0, 3)
            .map((o) => clientLabel(o.clientContact, o.name))
            .join(", "),
        ]),
        client: "",
        ...who(name),
        gmv,
        stage: null,
        facts: [a.frozen.detail],
        messageId: null,
        receivedAt: null,
        opportunityId: null,
        opportunityIds: a.stagnant.map((o) => o.opportunityId),
        score:
          MORNING_PLAN.weightFrozen +
          MORNING_PRIORITY.weightGmv * weightOwnerGmv(gmv) +
          MORNING_PLAN.weightFrozenShare * (a.activeCount > 0 ? a.stagnant.length / a.activeCount : 0),
      });
    }
    if (a.pipe) {
      const shortfall = Math.max(0, Math.min(1, (ATTENTION.lowPipeGmv - a.activeGmv) / ATTENTION.lowPipeGmv));
      push({
        key: `pipe_faible:${name}`,
        reason: "pipe_faible",
        category: "pipe_faible",
        source: "salesforce",
        why: a.pipe.detail,
        todo: `Faire reconstituer le pipe de ${name}`,
        title: `${first} — pipe insuffisant : ${kEur(a.activeGmv)}`,
        detail: joinDetail([
          `${a.activeCount} affaire(s) active(s)`,
          `${kEur(a.activeGmv)} de pipe actif`,
          `sous le seuil de ${kEur(ATTENTION.lowPipeGmv)}`,
        ]),
        client: "",
        ...who(name),
        gmv: a.activeGmv,
        stage: null,
        facts: [a.pipe.detail],
        messageId: null,
        receivedAt: null,
        opportunityId: null,
        opportunityIds: [],
        score: MORNING_PLAN.weightLowPipe + MORNING_PRIORITY.weightGmv * shortfall,
      });
    }
  }

  // Sélection : au plus N par commercial, jamais la même affaire deux fois,
  // plafond global absolu.
  //
  // RÈGLE VOLONTAIRE, à ne pas « corriger » : 7 situations MAXIMUM PAR JOURNÉE
  // MÉTIER, situations traitées incluses. Le Plan du jour est un arbitrage du
  // matin, pas une file temps réel : une nouvelle urgence en cours de journée
  // apparaît dans les Blocs 1 et 2, sans recréer de place dans le Plan.
  // (Verrouillé par `morning:plan-v2-verify`, section C3.)
  //
  // Le plafond est un BUDGET JOURNALIER : `maxSituations` moins ce qui a déjà
  // été traité aujourd'hui. Sans cela, traiter les sept situations et recharger
  // la page ferait remonter les sept suivantes — un backlog déguisé, alors que
  // « traité » veut seulement dire « vu et arbitré aujourd'hui ». Les familles
  // nées d'un mail comptent aussi contre leur propre plafond, traitées comprises.
  // Demain, `doneActionKeys` est vide : le Plan repart de l'état courant.
  const done = doneActionKeys(now);
  const doneIn = (prefix: string) => [...done].filter((k) => k.startsWith(prefix)).length;
  const proposed = selectSituations(
    candidates.filter((a) => !done.has(a.key)),
    {
      max: Math.max(0, MORNING_PLAN.maxSituations - done.size),
      perOwner: MORNING_PLAN.maxPerOwner,
      perMailFamily: {
        chaud: Math.max(0, MORNING_PLAN.maxPerMailFamily - doneIn("chaud:")),
        attente: Math.max(0, MORNING_PLAN.maxPerMailFamily - doneIn("attente:")),
      },
    },
  );

  // Ce que Morning a délibérément laissé de côté : fort Expected, aucun signe
  // de vie. Affiché pour que l'arbitrage soit visible et discutable.
  const silentButStrong = (snapshot?.opportunities ?? [])
    .filter(
      (o) =>
        o.expectedMonthEnd >= MORNING_PRIORITY.strongExpected &&
        !spoke.has(o.opportunityId) &&
        // Toute affaire déjà candidate au Plan reste hors de cette liste : une
        // situation traitée ne doit pas réapparaître ici sous prétexte qu'elle a
        // quitté le Plan.
        !candidates.some((a) => a.opportunityIds.includes(o.opportunityId)),
    )
    .sort((a, b) => b.expectedMonthEnd - a.expectedMonthEnd)
    .slice(0, 5)
    .map((o) => ({
      client: o.client ?? o.opportunityId,
      salesperson: o.owner,
      gmv: o.gmv,
      expected: o.expectedMonthEnd,
    }));

  const byCategory: Record<string, number> = {};
  for (const c of candidates) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;

  return {
    actions: proposed,
    doneToday: done.size,
    pool: { total: candidates.length, byCategory, keys: candidates.map((c) => c.key), mailWithoutMotive },
    hot,
    waiting,
    silentButStrong,
  };
}

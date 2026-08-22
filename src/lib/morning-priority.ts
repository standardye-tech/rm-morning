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

import { MORNING_PRIORITY } from "./config";
import { buildExpectedGmvSnapshot, type ExpectedGmvOpportunity } from "./expected-gmv-live";
import { buildForecastV2, type ForecastV2Row } from "./forecast-v2";
import { doneActionKeys, loadMorningEvents, type MorningEvent } from "./morning-events";

export type { MorningAction, MorningReason } from "./morning-types";
export { REASON_LABEL, received } from "./morning-types";
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

export type MorningPlan = {
  actions: MorningAction[];
  /** Actions du jour déjà cochées. Comptées, jamais listées : le plan reste court. */
  doneToday: number;
  hot: MorningEvent[];
  waiting: MorningEvent[];
  lastRead: string | null;
  /** Affaires écartées du haut de Morning faute de signe de vie. */
  silentButStrong: { client: string; salesperson: string; gmv: number | null; expected: number }[];
};

/**
 * Construit le plan du matin.
 *
 * Aucune anomalie de suivi n'entre ici du seul fait qu'elle existe : les
 * relances manquées, First Calls et dossiers dormants restent dans Monitoring.
 * Une affaire n'apparaît que si elle porte une valeur immédiate — un client qui
 * parle, ou un poids décisif sur le mois.
 */
export function buildMorningPlan(now = new Date()): MorningPlan {
  const { events, lastRead } = loadMorningEvents();
  const snapshot = buildExpectedGmvSnapshot();
  const board = buildForecastV2(0);

  const expectedById = new Map<string, ExpectedGmvOpportunity>(
    (snapshot?.opportunities ?? []).map((o) => [o.opportunityId, o]),
  );
  const rowById = new Map<string, ForecastV2Row>(
    board.salespeople.flatMap((s) => s.opportunities).map((o) => [o.opportunityId, o]),
  );
  const challengeIds = new Set(board.examine.map((e) => e.row.opportunityId));
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
  const hot = pending.filter((e) => e.category === "chaud");
  const waiting = pending.filter((e) => e.category === "attente");

  const actions: MorningAction[] = [];
  const seen = new Set<string>();

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
    actions.push(a);
  };

  // 1. Client explicitement motivé. La priorité la plus haute du Morning :
  //    quelqu'un a dit qu'il voulait avancer, et il attend.
  for (const e of hot) {
    const id = e.opportunityId;
    const exp = id ? expectedById.get(id) : undefined;
    push({
      key: `chaud:${e.messageId}`,
      reason: "client_motive",
      why: e.reason,
      todo: e.salesperson
        ? `Appeler ${e.salesperson} pour qu'il traite ce client aujourd'hui`
        : "Identifier le commercial et faire traiter la demande aujourd'hui",
      client: e.client ?? "Client non identifié",
      salesperson: e.salesperson,
      gmv: e.gmv,
      stage: e.stage,
      facts: [received(e.sentAt, now), ...factsOf(id)],
      messageId: e.messageId,
      receivedAt: e.sentAt,
      opportunityId: id,
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
    push({
      key: `attente:${e.messageId}`,
      reason: "client_attend",
      why: e.reason,
      todo: e.salesperson
        ? `Faire répondre ${e.salesperson} aujourd'hui`
        : "Identifier le commercial et faire répondre aujourd'hui",
      client: e.client ?? "Client non identifié",
      salesperson: e.salesperson,
      gmv: e.gmv,
      stage: e.stage,
      facts: [received(e.sentAt, now), ...factsOf(id)],
      messageId: e.messageId,
      receivedAt: e.sentAt,
      opportunityId: id,
      score:
        MORNING_PRIORITY.weightWaiting +
        MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) +
        MORNING_PRIORITY.weightGmv * weightGmv(e.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0) +
        (id && kanbanIds.has(id) ? MORNING_PRIORITY.bonusKanban : 0),
    });
  }

  const spoke = new Map<string, MorningEvent>();
  for (const e of pending) if (e.opportunityId) spoke.set(e.opportunityId, e);

  // 3. Affaires décisives pour le mois : présentes dans Perspective ou prévues
  //    par le commercial, et suffisamment lourdes. Elles entrent même sans mail,
  //    parce que le mois se joue dessus — mais après les clients qui parlent.
  for (const row of board.salespeople.flatMap((s) => s.opportunities)) {
    const id = row.opportunityId;
    const exp = expectedById.get(id);
    const decisive =
      (kanbanIds.has(id) || perspectiveIds.has(id)) &&
      (row.gmv ?? 0) >= MORNING_PRIORITY.decisiveGmv &&
      !row.frozenMonthEnd;
    if (!decisive) continue;
    const e = spoke.get(id);
    push({
      key: `decisive:${id}`,
      reason: "affaire_decisive",
      why: e
        ? `Pèse lourd sur le mois, et le client vient d'écrire`
        : "Pèse lourd sur le mois et engage la prévision de l'équipe",
      todo: `Obtenir de ${row.owner} un point précis sur cette affaire`,
      client: row.client,
      salesperson: row.owner,
      gmv: row.gmv,
      stage: row.stage,
      facts: [...(e ? [received(e.sentAt, now)] : []), ...factsOf(id)],
      messageId: e?.messageId ?? null,
      receivedAt: e?.sentAt ?? null,
      opportunityId: id,
      score:
        MORNING_PRIORITY.weightDecisive +
        MORNING_PRIORITY.weightGmv * weightGmv(row.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0) +
        (e ? MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) : 0),
    });
  }

  // 4. Affaire à challenger DONT le client donne signe de vie. Une affaire
  //    jaune silencieuse reste dans Forecast : elle n'est pas actionnable ce
  //    matin. La liste « À challenger » n'est pas recalculée ici, elle est lue.
  for (const item of board.examine) {
    const id = item.row.opportunityId;
    const e = spoke.get(id);
    if (!e) continue;
    const exp = expectedById.get(id);
    push({
      key: `challenge:${id}`,
      reason: "a_challenger_vivante",
      why: `${item.reason}, et le client vient d'écrire`,
      todo: `Décider avec ${item.row.owner} si l'affaire rentre sur le mois`,
      client: item.row.client,
      salesperson: item.row.owner,
      gmv: item.row.gmv,
      stage: item.row.stage,
      facts: [received(e.sentAt, now), ...factsOf(id)],
      messageId: e.messageId,
      receivedAt: e.sentAt,
      opportunityId: id,
      score:
        MORNING_PRIORITY.weightChallenge +
        MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) +
        MORNING_PRIORITY.weightGmv * weightGmv(item.row.gmv) +
        MORNING_PRIORITY.weightExpected * (exp?.pMonthEnd ?? 0),
    });
  }

  // 5. Proche de la signature et encore vivante. L'étape Signature est le seul
  //    cas où l'absence de mail ne disqualifie pas : le dossier est au bout.
  for (const o of snapshot?.opportunities ?? []) {
    if (o.stage !== "Signature" || o.frozenMonthEnd) continue;
    const e = spoke.get(o.opportunityId);
    push({
      key: `signature:${o.opportunityId}`,
      reason: "proche_signature",
      why: e ? "En signature, et le client vient d'écrire" : "En étape Signature",
      todo: `Vérifier avec ${o.owner} ce qui manque pour signer`,
      client: o.client ?? o.opportunityId,
      salesperson: o.owner,
      gmv: o.gmv,
      stage: o.stage,
      facts: [...(e ? [received(e.sentAt, now)] : []), ...factsOf(o.opportunityId)],
      messageId: e?.messageId ?? null,
      receivedAt: e?.sentAt ?? null,
      opportunityId: o.opportunityId,
      score:
        MORNING_PRIORITY.weightSignature +
        MORNING_PRIORITY.weightGmv * weightGmv(o.gmv) +
        MORNING_PRIORITY.weightExpected * o.pMonthEnd +
        (e ? MORNING_PRIORITY.weightFreshness * freshness(e.sentAt, now) : 0),
    });
  }

  actions.sort((a, b) => b.score - a.score);

  // Ce qui a été coché aujourd'hui sort du plan. Le filtre est appliqué APRÈS le
  // tri et après le calcul des « affaires prometteuses mais silencieuses » : une
  // action faite reste une action que Morning a bien retenue, elle ne doit pas
  // réapparaître ailleurs sous prétexte qu'elle a quitté cette liste.
  const done = doneActionKeys(now);
  const remaining = actions.filter((a) => !done.has(a.key));

  // Ce que Morning a délibérément laissé de côté : fort Expected, aucun signe
  // de vie. Affiché pour que l'arbitrage soit visible et discutable.
  const silentButStrong = (snapshot?.opportunities ?? [])
    .filter(
      (o) =>
        o.expectedMonthEnd >= MORNING_PRIORITY.strongExpected &&
        !spoke.has(o.opportunityId) &&
        !actions.some((a) => a.opportunityId === o.opportunityId),
    )
    .sort((a, b) => b.expectedMonthEnd - a.expectedMonthEnd)
    .slice(0, 5)
    .map((o) => ({
      client: o.client ?? o.opportunityId,
      salesperson: o.owner,
      gmv: o.gmv,
      expected: o.expectedMonthEnd,
    }));

  return {
    actions: remaining,
    doneToday: actions.length - remaining.length,
    hot,
    waiting,
    lastRead,
    silentButStrong,
  };
}

/**
 * Plan du jour — les affaires qui peuvent le plus faire bouger la GMV de M.
 *
 * DOCTRINE. Le Plan sélectionne des AFFAIRES (un OpportunityId par ligne), pas
 * des commerciaux à manager. Le commercial reste affiché — c'est lui qu'il faut
 * challenger — mais il n'est jamais un critère de sélection : aucun plafond par
 * commercial, aucune situation agrégée (« 13 affaires figées », « pipe
 * insuffisant » vivent dans `owner-signals.ts`, pour Performance).
 *
 * Question posée : « quelles affaires, si elles évoluent aujourd'hui, modifient le
 * plus l'atterrissage de M ? » — soit du GMV ANNONCÉ à sécuriser (impact négatif
 * évité), soit de l'UPSIDE à aller chercher (M+1 qui peut basculer sur M, gros
 * dossier bloqué, affaire hors forecast crédible). Ce n'est ni les plus gros
 * montants, ni les plus fortes probabilités, ni les plus vieux dossiers.
 *
 * Les mails ne sont PAS une famille : un message client seul ne prend aucune place
 * dans le Plan (il reste dans les Blocs 1 et 2). Il ne compte que comme SIGNAL DUR
 * de réactivation ou de crédibilité, avec la visite récente ou planifiée.
 *
 * La formule d'impact, les portes et les seuils vivent dans `MORNING_PLAN`
 * (`config.ts`) et `morning-plan-select.ts`. Aucune probabilité Expected n'est
 * jamais modifiée par un signal mail.
 */

import { actionWeekStart, planActionKey, planEventVersion } from "./action-keys";
import { treatedActions } from "./action-state";
import { ATTENTION, MORNING_PLAN, MORNING_PRIORITY } from "./config";
import { parisDate } from "./business-time";
import { buildExpectedGmvSnapshot } from "./expected-gmv-live";
import { buildForecastV2 } from "./forecast-v2";
import { daysSinceActivity } from "./metrics";
import { doneActionKeys, loadMorningEvents, type MorningEvent } from "./morning-events";
import {
  evaluateAffaire,
  hardSignals,
  joinDetail,
  selectAffaires,
  type AffaireInput,
} from "./morning-plan-select";
import { loadMilestoneOpportunities } from "./opportunity-metrics";
import { loadOpportunities } from "./repository";
import { loadStageStability } from "./stage-history";
import { isStagnant } from "./stagnation";
import { loadTeam } from "./team-store";
import { kEur } from "./vocabulary";

export type { MorningAction, MorningReason } from "./morning-types";
export { ASK_LABEL, REASON_LABEL, received } from "./morning-types";
import type { MorningAction, MorningReason } from "./morning-types";

export type MorningPlan = {
  /**
   * Les affaires à traiter maintenant : au plus `MORNING_PLAN.maxSituations` PAR
   * JOUR, traitées comprises (budget journalier), et jamais de remplissage — le
   * Plan peut n'en compter que quatre. Traiter une affaire ne fait donc jamais
   * remonter la suivante.
   */
  actions: MorningAction[];
  /** Affaires marquées « traitées » aujourd'hui. Comptées, jamais listées. */
  doneToday: number;
  /**
   * Le vivier avant sélection, pour l'observation (journal, contrôles) : jamais
   * affiché. `excluded` dit pourquoi les autres affaires n'y sont pas.
   */
  pool: {
    total: number;
    byCategory: Record<string, number>;
    keys: string[];
    all: MorningAction[];
    excluded: Record<string, string>;
  };
  hot: MorningEvent[];
  waiting: MorningEvent[];
  /**
   * Affaires à fort Expected, sans signe de vie, hors du Plan. N'est PLUS rendu
   * (lot de simplification, A3) : chacune a déjà été jugée par `evaluateAffaire`
   * — si elle appelait une action sur M, elle serait dans le Plan ; le motif de
   * son écart est dans `pool.excluded`. Conservé pour l'observation et les
   * contrôles.
   */
  silentButStrong: { opportunityId: string; client: string; salesperson: string; gmv: number | null; expected: number }[];
};

const TODO: Record<MorningReason, (owner: string, client: string) => string> = {
  securiser: (o, c) => `Challenger ${o} pour sécuriser ${c} sur le mois`,
  basculer: (o, c) => `Demander à ${o} ce qu'il faut pour signer ${c} ce mois-ci`,
  bloque: (o, c) => `Challenger ${o} sur le déblocage de ${c}`,
  upside: (o, c) => `Challenger ${o} : pourquoi ${c} n'est pas dans sa prévision`,
  divergence: (o, c) => `Challenger ${o} sur ${c}, annoncée mais que RM Morning n'attend pas`,
};

/** Une phrase : pourquoi cette affaire peut modifier l'atterrissage. */
function whyOf(family: MorningReason, gmv: number, direction: "down" | "up"): string {
  const at = kEur(gmv);
  return direction === "down"
    ? `Jusqu'à ${at} de GMV annoncé sur le mois peut être perdu si elle ne se débloque pas`
    : family === "basculer"
      ? `Jusqu'à ${at} de GMV peut entrer sur le mois si elle signe plus tôt que prévu`
      : `Jusqu'à ${at} de GMV d'upside sur le mois, hors de la prévision commerciale`;
}

export function buildMorningPlan(now = new Date()): MorningPlan {
  const today = parisDate(now);
  const { events } = loadMorningEvents();
  const snapshot = buildExpectedGmvSnapshot();
  const board = buildForecastV2(0, null, now);

  const team = loadTeam();
  const firstNameOf = new Map<string, string>(team.map((m) => [m.name, m.firstName]));
  const excludedOwners = new Set<string>(ATTENTION.excluded);
  const oppById = new Map(loadOpportunities().map((o) => [o.opportunityId, o]));
  const stability = loadStageStability(today);
  const visitById = new Map(loadMilestoneOpportunities().map((m) => [m.opportunityId, m.nextVisitAt]));
  const challengeById = new Map(board.examine.map((e) => [e.row.opportunityId, e]));
  const week = actionWeekStart(now);

  // Dernier message entrant du client par affaire, acquitté ou non : c'est une
  // preuve de vie du client, pas une tâche.
  const lastInbound = new Map<string, string>();
  // Le message lui-même : il versionne l'action du Plan (nouvel événement).
  const lastInboundId = new Map<string, string>();
  for (const e of events) {
    if (!e.opportunityId || !e.sentAt) continue;
    const prev = lastInbound.get(e.opportunityId);
    if (!prev || new Date(e.sentAt) > new Date(prev)) {
      lastInbound.set(e.opportunityId, e.sentAt);
      lastInboundId.set(e.opportunityId, e.messageId);
    }
  }

  const pending = events.filter((e) => !e.acknowledged);
  const hot = pending.filter((e) => e.category === "chaud" && e.isLatestHotInThread);
  const waiting = pending.filter((e) => e.category === "attente" && e.awaitingReply);

  // --- Le pipe pertinent : toutes les affaires scorées ou déclarées de M.
  const candidates: MorningAction[] = [];
  const excluded: Record<string, string> = {};
  for (const row of board.salespeople.flatMap((s) => s.opportunities)) {
    const id = row.opportunityId;
    const opp = oppById.get(id);
    if (row.isSignedRow || !opp || opp.isSigned || opp.isTerminal) continue;
    if (excludedOwners.has(row.owner)) {
      excluded[id] = "commercial exclu (directeur régional)";
      continue;
    }
    const stalled = isStagnant(opp, stability, today);
    const input: AffaireInput = {
      opportunityId: id,
      client: row.client,
      owner: row.owner,
      gmv: row.gmv ?? 0,
      stage: row.stage,
      pMonthEnd: row.expectedProbability ?? 0,
      scored: row.expectedProbability != null,
      declaredOnM: row.kanbanMonth === board.month || row.perspectiveMonth === board.month,
      kanbanMonth: row.kanbanMonth,
      challengeKind: challengeById.get(id)?.kind ?? null,
      stalled,
      stalledDays: stalled ? (stability.get(id)?.provenDays ?? null) : null,
      daysSinceActivity: daysSinceActivity(opp, today),
      standby: !!row.isStandby,
      frozenMonthEnd: !!row.frozenMonthEnd,
      hard: hardSignals({ lastInboundAt: lastInbound.get(id) ?? null, nextVisitAt: visitById.get(id) ?? null }, now),
    };
    const verdict = evaluateAffaire(input);
    if (!verdict.eligible) {
      excluded[id] = verdict.why;
      continue;
    }
    const first = firstNameOf.get(row.owner) ?? row.owner.split(" ")[0];
    const reason = verdict.family;
    candidates.push({
      // Même motif, mêmes signaux durs = même action toute la semaine ; un
      // nouveau message client ou une nouvelle visite = une nouvelle action.
      key: planActionKey(
        id,
        reason,
        week,
        planEventVersion({ lastInboundMessageId: lastInboundId.get(id) ?? null, nextVisitAt: visitById.get(id) ?? null }),
      ),
      reason,
      category: reason,
      source: reason === "bloque" ? "salesforce" : "forecast",
      why: whyOf(reason, input.gmv, verdict.direction),
      todo: TODO[reason](row.owner, row.client),
      title: `${first} — ${row.client}`,
      detail: joinDetail([kEur(input.gmv), row.stage, ...verdict.reasons]),
      client: row.client,
      owner: row.owner,
      ownerFirstName: first,
      salesperson: row.owner,
      gmv: input.gmv,
      stage: row.stage,
      facts: verdict.reasons,
      messageId: null,
      receivedAt: null,
      opportunityId: id,
      opportunityIds: [id],
      score: verdict.impact,
    });
  }

  // Budget JOURNALIER : `maxSituations` moins ce qui a déjà été traité aujourd'hui.
  // RÈGLE VOLONTAIRE, à ne pas « corriger » : 7 affaires MAXIMUM PAR JOURNÉE
  // MÉTIER, traitées incluses. Le Plan du jour est un arbitrage du matin, pas une
  // file temps réel : une nouvelle urgence en cours de journée apparaît dans les
  // Blocs 1 et 2, sans recréer de place dans le Plan. Demain, le budget repart
  // à zéro (`doneActionKeys` ne compte que le jour même). (Verrouillé par
  // `morning:plan-v2-verify`.)
  //
  // État PARTAGÉ (`action-state`) : une affaire traitée ici ou dans « Ma
  // semaine » (même ActionKey) ne revient pas de la semaine tant que son motif
  // ne change pas. Le budget compte ce qui a été traité AUJOURD'HUI, où que ce
  // soit ; l'ancienne coche journalière (`affaire:…`) du jour reste honorée.
  const done = doneActionKeys(now);
  const treated = treatedActions(candidates.map((a) => a.key));
  const actions = selectAffaires(
    candidates
      .filter((a) => !treated.has(a.key) && !done.has(`affaire:${a.opportunityId}`))
      .map((a) => ({ ...a, impact: a.score, gmv: a.gmv ?? 0 })),
    Math.max(0, MORNING_PLAN.maxSituations - done.size),
  ).map(({ impact, ...a }) => {
    void impact; // le score de tri reste dans `score` ; `impact` n'était qu'une clé de tri
    return a as MorningAction;
  });

  // Ce que Morning a délibérément laissé de côté : fort Expected, aucun signe de
  // vie, et hors du Plan. Affiché pour que l'arbitrage soit visible.
  const spoke = new Set(pending.map((e) => e.opportunityId).filter((x): x is string => !!x));
  const silentButStrong = (snapshot?.opportunities ?? [])
    .filter(
      (o) =>
        o.expectedMonthEnd >= MORNING_PRIORITY.strongExpected &&
        !spoke.has(o.opportunityId) &&
        !candidates.some((a) => a.opportunityId === o.opportunityId),
    )
    .sort((a, b) => b.expectedMonthEnd - a.expectedMonthEnd)
    .slice(0, 5)
    .map((o) => ({ opportunityId: o.opportunityId, client: o.client ?? o.opportunityId, salesperson: o.owner, gmv: o.gmv, expected: o.expectedMonthEnd }));

  const byCategory: Record<string, number> = {};
  for (const c of candidates) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;

  return {
    actions,
    doneToday: done.size,
    pool: { total: candidates.length, byCategory, keys: candidates.map((c) => c.key), all: candidates, excluded },
    hot,
    waiting,
    silentButStrong,
  };
}

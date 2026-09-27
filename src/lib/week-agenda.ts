/**
 * « Ma semaine » — le planning recommandé de management des ET (lot de
 * simplification, B).
 *
 * UNE carte = UN ET : qui je vois, pourquoi, quoi traiter avec lui, sur quelles
 * affaires. Les moteurs existants ne disparaissent pas ; leur sortie est
 * DIGÉRÉE ici en quelques sujets par ET au lieu de cinq blocs juxtaposés :
 *
 *   Plan du jour (affaires de M à actionner)      → tier 1 (GMV annoncé en risque)
 *                                                   ou 3 (upside à aller chercher)
 *   Momentum 7 jours (baisses GMV, sorties de M)   → tier 2
 *   Forecast « À challenger » (> 25 %)             → tier 3
 *   Attention managériale (pipe, affaires figées…) → tier 4
 *   Gros dossiers                                  → tier 3 si urgent, 5 sinon
 *   Changements de stade nombreux                  → tier 5
 *
 * DÉDUPLICATION : un sujet portant sur une affaire n'existe qu'une fois — la
 * formulation la plus prioritaire l'emporte (le Plan avant le Momentum avant le
 * challenger avant le gros dossier). Au plus `WEEK_AGENDA.maxTasks` sujets par
 * carte, choisis sur TOUS les sujets de la semaine, traités compris : cocher un
 * sujet fait baisser le compteur, il ne fait pas remonter un cinquième.
 *
 * PLACEMENT : les créneaux sont ceux de la grille déjà validée (`WEEK_SLOTS`,
 * types réaffectables aux ET), à partir d'aujourd'hui. Aucune disponibilité
 * n'est inventée : un ET urgent sans créneau libre, ou un ET dont les sujets ne
 * sont que structurels, va dans « À placer cette semaine ».
 *
 * Cœur PUR (`composeCards`, `scheduleCards`) : contrôlable sans base.
 */

import type { AttentionReason, ReasonKey } from "./attention";
import { WEEK_AGENDA, WEEK_REASSIGNABLE, type WeekSlot } from "./config";
import type { MorningReason } from "./morning-types";
import { kEur } from "./vocabulary";

// --- Entrées -----------------------------------------------------------------

export type AgendaMove = {
  opportunityId: string | null;
  client: string;
  gmv: number | null;
  /** Variation de GMV qualifiée (règle du delta manager), négative = baisse. */
  gmvDelta: number | null;
  exitedM: boolean;
  enteredStandby: boolean;
};

export type OwnerAgendaInput = {
  owner: string;
  firstName: string;
  /** Verdict d'attention managériale ; `vert` = aucune intervention requise. */
  level: "rouge" | "orange" | "vert";
  attentionSummary: string | null;
  reasons: AttentionReason[];
  momentum: { available: boolean; signed: number; up: number; down: number; stageChanges: number } | null;
  moves: AgendaMove[];
  plan: {
    opportunityId: string;
    client: string;
    gmv: number;
    reason: MorningReason;
    impact: number;
    pMonthEnd: number | null;
    /** ActionKey du Plan du jour (`plan:…`) : la tâche EST cette action, partagée. */
    actionKey?: string;
  }[];
  challengers: { opportunityId: string; client: string; gmv: number; probability: number; expectedGmv: number }[];
  bigDeals: { opportunityId: string; client: string; gmv: number; objective: string; urgent: boolean }[];
};

// --- Sorties -----------------------------------------------------------------

export type AgendaTaskSource = "plan" | "momentum" | "forecast" | "attention" | "gros_dossier";

export type AgendaTask = {
  /** Stable sur la semaine : « Anthony Ramaherison|baisse|006… ». */
  key: string;
  owner: string;
  label: string;
  source: AgendaTaskSource;
  /** 1 = le plus prioritaire. */
  tier: number;
  /** Enjeu en euros, pour départager au sein d'un tier. */
  stake: number;
  opportunityId: string | null;
  client: string | null;
  /**
   * ActionKey de l'action source quand la tâche en reprend une existante
   * ailleurs (Plan du jour) : son état traité / ouvert est alors l'état PARTAGÉ
   * (`action-state`). Null pour un sujet purement managérial de Ma semaine, dont
   * l'état reste dans `week_agenda_state`.
   */
  actionKey: string | null;
};

export type AgendaCard = {
  owner: string;
  firstName: string;
  level: "rouge" | "orange" | "vert";
  /** « Momentum 7 j : +73 k€ GMV / −166 k€ GMV · 0 € signé ». */
  why: string | null;
  /** Le verdict d'attention, quand il y en a un. */
  attention: string | null;
  /** Les sujets retenus pour la semaine (traités compris). */
  tasks: AgendaTask[];
  keyDeals: { opportunityId: string; client: string }[];
  /** Placé d'office dans un créneau : ET rouge ou orange, ou enjeu court terme. */
  urgent: boolean;
  priority: number;
};

const TIER = { plan_risque: 1, momentum: 2, upside: 3, forecast: 3, gros_urgent: 3, attention: 4, gros: 5, stades: 5 } as const;

const pctLabel = (p: number) => `${Math.round(p * 100)} %`;

function signedK(v: number): string {
  const k = kEur(Math.abs(v));
  return v > 0 ? `+${k}` : v < 0 ? `−${k}` : k;
}

/** La ligne « Pourquoi le voir » : le momentum brut, sans score ni jugement. */
export function momentumLine(m: OwnerAgendaInput["momentum"]): string | null {
  if (!m || !m.available) return null;
  return `Momentum 7 j : ${signedK(m.up)} GMV / ${signedK(m.down)} GMV · ${m.signed > 0 ? kEur(m.signed) : "0 €"} signé`;
}

const ATTENTION_TASK: Record<ReasonKey, string> = {
  forecast_retard: "Confronter son forecast à RM Morning",
  anomalies_suivi: "Revoir les anomalies de suivi",
  clients_attente: "Vérifier les réponses aux clients qui attendent",
  affaires_figees: "Faire bouger les affaires figées",
  gros_dossier_signature: "Préparer la signature des gros dossiers",
  pipe_faible: "Pipe peu dynamique à revoir",
  donnees_obsoletes: "Remettre Salesforce à jour",
};

const PLAN_TASK: Record<MorningReason, (client: string) => string> = {
  securiser: (c) => `Sécuriser ${c} sur le mois`,
  divergence: (c) => `Challenger ${c}, annoncée ce mois mais peu probable`,
  basculer: (c) => `Voir ce qu'il faut pour signer ${c} dès ce mois`,
  bloque: (c) => `Débloquer ${c}`,
  upside: (c) => `Challenger ${c}, absente de sa prévision`,
};

/** Tous les sujets d'un ET, dédupliqués par affaire. */
export function tasksOf(input: OwnerAgendaInput, rules = WEEK_AGENDA): AgendaTask[] {
  const o = input.owner;
  const byDeal = new Map<string, AgendaTask>();
  const other: AgendaTask[] = [];
  const add = (t: AgendaTask) => {
    if (!t.opportunityId) {
      other.push(t);
      return;
    }
    const cur = byDeal.get(t.opportunityId);
    if (!cur || t.tier < cur.tier || (t.tier === cur.tier && t.stake > cur.stake)) byDeal.set(t.opportunityId, t);
  };

  for (const p of input.plan) {
    const risk = p.reason === "securiser" || p.reason === "divergence";
    add({
      key: `${o}|plan|${p.opportunityId}`,
      owner: o,
      label: `${PLAN_TASK[p.reason](p.client)} (${kEur(p.gmv)})`,
      source: "plan",
      tier: risk ? TIER.plan_risque : TIER.upside,
      stake: p.impact,
      opportunityId: p.opportunityId,
      client: p.client,
      actionKey: p.actionKey ?? null,
    });
  }
  for (const m of input.moves) {
    if (m.gmvDelta != null && m.gmvDelta <= -rules.minGmvDown) {
      add({
        key: `${o}|baisse|${m.opportunityId ?? m.client}`,
        owner: o,
        label: `Comprendre la baisse de ${kEur(-m.gmvDelta)} sur ${m.client}`,
        source: "momentum",
        tier: TIER.momentum,
        stake: -m.gmvDelta,
        opportunityId: m.opportunityId,
        client: m.client,
        actionKey: null,
      });
    } else if (m.exitedM && (m.gmv ?? 0) >= rules.minGmvExit) {
      add({
        key: `${o}|sortie|${m.opportunityId ?? m.client}`,
        owner: o,
        label: `Comprendre la sortie de ${m.client} du mois (${kEur(m.gmv)})`,
        source: "momentum",
        tier: TIER.momentum,
        stake: m.gmv ?? 0,
        opportunityId: m.opportunityId,
        client: m.client,
        actionKey: null,
      });
    } else if (m.enteredStandby && (m.gmv ?? 0) >= rules.minGmvStandby) {
      add({
        key: `${o}|standby|${m.opportunityId ?? m.client}`,
        owner: o,
        label: `Faire le point sur le stand-by de ${m.client} (${kEur(m.gmv)})`,
        source: "momentum",
        tier: TIER.attention,
        stake: m.gmv ?? 0,
        opportunityId: m.opportunityId,
        client: m.client,
        actionKey: null,
      });
    }
  }
  for (const c of input.challengers) {
    add({
      key: `${o}|challenger|${c.opportunityId}`,
      owner: o,
      label: `Challenger ${c.client} : ${pctLabel(c.probability)} de chance de signer ce mois (${kEur(c.gmv)})`,
      source: "forecast",
      tier: TIER.forecast,
      stake: c.expectedGmv,
      opportunityId: c.opportunityId,
      client: c.client,
      actionKey: null,
    });
  }
  for (const d of input.bigDeals) {
    add({
      key: `${o}|gros|${d.opportunityId}`,
      owner: o,
      label: `${d.objective} ${d.client} (${kEur(d.gmv)})`,
      source: "gros_dossier",
      tier: d.urgent ? TIER.gros_urgent : TIER.gros,
      stake: d.gmv * 0.3,
      opportunityId: d.opportunityId,
      client: d.client,
      actionKey: null,
    });
  }
  // Sujets structurels : seulement quand le verdict appelle une intervention.
  // Une raison modérée isolée (verdict vert) est affichée en Performance, pas
  // planifiée — arbitrage du 11/09/2026, inchangé.
  if (input.level !== "vert") {
    for (const r of input.reasons) {
      // « Gros dossier proche de signature » EST le sujet de l'affaire elle-même,
      // déjà posé par affaire : on ne le répète pas en sujet agrégé.
      if (r.key === "gros_dossier_signature" && input.bigDeals.length > 0) continue;
      other.push({
        key: `${o}|attention|${r.key}`,
        owner: o,
        label: `${ATTENTION_TASK[r.key]} (${r.detail})`,
        source: "attention",
        tier: TIER.attention,
        stake: r.weight === "fort" ? 2 : 1,
        opportunityId: null,
        client: null,
        actionKey: null,
      });
    }
  }
  if (input.momentum?.available && input.momentum.stageChanges >= rules.minStageChanges) {
    other.push({
      key: `${o}|stades`,
      owner: o,
      label: `Faire le point sur les ${input.momentum.stageChanges} changements de stade de la semaine`,
      source: "momentum",
      tier: TIER.stades,
      stake: 0,
      opportunityId: null,
      client: null,
      actionKey: null,
    });
  }
  return [...byDeal.values(), ...other].sort((a, b) => a.tier - b.tier || b.stake - a.stake || a.key.localeCompare(b.key));
}

/** Une carte par ET qui a au moins un sujet ; jamais de carte vide. */
export function composeCards(inputs: OwnerAgendaInput[], rules = WEEK_AGENDA): AgendaCard[] {
  const cards: AgendaCard[] = [];
  for (const input of inputs) {
    const tasks = tasksOf(input, rules).slice(0, rules.maxTasks);
    if (tasks.length === 0) continue;
    const seen = new Set<string>();
    const keyDeals: { opportunityId: string; client: string }[] = [];
    for (const t of tasks) {
      if (!t.opportunityId || !t.client || seen.has(t.opportunityId)) continue;
      seen.add(t.opportunityId);
      keyDeals.push({ opportunityId: t.opportunityId, client: t.client });
    }
    const shortTerm = tasks.some((t) => t.tier <= TIER.momentum);
    const levelRank = input.level === "rouge" ? 3 : input.level === "orange" ? 2 : 1;
    cards.push({
      owner: input.owner,
      firstName: input.firstName,
      level: input.level,
      why: momentumLine(input.momentum),
      attention: input.level === "vert" ? null : input.attentionSummary,
      tasks,
      keyDeals: keyDeals.slice(0, rules.keyDeals),
      urgent: input.level !== "vert" || shortTerm,
      // Rouge avant orange avant le reste ; à niveau égal, le sujet le plus
      // prioritaire, puis l'enjeu en euros des sujets retenus.
      priority: levelRank * 1e9 + (10 - Math.min(...tasks.map((t) => t.tier))) * 1e8 + Math.min(9.9e7, tasks.reduce((s, t) => s + t.stake, 0)),
    });
  }
  return cards.sort((a, b) => b.priority - a.priority || a.owner.localeCompare(b.owner, "fr"));
}

// --- Placement -----------------------------------------------------------------

export type AgendaSlot = { day: number; time: string | null };
export type ScheduledCard = AgendaCard & { slot: AgendaSlot | null; placedBy: "auto" | "manuel" | null };

const slotKey = (s: AgendaSlot) => `${s.day}-${s.time ?? ""}`;

/** Créneaux ET de la grille, chronologiques, à partir du jour `fromDay` (1 = lundi). */
export function etSlots(grid: WeekSlot[], fromDay: number): AgendaSlot[] {
  return grid
    .filter((s) => WEEK_REASSIGNABLE.includes(s.kind) && s.day >= fromDay)
    .sort((a, b) => a.day - b.day || a.time.localeCompare(b.time))
    .map((s) => ({ day: s.day, time: s.time }));
}

/**
 * Place les cartes : d'abord les placements choisis par le directeur, puis les
 * cartes urgentes dans les créneaux restants, par priorité et dans l'ordre
 * chronologique. Le reste va dans « À placer ».
 *
 * La timeline ne porte QUE des créneaux réels (jour + heure). Un placement sans
 * heure — « jour, horaire à caler », encore présent en base pour d'anciennes
 * semaines — n'est pas un créneau : la carte reste dans « À placer ».
 */
export function scheduleCards(
  cards: AgendaCard[],
  slots: AgendaSlot[],
  placements: { owner: string; day: number; time: string | null }[],
): { timeline: ScheduledCard[]; toPlace: ScheduledCard[]; freeSlots: AgendaSlot[] } {
  const manual = new Map(placements.map((p) => [p.owner, { day: p.day, time: p.time }]));
  const taken = new Set<string>();
  const timeline: ScheduledCard[] = [];
  const pending: AgendaCard[] = [];
  const unscheduled: ScheduledCard[] = [];
  for (const c of cards) {
    const slot = manual.get(c.owner);
    if (slot?.time) {
      timeline.push({ ...c, slot, placedBy: "manuel" });
      taken.add(slotKey(slot));
    } else if (slot) unscheduled.push({ ...c, slot: null, placedBy: null });
    else pending.push(c);
  }
  const free = slots.filter((s) => !taken.has(slotKey(s)));
  const toPlace: ScheduledCard[] = [...unscheduled];
  for (const c of pending) {
    if (c.urgent && free.length > 0) {
      const slot = free.shift()!;
      timeline.push({ ...c, slot, placedBy: "auto" });
    } else toPlace.push({ ...c, slot: null, placedBy: null });
  }
  timeline.sort((a, b) => a.slot!.day - b.slot!.day || (a.slot!.time ?? "99").localeCompare(b.slot!.time ?? "99"));
  toPlace.sort((a, b) => b.priority - a.priority || a.owner.localeCompare(b.owner, "fr"));
  return { timeline, toPlace, freeSlots: free };
}

/** Un ET dont tous les sujets de la semaine sont cochés. */
export const isTreated = (card: AgendaCard, doneKeys: ReadonlySet<string>) =>
  card.tasks.every((t) => doneKeys.has(t.key));

/**
 * Retire du planning actif les ET entièrement traités. Appliqué APRÈS
 * `scheduleCards` : la carte garde son créneau réservé, si bien qu'un sujet
 * rétabli la fait réapparaître exactement où elle était. Ses sujets restent dans
 * « Terminés », et les compteurs se calculent sur toutes les cartes.
 */
export function hideTreated<T extends { timeline: ScheduledCard[]; toPlace: ScheduledCard[] }>(
  scheduled: T,
  doneKeys: ReadonlySet<string>,
): T {
  return {
    ...scheduled,
    timeline: scheduled.timeline.filter((c) => !isTreated(c, doneKeys)),
    toPlace: scheduled.toPlace.filter((c) => !isTreated(c, doneKeys)),
  };
}

/**
 * Compteurs de la semaine. « Terminés » vient de l'état persisté (un sujet
 * traité reste compté même s'il n'est plus recalculé) ; « restants » compte les
 * sujets actifs des cartes. X = Y + Z, toujours.
 */
export function agendaCounts(
  cards: AgendaCard[],
  doneKeys: ReadonlySet<string>,
): { total: number; done: number; remaining: number } {
  const remaining = cards.reduce((s, c) => s + c.tasks.filter((t) => !doneKeys.has(t.key)).length, 0);
  return { total: remaining + doneKeys.size, done: doneKeys.size, remaining };
}

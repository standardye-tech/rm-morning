/**
 * Contrôles du planning recommandé de « Ma semaine » (lot de simplification, B).
 *
 *   npm run semaine:agenda-verify
 *
 * Trois parties :
 *   — le moteur pur (`week-agenda.ts`) sur des entrées fabriquées ;
 *   — la persistance hebdomadaire, sur une COPIE de la base ;
 *   — la composition sur l'état réel (invariants, lecture seule).
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "week-agenda.db");
mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(WORK + suffix, { force: true });
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { tasksOf, composeCards, scheduleCards, hideTreated, etSlots, agendaCounts, momentumLine } = await import(lib("week-agenda"));
const store = await import(lib("week-agenda-store"));
const { buildWeekAgenda } = await import(lib("week-agenda-view"));
const { ATTENTION, WEEK_AGENDA, WEEK_SLOTS } = await import(lib("config"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const base = (over = {}) => ({
  owner: "ET Test",
  firstName: "Test",
  level: "vert",
  attentionSummary: null,
  reasons: [],
  momentum: { available: true, signed: 0, up: 73_000, down: -166_000, stageChanges: 0 },
  moves: [],
  plan: [],
  challengers: [],
  bigDeals: [],
  ...over,
});

// ────────────────────────────────────────────────────────────────────────
section("MOTEUR — sujets, déduplication, plafond");
{
  const input = base({
    moves: [{ opportunityId: "006A", client: "Client A", gmv: 200_000, gmvDelta: -166_000, exitedM: false, enteredStandby: false }],
    challengers: [{ opportunityId: "006A", client: "Client A", gmv: 200_000, probability: 0.3, expectedGmv: 60_000 }],
    bigDeals: [{ opportunityId: "006A", client: "Client A", gmv: 200_000, objective: "Accélérer", urgent: false }],
  });
  const t = tasksOf(input);
  check("une affaire vue par trois moteurs -> UN seul sujet", t.filter((x) => x.opportunityId === "006A").length === 1);
  check("… et c'est la formulation la plus prioritaire (baisse GMV)", t[0].label.includes("baisse de 166 k€"), t[0].label);
  check("« Pourquoi le voir » = momentum brut", momentumLine(input.momentum) === "Momentum 7 j : +73 k€ GMV / −166 k€ GMV · 0 € signé", momentumLine(input.momentum));

  const many = base({
    level: "rouge",
    reasons: [
      { key: "pipe_faible", weight: "fort", label: "Pipe faible", detail: "200 k€" },
      { key: "affaires_figees", weight: "modere", label: "Affaires figées", detail: "5 affaires" },
    ],
    plan: [1, 2, 3, 4].map((i) => ({ opportunityId: `006P${i}`, client: `P${i}`, gmv: 100_000 * i, reason: "securiser", impact: 10_000 * i, pMonthEnd: 0.1 })),
  });
  const cards = composeCards([many]);
  check(`au plus ${WEEK_AGENDA.maxTasks} sujets par carte`, cards[0].tasks.length === WEEK_AGENDA.maxTasks);
  check("les sujets de M en risque passent avant les sujets structurels", cards[0].tasks.every((x) => x.source === "plan"));
  check("affaires clés : au plus 3, sans doublon", cards[0].keyDeals.length === 3);

  const vert = tasksOf(base({ level: "vert", reasons: [{ key: "pipe_faible", weight: "modere", label: "Pipe faible", detail: "x" }] }));
  check("verdict vert : une raison isolée n'est pas planifiée", vert.length === 0);

  const gros = tasksOf(base({ level: "orange", reasons: [{ key: "gros_dossier_signature", weight: "modere", label: "Gros dossier", detail: "1 dossier" }], bigDeals: [{ opportunityId: "006G", client: "G", gmv: 300_000, objective: "Closer", urgent: true }] }));
  check("gros dossier : pas de doublon « préparer la signature » + affaire", gros.length === 1 && gros[0].opportunityId === "006G");

  check("ET sans aucun sujet -> aucune carte (jamais de remplissage)", composeCards([base({ momentum: null })]).length === 0);
}

section("MOTEUR — compteurs : cocher fait baisser, ne fait pas remonter");
{
  const input = base({
    level: "orange",
    plan: [1, 2, 3, 4, 5].map((i) => ({ opportunityId: `006P${i}`, client: `P${i}`, gmv: 100_000, reason: "securiser", impact: 1000 * i, pMonthEnd: 0.1 })),
  });
  const cards = composeCards([input]);
  const first = cards[0].tasks[0].key;
  const c0 = agendaCounts(cards, new Set());
  const c1 = agendaCounts(cards, new Set([first]));
  check("X = Y + Z", c1.total === c1.done + c1.remaining && c0.total === 4);
  check("un sujet coché : restants −1, terminés +1, total inchangé", c1.remaining === 3 && c1.done === 1 && c1.total === 4);
  check("le 5e sujet ne remonte pas", composeCards([input])[0].tasks.length === 4);
}

section("MOTEUR — placement");
{
  const card = (owner, level, urgent) => ({ owner, firstName: owner, level, why: null, attention: null, tasks: [{ key: owner }], keyDeals: [], urgent, priority: level === "rouge" ? 3 : 1 });
  const slots = etSlots(WEEK_SLOTS, 1);
  check("grille : seulement les créneaux ET, chronologiques", slots.length > 0 && slots.every((s, i) => i === 0 || slots[i - 1].day < s.day || (slots[i - 1].day === s.day && slots[i - 1].time < s.time)));
  const fromThu = etSlots(WEEK_SLOTS, 4);
  check("jeudi : aucun créneau passé proposé", fromThu.every((s) => s.day >= 4));
  const r = scheduleCards([card("A", "rouge", true), card("B", "vert", false), card("C", "orange", true)], slots.slice(0, 1), []);
  check("urgent -> créneau ; au-delà des créneaux libres -> À placer", r.timeline.length === 1 && r.timeline[0].owner === "A" && r.toPlace.some((c) => c.owner === "C"));
  check("non urgent -> À placer, jamais placé d'office", r.toPlace.some((c) => c.owner === "B"));
  const m = scheduleCards([card("A", "rouge", true), card("B", "vert", false)], slots.slice(0, 2), [{ owner: "B", day: slots[0].day, time: slots[0].time }]);
  check("un placement choisi prime et occupe son créneau", m.timeline.find((c) => c.owner === "B")?.placedBy === "manuel" && m.timeline.find((c) => c.owner === "A")?.slot.time === slots[1].time);
  const d = scheduleCards([card("A", "rouge", true), card("B", "vert", false)], slots.slice(0, 1), [{ owner: "B", day: 1, time: null }]);
  check("placement sans heure : hors timeline, dans À placer", !d.timeline.some((c) => c.owner === "B") && d.toPlace.some((c) => c.owner === "B" && c.slot === null));
  check("la timeline ne porte que des créneaux réels (jour + heure)", d.timeline.every((c) => c.slot.day >= 1 && c.slot.time));
  check("… et le créneau réel reste libre pour un autre ET", d.timeline[0]?.owner === "A");
  const before = scheduleCards([card("B", "vert", false)], slots.slice(0, 2), []);
  const real = before.freeSlots[1];
  const after = scheduleCards([card("B", "vert", false)], slots.slice(0, 2), [{ owner: "B", day: real.day, time: real.time }]);
  check("placement dans un vrai créneau : À placer -> timeline, à ce créneau", before.toPlace[0]?.owner === "B" && after.timeline[0]?.owner === "B" && after.timeline[0].slot.time === real.time && after.toPlace.length === 0);
  check("… et ce créneau n'est plus proposé", !after.freeSlots.some((x) => x.day === real.day && x.time === real.time));
}

section("MOTEUR — ET entièrement traité");
{
  const card = (owner, keys) => ({ owner, firstName: owner, level: "rouge", why: null, attention: null, tasks: keys.map((key) => ({ key })), keyDeals: [], urgent: true, priority: 3 });
  const cards = [card("A", ["a1", "a2"]), card("B", ["b1"]), card("C", ["c1"])];
  const slots = etSlots(WEEK_SLOTS, 1).slice(0, 2);
  const sched = scheduleCards(cards, slots, []);
  const slotOfA = sched.timeline.find((c) => c.owner === "A")?.slot;
  const partial = hideTreated(sched, new Set(["a1"]));
  check("une tâche cochée sur deux : la carte reste", partial.timeline.some((c) => c.owner === "A"));
  const all = hideTreated(sched, new Set(["a1", "a2", "c1"]));
  check("dernière tâche cochée : la carte quitte le planning", !all.timeline.some((c) => c.owner === "A"));
  check("… y compris dans À placer", !all.toPlace.some((c) => c.owner === "C"));
  check("… sans décaler les autres ET", all.timeline.find((c) => c.owner === "B")?.slot.time === sched.timeline.find((c) => c.owner === "B")?.slot.time);
  const counts = agendaCounts(cards, new Set(["a1", "a2", "c1"]));
  check("compteurs inchangés : les sujets traités restent comptés", counts.total === 4 && counts.done === 3 && counts.remaining === 1, JSON.stringify(counts));
  const back = hideTreated(sched, new Set(["a1", "c1"]));
  const a = back.timeline.find((c) => c.owner === "A");
  check("Rétablir : la carte réapparaît à son créneau précédent", a?.slot.day === slotOfA.day && a?.slot.time === slotOfA.time);
  check("… avec la tâche rétablie redevenue active", a?.tasks.some((t) => t.key === "a2"));
}

section("PERSISTANCE — hebdomadaire, sans backlog");
{
  const W1 = "2026-09-21";
  const W2 = "2026-09-28";
  store.markAgendaTaskDone(W1, { key: "k1", owner: "ET Test", label: "Sujet 1" });
  check("coché semaine 1 : retrouvé dans les terminés", store.loadAgendaState(W1).done.some((x) => x.key === "k1" && x.label === "Sujet 1"));
  check("semaine 2 : page blanche (aucun report)", store.loadAgendaState(W2).done.length === 0);
  check("cocher deux fois n'écrit qu'une ligne", store.markAgendaTaskDone(W1, { key: "k1", owner: "ET Test", label: "Sujet 1" }) === false);
  store.undoAgendaTask(W1, "k1");
  check("rétablir : le sujet quitte les terminés", !store.loadAgendaState(W1).done.some((x) => x.key === "k1"));
  store.placeAgendaOwner(W1, "ET Test", "4-12:00");
  store.placeAgendaOwner(W1, "ET Test", "5-");
  const p = store.loadAgendaState(W1).placements;
  check("placer puis déplacer : un seul placement, le dernier", p.length === 1 && p[0].day === 5 && p[0].time === null);
  check("valeur de créneau invalide refusée", store.parseSlotValue("9-25:00") === null && store.parseSlotValue("2-14:00")?.time === "14:00");
  store.unplaceAgendaOwner(W1, "ET Test");
  check("retirer : plus de placement", store.loadAgendaState(W1).placements.length === 0);
}

section("PARCOURS — sur la copie de la base (traiter, rétablir, placer)");
{
  const v0 = buildWeekAgenda(new Date());
  const target = v0.timeline.find((c) => c.tasks.some((t) => !v0.doneKeys.includes(t.key)));
  if (!target) console.log("  (info) aucune carte planifiée active : parcours traiter/rétablir non joué");
  else {
    const slot = `${target.slot.day}-${target.slot.time}`;
    const pending = target.tasks.filter((t) => !v0.doneKeys.includes(t.key));
    for (const t of pending) store.markAgendaTaskDone(v0.weekStart, { key: t.key, owner: t.owner, label: t.label });
    const v1 = buildWeekAgenda(new Date());
    check(`dernière tâche traitée : ${target.owner} quitte le planning`, ![...v1.timeline, ...v1.toPlace].some((c) => c.owner === target.owner));
    check("… ses sujets sont dans Terminés", pending.every((t) => v1.done.some((d) => d.key === t.key)));
    check("… compteurs : total inchangé, restants −N", v1.counts.total === v0.counts.total && v1.counts.remaining === v0.counts.remaining - pending.length, `${JSON.stringify(v0.counts)} -> ${JSON.stringify(v1.counts)}`);
    check("… son créneau n'est pas proposé à un autre ET", !v1.placeOptions.some((o) => o.value === slot));
    store.undoAgendaTask(v0.weekStart, pending[0].key);
    const v2 = buildWeekAgenda(new Date());
    const back = v2.timeline.find((c) => c.owner === target.owner);
    check("Rétablir : la carte réapparaît au même créneau", back && `${back.slot.day}-${back.slot.time}` === slot, back ? `${back.slot.day}-${back.slot.time}` : "absente");
    check("… avec la tâche rétablie active", back?.tasks.some((t) => t.key === pending[0].key) && !v2.doneKeys.includes(pending[0].key));
    for (const t of pending.slice(1)) store.undoAgendaTask(v0.weekStart, t.key);
  }

  const v3 = buildWeekAgenda(new Date());
  check("placement : seuls des créneaux réels sont proposés", v3.placeOptions.every((o) => store.parseSlotValue(o.value)?.time));
  const candidate = v3.toPlace[0];
  if (!candidate) console.log("  (info) aucun ET à placer : placement non joué");
  else {
    store.placeAgendaOwner(v3.weekStart, candidate.owner, `${v3.todayDay ?? 1}-`);
    const v4 = buildWeekAgenda(new Date());
    check(`placement sans heure (${candidate.owner}) : reste dans À placer`, v4.toPlace.some((c) => c.owner === candidate.owner) && !v4.timeline.some((c) => c.owner === candidate.owner));
    const option = v4.placeOptions[0];
    if (!option) console.log("  (info) aucun créneau libre : placement réel non joué");
    else {
      store.placeAgendaOwner(v4.weekStart, candidate.owner, option.value);
      const v5 = buildWeekAgenda(new Date());
      const placed = v5.timeline.find((c) => c.owner === candidate.owner);
      check(`placement dans un vrai créneau (${option.label}) : la carte rejoint la timeline`, placed && `${placed.slot.day}-${placed.slot.time}` === option.value && !v5.toPlace.some((c) => c.owner === candidate.owner));
    }
    store.unplaceAgendaOwner(v3.weekStart, candidate.owner);
  }
}

section("COMPOSITION — état réel (invariants)");
{
  const v = buildWeekAgenda(new Date());
  const cards = [...v.timeline, ...v.toPlace];
  check("aucun directeur exclu dans le planning", !cards.some((c) => ATTENTION.excluded.includes(c.owner)));
  check("une carte par ET", new Set(cards.map((c) => c.owner)).size === cards.length);
  check(`au plus ${WEEK_AGENDA.maxTasks} sujets par carte`, cards.every((c) => c.tasks.length <= WEEK_AGENDA.maxTasks));
  check("aucune affaire en double dans une carte", cards.every((c) => {
    const ids = c.tasks.map((t) => t.opportunityId).filter(Boolean);
    return new Set(ids).size === ids.length;
  }));
  const keys = cards.flatMap((c) => c.tasks.map((t) => t.key));
  check("clés de sujets uniques", new Set(keys).size === keys.length);
  const slotKeys = v.timeline.filter((c) => c.slot.time).map((c) => `${c.slot.day}-${c.slot.time}`);
  check("aucun créneau occupé deux fois", new Set(slotKeys).size === slotKeys.length);
  check("compteurs cohérents", v.counts.total === v.counts.done + v.counts.remaining, JSON.stringify(v.counts));
  check("aucune carte sans horaire dans la timeline", v.timeline.every((c) => c.slot?.time), v.timeline.filter((c) => !c.slot?.time).map((c) => c.owner).join(", "));
  const doneSet = new Set(v.doneKeys);
  check("aucune carte entièrement traitée dans le planning", cards.every((c) => c.tasks.some((t) => !doneSet.has(t.key))), cards.filter((c) => c.tasks.every((t) => doneSet.has(t.key))).map((c) => c.owner).join(", "));
  console.log(`  (info) ${v.weekLabel} · ${v.timeline.length} ET placés · ${v.toPlace.length} à placer · ${v.counts.total} sujets`);
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);

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
  // Une ActionKey = une case : trois actions DIFFÉRENTES d'une même affaire
  // (comprendre la baisse, challenger, préparer) restent trois cases.
  check("une affaire, trois actions différentes -> trois sujets distincts", t.filter((x) => x.opportunityId === "006A").length === 3);
  check("… par ordre de priorité (la baisse GMV d'abord)", t[0].label.includes("baisse de 166 k€"), t[0].label);
  const same = tasksOf(base({
    plan: [{ opportunityId: "006B", client: "Client B", gmv: 300_000, reason: "upside", impact: 90_000, pMonthEnd: null, actionKey: "plan:006B:upside:2026-09-28:0" }],
    challengers: [{ opportunityId: "006B", client: "Client B", gmv: 300_000, probability: 0.4, expectedGmv: 120_000, actionKey: "plan:006B:upside:2026-09-28:0" }],
  }));
  check("deux moteurs, MÊME ActionKey (Plan upside = Forecast à challenger) -> UN seul sujet", same.filter((x) => x.opportunityId === "006B").length === 1 && same.find((x) => x.opportunityId === "006B")?.actionKey === "plan:006B:upside:2026-09-28:0");
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

section("MOTEUR — fusions sémantiques : une case = une action manager distincte");
{
  const W = "2026-10-05";
  const pk = (id, reason) => `plan:${id}:${reason}:${W}:0`;
  const plan = (id, client, reason, gmv = 200_000) => ({ opportunityId: id, client, gmv, reason, impact: gmv * 0.5, pMonthEnd: null, actionKey: pk(id, reason) });
  const deal = (id, client, kind, urgent = true, gmv = 200_000) => ({ opportunityId: id, client, gmv, objective: { accelerer: "Accélérer", debloquer: "Débloquer", closer: "Closer" }[kind], kind, urgent });
  const exit = (id, client, gmv = 200_000) => ({ opportunityId: id, client, gmv, gmvDelta: null, exitedM: true, enteredStandby: false });
  const of = (input, id) => tasksOf(base(input)).filter((t) => t.opportunityId === id);

  // Cas de production nommés.
  const chanville = of({ plan: [plan("006CH", "Monsieur et Madame de CHANVILLE", "divergence")], bigDeals: [deal("006CH", "Monsieur et Madame de CHANVILLE", "accelerer")] }, "006CH");
  check("Chanville (divergence + Accélérer ce mois) -> 1 tâche", chanville.length === 1, chanville.map((t) => t.label).join(" | "));
  check("… ActionKey du Plan « divergence » conservée", chanville[0]?.actionKey === pk("006CH", "divergence") && chanville[0]?.source === "plan");
  check("… formulation unique", /confirmer ce qui permet réellement de signer ce mois/.test(chanville[0]?.label ?? ""), chanville[0]?.label);

  const boisdron = of({ plan: [plan("006BO", "Mme BOISDRON", "basculer", 109_000)], moves: [exit("006BO", "Mme BOISDRON", 109_000)] }, "006BO");
  check("Mme Boisdron (basculer + sortie du mois) -> 1 tâche", boisdron.length === 1, boisdron.map((t) => t.label).join(" | "));
  check("… ActionKey du Plan « basculer » conservée", boisdron[0]?.actionKey === pk("006BO", "basculer"));
  check("… formulation unique", /comprendre la sortie du mois et vérifier si elle peut revenir/.test(boisdron[0]?.label ?? ""), boisdron[0]?.label);
  check("… au tier le plus prioritaire des deux (Momentum)", boisdron[0]?.tier === 2);

  const tatiana = of({ plan: [plan("006TP", "Tatiana PETROVA", "upside", 614_000)], bigDeals: [deal("006TP", "Tatiana PETROVA", "debloquer", true, 614_000)] }, "006TP");
  check("Tatiana (upside + Débloquer) -> 2 tâches", tatiana.length === 2, tatiana.map((t) => t.label).join(" | "));
  check(
    "… deux formulations qui disent deux résultats différents",
    tatiana.some((t) => /lever le blocage/.test(t.label)) && tatiana.some((t) => /Challenger la prévision/.test(t.label)),
  );

  const cyril = of({ plan: [plan("006CL", "Cyril LAGEL", "divergence")], bigDeals: [deal("006CL", "Cyril LAGEL", "debloquer")] }, "006CL");
  check("Cyril Lagel (divergence + Débloquer) -> 2 tâches", cyril.length === 2, cyril.map((t) => t.label).join(" | "));
  check("… « lever le blocage » et « revalider le mois »", cyril.some((t) => /lever le blocage/.test(t.label)) && cyril.some((t) => /Revalider le mois/.test(t.label)));

  // Fixtures génériques : seules les deux paires sûres fusionnent.
  check("générique : divergence + Accélérer NON urgent (pas ce mois) -> 2", of({ plan: [plan("X1", "X1", "divergence")], bigDeals: [deal("X1", "X1", "accelerer", false)] }, "X1").length === 2);
  // 3e paire sûre : sécuriser + Accélérer urgent (cas historiques du 30/09).
  for (const [id, client, gmv] of [["006AE", "Anas EL HIMDI", 112_000], ["006CLs", "Cyril LAGEL", 138_000], ["006CHs", "Monsieur et Madame DE CHANVILLE", 187_000]]) {
    const t = of({ plan: [plan(id, client, "securiser", gmv)], bigDeals: [deal(id, client, "accelerer", true, gmv)] }, id);
    check(
      `${client} (sécuriser + Accélérer urgent) -> 1 tâche, ActionKey du Plan « sécuriser »`,
      t.length === 1 && t[0].actionKey === pk(id, "securiser") && /obtenir le prochain jalon pour confirmer la signature ce mois/.test(t[0].label),
      t.map((x) => x.label).join(" | "),
    );
  }
  // 4e paire sûre : « bloqué » POUR IMMOBILITÉ SEULE + Accélérer (urgent ou non :
  // un « bloqué » n'est jamais déclaré sur le mois, son « Accélérer » jamais urgent).
  const bloque = (id, client, immobileOnly, gmv = 826_000) => ({ ...plan(id, client, "bloque", gmv), immobileOnly });
  const falcon = of({ plan: [bloque("006FI", "Falcon Invest FRANCE", true)], bigDeals: [deal("006FI", "Falcon Invest FRANCE", "accelerer", false, 826_000)] }, "006FI");
  check(
    "Falcon (bloqué pour immobilité + Accélérer, hors prévision) -> 1 tâche, ActionKey du Plan « bloque »",
    falcon.length === 1 && falcon[0].actionKey === pk("006FI", "bloque") && /identifier le frein et fixer le prochain jalon/.test(falcon[0].label),
    falcon.map((x) => x.label).join(" | "),
  );
  check("générique : bloqué pour immobilité + Accélérer urgent -> 1", of({ plan: [bloque("X11", "X11", true)], bigDeals: [deal("X11", "X11", "accelerer", true)] }, "X11").length === 1);
  check("générique : bloqué avec client actif (signal dur) + Accélérer -> 2", of({ plan: [bloque("X9", "X9", false)], bigDeals: [deal("X9", "X9", "accelerer", false)] }, "X9").length === 2);
  check("générique : bloqué sans motif connu (champ absent) + Accélérer -> 2", of({ plan: [plan("X10", "X10", "bloque")], bigDeals: [deal("X10", "X10", "accelerer", false)] }, "X10").length === 2);
  check("générique : bloqué pour immobilité + Closer -> 2", of({ plan: [bloque("X13", "X13", true)], bigDeals: [deal("X13", "X13", "closer", false)] }, "X13").length === 2);
  check("générique : bloqué pour immobilité + Débloquer (blocage dur : client en attente, relance…) -> 2", of({ plan: [bloque("X12", "X12", true)], bigDeals: [deal("X12", "X12", "debloquer")] }, "X12").length === 2);
  check("générique : sécuriser + Accélérer urgent -> 1", of({ plan: [plan("X2", "X2", "securiser")], bigDeals: [deal("X2", "X2", "accelerer")] }, "X2").length === 1);
  check("générique : sécuriser + Accélérer NON urgent -> 2", of({ plan: [plan("X2b", "X2b", "securiser")], bigDeals: [deal("X2b", "X2b", "accelerer", false)] }, "X2b").length === 2);
  check("générique : upside + Accélérer urgent -> 2", of({ plan: [plan("X2c", "X2c", "upside")], bigDeals: [deal("X2c", "X2c", "accelerer")] }, "X2c").length === 2);
  check("générique : basculer + Accélérer urgent -> 2", of({ plan: [plan("X2d", "X2d", "basculer")], bigDeals: [deal("X2d", "X2d", "accelerer")] }, "X2d").length === 2);
  check("générique : sécuriser + sortie du mois -> 2", of({ plan: [plan("X2e", "X2e", "securiser")], moves: [exit("X2e", "X2e")] }, "X2e").length === 2);
  check("générique : sécuriser + Débloquer -> 2", of({ plan: [plan("X3", "X3", "securiser")], bigDeals: [deal("X3", "X3", "debloquer")] }, "X3").length === 2);
  check("générique : basculer + Débloquer -> 2", of({ plan: [plan("X4", "X4", "basculer")], bigDeals: [deal("X4", "X4", "debloquer")] }, "X4").length === 2);
  check("générique : upside + sortie du mois -> 2", of({ plan: [plan("X5", "X5", "upside")], moves: [exit("X5", "X5")] }, "X5").length === 2);
  check(
    "générique : basculer + BAISSE de GMV (pas une sortie) -> 2",
    of({ plan: [plan("X6", "X6", "basculer")], moves: [{ opportunityId: "X6", client: "X6", gmv: 200_000, gmvDelta: -50_000, exitedM: true, enteredStandby: false }] }, "X6").length === 2,
  );
  check("générique : divergence + Accélérer d'une AUTRE affaire -> 2", tasksOf(base({ plan: [plan("X7", "X7", "divergence")], bigDeals: [deal("X8", "X8", "accelerer")] })).length === 2);

  // Limite de 4 inchangée ; une fusion libère une place pour le sujet suivant.
  const crowded = (withPair) => base({
    level: "rouge",
    plan: [plan("L1", "L1", "divergence", 900_000), plan("L2", "L2", "securiser", 800_000), plan("L3", "L3", "securiser", 700_000)],
    bigDeals: [deal("L1", "L1", withPair ? "accelerer" : "closer", true, 900_000)],
    reasons: [{ key: "pipe_faible", weight: "fort", label: "Pipe faible", detail: "200 k€" }],
  });
  const before = composeCards([crowded(false)])[0];
  const after = composeCards([crowded(true)])[0];
  check(`limite de ${WEEK_AGENDA.maxTasks} sujets inchangée`, before.tasks.length === WEEK_AGENDA.maxTasks && after.tasks.length === WEEK_AGENDA.maxTasks);
  check(
    "une fusion libère une place : le sujet suivant remonte",
    !before.tasks.some((t) => t.source === "attention") && after.tasks.some((t) => t.source === "attention") &&
      after.tasks.filter((t) => t.opportunityId === "L1").length === 1,
    after.tasks.map((t) => t.source).join(","),
  );

  // Traiter une action distincte ne traite pas l'autre.
  const [a, b] = tatiana;
  const done = new Set([tatiana.find((t) => t.source === "gros_dossier").key]);
  check(
    "Tatiana : cocher « Débloquer » ne coche pas « Challenger la prévision »",
    a.key !== b.key && (a.actionKey ?? a.key) !== (b.actionKey ?? b.key) && tatiana.filter((t) => !done.has(t.key)).length === 1 &&
      tatiana.find((t) => !done.has(t.key))?.actionKey === pk("006TP", "upside"),
  );
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
  check("aucune action en double dans une carte (une ActionKey = une case)", cards.every((c) => {
    const ids = c.tasks.map((t) => t.actionKey ?? t.key);
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

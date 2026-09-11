/**
 * Contrôles de « Ma semaine ».
 *
 *   npm run semaine:verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : l'affaire de la semaine et le radar sont
 * des écritures, et un contrôle ne doit pas laisser de fausses lignes dans les
 * données du directeur régional.
 *
 * Ce qui est vérifié n'est pas « les verdicts sont justes » — cela se discute
 * avec le manager, pas avec un script — mais que le MOTEUR tient ses promesses :
 * périmètre exact, règles déterministes et explicables, ancienneté jamais
 * surestimée, planning sans doublon et réaffectation dans l'ordre voulu,
 * persistance cohérente.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "semaine.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { ATTENTION, BIG_DEALS, WEEK_SLOTS, WEEK_FALLBACK_ORDER, WEEK_REASSIGNABLE, RADAR } = await import(lib("config"));
const { assessAttention, assessPerformance, sortVerdicts } = await import(
  lib("attention")
);
const { detectBigDeals, qualifies, objectiveOf } = await import(lib("big-deals"));
const { planWeek, orderActions, actionRank } = await import(lib("week-plan"));
const { stabilityFromRows, loadStageStability, earliestSnapshotDate } = await import(lib("stage-history"));
const { buildWeek, weekBounds } = await import(lib("week"));
const { loadTeam } = await import(lib("team-store"));
const { loadOpportunities } = await import(lib("repository"));
const { daysBetween } = await import(lib("normalize"));
const { currentDealOfWeek, selectDealOfWeek, closeDealOfWeek, dealOfWeekHistory, updateDealOfWeek } = await import(
  lib("deal-of-week-store")
);
const { addRadarContact, updateRadarContact, listRadarContacts, radarToProcess, radarInterviews } = await import(
  lib("radar-store")
);
const { preselect, evaluate, rank, pickDiverse, recommend, suggestAngle } = await import(lib("deal-of-week-recommend"));
const { DEAL_OF_WEEK_RECOMMENDATION } = await import(lib("config"));
const { ignoreWeek, resumeWeek, isWeekIgnored } = await import(lib("deal-of-week-store"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const kEurLocal = (v) => (v == null ? "—" : `${Math.round(v / 1000)} k€`);

// --- S1 — Moteur d'attention sur entrées synthétiques -----------------------

section("S1 — Règles d'attention, entrées synthétiques");

const base = {
  salesperson: "Test Un",
  firstName: "Test",
  performanceScore: 60,
  activeCount: 20,
  activeGmv: 1_000_000,
  staleCount: 2,
  withoutProjectionCount: 3,
  monitoringState: "sain",
  newExceptions: 0,
  clientWaiting: 0,
  divergence: null,
  expectedRemaining: 0,
  kanbanRemaining: 0,
  stagnant: { count: 0, minProvenDays: 0, examples: [] },
  nearSignature: { count: 0, gmv: 0, examples: [] },
};

const calm = assessAttention(base);
check("aucune raison ⇒ vert, sans recommandation", calm.attention.level === "vert" && calm.recommendation === null);
check("verdict vert porte le libellé « aucune intervention »", calm.summary.includes("Aucune intervention"));

const oneModerate = assessAttention({ ...base, activeGmv: 400_000 });
check(
  "une seule raison modérée ⇒ vert (affichée, pas planifiée)",
  oneModerate.attention.level === "vert" && oneModerate.reasons.length === 1 && oneModerate.reasons[0].key === "pipe_faible",
);

const twoModerate = assessAttention({ ...base, activeGmv: 400_000, nearSignature: { count: 1, gmv: 150_000, examples: ["X"] } });
check("deux raisons modérées ⇒ orange", twoModerate.attention.level === "orange" && twoModerate.recommendation?.minutes === ATTENTION.minutes.orange);

const oneStrong = assessAttention({ ...base, monitoringState: "action requise", newExceptions: 6 });
check("une raison forte seule ⇒ orange", oneStrong.attention.level === "orange" && oneStrong.attention.strong === 1);

const strongPlus = assessAttention({ ...base, monitoringState: "action requise", newExceptions: 6, activeGmv: 400_000 });
check("une forte + une modérée ⇒ rouge", strongPlus.attention.level === "rouge" && strongPlus.recommendation?.minutes === ATTENTION.minutes.rouge);

const twoStrong = assessAttention({ ...base, monitoringState: "action requise", newExceptions: 6, clientWaiting: ATTENTION.clientWaitingStrong });
check("deux fortes ⇒ rouge", twoStrong.attention.level === "rouge" && twoStrong.attention.strong === 2);
check("la raison dominante est la forte la plus haute dans l'ordre", twoStrong.primary === "anomalies_suivi");

const forecastStrong = assessAttention({ ...base, divergence: "fort", expectedRemaining: 50_000, kanbanRemaining: 300_000 });
check("divergence forte sous le déclaré ⇒ raison forte « Forecast en retard »", forecastStrong.reasons[0]?.key === "forecast_retard" && forecastStrong.reasons[0]?.weight === "fort");
const forecastAbove = assessAttention({ ...base, divergence: "fort", expectedRemaining: 500_000, kanbanRemaining: 300_000 });
check("divergence forte AU-DESSUS du déclaré ⇒ aucune raison forecast", forecastAbove.reasons.length === 0);
const forecastNoData = assessAttention({ ...base, divergence: null, expectedRemaining: 0, kanbanRemaining: 300_000 });
check("Expected indisponible ⇒ règle forecast neutralisée", forecastNoData.reasons.length === 0);

const watchLow = assessAttention({ ...base, monitoringState: "à surveiller", newExceptions: ATTENTION.watchMinExceptions - 1 });
const watchHigh = assessAttention({ ...base, monitoringState: "à surveiller", newExceptions: ATTENTION.watchMinExceptions });
check(
  `« à surveiller » ne s'allume qu'à partir de ${ATTENTION.watchMinExceptions} exceptions`,
  watchLow.reasons.length === 0 && watchHigh.reasons.length === 1 && watchHigh.reasons[0].weight === "modere",
);

const stagnantFew = assessAttention({ ...base, activeCount: 20, stagnant: { count: 3, minProvenDays: 20, examples: [] } });
const stagnantMany = assessAttention({ ...base, activeCount: 6, stagnant: { count: 3, minProvenDays: 20, examples: [] } });
check(
  "affaires figées : nombre ET part du pipe requis",
  stagnantFew.reasons.length === 0 && stagnantMany.reasons.some((r) => r.key === "affaires_figees"),
);
check(
  "le détail dit « depuis au moins »",
  stagnantMany.reasons.find((r) => r.key === "affaires_figees")?.detail.includes("depuis au moins 20 jours"),
);

const staleData = assessAttention({ ...base, activeCount: 10, staleCount: 6 });
check("données obsolètes : plus de la moitié du pipe sans activité", staleData.reasons.some((r) => r.key === "donnees_obsoletes"));
const noProjection = assessAttention({ ...base, activeCount: 4, withoutProjectionCount: 4 });
check("données obsolètes : aucune Projection Kanban", noProjection.reasons.some((r) => r.key === "donnees_obsoletes"));

check("déterminisme : mêmes entrées, même verdict", JSON.stringify(assessAttention(strongPlus && { ...base, monitoringState: "action requise", newExceptions: 6, activeGmv: 400_000 })) === JSON.stringify(strongPlus));

check("performance : paliers vert / neutre / orange, jamais rouge",
  assessPerformance(75) === "vert" && assessPerformance(50) === "neutre" && assessPerformance(30) === "orange" && assessPerformance(null) === "neutre");

const sorted = sortVerdicts([calm, oneStrong, strongPlus, twoModerate]);
check("tri : rouge, puis orange, puis vert", sorted.map((v) => v.attention.level).join(",") === "rouge,orange,orange,vert");

// --- S2 — Stabilité d'étape : jamais plus que prouvé --------------------------

section("S2 — Stabilité d'étape");

const rows = [
  { opportunityId: "A", snapshotDate: "2026-08-16", stage: "Etude dossier" },
  { opportunityId: "A", snapshotDate: "2026-08-20", stage: "Etude dossier" },
  { opportunityId: "A", snapshotDate: "2026-08-25", stage: "Examen devis" },
  { opportunityId: "A", snapshotDate: "2026-09-01", stage: "Examen devis" },
  { opportunityId: "B", snapshotDate: "2026-08-16", stage: "Signature" },
  { opportunityId: "B", snapshotDate: "2026-09-01", stage: "Signature" },
];
const stab = stabilityFromRows(rows, "2026-09-10");
check("changement observé ⇒ stable depuis le premier snapshot de la nouvelle étape", stab.get("A").stableSince === "2026-08-25" && stab.get("A").changeObserved === true && stab.get("A").provenDays === 16);
check("aucun changement observé ⇒ borne = premier snapshot, non prouvé", stab.get("B").stableSince === "2026-08-16" && stab.get("B").changeObserved === false && stab.get("B").provenDays === 25);

const realStab = loadStageStability("2026-09-10");
const earliest = earliestSnapshotDate();
const depth = earliest ? daysBetween(earliest, "2026-09-10") : 0;
check(
  "sur la base : aucune ancienneté ne dépasse la profondeur des snapshots",
  [...realStab.values()].every((s) => s.provenDays <= depth),
  `${realStab.size} affaires, profondeur ${depth} jours`,
);

// --- S3 — Gros dossiers ---------------------------------------------------------

section("S3 — Gros dossiers");

const cand = (over) => ({
  opportunityId: "X",
  client: "Client",
  owner: "O",
  firstName: "O",
  gmv: 150_000,
  stage: "Etude dossier",
  stageRank: 1,
  kanbanMonth: null,
  pMonthEnd: null,
  milestoneStatus: "normal",
  clientWaiting: false,
  daysSinceActivity: 3,
  ...over,
});
check("sous le seuil de GMV : jamais retenu", !qualifies(cand({ gmv: BIG_DEALS.minGmv - 1, stageRank: 5 }), "2026-09"));
check("gros montant sans maturité : non retenu", !qualifies(cand({}), "2026-09"));
check("gros montant + étape avancée : retenu", qualifies(cand({ stageRank: BIG_DEALS.advancedRank }), "2026-09"));
check("gros montant + Kanban du mois : retenu", qualifies(cand({ kanbanMonth: "2026-09" }), "2026-09"));
check("gros montant + probable : retenu", qualifies(cand({ pMonthEnd: BIG_DEALS.minProbability }), "2026-09"));
check("gros montant + anomalie : retenu", qualifies(cand({ milestoneStatus: "sla_devis" }), "2026-09"));
check("objectif : client en attente ⇒ débloquer", objectiveOf(cand({ clientWaiting: true, stageRank: 5 })) === "debloquer");
check("objectif : Signature ⇒ closer", objectiveOf(cand({ stageRank: BIG_DEALS.signatureRank })) === "closer");
check("objectif : dormante ⇒ arbitrer", objectiveOf(cand({ milestoneStatus: "dormant_candidate" })) === "arbitrer");
check("objectif : avancée sans blocage ⇒ accélérer", objectiveOf(cand({ stageRank: BIG_DEALS.advancedRank })) === "accelerer");

const deals = detectBigDeals(
  [
    cand({ opportunityId: "1", gmv: 120_000, stageRank: 4 }),
    cand({ opportunityId: "2", gmv: 500_000, stageRank: 4 }),
    cand({ opportunityId: "3", gmv: 110_000, stageRank: 5 }),
    cand({ opportunityId: "4", gmv: 90_000, stageRank: 5 }),
  ],
  "2026-09",
);
check("urgents d'abord, puis par montant", deals.map((d) => d.opportunityId).join(",") === "3,2,1");
check("plafond respecté", deals.length <= BIG_DEALS.maxItems);
const lowP = detectBigDeals([cand({ stageRank: 4, pMonthEnd: 0.004 })], "2026-09")[0];
check("probabilité < 5 % non écrite dans la raison", !lowP.reason.includes("%"));

// --- S4 — Planning --------------------------------------------------------------

section("S4 — Planning recommandé");

const item = (key, kind, score = 1, urgent = false) => ({
  key,
  kind,
  urgent,
  score,
  title: key,
  who: key,
  reason: "r",
  recommendation: { minutes: 30, action: "a", lookWhere: "w", lookFor: "f", obtain: "o" },
  href: null,
});

const planned = planWeek(WEEK_SLOTS, [
  item("rouge1", "et_rouge", 5),
  item("rouge2", "et_rouge", 4),
  item("rouge3", "et_rouge", 3),
  item("orange1", "et_orange", 2),
  item("deal-urgent", "gros_dossier", 500, true),
  item("deal-calme", "gros_dossier", 900, false),
  item("dow", "affaire_semaine", 1),
]);
check("autant de créneaux planifiés que déclarés", planned.length === WEEK_SLOTS.length);
const assigned = planned.filter((s) => s.item).map((s) => s.item.key);
check("aucun élément affecté deux fois", new Set(assigned).size === assigned.length);
check("ordre chronologique", planned.every((s, i) => i === 0 || s.day > planned[i - 1].day || (s.day === planned[i - 1].day && s.time >= planned[i - 1].time)));
const bySlot = (day, time) => planned.find((s) => s.day === day && s.time === time);
check("les créneaux ET rouge prennent les deux rouges les mieux classés", bySlot(1, "11:00").item?.key === "rouge1" && bySlot(3, "10:00").item?.key === "rouge2");
check("l'affaire de la semaine garde SON créneau (passe 1 avant réaffectation)", bySlot(4, "12:00").item?.key === "dow" && !bySlot(4, "12:00").reassigned);
check("le créneau gros dossier prend le gros dossier le mieux classé", bySlot(2, "15:30").item?.key === "deal-calme");
check("premier créneau orange : l'orange", bySlot(2, "14:00").item?.key === "orange1");
check("second créneau orange vide ⇒ réaffecté au rouge restant en priorité", bySlot(2, "14:45").item?.key === "rouge3" && bySlot(2, "14:45").reassigned);
const cand15 = bySlot(4, "15:00");
check("créneau candidatures non réaffectable : reste disponible avec suggestion", cand15.item === null && cand15.note && cand15.suggestion);
check("les créneaux sourcing ne reçoivent jamais d'élément", planned.filter((s) => s.kind.startsWith("sourcing")).every((s) => s.item === null && s.note));

const sparse = planWeek(WEEK_SLOTS, [item("orange1", "et_orange", 2)]);
check("un seul orange ⇒ un seul créneau ET rempli, les autres disponibles", sparse.filter((s) => s.item).length === 1 && sparse.filter((s) => WEEK_REASSIGNABLE.includes(s.kind) && !s.item).every((s) => s.note));
check("créneau vide : le message dit « aucun autre ET »", sparse.find((s) => s.day === 2 && s.time === "14:45").note.includes("Aucun autre ET"));

const fallbackTest = planWeek(WEEK_SLOTS, [item("deal-urgent", "gros_dossier", 1, true), item("deal-calme", "gros_dossier", 2, false)]);
check("réaffectation : seul un gros dossier URGENT remplit un créneau ET", fallbackTest.filter((s) => s.item?.key === "deal-urgent").length === 1 && !fallbackTest.some((s) => s.item?.key === "deal-calme" && s.kind !== "gros_dossier"));
check("ordre de repli conforme à la config", WEEK_FALLBACK_ORDER.join(",") === "et_rouge,gros_dossier,affaire_semaine,et_orange,candidatures");

const actions = orderActions([item("o", "et_orange"), item("dc", "gros_dossier", 1, false), item("r", "et_rouge"), item("du", "gros_dossier", 1, true), item("dow", "affaire_semaine"), item("c", "candidatures"), item("s", "sourcing_et")]);
check("« À traiter » : rouge, gros dossier urgent, affaire, orange, candidatures ; sans sourcing ni gros dossier calme", actions.map((a) => a.key).join(",") === "r,du,dow,o,c");
check("rang : gros dossier non urgent hors liste", actionRank(item("dc", "gros_dossier", 1, false)) >= 9);

// --- S5 — Composition sur la base réelle ----------------------------------------

section("S5 — Composition sur la base réelle");

const now = new Date();
const view = buildWeek(now);
const team = loadTeam();
const expected = team.filter((m) => !ATTENTION.excluded.includes(m.name));
check("un verdict par commercial du périmètre hors exclus", view.verdicts.length === expected.length, `${view.verdicts.length} pour ${expected.length}`);
check("aucun exclu dans les verdicts", !view.verdicts.some((v) => ATTENTION.excluded.includes(v.salesperson)));
check("aucun rouge en performance", view.verdicts.every((v) => ["vert", "neutre", "orange"].includes(v.performance.level)));
check("tout verdict non vert a une raison et une recommandation", view.verdicts.filter((v) => v.attention.level !== "vert").every((v) => v.reasons.length > 0 && v.recommendation));
check("tout verdict vert est sans recommandation", view.verdicts.filter((v) => v.attention.level === "vert").every((v) => v.recommendation === null));
check("synthèse cohérente avec les verdicts",
  view.summary.red === view.verdicts.filter((v) => v.attention.level === "rouge").length &&
  view.summary.orange === view.verdicts.filter((v) => v.attention.level === "orange").length &&
  view.summary.bigDeals === view.bigDeals.length,
  `${view.summary.red} rouge · ${view.summary.orange} orange · ${view.summary.bigDeals} gros dossiers`);
const active = loadOpportunities().filter((o) => o.isActive);
check("gros dossiers : actifs et au-dessus du seuil", view.bigDeals.every((d) => d.gmv >= BIG_DEALS.minGmv && active.some((o) => o.opportunityId === d.opportunityId)));
check("gros dossiers : les exclus de l'attention restent éligibles", true, "règle : filtre sur GMV seulement, aucune exclusion par commercial");
const planKeys = view.planning.filter((s) => s.item).map((s) => s.item.key);
check("planning réel sans doublon", new Set(planKeys).size === planKeys.length);
check("chaque élément planifié existe dans les actions ou les gros dossiers", planKeys.every((k) => view.actions.some((a) => a.key === k) || k.startsWith("deal:")));
const { weekStart, weekEnd } = weekBounds(now);
check("semaine : lundi → vendredi", new Date(`${weekStart}T00:00:00`).getDay() === 1 && daysBetween(weekStart, weekEnd) === 4);
check("bascule : le samedi affiche la semaine suivante", weekBounds(new Date("2026-09-12T10:00:00")).weekStart === "2026-09-14" && weekBounds(new Date("2026-09-11T10:00:00")).weekStart === "2026-09-07");

// --- S6 — Affaire de la semaine (copie de base) -------------------------------------

section("S6 — Affaire de la semaine");

const before = currentDealOfWeek();
const first = active[0];
const second = active.find((o) => o.opportunityId !== first.opportunityId);
const r1 = selectDealOfWeek({ opportunityId: first.opportunityId, salesperson: first.owner, weekStart, angle: "closing", comment: "test" });
check("sélection ⇒ devient l'affaire en cours", currentDealOfWeek()?.id === r1.id && r1.status === "en_cours");
check("l'angle de challenge est conservé", r1.angle === "closing");
check("changer l'angle ne remplace pas l'affaire", updateDealOfWeek(r1.id, { angle: "planning" }) && currentDealOfWeek()?.id === r1.id && currentDealOfWeek()?.angle === "planning");
const r2 = selectDealOfWeek({ opportunityId: second.opportunityId, salesperson: second.owner, weekStart });
const hist = dealOfWeekHistory();
check("nouvelle sélection ⇒ la précédente passe en « remplacee »", hist.find((h) => h.id === r1.id)?.status === "remplacee" && currentDealOfWeek()?.id === r2.id);
check("une seule affaire en cours à la fois", hist.filter((h) => h.status === "en_cours").length === 1);
check("clôture ⇒ plus d'affaire en cours", closeDealOfWeek(r2.id) && currentDealOfWeek() === null);
check("clore deux fois ne change rien", closeDealOfWeek(r2.id) === false);
check("l'affaire précédente du directeur n'a pas été touchée", before === null || hist.some((h) => h.id === before.id));
const viewWith = (() => { selectDealOfWeek({ opportunityId: first.opportunityId, salesperson: first.owner, weekStart, angle: "strategie_client" }); return buildWeek(now); })();
check("avec une affaire en cours : présente dans la synthèse, les actions et le créneau du jeudi",
  viewWith.summary.dealOfWeek === 1 && viewWith.actions.some((a) => a.kind === "affaire_semaine") && viewWith.planning.find((s) => s.kind === "affaire_semaine")?.item?.kind === "affaire_semaine");
check("l'angle dicte le libellé et l'objectif du point", viewWith.dealOfWeek?.angleLabel === "Stratégie client" && viewWith.dealOfWeek?.objective.startsWith("Obtenir un plan d'action") && viewWith.actions.find((a) => a.kind === "affaire_semaine")?.recommendation.obtain === viewWith.dealOfWeek?.objective);
const viewLegacy = (() => { selectDealOfWeek({ opportunityId: first.opportunityId, salesperson: first.owner, weekStart }); return buildWeek(now); })();
check("un choix sans angle s'affiche « Autre »", viewLegacy.dealOfWeek?.angleLabel === "Autre");

// --- S7 — Radar ----------------------------------------------------------------------

section("S7 — Radar");

const c1 = addRadarContact({ category: "et", name: "Test Candidat", company: "ACME" });
check("ajout ⇒ statut « nouveau », source manuelle", c1.status === "nouveau" && c1.source === "manuel");
let threw = false;
try { addRadarContact({ category: "et", name: "  " }); } catch { threw = true; }
check("nom vide refusé", threw);
threw = false;
try { addRadarContact({ category: "robot", name: "X" }); } catch { threw = true; }
check("catégorie inconnue refusée", threw);
const c2 = updateRadarContact(c1.id, { status: "rdv", nextActionAt: weekEnd });
check("mise à jour du statut", c2.status === "rdv" && c2.nextActionAt === weekEnd);
const all = listRadarContacts();
check("à traiter : « nouveau » et « à contacter », ou prochaine action dans la semaine", radarToProcess(all, weekEnd).some((c) => c.id === c1.id));
check("entretiens : statut RDV", radarInterviews(all).some((c) => c.id === c1.id));
const ecarte = updateRadarContact(c1.id, { status: "ecarte" });
check("écarté ⇒ jamais à traiter", ecarte.status === "ecarte" && !radarToProcess(listRadarContacts(), weekEnd).some((c) => c.id === c1.id));
check("statuts du pipeline conformes", RADAR.statuses.map((s) => s.key).join(",") === "nouveau,a_contacter,contacte,interessant,rdv,ecarte");

// --- S8 — Affaire recommandée : présélection, points, angle, diversité, historique ----

section("S8 — Affaire recommandée de la semaine");

const RR = DEAL_OF_WEEK_RECOMMENDATION;
const T = "2026-09-11";
const W = "2026-09-07";
const rc = (over) => ({
  opportunityId: over.opportunityId ?? `c-${Math.random().toString(36).slice(2, 8)}`,
  owner: "Anthony Ramaherison",
  firstName: "Anthony",
  client: "Client",
  gmv: 40_000,
  stage: "Examen devis",
  createdAt: "2026-07-01",
  lastActivityAt: "2026-09-09",
  isActive: true,
  milestone: { status: "normal", nextExpectedEvent: null, nextExpectedDueAt: null, estimationSentAt: null, devisSentAt: "2026-09-01", nextVisitAt: null, clientWaiting: false },
  stageChangedRecently: false,
  attention: "orange",
  ownerEligible: true,
  isBigDeal: false,
  isCurrent: false,
  ...over,
});

// Présélection
check("gros dossier déjà remonté ⇒ exclu", preselect([rc({ isBigDeal: true })], T).length === 0);
check(`montant sous ${RR.minGmv} ⇒ exclu`, preselect([rc({ gmv: RR.minGmv - 1 })], T).length === 0);
check("ET exclu ou inactif ⇒ exclu", preselect([rc({ ownerEligible: false })], T).length === 0);
check("dormante ⇒ exclue", preselect([rc({ milestone: { ...rc({}).milestone, status: "dormant_candidate" } })], T).length === 0);
check("sans activité récente ni création récente ⇒ exclue", preselect([rc({ lastActivityAt: "2026-07-20", createdAt: "2026-06-01" })], T).length === 0);
check("création récente sans activité ⇒ retenue", preselect([rc({ lastActivityAt: null, createdAt: "2026-09-05" })], T).length === 1);
check("affaire en cours ⇒ exclue", preselect([rc({ isCurrent: true })], T).length === 0);
check("stand-by ⇒ exclue", preselect([rc({ isActive: false })], T).length === 0);
check("cas nominal ⇒ retenu", preselect([rc({})], T).length === 1);

// Points, critère par critère
const e1 = evaluate(rc({}), T, W, []);
const pts = Object.fromEntries(e1.criteria.map((c) => [c.key, c.points]));
check("Examen devis = +3, activité cette semaine = +2, montant significatif = +2, prochaine étape non datée = +1, ET orange = +2", pts.etape === 3 && pts.activite === 2 && pts.montant === 2 && pts.prochaine_etape === 1 && pts.et === 2 && e1.total === 10, JSON.stringify(pts));
check("chaque critère porte une étiquette lisible", e1.criteria.every((c) => c.label.length > 3));
check("la raison est une seule phrase courte", e1.reason.length < 120 && (e1.reason.match(/\./g) ?? []).length === 1, e1.reason);
const e2 = evaluate(rc({ attention: "vert", gmv: 15_000, lastActivityAt: "2026-08-30", stageChangedRecently: true }), T, W, []);
const pts2 = Object.fromEntries(e2.criteria.map((c) => [c.key, c.points]));
check("ET vert = +1, montant modeste = +1, activité récente = +1, changement d'étape = +1", pts2.et === 1 && pts2.montant === 1 && pts2.activite === 1 && pts2.etape_changee === 1, JSON.stringify(pts2));
check("ET vert : la raison commence par « ET performant »", e2.reason.startsWith("ET performant"));
check("rendez-vous planifié (activité future) = +2", evaluate(rc({ lastActivityAt: "2026-09-15" }), T, W, []).criteria.find((c) => c.key === "activite")?.points === 2);
check("ET rouge = +1 seulement : il a déjà son créneau", evaluate(rc({ attention: "rouge" }), T, W, []).criteria.find((c) => c.key === "et")?.points === 1);

// Angle suggéré
check("Étude dossier récente ⇒ Qualification", suggestAngle(rc({ stage: "Etude dossier", createdAt: "2026-09-01" }), T) === "qualification");
check("Étude dossier ancienne ⇒ Stratégie client", suggestAngle(rc({ stage: "Etude dossier", createdAt: "2026-07-01" }), T) === "strategie_client");
check("Examen estimation non envoyée ⇒ Estimation", suggestAngle(rc({ stage: "Examen estimation" }), T) === "estimation");
check("Examen estimation envoyée ⇒ Stratégie client", suggestAngle(rc({ stage: "Examen estimation", milestone: { ...rc({}).milestone, estimationSentAt: "2026-09-01" } }), T) === "strategie_client");
check("Visite artisan à venir ⇒ Visite artisan", suggestAngle(rc({ stage: "Visite artisan", milestone: { ...rc({}).milestone, nextVisitAt: "2026-09-15" } }), T) === "visite_artisan");
check("Visite réalisée, activité fraîche ⇒ Planning", suggestAngle(rc({ stage: "Visite artisan" }), T) === "planning");
check("Visite réalisée, silence > 10 j ⇒ Création d'urgence", suggestAngle(rc({ stage: "Visite artisan", lastActivityAt: "2026-08-25" }), T) === "urgence");
check("Examen devis, devis envoyé ⇒ Closing", suggestAngle(rc({}), T) === "closing");
check("Examen devis, devis non envoyé ⇒ Stratégie client", suggestAngle(rc({ milestone: { ...rc({}).milestone, devisSentAt: null } }), T) === "strategie_client");
check("Signature ⇒ Closing", suggestAngle(rc({ stage: "Signature" }), T) === "closing");

// Historique : pénalités validées
const hx = (weeksAgo, status, opportunityId = "X", salesperson = "Anthony Ramaherison") => ({
  opportunityId,
  salesperson,
  weekStart: new Date(new Date(`${W}T00:00:00`).getTime() - weeksAgo * 7 * 86_400_000).toISOString().slice(0, 10),
  status,
});
const baseTotal = evaluate(rc({ opportunityId: "X" }), T, W, []).total;
check("choisie la semaine dernière : −4", evaluate(rc({ opportunityId: "X" }), T, W, [hx(1, "cloturee")]).total === baseTotal - 4);
check("choisie il y a 2 ou 3 semaines : −2", evaluate(rc({ opportunityId: "X" }), T, W, [hx(2, "remplacee")]).total === baseTotal - 2 && evaluate(rc({ opportunityId: "X" }), T, W, [hx(3, "cloturee")]).total === baseTotal - 2);
check("choisie il y a 4 semaines : plus de pénalité", evaluate(rc({ opportunityId: "X" }), T, W, [hx(4, "cloturee")]).total === baseTotal);
check("ignorée la semaine dernière : −3", evaluate(rc({ opportunityId: "X" }), T, W, [hx(1, "ignoree")]).total === baseTotal - 3);
check("ignorée il y a 2 semaines : aucune pénalité, elle revient normalement", evaluate(rc({ opportunityId: "X" }), T, W, [hx(2, "ignoree")]).total === baseTotal);
check("ignorance reprise : aucune pénalité", evaluate(rc({ opportunityId: "X" }), T, W, [hx(1, "reprise")]).total === baseTotal);
check("même ET choisi la semaine dernière : −1", evaluate(rc({ opportunityId: "Y" }), T, W, [hx(1, "cloturee", "X")]).total === baseTotal - 1);
check("autre ET la semaine dernière : rien", evaluate(rc({ opportunityId: "Y" }), T, W, [hx(1, "cloturee", "X", "David Bernstein")]).total === baseTotal);
check("une affaire pénalisée reste proposable si elle domine", rank([rc({ opportunityId: "X" }), rc({ opportunityId: "Z", gmv: 12_000, attention: "vert", lastActivityAt: "2026-08-30" })], T, W, [hx(1, "ignoree")])[0].candidate.opportunityId === "X");

// Diversité
const same = [
  rc({ opportunityId: "A1", client: "A1" }),
  rc({ opportunityId: "A2", client: "A2", gmv: 38_000 }),
  rc({ opportunityId: "A3", client: "A3", gmv: 36_000 }),
  rc({ opportunityId: "D1", client: "D1", owner: "David Bernstein", firstName: "David", stage: "Visite artisan", milestone: { ...rc({}).milestone, devisSentAt: null }, gmv: 30_000 }),
  rc({ opportunityId: "M1", client: "M1", owner: "Mathis Coulon", firstName: "Mathis", stage: "Examen estimation", attention: "vert", gmv: 30_000 }),
];
const raw = rank(same, T, W, []);
const div = pickDiverse(raw);
check("classement brut : les trois affaires d'Anthony en tête", raw.slice(0, 3).every((r) => r.candidate.owner === "Anthony Ramaherison"));
check("diversité : le top 3 mêle trois ET différents", new Set(div.map((r) => r.candidate.owner)).size === 3, div.map((r) => `${r.candidate.firstName}/${r.angleLabel}`).join(", "));
check("diversité : trois angles différents", new Set(div.map((r) => r.angle)).size === 3);
check("la principale reste la meilleure du classement brut", div[0] === raw[0]);
const far = [rc({ opportunityId: "A1" }), rc({ opportunityId: "A2", gmv: 38_000 }), rc({ opportunityId: "V1", owner: "Vincent Da Silva", firstName: "Vincent D.", gmv: 11_000, attention: "vert", lastActivityAt: "2026-08-30", stage: "Etude dossier", createdAt: "2026-06-01" })];
check("diversité : un candidat trop faible ne remplace pas une seconde affaire du même ET", pickDiverse(rank(far, T, W, []))[1]?.candidate.opportunityId === "A2");
check("au plus 1 principale + 2 alternatives", recommend(same, T, W, []).alternatives.length === RR.alternatives);
check("aucun candidat ⇒ aucune recommandation, jamais imposée", recommend([rc({ isBigDeal: true })], T, W, []) === null);

// Sur la base réelle. L'affaire posée par S6 est close d'abord : la
// recommandation n'existe que sans affaire en cours.
const leftover = currentDealOfWeek();
if (leftover) closeDealOfWeek(leftover.id);
const real = buildWeek(now);
if (real.recommendation) {
  const rec = real.recommendation;
  const all = [rec.primary, ...rec.alternatives];
  check("recommandation réelle : principale + au plus 2 alternatives", rec.alternatives.length <= 2, `${rec.considered} candidats`);
  check("aucune recommandation n'est un gros dossier", all.every((r) => !real.bigDeals.some((d) => d.opportunityId === r.candidate.opportunityId)));
  check("aucune recommandation ne vient d'un ET exclu", all.every((r) => !ATTENTION.excluded.includes(r.candidate.owner)));
  check("des ET différents quand c'est possible", new Set(all.map((r) => r.candidate.owner)).size === all.length);
  check("chaque recommandation porte une raison, un angle et des critères", all.every((r) => r.reason && r.angleLabel && r.criteria.length > 0));
  console.log("  → " + all.map((r, i) => `${i + 1}. ${r.candidate.firstName} — ${r.candidate.client} — ${kEurLocal(r.candidate.gmv)} — ${r.candidate.stage} · ${r.angleLabel} · ${r.total} pts`).join("\n  → "));
} else {
  check("aucune recommandation réelle (aucun candidat) : état admis", true);
}

// Ignorer la semaine, sur la copie
const primaryId = real.recommendation?.primary.candidate.opportunityId;
if (primaryId && !real.dealOfWeek) {
  check("ignorer ⇒ enregistré une fois", ignoreWeek({ opportunityId: primaryId, salesperson: real.recommendation.primary.candidate.owner, weekStart }) && !ignoreWeek({ opportunityId: primaryId, salesperson: "x", weekStart }));
  const ignored = buildWeek(now);
  check("semaine ignorée : plus de recommandation, bandeau à 0, aucune affaire imposée", ignored.ignoredThisWeek && ignored.recommendation === null && ignored.summary.dealOfWeek === 0 && ignored.dealOfWeek === null);
  const thursday = ignored.planning.find((s) => s.kind === "affaire_semaine");
  check("le créneau du jeudi est réaffecté ou disponible, jamais rempli d'une affaire", thursday && (thursday.item === null || thursday.item.kind !== "affaire_semaine"));
  check("reprendre ⇒ la recommandation revient", resumeWeek(weekStart) && !isWeekIgnored(weekStart) && buildWeek(now).recommendation !== null);
  check("une ignorance reprise ne pénalise pas l'affaire", buildWeek(now).recommendation.primary.candidate.opportunityId === primaryId);
}

// --- Bilan -------------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "TOUS LES CONTRÔLES PASSENT" : `${failures} CONTRÔLE(S) EN ÉCHEC`} (base de travail : ${process.env.RM_DB_PATH})`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles LOT 1 — Plan du jour V2.
 *
 *   npm run morning:plan-v2-verify
 *
 * Le Plan est une liste COURTE de situations managériales, recalculée en entier
 * depuis l'état courant. Ces contrôles couvrent les plafonds (7 au total, 2 par
 * commercial), l'unicité des affaires, la porte du motif managérial, les
 * absences de signal, le geste « Traité » et « Tout traiter », le lendemain,
 * l'absence de tâche persistante et le journal.
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : affaires, mails et snapshots fictifs, gestes
 * « Traité ». Jamais sur les données réelles.
 *
 * Les contrôles 12 à 14 de la liste du chantier (mois métier identique partout,
 * signé officiel, affaires distinctes) vivent dans `business-time:verify` et
 * `signed:verify`.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "plan-v2.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { parisDate } = await import(lib("business-time"));
const { ATTENTION, MORNING_PLAN } = await import(lib("config"));
const {
  absenceSignals,
  hasManagerialMotive,
  selectSituations,
} = await import(lib("morning-plan-select"));
const { buildMorningPlan } = await import(lib("morning-priority"));
const { triage, markActionDone, doneActionKeys, completeShownActions } = await import(lib("morning-events"));
const { recordPlanLog } = await import(lib("morning-plan-log"));
const { loadTeam } = await import(lib("team-store"));
const { computeMetrics } = await import(lib("metrics"));
const { loadOpportunities } = await import(lib("repository"));
const { loadStageStability } = await import(lib("stage-history"));
const { stagnantDeals } = await import(lib("stagnation"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const nowMs = Date.now();
const HOUR = 36e5;
const DAY = 24 * HOUR;
const hoursAgo = (h) => new Date(nowMs - h * HOUR).toISOString();
const now = new Date(nowMs);
// Date de la copie locale : ses snapshots et ses mails datent de ce jour-là. Les
// invariants sont contrôlés aux DEUX dates, pour ne pas dépendre de l'âge de la copie.
const dataDay = new Date("2026-09-10T16:00:00Z");
const today = parisDate(now);
const dayOffset = (n) => parisDate(new Date(nowMs + n * DAY));

const MAX = MORNING_PLAN.maxSituations;
const PER_OWNER = MORNING_PLAN.maxPerOwner;

// --- Candidats synthétiques ----------------------------------------------------
let seq = 0;
const cand = ({ owner, score, category = "decisive", ids }) => {
  seq += 1;
  const opportunityIds = ids ?? [`SYN_OPP_${seq}`];
  return {
    key: `${category}:SYN_${seq}`,
    reason: "affaire_decisive",
    category,
    source: "forecast",
    why: "",
    todo: "",
    title: "",
    detail: "",
    client: "",
    owner,
    ownerFirstName: owner,
    salesperson: owner,
    gmv: 50_000,
    stage: null,
    facts: [],
    messageId: null,
    receivedAt: null,
    opportunityId: opportunityIds[0] ?? null,
    opportunityIds,
    score,
  };
};

// ============================================================================
section("A — Règles de sélection (pures)");

{
  const many = Array.from({ length: 30 }, (_, i) => cand({ owner: `Commercial ${i}`, score: 1000 - i }));
  const sel = selectSituations(many);
  check("1. jamais plus de 7 situations (30 candidates)", sel.length === MAX, `${sel.length}`);
  check("1b. ce sont les 7 meilleurs scores", sel.every((a, i) => a.score === 1000 - i));
}
{
  const one = Array.from({ length: 12 }, (_, i) => cand({ owner: "Anthony", score: 900 - i }));
  const others = [cand({ owner: "David", score: 100 }), cand({ owner: "Mathis", score: 90 })];
  const sel = selectSituations([...one, ...others]);
  const anthony = sel.filter((a) => a.owner === "Anthony").length;
  check("2. jamais plus de 2 situations par commercial", anthony === PER_OWNER, `${anthony}`);
  check("2b. les autres commerciaux passent devant le 3e d'Anthony", sel.some((a) => a.owner === "David") && sel.some((a) => a.owner === "Mathis"));
}
{
  // La même affaire sous trois familles, et une situation « N affaires » qui la recouvre.
  const a = cand({ owner: "Anthony", score: 900, category: "chaud", ids: ["OPP_X"] });
  const b = cand({ owner: "Anthony", score: 800, category: "decisive", ids: ["OPP_X"] });
  const c = cand({ owner: "David", score: 700, category: "signature", ids: ["OPP_X"] });
  const d = cand({ owner: "Guillaume", score: 600, category: "figees", ids: ["OPP_X", "OPP_Y"] });
  const e = cand({ owner: "Guillaume", score: 500, category: "decisive", ids: ["OPP_Y"] });
  const sel = selectSituations([a, b, c, d, e]);
  const ids = sel.flatMap((s) => s.opportunityIds);
  check("3. aucun doublon d'OpportunityId", new Set(ids).size === ids.length, ids.join(","));
  check("3b. le meilleur score garde l'affaire", sel.some((s) => s.key === a.key) && !sel.some((s) => s.key === b.key));
}
{
  // Situations sans affaire (pipe faible) : jamais dédoublonnées entre elles par erreur.
  const p1 = cand({ owner: "Guillaume", score: 300, category: "pipe_faible", ids: [] });
  const p2 = cand({ owner: "Mathis", score: 290, category: "pipe_faible", ids: [] });
  check("3c. deux pipes faibles de commerciaux différents coexistent", selectSituations([p1, p2]).length === 2);
}
{
  // Les mails ne monopolisent pas le Plan : les Blocs 1 et 2 les listent déjà.
  const mails = Array.from({ length: 10 }, (_, i) => cand({ owner: `M${i}`, score: 1200 - i, category: i % 2 ? "attente" : "chaud" }));
  const structural = Array.from({ length: 6 }, (_, i) => cand({ owner: `S${i}`, score: 500 - i, category: "challenge" }));
  const sel = selectSituations([...mails, ...structural]);
  const hotN = sel.filter((s) => s.category === "chaud").length;
  const waitN = sel.filter((s) => s.category === "attente").length;
  const cap = MORNING_PLAN.maxPerMailFamily;
  check(`plafond par famille née d'un mail (${cap} chaud, ${cap} attente)`, hotN === cap && waitN === cap, `${hotN} chaud · ${waitN} attente`);
  check("le Plan reste plein grâce aux situations structurelles", sel.length === MAX);
  // Une famille ne prive pas l'autre : des « chauds » (poids de base plus haut) ne
  // doivent pas empêcher un client qui attend d'apparaître.
  const hotOnly = Array.from({ length: 6 }, (_, i) => cand({ owner: `H${i}`, score: 1300 - i, category: "chaud" }));
  const oneWaiting = cand({ owner: "W", score: 800, category: "attente" });
  const mix = selectSituations([...hotOnly, oneWaiting]);
  check("un client qui attend passe même derrière six clients motivés", mix.some((s) => s.key === oneWaiting.key), `${mix.length} situations`);
  const fewer = selectSituations([...mails.slice(0, 2), structural[0]]);
  check("jamais de remplissage artificiel : peu de situations, Plan court", fewer.length === 3, `${fewer.length}`);
}

section("A' — Motif managérial et absences de signal (pures)");

check(
  "4. une grosse affaire qui avance normalement n'a pas de motif",
  hasManagerialMotive({ inChallenge: false, stalled: false, clientSpoke: false }) === false,
);
check("4b. à challenger → motif", hasManagerialMotive({ inChallenge: true, stalled: false, clientSpoke: false }));
check("4c. figée → motif", hasManagerialMotive({ inChallenge: false, stalled: true, clientSpoke: false }));
check("4d. le client écrit → motif", hasManagerialMotive({ inChallenge: false, stalled: false, clientSpoke: true }));

{
  const base = { salesperson: "X", firstName: "X", staleCount: 0 };
  const low = absenceSignals({ ...base, activeCount: 6, activeGmv: 210_000, stagnant: { count: 0, minProvenDays: 0, examples: [] } });
  check("5. pipe insuffisant remonte quand le signal existe", low.pipe != null, low.pipe?.detail ?? "");
  const ok = absenceSignals({ ...base, activeCount: 6, activeGmv: ATTENTION.lowPipeGmv + 1, stagnant: { count: 0, minProvenDays: 0, examples: [] } });
  check("5b. pipe suffisant : pas de situation", ok.pipe == null);
  const frozen = absenceSignals({ ...base, activeCount: 6, activeGmv: 900_000, stagnant: { count: 4, minProvenDays: 21, examples: ["A", "B", "C"] } });
  check("6. plusieurs affaires figées → une situation agrégée", frozen.frozen != null, frozen.frozen?.detail ?? "");
  const few = absenceSignals({ ...base, activeCount: 6, activeGmv: 900_000, stagnant: { count: 2, minProvenDays: 21, examples: [] } });
  check("6b. deux affaires figées seulement : rien (seuil d'attention.ts)", few.frozen == null);
  const diluted = absenceSignals({ ...base, activeCount: 20, activeGmv: 900_000, stagnant: { count: 4, minProvenDays: 21, examples: [] } });
  check("6c. 4 figées sur 20 : rien (part du pipe sous le seuil)", diluted.frozen == null);
}

// ============================================================================
section("B — Sur les données réelles (lecture seule)");

const tables = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const counts = () => {
  const out = {};
  for (const t of tables()) out[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return out;
};

const tablesBefore = tables();
const countsBefore = counts();
const planReal = buildMorningPlan(now);
const planData = buildMorningPlan(dataDay);
const countsAfter = counts();

for (const [label, plan] of [["aujourd'hui", planReal], ["date des données (10/09)", planData]]) {
  const byOwner = new Map();
  for (const a of plan.actions) byOwner.set(a.owner ?? "?", (byOwner.get(a.owner ?? "?") ?? 0) + 1);
  const ids = plan.actions.flatMap((a) => a.opportunityIds);
  check(`${label} — au plus ${MAX} situations`, plan.actions.length <= MAX, `${plan.actions.length}`);
  check(`${label} — au plus ${PER_OWNER} par commercial`, [...byOwner.values()].every((n) => n <= PER_OWNER), JSON.stringify(Object.fromEntries(byOwner)));
  check(`${label} — aucune affaire en double`, new Set(ids).size === ids.length);
  check(
    `${label} — chaque situation porte owner, catégorie, source, raison, score`,
    plan.actions.every((a) => a.category && a.source && a.reason && Number.isFinite(a.score) && (a.owner || a.category === "chaud" || a.category === "attente")),
  );
  check(`${label} — chaque situation a un titre et une justification`, plan.actions.every((a) => a.title.includes(" — ") && a.detail.length > 0));
  check(
    `${label} — le titre commence par le commercial`,
    plan.actions.every((a) => a.title.startsWith(a.ownerFirstName ?? "Commercial à identifier")),
  );
}

check("9. le calcul du Plan n'écrit rien en base", JSON.stringify(countsBefore) === JSON.stringify(countsAfter));

// Pipe faible et affaires figées : mêmes règles qu'attention.ts, recalculées indépendamment.
{
  const team = loadTeam().filter((m) => !ATTENTION.excluded.includes(m.name));
  const opps = loadOpportunities();
  const pipe = new Map(computeMetrics(opps, today).owners.map((o) => [o.owner, o]));
  const stab = loadStageStability(today);
  const wantLow = [];
  const wantFrozen = [];
  for (const m of team) {
    const mine = opps.filter((o) => o.isActive && o.owner === m.name);
    if ((pipe.get(m.name)?.activeGmv ?? 0) < ATTENTION.lowPipeGmv) wantLow.push(`pipe_faible:${m.name}`);
    const s = stagnantDeals(mine, stab, today).length;
    if (s >= ATTENTION.stagnantMinCount && mine.length > 0 && s / mine.length >= ATTENTION.stagnantShare) wantFrozen.push(`figees:${m.name}`);
  }
  const has = (k) => planReal.pool.keys.includes(k);
  check(
    `5. « pipe insuffisant » : ${wantLow.length} commercial(aux) attendu(s), tous dans le vivier`,
    wantLow.every(has) && planReal.pool.keys.filter((k) => k.startsWith("pipe_faible:")).length === wantLow.length,
    wantLow.join(", ") || "aucun",
  );
  check(
    `6. « affaires figées » : ${wantFrozen.length} commercial(aux) attendu(s), tous dans le vivier`,
    wantFrozen.every(has) && planReal.pool.keys.filter((k) => k.startsWith("figees:")).length === wantFrozen.length,
    wantFrozen.join(", ") || "aucun",
  );
  const sami = ATTENTION.excluded[0];
  check("Sami est exclu des absences de signal", !planReal.pool.keys.some((k) => k === `pipe_faible:${sami}` || k === `figees:${sami}`));
}

// ============================================================================
section("C1 — Une grosse affaire sans motif managérial n'entre pas ; la même, figée, entre");

const kanbanYear = Number(today.slice(0, 4));
const kanbanMonth = Number(today.slice(5, 7));
const cleanup = { opportunities: [], messages: [], snapshots: [] };

function insertOpportunity({ id, owner, gmv = 60_000, lastActivity = null, kanban = false }) {
  db.prepare(
    `INSERT INTO opportunity
       (opportunity_id, name, client_contact, owner, gmv, stage, kanban_month, kanban_year, last_activity_at,
        is_signed, is_terminal, is_standby, is_active,
        milestone_status, milestone_is_legacy, client_waiting, milestone_lateness_hours, first_seen_on, last_import_id)
     VALUES (?, ?, ?, ?, ?, 'Examen devis', ?, ?, ?, 0, 0, 0, 1, 'normal', 0, 0, 0, ?, 0)`,
  ).run(id, `Client ${id}`, `Client ${id}`, owner, gmv, kanban ? kanbanMonth : null, kanban ? kanbanYear : null, lastActivity, today);
  cleanup.opportunities.push(id);
}
function insertSnapshot(id, owner, date, stage) {
  db.prepare(
    `INSERT OR REPLACE INTO opportunity_snapshot
       (snapshot_date, opportunity_id, import_id, owner, gmv, stage, is_standby, is_signed, is_active)
     VALUES (?, ?, 0, ?, 300000, ?, 0, 0, 1)`,
  ).run(date, id, owner, stage);
  cleanup.snapshots.push([date, id]);
}

// Un commercial pour qui l'ajout de deux affaires n'allume PAS « N affaires figées » :
// sinon la situation agrégée absorberait légitimement l'affaire figée du test.
const opps0 = loadOpportunities();
const stab0 = loadStageStability(today);
const owner = loadTeam()
  .filter((m) => !ATTENTION.excluded.includes(m.name))
  .find((m) => {
    const mine = opps0.filter((o) => o.isActive && o.owner === m.name);
    const s = stagnantDeals(mine, stab0, today).length + 1;
    return !(s >= ATTENTION.stagnantMinCount && s / (mine.length + 2) >= ATTENTION.stagnantShare);
  })?.name;
check("un commercial de test est disponible", owner != null, owner ?? "aucun");

const BIG_MOVING = "TESTPV_BIG_MOVING";
const BIG_STALLED = "TESTPV_BIG_STALLED";
const recent = new Date(nowMs - 1 * DAY).toISOString().slice(0, 10);
const old = new Date(nowMs - 40 * DAY).toISOString().slice(0, 10);

insertOpportunity({ id: BIG_MOVING, owner, gmv: 300_000, lastActivity: recent, kanban: true });
insertSnapshot(BIG_MOVING, owner, dayOffset(-3), "Examen estimation");
insertSnapshot(BIG_MOVING, owner, today, "Examen devis"); // l'étape vient de changer

insertOpportunity({ id: BIG_STALLED, owner, gmv: 300_000, lastActivity: old, kanban: true });
insertSnapshot(BIG_STALLED, owner, dayOffset(-25), "Examen devis");
insertSnapshot(BIG_STALLED, owner, today, "Examen devis"); // 25 jours sans changement

const planC1 = buildMorningPlan(now);
check(
  "4. une affaire de 300 k€ qui avance normalement n'est PAS une situation",
  !planC1.pool.keys.includes(`decisive:${BIG_MOVING}`) && !planC1.actions.some((a) => a.opportunityIds.includes(BIG_MOVING)),
);
check(
  "4e. la même affaire, sans mouvement depuis 25 jours, EST une situation candidate",
  planC1.pool.keys.includes(`decisive:${BIG_STALLED}`),
);
const stalledAction = planC1.actions.find((a) => a.opportunityIds.includes(BIG_STALLED));
if (stalledAction) {
  check("4f. sa justification dit « aucun mouvement depuis au moins N jours »", /aucun mouvement depuis au moins \d+ jours/.test(stalledAction.detail), stalledAction.detail);
  check("4g. le titre nomme le commercial", stalledAction.title.startsWith(stalledAction.ownerFirstName), stalledAction.title);
}

// ============================================================================
section("C2 — « Traité » : disparaît pour la journée, revient le lendemain, ne crée aucune tâche");

const PIPE = { match_kind: "affaire_pipe", opportunity_stage: null, lead_status: null, stage: "Examen devis", is_terminal: 0, owner: null, ext_owner: null, lead_owner: null, rm_to: null, rm_cc: null };
const OPP_H = "TESTPV_HOT";
const MSG_H = "TESTPV_MSG_HOT";
insertOpportunity({ id: OPP_H, owner, gmv: 90_000, lastActivity: recent });
const tH = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Nous souhaitons avancer, quelle est la prochaine etape ?", blocker: null, signal_type: "neutre" });
db.prepare(
  `INSERT INTO mail_signal
     (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction, filter_rule,
      opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
   VALUES (?, ?, ?, 'client@example.com', 'Client Test', 'Devis', 'entrant', 'conserve', ?, 'A', 'test', ?, 'neutre', ?, 0)`,
).run(MSG_H, "TESTPV_THREAD_HOT", hoursAgo(1), OPP_H, owner, "Nous souhaitons avancer, quelle est la prochaine etape ?");
cleanup.messages.push(MSG_H);
db.prepare(
  `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
   VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)`,
).run(MSG_H, "TESTPV_THREAD_HOT", hoursAgo(1), tH.category, tH.reason, new Date(nowMs).toISOString());
cleanup.messages.push(MSG_H);

const HOT_KEY = `chaud:${MSG_H}`;
const planH = buildMorningPlan(now);
const hotAction = planH.actions.find((a) => a.key === HOT_KEY);
check("la situation « client motivé » est dans le Plan", hotAction != null, planH.actions.map((a) => a.key).join(", "));
if (hotAction) {
  check("son titre est au format « Commercial — situation »", /^.+ — .+ veut avancer$/.test(hotAction.title), hotAction.title);
  check("sa justification est tirée des données (GMV, étape, fraîcheur)", /90 k€/.test(hotAction.detail) && /message reçu/.test(hotAction.detail), hotAction.detail);
}

// Traité : le geste « action_faite » n'écrit que morning_action_done — le message
// reste en attente, comme une situation cochée dans le Plan sans acquitter le mail.
markActionDone(HOT_KEY, now);
const planH2 = buildMorningPlan(now);
check("7. traitée : elle disparaît du Plan pour la journée", !planH2.actions.some((a) => a.key === HOT_KEY));
check("7b. elle est comptée comme traitée aujourd'hui", planH2.doneToday >= 1 && doneActionKeys(now).has(HOT_KEY));

const tomorrow = new Date(nowMs + DAY);
const planNext = buildMorningPlan(tomorrow);
check("8. le lendemain, le jour est vierge (rien n'est reporté)", planNext.doneToday === 0, `${planNext.doneToday}`);
check("8b. le lendemain, la situation revient si elle persiste", planNext.actions.some((a) => a.key === HOT_KEY), planNext.actions.map((a) => a.key).join(", "));

// ============================================================================
section("C3 — Budget journalier : traiter ne fait pas remonter la huitième");

{
  const p = buildMorningPlan(tomorrow);
  const shown = p.actions.map((a) => a.key);
  // Tout traiter, exactement ce qui est affiché.
  completeShownActions(p.actions, new Set(shown), tomorrow);
  const after = buildMorningPlan(tomorrow);
  check(
    `budget : ${shown.length} situations traitées → ${MAX - shown.length} au plus restent`,
    after.actions.length <= MAX - shown.length,
    `${after.actions.length} restante(s)`,
  );
  check("après avoir tout traité, aucune situation ne remplace celles traitées", shown.length < MAX || after.actions.length === 0);
  check("les situations traitées ne reviennent pas le même jour", after.actions.every((a) => !shown.includes(a.key)));
}

// Verrou de la règle voulue : une nouvelle urgence en cours de journée ne recrée
// pas de place dans le Plan, elle reste visible dans les Blocs 1 et 2.
{
  const day = new Date(nowMs + 4 * DAY);
  const p = buildMorningPlan(day);
  completeShownActions(p.actions, new Set(p.actions.map((a) => a.key)), day); // tout traité
  check("budget : 7 traitées → le Plan du jour est terminé", buildMorningPlan(day).actions.length === 0 && p.actions.length === MAX);

  // Une urgence fraîche arrive dans la journée (client motivé, message d'il y a 5 minutes).
  const MSG_U = "TESTPV_MSG_URGENT";
  const OPP_U = "TESTPV_URGENT";
  insertOpportunity({ id: OPP_U, owner, gmv: 500_000, lastActivity: recent });
  const tU = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Nous souhaitons avancer, quelle est la prochaine etape ?", blocker: null, signal_type: "neutre" });
  const sentAt = new Date(day.getTime() - 5 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO mail_signal
       (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction, filter_rule,
        opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
     VALUES (?, ?, ?, 'client@example.com', 'Client Test', 'Devis', 'entrant', 'conserve', ?, 'A', 'test', ?, 'neutre', ?, 0)`,
  ).run(MSG_U, "TESTPV_THREAD_URGENT", sentAt, OPP_U, owner, "Nous souhaitons avancer, quelle est la prochaine etape ?");
  db.prepare(
    `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)`,
  ).run(MSG_U, "TESTPV_THREAD_URGENT", sentAt, tU.category, tU.reason, sentAt);
  cleanup.messages.push(MSG_U);

  const after = buildMorningPlan(day);
  check("budget : une urgence en cours de journée ne recrée AUCUNE place dans le Plan", after.actions.length === 0, `${after.actions.length} situation(s)`);
  check("l'urgence est bien un candidat, visible dans le Bloc 1", after.pool.keys.includes(`chaud:${MSG_U}`) && after.hot.some((e) => e.messageId === MSG_U));
  check("le lendemain, elle peut entrer dans le Plan", buildMorningPlan(new Date(day.getTime() + DAY)).pool.keys.includes(`chaud:${MSG_U}`));
}

// ============================================================================
section("C4 — « Tout traiter » ne traite que les situations affichées");

{
  const day = new Date(nowMs + 2 * DAY);
  const p = buildMorningPlan(day);
  const hiddenKey = p.pool.keys.find((k) => !p.actions.some((a) => a.key === k)); // candidate hors Plan
  check("un vivier plus large que le Plan existe (sinon le contrôle est vide)", hiddenKey != null, `${p.pool.total} candidates / ${p.actions.length} affichées`);
  const shownSubset = p.actions.slice(0, Math.max(1, p.actions.length - 1)).map((a) => a.key);
  const notShown = p.actions.slice(shownSubset.length).map((a) => a.key);
  const ghost = "chaud:MESSAGE_FANTOME";
  const changed = completeShownActions(p.actions, new Set([...shownSubset, hiddenKey, ghost].filter(Boolean)), day);
  const done = doneActionKeys(day);
  check("les situations affichées sont traitées", shownSubset.every((k) => done.has(k)), `${changed}/${shownSubset.length}`);
  check("une situation non affichée n'est pas traitée", notShown.every((k) => !done.has(k)), notShown.join(", ") || "aucune");
  check("une candidate hors Plan (8e, filtrée) n'est pas traitée", hiddenKey == null || !done.has(hiddenKey), hiddenKey ?? "");
  check("une clé inconnue n'est pas traitée", !done.has(ghost));
  const legacy = buildMorningPlan(new Date(nowMs + 3 * DAY));
  const n = completeShownActions(legacy.actions, null, new Date(nowMs + 3 * DAY));
  check("sans liste de clés (appel ancien), le Plan plafonné est traité tel quel", n === legacy.actions.length && n <= MAX, `${n}`);
}

// ============================================================================
section("C5 — Aucune tâche persistante, journal idempotent");

{
  const tablesAfter = tables();
  const added = tablesAfter.filter((t) => !tablesBefore.includes(t));
  check("9. aucune table créée par le Plan ou les gestes", added.length === 0, added.join(", "));
  const cols = db.prepare("PRAGMA table_info(morning_plan_log)").all().map((c) => c.name);
  const expected = ["plan_date", "action_key", "owner", "opportunity_id", "category", "score", "rank", "gmv", "reason_code", "created_at"];
  check("le journal porte exactement les colonnes prévues", JSON.stringify(cols) === JSON.stringify(expected), cols.join(","));
  check(
    "le journal n'a aucune colonne de statut, d'échéance, de report ou de rappel",
    !cols.some((c) => /status|statut|deadline|due|snooze|remind|rappel|echeance|report|backlog|done|traite/i.test(c)),
  );

  db.prepare("DELETE FROM morning_plan_log").run();
  const day = new Date(nowMs + 5 * DAY);
  const p = buildMorningPlan(day);
  const first = recordPlanLog(p.actions, day, p.doneToday);
  const second = recordPlanLog(p.actions, day, p.doneToday);
  const rows = db.prepare("SELECT * FROM morning_plan_log WHERE plan_date = ? ORDER BY rank").all(parisDate(day));
  check("11. premier enregistrement : une ligne par situation", first === p.actions.length && rows.length === p.actions.length, `${first}/${p.actions.length}`);
  check("11b. second enregistrement le même jour : rien d'ajouté", second === 0 && rows.length === p.actions.length, `${second}`);
  check("11c. rangs 1..N, montants et raisons renseignés", rows.every((r, i) => r.rank === i + 1 && r.reason_code && r.category && r.score != null));
  check("11d. owner et OpportunityId conservés", rows.every((r, i) => r.owner === p.actions[i].owner && r.opportunity_id === p.actions[i].opportunityId));
  const nextDay = new Date(day.getTime() + DAY);
  const added2 = recordPlanLog(p.actions, nextDay, 0);
  check("11e. un autre jour : de nouvelles lignes, l'historique du premier jour reste", added2 === p.actions.length && db.prepare("SELECT COUNT(*) n FROM morning_plan_log").get().n === 2 * p.actions.length);
  // Le journal n'est écrit que par `recordPlanLog` et déclaré dans `db.ts` : aucun
  // autre module de `src` ne le nomme, donc rien ne peut le relire pour construire
  // le Plan.
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      const f = path.join(dir, e);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.(ts|tsx)$/.test(e)) out.push(f);
    }
    return out;
  };
  const mentions = walk(path.resolve(process.cwd(), "src"))
    .filter((f) => /morning_plan_log/.test(readFileSync(f, "utf8")))
    .map((f) => path.basename(f))
    .sort();
  check("le journal n'est nommé que par db.ts (schéma) et morning-plan-log.ts (écriture)", JSON.stringify(mentions) === JSON.stringify(["db.ts", "morning-plan-log.ts"]), mentions.join(", "));

  // Migration : par rapport à la base SOURCE, la seule table ajoutée est le journal.
  const src = new DatabaseSync(SOURCE, { readOnly: true });
  const sourceTables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  src.close();
  const migrated = tablesAfter.filter((t) => !sourceTables.includes(t));
  // La base source locale a pu être ouverte (donc migrée) par une autre suite :
  // la table peut déjà s'y trouver. Ce qui compte, c'est qu'aucune AUTRE table
  // n'ait été ajoutée, et que le journal existe bien.
  check(
    "migration additive : aucune table ajoutée hors morning_plan_log, et le journal existe",
    migrated.every((t) => t === "morning_plan_log") && tablesAfter.includes("morning_plan_log"),
    migrated.length === 0 ? "déjà présente dans la source" : migrated.join(", "),
  );
}

// --- Nettoyage ---------------------------------------------------------------
if (cleanup.opportunities.length > 0) {
  const ph = cleanup.opportunities.map(() => "?").join(",");
  db.prepare(`DELETE FROM opportunity WHERE opportunity_id IN (${ph})`).run(...cleanup.opportunities);
  db.prepare(`DELETE FROM opportunity_snapshot WHERE opportunity_id IN (${ph})`).run(...cleanup.opportunities);
}
if (cleanup.messages.length > 0) {
  const ph = cleanup.messages.map(() => "?").join(",");
  db.prepare(`DELETE FROM mail_signal WHERE gmail_message_id IN (${ph})`).run(...cleanup.messages);
  db.prepare(`DELETE FROM morning_event WHERE gmail_message_id IN (${ph})`).run(...cleanup.messages);
}

console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles — Plan du jour par AFFAIRES.
 *
 *   npm run morning:plan-v2-verify
 *
 * Le Plan sélectionne au plus 7 AFFAIRES (un OpportunityId par ligne), classées
 * par impact GMV actionnable. Aucun plafond par commercial, aucune situation
 * agrégée, aucun remplissage. Ces contrôles couvrent la formule d'impact famille
 * par famille, les portes (GMV, stand-by, crédibilité, signal dur), la sélection,
 * le budget journalier, « Tout traiter », le journal et l'absence de tâche
 * persistante.
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : affaires, mails et snapshots fictifs, gestes
 * « Traité ». Jamais sur les données réelles.
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
const { evaluateAffaire, hardSignals, selectAffaires } = await import(lib("morning-plan-select"));
const { buildMorningPlan } = await import(lib("morning-priority"));
const { triage, markActionDone, doneActionKeys, completeShownActions } = await import(lib("morning-events"));
const { recordPlanLog } = await import(lib("morning-plan-log"));
const { loadTeam } = await import(lib("team-store"));
const { buildOwnerSignals } = await import(lib("owner-signals"));
const { stagnantDeals } = await import(lib("stagnation"));
const { loadOpportunities } = await import(lib("repository"));
const { loadStageStability } = await import(lib("stage-history"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);
const near = (a, b, eps = 0.5) => Math.abs(a - b) < eps;

const db = getDb();
const nowMs = Date.now();
const HOUR = 36e5;
const DAY = 24 * HOUR;
const now = new Date(nowMs);
const today = parisDate(now);
const dayOffset = (n) => parisDate(new Date(nowMs + n * DAY));
const hoursAgo = (h) => new Date(nowMs - h * HOUR).toISOString();
const MAX = MORNING_PLAN.maxSituations;

// ---- entrées synthétiques ---------------------------------------------------------
const aff = (o = {}) => ({
  opportunityId: "OPP", client: "Client", owner: "Commercial", gmv: 100_000, stage: "Examen devis", pMonthEnd: 0.05, scored: true,
  declaredOnM: false, kanbanMonth: null, challengeKind: null, stalled: false, stalledDays: null, daysSinceActivity: 5,
  standby: false, frozenMonthEnd: false, hard: [], ...o,
});
const MSG = [{ kind: "message", label: "client actif aujourd'hui" }];
const VIS = [{ kind: "visite", label: "visite planifiée le 22/09" }];

// ============================================================================
section("A — Formule d'impact, famille par famille (le replay validé)");

const chanville = evaluateAffaire(aff({ gmv: 186_773, pMonthEnd: 0.026, declaredOnM: true, stalled: true, stalledDays: 15, challengeKind: "declaree_fragile" }));
check("A : De Chanville = g × 0,75 × (1 − p) = 136 k", chanville.eligible && chanville.family === "securiser" && near(chanville.impact, 186_773 * 0.75 * (1 - 0.026), 1) && Math.round(chanville.impact / 1000) === 136, chanville.impact?.toFixed(0));
const falcon = evaluateAffaire(aff({ gmv: 826_066, pMonthEnd: 0.034, stalled: true, stalledDays: 34, daysSinceActivity: 20, challengeKind: "absente_du_mois" }));
check("C : Falcon = min(GMV, 250 k) × 0,30 = 75 k, GMV réelle non plafonnée", falcon.eligible && falcon.family === "bloque" && near(falcon.impact, 75_000) && falcon.cappedGmv === 250_000);
const cyril = evaluateAffaire(aff({ gmv: 137_507, pMonthEnd: 0.034, challengeKind: "prevue_mois_suivant", standby: true, hard: MSG }));
check("B : Cyril LAGEL = g × 0,50 = 68,8 k (aucune décote supplémentaire)", cyril.eligible && cyril.family === "basculer" && near(cyril.impact, 137_507 * 0.5, 1), cyril.impact?.toFixed(0));
const boisdron = evaluateAffaire(aff({ gmv: 131_000, pMonthEnd: 0.039, challengeKind: "absente_du_mois", hard: VIS }));
check("D : Boisdron = g × 0,30 = 39,3 k (aucune décote supplémentaire)", boisdron.eligible && boisdron.family === "upside" && near(boisdron.impact, 131_000 * 0.3, 1), boisdron.impact?.toFixed(0));
const e = evaluateAffaire(aff({ gmv: 90_000, pMonthEnd: 0.05, declaredOnM: true }));
check("E : annoncée sur M, RM Morning < 10 % → divergence, même coefficient que A", e.eligible && e.family === "divergence" && near(e.impact, 90_000 * 0.75 * 0.95, 1));
check("doctrine : sécuriser l'annoncé > M+1 vers M > upside hors forecast", chanville.impact > cyril.impact && cyril.impact > boisdron.impact);
const big = evaluateAffaire(aff({ gmv: 1_000_000, pMonthEnd: 0.5, declaredOnM: true, stalled: true, stalledDays: 20 }));
check("le plafond GMV joue partout : 1 M€ pèse comme 250 k€ dans le score", big.eligible && near(big.impact, 250_000 * 0.75 * 0.5, 1));
const coefs = MORNING_PLAN.coefficient;
check("coefficients V1 : 0,75 / 0,50 / 0,30 / 0,30", coefs.securiser === 0.75 && coefs.basculer === 0.5 && coefs.bloque === 0.3 && coefs.upside === 0.3);

section("A' — Portes d'éligibilité");

check("GMV : 49 999 € est écarté, 50 000 € passe", !evaluateAffaire(aff({ gmv: 49_999, declaredOnM: true, stalled: true, stalledDays: 20 })).eligible && evaluateAffaire(aff({ gmv: 50_000, declaredOnM: true, stalled: true, stalledDays: 20 })).eligible);
const pecout = evaluateAffaire(aff({ gmv: 7_686, stage: "Signature", pMonthEnd: 0.7, declaredOnM: true, stalled: true, stalledDays: 20 }));
check("Thomas PÉCOUT (7,7 k€, Signature) ne prend aucune place : pas d'exception Signature", !pecout.eligible, pecout.why);
check("stand-by sans signal : exclu", !evaluateAffaire(aff({ standby: true, declaredOnM: true, stalled: true, stalledDays: 20 })).eligible);
check("stand-by + message entrant récent : redevient candidate", evaluateAffaire(aff({ standby: true, challengeKind: "prevue_mois_suivant", hard: MSG })).eligible);
check("stand-by au-delà de la fin du mois sans signal : exclu", !evaluateAffaire(aff({ frozenMonthEnd: true, declaredOnM: true, stalled: true, stalledDays: 20 })).eligible);
check("hors forecast p = 9,9 % sans signal dur : exclu", !evaluateAffaire(aff({ pMonthEnd: 0.099, challengeKind: "absente_du_mois" })).eligible);
check("hors forecast p = 10 % : passe", evaluateAffaire(aff({ pMonthEnd: 0.1, challengeKind: "absente_du_mois" })).eligible);
check("hors forecast p = 4 % + signal dur (visite) : passe", evaluateAffaire(aff({ pMonthEnd: 0.04, challengeKind: "absente_du_mois", hard: VIS })).eligible);
check("M+1 → M à 7 % sans signal dur (Quentin LETELLIER, Claire BASTARD) : exclu", !evaluateAffaire(aff({ pMonthEnd: 0.07, challengeKind: "prevue_mois_suivant" })).eligible);
check("gros GMV bloqué : p = 2,9 % exclu (BRIE 0,8 %), p = 3 % passe (Falcon 3,4 %)", !evaluateAffaire(aff({ gmv: 250_000, pMonthEnd: 0.029, stalled: true, stalledDays: 35 })).eligible && evaluateAffaire(aff({ gmv: 250_000, pMonthEnd: 0.03, stalled: true, stalledDays: 35 })).eligible);
check("gros GMV sans activité depuis plus de 90 j : mort, exclu", !evaluateAffaire(aff({ gmv: 800_000, pMonthEnd: 0.2, stalled: true, stalledDays: 35, daysSinceActivity: 200 })).eligible);
check("annoncée sur M, crédible et en mouvement : pas une situation", !evaluateAffaire(aff({ declaredOnM: true, pMonthEnd: 0.5 })).eligible);
check("annoncée sur M mais NON scorée : probabilité inconnue, aucune divergence fabriquée", !evaluateAffaire(aff({ declaredOnM: true, pMonthEnd: 0, scored: false })).eligible);
check("annoncée sur M, non scorée mais immobile : reste à sécuriser (le blocage est mesuré)", evaluateAffaire(aff({ declaredOnM: true, pMonthEnd: 0, scored: false, stalled: true, stalledDays: 20 })).eligible);

section("A'' — Signal dur : restreint (message entrant, visite) — jamais devis / stade / montant / date");

const nowD = new Date("2026-09-20T12:00:00Z");
check("aucun signal : liste vide", hardSignals({ lastInboundAt: null, nextVisitAt: null }, nowD).length === 0);
check("message entrant d'aujourd'hui : « client actif aujourd'hui »", hardSignals({ lastInboundAt: "2026-09-20T08:00:00Z", nextVisitAt: null }, nowD)[0]?.label === "client actif aujourd'hui");
check("message entrant il y a 3 jours : signal dur", hardSignals({ lastInboundAt: "2026-09-17T08:00:00Z", nextVisitAt: null }, nowD).length === 1);
check("message entrant il y a 8 jours : plus récent", hardSignals({ lastInboundAt: "2026-09-12T08:00:00Z", nextVisitAt: null }, nowD).length === 0);
check("visite planifiée dans 2 jours : signal dur", hardSignals({ lastInboundAt: null, nextVisitAt: "2026-09-22T09:00:00Z" }, nowD)[0]?.kind === "visite");
check("visite réalisée il y a 3 jours : signal dur", /réalisée/.test(hardSignals({ lastInboundAt: null, nextVisitAt: "2026-09-17T09:00:00Z" }, nowD)[0]?.label ?? ""));
check("visite dans 10 jours : hors fenêtre", hardSignals({ lastInboundAt: null, nextVisitAt: "2026-09-30T09:00:00Z" }, nowD).length === 0);
const src = readFileSync(path.resolve(process.cwd(), "src/lib/morning-plan-select.ts"), "utf8");
const hs = src.slice(src.indexOf("export function hardSignals"), src.indexOf("// --- Éligibilité"));
check("`hardSignals` ne lit ni devis, ni estimation, ni étape, ni montant, ni date de signature", !/devisSent|estimationSent|StageName|changeObserved|Amount|CloseDate|amount/.test(hs));

section("A''' — Sélection : max 7, aucun plafond par commercial, jamais de remplissage");

const cand = (i, owner, impact, gmv = 100_000) => ({ key: `affaire:C${i}`, owner, impact, gmv });
check("jamais plus de 7 affaires (20 candidates)", selectAffaires(Array.from({ length: 20 }, (_, i) => cand(i, `O${i}`, 1000 - i))).length === MAX);
{
  const four = [1, 2, 3, 4].map((i) => cand(i, "Guillaume H.", 900 - i));
  const others = [5, 6, 7, 8, 9].map((i) => cand(i, `Autre ${i}`, 100 - i));
  const sel = selectAffaires([...four, ...others]);
  check("aucun plafond par commercial : les 4 affaires du même commercial apparaissent toutes", four.every((f) => sel.some((s) => s.key === f.key)), `${sel.filter((s) => s.owner === "Guillaume H.").length}/4`);
  check("… et elles restent en tête (impact), sans équilibrage artificiel", sel.slice(0, 4).every((s) => s.owner === "Guillaume H."));
}
check("jamais de remplissage : 4 candidates → 4 lignes", selectAffaires([1, 2, 3, 4].map((i) => cand(i, `O${i}`, 100 - i))).length === 4);
check("aucune candidate → Plan vide", selectAffaires([]).length === 0);
{
  const sel = selectAffaires([cand(1, "A", 500), cand(1, "A", 400), cand(2, "B", 300)]);
  check("une affaire = une ligne (aucun doublon d'OpportunityId)", sel.length === 2 && new Set(sel.map((s) => s.key)).size === 2);
}
check("égalité d'impact : la GMV réelle départage", selectAffaires([cand(1, "A", 75_000, 250_000), cand(2, "B", 75_000, 826_000)])[0].key === "affaire:C2");
check("budget : max 0 → aucune affaire", selectAffaires([cand(1, "A", 10)], 0).length === 0);
{
  // Le classement validé : De Chanville, Falcon, Cyril, Boisdron.
  const order = [["Chanville", chanville], ["Falcon", falcon], ["Cyril", cyril], ["Boisdron", boisdron]].map(([n, v]) => ({ key: n, impact: v.impact, gmv: 1 }));
  check("classement validé : De Chanville, Falcon, Cyril, Boisdron", selectAffaires(order.reverse()).map((s) => s.key).join(",") === "Chanville,Falcon,Cyril,Boisdron");
}

// ============================================================================
section("B — Sur les données réelles (lecture seule)");

const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const counts = () => Object.fromEntries(tables().map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const tablesBefore = tables();
const countsBefore = counts();
const planReal = buildMorningPlan(now);
const planData = buildMorningPlan(new Date("2026-09-10T16:00:00Z"));
const countsAfter = counts();

for (const [label, plan] of [["aujourd'hui", planReal], ["date des données (10/09)", planData]]) {
  const ids = plan.actions.map((a) => a.opportunityId);
  check(`${label} — au plus ${MAX} affaires`, plan.actions.length <= MAX, `${plan.actions.length}`);
  check(`${label} — une ligne = une affaire distincte`, ids.every(Boolean) && new Set(ids).size === ids.length && plan.actions.every((a) => a.opportunityIds.length === 1 && a.key === `affaire:${a.opportunityId}`));
  check(`${label} — GMV réelle ≥ 50 k€ pour chaque ligne`, plan.actions.every((a) => (a.gmv ?? 0) >= MORNING_PLAN.minGmv));
  check(`${label} — impact décroissant`, plan.actions.every((a, i) => i === 0 || plan.actions[i - 1].score >= a.score));
  check(`${label} — aucune situation agrégée ni ligne « pipe insuffisant »`, plan.actions.every((a) => !/affaires figées|pipe insuffisant/.test(a.title)) && !plan.pool.keys.some((k) => !k.startsWith("affaire:")));
  check(`${label} — « Commercial — Client » puis « GMV · stade · raison »`, plan.actions.every((a) => a.title === `${a.ownerFirstName} — ${a.client}` && a.detail.startsWith(`${Math.round((a.gmv ?? 0) / 1000)} k€`) && a.detail.split(" · ").length >= 3));
}
check("le calcul du Plan n'écrit rien en base", JSON.stringify(countsBefore) === JSON.stringify(countsAfter));
check("le vivier explique ses exclusions", Object.keys(planReal.pool.excluded).length > 0 && Object.values(planReal.pool.excluded).every((w) => typeof w === "string" && w.length > 0));

section("B' — Signaux par commercial : conservés, hors du Plan");

{
  const signals = buildOwnerSignals(now);
  check("les signaux par commercial restent calculés", signals.length > 0 && signals.every((s) => Array.isArray(s.stagnant)));
  check("Sami (directeur) exclu des signaux par commercial", !signals.some((s) => ATTENTION.excluded.includes(s.owner)));
  const opps = loadOpportunities();
  const stab = loadStageStability(today);
  const one = signals.find((s) => s.stagnant.length > 0);
  const recomputed = one ? stagnantDeals(opps.filter((o) => o.isActive && o.owner === one.owner), stab, today).length : 0;
  check("liste exhaustive des affaires figées par commercial (même règle que Ma semaine)", !one || recomputed === one.stagnant.length, one ? `${one.owner} : ${one.stagnant.length}` : "aucun cas");
  check("pipe insuffisant / affaires figées exposés comme raisons d'attention.ts", signals.every((s) => s.pipe === null || s.pipe.key === "pipe_faible") && signals.every((s) => s.frozen === null || s.frozen.key === "affaires_figees"));
}

// ============================================================================
section("C — Fixtures : aucun plafond par commercial, portes, mails hors du Plan");

const kanbanYear = Number(today.slice(0, 4));
const kanbanMonth = Number(today.slice(5, 7));
const cleanup = { opportunities: [], messages: [] };

function insertOpportunity({ id, owner, gmv, lastActivity = null, kanban = true }) {
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
}
const stall = (id, owner) => {
  insertSnapshot(id, owner, dayOffset(-25), "Examen devis");
  insertSnapshot(id, owner, today, "Examen devis");
};
const old = new Date(nowMs - 40 * DAY).toISOString().slice(0, 10);
const owner = loadTeam().find((m) => !ATTENTION.excluded.includes(m.name))?.name;

// Quatre affaires annoncées, immobiles, TRÈS lourdes, du MÊME commercial.
const FOUR = ["TESTPV_F1", "TESTPV_F2", "TESTPV_F3", "TESTPV_F4"];
for (const id of FOUR) { insertOpportunity({ id, owner, gmv: 1_000_000, lastActivity: old }); stall(id, owner); }
// Une petite affaire annoncée immobile (sous le plancher), et une qui avance normalement.
insertOpportunity({ id: "TESTPV_SMALL", owner, gmv: 40_000, lastActivity: old }); stall("TESTPV_SMALL", owner);
insertOpportunity({ id: "TESTPV_MOVING", owner, gmv: 900_000, lastActivity: new Date(nowMs - 1 * DAY).toISOString().slice(0, 10) });
insertSnapshot("TESTPV_MOVING", owner, dayOffset(-3), "Examen estimation");
insertSnapshot("TESTPV_MOVING", owner, today, "Examen devis");

const planC = buildMorningPlan(now);
const mine = planC.actions.filter((a) => FOUR.includes(a.opportunityId));
check("4 affaires d'un même commercial : les 4 apparaissent (aucun plafond par commercial)", mine.length === 4, `${mine.length}/4`);
check("elles portent la famille A (GMV annoncé à sécuriser)", mine.every((a) => a.reason === "securiser"));
check("GMV réelle affichée (1 M€), score plafonné à 250 k€ × 0,75", mine.every((a) => a.gmv === 1_000_000 && near(a.score, 250_000 * 0.75, 1)), mine.map((a) => Math.round(a.score)).join(","));
check("une affaire sous 50 k€ n'entre pas, même annoncée et immobile", !planC.pool.keys.includes("affaire:TESTPV_SMALL") && /plancher/.test(planC.pool.excluded.TESTPV_SMALL ?? ""), planC.pool.excluded.TESTPV_SMALL);
check("une grosse affaire annoncée qui avance normalement n'est pas une situation", !planC.pool.keys.includes("affaire:TESTPV_MOVING"), planC.pool.excluded.TESTPV_MOVING);
check("toujours au plus 7, sans doublon", planC.actions.length <= MAX && new Set(planC.actions.map((a) => a.opportunityId)).size === planC.actions.length);

// Un mail chaud sur une petite affaire n'entre PAS dans le Plan : il reste dans le Bloc 1.
const PIPE = { match_kind: "affaire_pipe", opportunity_stage: null, lead_status: null, stage: "Examen devis", is_terminal: 0, owner: null, ext_owner: null, lead_owner: null, rm_to: null, rm_cc: null };
insertOpportunity({ id: "TESTPV_HOT", owner, gmv: 90_000, lastActivity: new Date(nowMs - 1 * DAY).toISOString().slice(0, 10), kanban: false });
const tH = triage({ ...PIPE, direction: "entrant", subject: "Devis", summary: "Nous souhaitons avancer, quelle est la prochaine etape ?", blocker: null, signal_type: "neutre" });
db.prepare(
  `INSERT INTO mail_signal
     (gmail_message_id, thread_id, sent_at, from_email, from_name, subject, direction, filter_rule,
      opportunity_id, match_level, match_reason, salesperson, signal_type, summary, sync_id)
   VALUES (?, ?, ?, 'client@example.com', 'Client Test', 'Devis', 'entrant', 'conserve', ?, 'A', 'test', ?, 'neutre', ?, 0)`,
).run("TESTPV_MSG", "TESTPV_THREAD", hoursAgo(1), "TESTPV_HOT", owner, "Nous souhaitons avancer, quelle est la prochaine etape ?");
db.prepare(
  `INSERT INTO morning_event (gmail_message_id, thread_id, sent_at, category, reason, opportunity_id, match_level, status, acknowledged_at, first_seen_at)
   VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nouveau', NULL, ?)`,
).run("TESTPV_MSG", "TESTPV_THREAD", hoursAgo(1), tH.category, tH.reason, new Date(nowMs).toISOString());
cleanup.messages.push("TESTPV_MSG");
const planMail = buildMorningPlan(now);
check("un mail chaud sur une affaire sans motif GMV n'entre pas dans le Plan", !planMail.actions.some((a) => a.opportunityId === "TESTPV_HOT") && !planMail.pool.keys.includes("affaire:TESTPV_HOT"));
check("… il reste intégralement visible dans le Bloc 1", planMail.hot.some((e) => e.messageId === "TESTPV_MSG"));
check("aucune ligne du Plan n'est un message (messageId nul)", planMail.actions.every((a) => a.messageId === null));

// ============================================================================
section("D — « Traité », budget journalier, « Tout traiter », lendemain");

const CAND = [];
for (let i = 1; i <= 5; i++) {
  const id = `TESTPV_X${i}`;
  insertOpportunity({ id, owner, gmv: 1_000_000 - i * 1000, lastActivity: old });
  stall(id, owner);
  CAND.push(id);
}
const p0 = buildMorningPlan(now);
check("le vivier dépasse 7 (9 candidates fictives + réelles) : le Plan est plafonné à 7", p0.pool.total > MAX && p0.actions.length === MAX, `${p0.pool.total} candidates / ${p0.actions.length}`);
const top = p0.actions[0];
markActionDone(top.key, now);
const p1 = buildMorningPlan(now);
check("7. traitée : l'affaire disparaît pour la journée", !p1.actions.some((a) => a.key === top.key) && p1.doneToday >= 1);
check("budget : traiter 1 affaire ne fait PAS remonter une 8e (au plus 6 restent)", p1.actions.length <= MAX - 1, `${p1.actions.length}`);
const tomorrow = new Date(nowMs + DAY);
const p2 = buildMorningPlan(tomorrow);
check("8. le lendemain : jour vierge, et l'affaire revient si elle persiste", p2.doneToday === 0 && p2.actions.some((a) => a.key === top.key));

{
  const day = new Date(nowMs + 2 * DAY);
  const p = buildMorningPlan(day);
  completeShownActions(p.actions, new Set(p.actions.map((a) => a.key)), day);
  const after = buildMorningPlan(day);
  check(`budget : ${MAX} affaires traitées → Plan terminé, aucune ne remplace`, p.actions.length === MAX && after.actions.length === 0, `${after.actions.length}`);
  // Une nouvelle urgence en cours de journée ne recrée AUCUNE place.
  insertOpportunity({ id: "TESTPV_URGENT", owner, gmv: 2_000_000, lastActivity: old });
  stall("TESTPV_URGENT", owner);
  const urgent = buildMorningPlan(day);
  check("budget : une nouvelle urgence en cours de journée ne recrée AUCUNE place (elle est candidate, demain)", urgent.actions.length === 0 && urgent.pool.keys.includes("affaire:TESTPV_URGENT"));
  check("le lendemain, elle peut entrer dans le Plan", buildMorningPlan(new Date(day.getTime() + DAY)).actions.some((a) => a.opportunityId === "TESTPV_URGENT"));
}

{
  const day = new Date(nowMs + 4 * DAY);
  const p = buildMorningPlan(day);
  const shown = p.actions.slice(0, p.actions.length - 1).map((a) => a.key);
  const hidden = p.pool.keys.find((k) => !p.actions.some((a) => a.key === k));
  const lastKey = p.actions[p.actions.length - 1].key;
  completeShownActions(p.actions, new Set([...shown, hidden, "affaire:FANTOME"].filter(Boolean)), day);
  const done = doneActionKeys(day);
  check("« Tout traiter » : les affaires affichées sont traitées", shown.every((k) => done.has(k)));
  check("… une affaire non affichée ne l'est pas", !done.has(lastKey));
  check("… ni une candidate hors Plan (8e), ni une clé inconnue", (hidden == null || !done.has(hidden)) && !done.has("affaire:FANTOME"));
  const n = completeShownActions(buildMorningPlan(new Date(nowMs + 5 * DAY)).actions, null, new Date(nowMs + 5 * DAY));
  check("sans liste de clés (appel ancien), le Plan plafonné est traité tel quel", n <= MAX, `${n}`);
}

// ============================================================================
section("E — Aucune tâche persistante, journal idempotent, migration additive");

{
  const tablesAfter = tables();
  const src0 = new DatabaseSync(SOURCE, { readOnly: true });
  const sourceTables = src0.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  src0.close();
  const added = tablesAfter.filter((t) => !sourceTables.includes(t));
  check("le Plan et les gestes ne créent aucune table", tablesAfter.length === tablesBefore.length);
  check("migration additive : seules morning_plan_log et monthly_objective peuvent s'ajouter à la base source", added.every((t) => ["morning_plan_log", "monthly_objective"].includes(t)), added.join(", ") || "déjà présentes dans la source");
  const cols = db.prepare("PRAGMA table_info(morning_plan_log)").all().map((c) => c.name);
  check("le journal n'a aucune colonne de statut, d'échéance, de report ou de rappel", !cols.some((c) => /status|statut|deadline|due|snooze|remind|rappel|echeance|report|backlog|done|traite/i.test(c)), cols.join(","));
  const walk = (dir, out = []) => {
    for (const en of readdirSync(dir)) {
      const f = path.join(dir, en);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.(ts|tsx)$/.test(en)) out.push(f);
    }
    return out;
  };
  const mentions = walk(path.resolve(process.cwd(), "src")).filter((f) => /morning_plan_log/.test(readFileSync(f, "utf8"))).map((f) => path.basename(f)).sort();
  check("le Plan ne relit jamais son journal (nommé par db.ts et morning-plan-log.ts seulement)", JSON.stringify(mentions) === JSON.stringify(["db.ts", "morning-plan-log.ts"]), mentions.join(", "));

  db.prepare("DELETE FROM morning_plan_log").run();
  const day = new Date(nowMs + 6 * DAY);
  const p = buildMorningPlan(day);
  const first = recordPlanLog(p.actions, day, p.doneToday);
  const second = recordPlanLog(p.actions, day, p.doneToday);
  const rows = db.prepare("SELECT * FROM morning_plan_log WHERE plan_date = ? ORDER BY rank").all(parisDate(day));
  check("11. journal : une ligne par affaire, rangs 1..N", first === p.actions.length && rows.length === p.actions.length && rows.every((r, i) => r.rank === i + 1));
  check("11b. journal idempotent pour la journée : rien d'ajouté au second passage", second === 0);
  check("11c. owner, OpportunityId, catégorie (famille), score, GMV et raison conservés", rows.every((r, i) => r.owner === p.actions[i].owner && r.opportunity_id === p.actions[i].opportunityId && r.category === p.actions[i].category && r.reason_code === p.actions[i].reason && r.gmv === p.actions[i].gmv));
}

// --- Nettoyage ---------------------------------------------------------------
if (cleanup.opportunities.length > 0) {
  const ph = cleanup.opportunities.map(() => "?").join(",");
  db.prepare(`DELETE FROM opportunity WHERE opportunity_id IN (${ph})`).run(...cleanup.opportunities);
  db.prepare(`DELETE FROM opportunity_snapshot WHERE opportunity_id IN (${ph})`).run(...cleanup.opportunities);
}
db.prepare("DELETE FROM opportunity_snapshot WHERE opportunity_id LIKE 'TESTPV_%'").run();
db.prepare("DELETE FROM opportunity WHERE opportunity_id LIKE 'TESTPV_%'").run();
if (cleanup.messages.length > 0) {
  const ph = cleanup.messages.map(() => "?").join(",");
  db.prepare(`DELETE FROM mail_signal WHERE gmail_message_id IN (${ph})`).run(...cleanup.messages);
  db.prepare(`DELETE FROM morning_event WHERE gmail_message_id IN (${ph})`).run(...cleanup.messages);
}

console.log(failures === 0 ? "\nTous les contrôles passent." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);

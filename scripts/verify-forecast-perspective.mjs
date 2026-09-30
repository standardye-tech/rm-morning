/**
 * Perspective ↔ Forecast : réconciliation de bout en bout (décision du 30/09/2026).
 *
 *   npm run forecast:perspective-verify
 *
 * Travaille sur une COPIE de la base (`data/verif/perspective.db`) : la base
 * locale n'est jamais écrite. Quatre affaires fabriquées sont déclarées dans la
 * Perspective du mois courant :
 *
 *   active   — Kanban du mois SUIVANT, 17 k€ Salesforce, 43 k€ déclarés ;
 *   standby  — stand-by jusqu'à une date future ;
 *   terminal — opportunité terminale (abandonnée) ;
 *   signed   — ligne Travaux signée ce mois-ci.
 *
 * Attendu : seule « active » entre dans le Reste annoncé (+43 k€, +1 affaire),
 * elle est visible dans le tableau comme déclarée en Perspective hors Kanban ;
 * « signed » entre dans le signé officiel et pas dans le reste.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "perspective.db");
mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(WORK + suffix, { force: true });
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { buildForecastV2, isVisibleInForecast, isDeclaredOnMonth, forecastChallengers, expectedChallengers } = await import(lib("forecast-v2"));
const { perspectiveAmountNote, perspectiveOffKanbanSituation } = await import(lib("forecast-wording"));
const { parisDate } = await import(lib("business-time"));
const { loadTeam } = await import(lib("team-store"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = getDb();
const today = parisDate();
const before = buildForecastV2(0);
const month = before.month;
const [y, m] = month.split("-").map(Number);
const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
const owner = loadTeam()[0].name;
const importId = db.prepare("SELECT MAX(id) AS id FROM import_run").get().id ?? 1;
const updatedAt = db.prepare("SELECT MAX(updated_at) AS u FROM forecast_current WHERE forecast_month = ?").get(month).u ?? `${today}T08:00`;

const opp = (id, over) =>
  db
    .prepare(
      `INSERT INTO opportunity (opportunity_id, name, client_contact, owner, owner_raw, gmv, stage, kanban_raw, kanban_month, kanban_year,
         is_terminal, is_standby, standby_until, is_active, first_seen_on, last_import_id)
       VALUES (?, ?, ?, ?, ?, ?, 'Examen devis', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, `Test ${id}`, `Client ${id}`, owner, owner, over.gmv, over.kanbanRaw, over.km, over.ky, over.terminal ? 1 : 0, over.standbyUntil ? 1 : 0, over.standbyUntil ?? null, today, importId);
const persp = (id, gmv) =>
  db
    .prepare(
      `INSERT INTO forecast_current (forecast_month, row_key, opportunity_id, salesperson, salesperson_raw, opportunity_label, confidence, gmv, projected_gmv, state, updated_at, source, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.5, ?, ?, NULL, ?, 'verif', ?)`,
    )
    .run(month, id, id, owner, owner, `Test ${id}`, gmv, gmv * 0.5, updatedAt, new Date().toISOString());

opp("TESTP0ACTIVE000", { gmv: 17_000, kanbanRaw: "octobre", km: next.m, ky: next.y });
opp("TESTP0STANDBY00", { gmv: 20_000, kanbanRaw: null, km: null, ky: null, standbyUntil: "2099-12-31" });
opp("TESTP0TERMINAL0", { gmv: 25_000, kanbanRaw: null, km: null, ky: null, terminal: true });
opp("TESTP0SIGNED000", { gmv: 30_000, kanbanRaw: null, km: null, ky: null });
persp("TESTP0ACTIVE000", 43_000);
persp("TESTP0STANDBY00", 20_000);
persp("TESTP0TERMINAL0", 25_000);
persp("TESTP0SIGNED000", 30_000);
db.prepare(
  `INSERT INTO travaux (travaux_id, opportunity_id, opportunity_name, owner_raw, signature_date, gmv, works_type, works_status, first_seen_at, last_import_at)
   VALUES ('TESTTRAVAUX0001', 'TESTP0SIGNED000', 'Test signée', ?, ?, 30000, 'ORIGINAL', 'Signé', ?, ?)`,
).run(owner, `${month}-${String(Math.min(Number(today.slice(8, 10)), 28)).padStart(2, "0")}`, new Date().toISOString(), new Date().toISOString());

const after = buildForecastV2(0);
const status = new Map(after.perspectiveLines.map((l) => [l.opportunityId, l.status]));
console.log(`\nPerspective ${month} — commercial ${owner}`);
check("statuts : active / standby / terminal / signed", ["active", "standby", "terminal", "signed"].every((s, i) =>
  status.get(["TESTP0ACTIVE000", "TESTP0STANDBY00", "TESTP0TERMINAL0", "TESTP0SIGNED000"][i]) === s),
  [...status].filter(([k]) => k?.startsWith("TESTP0")).map(([k, v]) => `${k.slice(6, 13)}=${v}`).join(", "));
check("Reste annoncé : +43 000 € exactement (seule l'affaire active)", Math.abs(after.region.declaredOpenGmv - before.region.declaredOpenGmv - 43_000) < 0.01,
  `${before.region.declaredOpenGmv} → ${after.region.declaredOpenGmv}`);
check("compteur des affaires annoncées : +1", after.region.declaredOpenCount === before.region.declaredOpenCount + 1);
check("signée : +30 000 € dans le signé officiel, rien dans le reste", Math.abs(after.region.signedGmvActual - before.region.signedGmvActual - 30_000) < 0.01);
check("atterrissage = signé + reste", Math.abs(after.region.commercialLanding - after.region.signedGmvActual - after.region.declaredOpenGmv) < 0.01);

const row = after.salespeople.flatMap((s) => s.opportunities).find((r) => r.opportunityId === "TESTP0ACTIVE000");
check("Perspective du mois + Kanban du mois suivant : une ligne existe", !!row);
if (row) {
  check("… visible dans Forecast", isVisibleInForecast(row, month, today));
  check("… comme déclarée sur le mois (Perspective)", isDeclaredOnMonth(row, month) && row.perspectiveMonth === month);
  check("… restée hors Kanban du mois (pas transformée en projection Kanban)", row.outsideKanban && row.kanbanMonth === `${next.y}-${String(next.m).padStart(2, "0")}`);
  check("… identifiée « hors Kanban du mois »", perspectiveOffKanbanSituation(row, month)?.label === "Déclarée en Perspective, hors Kanban du mois");
  check("… GMV Salesforce principal, montant déclaré en second niveau", row.gmv === 17_000 && perspectiveAmountNote(row, month) === "Perspective déclarée : 43 k€", perspectiveAmountNote(row, month));
  const challenged = [...forecastChallengers(after), ...expectedChallengers(after)].some((e) => e.row.opportunityId === "TESTP0ACTIVE000");
  check("… jamais proposée « à challenger » : elle est déjà annoncée", !challenged);
}
const hidden = ["TESTP0STANDBY00", "TESTP0TERMINAL0"].filter((id) => after.salespeople.flatMap((s) => s.opportunities).some((r) => r.opportunityId === id && isVisibleInForecast(r, month, today)));
check("stand-by et abandonnée : ni comptées ni affichées", hidden.length === 0, hidden.join(", ") || "aucune");
check("exclusions signalées dans les remarques du périmètre", after.issues.some((i) => /stand-by ou abandonnée/.test(i)));

db.close?.();
console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles de cohérence du Forecast V1.
 *
 *   node --experimental-strip-types --experimental-loader ./scripts/ts-resolver.mjs \
 *        --env-file=.env.local scripts/verify-forecast-board.mjs
 *
 * Les dix contrôles exigés avant toute construction d'interface. Chacun est
 * chiffré et son écart toléré est nul, sauf mention explicite.
 *
 * LECTURE SEULE : aucune écriture, aucun appel réseau.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { buildForecastBoard, shiftMonth, MOVEMENT_LABEL } = await import(lib("forecast-board"));
const { TEAM } = await import(lib("config"));
const { loadOpportunities } = await import(lib("repository"));

const eur = (v) => `${Math.round((v ?? 0) / 1000)} k€`;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const M = buildForecastBoard(0);
const M1 = buildForecastBoard(1);

console.log(`\n════ DONNÉES M — ${M.monthLabel} (${M.month}) ════`);
console.log(`  dernière mise à jour   : ${M.updatedAt ? new Date(M.updatedAt).toLocaleString("fr-FR") : "—"}`);
console.log(`  Perspective utilisée   : ${M.perspectiveDate ?? "aucune"}`);
console.log(`  Signé ${M.month}          : ${M.region.signedCount} affaires · ${eur(M.region.signedGmv)}`);
console.log(`  Projection Kanban restante : ${M.region.count} affaires · ${eur(M.region.kanbanGmv)}`);
console.log(`  Signé + Projection Kanban  : ${eur(M.region.signedPlusKanban)}`);
console.log(`  Perspective (lignes matchées) : ${eur(M.region.perspectiveGmv)}`);
console.log(`  Objectif régional      : ${M.region.objective == null ? "non configuré" : eur(M.region.objective)}`);

console.log(`\n──── PAR COMMERCIAL — ${M.month} ────`);
console.log(`  ${"Commercial".padEnd(22)}${"opps".padStart(5)}${"Kanban M".padStart(11)}${"Perspective".padStart(13)}${"Signé M".padStart(10)}`);
for (const s of M.salespeople) {
  console.log(
    `  ${s.salesperson.padEnd(22)}${String(s.count).padStart(5)}${eur(s.kanbanGmv).padStart(11)}${eur(s.perspectiveGmv).padStart(13)}${eur(s.signedGmv).padStart(10)}`,
  );
}
console.log(
  `  ${"TOTAL RÉGION".padEnd(22)}${String(M.region.count).padStart(5)}${eur(M.region.kanbanGmv).padStart(11)}${eur(M.region.perspectiveGmv).padStart(13)}${eur(M.region.signedGmv).padStart(10)}`,
);

console.log(`\n──── CONTRÔLES M ────`);

// 1. Région ↔ commerciaux
const sumCount = M.salespeople.reduce((s, p) => s + p.count, 0);
const sumKanban = M.salespeople.reduce((s, p) => s + p.kanbanGmv, 0);
const sumPersp = M.salespeople.reduce((s, p) => s + p.perspectiveGmv, 0);
const sumSigned = M.salespeople.reduce((s, p) => s + p.signedGmv, 0);
check("1a. Σ opportunités commerciaux = Région", sumCount === M.region.count, `${sumCount} vs ${M.region.count}`);
check("1b. Σ Kanban commerciaux = Région", sumKanban === M.region.kanbanGmv, `écart ${sumKanban - M.region.kanbanGmv} €`);
check("1c. Σ Perspective commerciaux = Région", sumPersp === M.region.perspectiveGmv, `écart ${sumPersp - M.region.perspectiveGmv} €`);
check("1d. Σ Signé commerciaux = Région", sumSigned === M.region.signedGmv, `écart ${sumSigned - M.region.signedGmv} €`);

// 2. Commercial ↔ opportunités
let ownerMismatch = 0;
for (const s of M.salespeople) {
  const gmv = s.opportunities.reduce((t, r) => t + (r.gmv ?? 0), 0);
  const persp = s.opportunities.reduce((t, r) => t + (r.perspectiveGmv ?? 0), 0);
  if (gmv !== s.kanbanGmv || persp !== s.perspectiveGmv || s.opportunities.length !== s.count) {
    ownerMismatch += 1;
    console.log(`        ${s.salesperson} : ${gmv} vs ${s.kanbanGmv}`);
  }
}
check("2. Σ opportunités = sous-total, pour chaque commercial", ownerMismatch === 0, `${M.salespeople.length} commerciaux vérifiés`);

// 3. Double comptage
const ids = M.salespeople.flatMap((s) => s.opportunities.map((o) => o.opportunityId));
const dupes = ids.length - new Set(ids).size;
check("3. aucun doublon d'Opportunity ID", dupes === 0, `${dupes} doublon(s)`);

// 4. Signé vs forecast restant
const opportunities = loadOpportunities();
const signedIds = new Set(
  opportunities.filter((o) => o.isSigned && (o.quoteSignatureDate ?? "").slice(0, 7) === M.month).map((o) => o.opportunityId),
);
const overlap = ids.filter((id) => signedIds.has(id));
check("4. aucune affaire signée dans le forecast restant", overlap.length === 0, `${overlap.length} intersection(s)`);

// 5. M et M+1 disjoints
const idsNext = new Set(M1.salespeople.flatMap((s) => s.opportunities.map((o) => o.opportunityId)));
const crossover = ids.filter((id) => idsNext.has(id));
check("5. M et M+1 disjoints", crossover.length === 0, `${crossover.length} intersection(s)`);

// 6. Couverture Perspective
const matched = M.salespeople.flatMap((s) => s.opportunities).filter((o) => o.perspectiveMonth === M.month).length;
console.log(
  `  info  6. Perspective M : ${M.region.count} opportunités Kanban · ${matched} matchées · ${M.region.count - matched} non matchées · couverture ${M.region.count ? Math.round((matched / M.region.count) * 100) : 0} %`,
);

// 7. Total Google Sheet
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const sheet = M.perspectiveDate
  ? db.prepare("SELECT COUNT(*) n, SUM(projected_gmv) g FROM forecast_snapshot WHERE forecast_month=? AND snapshot_date=?").get(M.month, M.perspectiveDate)
  : null;
db.close();
if (sheet) {
  console.log(
    `  info  7. Sheet ${M.perspectiveDate} : ${sheet.n} lignes · ${eur(sheet.g)} projeté — RM Morning n'en retient que les ${matched} lignes rattachées à une opportunité encore projetée sur ${M.month} (${eur(M.region.perspectiveGmv)}). L'écart est la part non rattachée ou sortie du mois.`,
  );
}

// 8. Équipe
const teamNames = new Set(TEAM.map((m) => m.name));
const outsiders = M.salespeople.filter((s) => !teamNames.has(s.salesperson));
check("8. aucun commercial hors équipe", outsiders.length === 0, `${TEAM.length} membres configurés`);

// 9. Stand-by
const standbyInBoard = M.salespeople.flatMap((s) => s.opportunities).filter((o) => o.isStandby);
check("9. aucun stand-by dans le total forecast", standbyInBoard.length === 0, "sémantique existante préservée");

// 10. Valeurs nulles
const rows = M.salespeople.flatMap((s) => s.opportunities);
console.log(`  info  10. GMV manquant : ${rows.filter((r) => r.gmv == null).length} · client manquant : ${rows.filter((r) => !r.client).length}`);
for (const issue of M.issues) console.log(`        anomalie : ${issue}`);

console.log(`\n════ DONNÉES M+1 — ${M1.monthLabel} (${M1.month}) ════`);
console.log(`  Perspective utilisée   : ${M1.perspectiveDate ?? "aucune"}`);
console.log(`  Projection Kanban      : ${M1.region.count} affaires · ${eur(M1.region.kanbanGmv)}`);
console.log(`  Perspective matchée    : ${eur(M1.region.perspectiveGmv)}`);
console.log(`\n  ${"Commercial".padEnd(22)}${"opps".padStart(5)}${"Kanban".padStart(11)}${"Perspective".padStart(13)}`);
for (const s of M1.salespeople) {
  console.log(`  ${s.salesperson.padEnd(22)}${String(s.count).padStart(5)}${eur(s.kanbanGmv).padStart(11)}${eur(s.perspectiveGmv).padStart(13)}`);
}
console.log(`  ${"TOTAL RÉGION".padEnd(22)}${String(M1.region.count).padStart(5)}${eur(M1.region.kanbanGmv).padStart(11)}${eur(M1.region.perspectiveGmv).padStart(13)}`);
const sumNext = M1.salespeople.reduce((s, p) => s + p.kanbanGmv, 0);
check("11. Σ Kanban commerciaux = Région (M+1)", sumNext === M1.region.kanbanGmv, `écart ${sumNext - M1.region.kanbanGmv} €`);

console.log(`\n════ MOUVEMENTS ════`);
const mv = {};
for (const r of rows) mv[r.movement] = (mv[r.movement] ?? 0) + 1;
for (const [k, v] of Object.entries(mv)) console.log(`  ${MOVEMENT_LABEL[k].padEnd(20)} ${v}`);
console.log(`  ${"Sorties du mois".padEnd(20)} ${M.exits.length}`);
for (const e of M.exits) console.log(`      ${e.client.slice(0, 28).padEnd(28)} ${e.owner.padEnd(20)} ${eur(e.perspectiveGmv).padStart(8)} → ${e.destination}`);
console.log(`  candidats à examiner pour M (Kanban ${shiftMonth(M.month, 1)}, très avancés) : ${M.candidates.length}`);
for (const c of M.candidates) console.log(`      ${c.client.slice(0, 28).padEnd(28)} ${c.owner.padEnd(20)} ${eur(c.gmv).padStart(8)} ${c.stage}`);

console.log(`\n  ${failures === 0 ? "Tous les contrôles bloquants passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Contrôles de cohérence EC1 → EC9 du scoring Expected GMV.
 *
 *   node --experimental-strip-types --experimental-loader ./scripts/ts-resolver.mjs \
 *        scripts/verify-expected-gmv.mjs
 *
 * Exécutés hors interface, avant toute construction d'écran : si une identité
 * est fausse ici, aucun affichage ne la rendra vraie.
 *
 * LECTURE SEULE.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { loadTeam } = await import(lib("team-store"));
const TEAM = loadTeam();

const eur = (v) => `${(v ?? 0).toFixed(2)} €`;
const kEur = (v) => `${Math.round((v ?? 0) / 1000).toLocaleString("fr-FR")} k€`;

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const snap = buildExpectedGmvSnapshot();
if (!snap) {
  console.log("\n  Aucun scoring en base. Lancer `npm run expected:score`.\n");
  process.exit(1);
}

console.log(`\n════ SCORING ${snap.month} ════`);
console.log(`  scoré le               : ${new Date(snap.scoredAt).toLocaleString("fr-FR")}`);
console.log(`  version                : ${snap.modelVersion}`);
console.log(`  modèle 7 jours         : ${snap.model7d}`);
console.log(`  modèle fin de mois     : ${snap.modelMonthEnd}`);
console.log(`  état de référence      : ${snap.sourceObservationDate} · au ${snap.asOfDate} · J-${snap.daysLeft}`);
console.log(`  affaires scorées       : ${snap.region.count}`);
console.log(`  GMV ouvert             : ${kEur(snap.region.openGmv)}`);
console.log(`  Expected 7 jours       : ${kEur(snap.region.expected7d)}`);
console.log(`  Signé à date           : ${kEur(snap.region.signedGmv)} (${snap.region.signedCount} affaires)`);
console.log(`  Expected restant       : ${kEur(snap.region.expectedRemaining)}`);
console.log(`  Expected finish        : ${kEur(snap.region.expectedFinish)}`);
console.log(`  P10 / P50 / P90        : ${kEur(snap.region.p10)} / ${kEur(snap.region.p50)} / ${kEur(snap.region.p90)}`);

console.log(`\n──── PAR COMMERCIAL ────`);
console.log(
  `  ${"Commercial".padEnd(24)}${"opps".padStart(5)}${"GMV ouvert".padStart(12)}${"Exp. 7j".padStart(10)}` +
    `${"Exp. f.mois".padStart(13)}${"Signé".padStart(9)}${"Exp. finish".padStart(13)}`,
);
for (const s of snap.salespeople) {
  console.log(
    `  ${s.salesperson.padEnd(24)}${String(s.count).padStart(5)}${kEur(s.openGmv).padStart(12)}` +
      `${kEur(s.expected7d).padStart(10)}${kEur(s.expectedMonthEnd).padStart(13)}` +
      `${kEur(s.signedGmv).padStart(9)}${kEur(s.expectedFinish).padStart(13)}`,
  );
}
console.log(
  `  ${"TOTAL RÉGION".padEnd(24)}${String(snap.region.count).padStart(5)}${kEur(snap.region.openGmv).padStart(12)}` +
    `${kEur(snap.region.expected7d).padStart(10)}${kEur(snap.region.expectedRemaining).padStart(13)}` +
    `${kEur(snap.region.signedGmv).padStart(9)}${kEur(snap.region.expectedFinish).padStart(13)}`,
);

console.log(`\n──── CONTRÔLES ────`);

// EC1 — Σ opportunités = Expected commercial, pour chacun des deux horizons.
let ec1 = 0;
let worst1 = 0;
for (const s of snap.salespeople) {
  const m = s.opportunities.reduce((t, o) => t + o.expectedMonthEnd, 0);
  const w = s.opportunities.reduce((t, o) => t + o.expected7d, 0);
  const g = s.opportunities.reduce((t, o) => t + o.gmv, 0);
  const d = Math.max(
    Math.abs(m - s.expectedMonthEnd),
    Math.abs(w - s.expected7d),
    Math.abs(g - s.openGmv),
  );
  worst1 = Math.max(worst1, d);
  if (d > 1e-6 || s.opportunities.length !== s.count) ec1 += 1;
}
check("EC1. Σ Expected opportunités = Expected commercial", ec1 === 0, `écart max ${eur(worst1)}`);

// EC2 — Σ commerciaux = Région.
const sums = {
  openGmv: snap.salespeople.reduce((t, s) => t + s.openGmv, 0),
  expected7d: snap.salespeople.reduce((t, s) => t + s.expected7d, 0),
  expectedMonthEnd: snap.salespeople.reduce((t, s) => t + s.expectedMonthEnd, 0),
  signedGmv: snap.salespeople.reduce((t, s) => t + s.signedGmv, 0),
  count: snap.salespeople.reduce((t, s) => t + s.count, 0),
};
const worst2 = Math.max(
  Math.abs(sums.openGmv - snap.region.openGmv),
  Math.abs(sums.expected7d - snap.region.expected7d),
  Math.abs(sums.expectedMonthEnd - snap.region.expectedRemaining),
  Math.abs(sums.signedGmv - snap.region.signedGmv),
);
check(
  "EC2. Σ Expected commerciaux = Expected Région",
  worst2 === 0 && sums.count === snap.region.count,
  `écart max ${eur(worst2)} · ${sums.count} opportunités`,
);

// EC3 — identité du finish, Région et chaque commercial.
const d3 = Math.abs(snap.region.expectedFinish - (snap.region.signedGmv + snap.region.expectedRemaining));
const bad3 = snap.salespeople.filter(
  (s) => Math.abs(s.expectedFinish - (s.signedGmv + s.expectedMonthEnd)) > 1e-9,
);
check(
  "EC3. Expected finish = Signé à date + Expected restant",
  d3 === 0 && bad3.length === 0,
  `écart Région ${eur(d3)} · ${bad3.length} commercial(aux) en écart`,
);

// EC4 — aucune affaire terminale, ni déjà signée, dans les scores.
const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });
const terminal = new Set(
  db
    .prepare("SELECT substr(opportunity_id,1,15) k FROM opportunity WHERE is_terminal = 1")
    .all()
    .map((r) => r.k),
);
const signedIds = new Set(
  db
    .prepare("SELECT opportunity_id k FROM expected_gmv_signed WHERE scored_at = ?")
    .all(snap.scoredAt)
    .map((r) => r.k),
);
const inTerminal = snap.opportunities.filter((o) => terminal.has(o.opportunityId));
const inSigned = snap.opportunities.filter((o) => signedIds.has(o.opportunityId));
check(
  "EC4. aucune opportunité terminale ni signée dans les scores",
  inTerminal.length === 0 && inSigned.length === 0,
  `${inTerminal.length} terminale(s) · ${inSigned.length} signée(s)`,
);

// EC5 — unicité.
const ids = snap.opportunities.map((o) => o.opportunityId);
check("EC5. une OpportunityId apparaît une seule fois", ids.length === new Set(ids).size, `${ids.length - new Set(ids).size} doublon(s)`);

// EC6 — probabilités dans [0, 1].
const outOfRange = snap.opportunities.filter(
  (o) => !(o.p7d >= 0 && o.p7d <= 1) || !(o.pMonthEnd >= 0 && o.pMonthEnd <= 1),
);
const p7 = snap.opportunities.map((o) => o.p7d);
const pm = snap.opportunities.map((o) => o.pMonthEnd);
check(
  "EC6. probabilités comprises entre 0 et 1",
  outOfRange.length === 0,
  `p7j ${(Math.min(...p7) * 100).toFixed(2)}–${(Math.max(...p7) * 100).toFixed(1)} % · ` +
    `p fin de mois ${(Math.min(...pm) * 100).toFixed(2)}–${(Math.max(...pm) * 100).toFixed(1)} %`,
);

// EC7 — contribution = montant × probabilité, sauf gel stand-by explicite.
//
// La règle stand-by (C7) met la contribution à zéro quand l'affaire est gelée
// au-delà de l'horizon, sans altérer la probabilité du modèle. Le contrôle doit
// donc connaître cette règle plutôt que d'être assoupli : hors gel, l'égalité
// reste exacte au centime ; sous gel, la contribution doit valoir exactement
// zéro et la probabilité rester non nulle.
let worst7 = 0;
let badFrozen = 0;
for (const o of snap.opportunities) {
  if (o.frozen7d) {
    if (o.expected7d !== 0) badFrozen += 1;
  } else {
    worst7 = Math.max(worst7, Math.abs(o.expected7d - o.gmv * o.p7d));
  }
  if (o.frozenMonthEnd) {
    if (o.expectedMonthEnd !== 0) badFrozen += 1;
  } else {
    worst7 = Math.max(worst7, Math.abs(o.expectedMonthEnd - o.gmv * o.pMonthEnd));
  }
}
const frozenMe = snap.opportunities.filter((o) => o.frozenMonthEnd).length;
const frozen7 = snap.opportunities.filter((o) => o.frozen7d).length;
check(
  "EC7. contribution = montant × probabilité, hors gel stand-by",
  worst7 === 0 && badFrozen === 0,
  `écart max ${eur(worst7)} · ${frozen7} gelée(s) à 7 j · ${frozenMe} gelée(s) fin de mois` +
    ` · ${badFrozen} contribution(s) résiduelle(s)`,
);

// EC13 — la règle stand-by elle-même : toute affaire gelée doit avoir une date
// de réveil postérieure à l'horizon, et toute affaire non gelée soit ne pas
// être en stand-by, soit se réveiller avant l'échéance.
// Dernier jour du mois, calculé sans passer par UTC : `toISOString()` sur une
// date locale ramenait le 31/08 au 30/08 et faisait échouer ce contrôle sur une
// affaire dont le réveil tombe pile le dernier jour.
const monthEnd = (() => {
  const y = Number(snap.month.slice(0, 4));
  const m = Number(snap.month.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  return `${snap.month}-${String(last).padStart(2, "0")}`;
})();
const wrongFreeze = snap.opportunities.filter((o) => {
  const wake = o.standbyUntil?.slice(0, 10) ?? null;
  if (o.frozenMonthEnd) return !o.isStandby || wake == null || wake <= monthEnd;
  return o.isStandby && wake != null && wake > monthEnd;
});
check(
  "EC13. gel stand-by cohérent avec la date de réveil",
  wrongFreeze.length === 0,
  `fin de mois ${monthEnd} · ${snap.standby.count} stand-by · ${wrongFreeze.length} incohérence(s)`,
);

// EC8 — les totaux affichés viennent des valeurs non arrondies. On le vérifie
// en recoupant l'agrégat de l'interface avec celui écrit par le service de
// scoring : deux chemins indépendants, écart attendu nul au centime.
// Le service de scoring n'est autorité que sur ce qu'il calcule : GMV ouvert et
// contributions. Depuis C10 le GMV signé vient des lignes Travaux, source
// officielle de pilotage — comparer les deux ferait échouer ce contrôle de
// 61 615,49 €, qui est précisément l'écart que l'audit a expliqué.
//
// L'interface écarte en outre les affaires dont l'état Salesforce a changé
// depuis la publication : signées, clôturées, ou disparues de la source. Leur
// poids est publié par le service de lecture, et l'identité vérifiée ici est
// donc « affiché + écarté = service ». Sans ce terme, une exclusion parfaitement
// légitime — un dossier abandonné retiré du pipe — serait signalée comme une
// dérive de calcul.
const drift = {
  openGmv: Math.abs(snap.region.openGmv + snap.excluded.openGmv - snap.stored.openGmv),
  expected7d: Math.abs(snap.region.expected7d + snap.excluded.expected7d - snap.stored.expected7d),
  expectedRemaining: Math.abs(
    snap.region.expectedRemaining + snap.excluded.expectedRemaining - snap.stored.expectedRemaining,
  ),
};
const worst8 = Math.max(...Object.values(drift));
check(
  "EC8. agrégats interface + écartés = agrégats du service de scoring",
  worst8 < 0.01,
  `écart max ${eur(worst8)} · ${snap.excluded.count} affaire(s) écartée(s) pour ${eur(snap.excluded.openGmv)} de GMV ouvert`,
);

// EC14 — le GMV signé affiché doit être exactement le GMV officiel du mois.
const { officialSignedGmv } = await import(lib("official-signed"));
const official = officialSignedGmv(snap.month);
const driftSigned = Math.abs(snap.region.signedGmv - official.gmv);
check(
  "EC14. Signé affiché = GMV officiel des lignes Travaux",
  driftSigned < 0.005 && snap.region.signedCount === official.lines,
  `${eur(snap.region.signedGmv)} vs ${eur(official.gmv)} · ${snap.region.signedCount}/${official.lines} lignes`,
);

// EC9 — version et date de scoring toujours disponibles.
check(
  "EC9. version du modèle et date de scoring présentes",
  Boolean(snap.modelVersion && snap.scoredAt && snap.model7d && snap.modelMonthEnd),
  `${snap.modelVersion} · ${snap.scoredAt}`,
);

// Contrôles complémentaires, non exigés mais utiles.
const teamNames = new Set(TEAM.map((m) => m.name));
const outsiders = snap.salespeople.filter((s) => !teamNames.has(s.salesperson));
check("EC10. aucun commercial hors équipe configurée", outsiders.length === 0, outsiders.map((s) => s.salesperson).join(", ") || `${TEAM.length} membres`);

const rel = snap.reliability ?? {};
check(
  "EC11. métriques de fiabilité disponibles (V1.2, jamais V1.1)",
  Boolean(rel.month_end && rel.seven_days && rel.backtest?.length),
  `backtest ${rel.backtest?.length ?? 0} snapshots · fin de mois ${rel.month_end?.model ?? "—"}`,
);

// EC12 — les modalités catégorielles servies au modèle doivent exister dans le
// vocabulaire d'apprentissage. Sans ce contrôle, une valeur inconnue ne lève
// aucune erreur : l'encodeur la range dans le panier des modalités rares et la
// prédiction se dégrade en silence. C'est ce qui s'est produit lorsque le
// scoring lisait les libellés traduits de la table opportunity là où le dataset
// porte les codes d'API Salesforce.
const vocabulary = (column) =>
  new Set(
    db
      .prepare(`SELECT DISTINCT ${column} v FROM expected_gmv_observation WHERE ${column} IS NOT NULL`)
      .all()
      .map((r) => String(r.v)),
  );
const today = db.prepare("SELECT * FROM expected_gmv_today").all();
let unknown = 0;
const samples = [];
for (const column of ["acquisition_channel", "lead_source", "service", "stage"]) {
  const known = vocabulary(column);
  for (const row of today) {
    const value = row[column];
    if (value != null && !known.has(String(value))) {
      unknown += 1;
      if (samples.length < 5) samples.push(`${column}="${value}"`);
    }
  }
}
check(
  "EC12. modalités connues du vocabulaire d'apprentissage",
  unknown === 0,
  unknown === 0
    ? `${today.length} affaires × 4 colonnes vérifiées`
    : `${unknown} valeur(s) inconnue(s) : ${samples.join(", ")}`,
);

if (snap.issues.length > 0) {
  console.log(`\n  anomalies signalées par le service de lecture :`);
  for (const i of snap.issues) console.log(`      ${i}`);
}

db.close();
console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

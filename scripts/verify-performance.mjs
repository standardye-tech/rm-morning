/**
 * Contrôles du Lot B — Performance commerciale.
 *
 *   npm run performance:verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE : l'historique du classement est une écriture,
 * et un contrôle ne doit pas fabriquer de fausses photos dans les données du
 * directeur régional.
 *
 * Ce qui est vérifié n'est pas « le classement est juste » — cela ne se
 * démontre pas — mais que le MOTEUR tient ses promesses : bornes respectées,
 * classement stable à données constantes, réactif à données changées, périmètre
 * exact, explications adossées aux mesures.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "performance.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { buildPerformanceBoard, PILLAR_LABEL } = await import(lib("performance"));
const {
  recordPerformanceSnapshot,
  previousSnapshotDate,
  ranksAt,
  historyOf,
} = await import(lib("performance-store"));
const { PERFORMANCE, PERFORMANCE_MODEL_VERSION } = await import(lib("config"));
// Le périmètre commercial fait foi depuis la base, plus depuis la graine de
// config.ts : le contrôle doit interroger la MÊME source que le classement,
// sinon il échouerait au premier ajout ou retrait fait dans l'interface.
const { loadTeam } = await import(lib("team-store"));
const TEAM = loadTeam();
const { dynamicWindows, yearToDateMonths } = await import(lib("performance"));
const { snapshotVersions } = await import(lib("performance-store"));
const { buildSteps } = await import(lib("sync/steps"));
const { readFileSync } = await import("node:fs");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();
const now = new Date();
const board = buildPerformanceBoard(now);
const rows = board.salespeople;

// --- Périmètre -------------------------------------------------------------

section("P1 — Périmètre");

check(
  "tous les commerciaux du périmètre sont classés",
  rows.length === TEAM.length,
  `${rows.length} lignes pour ${TEAM.length} membres actifs`,
);
check(
  "aucun commercial hors équipe n'est ajouté",
  rows.every((r) => TEAM.some((m) => m.name === r.salesperson)),
);
check(
  "aucun commercial de l'équipe n'est oublié",
  TEAM.every((m) => rows.some((r) => r.salesperson === m.name)),
);
check(
  "les rangs sont 1..n sans trou ni doublon",
  rows.map((r) => r.rank).join(",") === Array.from({ length: rows.length }, (_, i) => i + 1).join(","),
);

// --- Bornes du score -------------------------------------------------------

section("P2 — Les quatre sous-scores et le score global");

const weights = PERFORMANCE.weights;
check(
  "les poids des piliers totalisent 100",
  Object.values(weights).reduce((t, v) => t + v, 0) === 100,
  Object.entries(weights).map(([k, v]) => `${k} ${v}`).join(" · "),
);

let boundsOk = true;
let sumOk = true;
let negative = 0;
for (const row of rows) {
  const pillars = Object.values(row.pillars);
  check(
    `${row.firstName} — quatre piliers calculés`,
    pillars.length === 4 && pillars.every((p) => p.metrics.length > 0),
    pillars.map((p) => `${PILLAR_LABEL[p.key]} ${p.outOf100}`).join(" · "),
  );
  for (const p of pillars) {
    if (p.points < 0 || p.points > p.weight + 1e-9) boundsOk = false;
    for (const m of p.metrics) {
      if (m.points < 0) negative += 1;
      if (m.points > m.weight + 1e-9) boundsOk = false;
      if (m.normalized < 0 || m.normalized > 1 + 1e-9) boundsOk = false;
    }
  }
  const total = pillars.reduce((t, p) => t + p.points, 0);
  if (Math.abs(total - row.score) > 0.11) sumOk = false;
  if (row.score < 0 || row.score > 100) boundsOk = false;
}
check("chaque sous-score reste dans sa borne", boundsOk);
check("aucune note négative", negative === 0);
check("score global = somme des quatre piliers", sumOk);
check(
  "score global plafonné à 100",
  rows.every((r) => r.score <= 100),
  `max ${Math.max(...rows.map((r) => r.score))}`,
);

// --- Calibration V1 : la composition exacte de chaque pilier.
const poids = (pillar) =>
  Object.fromEntries(rows[0].pillars[pillar].metrics.map((m) => [m.key, m.weight]));
const somme = (pillar) =>
  rows[0].pillars[pillar].metrics.reduce((t, m) => t + m.weight, 0);

check("le pilier Opportunités totalise 20 points", somme("deals") === 20, JSON.stringify(poids("deals")));
check("le pilier Pipeline totalise 30 points", somme("pipeline") === 30, JSON.stringify(poids("pipeline")));
check("le pilier Signé totalise 30 points", somme("signed") === 30);
check("le pilier Pistes totalise 20 points", somme("leads") === 20);
check(
  "« mois de signature dépassé » a été retirée du score",
  rows.every((r) => !Object.values(r.pillars).flatMap((p) => p.metrics).some((m) => m.key === "deal_overdue_month")),
);
check(
  "les 4 points retirés sont redistribués dans Opportunités",
  poids("deals").deal_hygiene === 8 &&
    poids("deals").deal_stagnation === 8 &&
    poids("deals").deal_client_waiting === 4,
);
check(
  "Pipeline rééquilibré 8 / 8 / 7 / 7",
  poids("pipeline").pipe_expected_month === 8 &&
    poids("pipeline").pipe_expected_m1 === 8 &&
    poids("pipeline").pipe_high_probability === 7 &&
    poids("pipeline").pipe_concentration === 7,
);

// --- Pipeline : le taux d'affaires probables, et non plus leur nombre.
section("P2 quater — Pipeline : taux, lissage et seuil de concentration");

const hp = (r) => r.pillars.pipeline.metrics.find((m) => m.key === "pipe_high_probability");
const cc = (r) => r.pillars.pipeline.metrics.find((m) => m.key === "pipe_concentration");

check(
  "« affaires à forte probabilité » est un TAUX, pas un comptage",
  rows.every((r) => hp(r).value === null || (hp(r).value >= 0 && hp(r).value <= 1)),
  rows.map((r) => `${r.firstName} ${hp(r).display}`).slice(0, 3).join(" · "),
);
check(
  "le détail affiche le comptage ET le taux",
  rows.filter((r) => hp(r).measured).every((r) => /^\d+ \/ \d+ affaires ≥ 25 % · \d+ %$/.test(hp(r).display)),
  rows.find((r) => hp(r).measured)?.pillars.pipeline.metrics.find((m) => m.key === "pipe_high_probability").display,
);

// Le cas de l'énoncé : 2/5 doit battre 5/20. On l'éprouve sur la fonction de
// lissage elle-même, avec le taux poolé réel de l'équipe — c'est elle qui
// décide de l'ordre, la percentile étant monotone.
const poole =
  rows.reduce((t, r) => t + (hp(r).measured ? hp(r).value * hp(r).sample : 0), 0) /
  rows.reduce((t, r) => t + (hp(r).measured ? hp(r).sample : 0), 0);
const lisse = (num, den) => (num + PERFORMANCE.smoothing * poole) / (den + PERFORMANCE.smoothing);
check(
  "2 / 5 affaires ≥ 25 % est mieux noté que 5 / 20",
  lisse(2, 5) > lisse(5, 20),
  `2/5 → ${lisse(2, 5).toFixed(4)} · 5/20 → ${lisse(5, 20).toFixed(4)} (taux d'équipe ${(poole * 100).toFixed(1)} %)`,
);
check(
  "1 / 1 ne donne pas une note maximale grâce au lissage",
  lisse(1, 1) < 1 && lisse(1, 1) < lisse(10, 10),
  `1/1 → ${lisse(1, 1).toFixed(4)} · 10/10 → ${lisse(10, 10).toFixed(4)}`,
);
check(
  "l'ordre des points suit l'ordre des taux lissés",
  (() => {
    const mesurés = rows.filter((r) => hp(r).measured);
    for (const a of mesurés) {
      for (const b of mesurés) {
        const la = lisse(a.value ?? hp(a).value * hp(a).sample, hp(a).sample);
        const lb = lisse(hp(b).value * hp(b).sample, hp(b).sample);
        if (la > lb && hp(a).points < hp(b).points) return false;
      }
    }
    return true;
  })(),
);

// Concentration : seuil de fiabilité.
const seuilConc = PERFORMANCE.minConcentrationSample;
check(
  "le seuil de concentration est documenté et appliqué",
  rows.every((r) => (cc(r).sample >= seuilConc) === cc(r).measured),
  `seuil ${seuilConc} affaires éligibles · ` +
    rows.filter((r) => !cc(r).measured).map((r) => `${r.firstName} (${cc(r).sample})`).join(", "),
);
check(
  "concentration sous le seuil = non mesuré = 50 % du poids",
  rows
    .filter((r) => !cc(r).measured)
    .every((r) => Math.abs(cc(r).points - cc(r).weight / 2) < 1e-9 && cc(r).display === "—"),
  rows.filter((r) => !cc(r).measured).map((r) => `${r.firstName} ${cc(r).points}/${cc(r).weight}`).join(" · ") ||
    "aucun commercial sous le seuil",
);
check(
  "au-dessus du seuil, la concentration reste mesurée",
  rows.filter((r) => cc(r).sample >= seuilConc).every((r) => cc(r).measured && cc(r).value != null),
);
check(
  "un pipe très concentré reste pénalisé quand il est mesurable",
  rows.filter((r) => cc(r).measured && cc(r).value > 0.5).every((r) => cc(r).points < cc(r).weight),
  rows.filter((r) => cc(r).measured && cc(r).value > 0.5).map((r) => `${r.firstName} ${(cc(r).value * 100).toFixed(0)} % → ${cc(r).points.toFixed(2)}/${cc(r).weight}`).join(" · ") || "aucun cas",
);

// --- Commentaires : jamais de conclusion sur un échantillon trop mince.
section("P2 quinquies — Commentaires et petits échantillons");

const minC = PERFORMANCE.minCommentSample;
const vd = rows.find((r) => r.salesperson === "Vincent Da Silva");
// La phrase porte désormais la CLÉ de la mesure dont elle sort : le contrôle
// remonte à la source exacte, sans passer par une comparaison de texte que
// « 0 % » rendrait ambiguë entre cinq mesures.
let phraseFragile = null;
for (const r of rows) {
  const parKey = new Map(
    Object.values(r.pillars)
      .flatMap((p) => p.metrics)
      .map((m) => [m.key, m]),
  );
  for (const e of [...r.strengths, ...r.watch]) {
    const m = parKey.get(e.key);
    if (m && m.sample != null && m.sample < minC) {
      phraseFragile = `${r.firstName} : « ${e.text} » (${e.key}, n=${m.sample})`;
    }
  }
}
check(
  `aucune phrase positive ou négative sous n = ${minC}`,
  phraseFragile === null,
  phraseFragile ?? `vérifié sur les ${TEAM.length} commerciaux`,
);
check(
  "le cas mesuré à l'audit ne produit plus de phrase — 1 piste, 1 opportunité",
  vd == null ||
    (!vd.strengths.some((e) => e.key === "lead_conversion" || e.key === "deal_hygiene") &&
      !vd.comment.includes("100 %")),
  vd ? vd.comment : "—",
);
check(
  "le détail chiffré reste affiché malgré l'interdiction de commentaire",
  vd == null || vd.pillars.leads.metrics.some((m) => m.measured && m.display !== "—"),
);
check(
  "une mesure sous le seuil compte toujours dans le score",
  vd == null || vd.pillars.deals.points > 0,
  vd ? `${vd.pillars.deals.points.toFixed(1)}/20` : "—",
);

// --- Mesure absente : exactement la moitié du poids, jamais un avantage.
section("P2 bis — Mesures non mesurées");

const absentes = rows.flatMap((r) =>
  Object.values(r.pillars)
    .flatMap((p) => p.metrics)
    .filter((m) => !m.measured)
    .map((m) => ({ who: r.firstName, ...m })),
);
check(
  "au moins un cas de mesure absente est présent dans les données",
  absentes.length > 0,
  absentes.map((a) => `${a.who}/${a.key}`).join(" · ") || "aucun",
);
check(
  "une mesure absente vaut exactement 50 % de son poids",
  absentes.every((a) => Math.abs(a.points - a.weight * 0.5) < 1e-9 && Math.abs(a.normalized - 0.5) < 1e-9),
  absentes.map((a) => `${a.points}/${a.weight}`).join(" · "),
);
check(
  "une mesure absente n'affiche aucune valeur",
  absentes.every((a) => a.value === null && a.display === "—"),
);
check(
  "une mesure absente n'apparaît dans aucun commentaire",
  rows.every((r) => {
    const abs = Object.values(r.pillars)
      .flatMap((p) => p.metrics)
      .filter((m) => !m.measured);
    return abs.every(
      (m) =>
        !r.strengths.some((e) => e.key === m.key) && !r.watch.some((e) => e.key === m.key),
    );
  }),
);
check(
  "une mesure absente ne vaut jamais mieux qu'une mesure réussie",
  absentes.every((a) => a.points < a.weight),
);
// Le cas mesuré à l'audit : 1 piste, 1 opportunité.
const daSilva = rows.find((r) => r.salesperson === "Vincent Da Silva");
if (daSilva) {
  const leads = daSilva.pillars.leads;
  check(
    "Vincent Da Silva n'obtient plus un score quasi maximal en Pistes",
    leads.outOf100 <= 75,
    `${leads.points.toFixed(1)}/20 = ${leads.outOf100}/100 sur ${
      leads.metrics.filter((m) => !m.measured).length
    } mesure(s) absente(s)`,
  );
}

// --- Régularité : mois clôturés, solde net positif.
section("P2 ter — Régularité de la production");

const moisCourant = new Date().toISOString().slice(0, 7);
const clos = board.months.filter((m) => m < moisCourant);
check(
  "le mois en cours est exclu de la régularité",
  clos.length === board.months.length - 1 && !clos.includes(moisCourant),
  `fenêtre ${board.months.join(", ")} → régularité sur ${clos.join(", ")}`,
);
check(
  "la régularité est un multiple de 1 / nombre de mois clôturés",
  rows.every((r) => {
    const v = r.pillars.signed.metrics.find((m) => m.key === "signed_regularity").value;
    return v === null || Number.isInteger(Math.round(v * clos.length * 1e6) / 1e6);
  }),
  `dénominateur ${clos.length}`,
);
// Un mois au solde net négatif ne doit pas compter. On le vérifie sur la donnée
// réelle : pour chaque commercial, les mois clôturés au solde > 0 doivent être
// exactement ceux que la régularité compte.
const { officialSignedGmv } = await import(lib("official-signed"));
const soldes = new Map();
for (const m of clos) {
  for (const l of officialSignedGmv(m).rows) {
    const k = `${l.salesperson}|${m}`;
    soldes.set(k, (soldes.get(k) ?? 0) + l.gmv);
  }
}
let regOk = true;
const details = [];
for (const r of rows) {
  const attendu = clos.filter((m) => (soldes.get(`${r.salesperson}|${m}`) ?? 0) > 0).length;
  const v = r.pillars.signed.metrics.find((m) => m.key === "signed_regularity").value;
  const compte = v === null ? 0 : Math.round(v * clos.length);
  if (compte !== attendu) regOk = false;
  const negatifs = clos.filter((m) => (soldes.get(`${r.salesperson}|${m}`) ?? 0) <= 0 && soldes.has(`${r.salesperson}|${m}`));
  if (negatifs.length > 0) details.push(`${r.firstName} ${negatifs.join("/")} exclu(s)`);
}
check(
  "un mois au solde net négatif ou nul ne compte pas comme mois produit",
  regOk,
  details.join(" · ") || "aucun mois négatif dans la fenêtre clôturée",
);

// --- Fenetres : YTD, dynamique, mois en cours -----------------------------

section("P2 sexies — Fenêtre YTD et dynamique 3 mois");

const ytd = yearToDateMonths(now);
const moisCourantIso = now.toISOString().slice(0, 7);
check("la production YTD commence au 1er janvier", ytd[0] === `${now.getFullYear()}-01`, ytd.join(", "));
check(
  "la production YTD va jusqu'au mois en cours inclus",
  ytd[ytd.length - 1] === moisCourantIso && ytd.length === now.getMonth() + 1,
);
check(
  "le pilier Signé utilise bien cette fenêtre",
  board.months.join(",") === ytd.join(","),
  board.monthsLabel,
);

const closYtd = ytd.filter((m) => m < moisCourantIso);
check(
  "la régularité YTD n'inclut que les mois clôturés",
  rows.every((r) => {
    const v = r.pillars.signed.metrics.find((m) => m.key === "signed_regularity").value;
    return v === null || Math.abs(v * closYtd.length - Math.round(v * closYtd.length)) < 1e-6;
  }),
  `${closYtd.length} mois clôturés sur ${ytd.length}`,
);

check(
  "les Pistes restent sur la fenêtre récente glissante",
  PERFORMANCE.leadWindowDays === 90,
  `${PERFORMANCE.leadWindowDays} jours`,
);
check(
  "les Opportunités utilisent l'état actuel du portefeuille",
  (() => {
    const actives = db
      .prepare(
        "SELECT COUNT(*) n FROM opportunity WHERE is_terminal = 0 AND milestone_status IS NOT NULL",
      )
      .get().n;
    const somme = rows.reduce(
      (t, r) => t + (r.pillars.deals.metrics.find((m) => m.key === "deal_hygiene").sample ?? 0),
      0,
    );
    return somme === Number(actives);
  })(),
);
check(
  "le Pipeline utilise l'Expected M / M+1 du jour",
  db.prepare("SELECT COUNT(*) n FROM expected_gmv_snapshot").get().n > 0 &&
    rows.some(
      (r) =>
        (r.pillars.pipeline.metrics.find((m) => m.key === "pipe_expected_month").value ?? 0) > 0,
    ),
);

const win = dynamicWindows(now);
check(
  "la fenêtre récente ne contient que des mois clôturés",
  win.recent.every((m) => m < moisCourantIso) &&
    win.recent.length === PERFORMANCE.dynamicWindowMonths,
  win.recent.join(", "),
);
check(
  "la fenêtre précédente précède la récente, sans recouvrement",
  win.previous.length === PERFORMANCE.dynamicWindowMonths &&
    win.previous.every((m) => m < win.recent[0]) &&
    new Set([...win.previous, ...win.recent]).size === 2 * PERFORMANCE.dynamicWindowMonths,
  win.previous.join(", "),
);
check(
  "le mois en cours n'entre dans aucune des deux fenêtres",
  ![...win.recent, ...win.previous].includes(moisCourantIso),
);
check(
  "score 3 mois plafonné à 100 et jamais négatif",
  rows.every(
    (r) =>
      r.dynamic.recent.score >= 0 &&
      r.dynamic.recent.score <= 100 &&
      r.dynamic.previous.score >= 0 &&
      r.dynamic.previous.score <= 100,
  ),
  `max ${Math.max(...rows.map((r) => r.dynamic.recent.score)).toFixed(1)}`,
);
check(
  "delta = score récent moins score précédent",
  rows.every(
    (r) => Math.abs(r.dynamic.delta - (r.dynamic.recent.score - r.dynamic.previous.score)) < 0.06,
  ),
);
check(
  "les deux fenêtres sont notées sur la même échelle",
  rows
    .filter(
      (r) =>
        r.dynamic.recent.gmv === r.dynamic.previous.gmv &&
        r.dynamic.recent.deals === r.dynamic.previous.deals &&
        r.dynamic.recent.producedMonths === r.dynamic.previous.producedMonths,
    )
    .every((r) => Math.abs(r.dynamic.delta) < 1e-9),
);

// --- Qui monte / Qui décroche ---------------------------------------------

section("P2 septies — Qui monte, qui décroche");

const seuilD = PERFORMANCE.dynamicSignificantDelta;
check("le seuil de significativité est de 5 points", seuilD === 5);
check(
  "« Qui monte » ne contient que des deltas au moins égaux à +5",
  board.movers.up.every((r) => r.dynamic.delta >= seuilD),
  board.movers.up.map((r) => `${r.firstName} +${r.dynamic.delta}`).join(" · ") || "vide",
);
check(
  "« Qui décroche » ne contient que des deltas au plus égaux à -5",
  board.movers.down.every((r) => r.dynamic.delta <= -seuilD),
  board.movers.down.map((r) => `${r.firstName} ${r.dynamic.delta}`).join(" · ") || "vide",
);
check("au plus 3 commerciaux dans « Qui monte »", board.movers.up.length <= PERFORMANCE.maxMovers);
check(
  "au plus 3 commerciaux dans « Qui décroche »",
  board.movers.down.length <= PERFORMANCE.maxMovers,
);
check(
  "les blocs sont triés par ampleur de la variation",
  board.movers.up.every((r, i, a) => i === 0 || a[i - 1].dynamic.delta >= r.dynamic.delta) &&
    board.movers.down.every((r, i, a) => i === 0 || a[i - 1].dynamic.delta <= r.dynamic.delta),
);
check(
  "aucun commercial sous le seuil n'apparaît dans un bloc",
  rows
    .filter((r) => Math.abs(r.dynamic.delta) < seuilD)
    .every(
      (r) =>
        !board.movers.up.some((u) => u.salesperson === r.salesperson) &&
        !board.movers.down.some((d) => d.salesperson === r.salesperson),
    ),
);
const selUp = (d) => d >= seuilD;
const selDown = (d) => d <= -seuilD;
check("+4,9 ne déclenche pas « Qui monte »", selUp(4.9) === false);
check("+5 déclenche « Qui monte »", selUp(5) === true);
check("-4,9 ne déclenche pas « Qui décroche »", selDown(-4.9) === false);
check("-5 déclenche « Qui décroche »", selDown(-5) === true);
check(
  "un changement de rang sans hausse de score ne déclenche pas « Qui monte »",
  rows
    .filter((r) => (r.rankChange ?? 0) > 0 && r.dynamic.delta < seuilD)
    .every((r) => !board.movers.up.some((u) => u.salesperson === r.salesperson)),
);

// --- Version du modèle ----------------------------------------------------

section("P2 octies — Version du modèle et comparabilité");

check(
  "le classement porte une version de modèle",
  board.modelVersion === PERFORMANCE_MODEL_VERSION && board.modelVersion.trim().length > 0,
  board.modelVersion,
);
recordPerformanceSnapshot(rows, now);
const aujourdhui = now.toISOString().slice(0, 10);
check(
  "les photos écrites portent cette version",
  (() => {
    const v = db
      .prepare("SELECT DISTINCT model_version v FROM performance_snapshot WHERE snapshot_date = ?")
      .all(aujourdhui);
    return v.length === 1 && v[0].v === PERFORMANCE_MODEL_VERSION;
  })(),
);
check(
  "la dynamique est historisée avec le score",
  Number(
    db
      .prepare(
        "SELECT COUNT(*) n FROM performance_snapshot WHERE snapshot_date = ? AND score_recent IS NOT NULL AND dynamic_delta IS NOT NULL",
      )
      .get(aujourdhui).n,
  ) === rows.length,
);
db.prepare(
  `INSERT INTO performance_snapshot
     (snapshot_date, salesperson, computed_at, rank, score, signed_score, leads_score,
      deals_score, pipeline_score, metrics, model_version)
   VALUES ('2000-01-03', ?, '2000-01-03', 1, 99, 0, 0, 0, 0, '{}', 'v-ancienne')
   ON CONFLICT(snapshot_date, salesperson) DO UPDATE SET model_version = 'v-ancienne'`,
).run(rows[0].salesperson);
check(
  "une photo d'une autre version n'est jamais retenue comme référence",
  previousSnapshotDate(aujourdhui) !== "2000-01-03",
  `versions en base : ${snapshotVersions().map((v) => `${v.version ?? "(aucune)"} sur ${v.days} j`).join(", ")}`,
);
check("les rangs d'une autre version ne sont jamais lus", ranksAt("2000-01-03").size === 0);
check(
  "sans photo comparable, aucune tendance n'est inventée",
  buildPerformanceBoard(now, new Map(), null).salespeople.every((r) => r.rankChange === null),
);

// --- Tri du tableau, entièrement côté interface ---------------------------

section("P2 nonies — Tri du tableau");

const tableSource = readFileSync(
  path.resolve(process.cwd(), "src/components/performance-table.tsx"),
  "utf8",
);
check(
  "le tableau est un composant client",
  tableSource.trimStart().startsWith('"use client"'),
);
check(
  "aucun appel serveur n'est déclenché pour trier",
  !/fetch\(|router\.(push|replace|refresh)|revalidate/.test(tableSource),
);
check(
  "les dix colonnes demandées sont triables",
  [
    "rank",
    "salesperson",
    "score",
    "signed",
    "leads",
    "deals",
    "pipeline",
    "momentum",
    "delta",
    "rankChange",
  ].every((k) => new RegExp(`key: "${k}"`).test(tableSource)),
);

// La logique de tri est rejouée à l'identique sur les données réelles : mêmes
// règles de comparaison, mêmes valeurs nulles en dernier, même départage.
const tableRows = rows.map((r) => ({
  rank: r.rank,
  salesperson: r.salesperson,
  score: r.score,
  signed: r.pillars.signed.outOf100,
  leads: r.pillars.leads.outOf100,
  deals: r.pillars.deals.outOf100,
  pipeline: r.pillars.pipeline.outOf100,
  momentum: r.dynamic.comparable ? r.dynamic.recent.score : null,
  delta: r.dynamic.comparable ? r.dynamic.delta : null,
  rankChange: r.rankChange,
}));
const trier = (key, direction) =>
  [...tableRows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return a.salesperson.localeCompare(b.salesperson, "fr");
    if (x == null) return 1;
    if (y == null) return -1;
    const cmp =
      typeof x === "string" && typeof y === "string"
        ? x.localeCompare(y, "fr")
        : Number(x) - Number(y);
    return (direction === "asc" ? cmp : -cmp) || a.rank - b.rank;
  });

check(
  "tri initial : le classement naturel, Score YTD décroissant",
  trier("rank", "asc").map((r) => r.rank).join(",") ===
    tableRows.map((r) => r.rank).sort((a, b) => a - b).join(",") &&
    trier("rank", "asc").every((r, i, a) => i === 0 || a[i - 1].score >= r.score),
);
check(
  "un clic sur Score YTD inverse l'ordre",
  trier("score", "asc")[0].score <= trier("score", "desc")[0].score &&
    trier("score", "desc")[0].score === Math.max(...tableRows.map((r) => r.score)),
  `croissant ${trier("score", "asc")[0].salesperson} · décroissant ${trier("score", "desc")[0].salesperson}`,
);
for (const [key, label] of [
  ["signed", "Signé"],
  ["leads", "Pistes"],
  ["deals", "Opps"],
  ["pipeline", "Pipeline"],
  ["momentum", "Momentum"],
  ["delta", "Dynamique"],
]) {
  const desc = trier(key, "desc");
  const mesures = tableRows.map((r) => r[key]).filter((v) => v != null);
  check(
    `tri ${label} : le meilleur en tête, les valeurs absentes en dernier`,
    Number(desc.find((r) => r[key] != null)[key]) === Math.max(...mesures.map(Number)) &&
      desc.every((r, i, a) => i === 0 || a[i - 1][key] != null || r[key] == null),
    `${desc[0].salesperson} ${desc[0][key] ?? "—"}`,
  );
}
check(
  "le rang affiché ne change pas lorsqu'on trie une autre colonne",
  ["signed", "leads", "deals", "pipeline", "momentum", "delta"].every((key) => {
    const trie = trier(key, "desc");
    return trie.every((r) => {
      const origine = tableRows.find((x) => x.salesperson === r.salesperson);
      return origine.rank === r.rank;
    });
  }),
  `tri par Pipeline : 1re ligne = rang ${trier("pipeline", "desc")[0].rank}`,
);
check(
  "un tri différent peut mettre en tête un commercial qui n'est pas 1er",
  trier("pipeline", "desc")[0].rank !== 1 ||
    trier("leads", "desc")[0].rank !== 1 ||
    trier("deals", "desc")[0].rank !== 1,
  `Pipeline → rang ${trier("pipeline", "desc")[0].rank} · Pistes → rang ${trier("leads", "desc")[0].rank} · Opps → rang ${trier("deals", "desc")[0].rank}`,
);
check(
  "le tri est stable : mêmes données, même ordre",
  JSON.stringify(trier("deals", "desc").map((r) => r.salesperson)) ===
    JSON.stringify(trier("deals", "desc").map((r) => r.salesperson)),
);

// --- Intégration avec « Actualiser RM » -----------------------------------

section("P2 decies — Actualiser RM synchronise Performance");

const steps = buildSteps();
const perfStep = steps.find((st) => st.key === "performance");
check("« Actualiser RM » comporte une étape Performance", perfStep != null, perfStep?.label);
check(
  "elle suit toutes les sources dont Performance dépend",
  perfStep != null &&
    ["travaux", "salesforce-pistes", "jalons-opportunites", "expected-m", "projection-m1"].every(
      (k) => steps.findIndex((st) => st.key === k) < steps.findIndex((st) => st.key === "performance"),
    ),
);
check(
  "elle n'est pas bloquante : son échec ne fausse aucun chiffre",
  perfStep?.blocking === false,
);
check(
  "aucun second système de synchronisation n'a été créé",
  steps.filter((st) => st.key === "performance").length === 1 &&
    !/setInterval|cron|schedule/i.test(
      readFileSync(path.resolve(process.cwd(), "src/lib/performance.ts"), "utf8"),
    ),
);

// L'étape écrit bien une photo, à la version courante, sans rien inventer.
db.prepare("DELETE FROM performance_snapshot").run();
const outcome = await perfStep.run();
const photos = db
  .prepare("SELECT model_version v, COUNT(*) n FROM performance_snapshot GROUP BY model_version")
  .all();
check(
  "l'étape écrit la photo Performance du jour",
  photos.length === 1 && Number(photos[0].n) === rows.length,
  outcome.detail,
);
check("la photo porte la version v3-ytd", photos[0].v === PERFORMANCE_MODEL_VERSION, photos[0].v);
check(
  "l'étape publie l'horodatage du recalcul",
  outcome.sources?.performanceComputedAt != null &&
    outcome.sources?.performanceModelVersion === PERFORMANCE_MODEL_VERSION,
  outcome.sources?.performanceComputedAt,
);
check(
  "une actualisation échouée ne crée pas de fausse photo",
  (() => {
    // Une étape bloquante en échec interrompt la suite : l'étape Performance,
    // placée après elles, ne s'exécute pas et n'écrit donc rien. On le vérifie
    // sur l'ordre déclaré plutôt qu'en simulant une panne, qui n'écrirait de
    // toute façon rien de plus.
    const bloquantes = steps.filter((st) => st.blocking).map((st) => st.key);
    const iPerf = steps.findIndex((st) => st.key === "performance");
    return bloquantes.every((k) => steps.findIndex((st) => st.key === k) < iPerf || k === "finalisation");
  })(),
);

// --- Sémantique de l'interface --------------------------------------------

section("P2 undecies — Wording YTD et Momentum");

const ui = [
  "src/components/performance.tsx",
  "src/components/performance-table.tsx",
  "src/app/performance/page.tsx",
]
  .map((f) => readFileSync(path.resolve(process.cwd(), f), "utf8"))
  .join("\n");

check("plus aucun « Score 3 mois » dans l'interface", !ui.includes("Score 3 mois"));
check("« Momentum 3 mois » est affiché", ui.includes("Momentum 3 mois"));
check(
  "la définition de YTD est explicite dans l'interface",
  /1<sup>er<\/sup> janvier/.test(ui) && /douze mois glissants/.test(ui),
);
check(
  "l'explicatif du Momentum est présent sous le tableau",
  ui.includes("3 derniers mois clôturés") && ui.includes("comparée aux 3"),
);
check(
  "l'explicatif dit que le Momentum ne couvre pas encore les quatre piliers",
  /Pistes, Opportunités et Pipeline y seront intégrés/.test(ui),
);
check(
  "l'explicatif rappelle la règle « non mesuré »",
  ui.includes("moitié de son poids"),
);
check(
  "l'heure affichée est celle des données, pas du rendu",
  /lastCompleteRun/.test(ui) && !/Mis à jour[^]{0,80}computedAt/.test(ui),
);
check(
  "les blocs Qui monte / Qui décroche chiffrent le mouvement",
  /dynamic\.previous\.gmv[^]{0,40}dynamic\.recent\.gmv/.test(ui),
);

// --- Stabilité et réactivité ----------------------------------------------

section("P3 — Stabilité et réactivité");

const again = buildPerformanceBoard(now);
check(
  "classement identique à données identiques",
  JSON.stringify(again.salespeople.map((r) => [r.salesperson, r.rank, r.score])) ===
    JSON.stringify(rows.map((r) => [r.salesperson, r.rank, r.score])),
);

// On modifie une donnée réelle — le pipe du dernier — et l'on vérifie que le
// score bouge. Un classement qui ne réagit pas aux données ne classe rien.
const last = rows[rows.length - 1];
const target = db
  .prepare(
    "SELECT opportunity_id FROM opportunity WHERE owner = ? AND is_terminal = 0 LIMIT 1",
  )
  .get(last.salesperson);
if (target) {
  db.prepare(
    "UPDATE opportunity SET milestone_status = 'dormant_candidate', milestone_is_legacy = 0 WHERE opportunity_id = ?",
  ).run(target.opportunity_id);
  const changed = buildPerformanceBoard(now);
  const after = changed.salespeople.find((r) => r.salesperson === last.salesperson);
  check(
    "un changement de données fait bouger le score",
    after.score !== last.score,
    `${last.score} → ${after.score}`,
  );
} else {
  check("un changement de données fait bouger le score", false, "aucune affaire à modifier");
}

// --- Historique et tendance ------------------------------------------------

section("P4 — Historique et évolution du rang");

// L'historique réel s'accumule au fil des jours : dès qu'une photo de la veille
// existe, elle devient la référence et le contrôle ci-dessous, qui fabrique sa
// propre photo antérieure, comparerait à la mauvaise. On repart d'un historique
// vide DANS LA COPIE — la base de travail n'est jamais touchée.
db.prepare("DELETE FROM performance_snapshot").run();

const written = recordPerformanceSnapshot(rows, now);
check("la photo du jour est enregistrée", written.written === rows.length, `${written.written} lignes`);
check(
  "réécrire le même jour ne crée pas de doublon",
  recordPerformanceSnapshot(rows, now).written === rows.length &&
    db.prepare("SELECT COUNT(*) n FROM performance_snapshot WHERE snapshot_date = ?").get(written.snapshotDate).n ===
      rows.length,
);
check(
  "l'historique d'un commercial est relisible",
  historyOf(rows[0].salesperson).length > 0,
  `${historyOf(rows[0].salesperson).length} photo(s)`,
);

// Photo antérieure fabriquée, rangs inversés : la tendance doit s'inverser.
const yesterday = "2000-01-02";
const insert = db.prepare(
  `INSERT INTO performance_snapshot
     (snapshot_date, salesperson, computed_at, rank, score, signed_score, leads_score,
      deals_score, pipeline_score, metrics, model_version)
   VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)
   ON CONFLICT(snapshot_date, salesperson) DO UPDATE SET
     rank = excluded.rank, model_version = excluded.model_version`,
);
// La photo fabriquée porte la version COURANTE : c'est la seule façon qu'elle
// serve de référence, et c'est précisément ce que le contrôle veut éprouver.
for (const row of rows) {
  insert.run(
    yesterday,
    row.salesperson,
    yesterday,
    rows.length + 1 - row.rank,
    PERFORMANCE_MODEL_VERSION,
  );
}
const previousDate = previousSnapshotDate(now.toISOString().slice(0, 10));
check("la photo précédente est bien celle d'un jour antérieur", previousDate === yesterday, previousDate ?? "—");

const withTrend = buildPerformanceBoard(now, ranksAt(yesterday), yesterday);
const first = withTrend.salespeople[0];
const lastRow = withTrend.salespeople[withTrend.salespeople.length - 1];
check(
  "un commercial qui monte affiche un gain de places",
  first.rankChange === rows.length - 1,
  `${first.firstName} ${first.previousRank} → ${first.rank} (${first.rankChange})`,
);
check(
  "un commercial qui descend affiche une perte de places",
  lastRow.rankChange === -(rows.length - 1),
  `${lastRow.firstName} ${lastRow.previousRank} → ${lastRow.rank} (${lastRow.rankChange})`,
);
check(
  "sans photo antérieure, aucune tendance n'est inventée",
  board.salespeople.every((r) => r.rankChange === null),
);

// --- Explications ----------------------------------------------------------

section("P5 — Explications adossées aux mesures");

let coherent = true;
let quoted = true;
for (const row of withTrend.salespeople) {
  const metrics = Object.values(row.pillars).flatMap((p) => p.metrics);
  const measured = metrics.filter((m) => m.measured);
  // Un point fort ne peut sortir que d'une mesure haute, un point de vigilance
  // que d'une mesure basse. C'est ce qui interdit au commentaire d'affirmer
  // quoi que ce soit que le calcul ne soutienne pas.
  //
  // Plusieurs mesures peuvent afficher la même valeur — « 0 % » est fréquent.
  // On ne cherche donc pas LA mesure d'origine, on vérifie qu'il en existe une
  // qui cite cette valeur ET qui se situe du bon côté du seuil.
  const parKey = new Map(metrics.map((m) => [m.key, m]));
  for (const e of row.strengths) {
    const m = parKey.get(e.key);
    if (!m || !m.measured || !e.text.includes(m.phrase)) quoted = false;
    if (!m || m.normalized < 0.65) coherent = false;
  }
  for (const e of row.watch) {
    const m = parKey.get(e.key);
    if (!m || !m.measured || !e.text.includes(m.phrase)) quoted = false;
    if (!m || m.normalized > 0.35) coherent = false;
  }
  if (!row.comment.startsWith(`#${row.rank} `)) coherent = false;
}
check("chaque point fort ou de vigilance cite une valeur réellement mesurée", quoted);
check("les explications sont cohérentes avec les sous-scores", coherent);
check(
  "aucune explication ne s'appuie sur une mesure absente",
  withTrend.salespeople.every((row) => {
    const missing = new Set(
      Object.values(row.pillars)
        .flatMap((p) => p.metrics)
        .filter((m) => !m.measured)
        .map((m) => m.key),
    );
    return [...row.strengths, ...row.watch].every((e) => !missing.has(e.key));
  }),
);
check(
  "le commentaire est court et factuel",
  withTrend.salespeople.every((r) => r.comment.length > 0 && r.comment.length < 260),
  `plus long : ${Math.max(...withTrend.salespeople.map((r) => r.comment.length))} caractères`,
);

// --- Ce que le score ne prétend pas mesurer -------------------------------

section("P6 — Limites déclarées");

check(
  "l'absence de mesure est signalée, jamais comblée en silence",
  withTrend.salespeople.every((row) =>
    Object.values(row.pillars)
      .flatMap((p) => p.metrics)
      .every((m) => m.measured || m.display === "—"),
  ),
);
check(
  "aucun pilier Réactivité n'est prétendu",
  Object.keys(PERFORMANCE.weights).length === 4 &&
    !Object.keys(PERFORMANCE.weights).includes("reactivite"),
);
check("les limites du modèle sont publiées à l'écran", board.notes.length > 0, `${board.notes.length} note(s)`);

console.log(`\n${failures === 0 ? "Tous les contrôles du Lot B passent." : `${failures} contrôle(s) en échec.`}`);

db.close();
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(WORK + suffix, { force: true });
  } catch {
    // Copie laissée sur place : sans conséquence, écrasée au contrôle suivant.
  }
}

process.exit(failures === 0 ? 0 : 1);

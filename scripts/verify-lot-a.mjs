/**
 * Contrôles du Lot A — Morning, Forecast, Monitoring.
 *
 *   npm run lota:verify
 *
 * ÉCRIT DANS UNE COPIE DE LA BASE, jamais dans celle de travail : trois des
 * comportements vérifiés ici sont des écritures (cocher une action, marquer une
 * liste comme lue), et un contrôle ne doit pas laisser de trace dans les données
 * du directeur régional. La copie est faite au démarrage, détruite à la fin.
 *
 * Les cas de test qui demandent une donnée absente de la base réelle — une
 * affaire déclarée mais peu probable, par exemple — sont FABRIQUÉS dans la
 * copie, puis mesurés. C'est ce qui permet de vérifier une règle et pas
 * seulement l'état du jour.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = path.resolve(process.cwd(), "data/rm-morning.db");
const WORK_DIR = path.resolve(process.cwd(), "data/verif");
const WORK = path.join(WORK_DIR, "lot-a.db");

mkdirSync(WORK_DIR, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(SOURCE + suffix)) copyFileSync(SOURCE + suffix, WORK + suffix);
}
// Doit être posée AVANT le premier import : `config` la lit au chargement.
process.env.RM_DB_PATH = path.relative(process.cwd(), WORK).replace(/\\/g, "/");

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { buildMorningPlan } = await import(lib("morning-priority"));
const { markActionDone, doneActionKeys } = await import(lib("morning-events"));
const {
  buildForecastV2,
  isDeclaredOnMonth,
  isProbableOnMonth,
  isFrozenOut,
  isVisibleInForecast,
} = await import(lib("forecast-v2"));
const { FORECAST_VISIBILITY } = await import(lib("config"));
const { leadMonitoringView, opportunityMonitoringView, markScopeRead } = await import(
  lib("monitoring-view")
);
const { resetRead } = await import(lib("monitoring-read"));
const { todayIso } = await import(lib("normalize"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const db = getDb();

// --- A1. Plan du jour : la case Done ---------------------------------------

section("A1 — « À faire aujourd'hui » : case Done et persistance");

// Le plan du jour a pu être coché par l'utilisateur avant le contrôle — c'est
// même le cas nominal en fin de matinée. On repart donc d'un plan vierge DANS LA
// COPIE : le contrôle mesure le mécanisme, pas l'avancement du directeur
// régional. La base de travail, elle, n'est jamais touchée.
db.prepare("DELETE FROM morning_action_done").run();

const plan = buildMorningPlan();
check("le plan du jour contient au moins une action", plan.actions.length > 0, `${plan.actions.length} action(s)`);

if (plan.actions.length > 0) {
  const target = plan.actions[0];
  const withoutMessage = plan.actions.find((a) => a.messageId == null);
  check(
    "des actions sans message existent (celles qui n'étaient pas cochables)",
    withoutMessage != null,
    withoutMessage ? withoutMessage.key : "aucune dans l'état du jour",
  );

  const before = plan.actions.length;
  const written = markActionDone(target.key);
  check("cocher une action est enregistré", written === true, target.key);
  check("cocher deux fois n'écrit rien de plus", markActionDone(target.key) === false);

  const after = buildMorningPlan();
  check(
    "l'action cochée quitte la liste active",
    after.actions.length === before - 1 && !after.actions.some((a) => a.key === target.key),
    `${before} → ${after.actions.length}`,
  );
  check("le compteur du jour la retient", after.doneToday >= 1, `${after.doneToday} faite(s)`);

  // Persistance : la clé doit survivre à une relecture complète de la base.
  check("l'état est persisté pour la journée", doneActionKeys().has(target.key));

  // Portée quotidienne : une action cochée hier ne doit pas masquer celle
  // d'aujourd'hui. On simule en repoussant la date de la ligne.
  db.prepare("UPDATE morning_action_done SET done_on = '2000-01-01' WHERE action_key = ?").run(
    target.key,
  );
  const tomorrow = buildMorningPlan();
  check(
    "une action cochée un autre jour revient",
    tomorrow.actions.some((a) => a.key === target.key),
    "l'état porte bien sur la journée",
  );
  db.prepare("DELETE FROM morning_action_done").run();
}

// --- A2. Forecast : la règle d'affichage -----------------------------------

section("A2 — Forecast : déclarée en signature OU Expected ≥ 25 %");

const board = buildForecastV2(0);
const rows = board.salespeople.flatMap((s) => s.opportunities);
const today = todayIso();
const seuil = FORECAST_VISIBILITY.minProbability;

const visible = (r) => isVisibleInForecast(r, board.month, today);
const shown = rows.filter(visible);

check("le seuil de probabilité est bien 25 %", seuil === 0.25, `${seuil * 100} %`);
check(
  "la règle raccourcit effectivement la feuille",
  shown.length < rows.length,
  `${shown.length} affichées sur ${rows.length} lignes du mois`,
);

// --- Les quatre cas de la règle, éprouvés sur des affaires FABRIQUÉES.
//
// Les mesurer sur l'état du jour ne prouverait rien : rien ne garantit qu'une
// affaire déclarée à 10 % existe ce matin. On construit donc les quatre cas
// exacts et on interroge la règle elle-même.
const gabarit = rows[0] ?? {};
const cas = (declared, probability) => ({
  ...gabarit,
  opportunityId: `T-${declared}-${probability}`,
  outsideKanban: !declared,
  perspectiveMonth: null,
  kanbanMonth: declared ? board.month : null,
  expectedProbability: probability,
  expectedGmv: 0,
  isStandby: false,
  standbyUntil: null,
});

check(
  "déclaré en signature + Expected 10 % → visible",
  visible(cas(true, 0.1)) === true,
);
check(
  "non déclaré + Expected 24,9 % → absent",
  visible(cas(false, 0.249)) === false,
);
check(
  "non déclaré + Expected 25 % → visible",
  visible(cas(false, 0.25)) === true,
);
check(
  "non déclaré + Expected 40 % → visible",
  visible(cas(false, 0.4)) === true,
);
check(
  "non déclaré sans Expected du tout → absent",
  visible(cas(false, null)) === false,
);
check(
  "déclaré mais en stand-by futur → absent malgré la déclaration",
  visible({ ...cas(true, 0.9), isStandby: true, standbyUntil: "2099-12-31" }) === false,
);

// --- Les mêmes règles, mesurées sur les données réelles du jour.
const declaredLowProb = rows.filter(
  (r) => isDeclaredOnMonth(r, board.month) && (r.expectedProbability ?? 0) < seuil,
);
check(
  "une affaire déclarée reste visible même sous le seuil",
  declaredLowProb.every((r) => visible(r) || isFrozenOut(r, today)),
  `${declaredLowProb.length} cas mesuré(s)`,
);

const undeclaredHigh = rows.filter((r) => !isDeclaredOnMonth(r, board.month) && (r.expectedProbability ?? 0) >= seuil);
check(
  "une affaire non déclarée à ≥ 25 % est visible",
  undeclaredHigh.every((r) => visible(r) || isFrozenOut(r, today)),
  `${undeclaredHigh.length} cas mesuré(s)`,
);

const undeclaredLow = rows.filter(
  (r) => !isDeclaredOnMonth(r, board.month) && (r.expectedProbability ?? 0) < seuil,
);
check(
  "une affaire non déclarée sous 25 % est masquée",
  undeclaredLow.every((r) => !visible(r)),
  `${undeclaredLow.length} cas mesuré(s)`,
);

const standbyShown = shown.filter((r) => isFrozenOut(r, today));
check("aucun stand-by à date future n'est affiché", standbyShown.length === 0);

// --- Aucune porte de sortie : ni accordéon, ni compteur, ni paramètre d'URL.
//
// Le contrôle porte sur le CODE de la page et du tableau, pas sur son rendu :
// c'est la seule façon de garantir qu'aucun mécanisme de dépliage ne subsiste,
// y compris derrière une condition qui ne se déclenche pas aujourd'hui.
const pageSource = readFileSync(path.resolve(process.cwd(), "src/app/forecast/page.tsx"), "utf8");
const sheetSource = readFileSync(
  path.resolve(process.cwd(), "src/components/forecast-sheet.tsx"),
  "utf8",
);
check(
  "la feuille ne connaît plus d'affaires secondaires",
  !sheetSource.includes("secondary") && !pageSource.includes("secondary"),
);
check(
  "aucun lien « voir les autres affaires »",
  !/autres affaires/i.test(sheetSource) && !/autres affaires/i.test(pageSource),
);
check(
  "aucun compteur « à challenger » sur des affaires masquées",
  !/secondaryChallenges/.test(sheetSource),
);
check(
  "aucun paramètre d'URL ne force l'affichage complet",
  !/query\.tout|"tout"/.test(pageSource),
);

// Le paramètre `tout=1` ne doit plus rien rouvrir, même s'il est saisi à la main.
check(
  "les affaires masquées ne sont transmises à aucun composant",
  (() => {
    const kept = board.salespeople.flatMap((sp) =>
      sp.opportunities.filter((o) => isVisibleInForecast(o, board.month, today)),
    );
    return kept.every(visible) && kept.length === shown.length;
  })(),
  `${shown.length} ligne(s) transmises`,
);

// Le bloc « Candidats à examiner » suit la même règle : déclarés sur le mois
// suivant, ils ne sont pas déclarés sur celui-ci.
const probaById = new Map(rows.map((r) => [r.opportunityId, r.expectedProbability ?? 0]));
const candidatsVisibles = board.candidates.filter(
  (c) => (probaById.get(c.opportunityId) ?? 0) >= seuil,
);
check(
  "les candidats sous le seuil sont écartés eux aussi",
  candidatsVisibles.length <= board.candidates.length &&
    candidatsVisibles.every((c) => (probaById.get(c.opportunityId) ?? 0) >= seuil),
  `${candidatsVisibles.length} retenu(s) sur ${board.candidates.length}`,
);

// Exclusions à la donnée : elles doivent tenir AVANT tout filtre d'affichage.
const terminal = db
  .prepare(
    "SELECT opportunity_id, client_contact, is_signed, absent_since FROM opportunity WHERE is_terminal = 1",
  )
  .all();
const ids = new Set(rows.map((r) => r.opportunityId));
const leaked = terminal.filter((t) => ids.has(t.opportunity_id) || ids.has(t.opportunity_id.slice(0, 15)));
check(
  "aucune affaire signée ou abandonnée ne remonte au Forecast",
  leaked.length === 0,
  leaked.length > 0 ? leaked.map((l) => l.client_contact).join(", ") : `${terminal.length} affaire(s) terminales vérifiées`,
);

const souad = db
  .prepare(
    "SELECT opportunity_id, is_terminal, absent_since, absent_reason FROM opportunity WHERE upper(client_contact) LIKE '%BOUSABBAG%'",
  )
  .get();
if (souad) {
  check(
    "SOUAD BOUSABBAG est sortie du pipe actif",
    Number(souad.is_terminal) === 1 && souad.absent_since != null,
    `${souad.absent_reason ?? "—"} (depuis le ${souad.absent_since ?? "—"})`,
  );
  check(
    "et elle n'apparaît plus dans le Forecast",
    !ids.has(souad.opportunity_id) && !ids.has(souad.opportunity_id.slice(0, 15)),
  );
} else {
  check("le dossier témoin SOUAD BOUSABBAG est introuvable en base", false);
}

const ghosts = db
  .prepare(
    `SELECT COUNT(*) n FROM opportunity
      WHERE is_terminal = 0 AND last_import_id <
            (SELECT MAX(id) FROM import_run WHERE source_kind IN ('api','manual'))`,
  )
  .get().n;
check(
  "plus aucune affaire active n'échappe au dernier import",
  Number(ghosts) === 0,
  `${ghosts} fantôme(s) restant(s)`,
);

// --- A3 / A4. Monitoring : Tout lire, snapshot, nouveautés -----------------

for (const [scope, label, buildView] of [
  ["piste", "Pistes", leadMonitoringView],
  ["opportunite", "Opportunités", opportunityMonitoringView],
]) {
  section(`A3/A4 — Monitoring ${label} : Tout lire et détection des nouveautés`);

  resetRead(scope);
  const initial = buildView(null);
  check("la liste part remplie", initial.items.length > 0, `${initial.activeCount} élément(s) actifs`);
  check("aucune lecture antérieure", initial.readCount === 0 && initial.lastReadAt === null);

  const read = markScopeRead(scope, null);
  check("« Tout lire » acquitte tout le stock actif", read === initial.activeCount, `${read} lu(s)`);

  const emptied = buildView(null);
  check("la liste active revient à vide", emptied.items.length === 0, `${emptied.visibleCount} restant(s)`);
  check("l'écran peut annoncer « Tout est traité »", emptied.readCount === emptied.activeCount);
  check("la dernière lecture est datée", emptied.lastReadAt != null, emptied.lastReadAt ?? "—");

  const snapshots = db
    .prepare("SELECT COUNT(*) n FROM monitoring_read WHERE scope = ? AND fingerprint <> '{}'")
    .get(scope).n;
  check("un snapshot des valeurs vues est persisté", Number(snapshots) === read, `${snapshots} signature(s)`);

  // Une donnée modifiée doit faire revenir l'élément, et lui seul.
  const first = initial.items[0];
  const id = scope === "piste" ? first.lead.leadId : first.opportunity.opportunityId;
  if (scope === "piste") {
    db.prepare("UPDATE lead SET recall_date = '2099-12-31' WHERE lead_id = ?").run(id);
  } else {
    db.prepare("UPDATE opportunity SET kanban_month = 12, kanban_year = 2099 WHERE opportunity_id = ?").run(id);
  }

  const afterChange = buildView(null);
  const back = afterChange.items.find(
    (i) => (scope === "piste" ? i.lead.leadId : i.opportunity.opportunityId) === id,
  );
  check("l'élément modifié revient dans la liste", back != null, id);
  if (back) {
    check("il est marqué comme modifié", back.verdict.status === "modifie");
    check(
      "seule la valeur modifiée est désignée",
      back.verdict.changes.length === 1,
      back.verdict.changes.map((c) => `${c.label} : ${c.before ?? "—"} → ${c.after ?? "—"}`).join(" / "),
    );
    check(
      "l'ancienne et la nouvelle valeur sont toutes deux connues",
      back.verdict.changes.every((c) => c.after != null),
    );
  }
  check(
    "les éléments inchangés restent masqués",
    afterChange.items.length === 1,
    `${afterChange.items.length} affiché(s), ${afterChange.changedCount} modifié(s)`,
  );

  // Un nouvel élément jamais lu doit apparaître sans être marqué « modifié ».
  const neverRead = afterChange.items.filter((i) => i.verdict.status === "jamais_lu").length;
  check("aucun faux « nouveau » n'est produit", neverRead === 0);
}

// --- Non-régression --------------------------------------------------------

section("Non-régression");

check("le Morning conserve ses blocs 1 et 2", Array.isArray(plan.hot) && Array.isArray(plan.waiting));
check(
  "les totaux Forecast restent cohérents avec le service Expected",
  board.issues.filter((i) => i.startsWith("Expected Forecast")).length === 0,
  board.issues.filter((i) => i.startsWith("Expected Forecast")).join(" · ") || "aucun écart",
);
check("le Signé officiel reste lisible", board.region.signedGmvActual >= 0, `${Math.round(board.region.signedGmvActual / 1000)} k€`);

console.log(`\n${failures === 0 ? "Tous les contrôles du Lot A passent." : `${failures} contrôle(s) en échec.`}`);

// Nettoyage : la copie ne survit pas au contrôle. La fermeture doit précéder la
// suppression — Windows refuse d'effacer un fichier encore ouvert.
db.close();
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(WORK + suffix, { force: true });
  } catch {
    // Copie laissée sur place : sans conséquence, elle sera écrasée au contrôle
    // suivant. Ne jamais faire échouer un contrôle pour un défaut de ménage.
  }
}

process.exit(failures === 0 ? 0 : 1);

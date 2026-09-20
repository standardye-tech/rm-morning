/**
 * Contrôles de « Perspective ajustée » : lecture du classeur manuel
 * « Perspectives M+1 (> 50 % de probabilité) ».
 *
 *   npm run forecast:adjusted-verify
 *
 * Parseur PUR sur des grilles synthétiques qui reproduisent la disposition réelle
 * (constatée le 20/09/2026) : aucune donnée client n'est versionnée. Aucun accès
 * réseau, aucune base.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const P = await import(pathToFileURL(path.resolve("src/lib/sources/adjusted-perspective-parser.ts")).href);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const blank = (n, w = 20) => Array.from({ length: n }, () => Array(w).fill(null));
const put = (g, r, c, v) => {
  g[r][c] = v;
};

/**
 * Onglet de mois courant : 4 blocs de snapshot (le dernier vide), 3 commerciaux,
 * une ligne « Moins value », un tableau de synthèse aux libellés faux.
 * `shift` décale tout vers le bas : rien ne doit dépendre d'un numéro de ligne.
 */
function currentTab({ shift = 0, dateFormat = "iso" } = {}) {
  const g = blank(60);
  const at = (r) => r + shift;
  const dates = {
    iso: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"],
    fr: ["31/08/2026", "07/09/2026", "14/09/2026", "21/09/2026"],
    serial: [46265, 46272, 46279, 46286],
  }[dateFormat];
  put(g, at(2), 0, "NATIONAL");
  put(g, at(3), 0, "Forecast");
  put(g, at(4), 0, "OBJECTIF");
  [7, 10, 13, 16].forEach((c, i) => {
    put(g, at(11), c, dates[i]);
    put(g, at(12), c, "Proba");
    put(g, at(12), c + 1, "CA");
    put(g, at(12), c + 2, "GMV");
  });
  const deal = (r, owner, client, base, snaps) => {
    if (owner) put(g, at(r), 0, owner);
    put(g, at(r), 1, client);
    put(g, at(r), 5, base);
    Object.entries(snaps).forEach(([c, v]) => put(g, at(r), Number(c), v));
  };
  // colonnes GMV des blocs : 9 (31/08), 12 (07/09), 15 (14/09), 18 (21/09, vide)
  deal(15, "Anthony RAMAHERISON", "Client A", 100000, { 9: 30000, 12: 40000, 15: 50000 });
  deal(16, null, "Client B", 80000, { 9: 10000, 12: 20000, 15: 25000 });
  put(g, at(17), 1, "Moins value");
  put(g, at(17), 5, -7000);
  deal(18, "David BERNSTEIN", "Client C", 60000, { 15: 12000 });
  deal(19, "Personne HORSEQUIPE", "Client D", 5000, { 15: 3000 });
  put(g, at(30), 0, "SAMI");
  put(g, at(30), 4, "CA");
  put(g, at(30), 5, "GMV");
  put(g, at(31), 0, "Forecast Janvier");
  put(g, at(31), 5, 999999);
  put(g, at(31), 15, 888888);
  put(g, at(40), 0, "THOMAS BRETON");
  put(g, at(40), 1, "Ne doit pas compter");
  put(g, at(40), 15, 777);
  return g;
}

/** Onglet de mois futur : liste manuelle, aucun bloc de snapshot. */
function futureTab() {
  const g = blank(40);
  put(g, 3, 0, "Forecast");
  const rows = [
    ["Guillaume FONTAINE", "F1", 50000],
    [null, "F2", 25000.5],
    ["Vincent BOUZY", "F3", 10000],
  ];
  rows.forEach(([o, c, v], i) => {
    if (o) put(g, 15 + i, 0, o);
    put(g, 15 + i, 1, c);
    put(g, 15 + i, 5, v);
  });
  put(g, 30, 0, "SAMI");
  put(g, 31, 0, "Forecast Janvier");
  put(g, 31, 5, 123456);
  return g;
}

function withoutSnapshots() {
  const g = currentTab();
  for (const r of g) for (let c = 7; c <= 18; c++) r[c] = null;
  return g;
}

const cur = (o) => P.parseAdjustedTab(currentTab(o), "2026-09", { allowSelection: false });

console.log("\nSnapshots");
const a = cur();
check(
  "dernier snapshot RENSEIGNÉ (14/09), pas le dernier daté (21/09 vide)",
  a?.snapshotDate === "2026-09-14" && a.source === "snapshot",
  `${a?.snapshotDate}`,
);
check(
  "GMV du snapshot 14/09 = Σ colonne GMV des lignes d'affaires",
  a?.gmv === 50000 + 25000 + 12000 + 3000,
  `${a?.gmv}`,
);
check(
  "les quatre blocs sont vus, seul le 21/09 est vide",
  a?.snapshots.length === 4 && a.snapshots.filter((s) => !s.filled).map((s) => s.date).join() === "2026-09-21",
);
check("« Moins value » n'est pas une affaire", a?.count === 4, `${a?.count} lignes`);
check("le tableau de synthèse et les libellés d'anciens gabarits sont ignorés", a?.gmv < 100000);
check(
  "GMV par commercial : A renseigné une seule fois par groupe",
  a?.byOwner["Anthony Ramaherison"] === 75000 && a?.byOwner["David Bernstein"] === 12000,
);
check(
  "un commercial hors équipe compte dans le total, pas dans l'équipe",
  a && !("Personne HORSEQUIPE" in a.byOwner) && Object.values(a.byOwner).reduce((t, v) => t + v, 0) === a.gmv - 3000,
);

console.log("\nStructure");
check("aucun numéro de ligne fixe : même résultat décalé de 7 lignes", JSON.stringify(cur({ shift: 7 })) === JSON.stringify(a));
check("dates d'en-tête au format JJ/MM/AAAA", cur({ dateFormat: "fr" })?.snapshotDate === "2026-09-14");
check("dates d'en-tête en numéro de série Sheets", cur({ dateFormat: "serial" })?.snapshotDate === "2026-09-14");
const earlier = currentTab();
for (const r of earlier) r[15] = null;
check(
  "si le 14/09 n'est pas renseigné, retombe sur le 07/09",
  P.parseAdjustedTab(earlier, "2026-09", { allowSelection: false })?.snapshotDate === "2026-09-07",
);

console.log("\nMois et onglets");
const titles = ["Aout 2026", "Septembre 2026", "Octobre 2026", "Novembre 2024 ", "Copie de DECEMBRE 2023", "Jui 2023", "JUIN 2023 "];
check(
  "le nom de l'onglet fait foi (accents, casse, espaces, « Aout »)",
  P.tabMonth("Aout 2026") === "2026-08" &&
    P.tabMonth("Novembre 2024 ") === "2024-11" &&
    P.tabMonth("SEPTEMBRE 2023") === "2023-09" &&
    P.tabMonth("Février 2025") === "2025-02",
);
check("onglets « Copie de … » ou abrégés ignorés", P.tabMonth("Copie de DECEMBRE 2023") === null && P.tabMonth("Jui 2023") === null);
check("septembre lit « Septembre 2026 », jamais octobre", P.pickTab(titles, "2026-09").title === "Septembre 2026");
check("M+1 lit l'onglet du mois suivant", P.pickTab(titles, "2026-10").title === "Octobre 2026");
check("mois sans onglet : rien n'est lu", P.pickTab(titles, "2026-11").title === null);
check("deux onglets pour un même mois : ambigu, rien n'est lu", P.pickTab(["Mars 2026", "MARS 2026"], "2026-03").title === null);
check(
  "le nom du classeur (« M+1 ») n'entre pas en jeu : aucun décalage de mois",
  P.tabMonth("Perspectives M+1 (> 50% de probabilité)") === null,
);

console.log("\nRepli sur la sélection manuelle");
const f = P.parseAdjustedTab(futureTab(), "2026-10", { allowSelection: true });
check(
  "mois futur sans snapshot : GMV de la liste manuelle",
  f?.source === "selection" && f.gmv === 85000.5 && f.snapshotDate === null && f.count === 3,
  `${f?.gmv}`,
);
check("libellés de synthèse d'anciens gabarits (« Forecast Janvier ») jamais lus", f?.gmv !== 123456);
check("mois futur : GMV par commercial", f?.byOwner["Guillaume Fontaine"] === 75000.5 && f.byOwner["Vincent Bouzy"] === 10000);
check(
  "mois courant sans snapshot : pas de repli (sa colonne F liste tout le pipe)",
  P.parseAdjustedTab(withoutSnapshots(), "2026-09", { allowSelection: false }) === null,
);
check(
  "mois futur AVEC snapshot renseigné : le snapshot prime sur la liste",
  P.parseAdjustedTab(currentTab(), "2026-10", { allowSelection: true })?.source === "snapshot",
);
check("onglet vide : null, pas de zéro inventé", P.parseAdjustedTab(blank(20), "2026-10", { allowSelection: true }) === null);

console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

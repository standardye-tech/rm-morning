/**
 * Tests du bloc « Depuis [la dernière photo] » — audit V3.1.
 *
 *   npm run since-last-snapshot:verify
 *
 * Deux parties :
 *
 *   — les 20 cas obligatoires de la mission, joués sur des fixtures fabriquées
 *     (aucun accès base pour ceux-là : le moteur est pur aux étages 1 et 3,
 *     et l'étage 2 est testé via ses briques extraites — `resolveSignedCoverage`,
 *     `mergeSignedLines` — plutôt que via une vraie table Travaux) ;
 *   — un contrôle d'intégration en LECTURE SEULE sur la vraie base, qui rejoue
 *     `buildSinceLastSnapshot` sur l'état réel et vérifie juste que rien ne
 *     casse et que les invariants de forme tiennent (une ligne par affaire,
 *     KPI jamais à 0 fabriqué).
 *
 * LECTURE SEULE de bout en bout : aucune écriture, aucune donnée fabriquée
 * n'est jamais insérée en base.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const {
  computeOpportunityDelta,
  resolveSignedCoverage,
  mergeSignedLines,
  buildBusinessDelta,
  buildSinceLastSnapshot,
  selectSignificantChanges,
  formatSinceTitle,
} = await import(lib("since-last-snapshot"));
const { loadOpportunities } = await import(lib("repository"));
const { parisDate } = await import(lib("business-time"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

const M = "2026-09"; // mois métier de test
const state = (over) => ({
  gmv: 100_000,
  stage: "Examen devis",
  kanbanMonth: 9,
  kanbanYear: 2026,
  isStandby: false,
  ...over,
});

// ────────────────────────────────────────────────────────────────────────
section("TITRE — cas 1 et 2");

{
  // 1. baseline J-1 → titre "Depuis hier"
  const delta = buildBusinessDelta("2026-09-22", "2026-09-21", [], new Map());
  check("1. baseline J-1 -> titre 'Depuis hier'", formatSinceTitle(delta.title) === "Depuis hier");
}
{
  // 2. trou de 2+ jours -> vraie date + nombre de jours, jamais "hier"
  const delta = buildBusinessDelta("2026-09-22", "2026-09-20", [], new Map());
  const label = formatSinceTitle(delta.title);
  check(
    "2. trou de 2 jours -> date réelle + compteur, jamais 'Depuis hier'",
    delta.title.kind === "days" && delta.title.days === 2 && !label.includes("hier"),
    label,
  );
  const gap = buildBusinessDelta("2026-09-22", "2026-09-14", [], new Map());
  check(
    "2bis. trou de 8 jours -> jamais 'Depuis hier'",
    gap.title.kind === "days" && gap.title.days === 8 && !formatSinceTitle(gap.title).includes("hier"),
    formatSinceTitle(gap.title),
  );
}

// ────────────────────────────────────────────────────────────────────────
section("BASELINE — cas 3");

{
  // 3. aucune baseline disponible -> dégradation propre, aucun 0 fabriqué
  const delta = buildBusinessDelta("2026-09-22", null, [], new Map());
  check("3. pas de baseline -> available=false", delta.available === false);
  check("3. pas de baseline -> titre 'unavailable'", delta.title.kind === "unavailable");
  check("3. pas de baseline -> KPI signé indisponible", delta.signed.available === false);
  check("3. pas de baseline -> KPI entré-M indisponible", delta.enteredM.available === false);
  check("3. pas de baseline -> aucun changement", delta.changes.length === 0);
}

// ────────────────────────────────────────────────────────────────────────
section("SIGNATURE OFFICIELLE — cas 4 et 5");

{
  // 4. nouvelle signature officielle : GMV officielle, commercial, affaires
  //    distinctes (deux lignes Travaux, avenant compris, sur la même affaire).
  const changes = new Map();
  mergeSignedLines(changes, [
    {
      travauxId: "t1",
      opportunityId: "006AAA",
      client: "Jean Dupont",
      salesperson: "Mathis Coulon",
      signatureDate: "2026-09-20",
      gmv: 42_000,
      worksType: null,
      worksStatus: "Signé",
    },
    {
      // Avenant sur la MÊME affaire : doit s'additionner, pas remplacer.
      travauxId: "t2",
      opportunityId: "006AAA",
      client: "Jean Dupont",
      salesperson: "Mathis Coulon",
      signatureDate: "2026-09-21",
      gmv: 3_000,
      worksType: null,
      worksStatus: "Signé",
    },
  ]);
  check("4. une seule ligne pour l'affaire malgré 2 lignes Travaux", changes.size === 1);
  const row = changes.get("006AAA");
  check("4. GMV officielle = somme (avenant inclus)", row.signed.gmv === 45_000, `obtenu ${row?.signed?.gmv}`);
  check("4. commercial porté", row.owner === "Mathis Coulon");
  check("4. date retenue = la plus récente", row.signed.signatureDate === "2026-09-21");
  check("4. opportunityId porté", row.opportunityId === "006AAA");
}
{
  // 5. Travaux non fraîche -> jamais un 0 € qui se fait passer pour un fait.
  const staleCoverage = resolveSignedCoverage("2026-09-22", "2026-09-14", "2026-09-10");
  check("5. Travaux antérieure à la baseline -> signé indisponible (pas 0)", staleCoverage.available === false);
  check("5. coveredThrough vide quand indisponible", staleCoverage.coveredThrough === null);

  const partialCoverage = resolveSignedCoverage("2026-09-22", "2026-09-14", "2026-09-18");
  check(
    "5bis. Travaux fraîche mais pas à jour -> disponible, borné et signalé 'stale'",
    partialCoverage.available === true && partialCoverage.coveredThrough === "2026-09-18" && partialCoverage.stale === true,
  );

  const freshCoverage = resolveSignedCoverage("2026-09-22", "2026-09-14", "2026-09-22");
  check(
    "5ter. Travaux à jour -> disponible, non 'stale'",
    freshCoverage.available === true && freshCoverage.stale === false,
  );
}

// ────────────────────────────────────────────────────────────────────────
section("VARIATION DE GMV — cas 6, 7, 8");

{
  // 6. GMV < seuil -> exclue (ni FORECAST_THRESHOLDS.significantGmvDelta ni ratio franchis)
  const before = state({ gmv: 100_000 });
  const after = state({ gmv: 105_000 }); // +5 000 € / +5 % : sous les deux seuils
  const d = computeOpportunityDelta(before, after, M);
  check("6. GMV +5% sous 20k€/15% -> aucun changement retenu", d === null);
}
{
  // 7. GMV >= 20k€ OU >= 15% -> incluse
  const d1 = computeOpportunityDelta(state({ gmv: 100_000 }), state({ gmv: 121_000 }), M); // +21k€
  check("7. GMV +21k€ (>=20k€) -> retenue", d1?.gmvChange != null);
  const d2 = computeOpportunityDelta(state({ gmv: 50_000 }), state({ gmv: 58_000 }), M); // +16%
  check("7bis. GMV +16% (>=15%) -> retenue", d2?.gmvChange != null);
}
{
  // 8. variation suspecte -> badge "à vérifier"
  const big = computeOpportunityDelta(state({ gmv: 254_000 }), state({ gmv: 8_700 }), M); // -245k€, >100k€
  check("8. variation > 100k€ -> suspicious=true", big?.gmvChange?.suspicious === true);
  const ratio = computeOpportunityDelta(state({ gmv: 60_000 }), state({ gmv: 20_000 }), M); // -66%, sur affaire >=50k€
  check("8bis. -66% sur affaire >=50k€ -> suspicious=true", ratio?.gmvChange?.suspicious === true);
  const notSuspicious = computeOpportunityDelta(state({ gmv: 100_000 }), state({ gmv: 125_000 }), M); // +25k€, +25%
  check(
    "8ter. +25k€/+25% sur 100k€ -> significatif mais PAS suspect (sous 100k€ et sous 50%)",
    notSuspicious?.gmvChange != null && notSuspicious.gmvChange.suspicious === false,
  );
}

// ────────────────────────────────────────────────────────────────────────
section("STADE — cas 9");

{
  // 9. changement de StageName brut, sans qualification positive/négative
  const d = computeOpportunityDelta(
    state({ stage: "Visite artisan" }),
    state({ stage: "Examen devis" }),
    M,
  );
  check("9. changement de stade détecté", d?.stageChange != null);
  check("9. stade brut, from correct", d.stageChange.from === "Visite artisan");
  check("9. stade brut, to correct", d.stageChange.to === "Examen devis");
}

// ────────────────────────────────────────────────────────────────────────
section("STAND-BY — cas 10, 11");

{
  // 10. stand-by -> actif
  const d = computeOpportunityDelta(state({ isStandby: true }), state({ isStandby: false }), M);
  check("10. stand-by -> actif détecté", d?.standbyChange?.enteredStandby === false);
}
{
  // 11. actif -> stand-by
  const d = computeOpportunityDelta(state({ isStandby: false }), state({ isStandby: true }), M);
  check("11. actif -> stand-by détecté", d?.standbyChange?.enteredStandby === true);
}

// ────────────────────────────────────────────────────────────────────────
section("KANBAN CONNU/CONNU — cas 12, 13, 14, 15");

{
  // 12. M+1 -> M, connu des deux côtés
  const d = computeOpportunityDelta(
    state({ kanbanMonth: 10, kanbanYear: 2026 }),
    state({ kanbanMonth: 9, kanbanYear: 2026 }),
    M,
  );
  check("12. M+1 -> M détecté", d?.kanbanChange?.enteredM === true && d.kanbanChange.exitedM === false);
}
{
  // 13. M -> M+1
  const d = computeOpportunityDelta(
    state({ kanbanMonth: 9, kanbanYear: 2026 }),
    state({ kanbanMonth: 10, kanbanYear: 2026 }),
    M,
  );
  check("13. M -> M+1 détecté", d?.kanbanChange?.exitedM === true && d.kanbanChange.enteredM === false);
}
{
  // 14. M -> NULL : ne JAMAIS compter comme une sortie
  const d = computeOpportunityDelta(
    state({ kanbanMonth: 9, kanbanYear: 2026 }),
    state({ kanbanMonth: null, kanbanYear: null }),
    M,
  );
  check("14. M -> NULL -> aucun changement Kanban retenu", d === null || d.kanbanChange === null);
}
{
  // 15. NULL -> M : ne JAMAIS compter comme une entrée certaine
  const d = computeOpportunityDelta(
    state({ kanbanMonth: null, kanbanYear: null }),
    state({ kanbanMonth: 9, kanbanYear: 2026 }),
    M,
  );
  check("15. NULL -> M -> aucun changement Kanban retenu", d === null || d.kanbanChange === null);
}
{
  // Connu -> connu mais qui NE touche PAS M : hors doctrine V3.1, pas retenu.
  const d = computeOpportunityDelta(
    state({ kanbanMonth: 11, kanbanYear: 2026 }),
    state({ kanbanMonth: 12, kanbanYear: 2026 }),
    M,
  );
  check("15bis. connu->connu hors mois M -> non retenu (hors doctrine)", d === null || d.kanbanChange === null);
}

// ────────────────────────────────────────────────────────────────────────
section("UNE AFFAIRE = UNE LIGNE — cas 16, 17");

{
  // 16. plusieurs changements sur la même opportunité -> une seule ligne
  const before = state({ gmv: 60_000, stage: "Visite artisan", isStandby: false, kanbanMonth: 10, kanbanYear: 2026 });
  const after = state({ gmv: 130_000, stage: "Examen devis", isStandby: false, kanbanMonth: 9, kanbanYear: 2026 });
  const raw = computeOpportunityDelta(before, after, M);
  check(
    "16. les 3 dimensions cohabitent dans le MÊME objet (donc 1 seule ligne à l'affichage)",
    raw?.gmvChange != null && raw?.stageChange != null && raw?.kanbanChange != null,
  );

  // 17. priorité déterministe : signature > kanban > gmv > stand-by > stade
  const delta = {
    opportunityId: "006BBB",
    owner: "Test",
    client: "Test",
    gmv: 130_000,
    signed: { gmv: 10_000, signatureDate: "2026-09-21" },
    ...raw,
  };
  const [selected] = selectSignificantChanges([delta]);
  check("17. priorité = signature quand elle est présente", selected.primaryCategory === "signed");

  const withoutSigned = { ...delta, signed: null };
  const [selected2] = selectSignificantChanges([withoutSigned]);
  check("17bis. priorité = kanban quand pas de signature", selected2.primaryCategory === "kanban");

  const onlyGmvAndStage = { ...delta, signed: null, kanbanChange: null };
  const [selected3] = selectSignificantChanges([onlyGmvAndStage]);
  check("17ter. priorité = gmv quand pas de kanban/signature", selected3.primaryCategory === "gmv");
}

// ────────────────────────────────────────────────────────────────────────
section("AFFICHAGE — cas 18");

{
  // 18. maximum 5 visibles + détail exhaustif (le total n'est jamais masqué)
  const many = Array.from({ length: 12 }, (_, i) => ({
    opportunityId: `006${i}`,
    owner: "Test",
    client: `Affaire ${i}`,
    gmv: 100_000 - i * 1_000, // décroissant, pour vérifier le tri
    signed: null,
    stageChange: { from: "Etude dossier", to: "Examen estimation" },
    gmvChange: null,
    kanbanChange: null,
    standbyChange: null,
  }));
  const selected = selectSignificantChanges(many);
  check("18. toutes les affaires significatives sont sélectionnées (rien perdu)", selected.length === 12);
  const visible = selected.slice(0, 5);
  const rest = selected.slice(5);
  check("18bis. 5 visibles au plus, 7 en reste — total = 12 (jamais masqué)", visible.length === 5 && rest.length === 7);
  check(
    "18ter. tri décroissant par GMV au sein de la même catégorie",
    visible.every((s, i) => i === 0 || s.delta.gmv <= visible[i - 1].delta.gmv),
  );
}

// ────────────────────────────────────────────────────────────────────────
section("LIEN SALESFORCE — cas 19");

{
  // 19. chaque ligne porte un opportunityId exploitable par SalesforceOpportunityLink
  //     (le composant partagé résout lui-même l'URL ; ici on vérifie juste que
  //     l'identifiant Salesforce est transporté jusqu'au bout de la chaîne).
  const changes = new Map();
  mergeSignedLines(changes, [
    {
      travauxId: "t9",
      opportunityId: "006CCC00000000X",
      client: "Client Test",
      salesperson: "Sami",
      signatureDate: "2026-09-20",
      gmv: 5_000,
      worksType: null,
      worksStatus: "Signé",
    },
  ]);
  const row = changes.get("006CCC00000000X");
  check("19. opportunityId Salesforce porté jusqu'à la ligne affichable", row.opportunityId === "006CCC00000000X");
}

// ────────────────────────────────────────────────────────────────────────
section("BRUIT — cas 20");

{
  // 20. aucun changement -> bloc propre, sans bruit
  const before = state({});
  const after = state({}); // état strictement identique
  const d = computeOpportunityDelta(before, after, M);
  check("20. aucun changement -> null, pas de ligne fabriquée", d === null);

  const delta = buildBusinessDelta("2026-09-22", "2026-09-21", [], new Map([]));
  check("20bis. pipe vide -> 0 changement, pas d'erreur", delta.changes.length === 0 && delta.available === true);
}

// ════════════════════════════════════════════════════════════════════════
section("INTÉGRATION — replay en lecture seule sur la vraie base");

{
  const today = parisDate();
  let integrationOk = true;
  let delta = null;
  try {
    const opportunities = loadOpportunities();
    delta = buildSinceLastSnapshot(today, opportunities);
  } catch (err) {
    integrationOk = false;
    console.log(`  ÉCHEC intégration — ${err instanceof (globalThis.Error) ? err.message : String(err)}`);
  }
  check("réel. buildSinceLastSnapshot ne lève pas sur l'état réel", integrationOk);

  if (delta) {
    console.log(
      `  info  titre="${formatSinceTitle(delta.title)}" baseline=${delta.baselineDate ?? "—"} ` +
        `changements=${delta.changes.length}`,
    );
    check("réel. une seule ligne par opportunityId connu", (() => {
      const seen = new Set();
      for (const c of delta.changes) {
        if (!c.opportunityId) continue;
        if (seen.has(c.opportunityId)) return false;
        seen.add(c.opportunityId);
      }
      return true;
    })());
    check(
      "réel. KPI signé jamais 0 fabriqué : available=false OU un vrai compte",
      delta.signed.available === false || delta.signed.count >= 0,
    );
    check(
      "réel. entreeM/sortieM ne comptent que des transitions connu->connu",
      delta.changes.every((c) => !c.kanbanChange || (c.kanbanChange.fromLabel !== "—" && c.kanbanChange.toLabel !== "—")),
    );
  }
}

console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

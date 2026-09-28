/**
 * Tests du bloc « Momentum 7 jours » (Performance) — audit V3.2.
 *
 *   npm run momentum:verify
 *
 * Deux parties :
 *
 *   — cas obligatoires de la mission, joués sur des fixtures fabriquées pour
 *     `aggregateOwnerMomentum` (agrégation pure, aucun accès base) et
 *     `formatMomentumWindow` (tolérance ±1 jour autour de la cible J-7) ;
 *   — un contrôle d'intégration en LECTURE SEULE sur la vraie base, qui
 *     rejoue `buildMomentum` sur l'état réel et vérifie les invariants :
 *     aucune affaire dupliquée entre commerciaux, chaque commercial actif
 *     apparaît (même sans mouvement), aucun classement implicite (tri
 *     alphabétique, pas par magnitude).
 *
 * LECTURE SEULE de bout en bout : aucune écriture, aucune donnée fabriquée
 * n'est jamais insérée en base.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const {
  aggregateOwnerMomentum,
  momentumScore,
  buildMomentum,
  formatMomentumWindow,
} = await import(lib("since-last-snapshot"));
const { loadOpportunities } = await import(lib("repository"));
const { parisDate } = await import(lib("business-time"));
const { ATTENTION } = await import(lib("config"));
const { loadTeam } = await import(lib("team-store"));
const { movementsOf, quietOf } = await import(lib("momentum-wording"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

// Fixture minimale : un OpportunityDelta fabriqué, dimensions au choix.
const delta = (over) => ({
  opportunityId: "006TEST00000001",
  owner: "Test Commercial",
  client: "Affaire test",
  gmv: 100_000,
  signed: null,
  stageChange: null,
  gmvChange: null,
  kanbanChange: null,
  standbyChange: null,
  ...over,
});

// ────────────────────────────────────────────────────────────────────────
section("FENÊTRE ~7 JOURS — tolérance ±1 jour, trous inclus");

{
  check("6 jours -> 'Momentum sur 7 jours' (tolérance)", formatMomentumWindow({ available: true, baselineDate: "2026-09-16", today: "2026-09-22", days: 6 }) === "Momentum sur 7 jours");
  check("7 jours -> 'Momentum sur 7 jours' (exact)", formatMomentumWindow({ available: true, baselineDate: "2026-09-15", today: "2026-09-22", days: 7 }) === "Momentum sur 7 jours");
  check("8 jours -> 'Momentum sur 7 jours' (tolérance, cas réel du 22/09/2026)", formatMomentumWindow({ available: true, baselineDate: "2026-09-14", today: "2026-09-22", days: 8 }) === "Momentum sur 7 jours");
  const wide = formatMomentumWindow({ available: true, baselineDate: "2026-09-10", today: "2026-09-22", days: 12 });
  check("12 jours -> dates exactes, jamais 'sur 7 jours'", wide.includes("Momentum du") && !wide.includes("sur 7 jours"), wide);
  const narrow = formatMomentumWindow({ available: true, baselineDate: "2026-09-20", today: "2026-09-22", days: 2 });
  check("2 jours -> dates exactes (trop court pour '7 jours')", narrow.includes("Momentum du"), narrow);
  check("fenêtre indisponible -> message neutre, pas d'erreur", formatMomentumWindow({ available: false }).length > 0);
}

// ────────────────────────────────────────────────────────────────────────
section("SIGNÉ OFFICIEL");

{
  const list = [delta({ signed: { gmv: 42_000, signatureDate: "2026-09-20" } })];
  const o = aggregateOwnerMomentum("Test Commercial", list);
  check("signé : compte + GMV corrects", o.signed.count === 1 && o.signed.gmv === 42_000);
  check("signé : n'alimente aucune autre dimension par erreur", o.enteredM.count === 0 && o.gmvUp.count === 0 && o.stageChangedCount === 0);
}

// ────────────────────────────────────────────────────────────────────────
section("KNOWN -> M / M -> KNOWN");

{
  const entered = delta({ gmv: 30_000, kanbanChange: { fromLabel: "octobre 2026", toLabel: "septembre 2026", enteredM: true, exitedM: false } });
  const o1 = aggregateOwnerMomentum("Test Commercial", [entered]);
  check("known->M : compte + GMV (Opportunity.gmv) corrects", o1.enteredM.count === 1 && o1.enteredM.gmv === 30_000);
  check("known->M : sortieM reste à 0", o1.exitedM.count === 0);

  const exited = delta({ gmv: 45_000, kanbanChange: { fromLabel: "septembre 2026", toLabel: "octobre 2026", enteredM: false, exitedM: true } });
  const o2 = aggregateOwnerMomentum("Test Commercial", [exited]);
  check("M->known : compte + GMV corrects", o2.exitedM.count === 1 && o2.exitedM.gmv === 45_000);
  check("M->known : entréeM reste à 0", o2.enteredM.count === 0);
}

// ────────────────────────────────────────────────────────────────────────
section("VARIATION GMV — RÈGLE C, HAUSSE/BAISSE SÉPARÉES");

{
  const up = delta({ gmv: 92_000, gmvChange: { from: 36_000, to: 92_000, delta: 56_000, suspicious: false } });
  const down = delta({ opportunityId: "006TEST00000002", gmv: 57_000, gmvChange: { from: 223_000, to: 57_000, delta: -166_000, suspicious: true } });
  const o = aggregateOwnerMomentum("Test Commercial", [up, down]);
  check("hausse : comptée dans gmvUp uniquement", o.gmvUp.count === 1 && o.gmvUp.gmv === 56_000);
  check("baisse : comptée dans gmvDown uniquement, somme négative", o.gmvDown.count === 1 && o.gmvDown.gmv === -166_000);
  check("hausse et baisse jamais mélangées dans le même compteur", o.gmvUp.count + o.gmvDown.count === 2);
}

// ────────────────────────────────────────────────────────────────────────
section("DÉDUPLICATION");

{
  // Une affaire signée ET dont le stade a changé : une seule entrée dans la
  // liste (comme le garantit computeRawChanges), mais alimente deux
  // dimensions différentes — ce n'est PAS un double comptage (audit §5).
  const both = delta({
    signed: { gmv: 20_000, signatureDate: "2026-09-20" },
    stageChange: { from: "Examen devis", to: "Signé" },
  });
  const o = aggregateOwnerMomentum("Test Commercial", [both]);
  check("une affaire, deux dimensions -> chaque dimension comptée une fois", o.signed.count === 1 && o.stageChangedCount === 1);
  check("mais une seule affaire dans la liste passée (pas de duplication de ligne)", 1 === [both].length);
}

// ────────────────────────────────────────────────────────────────────────
section("AGRÉGATION PAR OWNER");

{
  const list = [
    delta({ opportunityId: "006A", gmv: 60_000, gmvChange: { from: 30_000, to: 60_000, delta: 30_000, suspicious: false } }),
    delta({ opportunityId: "006B", gmv: 25_000, stageChange: { from: "Etude dossier", to: "Visite artisan" } }),
    delta({ opportunityId: "006C", signed: { gmv: 15_000, signatureDate: "2026-09-21" } }),
  ];
  const o = aggregateOwnerMomentum("Test Commercial", list);
  check("3 affaires, 3 dimensions différentes -> chacune comptée dans sa métrique", o.gmvUp.count === 1 && o.stageChangedCount === 1 && o.signed.count === 1);
  check("owner porté correctement", o.owner === "Test Commercial");
}

// ────────────────────────────────────────────────────────────────────────
section("OPPORTUNITYID / LIEN SALESFORCE DANS topMoves");

{
  const list = [delta({ opportunityId: "006XYZ00000000A", gmv: 80_000, gmvChange: { from: 20_000, to: 80_000, delta: 60_000, suspicious: false } })];
  const o = aggregateOwnerMomentum("Test Commercial", list);
  check("topMoves non vide", o.topMoves.length === 1);
  check("opportunityId porté jusqu'au top move (résoluble en lien Salesforce)", o.topMoves[0]?.delta.opportunityId === "006XYZ00000000A");
}

// ────────────────────────────────────────────────────────────────────────
section("COMMERCIAL SANS MOUVEMENT / AVEC PLUSIEURS AFFAIRES");

{
  const empty = aggregateOwnerMomentum("Sans Mouvement", []);
  check("liste vide -> toutes les métriques à 0, pas d'erreur", empty.signed.count === 0 && empty.enteredM.count === 0 && empty.exitedM.count === 0 && empty.gmvUp.count === 0 && empty.gmvDown.count === 0 && empty.stageChangedCount === 0);
  check("liste vide -> topMoves vide, pas fabriqué", empty.topMoves.length === 0);
  check("liste vide -> owner toujours porté (visible, pas omis)", empty.owner === "Sans Mouvement");

  const many = Array.from({ length: 6 }, (_, i) => delta({
    opportunityId: `006MANY${i}`,
    gmv: 20_000 + i * 10_000,
    gmvChange: { from: 20_000 + i * 10_000 - 25_000, to: 20_000 + i * 10_000, delta: 25_000, suspicious: false },
  }));
  const busy = aggregateOwnerMomentum("Plusieurs Affaires", many);
  check("6 affaires du même commercial -> toutes comptées", busy.gmvUp.count === 6);
  check("topMoves plafonné à 3, jamais toute la liste", busy.topMoves.length === 3);
}

// ────────────────────────────────────────────────────────────────────────
section("AUCUNE NOTE NI CLASSEMENT IMPLICITE");

{
  const o = aggregateOwnerMomentum("Test Commercial", [delta({ signed: { gmv: 1000, signatureDate: "2026-09-20" } })]);
  check("aucun champ 'score'/'rank'/'note' dans OwnerMomentum", !("score" in o) && !("rank" in o) && !("note" in o) && !("ranking" in o));
}

// ────────────────────────────────────────────────────────────────────────
section("POPULATION PILOTÉE — pas de second nom en dur");

{
  // Le correctif visé : Sami Lazari (directeur régional) ne doit jamais
  // apparaître comme ligne Momentum. La règle vient de ATTENTION.excluded,
  // pas d'un nom recopié dans since-last-snapshot.ts.
  check(
    "ATTENTION.excluded contient Sami Lazari (config canonique, inchangée par ce correctif)",
    ATTENTION.excluded.includes("Sami Lazari"),
  );
}

// ════════════════════════════════════════════════════════════════════════
section("INTÉGRATION — replay en lecture seule sur la vraie base");

{
  const today = parisDate();
  let ok = true;
  let momentum = null;
  try {
    momentum = buildMomentum(today, loadOpportunities());
  } catch (err) {
    ok = false;
    console.log(`  ÉCHEC intégration — ${err instanceof Error ? err.message : String(err)}`);
  }
  check("buildMomentum ne lève pas sur l'état réel", ok);

  if (momentum) {
    console.log(`  info  fenêtre=${JSON.stringify(momentum.window)} commerciaux=${momentum.owners.length} affaires touchées=${momentum.totalOpportunitiesTouched}`);

    check(
      "aucune affaire dupliquée entre commerciaux (une affaire = un owner)",
      (() => {
        const seen = new Set();
        for (const o of momentum.owners) {
          for (const m of o.topMoves) {
            const id = m.delta.opportunityId;
            if (!id) continue;
            if (seen.has(id)) return false;
            seen.add(id);
          }
        }
        return true;
      })(),
    );

    check(
      "tri alphabétique des commerciaux, jamais par magnitude (aucun classement implicite)",
      momentum.owners.every((o, i) => i === 0 || o.owner.localeCompare(momentum.owners[i - 1].owner, "fr") >= 0),
    );

    check(
      "chaque commercial a au plus 3 affaires marquantes",
      momentum.owners.every((o) => o.topMoves.length <= 3),
    );

    check(
      "aucun champ score/rank/note sur les commerciaux réels",
      momentum.owners.every((o) => !("score" in o) && !("rank" in o)),
    );

    // Population des commerciaux/ET PILOTÉS uniquement — ATTENTION.excluded
    // (config.ts), la même liste que morning-priority.ts/week.ts/owner-signals.ts.
    const excludedSet = new Set(ATTENTION.excluded);
    check(
      "aucun commercial de ATTENTION.excluded n'apparaît comme ligne Momentum",
      momentum.owners.every((o) => !excludedSet.has(o.owner)),
      `exclus configurés : ${[...excludedSet].join(", ")}`,
    );
    if (momentum.window.available) {
      const expectedCount = loadTeam().filter((m) => !excludedSet.has(m.name)).length;
      check(
        `fenêtre disponible -> commerciaux pilotés attendus (${expectedCount}) = commerciaux affichés`,
        momentum.owners.length === expectedCount,
        `affichés : ${momentum.owners.length}`,
      );
    } else {
      check(
        "fenêtre indisponible sur cette base -> liste vide, cohérent (pas une exclusion cassée)",
        momentum.owners.length === 0,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
section("NOTE DE MOMENTUM /20 (lot de simplification C)");

{
  const agg = (list) => aggregateOwnerMomentum("Test Commercial", list);
  const neutral = momentumScore(agg([]));
  check("aucun mouvement -> 10/20 (semaine neutre)", neutral.score === 10 && neutral.impact === 0);
  const signed = momentumScore(agg([delta({ signed: { gmv: 50_000, signatureDate: "2026-09-20" } })]));
  check("50 k€ signés -> 15/20 (signé pèse plein)", signed.score === 15, String(signed.score));
  const up = momentumScore(agg([delta({ gmvChange: { from: 100_000, to: 150_000, delta: 50_000, suspicious: false } })]));
  check("+50 k€ de GMV déclarée -> 12,5/20 (déclaratif pèse moitié)", up.score === 12.5, String(up.score));
  const exit = momentumScore(agg([delta({ gmv: 80_000, kanbanChange: { fromLabel: "Sept.", toLabel: "Oct.", enteredM: false, exitedM: true } })]));
  check("sortie de M de 80 k€ -> 6/20", exit.score === 6, String(exit.score));
  const sb = momentumScore(agg([delta({ gmv: 100_000, standbyChange: { enteredStandby: true } })]));
  check("passage en stand-by de 100 k€ -> 7,5/20 (stand-by pèse un quart)", sb.score === 7.5, String(sb.score));
  const stage = momentumScore(agg([delta({ stageChange: { from: "Examen estimation", to: "Examen devis" } })]));
  check("un changement de stade seul ne bouge pas la note", stage.score === 10);
  const huge = momentumScore(agg([delta({ signed: { gmv: 900_000, signatureDate: "2026-09-20" } })]));
  const crash = momentumScore(agg([delta({ gmvChange: { from: 900_000, to: 0, delta: -900_000, suspicious: true } })]));
  check("bornée à 20 et à 0", huge.score === 20 && crash.score === 0);
  const odd = momentumScore(agg([delta({ signed: { gmv: 12_345, signatureDate: "2026-09-20" } })]));
  check("au demi-point, jamais de pseudo-précision", Number.isInteger(odd.score * 2), String(odd.score));
  check("l'explication somme exactement l'impact", Math.abs(odd.parts.reduce((t, p) => t + p.value, 0) - odd.impact) < 1e-6);

  // Une affaire = une contribution (verrous du 24/09/2026).
  const entreeSigne = momentumScore(agg([delta({ gmv: 50_000, signed: { gmv: 50_000, signatureDate: "2026-09-20" }, kanbanChange: { fromLabel: "Oct.", toLabel: "Sept.", enteredM: true, exitedM: false } })]));
  check("entrée dans M + signature de la même affaire : seule la signature compte (15/20, pas 17,5)", entreeSigne.score === 15, String(entreeSigne.score));
  const sortieStandby = momentumScore(agg([delta({ gmv: 138_000, kanbanChange: { fromLabel: "Sept.", toLabel: "Oct.", enteredM: false, exitedM: true }, standbyChange: { enteredStandby: true } })]));
  check("sortie de M + stand-by de la même affaire : pénalisée une seule fois (−69 k€ -> 3/20)", sortieStandby.score === 3 && Math.round(sortieStandby.impact) === -69_000, String(sortieStandby.score));
  const hausseStandby = momentumScore(agg([delta({ gmv: 111_000, gmvChange: { from: 25_000, to: 111_000, delta: 86_000, suspicious: false }, standbyChange: { enteredStandby: true } })]));
  check("signe conservé : hausse +43 k€ retenue face au stand-by −27,75 k€", Math.round(hausseStandby.impact) === 43_000, String(Math.round(hausseStandby.impact)));
  const egalite = momentumScore(agg([delta({ signed: { gmv: 20_000, signatureDate: "2026-09-20" }, gmvChange: { from: 60_000, to: 100_000, delta: 40_000, suspicious: false } })]));
  check("égalité exacte (signé 20 k€ vs hausse ½ × 40 k€) : la signature l'emporte", egalite.parts.find((p) => p.label === "signé").value === 20_000 && egalite.parts.find((p) => p.label === "hausses GMV").value === 0);
  const deux = momentumScore(agg([delta({ opportunityId: "006A", signed: { gmv: 30_000, signatureDate: "2026-09-20" } }), delta({ opportunityId: "006B", gmvChange: { from: 50_000, to: 90_000, delta: 40_000, suspicious: false } })]));
  check("deux affaires distinctes : chacune garde sa contribution (30 + 20 k€)", Math.round(deux.impact) === 50_000);
  const agr = aggregateOwnerMomentum("Test Commercial", [delta({ gmv: 50_000, signed: { gmv: 50_000, signatureDate: "2026-09-20" }, kanbanChange: { fromLabel: "Oct.", toLabel: "Sept.", enteredM: true, exitedM: false } })]);
  check("le tableau factuel garde toutes les dimensions (signé ET entrée dans M)", agr.signed.count === 1 && agr.enteredM.count === 1);
}

// ────────────────────────────────────────────────────────────────────────
section("LECTURE EN PHRASES — pluriels, ordre, zéros regroupés");

{
  const ids = (n, prefix) => Array.from({ length: n }, (_, i) => `006${prefix}${i}`);
  const o = aggregateOwnerMomentum("Test Commercial", [
    delta({ opportunityId: "006S0", signed: { gmv: 32_000, signatureDate: "2026-09-20" } }),
    ...ids(4, "U").map((id) => delta({ opportunityId: id, gmvChange: { from: 100_000, to: 118_250, delta: 18_250, suspicious: false } })),
    delta({ opportunityId: "006D0", gmvChange: { from: 266_000, to: 100_000, delta: -166_000, suspicious: false } }),
    ...ids(3, "E").map((id) => delta({ opportunityId: id, stageChange: { from: "A", to: "B" } })),
  ]);
  const texts = movementsOf(o).map((m) => m.text);
  check("signé positif seul : « GMV signé sur 7 jours · +32 k€ »", texts[0] === "GMV signé sur 7 jours · +32 k€", texts[0]);
  check("pluriel : « 4 affaires revues à la hausse · +73 k€ »", texts[1] === "4 affaires revues à la hausse · +73 k€", texts[1]);
  check("baisse : « 1 affaire revue à la baisse · −166 k€ »", texts[2] === "1 affaire revue à la baisse · −166 k€", texts[2]);
  check("étapes : « 3 affaires ont changé d’étape »", texts[3] === "3 affaires ont changé d’étape", texts[3]);
  check("ordre : hausses, puis baisses, puis neutre", movementsOf(o).map((m) => m.tone).join(",") === "up,up,down,neutral");
  const quiet = quietOf(o).join(" · ");
  check(
    "zéros regroupés en une ligne secondaire",
    quiet === "Aucune affaire avancée ou repoussée sur le mois · Aucune mise en pause / réactivation",
    quiet,
  );

  const mixed = movementsOf(
    aggregateOwnerMomentum("Test Commercial", [
      ...ids(2, "R").map((id) => delta({ opportunityId: id, standbyChange: { enteredStandby: false } })),
      delta({ opportunityId: "006P0", standbyChange: { enteredStandby: true } }),
      delta({ opportunityId: "006X0", gmv: 55_000, kanbanChange: { fromLabel: "Sept.", toLabel: "Oct.", enteredM: false, exitedM: true } }),
      delta({ opportunityId: "006X1", gmv: 86_000, kanbanChange: { fromLabel: "Oct.", toLabel: "Sept.", enteredM: true, exitedM: false } }),
    ]),
  ).map((m) => m.text);
  check("« 2 affaires réactivées » et « 1 affaire mise en pause »", mixed.includes("2 affaires réactivées") && mixed.includes("1 affaire mise en pause"), mixed.join(" | "));
  check(
    "« 1 affaire avancée sur ce mois · 86 k€ » et « 1 affaire repoussée hors de ce mois · 55 k€ »",
    mixed.includes("1 affaire avancée sur ce mois · 86 k€") && mixed.includes("1 affaire repoussée hors de ce mois · 55 k€"),
    mixed.join(" | "),
  );
  check("aucun mouvement : aucune phrase", movementsOf(aggregateOwnerMomentum("Test Commercial", [])).length === 0);
}

// ────────────────────────────────────────────────────────────────────────
section("SIGNÉ TRAVAUX — une ligne signée n'est pas une « affaire signée »");

{
  // Montants réels de la fenêtre du 21/09 au 28/09/2026 (audit du 28/09).
  const signedOnly = (lines) =>
    aggregateOwnerMomentum(
      "Test Commercial",
      lines.map(([id, gmv]) => delta({ opportunityId: id, signed: { gmv, signatureDate: "2026-09-22" } })),
    );
  const phrases = (o) => movementsOf(o).map((m) => `${m.tone}:${m.text}`);

  const valentin = signedOnly([["006WALBERT", -1036.57]]);
  const v = phrases(valentin);
  check("Valentin (WALBERT −1 036,57 €) : « Moins-value signée · −1 k€ », en baisse", v.length === 1 && v[0] === "down:Moins-value signée · −1 k€", v.join(" | "));
  check("jamais « affaire signée » pour une ligne négative", v.every((t) => !t.includes("affaire signée")));

  const anthony = phrases(signedOnly([["006STARKMAN", -157.92]]));
  check("petit montant (STARKMAN −157,92 €) : « −158 € », jamais « 0 k€ »", anthony[0] === "down:Moins-value signée · −158 €", anthony.join(" | "));

  const fontaine = phrases(signedOnly([["006BAUMANN", -1902.64]]));
  check("Fontaine (BAUMANN −1 902,64 €) : « Moins-value signée · −2 k€ »", fontaine[0] === "down:Moins-value signée · −2 k€", fontaine.join(" | "));

  const mixed = phrases(signedOnly([["006CHARVILLAT", 32_090.2], ["006PAROT", -1466.07], ["006SABOURAUD", -255]]));
  check(
    "coexistence : « GMV signé positif · +32 k€ » et « Moins-values signées · −2 k€ », séparés",
    mixed.join(" | ") === "up:GMV signé positif · +32 k€ | down:Moins-values signées · −2 k€",
    mixed.join(" | "),
  );

  const small = phrases(signedOnly([["006LEBIHAN", 278]]));
  check("petit positif : « GMV signé sur 7 jours · +278 € »", small[0] === "up:GMV signé sur 7 jours · +278 €", small.join(" | "));

  const nul = signedOnly([["006NUL", 0]]);
  check("total nul sur la fenêtre : aucune phrase de signé", movementsOf(nul).length === 0, phrases(nul).join(" | "));
  check("une moins-value n'affiche pas « Aucun GMV signé »", !quietOf(valentin).includes("Aucun GMV signé"));

  // La note ne dépend PAS de la formulation : la moins-value reste pénalisante.
  const sv = momentumScore(valentin);
  check("note Valentin inchangée : impact −1 036,57 €, 10/20 au demi-point", sv.impact === -1036.57 && sv.score === 10, `${sv.impact} -> ${sv.score}`);
  const sa = momentumScore(signedOnly([["006STARKMAN", -157.92]]));
  check("note Anthony (STARKMAN seul) : impact −157,92 €, pénalité conservée", sa.impact === -157.92 && sa.score === 10, `${sa.impact} -> ${sa.score}`);
  const sm = momentumScore(signedOnly([["006CHARVILLAT", 32_090.2], ["006PAROT", -1466.07], ["006SABOURAUD", -255]]));
  check("note mixte : impact = somme signée nette (30 369 €) -> 13/20", Math.round(sm.impact) === 30_369 && sm.score === 13, `${sm.impact} -> ${sm.score}`);
  check("le compteur factuel `signed` reste celui du moteur (3 opportunités, net)", signedOnly([["006CHARVILLAT", 32_090.2], ["006PAROT", -1466.07], ["006SABOURAUD", -255]]).signed.count === 3);
}

console.log(`\n  ${failures === 0 ? "Tous les contrôles passent." : `${failures} contrôle(s) en échec.`}\n`);
process.exit(failures === 0 ? 0 : 1);

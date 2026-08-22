/**
 * Audit fonctionnel V1 (C16).
 *
 *   npm run audit:v1
 *
 * Ne modifie rien. Vérifie qu'un même concept donne le même chiffre partout, et
 * traque les défauts qui trompent l'utilisateur : identifiant technique affiché
 * comme nom, faux zéro, affaire signée présentée comme du pipe, mélange de
 * fuseaux, commercial hors équipe.
 *
 * Le principe de lecture est simple : chaque contrôle nomme les DEUX endroits
 * comparés. Un écart n'est jamais rapporté sans dire entre quoi et quoi.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { getDb } = await import(lib("db"));
const { officialSignedGmv, officialMonthlyReference } = await import(lib("official-signed"));
const { buildExpectedGmvSnapshot } = await import(lib("expected-gmv-live"));
const { buildExpectedM1 } = await import(lib("expected-m1"));
const { buildForecastV2 } = await import(lib("forecast-v2"));
const { loadMorningEvents } = await import(lib("morning-events"));
const { TEAM } = await import(lib("config"));
const { matchTeamMember } = await import(lib("normalize"));

const db = getDb();
let blocking = 0;
let toFix = 0;
let total = 0;
const findings = [];

const check = (label, ok, detail = "", severity = "BLOQUANT V1") => {
  total += 1;
  if (!ok) {
    if (severity === "BLOQUANT V1") blocking += 1;
    else toFix += 1;
    findings.push({ label, detail, severity });
  }
  console.log(`  ${ok ? "ok   " : severity === "BLOQUANT V1" ? "BLOQUE" : "CORRIG"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const eur = (v) => `${(v ?? 0).toFixed(2)} €`;
const k = (v) => `${Math.round((v ?? 0) / 1000)} k€`;
const month = new Date().toISOString().slice(0, 7);

const snap = buildExpectedGmvSnapshot();
const m1 = buildExpectedM1();
const [fM, fM1, fM2] = [0, 1, 2].map((h) => buildForecastV2(h));
const { events } = loadMorningEvents();

console.log("\n════ AUDIT FONCTIONNEL V1 ════\n");
console.log("──── 3. COHÉRENCE CROISÉE DES CHIFFRES ────\n");

// --- Signé officiel : une seule source.
{
  const official = officialSignedGmv(month);
  check(
    "Signé officiel identique — source officielle vs Forecast M",
    Math.abs(official.gmv - fM.region.signedGmvActual) < 0.01,
    `${eur(official.gmv)} / ${eur(fM.region.signedGmvActual)}`,
  );
  check(
    "Signé officiel identique — source officielle vs Expected M",
    snap != null && Math.abs(official.gmv - snap.region.signedGmv) < 0.01,
    `${eur(official.gmv)} / ${eur(snap?.region.signedGmv)}`,
  );
}

// --- Expected M : Morning, Expected et Forecast lisent le même scoring.
{
  const drift = Math.abs((snap?.region.expectedRemaining ?? 0) - fM.region.expectedRemaining);
  check(
    "Expected M identique — service vs Forecast M",
    drift < 0.01,
    `écart ${eur(drift)} · scoré le ${snap?.scoredAt}`,
  );
  check(
    "zone probable présente et bornée",
    snap != null && snap.region.p10 <= snap.region.p50 && snap.region.p50 <= snap.region.p90,
    `${k(snap?.region.p10)} – ${k(snap?.region.p90)}`,
  );
}

// --- M+1 : la projection doit être la même partout, et jamais la somme des lignes.
{
  const fromForecast = fM1.expectedM1;
  check(
    "Projection M+1 identique — service vs Forecast M+1",
    m1 != null && fromForecast != null && Math.abs(m1.projection - fromForecast.projection) < 0.01,
    `${k(m1?.projection)} / ${k(fromForecast?.projection)}`,
  );
  check(
    "fourchette M+1 identique",
    m1 != null && fromForecast != null &&
      Math.abs(m1.rangeLo - fromForecast.rangeLo) < 0.01 &&
      Math.abs(m1.rangeHi - fromForecast.rangeHi) < 0.01,
    `${k(m1?.rangeLo)}–${k(m1?.rangeHi)}`,
  );
  const sumRows = fM1.salespeople
    .flatMap((s) => s.opportunities)
    .reduce((t, o) => t + (o.expectedGmv ?? 0), 0);
  check(
    "la somme des lignes M+1 n'est jamais la projection",
    m1 != null && Math.abs(m1.projection - sumRows) > 1,
    `projection ${k(m1?.projection)} · somme ${k(sumRows)}`,
  );
  check(
    "même génération M+1 des deux côtés",
    m1 != null && fromForecast != null && m1.generatedAt === fromForecast.generatedAt,
    m1?.generatedAt ?? "—",
  );
}

// --- M+2 : aucune projection hybride nulle part.
{
  check("M+2 ne porte aucune projection", fM2.expectedM1 == null && !fM2.expectedAvailable);
  check("M+2 ne produit aucune ligne jaune", fM2.examine.length === 0, `${fM2.examine.length}`);
  const withProb = fM2.salespeople
    .flatMap((s) => s.opportunities)
    .filter((o) => o.expectedProbability != null);
  check("M+2 n'affiche aucune probabilité individuelle", withProb.length === 0, `${withProb.length}`);
  check(
    "repère historique M+2 disponible",
    officialMonthlyReference(12) != null,
    k(officialMonthlyReference(12)?.monthlyAverage),
  );
}

console.log("\n──── 6/7/8. FORECAST ────\n");
for (const [name, board] of [["M", fM], ["M+1", fM1], ["M+2", fM2]]) {
  const rows = board.salespeople.flatMap((s) => s.opportunities);
  const ids = rows.map((o) => o.opportunityId);
  check(`${name} — aucun doublon d'affaire`, new Set(ids).size === ids.length, `${ids.length} ligne(s)`);
  const subtotal = board.salespeople.every(
    (s) => Math.abs(s.opportunities.reduce((t, o) => t + (o.expectedGmv ?? 0), 0) - s.expectedGmv) < 0.01,
  );
  check(`${name} — sous-totaux égaux à la somme des lignes`, subtotal);
  const owners = [...new Set(rows.map((o) => o.owner))];
  const outside = owners.filter((o) => matchTeamMember(o) == null);
  check(`${name} — aucun commercial hors équipe`, outside.length === 0, outside.join(", ") || `${owners.length} commercial(aux)`);
}
{
  const yellow = fM1.examine;
  const declared = new Set(
    fM1.salespeople
      .flatMap((s) => s.opportunities)
      .filter((o) => !o.outsideKanban && o.kanbanMonth === fM1.month)
      .map((o) => o.opportunityId),
  );
  check(
    "M+1 — aucune ligne jaune déjà déclarée sur le mois",
    yellow.every((e) => !declared.has(e.row.opportunityId)),
    `${yellow.length} ligne(s) jaune(s)`,
  );
  check(
    "M+1 — toutes les lignes jaunes au-dessus du seuil",
    yellow.every((e) => (e.row.expectedProbability ?? 0) >= 0.2),
  );
  check("M+1 — aucune ligne jaune gelée hors horizon", yellow.every((e) => !e.row.frozenMonthEnd));
}

console.log("\n──── 10/11/12. MORNING ────\n");
{
  const bad = events.filter((e) =>
    ["affaire_fermee", "affaire_hors_pipe", "inconnu"].includes(e.matchKind) && e.gmv != null,
  );
  check("aucun GMV de pipe sur une affaire non ouverte", bad.length === 0, `${bad.length}`);

  const signed = db
    .prepare(
      `SELECT COUNT(*) n FROM morning_event e
         JOIN mail_signal m ON m.gmail_message_id = e.gmail_message_id
         JOIN opportunity o ON o.opportunity_id = m.opportunity_id
        WHERE e.category IN ('chaud','attente') AND o.is_terminal = 1`,
    )
    .get().n;
  check("aucune affaire déjà signée dans le Morning actif", signed === 0, `${signed}`);

  const ixina = events.filter((e) => String(e.fromEmail).includes("ixina"));
  check("IXINA absent", ixina.length === 0);

  // Doublons : plusieurs messages du même fil, et même client plusieurs fois.
  const threads = new Map();
  for (const e of events) threads.set(e.threadId, (threads.get(e.threadId) ?? 0) + 1);
  const dupThreads = [...threads.values()].filter((n) => n > 1);
  const clients = new Map();
  for (const e of events) clients.set(e.client ?? e.fromEmail, (clients.get(e.client ?? e.fromEmail) ?? 0) + 1);
  const dupClients = [...clients.entries()].filter(([, n]) => n > 1);
  console.log(
    `  info  fils apparaissant plusieurs fois : ${dupThreads.length} fil(s), ${dupThreads.reduce((a, b) => a + b, 0)} action(s)`,
  );
  console.log(
    `  info  clients apparaissant plusieurs fois : ${dupClients.length} · ${dupClients.map(([c, n]) => `${c} ×${n}`).join(" · ")}`,
  );
  const strictDup = events.length - new Set(events.map((e) => e.messageId)).size;
  check("aucun doublon strict de message", strictDup === 0, `${strictDup}`);
}

console.log("\n──── 22. VALEURS AFFICHÉES ────\n");
{
  // Un identifiant Salesforce en guise de nom : le défaut signalé en C11.
  const ID = /^006[A-Za-z0-9]{12,15}$/;
  const idAsName = [
    ...events.filter((e) => ID.test(String(e.client))).map((e) => `Morning:${e.client}`),
    ...(snap?.opportunities ?? [])
      .filter((o) => ID.test(String(o.client)))
      .map((o) => `Expected:${o.client}`),
    ...fM.salespeople
      .flatMap((s) => s.opportunities)
      .filter((o) => ID.test(String(o.client)))
      .map((o) => `Forecast:${o.client}`),
    ...fM1.salespeople
      .flatMap((s) => s.opportunities)
      .filter((o) => ID.test(String(o.client)))
      .map((o) => `Forecast M+1:${o.client}`),
  ];
  check(
    "aucun identifiant Salesforce affiché comme nom de client",
    idAsName.length === 0,
    idAsName.slice(0, 4).join(" · ") || "aucun",
    "À CORRIGER AVANT UX",
  );

  const nullish = [
    ...events.map((e) => String(e.client)),
    ...(snap?.opportunities ?? []).map((o) => String(o.client)),
  ].filter((v) => v === "null" || v === "undefined" || v === "NaN");
  check("aucun null/undefined/NaN affiché", nullish.length === 0, `${nullish.length}`, "À CORRIGER AVANT UX");

  const rawOwners = [
    ...events.map((e) => e.salesperson),
    ...(snap?.salespeople ?? []).map((s) => s.salesperson),
  ].filter(Boolean);
  const unknown = [...new Set(rawOwners)].filter((o) => matchTeamMember(o) == null);
  check("aucun commercial non normalisé", unknown.length === 0, unknown.join(", ") || "—");
}

console.log("\n──── 23. MONTANTS ────\n");
{
  const neg = db
    .prepare("SELECT COUNT(*) n, COALESCE(SUM(gmv),0) s FROM travaux WHERE gmv < 0")
    .get();
  console.log(`  info  lignes Travaux négatives : ${neg.n} pour ${eur(neg.s)}`);
  const official = officialSignedGmv(month);
  const sum = official.rows.reduce((t, r) => t + r.gmv, 0);
  check(
    "le Signé officiel inclut bien les montants négatifs",
    Math.abs(sum - official.gmv) < 0.01,
    `${eur(official.gmv)} sur ${official.lines} ligne(s)`,
  );
}

console.log("\n──── 25. COMMERCIAUX ────\n");
{
  check("13 membres configurés", TEAM.length === 13, `${TEAM.length}`);
  const names = TEAM.map((t) => t.name);
  check("aucun doublon dans l'équipe", new Set(names).size === names.length);
  const owners = new Set(
    db.prepare("SELECT DISTINCT owner FROM opportunity WHERE is_terminal = 0").all().map((r) => r.owner),
  );
  const strays = [...owners].filter((o) => matchTeamMember(o) == null);
  check("aucun propriétaire hors équipe dans le pipe", strays.length === 0, strays.join(", ") || "—");
}

console.log("\n──── 24. DATES ET FUSEAU ────\n");
{
  // Un horodatage stocké sans fuseau se lit comme de l'UTC et décale l'affichage.
  const naive = db
    .prepare(
      `SELECT COUNT(*) n FROM expected_gmv_snapshot
        WHERE scored_at NOT LIKE '%Z' AND scored_at NOT LIKE '%+%' AND scored_at NOT LIKE '%-__:__'`,
    )
    .get().n;
  console.log(`  info  scorings sans fuseau explicite : ${naive}`);
  const perspective = fM.perspectiveDate;
  check(
    "date Perspective au format jour, sans heure inventée",
    perspective == null || /^\d{4}-\d{2}-\d{2}$/.test(perspective),
    perspective ?? "—",
  );
}

console.log("\n──── 15. STAND-BY ────\n");
{
  const frozenContributing = (snap?.opportunities ?? []).filter(
    (o) => o.frozenMonthEnd && o.expectedMonthEnd > 0,
  );
  check(
    "aucun stand-by gelé ne contribue à l'Expected du mois",
    frozenContributing.length === 0,
    `${frozenContributing.length}`,
  );
  const yellowFrozen = fM1.examine.filter((e) => e.row.frozenMonthEnd);
  check("aucun stand-by gelé en ligne jaune M+1", yellowFrozen.length === 0);
}

console.log("\n──── 21. ÉTATS VIDES ────\n");
{
  // Un total à zéro doit venir d'un vrai zéro, pas d'une jointure manquée.
  const suspicious = [];
  if (fM2.region.kanbanGmv === 0 && fM2.region.count > 0) suspicious.push("Kanban M+2 nul avec des lignes");
  if (fM.region.perspectiveGmv === 0 && fM.perspectiveDate != null) {
    suspicious.push("Perspective M nulle malgré un snapshot");
  }
  check("aucun faux zéro détecté", suspicious.length === 0, suspicious.join(" · ") || "—");
}

console.log("\n──── RÉSUMÉ ────\n");
console.log(`  contrôles          : ${total}`);
console.log(`  BLOQUANT V1        : ${blocking}`);
console.log(`  À CORRIGER AVANT UX: ${toFix}`);
if (findings.length > 0) {
  console.log("\n  défauts :");
  for (const f of findings) console.log(`    [${f.severity}] ${f.label} — ${f.detail}`);
}
console.log("");
process.exit(blocking > 0 ? 1 : 0);

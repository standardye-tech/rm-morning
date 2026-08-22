/**
 * Réconciliation du périmètre « Prévu par les commerciaux » entre deux photos.
 *
 *   npm run forecast:reconcile [-- --from 2026-08-16 --to 2026-08-17 --mois 2026-08]
 *
 * Sert à expliquer, opportunité par opportunité, un écart de total entre deux
 * états de la base. Les deux photos viennent de `opportunity_snapshot`, qui
 * n'est jamais écrasé d'un jour sur l'autre : c'est la seule source qui permette
 * de reconstituer ce que l'application affichait un jour donné.
 *
 * LECTURE SEULE.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { TERMINAL_STAGES, WON_STAGES } = await import(lib("config"));

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const from = arg("from", "2026-08-16");
const to = arg("to", "2026-08-17");
const month = arg("mois", "2026-08");
const [year, mon] = month.split("-").map(Number);

const db = new DatabaseSync(path.resolve(process.cwd(), "data/rm-morning.db"), { readOnly: true });

const eur = (v) => `${Math.round(v ?? 0).toLocaleString("fr-FR")} €`;
const kEur = (v) => `${Math.round((v ?? 0) / 1000).toLocaleString("fr-FR")} k€`;

// Le snapshot quotidien ne porte pas `is_terminal` : on le reconstruit depuis
// l'étape historisée, avec la même liste que l'import.
const terminal = new Set([...TERMINAL_STAGES, ...WON_STAGES, "Affaire perdue"]);
const isTerminal = (stage) => terminal.has(stage ?? "");

const photo = (date) => {
  const rows = db
    .prepare(
      `SELECT s.opportunity_id, s.owner, s.gmv, s.stage, s.kanban_raw, s.kanban_year, s.kanban_month,
              s.is_standby, s.standby_until, s.import_id
         FROM opportunity_snapshot s
        WHERE s.snapshot_date = ?`,
    )
    .all(date);
  const inMonth = rows.filter(
    (r) =>
      r.kanban_year === year &&
      r.kanban_month === mon &&
      r.is_standby === 0 &&
      !isTerminal(r.stage),
  );
  return { all: new Map(rows.map((r) => [r.opportunity_id, r])), kept: inMonth };
};

const a = photo(from);
const b = photo(to);

const sum = (rows) => rows.reduce((t, r) => t + (r.gmv ?? 0), 0);
const totalA = sum(a.kept);
const totalB = sum(b.kept);

console.log(`\n════ PRÉVU PAR LES COMMERCIAUX — ${month} ════`);
console.log(`  photo du ${from} : ${a.kept.length} affaires · ${eur(totalA)}  (import ${a.kept[0]?.import_id ?? "—"})`);
console.log(`  photo du ${to} : ${b.kept.length} affaires · ${eur(totalB)}  (import ${b.kept[0]?.import_id ?? "—"})`);
console.log(`  écart : ${eur(totalB - totalA)}`);

const keptA = new Map(a.kept.map((r) => [r.opportunity_id, r]));
const keptB = new Map(b.kept.map((r) => [r.opportunity_id, r]));

// État actuel, pour dire où l'affaire en est aujourd'hui.
const current = new Map(
  db
    .prepare(
      `SELECT opportunity_id, client_contact, owner, gmv, stage, kanban_raw, kanban_year,
              kanban_month, is_standby, standby_until, is_terminal
         FROM opportunity`,
    )
    .all()
    .map((r) => [r.opportunity_id, r]),
);

const kanbanOf = (r) =>
  r && r.kanban_year && r.kanban_month ? `${r.kanban_year}-${String(r.kanban_month).padStart(2, "0")}` : "—";

/** Pourquoi l'affaire est sortie du périmètre entre les deux photos. */
function reason(id) {
  const before = a.all.get(id);
  const after = b.all.get(id);
  if (!after) return "absente de la photo suivante (hors périmètre importé)";
  if (isTerminal(after.stage)) return `devenue terminale — étape « ${after.stage} »`;
  if (after.is_standby === 1)
    return `passée en stand-by jusqu'au ${(after.standby_until ?? "").slice(0, 10) || "?"}`;
  const kb = kanbanOf(after);
  if (kb !== month) {
    return kb === "—"
      ? "Projection Kanban effacée par le commercial"
      : `Projection Kanban déplacée sur ${kb}`;
  }
  if ((before?.gmv ?? 0) !== (after.gmv ?? 0)) return "maintenue, GMV modifié";
  return "maintenue";
}

const out = [];
for (const id of new Set([...keptA.keys(), ...keptB.keys()])) {
  const before = keptA.get(id) ?? null;
  const after = keptB.get(id) ?? null;
  const cur = current.get(id) ?? null;
  out.push({
    id,
    client: cur?.client_contact ?? before?.owner ?? id,
    owner: cur?.owner ?? before?.owner ?? "—",
    gmvA: before?.gmv ?? null,
    kanbanA: before ? kanbanOf(before) : "—",
    stageA: before?.stage ?? a.all.get(id)?.stage ?? "—",
    gmvB: cur?.gmv ?? null,
    kanbanB: cur ? kanbanOf(cur) : "—",
    stageB: cur?.stage ?? "—",
    standby: cur?.is_standby === 1,
    standbyUntil: (cur?.standby_until ?? "").slice(0, 10) || null,
    terminal: cur?.is_terminal === 1,
    inA: before != null,
    inB: after != null,
    reason: before != null && after == null ? reason(id) : after != null && before == null ? "entrée dans le périmètre" : reason(id),
    delta: (after?.gmv ?? 0) - (before?.gmv ?? 0),
  });
}
out.sort((x, y) => x.delta - y.delta);

console.log(`\n──── DÉTAIL, OPPORTUNITÉ PAR OPPORTUNITÉ ────`);
console.log(
  `  ${"ID".padEnd(17)}${"Client".padEnd(26)}${"Commercial".padEnd(20)}` +
    `${"GMV " + from.slice(5)}`.padStart(12) +
    `${"Kanban".padStart(9)}${"GMV " + to.slice(5)}`.padStart(21) +
    `${"Kanban".padStart(9)}  Raison`,
);
for (const r of out) {
  console.log(
    `  ${r.id.padEnd(17)}${String(r.client).slice(0, 24).padEnd(26)}${String(r.owner).slice(0, 18).padEnd(20)}` +
      `${(r.gmvA == null ? "—" : eur(r.gmvA)).padStart(12)}${r.kanbanA.padStart(9)}` +
      `${(r.gmvB == null ? "—" : eur(r.gmvB)).padStart(12)}${r.kanbanB.padStart(9)}` +
      `  ${r.reason}`,
  );
}

console.log(`\n──── ÉTAT ACTUEL DES SORTANTES ────`);
console.log(`  ${"ID".padEnd(17)}${"Étape actuelle".padEnd(22)}${"stand-by".padStart(12)}${"terminale".padStart(11)}`);
for (const r of out.filter((x) => x.inA && !x.inB)) {
  console.log(
    `  ${r.id.padEnd(17)}${String(r.stageB).slice(0, 20).padEnd(22)}` +
      `${(r.standby ? `oui → ${r.standbyUntil}` : "non").padStart(12)}${(r.terminal ? "oui" : "non").padStart(11)}`,
  );
}

// --- Réconciliation arithmétique, qui doit tomber à zéro.
const leaving = out.filter((r) => r.inA && !r.inB);
const entering = out.filter((r) => !r.inA && r.inB);
const staying = out.filter((r) => r.inA && r.inB);
const lostGmv = sum(leaving.map((r) => ({ gmv: r.gmvA })));
const gainedGmv = sum(entering.map((r) => ({ gmv: r.gmvB })));
const movedGmv = staying.reduce((t, r) => t + ((r.gmvB ?? 0) - (r.gmvA ?? 0)), 0);

console.log(`\n──── RÉCONCILIATION ────`);
console.log(`  total ${from}                       ${eur(totalA).padStart(14)}`);
console.log(`  − sorties du périmètre (${String(leaving.length).padStart(2)} affaires) ${eur(-lostGmv).padStart(14)}`);
console.log(`  + entrées dans le périmètre (${String(entering.length).padStart(2)} aff.) ${eur(gainedGmv).padStart(14)}`);
console.log(`  ± GMV révisé sur les maintenues (${String(staying.length).padStart(2)})  ${eur(movedGmv).padStart(14)}`);
console.log(`  ${"".padEnd(38, "─")}`);
const rebuilt = totalA - lostGmv + gainedGmv + movedGmv;
console.log(`  total reconstitué                  ${eur(rebuilt).padStart(14)}`);
console.log(`  total ${to} observé              ${eur(totalB).padStart(14)}`);
const gap = rebuilt - totalB;
console.log(`  écart résiduel                     ${eur(gap).padStart(14)}  ${Math.abs(gap) < 0.005 ? "→ réconcilié" : "→ NON RÉCONCILIÉ"}`);

// --- Motifs agrégés.
const byReason = {};
for (const r of leaving) {
  const key = r.reason.replace(/ jusqu'au .*/, "").replace(/ sur \d{4}-\d{2}/, " sur un autre mois").replace(/ — étape .*/, "");
  byReason[key] = byReason[key] ?? { n: 0, gmv: 0 };
  byReason[key].n += 1;
  byReason[key].gmv += r.gmvA ?? 0;
}
console.log(`\n──── MOTIFS DE SORTIE ────`);
for (const [key, v] of Object.entries(byReason).sort((x, y) => y[1].gmv - x[1].gmv)) {
  console.log(`  ${key.padEnd(46)}${String(v.n).padStart(3)} affaires  ${kEur(v.gmv).padStart(10)}`);
}

db.close();
process.exit(Math.abs(gap) < 0.005 ? 0 : 1);

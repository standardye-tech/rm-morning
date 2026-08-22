import Link from "next/link";

import {
  MOVEMENT_LABEL,
  type ForecastMonthBoard,
  type ForecastMovement,
  type ForecastRow,
  type ForecastSalespersonBlock,
} from "@/lib/forecast-board";
import { formatEur, formatEurShort } from "@/lib/normalize";
import { Badge, Card, EmptyState, SectionTitle, Stat } from "./ui";

const MOVEMENT_TONE: Record<ForecastMovement, "neutral" | "positive" | "warning" | "danger"> = {
  stable: "neutral",
  renforce: "positive",
  glissement: "warning",
  revenu: "positive",
  sorti: "danger",
  nouveau: "positive",
  non_comparable: "neutral",
};

const eur = (v: number | null) => (v == null ? "—" : formatEurShort(v));

/**
 * Montants de la bande de synthèse, en milliers d'euros sans arrondi au
 * million. « Projection Kanban » et « Signé + projeté » ne doivent jamais
 * s'afficher identiques par un simple effet d'arrondi : ces deux KPI ont un
 * sens différent, et le brief exige qu'aucune ambiguïté ne subsiste.
 */
const kEur = (v: number | null) =>
  v == null ? "—" : `${Math.round(v / 1000).toLocaleString("fr-FR")} k€`;

/**
 * Bande de synthèse. Chaque KPI est nommé sans ambiguïté : « restant à
 * signer » et « signé + projeté » ne sont jamais confondus.
 */
export function ForecastSummary({ board }: { board: ForecastMonthBoard }) {
  return (
    <>
      <Card className="grid grid-cols-2 divide-x divide-line md:grid-cols-3 lg:grid-cols-6">
        {board.isCurrentMonth ? (
          <Stat
            label="Signé à date"
            value={kEur(board.region.signedGmv)}
            tone="positive"
            hint={`${board.region.signedCount} affaires réalisées`}
          />
        ) : null}
        <Stat
          label="Projection Kanban"
          value={kEur(board.region.kanbanGmv)}
          hint={`${board.region.count} affaires — restant à signer`}
        />
        {board.isCurrentMonth ? (
          <Stat
            label="Signé + projeté"
            value={kEur(board.region.signedPlusKanban)}
            hint="si le Kanban se réalise"
          />
        ) : null}
        <Stat
          label="Perspective"
          value={kEur(board.region.perspectiveGmv)}
          hint={
            board.perspectiveDate
              ? `snapshot du ${new Date(board.perspectiveDate).toLocaleDateString("fr-FR")}`
              : "aucun snapshot"
          }
        />
        <Stat label="Expected GMV" value="—" hint="prévision statistique à venir" />
        {board.isCurrentMonth ? (
          <Stat
            label="Objectif régional"
            value={board.region.objective == null ? "—" : kEur(board.region.objective)}
            hint={board.region.objective == null ? "non configuré" : "écart calculé sur signé + projeté"}
          />
        ) : (
          <Stat label="Opportunités" value={`${board.region.count}`} hint="projetées sur le mois" />
        )}
      </Card>
      {board.issues.length > 0 ? (
        <Card className="mt-3 px-4 md:px-6 py-3">
          <ul className="space-y-1">
            {board.issues.map((issue, i) => (
              <li key={i} className="text-xs text-ink-faint">
                {issue}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function Row({ row }: { row: ForecastRow }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 md:px-6 py-2">
        <p className="truncate font-medium">{row.client}</p>
      </td>
      <td className="px-3 py-2 text-xs text-ink-soft">{row.stage ?? "—"}</td>
      <td className="tabular px-3 py-2 text-right font-medium">{formatEur(row.gmv)}</td>
      <td className="px-3 py-2 text-center text-xs">{row.kanbanRaw ?? "—"}</td>
      <td className="tabular px-3 py-2 text-right text-xs text-ink-soft">
        {eur(row.perspectiveGmv)}
      </td>
      <td className="px-3 py-2">
        <Badge tone={MOVEMENT_TONE[row.movement]}>{MOVEMENT_LABEL[row.movement]}</Badge>
      </td>
      <td className="px-3 py-2 text-xs text-ink-soft">{row.nextExpectedLabel ?? "—"}</td>
      <td className="px-3 py-2 text-xs">
        {row.reading ? <span className="text-warning">{row.reading}</span> : <span className="text-ink-faint">—</span>}
      </td>
      <td className="px-3 py-2 text-center text-xs text-ink-faint">—</td>
      <td className="px-4 md:px-6 py-2 text-right text-xs text-ink-faint">—</td>
    </tr>
  );
}

function SalespersonGroup({
  block,
  month,
}: {
  block: ForecastSalespersonBlock;
  month: string;
}) {
  return (
    <>
      <tr className="border-b border-line-strong bg-canvas">
        <td colSpan={2} className="px-4 md:px-6 py-2.5">
          <Link
            href={`/forecast?mois=${month}&commercial=${encodeURIComponent(block.salesperson)}`}
            className="text-sm font-semibold hover:underline"
          >
            {block.salesperson}
          </Link>
          <span className="ml-2 text-xs text-ink-soft">
            {block.count} affaire{block.count > 1 ? "s" : ""}
            {block.signedCount > 0 ? ` · ${block.signedCount} signée${block.signedCount > 1 ? "s" : ""}` : ""}
          </span>
        </td>
        <td className="tabular px-3 py-2.5 text-right text-sm font-semibold">
          {formatEur(block.kanbanGmv)}
        </td>
        <td className="px-3 py-2.5" />
        <td className="tabular px-3 py-2.5 text-right text-xs font-medium text-ink-soft">
          {eur(block.perspectiveGmv)}
        </td>
        <td colSpan={3} className="px-3 py-2.5 text-xs text-ink-soft">
          {block.signedGmv > 0 ? `Signé ce mois : ${eur(block.signedGmv)}` : ""}
        </td>
        <td colSpan={2} className="px-4 md:px-6 py-2.5" />
      </tr>
      {block.opportunities
        .slice()
        .sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0))
        .map((row) => (
          <Row key={row.opportunityId} row={row} />
        ))}
    </>
  );
}

/** Le tableau : Région → Commercial → Opportunité. C'est la pièce centrale. */
export function ForecastTable({
  board,
  blocks,
}: {
  board: ForecastMonthBoard;
  blocks: ForecastSalespersonBlock[];
}) {
  const count = blocks.reduce((s, b) => s + b.count, 0);
  const kanban = blocks.reduce((s, b) => s + b.kanbanGmv, 0);
  const perspective = blocks.reduce((s, b) => s + b.perspectiveGmv, 0);
  const signed = blocks.reduce((s, b) => s + b.signedGmv, 0);

  return (
    <Card className="mt-6">
      <SectionTitle
        title={`Forecast ${board.monthLabel}`}
        aside={
          board.perspectiveDate
            ? `Perspective au ${new Date(board.perspectiveDate).toLocaleDateString("fr-FR")}`
            : "sans Perspective"
        }
      />
      {blocks.length === 0 ? (
        <EmptyState>Aucune opportunité projetée sur ce mois avec ce filtre.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 md:px-6 py-2 font-medium">Client / Opportunité</th>
                <th className="px-3 py-2 font-medium">Étape</th>
                <th className="px-3 py-2 text-right font-medium">GMV</th>
                <th className="px-3 py-2 text-center font-medium">Kanban</th>
                <th className="px-3 py-2 text-right font-medium">Perspective</th>
                <th className="px-3 py-2 font-medium">Évolution</th>
                <th className="px-3 py-2 font-medium">Prochain jalon</th>
                <th className="px-3 py-2 font-medium">Lecture RM</th>
                <th className="px-3 py-2 text-center font-medium">Exp. %</th>
                <th className="px-4 md:px-6 py-2 text-right font-medium">Exp. GMV</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((block) => (
                <SalespersonGroup key={block.salesperson} block={block} month={board.month} />
              ))}
              <tr className="border-t-2 border-line-strong bg-canvas">
                <td className="px-4 md:px-6 py-3 text-sm font-semibold">TOTAL RÉGION</td>
                <td className="px-3 py-3 text-xs text-ink-soft">
                  {count} affaire{count > 1 ? "s" : ""}
                </td>
                <td className="tabular px-3 py-3 text-right text-base font-semibold">
                  {formatEur(kanban)}
                </td>
                <td className="px-3 py-3" />
                <td className="tabular px-3 py-3 text-right text-sm font-medium text-ink-soft">
                  {eur(perspective)}
                </td>
                <td colSpan={3} className="px-3 py-3 text-xs text-ink-soft">
                  {signed > 0 ? `Signé ce mois : ${eur(signed)}` : ""}
                </td>
                <td colSpan={2} className="px-4 md:px-6 py-3 text-right text-xs text-ink-faint">
                  Expected à venir
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-4 md:px-6 py-3 text-xs leading-relaxed text-ink-faint">
        « Projection Kanban » est le déclaratif actuel du commercial dans Salesforce.
        « Perspective » est la dernière photographie hebdomadaire de ce déclaratif — les deux ne
        sont jamais confondus. « Expected GMV » est une prévision statistique qui n&apos;existe pas
        encore : rien n&apos;est simulé à sa place.
      </p>
    </Card>
  );
}

/** Répond à « pourquoi le forecast a-t-il baissé depuis la semaine dernière ? ». */
// Ces deux blocs ne lisent que les mouvements du déclaratif : les typer sur la
// part du modèle qu'ils utilisent réellement les rend réutilisables par Forecast
// V2, dont les lignes portent en plus l'Expected.
export function ForecastExits({
  board,
}: {
  board: Pick<ForecastMonthBoard, "exits" | "month" | "monthLabel">;
}) {
  if (board.exits.length === 0) return null;
  const total = board.exits.reduce((s, e) => s + (e.perspectiveGmv ?? 0), 0);
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Depuis la dernière Perspective"
        title="Sorties du mois"
        aside={`${board.exits.length} affaires · ${eur(total)} projetés`}
      />
      <ul className="divide-y divide-line">
        {board.exits
          .slice()
          .sort((a, b) => (b.perspectiveGmv ?? 0) - (a.perspectiveGmv ?? 0))
          .map((e) => (
            <li
              key={e.opportunityId}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 md:px-6 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{e.client}</p>
                <p className="text-xs text-ink-faint">
                  {e.owner} · {e.destination}
                </p>
              </div>
              <p className="tabular text-xs text-ink-soft">{eur(e.perspectiveGmv)}</p>
            </li>
          ))}
      </ul>
    </Card>
  );
}

/** Bloc secondaire, sur règles existantes uniquement. */
export function ForecastCandidates({
  board,
}: {
  board: Pick<ForecastMonthBoard, "candidates" | "month" | "monthLabel">;
}) {
  if (board.candidates.length === 0) return null;
  return (
    <Card className="mt-6">
      <SectionTitle
        eyebrow="Secondaire"
        title="Candidats à examiner pour ce mois"
        aside={`${board.candidates.length}`}
      />
      <ul className="divide-y divide-line">
        {board.candidates.map((c) => (
          <li
            key={c.opportunityId}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 md:px-6 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{c.client}</p>
              <p className="text-xs text-ink-faint">
                {c.owner} · {c.stage} · projetée {c.kanbanMonth}
              </p>
            </div>
            <p className="tabular text-sm">{formatEur(c.gmv)}</p>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 md:px-6 py-3 text-xs text-ink-faint">
        Affaires projetées sur le mois suivant mais déjà en étape Signature, ou dont le prochain
        jalon est la signature. Règles existantes uniquement — aucune prédiction.
      </p>
    </Card>
  );
}

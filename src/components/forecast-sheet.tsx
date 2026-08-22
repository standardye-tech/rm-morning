"use client";

import { useState } from "react";

import { Badge } from "@/components/ui";
import {
  MOVEMENT_LABEL,
  type ChallengeKind,
  type ForecastMovement,
} from "@/lib/forecast-labels";
import type { ForecastV2Row } from "@/lib/forecast-v2";
import { formatEur, formatEurShort, formatFrenchDate } from "@/lib/normalize";
import { LABEL, kEur, pct } from "@/lib/vocabulary";

/**
 * La feuille de rapprochement Forecast.
 *
 * Parti pris : ceci n'est pas un tableau de bord, c'est un classeur. Pas de
 * carte autour de chaque commercial, pas de marge décorative, des en-têtes de
 * section d'une seule ligne — l'écran doit ressembler à la feuille Perspective
 * que le directeur régional tient à la main.
 *
 * Composant client pour une seule raison : replier et déplier un commercial,
 * sans rechargement ni perte de position.
 *
 * Il n'existe plus de second niveau d'affaires « secondaires » : la page décide
 * seule de ce qui est visible, et ce qu'elle écarte n'est pas transmis ici. Un
 * dépliage local rouvrirait ce que la règle de visibilité ferme.
 */

const MOVEMENT_TONE: Record<ForecastMovement, "neutral" | "positive" | "warning" | "danger"> = {
  stable: "neutral",
  renforce: "positive",
  glissement: "warning",
  revenu: "positive",
  sorti: "danger",
  nouveau: "positive",
  non_comparable: "neutral",
};

export type SheetRow = ForecastV2Row & {
  /** Motif de challenge, quand l'affaire en porte un. */
  challenge: { kind: ChallengeKind; reason: string } | null;
};

export type SheetGroup = {
  salesperson: string;
  signedGmv: number;
  kanbanGmv: number;
  /** Part de la Perspective encore ouverte : c'est ce que la colonne totalise. */
  perspectiveGmv: number;
  /** Total du snapshot du commercial, affiché en en-tête de groupe. */
  perspectiveSnapshotGmv: number;
  expectedGmv: number;
  rows: SheetRow[];
};

/** Le mois suivant, pour dire « déplacé à septembre » plutôt qu'un code. */
const MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function monthName(key: string | null): string | null {
  if (!key) return null;
  const [, m] = key.split("-");
  return MONTHS[Number(m) - 1] ?? key;
}

/**
 * La colonne de lecture métier.
 *
 * Pour une affaire jaune, le motif de challenge suffit — le fond coloré porte
 * déjà l'alerte. Pour les autres, c'est le mouvement depuis la dernière
 * Perspective.
 */
function situation(
  row: SheetRow,
  /** Mois de la vue, pour dire « pas prévu pour septembre » et non « pas prévu ». */
  viewMonth: string | null,
): { label: string; tone: "neutral" | "positive" | "warning" | "danger" } {
  if (row.challenge) {
    // Sur M+1 le motif est unique : l'affaire pourrait signer le mois prochain et
    // n'y est pas déclarée. Nommer le mois cible évite l'ambiguïté quand la ligne
    // porte par ailleurs un mois Kanban différent.
    const suffix =
      row.challenge.kind === "non_prevue_m1"
        ? `pas prévu pour ${monthName(viewMonth) ?? "le mois prochain"}${
            row.kanbanMonth ? `, annoncé en ${monthName(row.kanbanMonth)}` : ""
          }`
        : row.challenge.kind === "prevue_mois_suivant"
          ? `prévu en ${monthName(row.kanbanMonth) ?? "mois suivant"}`
          : row.challenge.kind === "declaree_fragile"
            ? "prévu mais fragile"
            : row.kanbanMonth
              ? `prévu en ${monthName(row.kanbanMonth)}`
              : "pas prévu";
    return { label: `À challenger — ${suffix}`, tone: "warning" };
  }
  return { label: MOVEMENT_LABEL[row.movement], tone: MOVEMENT_TONE[row.movement] };
}

function Row({
  row,
  showExpected,
  viewMonth,
}: {
  row: SheetRow;
  showExpected: boolean;
  viewMonth: string | null;
}) {
  const s = situation(row, viewMonth);
  return (
    <tr className={`border-b border-line/70 last:border-0 ${row.challenge ? "bg-warning-soft/40" : ""}`}>
      <td className="py-[3px] pl-6 pr-3">
        <span className="font-medium">{row.client}</span>
        {row.nextExpectedLabel || row.isStandby ? (
          <span className="ml-2 text-xs text-ink-faint">
            {row.isStandby
              ? `gelée jusqu'au ${formatFrenchDate(row.standbyUntil?.slice(0, 10) ?? null)}`
              : row.nextExpectedLabel}
          </span>
        ) : null}
      </td>
      <td className="tabular whitespace-nowrap px-3 py-[3px] text-right font-medium">{formatEurShort(row.gmv)}</td>
      <td className="whitespace-nowrap px-3 py-[3px] text-center text-xs">
        {row.outsideKanban ? (
          <span className="text-ink-faint">{monthName(row.kanbanMonth) ?? "—"}</span>
        ) : (
          <span className="text-ink-soft">{row.kanbanRaw ?? "oui"}</span>
        )}
      </td>
      <td className="tabular whitespace-nowrap px-3 py-[3px] text-center text-xs">
        {row.perspectiveGmv == null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <span className="text-ink-soft">{formatEurShort(row.perspectiveGmv)}</span>
        )}
      </td>
      {showExpected ? (
        <td className="whitespace-nowrap px-3 py-[3px] text-right">
          <span className="tabular">{pct(row.expectedProbability)}</span>
          {row.expectedGmv != null && row.expectedGmv > 0 ? (
            <span className="tabular ml-1.5 text-xs text-ink-faint">
              {formatEurShort(row.expectedGmv)}
            </span>
          ) : null}
        </td>
      ) : null}
      <td className="py-[3px] pl-3 pr-6 text-xs">
        <Badge tone={s.tone}>{s.label}</Badge>
      </td>
    </tr>
  );
}

function Group({
  group,
  showExpected,
  collapsed,
  viewMonth,
}: {
  group: SheetGroup;
  showExpected: boolean;
  collapsed: boolean;
  viewMonth: string | null;
}) {
  const [open, setOpen] = useState(!collapsed);

  const rows = group.rows;
  const yellow = rows.filter((r) => r.challenge).length;
  const columns = showExpected ? 6 : 5;

  return (
    <>
      {/*
        Rupture de ligne de tableur, pas carte : un simple filet haut plus marqué
        et un fond très légèrement teinté suffisent à séparer deux commerciaux.
        Un bloc massif casserait le balayage vertical sur 282 lignes.
      */}
      <tr className="border-t border-line-strong bg-canvas/70">
        <th colSpan={columns} className="py-1 pl-6 pr-6 text-left font-normal">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="-my-2 flex w-full flex-wrap items-baseline gap-x-3 py-2 text-left md:my-0 md:py-0"
          >
            <span aria-hidden className="text-xs text-ink-faint">
              {open ? "▾" : "▸"}
            </span>
            <span className="text-sm font-semibold">{group.salesperson}</span>
            <span className="tabular text-xs text-ink-soft">
              Prévu {kEur(group.kanbanGmv)} · Perspective {kEur(group.perspectiveSnapshotGmv)}
              {group.signedGmv > 0 ? ` · Signé ${kEur(group.signedGmv)}` : ""}
              {showExpected ? ` · GMV probable ${kEur(group.expectedGmv)}` : ""}
              {` · ${rows.length} affaire${rows.length > 1 ? "s" : ""}`}
            </span>
            {yellow > 0 ? (
              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-xs font-medium text-warning">
                {yellow} à challenger
              </span>
            ) : null}
          </button>
        </th>
      </tr>
      {open
        ? rows.map((r) => (
            <Row key={r.opportunityId} row={r} showExpected={showExpected} viewMonth={viewMonth} />
          ))
        : null}
    </>
  );
}

export function ForecastSheet({
  groups,
  showExpected,
  totals,
  /**
   * En-tête de la colonne de probabilité. Sur M elle demande « ce mois », sur M+1
   * « en septembre » : la même colonne ne pose pas la même question selon la vue,
   * et deux écrans qui se ressemblent doivent le dire explicitement.
   */
  probabilityLabel = LABEL.chanceThisMonth,
  /** Mois de la vue, au format AAAA-MM. */
  viewMonth = null,
  /** Libellé du pied de tableau, qui n'est pas un total de mois sur M+1. */
  expectedFooterLabel,
}: {
  groups: SheetGroup[];
  showExpected: boolean;
  totals: { signed: number; kanban: number; perspective: number; expected: number; count: number };
  probabilityLabel?: string;
  viewMonth?: string | null;
  expectedFooterLabel?: string;
}) {
  const [allCollapsed, setAllCollapsed] = useState(false);
  // La clé force le remontage des groupes : « Tout replier » et « Tout déplier »
  // doivent reprendre la main sur les groupes ouverts ou fermés à la main.
  const [generation, setGeneration] = useState(0);

  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 md:px-6 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">
          {groups.length} commerciaux · {totals.count} affaires prévues sur le mois
        </span>
        <button
          type="button"
          onClick={() => {
            setAllCollapsed((v) => !v);
            setGeneration((g) => g + 1);
          }}
          className="-my-2 shrink-0 py-2 text-xs text-ink-soft underline decoration-dotted hover:text-ink md:my-0 md:py-0"
        >
          {allCollapsed ? "Tout déplier" : "Tout replier"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="sticky top-0 z-10 border-b border-line bg-surface text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="py-1.5 pl-6 pr-3 font-medium">Client</th>
              <th className="px-3 py-1.5 text-right font-medium">GMV</th>
              <th className="px-3 py-1.5 text-center font-medium">Prévu</th>
              <th className="px-3 py-1.5 text-center font-medium">Perspective</th>
              {showExpected ? (
                <th className="px-3 py-1.5 text-right font-medium">{probabilityLabel}</th>
              ) : null}
              <th className="py-1.5 pl-3 pr-6 font-medium">Situation</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Group
                key={`${g.salesperson}-${generation}`}
                group={g}
                showExpected={showExpected}
                collapsed={allCollapsed}
                viewMonth={viewMonth}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-canvas text-sm">
              <td className="py-2 pl-6 pr-3 font-semibold">TOTAL RÉGION</td>
              <td className="tabular px-3 py-2 text-right font-medium">
                {formatEur(totals.kanban)}
              </td>
              <td className="px-3 py-2" />
              {/*
                Ce total est l'intersection avec les lignes affichées, pas la
                photographie Perspective — la bande au-dessus porte celle-ci.
                Le pied le nomme pour lever toute ambiguïté.
              */}
              <td className="tabular px-3 py-2 text-center text-xs font-medium" title="Part de la Perspective encore présente dans le pipe">
                {formatEurShort(totals.perspective)}
                <span className="block text-xs font-normal text-ink-faint">encore au pipe</span>
              </td>
              {showExpected ? (
                <td className="tabular px-3 py-2 text-right font-semibold">
                  {formatEurShort(totals.expected)}
                </td>
              ) : null}
              <td className="py-2 pl-3 pr-6 text-xs text-ink-soft">
                {expectedFooterLabel ?? `signé ${kEur(totals.signed)}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

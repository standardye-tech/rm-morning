"use client";

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { useState } from "react";

import { Badge } from "@/components/ui";
import {
  MOVEMENT_LABEL,
  type ChallengeKind,
  type ForecastMovement,
} from "@/lib/forecast-labels";
import type { ForecastV2Row } from "@/lib/forecast-v2";
import {
  footerItems,
  groupSummary,
  hasWeightedContribution,
  openShownCount,
  perspectiveAmountNote,
  perspectiveOffKanbanSituation,
  signedRowSituation,
} from "@/lib/forecast-wording";
import { formatEurShort, formatFrenchDate } from "@/lib/normalize";
import { LABEL, pct } from "@/lib/vocabulary";

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
  signee: "positive",
};

export type SheetRow = ForecastV2Row & {
  /** Motif de challenge, quand l'affaire en porte un. */
  challenge: { kind: ChallengeKind; reason: string } | null;
};

export type SheetGroup = {
  salesperson: string;
  signedGmv: number;
  /** Reste annoncé : GMV brut ouvert de la Perspective M, signé exclu. */
  declaredOpenGmv: number;
  /** Perspective ajustée du commercial ; null si le classeur manuel est indisponible. */
  adjustedGmv: number | null;
  kanbanGmv: number;
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
  // Une ligne Travaux signée négative est une moins-value : elle reste dans le
  // signé officiel du mois, mais ne se lit pas comme une affaire gagnée.
  const signed = signedRowSituation(row);
  if (signed) return signed;
  // Annoncée dans la Perspective du mois sans être au Kanban de ce mois.
  const offKanban = perspectiveOffKanbanSituation(row, viewMonth);
  if (offKanban) return offKanban;
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
    <tr
      className={`border-b border-line/70 last:border-0 ${
        row.isSignedRow ? "bg-positive-soft/50" : row.challenge ? "bg-warning-soft/40" : ""
      }`}
    >
      <td className="py-[3px] pl-6 pr-3">
        <span className="font-medium"><SalesforceOpportunityLink opportunityId={row.opportunityId}>{row.client}</SalesforceOpportunityLink></span>
        {row.nextExpectedLabel || row.isStandby ? (
          <span className="ml-2 text-xs text-ink-faint">
            {row.isStandby
              ? `gelée jusqu'au ${formatFrenchDate(row.standbyUntil?.slice(0, 10) ?? null)}`
              : row.nextExpectedLabel}
          </span>
        ) : null}
      </td>
      <td className="tabular whitespace-nowrap px-3 py-[3px] text-right font-medium">
        {formatEurShort(row.gmv)}
        {perspectiveAmountNote(row, viewMonth) ? (
          <span className="block text-[11px] font-normal leading-tight text-ink-faint">
            {perspectiveAmountNote(row, viewMonth)}
          </span>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-3 py-[3px] text-center text-xs">
        {row.outsideKanban ? (
          <span className="text-ink-faint">{monthName(row.kanbanMonth) ?? "—"}</span>
        ) : (
          <span className="text-ink-soft">{row.kanbanRaw ?? "oui"}</span>
        )}
      </td>
      {/*
        Lot de simplification (E4) : la confiance que l'ET a DÉCLARÉE dans la
        Perspective, brute. Aucune pondération ici — le retraitement manuel vit
        dans la Perspective ajustée.
      */}
      <td className="tabular whitespace-nowrap px-3 py-[3px] text-center text-xs">
        {row.perspectiveConfidence == null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <span className="text-ink-soft">{Math.round(row.perspectiveConfidence * 100)} %</span>
        )}
      </td>
      {showExpected ? (
        <td className="whitespace-nowrap px-3 py-[3px] text-right">
          <span className="tabular">{pct(row.expectedProbability)}</span>
          {hasWeightedContribution(row.expectedGmv) ? (
            <span className="tabular block text-[11px] leading-tight text-ink-faint">
              Contribution pondérée : {formatEurShort(row.expectedGmv)}
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
              {groupSummary({ ...group, rowCount: rows.length }, showExpected)}
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
  /** Horizon de la vue : le pied ne dit pas la même chose sur M, M+1 et M+2. */
  horizon = 0,
  /** Périmètre du pied : la Région, ou le seul commercial filtré. */
  scopeLabel = "TOTAL RÉGION",
}: {
  groups: SheetGroup[];
  showExpected: boolean;
  /** `openShown` : lignes non signées réellement affichées dans le tableau. */
  totals: { signed: number; declaredOpen: number; expectedRemaining: number; openShown: number };
  probabilityLabel?: string;
  viewMonth?: string | null;
  horizon?: 0 | 1 | 2;
  scopeLabel?: string;
}) {
  const columns = showExpected ? 6 : 5;
  const footer = footerItems(totals, { horizon, showExpected });
  const [allCollapsed, setAllCollapsed] = useState(false);
  // La clé force le remontage des groupes : « Tout replier » et « Tout déplier »
  // doivent reprendre la main sur les groupes ouverts ou fermés à la main.
  const [generation, setGeneration] = useState(0);

  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 md:px-6 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">
          {groups.length} commercia{groups.length > 1 ? "ux" : "l"} · {openShownCount(totals.openShown)}
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
              <th className="px-3 py-1.5 text-center font-medium">Kanban</th>
              <th
                className="px-3 py-1.5 text-center font-medium"
                title="Taux de confiance déclaré par l'ET dans la dernière Perspective, brut"
              >
                Confiance déclarée par l&apos;ET
              </th>
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
          {/*
            Le pied ne s'aligne plus sous les colonnes : la colonne GMV mélange des
            lignes signées, déclarées et ajoutées par RM Morning, et aucun des
            totaux ci-dessous n'est la somme de cette colonne. Chaque montant porte
            donc son nom, et vaut pour tout le périmètre (Région ou commercial),
            pas pour les seules lignes affichées. Une confiance ne se totalise pas
            (E5) : aucune n'y figure.
          */}
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-canvas text-sm">
              <td colSpan={columns} className="py-2 pl-6 pr-6">
                <span className="mr-4 font-semibold">{scopeLabel}</span>
                <span className="tabular font-medium">{footer.primary.join(" · ")}</span>
                <span className="tabular block text-xs text-ink-soft">{footer.detail.join(" · ")}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

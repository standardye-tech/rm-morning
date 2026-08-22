import Link from "next/link";

import { ForecastCandidates, ForecastExits } from "@/components/forecast-board";
import { ForecastSheet, type SheetGroup } from "@/components/forecast-sheet";
import {
  ForecastV2Divergences,
  ForecastV2Freshness,
  ForecastV2Scopes,
  ForecastV2Totals,
} from "@/components/forecast-v2";
import { Card, EmptyState } from "@/components/ui";
import { monthLabel, shiftMonth } from "@/lib/forecast-board";
import { buildForecastV2, isVisibleInForecast } from "@/lib/forecast-v2";
import { FORECAST_VISIBILITY } from "@/lib/config";
import { todayIso } from "@/lib/normalize";
import { chanceInMonth, LABEL } from "@/lib/vocabulary";

export const dynamic = "force-dynamic";

const STAGES = ["Etude dossier", "Examen estimation", "Visite artisan", "Examen devis", "Signature"];

/**
 * Forecast V2 — vue de pilotage consolidée.
 *
 * Quatre valeurs confrontées, jamais mélangées : Signé (réalisé), Projection
 * Kanban (déclaratif actuel), Perspective (dernière photographie hebdomadaire du
 * déclaratif) et Expected (estimation statistique, lue du service et jamais
 * recalculée ici).
 *
 * Trois vues volontairement séparées, jamais côte à côte :
 *
 *   M   — prévision du mois, lignes jaunes du mois ;
 *   M+1 — projection régionale C8.1 et lignes jaunes au seuil de probabilité. La
 *         projection est affichée dans la bande ; la somme de la colonne « GMV
 *         probable » n'est pas un total de mois et le pied du tableau le dit ;
 *   M+2 — déclaratif SEUL. Aucune ligne jaune : le classement M+2 de C8.1 ne
 *         distingue pas mieux que le hasard, il est rejeté.
 */
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const offset = query.vue === "m1" ? 1 : query.vue === "m2" ? 2 : 0;
  const ownerFilter = typeof query.commercial === "string" ? query.commercial : null;
  const stageFilter = typeof query.etape === "string" ? query.etape : null;
  const sort = typeof query.tri === "string" ? query.tri : "commercial";

  const board = buildForecastV2(offset);
  // Libellés des trois onglets. Dérivés du mois de la vue courante par simple
  // décalage : construire deux planches complètes juste pour lire leur titre
  // coûterait deux passes de base de données pour rien.
  const views = ([0, 1, 2] as const).map((h) => ({
    horizon: h,
    key: h === 0 ? null : (`m${h}` as const),
    tab: h === 0 ? "M" : `M+${h}`,
    label: monthLabel(shiftMonth(board.month, h - offset)),
  }));

  // Filtres appliqués aux LIGNES : les sous-totaux et le total Région sont
  // ensuite recalculés depuis ces mêmes lignes, sans autre chemin de calcul.
  // C'est ce qui garantit FC1 et FC2 quels que soient les filtres actifs.
  //
  // VISIBILITÉ : une seule règle, appliquée en dur, sans échappatoire. Une
  // affaire non déclarée sur le mois et sous le seuil de probabilité n'existe
  // pas sur cette page — elle n'est ni repliée ni comptée. Le dépliage local par
  // commercial a été retiré pour cette raison : il rouvrait par la petite porte
  // exactement ce que la règle ferme.
  //
  // Le motif « à challenger » ne donne aucun passe-droit. Une affaire hors
  // Kanban n'a besoin que de 4 000 € de GMV probable pour être signalée, ce
  // qu'atteint un dossier à 200 000 € avec 2 % de chance de signer. Les affaires
  // à challenger qui comptent — déclarées, ou réellement probables — passent la
  // règle d'elles-mêmes ; les autres restent visibles dans Expected GMV, qui est
  // l'écran d'exploration du pipe.
  const today = todayIso();
  const challengeById = new Map(board.examine.map((e) => [e.row.opportunityId, e]));

  // La même règle s'applique au bloc « Candidats à examiner », qui liste des
  // affaires déclarées sur le MOIS SUIVANT et déjà très avancées. Elles ne sont
  // pas déclarées sur le mois affiché : elles doivent donc, elles aussi, porter
  // au moins 25 % de chance de signer d'ici la fin du mois pour apparaître.
  // Sans ce filtre, ce bloc resterait une porte d'entrée vers le pipe faible.
  const probabilityById = new Map(
    board.salespeople
      .flatMap((sp) => sp.opportunities)
      .map((o) => [o.opportunityId, o.expectedProbability ?? 0]),
  );
  const candidatesBoard = {
    ...board,
    candidates: board.candidates.filter(
      (c) => (probabilityById.get(c.opportunityId) ?? 0) >= FORECAST_VISIBILITY.minProbability,
    ),
  };

  const groups: SheetGroup[] = board.salespeople
    .filter((sp) => !ownerFilter || sp.salesperson === ownerFilter)
    .map((sp) => {
      const rows = sp.opportunities
        .filter(
          (o) =>
            (!stageFilter || o.stage === stageFilter) &&
            isVisibleInForecast(o, board.month, today),
        )
        .map((o) => {
          const c = challengeById.get(o.opportunityId);
          return { ...o, challenge: c ? { kind: c.kind, reason: c.reason } : null };
        });
      return {
        salesperson: sp.salesperson,
        signedGmv: sp.signedGmvActual,
        kanbanGmv: rows.reduce((t, o) => t + (o.outsideKanban ? 0 : o.gmv ?? 0), 0),
        perspectiveGmv: rows.reduce((t, o) => t + (o.perspectiveGmv ?? 0), 0),
        perspectiveSnapshotGmv: sp.perspectiveSnapshotGmv,
        expectedGmv: rows.reduce((t, o) => t + (o.expectedGmv ?? 0), 0),
        rows,
      };
    })
    .filter((g) => g.rows.length > 0 || g.signedGmv > 0);

  if (sort === "expected") groups.sort((a, b) => b.expectedGmv - a.expectedGmv);
  else if (sort === "gmv") groups.sort((a, b) => b.kanbanGmv - a.kanbanGmv);
  else groups.sort((a, b) => a.salesperson.localeCompare(b.salesperson, "fr"));

  // Les totaux de la bande sont resommés depuis ces mêmes lignes : un seul
  // chemin de calcul, donc jamais d'écart entre la bande et le pied du tableau.
  const filtered = ownerFilter !== null || stageFilter !== null;
  const sheetTotals = {
    signed: groups.reduce((t, g) => t + g.signedGmv, 0),
    kanban: groups.reduce((t, g) => t + g.kanbanGmv, 0),
    perspective: groups.reduce((t, g) => t + g.perspectiveGmv, 0),
    perspectiveSnapshot: groups.reduce((t, g) => t + g.perspectiveSnapshotGmv, 0),
    expected: groups.reduce((t, g) => t + g.expectedGmv, 0),
    count: groups.reduce((t, g) => t + g.rows.filter((r) => !r.outsideKanban).length, 0),
  };
  const view = filtered
    ? {
        ...board,
        region: {
          ...board.region,
          count: sheetTotals.count,
          kanbanGmv: sheetTotals.kanban,
          perspectiveGmv: sheetTotals.perspective,
          perspectiveSnapshotGmv: sheetTotals.perspectiveSnapshot,
          expectedRemaining: sheetTotals.expected,
          signedGmvActual: sheetTotals.signed,
          expectedFinish: sheetTotals.signed + sheetTotals.expected,
        },
      }
    : board;

  const link = (params: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    if (offset === 1) sp.set("vue", "m1");
    else if (offset === 2) sp.set("vue", "m2");
    if (ownerFilter) sp.set("commercial", ownerFilter);
    if (stageFilter) sp.set("etape", stageFilter);
    if (sort !== "commercial") sp.set("tri", sort);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    return `/forecast${sp.toString() ? `?${sp}` : ""}`;
  };

  const tab = (isActive: boolean) =>
    `inline-flex min-h-9 items-center rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5 ${
      isActive ? "bg-surface font-medium text-ink" : "text-ink-soft hover:bg-surface hover:text-ink"
    }`;
  const chip = (isActive: boolean) =>
    `inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs transition-colors md:min-h-0 md:py-1 ${
      isActive ? "bg-surface font-medium text-ink" : "text-ink-soft hover:bg-surface hover:text-ink"
    }`;

  const filters = (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-ink-faint">Commercial</span>
        <Link href={link({ commercial: null })} className={chip(!ownerFilter)}>
          tous
        </Link>
        {board.salespeople.map((s) => (
          <Link
            key={s.salesperson}
            href={link({ commercial: s.salesperson })}
            className={chip(ownerFilter === s.salesperson)}
          >
            {s.firstName}
          </Link>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-ink-faint">Étape</span>
        <Link href={link({ etape: null })} className={chip(!stageFilter)}>
          toutes
        </Link>
        {STAGES.map((stage) => (
          <Link key={stage} href={link({ etape: stage })} className={chip(stageFilter === stage)}>
            {stage}
          </Link>
        ))}
      </div>
    </>
  );

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forecast</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Votre Perspective, enrichie des affaires que RM Morning conseille de challenger.
            Les lignes surlignées ne sont pas annoncées par le commercial.
          </p>
          {/*
            La règle de densité est dite à l'écran : un tableau qui cache des
            lignes doit annoncer selon quel critère, sinon on ne sait plus si
            l'absence d'une affaire est un choix ou un oubli.
          */}
          <p className="mt-1 max-w-2xl text-xs text-ink-faint">
            Sont affichées les affaires déclarées sur le mois par le commercial, et celles à
            au moins {Math.round(FORECAST_VISIBILITY.minProbability * 100)} % de chance de
            signer d&apos;ici la fin du mois. Les autres n&apos;apparaissent pas ici : elles
            restent consultables dans Expected GMV. Les stand-by en cours et les affaires
            signées ou abandonnées sont exclus.
          </p>
        </div>
        <ForecastV2Freshness board={board} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {/*
          Trois vues séparées, jamais côte à côte : chaque mois se lit avec son
          propre régime — prévision pour M, projection pour M+1, déclaratif seul
          pour M+2. Les juxtaposer inviterait à additionner trois chiffres qui ne
          se construisent pas de la même façon.
        */}
        <nav className="flex gap-1">
          {views.map((v) => (
            <Link key={v.tab} href={link({ vue: v.key })} className={tab(offset === v.horizon)}>
              {v.tab} — {v.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-ink-faint">Tri</span>
          <Link href={link({ tri: "commercial" })} className={chip(sort === "commercial")}>
            commercial
          </Link>
          <Link href={link({ tri: "gmv" })} className={chip(sort === "gmv")}>
            GMV prévu
          </Link>
          {board.expectedAvailable ? (
            <Link href={link({ tri: "expected" })} className={chip(sort === "expected")}>
              GMV probable
            </Link>
          ) : null}
        </div>
      </div>

      {/*
        Les mêmes filtres, présentés deux fois : dépliés à la souris, repliés au
        doigt. Dix-neuf pastilles remplissaient trois rangées et repoussaient les
        chiffres du mois hors de l'écran ; le résumé du sommaire dit ce qui est
        actif, donc rien n'est caché — seulement remis à sa place.
      */}
      <details className="mt-2 rounded-lg border border-line bg-surface md:hidden">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm">
          Filtres
          <span className="ml-2 text-xs text-ink-faint">
            {ownerFilter ?? "tous les commerciaux"} · {stageFilter ?? "toutes les étapes"}
          </span>
        </summary>
        <div className="border-t border-line px-4 pb-3 pt-1">{filters}</div>
      </details>
      <div className="hidden md:block">{filters}</div>

      {board.salespeople.length === 0 ? (
        <Card className="mt-6">
          <EmptyState>
            Aucune opportunité projetée sur {board.monthLabel}. Lancez une synchronisation
            Salesforce depuis la page Données.
          </EmptyState>
        </Card>
      ) : (
        <div className="mt-3 space-y-3">
          <ForecastV2Totals board={view} />
          <ForecastSheet
            groups={groups}
            showExpected={board.expectedAvailable}
            totals={sheetTotals}
            viewMonth={board.month}
            probabilityLabel={
              offset === 1 ? chanceInMonth(board.monthLabel) : LABEL.chanceThisMonth
            }
            expectedFooterLabel={
              offset === 1
                ? "somme des affaires en cours — la projection du mois est au-dessus"
                : offset === 2
                  ? "déclaratif seul"
                  : undefined
            }
          />
          {offset === 0 ? (
            <details className="group rounded-xl border border-line bg-surface">
              <summary className="cursor-pointer list-none px-4 md:px-6 py-3 text-sm font-medium hover:bg-canvas">
                Voir le détail de la Région
                <span className="ml-1 group-open:hidden" aria-hidden>
                  &#9656;
                </span>
                <span className="ml-1 hidden group-open:inline" aria-hidden>
                  &#9662;
                </span>
                <span className="ml-2 text-xs font-normal text-ink-faint">
                  périmètres comparés, écarts par commercial, mouvements de Perspective
                </span>
              </summary>
              <div className="space-y-4 border-t border-line p-4">
                <ForecastV2Scopes board={view} />
                <ForecastV2Divergences board={view} />
                <ForecastExits board={board} />
                <ForecastCandidates board={candidatesBoard} />
              </div>
            </details>
          ) : null}
          {board.issues.length > 0 ? (
            <details className="group rounded-xl border border-line bg-surface px-4 py-3 md:px-6">
              <summary className="-my-2 flex min-h-9 cursor-pointer list-none items-center py-2 text-xs text-ink-faint hover:text-ink md:my-0 md:min-h-0 md:py-0">
                <span className="underline decoration-dotted">
                  {board.issues.length} remarque(s) sur le périmètre
                </span>
                <span className="ml-1 group-open:hidden" aria-hidden>
                  ▸
                </span>
                <span className="ml-1 hidden group-open:inline" aria-hidden>
                  ▾
                </span>
              </summary>
              <ul className="mt-2 space-y-1 border-t border-line pt-2">
                {board.issues.map((issue, i) => (
                  <li key={i} className="text-xs text-ink-faint">
                    {issue}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}

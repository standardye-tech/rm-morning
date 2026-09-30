/**
 * Composants Forecast V2 — bandeau de la Région et fraîcheur des données.
 *
 * Forecast reste l'écran de pilotage du DÉCLARATIF : aucun terme de
 * modélisation n'y apparaît. Lot de simplification (E6) : le « détail de la
 * Région » (périmètres comparés, écarts par commercial, sorties, candidats)
 * n'est plus rendu — il répétait ce que la feuille montre déjà affaire par
 * affaire. Les moteurs restent dans `forecast-v2.ts` / `forecast-board.ts`.
 */

import type { ForecastV2Board } from "@/lib/forecast-v2";
import { formatFrenchDate } from "@/lib/normalize";
import { LABEL, kEur } from "@/lib/vocabulary";

// --- Totaux de la Région -----------------------------------------------------

/**
 * Totaux de la Région, en une ligne.
 *
 * Forecast n'est pas un tableau de bord : c'est une feuille de rapprochement.
 * Les quatre chiffres tiennent donc sur une ligne au-dessus du tableau, et rien
 * ne s'interpose entre eux et les affaires.
 */
export function ForecastV2Totals({ board }: { board: ForecastV2Board }) {
  const r = board.region;
  const commercial = r.commercialLanding;
  const m1 = board.expectedM1;
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 rounded-xl border border-line bg-surface px-4 md:px-6 py-3">
      <Total label={LABEL.signedToDate} value={kEur(r.signedGmvActual)} hint="Travaux signés dans le mois" tone="positive" />
      {/*
        Reste annoncé : GMV brut des lignes ouvertes de la Perspective M du mois,
        signé exclu. L'atterrissage commercial (signé + reste) est une information
        secondaire, jamais présentée comme le déclaratif lui-même.
      */}
      <Total
        label={LABEL.declaredOpen}
        value={kEur(r.declaredOpenGmv)}
        hint={`Perspective M · ${r.declaredOpenCount} affaire(s) · atterrissage ${kEur(r.commercialLanding)} = ${kEur(r.signedGmvActual)} signés + ${kEur(r.declaredOpenGmv)} à signer`}
      />
      <Total
        label={LABEL.adjustedPerspective}
        value={r.adjustedPerspective ? kEur(r.adjustedPerspective.gmv) : "—"}
        hint={
          r.adjustedPerspective
            ? r.adjustedPerspective.source === "snapshot"
              ? `Analyse régionale · snapshot ${
                  r.adjustedPerspective.snapshotDate
                    ? formatFrenchDate(r.adjustedPerspective.snapshotDate).slice(0, 5)
                    : "—"
                }`
              : `Analyse régionale · sélection manuelle · ${r.adjustedPerspective.count} affaires`
            : `Analyse régionale · ${r.adjustedPerspectiveNote ?? "indisponible"}`
        }
      />
      {/*
        Sur M+1 la bande affiche la PROJECTION régionale, jamais la somme de la
        colonne « GMV probable ». Les deux ne mesurent pas la même chose : la
        projection intègre les affaires qui n'existent pas encore, la colonne ne
        peut compter que celles du pipe d'aujourd'hui. Présenter la somme comme un
        total de mois la sous-estimerait de moitié.
      */}
      {board.horizon === 1 && m1 != null ? (
        <>
          <Total label={LABEL.projectionM1} value={kEur(m1.projection)} strong />
          <Total
            label={LABEL.indicativeRange}
            value={`${kEur(m1.rangeLo)} – ${kEur(m1.rangeHi)}`}
            hint={`${LABEL.confidence.toLowerCase()} ${m1.confidence}`}
          />
          <span className="text-xs text-ink-faint">
            les commerciaux annoncent {kEur(r.declaredOpenGmv)} · écart{" "}
            {kEur(r.declaredOpenGmv - m1.projection)}
          </span>
        </>
      ) : board.horizon === 2 ? (
        <Total
          label={LABEL.projectionM1}
          value="—"
          hint="pas de projection fiable à cet horizon"
        />
      ) : board.expectedAvailable ? (
        <>
          <Total label={LABEL.expectedRegion} value={kEur(r.expectedFinish)} strong />
          <Total
            label={LABEL.probableZone}
            value={`${kEur(r.p10)} – ${kEur(r.p90)}`}
          />
          <span className="text-xs text-ink-faint">
            Atterrissage commercial {kEur(commercial)} · Écart {LABEL.expectedRegion} vs atterrissage :{" "}
            {kEur(r.expectedFinish - commercial)}
          </span>
        </>
      ) : (
        <Total label={LABEL.expectedRegion} value="—" hint="pas de prévision pour ce mois" />
      )}
    </div>
  );
}

function Total({
  label,
  value,
  hint,
  strong = false,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  tone?: "positive";
}) {
  return (
    <span className="inline-flex flex-col">
      <span className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">{label}</span>
      <span
        className={`tabular tracking-tight ${strong ? "text-lg font-semibold" : "text-sm font-medium"} ${
          tone === "positive" ? "text-positive" : ""
        }`}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-ink-faint">{hint}</span> : null}
    </span>
  );
}

// --- Fraîcheur --------------------------------------------------------------

export function ForecastV2Freshness({ board }: { board: ForecastV2Board }) {
  const e = board.expected;
  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  const dataStale = e?.dataAgeHours != null && e.dataAgeHours > 24;
  const historyStale = e?.historyAgeHours != null && e.historyAgeHours > 24;
  const stale = dataStale || historyStale;

  // Deux niveaux de lecture, et c'est ce qui règle §13 : les horodatages sont
  // l'information courante, la mise en garde n'est qu'une note. Les mettre au
  // même poids donnait un pavé orange en gras qui pesait, sur un écran de
  // 375 px, plus lourd que les chiffres du mois.
  const caveat = !stale
    ? null
    : dataStale
      ? "L'état Salesforce a plus de 24 h : la prévision n'est pas à jour."
      : "L'historique des étapes a plus de 24 h : le temps passé dans l'étape est approximatif.";

  return (
    <p
      className={`text-xs ${stale ? "rounded-md bg-warning-soft px-3 py-1.5 text-warning" : "text-ink-faint"}`}
    >
      <span className={stale ? "font-medium" : undefined}>
        Données Salesforce : {fmt(board.updatedAt)}
        {e ? ` · Expected scoré : ${fmt(e.scoredAt)}` : ""}
      </span>
      {caveat ? <span className="block opacity-80 md:inline md:before:content-['_·_']">{caveat}</span> : null}
    </p>
  );
}

import { Card, SectionTitle } from "@/components/ui";
import type { ExpectedReliabilityView, HorizonReliability } from "@/lib/expected-reliability-view";
import { reliabilityHorizonText } from "@/lib/expected-wording";

/**
 * « Fiabilité d'Expected GMV » — lot de simplification (F5 à F7), verrous du
 * 24/09/2026.
 *
 * Chaque pourcentage vient d'un backtest historique réel, jamais de la
 * « confiance » du modèle : voir `expected-reliability.ts`. Un horizon par ligne,
 * jamais de total : additionner les horizons laisserait leurs erreurs se
 * compenser. Un indice fondé sur moins d'une année de mois cibles est dit
 * « indicatif », avec sa taille d'échantillon. Aucune date fictive.
 */

const DDMM = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const LABEL: Record<string, (h: HorizonReliability) => string> = {
  "Mois en cours": (h) => `Mois en cours (${h.monthLabel})`,
  "M+1": (h) => `Fiabilité historique M+1 (${h.monthLabel})`,
  "M+2": (h) => `M+2 (${h.monthLabel})`,
};

function Value({ h }: { h: HorizonReliability }) {
  if (h.reliability == null) return <span className="text-ink-faint">{h.unavailable ?? "Données insuffisantes"}</span>;
  return (
    <>
      <span className="tabular text-base font-semibold">{h.reliability} %</span>
      <span className="ml-2 text-xs text-ink-faint">
        {h.mature ? `sur ${h.months} mois` : `indicatif · seulement ${h.months} mois d'historique`}
      </span>
    </>
  );
}

export function ExpectedReliabilityBlock({ view }: { view: ExpectedReliabilityView }) {
  return (
    <Card>
      <SectionTitle eyebrow="Confiance dans les chiffres" title="Fiabilité d'Expected GMV" aside="estimation basée sur l'historique" />
      <ul className="divide-y divide-line">
        {view.horizons.map((h) => (
          <li key={h.label} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3 md:px-6">
            <p className="text-sm">
              <span className="text-ink-soft">{(LABEL[h.label] ?? ((x: HorizonReliability) => x.label))(h)} : </span>
              <Value h={h} />
            </p>
            {reliabilityHorizonText(h) ? <p className="text-xs text-ink-soft">{reliabilityHorizonText(h)}</p> : null}
          </li>
        ))}
      </ul>
      <details className="border-t border-line px-4 py-3 text-xs text-ink-faint md:px-6">
        <summary className="cursor-pointer list-none underline decoration-dotted">Comment se lit cet indice ?</summary>
        <div className="mt-2 space-y-1.5 leading-relaxed">
          <p>
            Fiabilité = 100 × (1 − erreur absolue agrégée) : on reprend les prévisions que RM Morning a faites (ou
            aurait faites avec la même règle, sans rien savoir de la suite) au même stade d&apos;un mois passé, et on
            les compare au GMV final officiel (Travaux). Chaque mois passé pèse autant, qu&apos;il ait été suivi chaque
            jour ou chaque semaine. Moins d&apos;une année de mois passés : l&apos;indice est seulement indicatif.
          </p>
          <p>
            « Estimée dans N jours » : le premier moment où, par le passé, l&apos;indice a atteint 90 %. C&apos;est une
            estimation basée sur l&apos;historique, jamais une certitude.
          </p>
          <p>
            Historique utilisé : {view.sources.mMonths} mois pour le mois en cours ({view.sources.mPoints} prévisions),{" "}
            {view.sources.m1Months} mois pour le mois suivant ({view.sources.m1Points} prévisions)
            {view.sources.from && view.sources.to
              ? `, du ${DDMM(view.sources.from)}/${view.sources.from.slice(0, 4)} au ${DDMM(view.sources.to)}/${view.sources.to.slice(0, 4)}`
              : ""}
            .
          </p>
          {view.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
          <CurveTable view={view} />
        </div>
      </details>
    </Card>
  );
}

function CurveTable({ view }: { view: ExpectedReliabilityView }) {
  const rows = view.horizons.filter((h) => h.curve);
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-xs">
        <tbody>
          {rows.map((h) => (
            <tr key={h.label}>
              <th className="pr-4 text-left font-medium text-ink-soft">{h.label}</th>
              {h.curve!.map((b) => (
                <td key={`${b.from}-${b.to}`} className="tabular whitespace-nowrap pr-4">
                  {b.from}–{b.to} j{h.label === "M+1" ? " avant" : " restants"} :{" "}
                  <span className="text-ink-soft">{b.reliability == null ? "données insuffisantes" : `${b.reliability} %`}</span>
                  <span className="text-ink-faint"> ({b.months} mois)</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

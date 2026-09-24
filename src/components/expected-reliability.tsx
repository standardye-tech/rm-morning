import { Card, SectionTitle } from "@/components/ui";
import type { ExpectedReliabilityView, HorizonReliability } from "@/lib/expected-reliability-view";

/**
 * « Fiabilité d'Expected GMV » — lot de simplification (F5 à F7).
 *
 * Chaque pourcentage vient d'un backtest historique réel, jamais de la
 * « confiance » du modèle : voir `expected-reliability.ts`. Quand l'historique ne
 * suffit pas, l'écran dit « Données insuffisantes » ; quand le seuil de 90 % n'a
 * jamais été atteint, il le dit aussi — aucune date fictive.
 */

const DDMM = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function horizonText(h: HorizonReliability): string {
  if (!h.reliableIn) return "90 % non atteint historiquement";
  if (h.reliableIn.days === 0) return "Déjà au-dessus de 90 % à ce stade, historiquement";
  return `Fiabilité > 90 % estimée dans ${h.reliableIn.days} jour${h.reliableIn.days > 1 ? "s" : ""} (le ${DDMM(h.reliableIn.date)})`;
}

function Value({ h, large = false }: { h: HorizonReliability; large?: boolean }) {
  if (h.reliability == null) {
    return <span className={`text-ink-faint ${large ? "text-base" : "text-sm"}`}>{h.unavailable ?? "Données insuffisantes"}</span>;
  }
  return <span className={`tabular font-semibold ${large ? "text-2xl" : "text-base"}`}>{h.reliability} %</span>;
}

export function ExpectedReliabilityBlock({ view }: { view: ExpectedReliabilityView }) {
  const g = view.global;
  return (
    <Card>
      <SectionTitle eyebrow="Confiance dans les chiffres" title="Fiabilité d'Expected GMV" aside="estimation basée sur l'historique" />
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-4 pb-4 md:px-6">
        <div>
          <p className="text-sm text-ink-soft">
            {g.label} ({g.monthLabel}) : <Value h={g} large />
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">
            {g.reliability != null
              ? `Mesurée sur ${g.months} mois passés, au même stade du mois. Sur si peu de mois, les écarts de M et de M+1 ont pu se compenser : à lire avec les deux lignes ci-dessous.`
              : "Pas assez de mois passés où les deux prévisions coexistaient."}
          </p>
        </div>
        <p className="text-xs text-ink-soft">{horizonText(g)}</p>
      </div>
      <ul className="divide-y divide-line">
        {view.horizons.map((h) => (
          <li key={h.label} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3 md:px-6">
            <p className="text-sm">
              <span className="text-ink-soft">
                {h.label} ({h.monthLabel}) :{" "}
              </span>
              <Value h={h} />
              {h.reliability != null ? <span className="ml-2 text-xs text-ink-faint">sur {h.months} mois passés</span> : null}
            </p>
            <p className="text-xs text-ink-soft">{horizonText(h)}</p>
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
            jour ou chaque semaine.
          </p>
          <p>
            « Estimée dans N jours » : le premier moment où, par le passé, l&apos;indice a atteint 90 %. C&apos;est une
            estimation basée sur l&apos;historique, jamais une certitude.
          </p>
          <p>
            Historique utilisé : {view.sources.mMonths} mois pour le mois en cours ({view.sources.mPoints} prévisions),{" "}
            {view.sources.m1Months} mois pour le mois suivant ({view.sources.m1Points} prévisions)
            {view.sources.from && view.sources.to ? `, du ${DDMM(view.sources.from)}/${view.sources.from.slice(0, 4)} au ${DDMM(view.sources.to)}/${view.sources.to.slice(0, 4)}` : ""}.
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
  const rows = [view.global, ...view.horizons].filter((h) => h.curve);
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

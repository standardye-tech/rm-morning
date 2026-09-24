import { Card, SectionTitle } from "@/components/ui";
import type { M1Trajectory, Trend, TrendReading } from "@/lib/m1-trajectory";
import { kEur } from "@/lib/vocabulary";

/**
 * « Trajectoire de construction » — vue M+1 d'Expected GMV, audit V3.3.
 *
 * Factuel : les chiffres du haut viennent de la vue M+1 (aucun KPI concurrent),
 * la table du bas est l'historique réel de quatre grandeurs. Pas de probabilité
 * d'atteindre l'objectif, pas de score, pas d'alerte : « monte / stagne / recule »
 * ne se lit que sur les valeurs affichées. Composant serveur, sans état.
 */

const DDMM = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const oneDecimal = (n: number) => n.toFixed(1).replace(".", ",");

const TREND_LABEL: Record<Trend, { arrow: string; word: string }> = {
  up: { arrow: "↗", word: "monte" },
  flat: { arrow: "→", word: "stagne" },
  down: { arrow: "↘", word: "recule" },
};

function signedK(delta: number): string {
  const k = kEur(Math.abs(delta));
  return delta > 0 ? `+${k}` : delta < 0 ? `−${k}` : k;
}

function Reading({ reading }: { reading: TrendReading | null }) {
  if (!reading) return <span className="text-ink-faint">—</span>;
  const t = TREND_LABEL[reading.trend];
  return (
    <span title={`du ${DDMM(reading.from)} au ${DDMM(reading.to)}`}>
      <span aria-hidden>{t.arrow}</span> {t.word}
      <span className="tabular ml-1 text-xs text-ink-faint">{signedK(reading.delta)}</span>
    </span>
  );
}

function Row({ label, value, hint, strong }: { label: string; value: string; hint?: string | null; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5 md:px-6">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="text-right">
        <span className={`tabular ${strong ? "text-base font-semibold" : "text-sm font-medium"}`}>{value}</span>
        {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      </dd>
    </div>
  );
}

export function TrajectoryM1Block({ trajectory }: { trajectory: M1Trajectory }) {
  const t = trajectory;
  const weeksLabel = `${oneDecimal(t.daysLeft / 7)} semaine(s)`;

  return (
    <Card>
      <SectionTitle
        eyebrow="Expected GMV · vue M+1"
        title="Trajectoire de construction"
        aside={
          t.history
            ? `Historique du ${DDMM(t.history.firstDate)} au ${DDMM(t.history.lastDate)} · ${oneDecimal(t.history.weeksCovered)} semaine(s)`
            : "Historique indisponible"
        }
      />
      <dl className="divide-y divide-line">
        <Row label="Objectif M+1" value={t.objective == null ? "Objectif non renseigné" : kEur(t.objective)} />
        <Row label="Prévision actuelle RM Morning" value={t.forecast == null ? "—" : kEur(t.forecast)} />
        <Row
          label="Manque à construire"
          value={t.missing == null ? "—" : t.covered ? "Objectif couvert" : kEur(t.missing)}
          hint={t.missing == null ? "objectif ou prévision indisponible" : "objectif − prévision RM Morning"}
        />
        <Row
          label="Semaines restantes"
          value={t.daysLeft > 0 ? weeksLabel : "—"}
          hint={t.daysLeft > 0 ? `${t.daysLeft} jour(s) avant le 1er ${t.monthLabel}` : `${t.monthLabel} a commencé`}
        />
        <Row
          label="Rythme hebdomadaire nécessaire"
          strong
          value={t.pace ? `${kEur(t.pace.weekly)} / semaine` : "—"}
          hint={
            t.pace && t.missing != null
              ? `Il manque ${kEur(t.missing)} à construire en ${weeksLabel} — rythme mathématique requis, pas une prédiction`
              : t.covered
                ? "aucun rythme requis : l'objectif est déjà couvert par la prévision"
                : "non calculable sans objectif et prévision"
          }
        />
      </dl>

      {t.history ? (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="px-4 py-2.5 font-medium md:px-6">Évolution</th>
                {t.history.checkpoints.map((d) => (
                  <th key={d} className="px-3 py-2.5 text-right font-medium">
                    {DDMM(d)}
                  </th>
                ))}
                <th className="px-3 py-2.5 font-medium">7 jours</th>
                <th className="px-4 py-2.5 font-medium md:px-6">Période</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {t.history.series.map((s) => (
                <tr key={s.key}>
                  <td className="px-4 py-2.5 md:px-6">
                    {s.label}
                    {s.unavailableReason ? (
                      <span className="block text-xs text-ink-faint">historique indisponible</span>
                    ) : null}
                  </td>
                  {s.values.map((v, i) => (
                    <td key={t.history!.checkpoints[i]} className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                      {v == null ? "—" : kEur(v)}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Reading reading={s.week} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 md:px-6">
                    <Reading reading={s.window} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="space-y-1.5 border-t border-line px-4 py-3 text-xs text-ink-faint md:px-6">
        <p>
          Le pipe identifié <span className="font-medium text-ink-soft">n&apos;est pas la prévision</span> : la prévision RM
          Morning M+1 intègre du GMV d&apos;affaires qui n&apos;existent pas encore — {t.futureShare} du GMV d&apos;un mois M+1,
          historiquement.
        </p>
        {t.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
    </Card>
  );
}

import Link from "next/link";

import { PerformanceTable, type PerformanceTableRow } from "@/components/performance-table";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import { kEur } from "@/lib/vocabulary";
import type {
  DynamicScore,
  PerformanceBoard,
  PerformanceRow,
  PillarResult,
} from "@/lib/performance";

/**
 * Performance commerciale — l'écran.
 *
 * PARTI PRIS : un tableau, pas un tableau de bord. Le classement doit se
 * comprendre en une trentaine de secondes ; des graphiques y ajouteraient de la
 * surface sans ajouter de décision. Une seule ligne par commercial, les quatre
 * sous-scores en colonnes, et le détail derrière un clic.
 *
 * Les sous-scores sont affichés sur 100 et non en points bruts. Un pilier à
 * « 24 » ne dit rien tant qu'on ne sait pas qu'il est noté sur 30 ; sur 100, les
 * quatre colonnes se comparent d'un coup d'œil.
 */

const PILLAR_ORDER = ["signed", "leads", "deals", "pipeline"] as const;

/** Le score, teinté par palier. Trois paliers seulement : lisibles de loin. */
function scoreTone(value: number): string {
  if (value >= 70) return "text-positive";
  if (value >= 45) return "text-ink";
  return "text-warning";
}

/**
 * La dynamique, dite en points de production.
 *
 * Un signe et un nombre, jamais une flèche seule : « ↑ » ne dit pas de combien,
 * et c'est précisément ce que le manager doit voir pour décider s'il ouvre la
 * conversation. En deçà du seuil, « stable » — et non « 0 », qui laisserait
 * croire à une mesure au point près sur trois mois de chiffre.
 */
function Dynamic({ dynamic, seuil }: { dynamic: DynamicScore; seuil: number }) {
  if (!dynamic.comparable) return <span className="text-xs text-ink-faint">—</span>;
  const d = dynamic.delta;
  if (Math.abs(d) < seuil) return <span className="text-xs text-ink-faint">Stable</span>;
  const up = d > 0;
  return (
    <span className={`tabular text-xs font-medium ${up ? "text-positive" : "text-warning"}`}>
      {up ? "+" : "−"}
      {Math.abs(d).toFixed(0)}
    </span>
  );
}

/**
 * « Qui monte » et « Qui décroche ».
 *
 * Placés AVANT le classement, et tenus sur une ligne chacun : ce sont les deux
 * questions qu'un directeur régional se pose en ouvrant l'écran, et elles se
 * répondent avant de lire treize lignes. Le critère est le delta de production,
 * jamais le rang — un commercial ne monte pas parce qu'un autre a baissé.
 */
export function Movers({ board, seuil }: { board: PerformanceBoard; seuil: number }) {
  const line = (
    title: string,
    rows: PerformanceRow[],
    empty: string,
    tone: "positive" | "warning",
  ) => (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 md:px-6">
      <span className="w-28 shrink-0 text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {title}
      </span>
      {rows.length === 0 ? (
        <span className="text-sm text-ink-faint">{empty}</span>
      ) : (
        rows.map((r) => (
          <span key={r.salesperson} className="text-sm">
            <Link
              href={`/performance?commercial=${encodeURIComponent(r.salesperson)}`}
              className="underline decoration-dotted underline-offset-2"
            >
              {r.salesperson}
            </Link>{" "}
            <span
              className={`tabular font-medium ${tone === "positive" ? "text-positive" : "text-warning"}`}
            >
              {tone === "positive" ? "↑ +" : "↓ −"}
              {Math.abs(r.dynamic.delta).toFixed(0)} pts
            </span>
            {/*
              Le chiffre qui fonde le mouvement, à côté du mouvement. Sans lui,
              « +50 pts » n'est qu'un score : le manager veut savoir de combien à
              combien, en euros, avant d'ouvrir la conversation.
            */}
            <span className="tabular ml-1.5 text-xs text-ink-faint">
              {kEur(r.dynamic.previous.gmv)} → {kEur(r.dynamic.recent.gmv)}
            </span>
          </span>
        ))
      )}
    </div>
  );

  return (
    <Card className="mt-4 divide-y divide-line">
      {line(
        "Qui monte",
        board.movers.up,
        "Aucune progression marquée sur la période.",
        "positive",
      )}
      {line(
        "Qui décroche",
        board.movers.down,
        "Aucun décrochage marqué sur la période.",
        "warning",
      )}
      <p className="px-4 py-2 text-xs text-ink-faint md:px-6">
        Production signée des 3 derniers mois clôturés comparée aux 3 précédents, à échelle
        commune. Seuil de significativité : {seuil} points.
      </p>
    </Card>
  );
}

function Trend({ change }: { change: number | null }) {
  if (change == null) return <span className="text-xs text-ink-faint">nouveau</span>;
  if (change === 0) return <span className="text-xs text-ink-faint">=</span>;
  const up = change > 0;
  return (
    <span className={`text-xs font-medium ${up ? "text-positive" : "text-warning"}`}>
      {up ? "↑" : "↓"} {Math.abs(change)}
    </span>
  );
}

/**
 * Enveloppe du tableau : elle aplatit le classement pour le composant client.
 *
 * Seules les colonnes affichées traversent la frontière serveur/client — pas
 * les seize mesures ni leurs barèmes. Le détail d'un commercial reste rendu
 * côté serveur, où il a accès à tout.
 */
export function PerformanceTableCard({
  board,
  selected,
  seuil,
}: {
  board: PerformanceBoard;
  selected: string | null;
  seuil: number;
}) {
  const rows: PerformanceTableRow[] = board.salespeople.map((r) => ({
    rank: r.rank,
    salesperson: r.salesperson,
    score: r.score,
    signed: r.pillars.signed.outOf100,
    leads: r.pillars.leads.outOf100,
    deals: r.pillars.deals.outOf100,
    pipeline: r.pillars.pipeline.outOf100,
    momentum: r.dynamic.comparable ? r.dynamic.recent.score : null,
    delta: r.dynamic.comparable ? r.dynamic.delta : null,
    rankChange: r.rankChange,
  }));

  return (
    <Card className="mt-4">
      <PerformanceTable rows={rows} selected={selected} seuil={seuil} />
      {/*
        L'explicatif tient en trois phrases : ce que mesure chaque score, et la
        règle qui surprend le plus — la moitié du poids pour une donnée absente.
        Le reste de la méthode vit dans les précisions dépliables, sous le
        tableau : visible pour qui le cherche, invisible pour qui lit le matin.
      */}
      <dl className="space-y-1.5 border-t border-line px-4 py-3 text-xs leading-relaxed text-ink-faint md:px-6">
        <div>
          <dt className="inline font-medium text-ink-soft">Score YTD</dt>{" "}
          <dd className="inline">
            — production signée depuis le 1<sup>er</sup> janvier {new Date(board.computedAt).getFullYear()},
            plus la qualité actuelle des pistes, des opportunités et du pipe futur. Les quatre
            sous-scores sont ramenés sur 100 et pondérés à 30, 20, 20 et 30 points.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink-soft">Momentum 3 mois</dt>{" "}
          <dd className="inline">
            — évolution de la production signée sur les 3 derniers mois clôturés, comparée aux 3
            mois précédents. Pistes, Opportunités et Pipeline y seront intégrés lorsque
            suffisamment d&apos;historique sera disponible.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink-soft">non mesuré</dt>{" "}
          <dd className="inline">
            — une mesure impossible à calculer faute de donnée reçoit la moitié de son poids :
            elle ne peut ni favoriser ni pénaliser, et n&apos;entre dans aucun commentaire.
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function PillarDetail({ pillar }: { pillar: PillarResult }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
        <span className="text-sm font-medium">{pillar.label}</span>
        <span className="tabular text-sm">
          {pillar.outOf100}
          <span className="text-xs text-ink-faint">/100</span>
          <span className="ml-2 text-xs text-ink-faint">
            {pillar.points.toFixed(1)} / {pillar.weight} pts
          </span>
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {pillar.metrics.map((m) => (
          <li key={m.key} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-ink-soft">
              {m.label}
              {/*
                Une mesure absente est ANNONCÉE, et la règle appliquée est dite.
                Sans cette mention, la moitié du poids se lirait comme une
                performance moyenne réellement constatée, alors qu'elle ne
                constate rien : c'est une position neutre faute de donnée.
              */}
              {!m.measured ? (
                <span
                  className="ml-1.5 rounded bg-canvas px-1.5 py-0.5 text-ink-faint"
                  title="Donnée absente pour ce commercial : la mesure reçoit la moitié de son poids — elle ne peut ni le favoriser ni le pénaliser — et n'entre ni dans ses points forts ni dans ses points de vigilance."
                >
                  non mesuré
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-right">
              <span className={`tabular font-medium ${m.measured ? "" : "text-ink-faint"}`}>
                {m.display}
              </span>
              {m.sampleText ? (
                <span
                  className="ml-1 text-ink-faint"
                  title="Un taux calculé sur peu de dossiers est rapproché de celui de l'équipe : le score reste prudent tant que la mesure est mince."
                >
                  {m.sampleText}
                </span>
              ) : null}
              <span className="tabular ml-2 text-ink-faint">
                {m.points.toFixed(1)}/{m.weight}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PerformanceDetail({ row }: { row: PerformanceRow }) {
  return (
    <Card className="mt-4">
      <SectionTitle
        eyebrow={`Rang ${row.rank}`}
        title={`${row.salesperson} — ${row.score.toFixed(0)}/100`}
        aside={
          <span className="flex items-center gap-2">
            <Trend change={row.rankChange} />
            {row.previousRank != null ? (
              <span className="text-xs text-ink-faint">
                précédemment {row.previousRank}
              </span>
            ) : (
              <span className="text-xs text-ink-faint">première photo</span>
            )}
          </span>
        }
      />

      <p className="border-b border-line px-4 py-3 text-[15px] md:px-6">{row.comment}</p>

      {/*
        Profondeur d'historique. AUCUN score n'est corrigé pour l'ancienneté —
        un commercial arrivé en juin a moins de GMV cumulé, et c'est un fait.
        Mais le lecteur doit pouvoir le savoir avant de conclure sur un rang.
        Affiché seulement quand l'historique est partiel : le dire à tout le
        monde serait du bruit.
      */}
      {row.history.firstMonth != null && row.history.monthsObserved < row.history.ytdMonths ? (
        <p
          className="border-b border-line px-4 py-2 text-xs text-ink-faint md:px-6"
          title="Premier mois de l'année où une affaire créée ou une signature est observée pour ce commercial. Le score n'est corrigé d'aucune ancienneté."
        >
          Historique disponible : {row.history.monthsObserved} mois sur {row.history.ytdMonths} mois
          depuis le 1<sup>er</sup> janvier.
        </p>
      ) : null}

      {/*
        La trajectoire, chiffrée. Deux fenêtres nommées et leurs deux scores :
        un delta seul ne dit pas s'il vient d'une chute ou d'un rattrapage.
      */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line px-4 py-2.5 text-xs md:px-6">
        <span className="font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Momentum 3 mois
        </span>
        {row.dynamic.comparable ? (
          <>
            <span className="text-ink-soft">
              {row.dynamic.previous.label}{" "}
              <span className="tabular font-medium text-ink">
                {row.dynamic.previous.score.toFixed(0)}
              </span>
            </span>
            <span aria-hidden className="text-ink-faint">
              →
            </span>
            <span className="text-ink-soft">
              {row.dynamic.recent.label}{" "}
              <span className="tabular font-medium text-ink">
                {row.dynamic.recent.score.toFixed(0)}
              </span>
            </span>
            <span
              className={`tabular font-semibold ${
                row.dynamic.delta > 0 ? "text-positive" : row.dynamic.delta < 0 ? "text-warning" : "text-ink-faint"
              }`}
            >
              {row.dynamic.delta > 0 ? "+" : ""}
              {row.dynamic.delta.toFixed(1)} pts
            </span>
            <span className="text-ink-faint">
              {kEur(row.dynamic.previous.gmv)} → {kEur(row.dynamic.recent.gmv)} ·{" "}
              {row.dynamic.previous.deals} → {row.dynamic.recent.deals} affaire(s) · production
              signée seule
            </span>
          </>
        ) : (
          <span className="text-ink-faint">
            Historique insuffisant pour mesurer une trajectoire.
          </span>
        )}
      </div>

      <div className="grid gap-4 border-b border-line p-4 md:grid-cols-2 md:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Points forts
          </p>
          {row.strengths.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-faint">
              Aucune mesure au-dessus du repère de l&apos;équipe.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {row.strengths.map((s) => (
                <li key={s.key} className="text-sm text-ink">
                  · {s.text}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
            À surveiller
          </p>
          {row.watch.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-faint">Aucun signal sous le repère.</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {row.watch.map((w) => (
                <li key={w.key} className="text-sm text-ink">
                  · {w.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid gap-5 p-4 md:grid-cols-2 md:p-6">
        {PILLAR_ORDER.map((key) => (
          <PillarDetail key={key} pillar={row.pillars[key]} />
        ))}
      </div>
    </Card>
  );
}

export function PerformanceNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <details className="group mt-3 rounded-xl border border-line bg-surface px-4 py-3 md:px-6">
      <summary className="-my-2 flex min-h-9 cursor-pointer list-none items-center py-2 text-xs text-ink-faint hover:text-ink md:my-0 md:min-h-0 md:py-0">
        <span className="underline decoration-dotted">
          {notes.length} précision(s) sur ce que le score mesure
        </span>
        <span className="ml-1 group-open:hidden" aria-hidden>
          ▸
        </span>
        <span className="ml-1 hidden group-open:inline" aria-hidden>
          ▾
        </span>
      </summary>
      <ul className="mt-2 space-y-1 border-t border-line pt-2">
        {notes.map((n) => (
          <li key={n} className="text-xs text-ink-faint">
            {n}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PerformanceEmpty() {
  return (
    <Card className="mt-6">
      <EmptyState>
        Aucun commercial à classer. Lancez « Actualiser RM Morning » pour charger les opportunités,
        les pistes et les Travaux.
      </EmptyState>
    </Card>
  );
}

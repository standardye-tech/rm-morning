/**
 * Composants de l'onglet Expected GMV.
 *
 * Parti pris d'affichage : une prévision statistique n'est jamais présentée
 * comme un chiffre certain. Le finish attendu est toujours accompagné de sa
 * zone probable, et les mesures de fiabilité sont visibles sur la même page,
 * pas reléguées dans une documentation.
 *
 * Aucun arrondi n'entre dans un calcul : les totaux arrivent déjà sommés depuis
 * `expected-gmv-live`, et cette couche ne fait que les formater (EC8).
 */

import { Badge, Card, SectionTitle } from "@/components/ui";
import type {
  ExpectedGmvOpportunity,
  ExpectedGmvReliability,
  ExpectedGmvSalesperson,
  ExpectedGmvSnapshot,
} from "@/lib/expected-gmv-live";
import { monthLabel } from "@/lib/expected-gmv-live";
import type { ExpectedM1Snapshot } from "@/lib/expected-m1";
import { formatEur, formatEurShort, formatFrenchDate } from "@/lib/normalize";
import { LABEL, READING_HINT, READING_LABEL, readForecast } from "@/lib/vocabulary";
import type { HistoricalReference } from "@/lib/official-signed";
import { CHALLENGE_LABEL, type ForecastV2Examine } from "@/lib/forecast-v2";
import { ProbabilityWithFactors } from "@/components/expected-factors";

/**
 * Séparateur de milliers en espace insécable classique. `toLocaleString("fr-FR")`
 * produit une espace fine (U+202F) qui disparaît visuellement dans un KPI de
 * grande taille : « 14036 k€ » au lieu de « 14 036 k€ ».
 */
function groupInt(value: number): string {
  return Math.abs(value)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** k€ sans passer en millions : 1 652 k€ reste plus lisible que 1,7 M€ ici. */
function kEur(value: number | null | undefined): string {
  if (value == null) return "—";
  const k = Math.round(value / 1000);
  // Signe moins typographique, comme dans les pourcentages voisins : un tiret
  // ASCII dans une colonne et un moins dans l'autre se lisait comme une faute.
  return `${k < 0 ? "−" : ""}${groupInt(k)} k€`;
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits).replace(".", ",")} %`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1).replace(".", ",")} %`;
}


/**
 * Affaires à challenger.
 *
 * EXACTEMENT la même liste que Forecast : `buildForecastV2(...).examine`. Ce
 * composant ne fait que la présenter autrement — cinq colonnes, une phrase par
 * ligne. Aucune seconde règle n'existe dans l'application.
 */
export function ExpectedGmvChallenge({
  items,
  limit = 8,
}: {
  items: ForecastV2Examine[];
  limit?: number;
}) {
  if (items.length === 0) return null;
  const head = items.slice(0, limit);
  const rest = items.slice(limit);
  const row = (e: ForecastV2Examine) => (
    <tr key={e.row.opportunityId} className="border-b border-line bg-warning-soft/60 last:border-0">
      <td className="px-4 md:px-6 py-2 font-medium">{e.row.client}</td>
      <td className="px-3 py-2 text-xs text-ink-soft">{e.row.owner}</td>
      <td className="tabular px-3 py-2 text-right font-medium">{kEur(e.row.gmv)}</td>
      <td className="tabular px-3 py-2 text-right">
        {e.row.expectedProbability == null ? "—" : pct(e.row.expectedProbability)}
      </td>
      <td className="px-4 md:px-6 py-2 text-xs text-ink-soft">
        <Badge tone="warning">{CHALLENGE_LABEL[e.kind]}</Badge>{" "}
        <span className="text-ink-faint">{e.reason}</span>
      </td>
    </tr>
  );
  return (
    <Card>
      <SectionTitle
        eyebrow="À garder dans le viseur"
        title={LABEL.challenge}
        aside={`${items.length} affaire(s)`}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm md:min-w-0">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Client</th>
              <th className="px-3 py-2 font-medium">Commercial</th>
              <th className="px-3 py-2 text-right font-medium">GMV</th>
              <th className="px-3 py-2 text-right font-medium">{LABEL.chanceThisMonth}</th>
              <th className="px-4 md:px-6 py-2 font-medium">Pourquoi cette affaire ressort</th>
            </tr>
          </thead>
          <tbody>{head.map(row)}</tbody>
        </table>
      </div>
      {rest.length > 0 ? (
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-sm text-ink-soft hover:text-ink">
            <span className="underline decoration-dotted">
              Voir toutes les affaires à challenger ({items.length})
            </span>
            <span className="ml-1 group-open:hidden" aria-hidden>
              ▸
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              ▾
            </span>
          </summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full min-w-[46rem] text-sm md:min-w-0">
              <tbody>{rest.map(row)}</tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}

// --- Synthese M / M+1 / M+2 -------------------------------------------------

/**
 * La lecture principale de l'ecran : ou RM Morning pense que nous allons finir.
 *
 * Trois mois, trois blocs de meme forme. Seul M porte une prevision : le modele
 * apprend « signer avant la fin du mois observe » et ne dit donc rien de M+1 ni
 * de M+2. Les deux blocs suivants l'annoncent au lieu de fabriquer un chiffre.
 */
export type HorizonDeclarative = {
  label: string;
  kanbanGmv: number | null;
  kanbanCount: number | null;
  perspectiveGmv: number | null;
  /** Part du GMV du mois venue d'affaires pas encore créées, mesurée en C8.1. */
  futureShare: string;
};

export function ExpectedGmvHorizons({
  snap,
  commercial,
  commercialCount,
  m1,
  m1Declarative,
  m1Suggestions,
  m2,
  reference,
}: {
  snap: ExpectedGmvSnapshot;
  commercial: number | null;
  /** Nombre d'affaires derrière la prévision commerciale, pour dire le périmètre. */
  commercialCount?: number | null;
  /** Projection M+1. Null tant que `npm run m1:publish` n'a pas tourné. */
  m1: ExpectedM1Snapshot | null;
  m1Declarative: HorizonDeclarative;
  m1Suggestions: { count: number; gmv: number };
  m2: HorizonDeclarative;
  /** Repère historique officiel. Jamais présenté comme une prévision. */
  reference: HistoricalReference | null;
}) {
  const r = snap.region;
  const reading = readForecast(r.expectedFinish, commercial);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle eyebrow="Ce mois-ci" title={snap.monthLabel} aside={`J-${snap.daysLeft}`} />
        <dl className="space-y-2.5 px-4 md:px-6 py-4 text-sm">
          {/*
            Le réalisé ouvre la carte : c'est le seul chiffre acquis, et il donne
            l'échelle des trois autres. Il n'apparaissait qu'en note dépliée.
          */}
          <Line label={LABEL.signed} value={kEur(r.signedGmv)} hint={`${r.signedCount} affaire(s)`} />
          <Line
            label={LABEL.kanbanFinish}
            value={kEur(commercial)}
            hint={commercialCount == null ? undefined : `sur ${commercialCount} affaire(s) prévue(s)`}
          />
          <Line label={LABEL.expectedFinish} value={kEur(r.expectedFinish)} strong hint={`sur ${r.count} affaire(s) suivies`} />
          <Line
            label="Écart"
            value={commercial == null ? "—" : kEur(r.expectedFinish - commercial)}
          />
          <Line label={LABEL.probableZone} value={`${kEur(r.p10)} – ${kEur(r.p90)}`} />
        </dl>
        {/*
          L'explication de périmètre est indispensable mais elle noyait la carte :
          quatre chiffres doivent suffire à la première lecture. Elle passe donc
          derrière un dépliage, au même endroit pour qui la cherche.
        */}
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-4 py-3 text-xs text-ink-faint hover:text-ink md:px-6 md:py-2">
            <span className="underline decoration-dotted">{READING_LABEL[reading]}</span>
            <span className="ml-1 group-open:hidden" aria-hidden>
              ▸
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              ▾
            </span>
          </summary>
          <div className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
            <p>{READING_HINT[reading]}</p>
            <p className="mt-1.5">
              Dont {kEur(r.signedGmv)} déjà signés et {kEur(r.expectedRemaining)} encore probables.
            </p>
          </div>
        </details>
      </Card>

      <ExpectedM1Card
        m1={m1}
        declarative={m1Declarative}
        suggestions={m1Suggestions}
      />
      <ExpectedM2Card m2={m2} reference={reference} />
    </div>
  );
}

/**
 * Carte M+1 : une projection, sa fourchette, sa confiance, et l'écart avec ce que
 * l'équipe annonce.
 *
 * Le mot « Projection » est choisi contre « Prévision » : ce chiffre ne se
 * construit pas comme celui du mois en cours. Il part du niveau historique de
 * l'équipe et l'ajuste selon la force du pipe — il n'est pas la somme des
 * affaires identifiées, et le dépliable l'explique.
 */
function ExpectedM1Card({
  m1,
  declarative,
  suggestions,
}: {
  m1: ExpectedM1Snapshot | null;
  declarative: HorizonDeclarative;
  suggestions: { count: number; gmv: number };
}) {
  if (m1 == null) {
    return (
      <Card>
        <SectionTitle eyebrow="Le mois prochain" title={declarative.label} />
        <div className="px-4 md:px-6 py-4">
          <p className="text-sm font-medium">Projection non publiée</p>
          <p className="mt-2 text-xs text-ink-soft">
            Le moteur de projection n&apos;a pas encore tourné pour ce mois.
          </p>
        </div>
      </Card>
    );
  }
  const gap = declarative.kanbanGmv == null ? null : declarative.kanbanGmv - m1.projection;
  return (
    <Card>
      <SectionTitle
        eyebrow="Le mois prochain"
        title={m1.targetMonthLabel}
        aside={`${LABEL.confidence} ${m1.confidence}`}
      />
      <dl className="space-y-2.5 px-4 md:px-6 py-4 text-sm">
        <Line label={LABEL.projectionM1} value={kEur(m1.projection)} strong />
        <Line
          label={LABEL.indicativeRange}
          value={`${kEur(m1.rangeLo)} – ${kEur(m1.rangeHi)}`}
        />
        <Line
          label={LABEL.kanban}
          value={kEur(declarative.kanbanGmv)}
          hint={
            declarative.kanbanCount == null
              ? undefined
              : `sur ${declarative.kanbanCount} affaire(s) prévue(s)`
          }
        />
        <Line label={LABEL.perspective} value={kEur(declarative.perspectiveGmv)} />
        {/*
          Formulation volontairement factuelle. « Forecast irréaliste » serait un
          jugement que la mesure ne permet pas : la projection porte elle-même une
          fourchette de plusieurs centaines de milliers d'euros.
        */}
        <Line
          label="Écart avec ce que l'équipe prévoit"
          value={gap == null ? "—" : `${gap >= 0 ? "+" : "−"}${kEur(Math.abs(gap))}`}
        />
      </dl>
      {!m1.strengthInRange ? (
        <p className="border-t border-line px-4 md:px-6 py-2 text-xs text-warning">
          Le pipe actuel sort de ce qui a servi à calibrer la projection. À lire avec prudence.
        </p>
      ) : null}
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs text-ink-faint hover:text-ink md:px-6 md:py-2">
          <span className="underline decoration-dotted">Comprendre cette projection</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▾
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▴
          </span>
        </summary>
        <ul className="space-y-1.5 border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
          <li>
            Elle part du niveau habituel de l&apos;équipe : {kEur(m1.baseline)} signés par mois en
            moyenne sur les douze derniers mois complets.
          </li>
          <li>
            Elle est ensuite ajustée selon la force du pipe actuel. Aujourd&apos;hui le pipe est{" "}
            {m1.strength >= 1
              ? `${Math.round((m1.strength - 1) * 100)} % au-dessus`
              : `${Math.round((1 - m1.strength) * 100)} % en dessous`}{" "}
            de son niveau des trois derniers mois, ce qui donne un ajustement de{" "}
            {m1.multiplier >= 1 ? "+" : "−"}
            {Math.abs(Math.round((m1.multiplier - 1) * 100))} %.
          </li>
          <li>
            Une partie du GMV {elide(m1.targetMonthLabel.split(" ")[0])} viendra encore
            d&apos;affaires qui n&apos;existent pas aujourd&apos;hui : {declarative.futureShare} du
            chiffre du mois, historiquement. C&apos;est pourquoi la projection ne peut pas être la
            somme des affaires en cours.
          </li>
          <li>
            Elle est donc moins sûre que celle du mois en cours, où presque tout le chiffre est
            déjà identifiable.
          </li>
          <li>
            <span className="font-medium text-ink-soft">
              {LABEL.confidence} {m1.confidence}
            </span>{" "}
            : la projection réagit au pipe actuel, mais l&apos;historique de validation reste encore
            court — trois mois seulement. Elle ne verrait pas venir un mois exceptionnellement
            creux, comme un mois d&apos;août.
          </li>
          {suggestions.count > 0 ? (
            <li>
              {suggestions.count} affaire(s) ont une chance réelle de signer sans être prévues par
              leur commercial, pour {kEur(suggestions.gmv)} au total. Elles apparaissent surlignées
              dans Forecast.
            </li>
          ) : null}
        </ul>
      </details>
    </Card>
  );
}

/**
 * Carte M+2 : aucun modèle.
 *
 * C8.1 a rejeté les deux briques M+2 — aucune approche ne bat une moyenne plate,
 * et le classement individuel fait moins bien que le hasard. On affiche donc le
 * repère historique officiel et le déclaratif, sans fourchette : une fourchette
 * supposerait une méthode calibrée, et il n'y en a pas.
 */
function ExpectedM2Card({
  m2,
  reference,
}: {
  m2: HorizonDeclarative;
  reference: HistoricalReference | null;
}) {
  return (
    <Card>
      <SectionTitle
        eyebrow="Dans deux mois"
        title={m2.label}
        aside={`${LABEL.confidence} faible`}
      />
      <div className="px-4 md:px-6 py-4">
        <p className="text-sm font-medium">Pas encore de projection suffisamment fiable</p>
        <dl className="mt-3 space-y-2.5 text-sm">
          {reference ? (
            <Line
              label={LABEL.historicalMark}
              value={kEur(reference.monthlyAverage)}
              hint={`moyenne signée sur ${reference.months} mois, de ${kEur(reference.min)} à ${kEur(reference.max)}`}
            />
          ) : null}
          <Line
            label={LABEL.kanban}
            value={kEur(m2.kanbanGmv)}
            hint={m2.kanbanCount == null ? undefined : `sur ${m2.kanbanCount} affaire(s) prévue(s)`}
          />
          <Line label={LABEL.perspective} value={kEur(m2.perspectiveGmv)} />
        </dl>
      </div>
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs text-ink-faint hover:text-ink md:px-6 md:py-2">
          <span className="underline decoration-dotted">Pourquoi pas de projection ?</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▾
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▴
          </span>
        </summary>
        <ul className="space-y-1.5 border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
          {/*
            Ce point était au premier niveau de la carte. Il y disait la même
            chose que la puce générique qu'il remplace ici, mais en quatre
            lignes de texte technique placées avant les chiffres du mois.
          */}
          <li>
            Une grande partie du GMV {elide(m2.label.split(" ")[0])} viendra d&apos;affaires qui
            n&apos;existent pas encore aujourd&apos;hui : {m2.futureShare} du chiffre du mois,
            historiquement. Aucune donnée d&apos;aujourd&apos;hui ne les décrit, et le repère ne
            tient pas compte du pipe actuel — ce n&apos;est pas une prévision.
          </li>
          <li>
            Toutes les méthodes essayées font moins bien qu&apos;une simple moyenne historique.
            Afficher un chiffre précis donnerait une fausse impression de maîtrise.
          </li>
          <li>
            Pour la même raison, RM Morning ne suggère aucune affaire à challenger sur ce mois :
            son classement ne distingue pas mieux que le hasard.
          </li>
        </ul>
      </details>
    </Card>
  );
}

/** « de septembre » mais « d'octobre » : l'élision se fait sur la voyelle. */
function elide(month: string): string {
  return /^[aeiouâéêîôû]/i.test(month) ? `d'${month}` : `de ${month}`;
}

function Line({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 md:gap-4">
      <dt className="min-w-0 text-ink-soft">
        {label}
        {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      </dt>
      {/* « 782 k€ » passait à la ligne entre le nombre et son unité à 375 px. */}
      <dd
        className={`tabular shrink-0 whitespace-nowrap text-right ${strong ? "text-xl font-semibold" : "font-medium"}`}
      >
        {value}
      </dd>
    </div>
  );
}

// --- Synthese detaillee -----------------------------------------------------


function Figure({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">{label}</p>
      <p className={`tabular mt-0.5 font-semibold tracking-tight ${strong ? "text-2xl" : "text-lg"}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function ExpectedGmvSummary({ snap }: { snap: ExpectedGmvSnapshot }) {
  const r = snap.region;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <SectionTitle
          eyebrow="Horizon court"
          title="Proches de signer"
          aside="dans les 7 prochains jours"
        />
        <div className="grid grid-cols-3 gap-6 px-4 md:px-6 py-5">
          <Figure label="GMV ouvert" value={kEur(r.openGmv)} hint={`${r.count} affaires`} />
          <Figure label={LABEL.gmvSevenDays} value={kEur(r.expected7d)} strong />
          <Figure
            label="Affaires scorées"
            value={String(r.count)}
            hint={`état du ${formatFrenchDate(snap.sourceObservationDate)}`}
          />
        </div>
        <p className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
          {snap.model7d} · probabilité de signature sous 7 jours. Jamais additionnée à l&apos;horizon
          fin de mois.
        </p>
      </Card>

      <Card>
        <SectionTitle
          eyebrow={`Fin de ${snap.monthLabel}`}
          title="Fin du mois"
          aside={`J-${snap.daysLeft}`}
        />
        <div className="grid grid-cols-3 gap-6 px-4 md:px-6 py-5">
          <Figure
            label={LABEL.signedToDate}
            value={kEur(r.signedGmv)}
            hint={`${r.signedCount} affaire${r.signedCount > 1 ? "s" : ""}`}
          />
          <Figure label={LABEL.expectedRemaining} value={kEur(r.expectedRemaining)} />
          <Figure
            label={LABEL.expectedFinish}
            value={kEur(r.expectedFinish)}
            strong
            hint={`médiane simulée ${kEur(r.p50)}`}
          />
        </div>
        <div className="border-t border-line px-4 md:px-6 py-3">
          <p className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
            {LABEL.probableZone}
          </p>
          <p className="tabular mt-0.5 text-base font-medium">
            {kEur(r.p10)} – {kEur(r.p90)}
          </p>
          <ProbabilityBar p10={r.p10} p50={r.p50} p90={r.p90} finish={r.expectedFinish} />
        </div>
        <p className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
          {snap.modelVersion} · estimation statistique. P10 / P90 sur {groupInt(snap.draws)}{" "}
          simulations du restant à signer.
        </p>
      </Card>
    </div>
  );
}

/**
 * Représentation minimale de l'intervalle. Pas un graphique : une règle, dont
 * le seul rôle est d'empêcher de lire le finish attendu comme une certitude.
 */
function ProbabilityBar({
  p10,
  p50,
  p90,
  finish,
}: {
  p10: number;
  p50: number;
  p90: number;
  finish: number;
}) {
  const lo = Math.min(p10, finish) * 0.9;
  const hi = Math.max(p90, finish) * 1.05;
  const at = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="mt-3 mb-1">
      <div className="relative h-1.5 rounded-full bg-canvas">
        <div
          className="absolute h-1.5 rounded-full bg-line-strong"
          style={{ left: at(p10), right: `calc(100% - ${at(p90)})` }}
        />
        <div
          className="absolute -top-1 h-3.5 w-[2px] rounded bg-ink"
          style={{ left: at(finish) }}
          title={`Prévision RM Morning ${formatEur(finish)}`}
        />
        <div
          className="absolute -top-0.5 h-2.5 w-[1px] bg-ink-faint"
          style={{ left: at(p50) }}
          title={`Médiane ${formatEur(p50)}`}
        />
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-faint">
        <span>P10</span>
        <span>P90</span>
      </div>
    </div>
  );
}

// --- Fiabilité --------------------------------------------------------------

/**
 * Fiabilité, en français de manager.
 *
 * La vue principale ne contient aucun terme technique : elle dit ce que le
 * modèle s'est montré capable de faire. PR-AUC, Brier et compagnie existent
 * toujours, mais dans le dépliage, pour qui veut vérifier — pas dans la lecture
 * qu'on envoie en capture d'écran.
 */
export function ExpectedGmvReliabilityCard({ rel }: { rel: ExpectedGmvReliability }) {
  const me = rel.month_end;
  const d7 = rel.seven_days;
  const signedOf10 = d7 ? Math.round(d7.precision_at_10 * 10) : null;
  const calibGap = d7
    ? Math.abs(d7.calibration_top_decile.predicted - d7.calibration_top_decile.observed)
    : null;

  return (
    <Card>
      <SectionTitle
        eyebrow="Transparence"
        title="Fiabilité du modèle"
        aside={
          <a href="#backtest" className="-my-2 inline-block py-2 underline decoration-dotted hover:text-ink md:my-0 md:py-0">
            Voir le détail du backtest
          </a>
        }
      />
      <div className="grid gap-x-10 gap-y-4 px-4 md:px-6 py-4 sm:grid-cols-2">
        {me ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
              Fin de mois
            </p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink-soft">
              <li>
                Erreur médiane observée :{" "}
                <span className="tabular font-medium text-ink">{pct(me.median_abs_error_pct)}</span>
              </li>
              <li>
                {Math.abs(me.bias_pct) < 0.03
                  ? "Pas de tendance forte à surestimer ni à sous-estimer"
                  : me.bias_pct > 0
                    ? "Tendance à surestimer légèrement"
                    : "Tendance à sous-estimer légèrement"}
              </li>
              <li>
                Zone probable correcte dans{" "}
                <span className="tabular font-medium text-ink">
                  {me.interval_covered} cas sur {me.interval_total}
                </span>
              </li>
            </ul>
          </div>
        ) : null}
        {d7 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
              7 jours
            </p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink-soft">
              <li>
                <span className="tabular font-medium text-ink">{signedOf10} affaires sur les 10</span>{" "}
                les mieux classées ont signé sous 7 jours
              </li>
              <li>
                Qualité du classement :{" "}
                <span className="font-medium text-ink">
                  {d7.lift_top_decile >= 3 ? "nettement meilleure que le hasard" : "meilleure que le hasard"}
                </span>
              </li>
              <li>
                {calibGap != null && calibGap < 0.05
                  ? "Probabilités globalement cohérentes avec les résultats"
                  : "Probabilités à interpréter avec prudence"}
              </li>
            </ul>
          </div>
        ) : null}
      </div>

      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-xs text-ink-faint hover:text-ink">
          <span className="underline decoration-dotted">Détail technique</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▸
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▾
          </span>
        </summary>
        <dl className="grid gap-x-10 gap-y-1.5 border-t border-line px-4 md:px-6 py-3 text-xs sm:grid-cols-2">
          {me ? (
            <>
              <Detail
                label="Erreur moyenne absolue (fin de mois)"
                value={`${Math.round(me.mae / 1000)} k€ sur ${me.snapshots} dates rejouées`}
              />
              <Detail label="Biais global en euros" value={signedPct(me.bias_pct)} />
              <Detail label="PR-AUC fin de mois" value={me.pr_auc.toFixed(4).replace(".", ",")} />
              <Detail label="Brier fin de mois" value={me.brier.toFixed(5).replace(".", ",")} />
              <Detail label="Modèle fin de mois" value={me.model} />
            </>
          ) : null}
          {d7 ? (
            <>
              <Detail label="PR-AUC 7 jours" value={d7.pr_auc.toFixed(4).replace(".", ",")} />
              <Detail label="Brier 7 jours" value={d7.brier.toFixed(5).replace(".", ",")} />
              <Detail
                label="Lift du 1er décile"
                value={`${d7.lift_top_decile.toFixed(2).replace(".", ",")}× le taux moyen`}
              />
              <Detail
                label="Calibration, 10 % d'affaires les mieux classées"
                value={`${pct(d7.calibration_top_decile.predicted)} annoncés, ${pct(
                  d7.calibration_top_decile.observed,
                )} réalisés`}
              />
              <Detail label="Modèle 7 jours" value={d7.model} />
            </>
          ) : null}
        </dl>
      </details>

      <p className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
        Mesuré sur {me?.test_window ?? "la période de test"}, hors échantillon : ces trois mois
        n&apos;ont jamais servi à entraîner les modèles.
      </p>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular text-right text-ink-soft">{value}</dd>
    </div>
  );
}

// --- Tableau par commercial -------------------------------------------------

export function ExpectedGmvBySalesperson({
  rows,
  region,
  horizon,
}: {
  rows: ExpectedGmvSalesperson[];
  region: ExpectedGmvSnapshot["region"];
  horizon: "7j" | "mois";
}) {
  const hl = (isHorizon: boolean) => (isHorizon ? "font-medium text-ink" : "text-ink-soft");
  return (
    <Card>
      <SectionTitle
        eyebrow="Niveau commercial"
        title="Par commercial"
        aside="Répartition d'une prévision, pas un classement de performance"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Commercial</th>
              <th className="px-3 py-2 text-right font-medium">GMV ouvert</th>
              <th className="px-3 py-2 text-right font-medium">GMV probable 7 j</th>
              <th className="px-3 py-2 text-right font-medium">{LABEL.probableGmv}</th>
              <th className="px-3 py-2 text-right font-medium">Signé</th>
              <th className="px-3 py-2 text-right font-medium">Prévision RM Morning</th>
              <th className="px-4 md:px-6 py-2 text-right font-medium">Opps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.salesperson} className="border-b border-line last:border-0">
                <td className="px-4 md:px-6 py-2 font-medium">{s.salesperson}</td>
                <td className="tabular px-3 py-2 text-right text-ink-soft">{kEur(s.openGmv)}</td>
                <td className={`tabular px-3 py-2 text-right ${hl(horizon === "7j")}`}>
                  {kEur(s.expected7d)}
                </td>
                <td className={`tabular px-3 py-2 text-right ${hl(horizon === "mois")}`}>
                  {kEur(s.expectedMonthEnd)}
                </td>
                <td className="tabular px-3 py-2 text-right text-ink-soft">
                  {s.signedGmv > 0 ? kEur(s.signedGmv) : "—"}
                </td>
                <td className="tabular px-3 py-2 text-right font-medium">{kEur(s.expectedFinish)}</td>
                <td className="tabular px-4 md:px-6 py-2 text-right text-xs text-ink-faint">{s.count}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-canvas">
              <td className="px-4 md:px-6 py-3 text-sm font-semibold">TOTAL RÉGION</td>
              <td className="tabular px-3 py-3 text-right text-sm font-medium text-ink-soft">
                {kEur(region.openGmv)}
              </td>
              <td className="tabular px-3 py-3 text-right text-sm font-semibold">
                {kEur(region.expected7d)}
              </td>
              <td className="tabular px-3 py-3 text-right text-sm font-semibold">
                {kEur(region.expectedRemaining)}
              </td>
              <td className="tabular px-3 py-3 text-right text-sm font-medium text-ink-soft">
                {kEur(region.signedGmv)}
              </td>
              <td className="tabular px-3 py-3 text-right text-base font-semibold">
                {kEur(region.expectedFinish)}
              </td>
              <td className="tabular px-4 md:px-6 py-3 text-right text-xs text-ink-faint">{region.count}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
        Pas d&apos;intervalle par commercial : sur des volumes de cette taille, une fourchette serait
        plus trompeuse qu&apos;utile.
      </p>
    </Card>
  );
}

// --- Tableau par opportunité ------------------------------------------------

/**
 * Les mesures secondaires de la ligne, sorties du premier scan.
 *
 * Elles ne disparaissent pas : elles descendent dans le détail de ligne, qui ne
 * se monte qu'à l'ouverture. Le tableau passe ainsi de treize colonnes — dont
 * six purement analytiques — à sept colonnes de décision.
 */
function rowDetail(
  o: ExpectedGmvOpportunity,
  horizon: "7j" | "mois",
): { label: string; value: string }[] {
  const other =
    horizon === "7j"
      ? { label: LABEL.chanceThisMonth, value: `${pct(o.pMonthEnd)} · ${formatEurShort(o.expectedMonthEnd)}` }
      : { label: LABEL.chanceSevenDays, value: `${pct(o.p7d)} · ${formatEurShort(o.expected7d)}` };
  const out: { label: string; value: string }[] = [other];
  if (o.nextMilestone) {
    out.push({
      label: LABEL.nextStep,
      value: o.nextMilestoneDueAt
        ? `${o.nextMilestone} — ${formatFrenchDate(o.nextMilestoneDueAt.slice(0, 10))}`
        : o.nextMilestone,
    });
  }
  out.push({
    label: LABEL.stageAge,
    value: o.daysInStage == null ? "non datable" : `${Math.round(o.daysInStage)} jours`,
  });
  out.push({ label: "Jours restants dans le mois", value: String(o.daysLeftInMonth) });
  if (o.amountBin) out.push({ label: "Tranche de GMV", value: o.amountBin });
  // Contexte déclaratif : n'entre dans aucun des deux modèles.
  out.push({ label: "Mois annoncé par le commercial", value: o.kanbanMonth ?? "aucun" });
  return out;
}

/**
 * La situation de l'affaire, en vocabulaire métier.
 *
 * Reprend exactement les termes déjà employés par Forecast — « À challenger »,
 * l'état de gel — plutôt que d'exposer un motif technique. Aucune règle n'est
 * calculée ici : la liste des affaires à challenger vient de Forecast V2, seule
 * source de cette définition dans l'application.
 */
function Situation({ o, challenged }: { o: ExpectedGmvOpportunity; challenged: boolean }) {
  if (challenged) return <Badge tone="warning">{LABEL.challenge}</Badge>;
  if (o.frozenMonthEnd) {
    return (
      <span className="text-ink-faint">
        Gelée jusqu&apos;au {formatFrenchDate(o.standbyUntil?.slice(0, 10) ?? null)}
      </span>
    );
  }
  if (o.isStandby) return <span className="text-ink-faint">En stand-by</span>;
  return <span className="text-ink-faint">—</span>;
}


export function ExpectedGmvOpportunities({
  rows,
  horizon,
  total,
  challenged,
}: {
  /** Identifiants des affaires à challenger, produits par Forecast V2. */
  challenged?: Set<string>;
  rows: ExpectedGmvOpportunity[];
  horizon: "7j" | "mois";
  total: number;
}) {
  return (
    <Card>
      <SectionTitle
        eyebrow="Niveau opportunité"
        title="Affaires scorées"
        aside={`${rows.length} affichée${rows.length > 1 ? "s" : ""} sur ${total}`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="w-[20%] px-4 md:px-6 py-1.5 font-medium">Client</th>
              <th className="w-[13%] px-3 py-1.5 font-medium">Commercial</th>
              <th className="w-[6.5rem] px-3 py-1.5 text-right font-medium">GMV</th>
              <th className="w-[13%] px-3 py-1.5 font-medium">Étape</th>
              {/*
                Une seule colonne de probabilité : le sélecteur d'horizon change
                la question posée, il n'ajoute pas deux colonnes de plus. La
                seconde probabilité reste lisible en ouvrant la ligne.
              */}
              <th className="w-[8rem] px-3 py-1.5 text-right font-medium">
                {horizon === "7j" ? LABEL.chanceSevenDays : LABEL.chanceThisMonth}
              </th>
              <th className="w-[7rem] px-3 py-1.5 text-right font-medium">{LABEL.probableGmv}</th>
              <th className="w-[14%] px-4 md:px-6 py-1.5 font-medium">Situation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.opportunityId} className="border-b border-line/70 align-top last:border-0">
                <td className="px-4 md:px-6 py-1.5">
                  <span className="font-medium">{o.client}</span>
                  {o.city ? <span className="block text-xs text-ink-faint">{o.city}</span> : null}
                </td>
                <td className="truncate px-3 py-1.5 text-xs text-ink-soft">{o.owner}</td>
                <td className="tabular whitespace-nowrap px-3 py-1.5 text-right font-medium">
                  {formatEurShort(o.gmv)}
                </td>
                <td className="truncate px-3 py-1.5 text-xs text-ink-soft">{o.stage ?? "—"}</td>
                <td className="px-3 py-1.5 text-right">
                  <ProbabilityWithFactors
                    probability={pct(horizon === "7j" ? o.p7d : o.pMonthEnd)}
                    factors={o.factors}
                    detail={rowDetail(o, horizon)}
                  />
                </td>
                <td className="tabular whitespace-nowrap px-3 py-1.5 text-right text-xs">
                  {formatEurShort(horizon === "7j" ? o.expected7d : o.expectedMonthEnd)}
                </td>
                <td className="px-4 md:px-6 py-1.5 text-xs">
                  <Situation o={o} challenged={challenged?.has(o.opportunityId) ?? false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 md:px-6 py-2 text-xs text-ink-faint">
        Cliquer sur une probabilité montre ce qui la compose, ainsi que l&apos;autre horizon,
        l&apos;ancienneté dans l&apos;étape et le mois annoncé par le commercial.
      </p>
    </Card>
  );
}

// --- Backtest et limites ----------------------------------------------------

export function ExpectedGmvBacktest({ rel }: { rel: ExpectedGmvReliability }) {
  const rows = rel.backtest ?? [];
  const me = rel.month_end;
  const months = [...new Set(rows.map((r) => r.month))];
  return (
    <Card className="scroll-mt-6">
      <SectionTitle
        eyebrow="Contrôle"
        title="Comment le modèle s'est comporté ?"
        aside={me?.test_window}
      />
      <div className="px-4 md:px-6 py-4">
        <p className="text-sm text-ink-soft">
          Chaque ligne rejoue une date passée : on ne garde que ce qui était connu ce jour-là, on
          score le pipe ouvert, et on compare au mois réellement réalisé. Une affaire ne compte
          qu&apos;une seule fois par date.
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          L&apos;erreur médiane observée sur le backtest est d&apos;environ{" "}
          <span className="font-medium text-ink">{me ? pct(me.median_abs_error_pct) : "—"}</span>. La
          zone probable a contenu le résultat réel sur{" "}
          <span className="font-medium text-ink">
            {me?.interval_covered ?? "—"} des {me?.interval_total ?? "—"} dates testées
          </span>
          .
        </p>
      </div>
      {/* Le détail reste replié : la page ne doit pas s'allonger de treize
          lignes de tableau pour dire ce que les deux phrases résument déjà. */}
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-sm text-ink-soft hover:text-ink">
          <span className="underline decoration-dotted">
            Voir les {rows.length} dates rejouées, mois par mois
          </span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▸
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▾
          </span>
        </summary>
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 md:px-6 py-2 font-medium">Date</th>
                <th className="px-3 py-2 text-right font-medium">Signé à date</th>
                <th className="px-3 py-2 text-right font-medium">Prévision RM Morning</th>
                <th className="px-3 py-2 text-right font-medium">Réalisé</th>
                <th className="px-3 py-2 text-right font-medium">Écart</th>
                <th className="px-4 md:px-6 py-2 text-right font-medium">Écart %</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <ExpectedGmvBacktestMonth key={m} month={m} rows={rows.filter((r) => r.month === m)} />
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

/**
 * Fraîcheur des données. Un écran de prévision qui ne dit pas de quand datent
 * ses données laisse croire qu'il est temps réel ; au-delà de vingt-quatre
 * heures l'avertissement passe en orange.
 */
export function ExpectedGmvFreshness({ snap }: { snap: ExpectedGmvSnapshot }) {
  // Deux sources structurantes, deux fraîcheurs. L'import porte l'étape et le
  // GMV ; l'extraction des transitions porte le temps passé dans l'étape. Un
  // scoring dont l'une des deux est périmée ne doit pas se présenter comme à
  // jour, même si l'autre est fraîche.
  const dataStale = snap.dataAgeHours != null && snap.dataAgeHours > 24;
  const historyStale = snap.historyAgeHours != null && snap.historyAgeHours > 24;
  const stale = dataStale || historyStale || snap.supersededByImport;
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
  const age = (h: number | null) =>
    h == null ? "" : h < 24 ? `${h.toFixed(1)} h` : `${Math.floor(h / 24)} j`;

  // Deux niveaux. Au premier, les trois horodatages : c'est ce qu'on vient
  // vérifier. Au second, ce que la vétusté change concrètement — des phrases
  // entières, qui occupaient six lignes en tête d'écran sur 375 px et faisaient
  // passer le diagnostic technique avant la prévision elle-même. Rien n'est
  // retiré : le repli est signalé et le compte des remarques est visible.
  const notes: string[] = [];
  if (snap.supersededByImport)
    notes.push(
      `Un import Salesforce plus récent (${fmt(snap.currentImportAt)}) a été chargé depuis ce scoring : relancer le scoring pour que cette prévision décrive l'état actuel.`,
    );
  if (dataStale && historyStale)
    notes.push("Les deux sources ont plus de 24 h : cette prévision n'est pas à jour.");
  else if (dataStale)
    notes.push("L'état Salesforce a plus de 24 h : cette prévision n'est pas à jour.");
  else if (historyStale)
    notes.push(
      "L'historique des étapes a plus de 24 h : le temps passé dans l'étape est approximatif.",
    );
  if (snap.stageFromImport > 0)
    notes.push(`${snap.stageFromImport} affaire(s) sans date d'entrée dans l'étape.`);
  if (snap.standby.count > 0)
    notes.push(
      `${snap.standby.count} stand-by (${kEur(snap.standby.gmv)}), dont ${snap.standby.frozenMonthEnd} gelé(s) au-delà du mois et donc comptés à zéro.`,
    );

  return (
    <div
      className={`rounded-lg border px-4 py-2.5 text-xs ${
        stale ? "border-warning-soft bg-warning-soft text-warning" : "border-line bg-surface text-ink-soft"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
      <span>
        État des données : <span className="tabular font-medium">{fmt(snap.dataAsOf)}</span>
        {snap.dataAgeHours != null ? (
          <span className={dataStale ? " font-medium" : " text-ink-faint"}> ({age(snap.dataAgeHours)})</span>
        ) : null}
      </span>
      <span>
        Historique des étapes : <span className="tabular font-medium">{fmt(snap.historyAsOf)}</span>
        {snap.historyAgeHours != null ? (
          <span className={historyStale ? " font-medium" : " text-ink-faint"}>
            {" "}
            ({age(snap.historyAgeHours)})
          </span>
        ) : null}
      </span>
      <span>
        Expected scoré : <span className="tabular font-medium">{fmt(snap.scoredAt)}</span>
      </span>
      </div>
      {notes.length > 0 ? (
        <details className="mt-1">
          <summary className="inline-flex min-h-9 cursor-pointer list-none items-center underline decoration-dotted underline-offset-2 md:min-h-0">
            {notes.length === 1 ? "1 remarque sur ces données" : `${notes.length} remarques sur ces données`}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ExpectedGmvBacktestMonth({
  month,
  rows,
}: {
  month: string;
  rows: NonNullable<ExpectedGmvReliability["backtest"]>;
}) {
  const actual = rows[0]?.actual_finish ?? 0;
  return (
    <>
      <tr className="border-b border-line bg-canvas">
        <td colSpan={6} className="px-4 md:px-6 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          {monthLabel(month)} · finish réel {kEur(actual)}
        </td>
      </tr>
      {rows.map((r) => {
        const bad = Math.abs(r.error_pct) > 0.25;
        return (
          <tr key={r.date} className="border-b border-line last:border-0">
            <td className="tabular px-4 md:px-6 py-2">{formatFrenchDate(r.date)}</td>
            <td className="tabular px-3 py-2 text-right text-ink-soft">{kEur(r.signed_to_date)}</td>
            <td className="tabular px-3 py-2 text-right font-medium">{kEur(r.expected_finish)}</td>
            <td className="tabular px-3 py-2 text-right text-ink-soft">{kEur(r.actual_finish)}</td>
            <td className="tabular px-3 py-2 text-right text-ink-soft">{kEur(r.error)}</td>
            <td className={`tabular px-4 md:px-6 py-2 text-right ${bad ? "font-medium text-warning" : "text-ink-soft"}`}>
              {signedPct(r.error_pct)}
            </td>
          </tr>
        );
      })}
    </>
  );
}

export function ExpectedGmvLimits({ outOfScopeShare }: { outOfScopeShare: number }) {
  return (
    <Card>
      <SectionTitle eyebrow="Honnêteté" title="À savoir" />
      <ul className="space-y-2 px-4 md:px-6 py-4 text-sm text-ink-soft">
        <li>
          Environ <span className="font-medium text-ink">{pct(outOfScopeShare, 0)}</span> du GMV final
          d&apos;un mois vient d&apos;affaires créées après la date du forecast. Aucune prévision ne
          peut les anticiper.
        </li>
        <li>
          La Projection Kanban et la Perspective ne sont pas utilisées comme variables : leur
          historique est trop court pour être appris.
        </li>
        <li>Les signaux Gmail ne sont pas utilisés par les modèles.</li>
        <li>
          Les très grosses affaires sont rares dans l&apos;historique. Au-delà de 200 k€, les
          probabilités reposent sur peu de cas.
        </li>
      </ul>
    </Card>
  );
}

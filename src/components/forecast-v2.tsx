/**
 * Composants Forecast V2 — la confrontation Signé · Kanban · Perspective · Expected.
 *
 * Forecast reste l'écran de pilotage : aucun terme de modélisation n'y apparaît.
 * La lecture visée est « les commerciaux annoncent X, RM Morning estime Y », et
 * l'écart sert à ouvrir une conversation, pas à trancher qui a raison.
 *
 * Les analyses statistiques (fiabilité, backtest, explicabilité) restent dans
 * l'onglet Expected GMV, qui n'est pas dupliqué ici.
 */

import { Badge, Card, SectionTitle } from "@/components/ui";
import { FORECAST_DIVERGENCE } from "@/lib/config";
import { MOVEMENT_LABEL, type ForecastMovement } from "@/lib/forecast-board";
import {
  DIVERGENCE_HINT,
  DIVERGENCE_LABEL,
  type Divergence,
  type ForecastV2Board,
  type ForecastV2Examine,
  type ForecastV2Row,
  type ForecastV2Salesperson,
} from "@/lib/forecast-v2";
import { formatEur, formatFrenchDate } from "@/lib/normalize";
import { CHALLENGE_LABEL } from "@/lib/forecast-v2";
import { LABEL, kEur, pct } from "@/lib/vocabulary";

const MOVEMENT_TONE: Record<ForecastMovement, "neutral" | "positive" | "warning" | "danger"> = {
  stable: "neutral",
  renforce: "positive",
  glissement: "warning",
  revenu: "positive",
  sorti: "danger",
  nouveau: "positive",
  non_comparable: "neutral",
};

const DIVERGENCE_TONE: Record<Divergence["level"], "neutral" | "positive" | "warning" | "danger"> = {
  proche: "positive",
  prudent: "warning",
  fort: "danger",
  non_qualifie: "neutral",
};

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
  const commercial = r.signedGmvActual + r.kanbanGmv;
  const m1 = board.expectedM1;
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 rounded-xl border border-line bg-surface px-4 md:px-6 py-3">
      <Total label="Signé" value={kEur(r.signedGmvActual)} />
      <Total label={LABEL.kanban} value={kEur(r.kanbanGmv)} hint={`${r.count} affaire(s)`} />
      {/*
        La Perspective est LUE, jamais recalculée sur le Salesforce du jour : on affiche le total
        du classeur tel quel — bloc « en cours » s'il existe, dernière photographie sinon. La part
        encore ouverte est une autre lecture, et elle porte son propre nom.
      */}
      <Total
        label={LABEL.perspective}
        value={kEur(r.perspectiveSnapshotGmv)}
        hint={`${r.perspectiveSnapshotLines} affaires · dont ${kEur(r.perspectiveGmv)} encore au pipe`}
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
            l&apos;équipe prévoit {kEur(r.kanbanGmv)} · écart{" "}
            {kEur(r.kanbanGmv - m1.projection)}
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
            l&apos;équipe annonce {kEur(commercial)} · écart {kEur(r.expectedFinish - commercial)}
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
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <span className="inline-flex flex-col">
      <span className="text-xs font-medium uppercase tracking-[0.06em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">{label}</span>
      <span className={`tabular tracking-tight ${strong ? "text-lg font-semibold" : "text-sm font-medium"}`}>
        {value}
      </span>
      {hint ? <span className="text-xs text-ink-faint">{hint}</span> : null}
    </span>
  );
}

/**
 * Ce que chaque chiffre compte réellement.
 *
 * Les trois périmètres sont différents et l'écran doit le dire : au 17/08/2026,
 * la prévision commerciale portait sur 8 affaires quand la prévision RM Morning
 * en scorait 279. Laisser croire qu'il s'agit du même univers transforme une
 * différence de définition en jugement sur l'équipe.
 */
export function ForecastV2Scopes({ board }: { board: ForecastV2Board }) {
  const r = board.region;
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer list-none px-4 md:px-6 py-3 text-sm font-medium hover:bg-canvas">
        Que compte chaque chiffre ?
        <span className="ml-1 group-open:hidden" aria-hidden>
          ▸
        </span>
        <span className="ml-1 hidden group-open:inline" aria-hidden>
          ▾
        </span>
        <span className="ml-2 text-xs font-normal text-ink-faint">
          les trois périmètres ne sont pas les mêmes
        </span>
      </summary>
      <dl className="space-y-3 border-t border-line px-4 md:px-6 py-4 text-sm">
        <div>
          <dt className="font-medium">
            {LABEL.kanban} — {r.count} affaire(s)
          </dt>
          <dd className="text-ink-soft">
            Les affaires que le commercial a lui-même positionnées sur ce mois dans la Projection
            Kanban de Salesforce. Sont exclues : les affaires terminées, celles en stand-by, et
            toutes celles sans Projection Kanban — même très avancées.
          </dd>
        </div>
        <div>
          <dt className="font-medium">
            {LABEL.perspective} —{" "}
            {board.perspectiveSource === "courant" ? "état courant du" : "photo du"}{" "}
            {board.perspectiveDate ? formatFrenchDate(board.perspectiveDate) : "—"}
          </dt>
          <dd className="text-ink-soft">
            Le total du classeur Perspective tel qu&apos;il a été lu — son bloc « en cours »,
            rafraîchi chaque jour, ou à défaut la dernière photographie hebdomadaire. Dans les deux
            cas, il ne se réécrit jamais en fonction de l&apos;état actuel de Salesforce.
            La mention « encore au pipe » indique la part de ces affaires toujours ouvertes
            aujourd&apos;hui — une affaire depuis signée ou perdue en sort, sans que la photo change.
          </dd>
        </div>
        <div>
          <dt className="font-medium">
            {LABEL.expectedRegion} — {r.scoredCount} affaire(s)
          </dt>
          <dd className="text-ink-soft">
            Toutes les affaires ouvertes du pipe de l&apos;équipe, qu&apos;elles soient projetées ou
            non sur ce mois. Chacune reçoit une chance de signer avant la fin du mois ; les affaires
            gelées au-delà de l&apos;échéance comptent pour zéro.
          </dd>
        </div>
      </dl>
      <p className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
        Conséquence : l&apos;écart entre prévision commerciale et prévision RM Morning mélange une
        différence de jugement et une différence de périmètre. Il ne se lit pas seul.
      </p>
    </details>
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

// --- Divergence -------------------------------------------------------------

export function ForecastV2Divergences({ board }: { board: ForecastV2Board }) {
  const flagged = board.salespeople
    .filter((s) => s.divergence.level === "fort" || s.divergence.level === "prudent")
    .sort((a, b) => a.divergence.gap - b.divergence.gap);
  if (!board.expectedAvailable) return null;

  return (
    <Card>
      <SectionTitle
        eyebrow="Confrontation"
        title="Déclaratif et estimation"
        aside={`RM Morning retient ${
          board.region.divergence.coverage == null
            ? "—"
            : Math.round(board.region.divergence.coverage * 100) + " %"
        } de ce que l'équipe prévoit`}
      />
      <div className="px-4 md:px-6 py-4">
        {flagged.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Aucun commercial ne s&apos;écarte notablement du rapport régional entre déclaratif et
            estimation.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {flagged.map((s) => (
              <li key={s.salesperson} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{s.salesperson}</span>
                <span className="tabular text-ink-soft">
                  Prévu {kEur(s.kanbanGmv)} · GMV probable {kEur(s.expectedGmv)} · écart{" "}
                  <span className="font-medium text-ink">{kEur(s.divergence.gap)}</span>
                </span>
                <Badge tone={DIVERGENCE_TONE[s.divergence.level]}>
                  {DIVERGENCE_LABEL[s.divergence.level]}
                </Badge>
                <span className="text-xs text-ink-faint">{DIVERGENCE_HINT[s.divergence.level]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-xs text-ink-faint hover:text-ink">
          <span className="underline decoration-dotted">Comment cet écart est qualifié</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▸
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▾
          </span>
        </summary>
        <div className="border-t border-line px-4 md:px-6 py-3 text-xs text-ink-soft">
          <p>
            L&apos;estimation est structurellement inférieure au déclaratif : sur la Région elle en
            couvre{" "}
            {board.region.divergence.coverage == null
              ? "—"
              : Math.round(board.region.divergence.coverage * 100) + " %"}
            . Comparer chaque commercial à l&apos;égalité les classerait tous en forte divergence.
            La référence est donc ce rapport régional, et l&apos;on mesure l&apos;écart de chacun à
            cette référence commune.
          </p>
          <ul className="mt-2 space-y-0.5">
            <li>
              <span className="font-medium">Proche</span> : au moins{" "}
              {FORECAST_DIVERGENCE.closeRatio}× le rapport régional
            </li>
            <li>
              <span className="font-medium">RM Morning plus prudent</span> : entre{" "}
              {FORECAST_DIVERGENCE.prudentRatio}× et {FORECAST_DIVERGENCE.closeRatio}×
            </li>
            <li>
              <span className="font-medium">Forte divergence</span> : moins de{" "}
              {FORECAST_DIVERGENCE.prudentRatio}×
            </li>
            <li>
              En deçà de {kEur(FORECAST_DIVERGENCE.minGap)} d&apos;écart, rien n&apos;est qualifié.
            </li>
          </ul>
          <p className="mt-2">
            Un écart n&apos;indique pas une erreur du commercial : il indique où une revue de pipe
            est probablement utile.
          </p>
        </div>
      </details>
    </Card>
  );
}

// --- À challenger -----------------------------------------------------------

/**
 * Les affaires à challenger, en tableau plutôt qu'en liste : ce sont des lignes
 * que le directeur régional va reprendre une par une dans Perspective. Fond
 * jaune pâle, la même teinte que dans Expected GMV, où la liste est identique.
 */
export function ForecastV2Challenge({
  items,
  limit = 10,
}: {
  items: ForecastV2Examine[];
  limit?: number;
}) {
  if (items.length === 0) return null;
  const head = items.slice(0, limit);
  const rest = items.slice(limit);
  return (
    <Card>
      <SectionTitle
        eyebrow="À reprendre dans Perspective"
        title={LABEL.challenge}
        aside={`${items.length} affaire(s)`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Client</th>
              <th className="px-3 py-2 font-medium">Commercial</th>
              <th className="px-3 py-2 text-right font-medium">GMV</th>
              <th className="px-3 py-2 font-medium">Étape</th>
              <th className="px-3 py-2 text-right font-medium">{LABEL.chanceThisMonth}</th>
              <th className="px-3 py-2 text-right font-medium">{LABEL.probableGmv}</th>
              <th className="px-4 md:px-6 py-2 font-medium">Pourquoi la challenger</th>
            </tr>
          </thead>
          <tbody>
            {head.map((e) => (
              <ChallengeRow key={e.row.opportunityId} item={e} />
            ))}
          </tbody>
        </table>
      </div>
      {rest.length > 0 ? (
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-sm text-ink-soft hover:text-ink">
            <span className="underline decoration-dotted">Voir les {rest.length} autres affaires</span>
            <span className="ml-1 group-open:hidden" aria-hidden>
              ▸
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              ▾
            </span>
          </summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <tbody>
                {rest.map((e) => (
                  <ChallengeRow key={e.row.opportunityId} item={e} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}

function ChallengeRow({ item }: { item: ForecastV2Examine }) {
  const r = item.row;
  return (
    <tr className="border-b border-line bg-warning-soft/60 last:border-0">
      <td className="px-4 md:px-6 py-2 font-medium">{r.client}</td>
      <td className="px-3 py-2 text-xs text-ink-soft">{r.owner}</td>
      <td className="tabular px-3 py-2 text-right font-medium">{formatEur(r.gmv)}</td>
      <td className="px-3 py-2 text-xs text-ink-soft">{r.stage ?? "—"}</td>
      <td className="tabular px-3 py-2 text-right">{pct(r.expectedProbability)}</td>
      <td className="tabular px-3 py-2 text-right text-xs font-medium">{formatEur(r.expectedGmv)}</td>
      <td className="px-4 md:px-6 py-2 text-xs text-ink-soft">
        <Badge tone="warning">{CHALLENGE_LABEL[item.kind]}</Badge>{" "}
        <span className="text-ink-faint">{item.reason}</span>
      </td>
    </tr>
  );
}

// --- Groupes commerciaux ----------------------------------------------------

/**
 * Une ligne d'affaire.
 *
 * Le fond jaune pâle porte tout le sens de l'écran : cette affaire n'est pas
 * dans ce que le commercial annonce, et RM Morning pense qu'elle mérite d'être
 * discutée. Elle est donc placée AVEC les affaires du commercial, pas dans un
 * bloc séparé qu'il faudrait recouper à la main.
 */
function Row({
  row,
  showExpected,
  challenge,
}: {
  row: ForecastV2Row;
  showExpected: boolean;
  challenge: ForecastV2Examine | undefined;
}) {
  return (
    <tr
      className={`border-b border-line last:border-0 ${challenge ? "bg-warning-soft/60" : ""}`}
    >
      <td className="px-4 md:px-6 py-2">
        <span className="font-medium">{row.client}</span>
        {row.isStandby ? (
          <span className="block text-xs text-warning">
            gelée jusqu&apos;au {formatFrenchDate(row.standbyUntil?.slice(0, 10) ?? null)}
          </span>
        ) : null}
      </td>
      <td className="tabular px-3 py-2 text-right font-medium">{formatEur(row.gmv)}</td>
      <td className="px-3 py-2 text-center text-xs">
        {row.outsideKanban ? (
          <span className="text-ink-faint">{row.kanbanMonth ?? "—"}</span>
        ) : (
          <span className="text-ink-soft">{row.kanbanRaw ?? "oui"}</span>
        )}
      </td>
      <td className="px-3 py-2 text-center text-xs">
        {row.perspectiveGmv != null ? (
          <span className="tabular text-ink-soft">{formatEur(row.perspectiveGmv)}</span>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </td>
      {showExpected ? (
        <>
          <td className="tabular px-3 py-2 text-right">{pct(row.expectedProbability)}</td>
          <td className="tabular px-3 py-2 text-right text-xs font-medium">
            {row.expectedGmv == null ? "—" : formatEur(row.expectedGmv)}
          </td>
        </>
      ) : null}
      <td className="px-3 py-2 text-xs text-ink-soft">{row.nextExpectedLabel ?? "—"}</td>
      <td className="px-4 md:px-6 py-2 text-xs">
        {challenge ? (
          <>
            <Badge tone="warning">{CHALLENGE_LABEL[challenge.kind]}</Badge>{" "}
            <span className="text-ink-soft">{challenge.reason}</span>
          </>
        ) : row.reading ? (
          <span className="text-warning">{row.reading}</span>
        ) : (
          <Badge tone={MOVEMENT_TONE[row.movement]}>{MOVEMENT_LABEL[row.movement]}</Badge>
        )}
      </td>
    </tr>
  );
}

/**
 * Le tableau de rapprochement. C'est le produit de la page.
 *
 * Un commercial, son sous-total, ses affaires — celles qu'il annonce, celles de
 * la dernière Perspective, et celles que RM Morning conseille de challenger,
 * mélangées volontairement dans une seule liste pour qu'une lecture suffise.
 */
export function ForecastV2Salespeople({
  board,
  openAll,
  hiddenByOwner,
  showAllLink,
}: {
  board: ForecastV2Board;
  openAll: boolean;
  hiddenByOwner?: Map<string, number>;
  showAllLink?: string;
}) {
  const show = board.expectedAvailable;
  const challengeById = new Map(board.examine.map((e) => [e.row.opportunityId, e]));
  return (
    <Card>
      <div className="divide-y divide-line">
        {board.salespeople.map((s) => (
          <Group
            key={s.salesperson}
            block={s}
            showExpected={show}
            open={openAll}
            challengeById={challengeById}
            hidden={hiddenByOwner?.get(s.salesperson) ?? 0}
            showAllLink={showAllLink}
          />
        ))}
      </div>
      <div className="border-t-2 border-line-strong bg-canvas px-4 md:px-6 py-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
          <span className="font-semibold">TOTAL RÉGION</span>
          <span className="tabular text-ink-soft">
            Signé <span className="font-medium text-ink">{kEur(board.region.signedGmvActual)}</span>
          </span>
          <span className="tabular text-ink-soft">
            Prévu <span className="font-medium text-ink">{kEur(board.region.kanbanGmv)}</span>
          </span>
          <span className="tabular text-ink-soft">
            Perspective{" "}
            <span className="font-medium text-ink">{kEur(board.region.perspectiveGmv)}</span>
          </span>
          {show ? (
            <span className="tabular text-ink-soft">
              GMV probable{" "}
              <span className="text-base font-semibold text-ink">
                {kEur(board.region.expectedRemaining)}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Group({
  block,
  showExpected,
  open,
  challengeById,
  hidden,
  showAllLink,
}: {
  block: ForecastV2Salesperson;
  showExpected: boolean;
  open: boolean;
  challengeById: Map<string, ForecastV2Examine>;
  hidden: number;
  showAllLink?: string;
}) {
  const rows = block.opportunities
    .slice()
    .sort((a, b) => {
      // Les affaires annoncées d'abord, les suggestions ensuite : on lit ce que
      // le commercial dit, puis ce que RM Morning ajoute.
      if (a.outsideKanban !== b.outsideKanban) return a.outsideKanban ? 1 : -1;
      return (b.expectedGmv ?? 0) - (a.expectedGmv ?? 0) || (b.gmv ?? 0) - (a.gmv ?? 0);
    });
  const yellow = rows.filter((r) => challengeById.has(r.opportunityId)).length;

  return (
    <details open={open} className="group">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-4 gap-y-1 px-4 md:px-6 py-3 hover:bg-canvas">
        <span className="text-sm font-semibold">{block.salesperson}</span>
        <span className="tabular text-xs text-ink-soft">
          Signé {kEur(block.signedGmvActual)} · prévu {kEur(block.kanbanGmv)} · Perspective{" "}
          {kEur(block.perspectiveGmv)}
          {showExpected ? ` · GMV probable ${kEur(block.expectedGmv)}` : ""}
        </span>
        {yellow > 0 ? <Badge tone="warning">{yellow} à challenger</Badge> : null}
        <span className="ml-auto text-xs text-ink-faint">
          {rows.length} affaire(s)
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▸
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▾
          </span>
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Client</th>
              <th className="px-3 py-2 text-right font-medium">GMV</th>
              <th className="px-3 py-2 text-center font-medium">{LABEL.kanbanRow}</th>
              <th className="px-3 py-2 text-center font-medium">Dans ma dernière Perspective</th>
              {showExpected ? (
                <>
                  <th className="px-3 py-2 text-right font-medium">{LABEL.chanceThisMonth}</th>
                  <th className="px-3 py-2 text-right font-medium">{LABEL.probableGmv}</th>
                </>
              ) : null}
              <th className="px-3 py-2 font-medium">{LABEL.nextStep}</th>
              <th className="px-4 md:px-6 py-2 font-medium">Pourquoi la challenger</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.opportunityId}
                row={r}
                showExpected={showExpected}
                challenge={challengeById.get(r.opportunityId)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && showAllLink ? (
        <p className="border-t border-line px-4 md:px-6 py-2 text-xs text-ink-faint">
          <a href={showAllLink} className="-my-2 inline-block py-2 underline decoration-dotted hover:text-ink md:my-0 md:py-0">
            Voir les autres affaires estimées de {block.salesperson} ({hidden}) ▾
          </a>
        </p>
      ) : null}
    </details>
  );
}

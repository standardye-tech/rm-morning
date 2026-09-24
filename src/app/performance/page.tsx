import { MomentumBlock, type MomentumSort } from "@/components/momentum";
import {
  Movers,
  PerformanceDetail,
  PerformanceEmpty,
  PerformanceNotes,
  PerformanceTableCard,
} from "@/components/performance";
import { parisDate } from "@/lib/business-time";
import { PERFORMANCE } from "@/lib/config";
import { buildPerformanceBoard } from "@/lib/performance";
import {
  previousSnapshotDate,
  ranksAt,
  recordPerformanceSnapshot,
} from "@/lib/performance-store";
import { latestImport, loadOpportunities } from "@/lib/repository";
import { buildMomentum } from "@/lib/since-last-snapshot";
import { lastCompleteRun } from "@/lib/sync/store";

export const dynamic = "force-dynamic";

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });
const HEURE = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** « aujourd'hui à 17:42 » quand c'est le jour même, la date complète sinon. */
function freshness(iso: string): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? `aujourd'hui à ${HEURE.format(at)}` : DATE_TIME.format(at);
}

/**
 * Performance commerciale.
 *
 * Le classement est CALCULÉ À CHAQUE AFFICHAGE, jamais lu d'un cache : il doit
 * suivre les données, et les données bougent à chaque actualisation. La photo du
 * jour est ensuite enregistrée — même geste que le triage des signaux mail au
 * chargement du Morning : idempotent, il corrige la photo du jour courant et ne
 * touche jamais aux jours passés.
 *
 * L'ordre des opérations compte. Les rangs de la photo PRÉCÉDENTE sont lus AVANT
 * d'écrire celle du jour : les lire après reviendrait à comparer le classement à
 * lui-même et à n'afficher jamais aucune évolution.
 */
export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const selected = typeof query.commercial === "string" ? query.commercial : null;
  const momentumSort: MomentumSort =
    query.momentum === "note-desc" || query.momentum === "note-asc" ? query.momentum : "alpha";
  const momentumHref = (sort: MomentumSort) => {
    const sp = new URLSearchParams();
    if (selected) sp.set("commercial", selected);
    if (sort !== "alpha") sp.set("momentum", sort);
    return `/performance${sp.toString() ? `?${sp}` : ""}#momentum`;
  };

  const now = new Date();
  const previousDate = previousSnapshotDate(parisDate(now));
  const previous = previousDate ? ranksAt(previousDate) : new Map<string, number>();

  const board = buildPerformanceBoard(now, previous, previousDate);
  recordPerformanceSnapshot(board.salespeople, now);

  const lastImport = latestImport();
  // L'heure affichée est celle des DONNÉES, pas celle du rendu de la page.
  // « Actualiser RM » recalcule désormais Performance à la fin de son cycle :
  // l'horodatage de cette actualisation est donc l'instant exact où le
  // classement et ses sources ont été mis en cohérence. À défaut — première
  // utilisation, ou actualisation jamais menée à son terme — on retombe sur
  // l'import Salesforce, qui reste une date de donnée et non de consultation.
  const lastSync = lastCompleteRun();
  const dataAt = lastSync?.completedAt ?? lastImport?.importedAt ?? null;
  const detail = selected
    ? (board.salespeople.find((s) => s.salesperson === selected) ?? null)
    : null;

  // Momentum 7 jours — audit V3.2. Réutilise le moteur du bloc « Depuis
  // hier » de Morning (since-last-snapshot.ts), fenêtre élargie à ~7 jours.
  const momentum = buildMomentum(parisDate(now), loadOpportunities());

  if (board.salespeople.length === 0) {
    return (
      <div className="py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Performance commerciale</h1>
        <PerformanceEmpty />
      </div>
    );
  }

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Performance commerciale</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {board.salespeople.length} commerciaux analysés ·{" "}
            {dataAt ? `Mis à jour : ${freshness(dataAt)}` : "aucune actualisation enregistrée"}
            {lastSync == null && lastImport
              ? " (dernier import Salesforce, actualisation complète jamais terminée)"
              : ""}
          </p>
          <p className="mt-1 max-w-3xl text-xs text-ink-faint">
            Score YTD — depuis le 1<sup>er</sup> janvier {new Date(board.computedAt).getFullYear()},
            et non sur douze mois glissants. Production signée sur {board.monthsLabel} ; qualité de
            traitement et pipe futur mesurés sur leur état d&apos;aujourd&apos;hui. Le classement
            n&apos;est pas un classement au GMV.{" "}
            {board.comparedTo
              ? `Mouvement de rang mesuré par rapport à la photo du ${DATE.format(new Date(board.comparedTo))}.`
              : "Aucune photo antérieure comparable : le mouvement de rang n'est pas affiché."}{" "}
            Modèle de calcul {board.modelVersion}.
          </p>
        </div>
      </div>

      {/*
        Ordre d'usage, et il est délibéré : qui monte, qui décroche, puis le
        classement. Les deux premières lignes répondent aux questions du matin
        avant d'avoir lu treize lignes de tableau.
      */}
      <Movers board={board} seuil={PERFORMANCE.dynamicSignificantDelta} />
      <PerformanceTableCard
        board={board}
        selected={selected}
        seuil={PERFORMANCE.dynamicSignificantDelta}
      />
      {detail ? <PerformanceDetail row={detail} /> : null}
      <div id="momentum" className="scroll-mt-6">
        <MomentumBlock momentum={momentum} sort={momentumSort} sortHref={momentumHref} />
      </div>
      <PerformanceNotes notes={board.notes} />
    </div>
  );
}

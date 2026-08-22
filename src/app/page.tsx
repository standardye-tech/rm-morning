import { AlertsBlock, TopDeals, WeekForecastBlock } from "@/components/morning";
import { HotClients, SilentButStrong, TodayPlan, WaitingClients } from "@/components/morning-v2";
import { Card, Stat } from "@/components/ui";
import { THRESHOLDS } from "@/lib/config";
import { computeWeekForecast } from "@/lib/forecast";
import { computeMetrics } from "@/lib/metrics";
import { todayIso } from "@/lib/normalize";
import { latestImport, loadOpportunities } from "@/lib/repository";
import { latestSignalByOpportunity } from "@/lib/mail-store";
import { buildAlerts, scoreDeals } from "@/lib/scoring";
import { syncMorningEvents } from "@/lib/morning-events";
import { buildMorningPlan } from "@/lib/morning-priority";
import { buildForecastV2 } from "@/lib/forecast-v2";
import { LABEL, kEur } from "@/lib/vocabulary";

export const dynamic = "force-dynamic";

const LONG_DATE = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export default function MorningPage() {
  const lastImport = latestImport();

  if (!lastImport) {
    return (
      <div className="py-16">
        <Card className="px-8 py-10 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Aucune donnée importée</h1>
          {/*
            Même sur l'écran de démarrage, le point d'entrée reste unique :
            « Actualiser RM Morning », dans l'en-tête. Un second bouton ici
            n'importerait que les opportunités, sans recalculer les prévisions —
            exactement l'état incohérent que l'orchestration a supprimé.
          */}
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
            Lancez « Actualiser RM Morning » en haut de l&apos;écran pour charger les
            opportunités de l&apos;équipe. L&apos;import de l&apos;export{" "}
            <code className="font-mono text-xs">.xls</code> reste disponible en secours depuis la
            page Données.
          </p>
        </Card>
      </div>
    );
  }

  // La date de référence est celle du snapshot importé : tous les calculs
  // d'ancienneté et de projection restent cohérents avec la donnée affichée.
  const referenceDate = lastImport.snapshotDate;
  const opportunities = loadOpportunities();
  const metrics = computeMetrics(opportunities, referenceDate);
  const forecast = computeWeekForecast(
    opportunities,
    referenceDate,
    metrics.currentMonth,
    metrics.currentYear,
  );
  // Signaux Gmail rattachés de façon fiable. `latestSignalByOpportunity` ne
  // renvoie que les niveaux A et B : un fil de niveau C est stocké et
  // historisé, mais n'influence jamais le brief.
  const mailSignals = latestSignalByOpportunity();
  const deals = scoreDeals(opportunities, metrics, mailSignals);
  const topDeals = deals.slice(0, THRESHOLDS.maxTopDeals);
  const alerts = buildAlerts(
    opportunities,
    metrics,
    forecast.standbyTransitions,
    forecast,
    mailSignals,
  );
  // Les anomalies de pistes et les opportunités à débloquer alimentaient
  // l'ancien `buildActions`. Elles appartiennent au Monitoring : Morning V2 ne
  // les remonte plus au seul motif qu'elles existent.

  // Morning V2. Le triage des signaux mail est rejoué à chaque affichage : il
  // est idempotent et ne touche pas l'état de prise en compte déjà enregistré.
  //
  // `buildActions` du Passage V0 n'est plus utilisé : il plafonnait à cinq
  // actions et mélangeait le travail de fond du Monitoring avec la valeur
  // immédiate. Les anomalies de suivi restent dans Monitoring et n'entrent ici
  // que si un client parle ou si l'affaire pèse sur le mois.
  syncMorningEvents();
  const plan = buildMorningPlan();

  const lowStock = metrics.owners.filter(
    (o) => o.activeCount > 0 && o.activeGmv < THRESHOLDS.activeGmvLow,
  ).length;
  const isToday = referenceDate === todayIso();

  // Chiffres de fin de mois, lus de Forecast V2 : aucune duplication de calcul.
  const board = buildForecastV2(0);
  const kanbanFinish = board.region.signedGmvActual + board.region.kanbanGmv;
  const signedCount = board.expected?.region.signedCount ?? 0;
  const sevenDays = board.expected?.region.expected7d ?? null;

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Brief du {LONG_DATE.format(new Date(`${referenceDate}T12:00:00`))}
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {metrics.owners.length} commerciaux suivis · {lastImport.teamRows} opportunités
            importées{isToday ? "" : " (données non rafraîchies aujourd'hui)"}
            {plan.lastRead
              ? ` · dernière lecture le ${new Date(plan.lastRead).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`
              : " · première lecture"}
          </p>
        </div>
      </div>

      {/*
        Bandeau volontairement resserré sur la fin du mois : ce sont les seuls
        chiffres sur lesquels le directeur régional peut agir aujourd'hui. Le
        pipe actif, le GMV gelé et le forecast de la semaine sont des mesures de
        stock — ils ont leur place ailleurs, pas en tête du brief.

        Aucun chiffre n'est recalculé ici : tout vient de Forecast V2, qui compose
        lui-même le déclaratif et le service Expected.
      */}
      <Card className="mt-6 grid grid-cols-2 divide-x divide-y divide-line [&>*:last-child]:col-span-2 md:grid-cols-3 md:[&>*:last-child]:col-span-1 lg:grid-cols-5">
        <Stat label={LABEL.signed} value={kEur(board.region.signedGmvActual)} hint={`${signedCount} affaire(s)`} />
        <Stat label={LABEL.kanbanFinish} value={kEur(kanbanFinish)} hint="fin de mois annoncée" />
        {board.expectedAvailable ? (
          <>
            <Stat
              label={LABEL.expectedFinish}
              value={kEur(board.region.expectedFinish)}
              hint="fin de mois estimée"
            />
            <Stat
              label={LABEL.probableZone}
              value={`${kEur(board.region.p10)} – ${kEur(board.region.p90)}`}
              hint="fourchette de la prévision"
            />
          </>
        ) : (
          <Stat label={LABEL.expectedFinish} value="—" hint="pas de prévision pour ce mois" />
        )}
        {board.region.objective != null ? (
          <Stat
            label={LABEL.gapToObjective}
            value={kEur(board.region.expectedGapToObjective)}
            tone={(board.region.expectedGapToObjective ?? 0) > 0 ? "warning" : "positive"}
            hint="objectif moins la prévision"
          />
        ) : (
          <Stat
            label={LABEL.gmvSevenDays}
            value={kEur(sevenDays)}
            hint="prochaines signatures probables"
          />
        )}
      </Card>

      {/*
        Trois blocs, dans l'ordre d'usage du matin : qui bouge, qui attend, quoi
        faire. Le travail de fond — relances manquées, First Calls, dossiers
        dormants — reste dans Monitoring et n'apparaît ici que s'il rencontre une
        valeur immédiate.
      */}
      <div className="mt-6 space-y-6">
        <HotClients events={plan.hot} />
        <WaitingClients events={plan.waiting} />
        <TodayPlan actions={plan.actions} doneToday={plan.doneToday} />
        <SilentButStrong items={plan.silentButStrong} />

        <details className="group rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
            Contexte du mois
            <span className="ml-1 group-open:hidden" aria-hidden>
              &#9656;
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              &#9662;
            </span>
            <span className="ml-2 text-xs font-normal text-ink-faint">
              affaires proches de signer, mouvements de la semaine, points de vigilance
              {lowStock > 0 ? ` \u00b7 ${lowStock} commercial(aux) sous le rep\u00e8re de pipe` : ""}
            </span>
          </summary>
          <div className="grid gap-6 border-t border-line p-4 [&>*]:min-w-0 md:p-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <TopDeals deals={topDeals} />
            </div>
            <WeekForecastBlock forecast={forecast} />
            <AlertsBlock alerts={alerts} />
          </div>
        </details>
      </div>
    </div>
  );
}

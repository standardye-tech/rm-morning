import { MorningBoard } from "@/components/morning-v2";
import { SinceLastSnapshotBlock } from "@/components/since-last-snapshot";
import { Card } from "@/components/ui";
import { parisDate } from "@/lib/business-time";
import { computeMetrics } from "@/lib/metrics";
import { latestImport, loadOpportunities } from "@/lib/repository";
import { syncMorningEvents } from "@/lib/morning-events";
import { buildMorningPlan } from "@/lib/morning-priority";
import { recordPlanLog } from "@/lib/morning-plan-log";
import { buildSinceLastSnapshot } from "@/lib/since-last-snapshot";

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

  // La date de référence est le JOUR MÉTIER (Paris), pas la date du snapshot
  // importé : c'est ce qui garantit que le mois de ces blocs est celui de tous
  // les autres écrans. Une donnée plus ancienne est signalée, pas suivie.
  const referenceDate = parisDate();
  const opportunities = loadOpportunities();
  const metrics = computeMetrics(opportunities, referenceDate);

  // Le triage des signaux mail est rejoué à chaque affichage : il est
  // idempotent et ne touche pas l'état de prise en compte déjà enregistré.
  syncMorningEvents();
  const plan = buildMorningPlan();
  // Bloc « Depuis [la dernière photo] » — audit V3.1. Composé, pas recalculé :
  // la baseline vient de `previousSnapshotDate`, déjà réutilisée par le
  // Forecast hebdo pour le même besoin (tolérer les trous de synchronisation).
  const sinceLastSnapshot = buildSinceLastSnapshot(referenceDate, opportunities);
  // Carnet d'observation : ce que le Plan recommande aujourd'hui. Jamais relu pour
  // le construire, et jamais bloquant pour l'affichage.
  try {
    recordPlanLog(plan.actions, new Date(), plan.doneToday);
  } catch {
    /* le journal est un plus : sa panne ne doit pas casser le Morning */
  }

  const isToday = lastImport.snapshotDate === referenceDate;

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
          </p>
        </div>
      </div>

      {/*
        Morning répond à deux questions, et à elles seules : qu'est-ce qui a
        changé, et que faut-il faire aujourd'hui ? Quatre blocs, dans l'ordre
        d'usage du matin — ce qui a bougé, qui est chaud, qui attend, quoi faire.

        Lot de simplification : le bandeau de fin de mois (répété par Forecast
        et Expected GMV), « Affaires prometteuses mais silencieuses » et
        « Contexte du mois » ont été retirés. Leurs moteurs restent en place et
        sont consommés ailleurs : une affaire de M à actionner entre dans le
        Plan du jour, un sujet de commercial dans Ma semaine, le déclaratif dans
        Forecast. Aucun de ces blocs n'apportait une information absente des
        écrans dont c'est le rôle.
      */}
      <div className="mt-6 space-y-6">
        <SinceLastSnapshotBlock delta={sinceLastSnapshot} />
        <MorningBoard
          hot={plan.hot}
          waiting={plan.waiting}
          actions={plan.actions}
          doneToday={plan.doneToday}
        />
      </div>
    </div>
  );
}

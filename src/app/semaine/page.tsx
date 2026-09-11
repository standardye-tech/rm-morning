import Link from "next/link";

import { DealOfWeek } from "@/components/deal-of-week";
import { RadarPipeline, RadarToProcess } from "@/components/radar";
import {
  BigDeals,
  TeamAttention,
  WeekActions,
  WeekEmpty,
  WeekNotes,
  WeekPlanning,
  WeekSummaryBand,
} from "@/components/week";
import { latestImport } from "@/lib/repository";
import { buildWeek } from "@/lib/week";

export const dynamic = "force-dynamic";

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const HEURE = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function freshness(iso: string): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? `aujourd'hui à ${HEURE.format(at)}` : DATE_TIME.format(at);
}

/**
 * « Ma semaine » — où investir le temps du directeur régional cette semaine.
 *
 * Ce n'est pas un agenda. Google Calendar garde les blocs ; cette page dit
 * lesquels méritent d'être remplis, avec qui, et ce qu'il faut en obtenir.
 * Tout est recalculé à chaque affichage, sur les données de la dernière
 * actualisation.
 */
export default async function SemainePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const vue = query.vue === "radar" ? "radar" : "semaine";

  if (!latestImport()) {
    return (
      <div className="py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Ma semaine</h1>
        <WeekEmpty />
      </div>
    );
  }

  const view = buildWeek(new Date());

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ma semaine</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {view.weekLabel} ·{" "}
            {view.dataAt ? `données mises à jour ${freshness(view.dataAt)}` : "aucune actualisation enregistrée"}
          </p>
          <p className="mt-1 max-w-3xl text-xs text-ink-faint">
            Où investir votre temps pour avoir le plus d&apos;impact. Recommandations, pas agenda : vos blocs
            fixes restent dans Google Calendar.
          </p>
        </div>
        <nav className="flex gap-1 text-sm" aria-label="Vue">
          {[
            { key: "semaine", label: "Semaine", href: "/semaine" },
            { key: "radar", label: "Radar", href: "/semaine?vue=radar" },
          ].map((v) => (
            <Link
              key={v.key}
              href={v.href}
              aria-current={vue === v.key ? "page" : undefined}
              className={`rounded-md px-2.5 py-1.5 transition-colors ${
                vue === v.key ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(16,20,24,0.04)]" : "text-ink-soft hover:bg-surface"
              }`}
            >
              {v.label}
            </Link>
          ))}
        </nav>
      </div>

      {vue === "radar" ? (
        <RadarPipeline contacts={view.radar.all} />
      ) : (
        <>
          <WeekSummaryBand view={view} />
          <WeekActions items={view.actions} />
          <TeamAttention verdicts={view.verdicts} />
          <BigDeals deals={view.bigDeals} />
          <DealOfWeek current={view.dealOfWeek} candidates={view.candidates} />
          <WeekPlanning planning={view.planning} />
          <RadarToProcess contacts={view.radar.toProcess} />
          <WeekNotes notes={view.notes} />
        </>
      )}
    </div>
  );
}

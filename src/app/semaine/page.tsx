import Link from "next/link";

import { RadarPipeline } from "@/components/radar";
import { Card, EmptyState } from "@/components/ui";
import { WeekAgendaBoard } from "@/components/week-agenda";
import { listRadarContacts } from "@/lib/radar-store";
import { latestImport } from "@/lib/repository";
import { buildWeekAgenda } from "@/lib/week-agenda-view";

export const dynamic = "force-dynamic";

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const HEURE = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function freshness(iso: string): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? `aujourd'hui à ${HEURE.format(at)}` : DATE_TIME.format(at);
}

/**
 * « Ma semaine » — mon planning recommandé de management des ET.
 *
 * Lot de simplification (B) : la page n'est plus une juxtaposition de blocs
 * (Performance, Attention, Gros dossiers, À traiter, puis planning). Ces moteurs
 * tournent toujours — attention managériale, gros dossiers, Momentum 7 jours,
 * Plan du jour, challengers Forecast — mais leur sortie est digérée en UNE
 * carte par ET dans un seul planning (`week-agenda.ts`).
 *
 * Le radar des candidatures reste consultable dans sa propre vue : c'est du
 * recrutement, pas du management des ET.
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
        <Card className="mt-6">
          <EmptyState>
            Aucune donnée importée. Lancez « Actualiser RM Morning » depuis l&apos;en-tête : la semaine se construit à
            partir de Salesforce, de la Perspective et du Monitoring.
          </EmptyState>
        </Card>
      </div>
    );
  }

  const view = vue === "semaine" ? buildWeekAgenda(new Date()) : null;

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ma semaine</h1>
          {view ? (
            <p className="mt-1 text-sm text-ink-soft">
              {view.weekLabel} ·{" "}
              {view.dataAt ? `données mises à jour ${freshness(view.dataAt)}` : "aucune actualisation enregistrée"}
            </p>
          ) : null}
        </div>
        <nav className="flex gap-1 text-sm" aria-label="Vue">
          {[
            { key: "semaine", label: "Planning", href: "/semaine" },
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

      {view ? <WeekAgendaBoard view={view} /> : <RadarPipeline contacts={listRadarContacts()} />}
    </div>
  );
}

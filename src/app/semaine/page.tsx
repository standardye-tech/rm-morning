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
 * Le radar des candidatures (recrutement, saisi à la main) n'est plus une
 * bascule de l'en-tête : la page est centrée sur le planning. Il reste
 * joignable par un lien discret en bas de page (`?vue=radar`).
 */
export default async function SemainePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

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

  if (query.vue === "radar") {
    return (
      <div className="py-8">
        <Link href="/semaine" className="text-sm text-ink-soft hover:text-ink hover:underline">
          ← Retour au planning
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Radar recrutement</h1>
        <RadarPipeline contacts={listRadarContacts()} />
      </div>
    );
  }

  const view = buildWeekAgenda(new Date());
  const subtitle = `${view.weekLabel} · ${
    view.dataAt ? `données mises à jour ${freshness(view.dataAt)}` : "aucune actualisation enregistrée"
  }`;

  return (
    <div className="py-8" data-page-wide>
      <WeekAgendaBoard view={view} subtitle={subtitle} />
      <p className="mt-8 text-right text-xs text-ink-faint">
        <Link href="/semaine?vue=radar" className="underline decoration-dotted underline-offset-2 hover:text-ink">
          Radar recrutement →
        </Link>
      </p>
    </div>
  );
}

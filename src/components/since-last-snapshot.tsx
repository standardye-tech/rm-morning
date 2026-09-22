import { Badge, Card, EmptyState, SectionTitle, Stat } from "@/components/ui";
import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { SINCE_LAST_SNAPSHOT } from "@/lib/config";
import { formatFrenchDate } from "@/lib/normalize";
import {
  formatSinceTitle,
  selectSignificantChanges,
  type BusinessDelta,
  type SelectedChange,
} from "@/lib/since-last-snapshot";
import { kEur, LABEL } from "@/lib/vocabulary";

/**
 * Bloc « Depuis [la dernière photo] », audit V3.1.
 *
 * Placé juste au-dessus du Plan du jour, visuellement secondaire : ce bloc
 * répond à « qu'est-ce qui vient de changer », le Plan répond à « où agir
 * maintenant ». Une même affaire peut apparaître dans les deux.
 *
 * Composant serveur, sans état : le repli « Voir les N autres » s'appuie sur
 * `<details>` natif plutôt que sur un `useState`, aucune logique métier n'est
 * ici — tout le calcul vient de `src/lib/since-last-snapshot.ts`.
 */
export function SinceLastSnapshotBlock({ delta }: { delta: BusinessDelta }) {
  const title = formatSinceTitle(delta.title);

  if (!delta.available) {
    return (
      <Card>
        <SectionTitle eyebrow="Depuis" title={title} />
        <EmptyState>Pas de photo antérieure disponible pour calculer un delta.</EmptyState>
      </Card>
    );
  }

  const selected = selectSignificantChanges(delta.changes);
  const visible = selected.slice(0, SINCE_LAST_SNAPSHOT.maxVisibleChanges);
  const rest = selected.slice(SINCE_LAST_SNAPSHOT.maxVisibleChanges);

  return (
    <Card>
      <SectionTitle eyebrow="Depuis" title={title} />

      <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
        <Stat
          label={LABEL.sinceSigned}
          value={delta.signed.available ? kEur(delta.signed.gmv) : "—"}
          hint={signedHint(delta.signed)}
        />
        <Stat
          label={LABEL.sinceEnteredM}
          value={delta.enteredM.available ? String(delta.enteredM.count) : "—"}
          hint={delta.enteredM.available ? `${kEur(delta.enteredM.gmv)} · Kanban connu` : "donnée insuffisante"}
        />
        <Stat
          label={LABEL.sinceExitedM}
          value={delta.exitedM.available ? String(delta.exitedM.count) : "—"}
          hint={delta.exitedM.available ? `${kEur(delta.exitedM.gmv)} · Kanban connu` : "donnée insuffisante"}
        />
        <Stat
          label={LABEL.sinceStagesChanged}
          value={delta.stageChanged.available ? String(delta.stageChanged.count) : "—"}
          hint="StageName brut, sans jugement"
        />
      </div>

      {selected.length === 0 ? (
        <EmptyState>Rien de significatif depuis la dernière photo.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line border-t border-line">
            {visible.map((item) => (
              <ChangeRow key={item.delta.opportunityId ?? item.delta.client} item={item} />
            ))}
          </ul>
          {rest.length > 0 ? (
            <details className="group border-t border-line">
              <summary className="cursor-pointer list-none px-4 py-2.5 text-sm text-ink-soft hover:text-ink md:px-6">
                <span className="underline decoration-dotted">
                  Voir les {rest.length} autres changements
                </span>
                <span className="ml-1" aria-hidden>
                  <span className="group-open:hidden">▾</span>
                  <span className="hidden group-open:inline">▴</span>
                </span>
              </summary>
              <ul className="divide-y divide-line border-t border-line">
                {rest.map((item) => (
                  <ChangeRow key={item.delta.opportunityId ?? item.delta.client} item={item} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </Card>
  );
}

function signedHint(signed: BusinessDelta["signed"]): string {
  if (!signed.available) return "donnée insuffisante";
  const base = `${signed.count} affaire(s)`;
  return signed.stale && signed.coveredThrough
    ? `${base} · mis à jour au ${formatFrenchDate(signed.coveredThrough)}`
    : base;
}

/** Sous-texte : chaque dimension retenue, dans l'ordre de priorité, séparée par « · ». */
function subtextOf(item: SelectedChange): string {
  const d = item.delta;
  const parts: string[] = [];
  if (d.signed) parts.push(`signé ${kEur(d.signed.gmv)} le ${formatFrenchDate(d.signed.signatureDate)}`);
  if (d.kanbanChange) parts.push(`prévu ${d.kanbanChange.fromLabel} → désormais ${d.kanbanChange.toLabel}`);
  if (d.gmvChange) parts.push(`GMV ${kEur(d.gmvChange.from)} → ${kEur(d.gmvChange.to)}`);
  if (d.standbyChange) parts.push(d.standbyChange.enteredStandby ? "passe en stand-by" : "redevient active");
  if (d.stageChange) parts.push(`${d.stageChange.from ?? "—"} → ${d.stageChange.to}`);
  return parts.join(" · ");
}

function ChangeRow({ item }: { item: SelectedChange }) {
  const d = item.delta;
  const displayGmv = d.gmv ?? d.signed?.gmv ?? null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm md:px-6">
      <span className="min-w-0 shrink-0 font-medium">
        <SalesforceOpportunityLink opportunityId={d.opportunityId}>{d.client}</SalesforceOpportunityLink>
      </span>
      {d.owner ? <span className="shrink-0 text-xs text-ink-soft">{d.owner}</span> : null}
      <span className="tabular shrink-0 text-xs text-ink-faint">{kEur(displayGmv)}</span>
      <span className="min-w-0 flex-1 basis-full text-xs text-ink-faint md:basis-auto">{subtextOf(item)}</span>
      {d.gmvChange?.suspicious ? <Badge tone="warning">À vérifier</Badge> : null}
    </li>
  );
}

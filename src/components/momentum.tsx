import Link from "next/link";

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import {
  formatMomentumWindow,
  type ChangeCategory,
  type MomentumReport,
  type OpportunityDelta,
  type OwnerMomentum,
  type SelectedChange,
} from "@/lib/since-last-snapshot";
import { kEur, LABEL } from "@/lib/vocabulary";

/**
 * Momentum 7 jours — audit V3.2.
 *
 * Bloc factuel, pas un second classement : ni score, ni podium, ni couleur
 * bon/mauvais. Les signes +/− sur les flux GMV suffisent à lire le sens d'un
 * mouvement ; rien ici n'ordonne les commerciaux entre eux (la liste est
 * alphabétique). Composant serveur, sans état.
 */
export function MomentumBlock({ momentum }: { momentum: MomentumReport }) {
  return (
    <Card className="mt-4">
      <SectionTitle
        eyebrow="Performance"
        title={LABEL.momentumTitle}
        aside={formatMomentumWindow(momentum.window)}
      />
      {!momentum.window.available ? (
        <EmptyState>Pas assez de recul pour mesurer un momentum sur cette période.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {momentum.owners.map((o) => (
              <OwnerRow key={o.owner} owner={o} />
            ))}
          </ul>
          <p className="px-4 py-2.5 text-xs text-ink-faint md:px-6">
            {momentum.totalOpportunitiesTouched} affaire(s) touchée(s) sur la période, tous
            commerciaux confondus. Mouvements observables uniquement — aucun score, aucun
            classement.
          </p>
        </>
      )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs">
      <span className="text-ink-faint">{label}</span>{" "}
      <span className="tabular font-medium text-ink">{value}</span>
    </span>
  );
}

function OwnerRow({ owner }: { owner: OwnerMomentum }) {
  return (
    <li className="px-4 py-2.5 md:px-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link
          href={`/performance?commercial=${encodeURIComponent(owner.owner)}`}
          className="w-40 shrink-0 text-sm font-medium underline decoration-dotted underline-offset-2"
        >
          {owner.owner}
        </Link>
        <Metric label={LABEL.momentumSigned} value={`${owner.signed.count} · ${kEur(owner.signed.gmv)}`} />
        <Metric label={LABEL.momentumEnteredM} value={`${owner.enteredM.count} · ${kEur(owner.enteredM.gmv)}`} />
        <Metric label={LABEL.momentumExitedM} value={`${owner.exitedM.count} · ${kEur(owner.exitedM.gmv)}`} />
        <Metric label={LABEL.momentumGmvUp} value={`${owner.gmvUp.count} · +${kEur(owner.gmvUp.gmv)}`} />
        <Metric label={LABEL.momentumGmvDown} value={`${owner.gmvDown.count} · ${kEur(owner.gmvDown.gmv)}`} />
        <Metric label={LABEL.momentumStages} value={String(owner.stageChangedCount)} />
        <Metric label={LABEL.momentumStandby} value={`${owner.standbyEntered} / ${owner.standbyReturned}`} />
      </div>
      {owner.topMoves.length > 0 ? (
        <details className="group mt-1.5">
          <summary className="cursor-pointer list-none text-xs text-ink-soft hover:text-ink">
            <span className="underline decoration-dotted">
              {owner.topMoves.length} affaire(s) marquante(s)
            </span>
            <span className="ml-1" aria-hidden>
              <span className="group-open:hidden">▾</span>
              <span className="hidden group-open:inline">▴</span>
            </span>
          </summary>
          <ul className="mt-1 space-y-0.5 border-l border-line pl-3">
            {owner.topMoves.map((m) => (
              <TopMoveLine key={m.delta.opportunityId ?? m.delta.client} item={m} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function moveAmount(d: OpportunityDelta, category: ChangeCategory): { amount: number; sign: "+" | "−" | "" } {
  if (category === "signed" && d.signed) return { amount: d.signed.gmv, sign: "" };
  if (category === "gmv" && d.gmvChange) {
    return { amount: Math.abs(d.gmvChange.delta), sign: d.gmvChange.delta >= 0 ? "+" : "−" };
  }
  if (category === "kanban" && d.kanbanChange) {
    return { amount: d.gmv ?? 0, sign: d.kanbanChange.enteredM ? "+" : "−" };
  }
  return { amount: d.gmv ?? 0, sign: "" };
}

/** Une seule raison — le primaire retenu par `selectSignificantChanges` — pas toutes les dimensions. */
function moveReason(item: SelectedChange): string | null {
  const d = item.delta;
  switch (item.primaryCategory) {
    case "signed":
      return "signé";
    case "kanban":
      return d.kanbanChange?.enteredM
        ? `entré dans ${d.kanbanChange.toLabel}`
        : `sorti de ${d.kanbanChange?.fromLabel ?? ""}`;
    case "standby":
      return d.standbyChange?.enteredStandby ? "stand-by" : "retour actif";
    case "stage":
      return "changement de stade";
    case "gmv":
    default:
      return null;
  }
}

function TopMoveLine({ item }: { item: SelectedChange }) {
  const { amount, sign } = moveAmount(item.delta, item.primaryCategory);
  const reason = moveReason(item);
  return (
    <li className="text-xs">
      <SalesforceOpportunityLink opportunityId={item.delta.opportunityId}>
        {item.delta.client}
      </SalesforceOpportunityLink>
      {reason ? <span className="text-ink-faint"> · {reason}</span> : null}
      <span className="tabular ml-1 font-medium">
        {sign}
        {kEur(amount)}
      </span>
    </li>
  );
}

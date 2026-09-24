import Link from "next/link";

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import {
  formatMomentumWindow,
  momentumScore,
  type MomentumScore,
  type ChangeCategory,
  type MomentumReport,
  type OpportunityDelta,
  type OwnerMomentum,
  type SelectedChange,
} from "@/lib/since-last-snapshot";
import { kEur, LABEL } from "@/lib/vocabulary";

/**
 * Momentum 7 jours — audit V3.2, note /20 ajoutée au lot de simplification (C).
 *
 * La note est une SYNTHÈSE de la dynamique business observable des 7 derniers
 * jours (`momentumScore`) : ni note de compétence, ni note RH, ni podium. Pas
 * de « meilleur commercial » : l'ordre par défaut reste alphabétique, le tri
 * par note est un choix explicite de l'utilisateur. Composant serveur.
 */
export type MomentumSort = "alpha" | "note-desc" | "note-asc";

export function MomentumBlock({
  momentum,
  sort = "alpha",
  sortHref,
}: {
  momentum: MomentumReport;
  sort?: MomentumSort;
  /** Construit le lien d'un tri, en conservant les autres paramètres de la page. */
  sortHref: (sort: MomentumSort) => string;
}) {
  const scored = momentum.owners.map((o) => ({ o, s: momentumScore(o) }));
  if (sort === "note-desc") scored.sort((a, b) => b.s.score - a.s.score || a.o.owner.localeCompare(b.o.owner, "fr"));
  else if (sort === "note-asc") scored.sort((a, b) => a.s.score - b.s.score || a.o.owner.localeCompare(b.o.owner, "fr"));
  const chip = (active: boolean) =>
    `rounded-md px-2 py-1 text-xs transition-colors ${active ? "bg-canvas font-medium text-ink ring-1 ring-line" : "text-ink-soft hover:bg-canvas"}`;
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
          <div className="flex flex-wrap items-center gap-1 border-b border-line px-4 pb-2.5 md:px-6">
            <span className="mr-1 text-xs text-ink-faint">Trier</span>
            <Link href={sortHref("alpha")} className={chip(sort === "alpha")} aria-current={sort === "alpha" ? "true" : undefined}>
              A → Z
            </Link>
            <Link href={sortHref("note-desc")} className={chip(sort === "note-desc")} aria-current={sort === "note-desc" ? "true" : undefined}>
              Note ↓
            </Link>
            <Link href={sortHref("note-asc")} className={chip(sort === "note-asc")} aria-current={sort === "note-asc" ? "true" : undefined}>
              Note ↑
            </Link>
          </div>
          <ul className="divide-y divide-line">
            {scored.map(({ o, s }) => (
              <OwnerRow key={o.owner} owner={o} score={s} />
            ))}
          </ul>
          <details className="border-t border-line px-4 py-2.5 text-xs text-ink-faint md:px-6">
            <summary className="cursor-pointer list-none underline decoration-dotted">Comment se calcule la note de momentum /20 ?</summary>
            <p className="mt-1.5 leading-relaxed">
              Une synthèse de la dynamique business observable des 7 derniers jours — pas une note de compétence, ni
              une note RH, ni une performance annuelle. Impact = signé + ½ × (entrées dans M − sorties de M) + ½ ×
              (hausses GMV − baisses GMV) + ¼ × (retours actifs − passages en stand-by), en GMV. Note = 10 + 10 ×
              impact ÷ 100 k€, bornée entre 0 et 20, au demi-point : 10/20 est une semaine neutre. Les changements de
              stade, les e-mails et les tâches ne comptent pas.
            </p>
          </details>
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink-faint md:px-6">
            {momentum.totalOpportunitiesTouched} affaire(s) touchée(s) sur la période, tous commerciaux confondus.
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

function OwnerRow({ owner, score }: { owner: OwnerMomentum; score: MomentumScore }) {
  const detail = score.parts
    .filter((p) => p.value !== 0)
    .map((p) => `${p.label} ${p.value > 0 ? "+" : "−"}${kEur(Math.abs(p.value))}`)
    .join(" · ");
  return (
    <li className="px-4 py-2.5 md:px-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link
          href={`/performance?commercial=${encodeURIComponent(owner.owner)}`}
          className="w-40 shrink-0 text-sm font-medium underline decoration-dotted underline-offset-2"
        >
          {owner.owner}
        </Link>
        <span
          className="tabular w-32 shrink-0 text-sm"
          title={`Impact pondéré ${score.impact >= 0 ? "+" : "−"}${kEur(Math.abs(score.impact))}${detail ? ` (${detail})` : " (aucun mouvement)"}`}
        >
          <span className="text-ink-faint">Momentum : </span>
          <span className="font-semibold">{String(score.score).replace(".", ",")}/20</span>
        </span>
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

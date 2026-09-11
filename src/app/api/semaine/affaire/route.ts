import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import {
  closeDealOfWeek,
  commentDealOfWeek,
  currentDealOfWeek,
  dealOfWeekHistory,
  selectDealOfWeek,
} from "@/lib/deal-of-week-store";
import { loadOpportunities } from "@/lib/repository";
import { weekBounds } from "@/lib/week";

export const dynamic = "force-dynamic";

/**
 * Affaire de la semaine.
 *
 *   GET  /api/semaine/affaire   affaire en cours + historique
 *   POST /api/semaine/affaire   { action: "selectionner", opportunityId, comment? }
 *                               { action: "cloturer", id }
 *                               { action: "commenter", id, comment }
 *
 * Le commercial est relu depuis l'opportunité en base, jamais accepté du
 * navigateur. Aucune écriture vers Salesforce.
 */
export async function GET() {
  return NextResponse.json({ current: currentDealOfWeek(), history: dealOfWeekHistory() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      opportunityId?: unknown;
      id?: unknown;
      comment?: unknown;
    };
    const comment = typeof body.comment === "string" ? body.comment : null;

    switch (body.action) {
      case "selectionner": {
        if (typeof body.opportunityId !== "string" || !body.opportunityId) {
          return NextResponse.json({ error: "Opportunité manquante." }, { status: 400 });
        }
        const opportunity = loadOpportunities().find((o) => o.opportunityId === body.opportunityId);
        if (!opportunity) return NextResponse.json({ error: "Opportunité inconnue." }, { status: 400 });
        if (!opportunity.isActive) {
          return NextResponse.json({ error: "Cette affaire n'est plus active dans Salesforce." }, { status: 400 });
        }
        const { weekStart } = weekBounds(new Date());
        const record = selectDealOfWeek({
          opportunityId: opportunity.opportunityId,
          salesperson: opportunity.owner,
          weekStart,
          comment,
        });
        revalidatePath("/semaine");
        return NextResponse.json({ ok: true, current: record });
      }
      case "cloturer": {
        const id = Number(body.id);
        if (!Number.isInteger(id)) return NextResponse.json({ error: "Identifiant manquant." }, { status: 400 });
        const changed = closeDealOfWeek(id);
        revalidatePath("/semaine");
        return NextResponse.json({ ok: true, changed, current: currentDealOfWeek() });
      }
      case "commenter": {
        const id = Number(body.id);
        if (!Number.isInteger(id)) return NextResponse.json({ error: "Identifiant manquant." }, { status: 400 });
        const changed = commentDealOfWeek(id, comment);
        revalidatePath("/semaine");
        return NextResponse.json({ ok: true, changed, current: currentDealOfWeek() });
      }
      default:
        return NextResponse.json({ error: "action inconnue" }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

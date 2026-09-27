import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { buildWeekAgenda } from "@/lib/week-agenda-view";
import {
  checkAgendaTask,
  parseSlotValue,
  placeAgendaOwner,
  restoreAgendaTask,
  unplaceAgendaOwner,
} from "@/lib/week-agenda-store";

export const dynamic = "force-dynamic";

/**
 * « Ma semaine » — les deux gestes du planning recommandé.
 *
 *   POST /api/semaine/agenda
 *     { action: "traiter",  key }            coche un sujet de la semaine
 *     { action: "retablir", key }            le remet dans la liste active
 *     { action: "placer",   owner, value }   place un ET dans un créneau réel (« 4-12:00 »)
 *     { action: "retirer",  owner }          annule un placement
 *
 * La semaine, le libellé du sujet et les créneaux proposables sont RECALCULÉS
 * ici, jamais reçus du navigateur : on ne coche que ce qui est réellement
 * proposé cette semaine, on ne place que dans un créneau réellement proposé.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    key?: unknown;
    owner?: unknown;
    value?: unknown;
  };
  const view = buildWeekAgenda(new Date());
  const cards = [...view.timeline, ...view.toPlace];

  switch (body.action) {
    case "traiter": {
      const task = cards.flatMap((c) => c.tasks).find((t) => t.key === body.key);
      if (!task) return NextResponse.json({ error: "Sujet inconnu cette semaine." }, { status: 400 });
      // Sujet repris d'une action existante (Plan du jour) : état PARTAGÉ.
      checkAgendaTask(view.weekStart, task);
      break;
    }
    case "retablir": {
      const entry = view.done.find((d) => d.key === body.key);
      if (!entry) return NextResponse.json({ error: "Sujet non traité cette semaine." }, { status: 400 });
      // Rouvre l'action partout (Plan compris) ; elle ne réapparaît que là où
      // son signal existe encore.
      restoreAgendaTask(view.weekStart, entry);
      break;
    }
    case "placer": {
      const card = cards.find((c) => c.owner === body.owner);
      const option = view.placeOptions.find((o) => o.value === body.value);
      if (!card || !option || !parseSlotValue(option.value)?.time) {
        return NextResponse.json({ error: "ET ou créneau non proposé." }, { status: 400 });
      }
      placeAgendaOwner(view.weekStart, card.owner, option.value);
      break;
    }
    case "retirer": {
      if (typeof body.owner !== "string") return NextResponse.json({ error: "ET manquant." }, { status: 400 });
      unplaceAgendaOwner(view.weekStart, body.owner);
      break;
    }
    default:
      return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
  }
  revalidatePath("/semaine");
  return NextResponse.json({ ok: true });
}

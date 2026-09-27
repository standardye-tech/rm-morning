import { NextResponse } from "next/server";

import {
  acknowledgeAllEvents,
  acknowledgeEvent,
  completeShownActions,
  markActionDone,
  syncMorningEvents,
} from "@/lib/morning-events";
import { buildMorningPlan } from "@/lib/morning-priority";

/**
 * Actions du Morning.
 *
 * Toutes locales : trier les signaux mail déjà synchronisés, marquer un
 * message comme pris en compte (seul ou en bloc), cocher une action du plan
 * du jour (seule ou en bloc). Aucune écriture Gmail, aucune écriture
 * Salesforce — l'état de prise en compte appartient à RM Morning.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    messageId?: string;
    actionKey?: string;
    category?: string;
    /** Clés des situations que le navigateur affiche : « Tout traiter » ne va pas au-delà. */
    keys?: string[];
    /** Messages que le navigateur affiche dans le bloc : même règle pour « Tout traiter ». */
    messageIds?: string[];
  };

  switch (body.action) {
    case "pris_en_compte": {
      if (!body.messageId) {
        return NextResponse.json({ error: "messageId manquant" }, { status: 400 });
      }
      // Porte sur ce message seul : si le client réécrit, le nouveau message
      // reviendra au Morning suivant.
      const done = acknowledgeEvent(body.messageId);
      return NextResponse.json({ ok: true, changed: done });
    }
    case "tout_pris_en_compte": {
      // Un bloc (« chaud » ou « attente ») ou les deux. La liste des messages
      // est recalculée côté serveur : ce qui est acquitté est ce que RM Morning
      // considère ouvert à cet instant, pas ce qu'un onglet affichait.
      const category =
        body.category === "chaud" || body.category === "attente" ? body.category : null;
      const shown = Array.isArray(body.messageIds)
        ? new Set(body.messageIds.filter((k): k is string => typeof k === "string"))
        : null;
      const result = acknowledgeAllEvents(category, new Date(), shown);
      return NextResponse.json({ ok: true, ...result });
    }
    case "action_faite": {
      if (!body.actionKey) {
        return NextResponse.json({ error: "actionKey manquant" }, { status: 400 });
      }
      // Deux effets distincts, volontairement enchaînés ici et pas fondus en un
      // seul : l'action du plan est faite POUR AUJOURD'HUI, et le message qui
      // l'a déclenchée — quand il y en a un — est acquitté DÉFINITIVEMENT.
      // C'est exactement le comportement des blocs 1 et 2 sur ce message.
      // L'action est l'ActionKey PARTAGÉE du Plan : la tâche correspondante de
      // « Ma semaine » est traitée du même geste, sans écriture de plus.
      const done = markActionDone(body.actionKey);
      if (body.messageId) acknowledgeEvent(body.messageId);
      return NextResponse.json({ ok: true, changed: done });
    }
    case "tout_faire": {
      // Le plan affiché est RECALCULÉ ici, jamais reçu du navigateur — même
      // principe que « tout_pris_en_compte » et « tout lire » du Monitoring.
      // Chaque action suit exactement le même double effet que
      // « action_faite » : faite pour aujourd'hui, message acquitté quand il
      // y en a un.
      //
      // Le plan recalculé est ensuite RESTREINT aux clés que l'écran affiche :
      // « Tout traiter » ne marque jamais une situation que Sami n'a pas vue —
      // ni une huitième qui aurait remplacé une acquittée entre-temps, ni une
      // situation filtrée hors du Plan.
      const plan = buildMorningPlan();
      const shown = Array.isArray(body.keys)
        ? new Set(body.keys.filter((k): k is string => typeof k === "string"))
        : null;
      const changed = completeShownActions(plan.actions, shown);
      return NextResponse.json({ ok: true, changed });
    }
    case "trier": {
      const r = syncMorningEvents();
      return NextResponse.json({ ok: true, ...r });
    }
    default:
      return NextResponse.json({ error: "action inconnue" }, { status: 400 });
  }
}

import { NextResponse } from "next/server";

import {
  acknowledgeEvent,
  markActionDone,
  markMorningRead,
  syncMorningEvents,
} from "@/lib/morning-events";

/**
 * Actions du Morning.
 *
 * Quatre seulement, toutes locales : trier les signaux mail déjà synchronisés,
 * marquer un message comme pris en compte, cocher une action du plan du jour, et
 * enregistrer que le Morning a été lu. Aucune écriture Gmail, aucune écriture
 * Salesforce — l'état de prise en compte appartient à RM Morning.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    messageId?: string;
    actionKey?: string;
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
    case "action_faite": {
      if (!body.actionKey) {
        return NextResponse.json({ error: "actionKey manquant" }, { status: 400 });
      }
      // Deux effets distincts, volontairement enchaînés ici et pas fondus en un
      // seul : l'action du plan est faite POUR AUJOURD'HUI, et le message qui
      // l'a déclenchée — quand il y en a un — est acquitté DÉFINITIVEMENT.
      // C'est exactement le comportement des blocs 1 et 2 sur ce message.
      const done = markActionDone(body.actionKey);
      if (body.messageId) acknowledgeEvent(body.messageId);
      return NextResponse.json({ ok: true, changed: done });
    }
    case "lu": {
      markMorningRead();
      return NextResponse.json({ ok: true });
    }
    case "trier": {
      const r = syncMorningEvents();
      return NextResponse.json({ ok: true, ...r });
    }
    default:
      return NextResponse.json({ error: "action inconnue" }, { status: 400 });
  }
}

import { NextResponse } from "next/server";

import { markItemRead, markScopeRead, treatItem } from "@/lib/monitoring-view";

/**
 * Gestes du Monitoring : lire, et traiter.
 *
 * Toutes entièrement locales : rien n'est écrit dans
 * Salesforce — l'état de lecture appartient à RM Morning, comme la prise en
 * compte des messages du Morning.
 *
 * — « tout_lire » acquitte le stock actif d'un périmètre. La liste acquittée
 *   est RECALCULÉE ici, elle n'est pas reçue du navigateur : un onglet resté
 *   ouvert une heure enverrait sinon un périmètre périmé et marquerait comme
 *   lues des anomalies apparues depuis.
 * — « lire » acquitte UNE SEULE ligne, désignée par son identifiant. Ses
 *   champs de décision sont eux aussi relus en base au moment du geste, jamais
 *   reçus du navigateur.
 * — « traiter » ferme l'ACTION courante d'une ligne dans l'état partagé
 *   (`action-state`) : elle disparaît aussi du Morning et de Ma semaine quand
 *   ils montrent la même action. Lire n'est jamais traiter.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    scope?: string;
    owner?: string | null;
    itemId?: string;
  };

  if (body.scope !== "piste" && body.scope !== "opportunite") {
    return NextResponse.json({ error: "périmètre inconnu" }, { status: 400 });
  }

  switch (body.action) {
    case "tout_lire": {
      // Le filtre par commercial est repris tel quel : « Tout lire » ne doit
      // acquitter que ce que l'écran montrait, filtre compris.
      const owner = typeof body.owner === "string" && body.owner.length > 0 ? body.owner : null;
      const read = markScopeRead(body.scope, owner);
      return NextResponse.json({ ok: true, read });
    }
    case "traiter": {
      // « Traité » ≠ « Lu » : l'action courante de la ligne est gérée, partout
      // où elle apparaît (Morning, Ma semaine). Aucune lecture n'est écrite.
      if (!body.itemId) {
        return NextResponse.json({ error: "itemId manquant" }, { status: 400 });
      }
      const changed = treatItem(body.scope, body.itemId);
      return NextResponse.json({ ok: true, changed });
    }
    case "lire": {
      if (!body.itemId) {
        return NextResponse.json({ error: "itemId manquant" }, { status: 400 });
      }
      const changed = markItemRead(body.scope, body.itemId);
      return NextResponse.json({ ok: true, changed });
    }
    default:
      return NextResponse.json({ error: "action inconnue" }, { status: 400 });
  }
}

import { NextResponse } from "next/server";

import { markScopeRead } from "@/lib/monitoring-view";

/**
 * Geste « Tout lire » du Monitoring.
 *
 * Une seule action, entièrement locale : enregistrer que le stock actif d'un
 * périmètre vient d'être lu, avec la valeur des champs de décision au moment du
 * clic. Rien n'est écrit dans Salesforce — l'état de lecture appartient à
 * RM Morning, comme la prise en compte des messages du Morning.
 *
 * La liste acquittée est RECALCULÉE ici, elle n'est pas reçue du navigateur :
 * un onglet resté ouvert une heure enverrait sinon un périmètre périmé et
 * marquerait comme lues des anomalies apparues depuis.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    scope?: string;
    owner?: string | null;
  };

  if (body.action !== "tout_lire") {
    return NextResponse.json({ error: "action inconnue" }, { status: 400 });
  }
  if (body.scope !== "piste" && body.scope !== "opportunite") {
    return NextResponse.json({ error: "périmètre inconnu" }, { status: 400 });
  }

  // Le filtre par commercial est repris tel quel : « Tout lire » ne doit
  // acquitter que ce que l'écran montrait, filtre compris.
  const owner = typeof body.owner === "string" && body.owner.length > 0 ? body.owner : null;
  const read = markScopeRead(body.scope, owner);
  return NextResponse.json({ ok: true, read });
}

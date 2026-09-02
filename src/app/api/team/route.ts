import { NextResponse } from "next/server";

import {
  addTeamMember,
  allTeamMembers,
  removeTeamMember,
  teamCandidates,
} from "@/lib/team-store";

export const dynamic = "force-dynamic";

/**
 * Périmètre commercial RM Morning.
 *
 *   GET    /api/team   membres (actifs et retirés) + commerciaux proposables
 *   POST   /api/team   ajoute, ou réactive, un commercial   { name }
 *   DELETE /api/team   retire un commercial du périmètre    { key }
 *
 * Le retrait n'efface RIEN : il bascule le membre en inactif. Ses opportunités,
 * ses snapshots et son historique restent en base, et le réajouter les fait
 * réapparaître. Aucune écriture n'est faite vers Salesforce, qui reste en
 * lecture seule.
 *
 * Le nouveau périmètre s'applique à l'actualisation suivante : les imports
 * relisent la table à chaque passage.
 */
export async function GET() {
  return NextResponse.json({ members: allTeamMembers(), candidates: teamCandidates() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: unknown };
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "Nom de commercial manquant." }, { status: 400 });
    }
    const member = addTeamMember({ name: body.name });
    return NextResponse.json({ member, members: allTeamMembers() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key) {
      return NextResponse.json({ error: "Commercial non identifié." }, { status: 400 });
    }
    removeTeamMember(body.key);
    return NextResponse.json({ members: allTeamMembers() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

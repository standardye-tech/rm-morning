import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { GmailAuthError } from "@/lib/google-oauth";
import { GmailSource } from "@/lib/sources/gmail";

/**
 * Synchronisation Gmail incrémentale.
 *
 *   POST /api/gmail/sync
 *
 * Lecture seule. N'interroge qu'une fenêtre temporelle — jamais toute la
 * boîte. La page Morning n'est pas revalidée : le Passage A ne touche pas au
 * Morning Brief.
 */
export async function POST() {
  try {
    const report = await new GmailSource().sync();
    revalidatePath("/donnees");
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof GmailAuthError) {
      return NextResponse.json(
        { error: "Gmail non connecté", detail: error.message, needsAuth: true },
        { status: 401 },
      );
    }
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

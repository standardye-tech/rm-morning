import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { SALESFORCE_LOGIN_COMMAND } from "@/lib/config";
import { importOpportunityMilestones } from "@/lib/opportunity-import";
import { SalesforceAuthError } from "@/lib/sources/api-salesforce";

/**
 * Import des jalons d'opportunités.
 *
 *   POST /api/opportunities
 *
 * Lecture seule. Ne recrée aucune opportunité : complète celles déjà importées.
 */
export async function POST() {
  try {
    const summary = await importOpportunityMilestones();
    revalidatePath("/monitoring");
    revalidatePath("/donnees");
    revalidatePath("/");
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof SalesforceAuthError) {
      return NextResponse.json(
        { error: error.message, needsLogin: true, loginCommand: SALESFORCE_LOGIN_COMMAND },
        { status: 401 },
      );
    }
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

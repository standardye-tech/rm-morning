import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { importLeads } from "@/lib/lead-import";
import { SALESFORCE_LOGIN_COMMAND } from "@/lib/config";
import { SalesforceAuthError } from "@/lib/sources/api-salesforce";

/**
 * Import des pistes Salesforce.
 *
 *   POST /api/leads
 *
 * Lecture seule Salesforce. Ne revalide que Monitoring : le Morning n'est
 * touché qu'au prochain rendu, et seulement à la marge.
 */
export async function POST() {
  try {
    const summary = await importLeads();
    revalidatePath("/monitoring");
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

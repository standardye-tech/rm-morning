import { NextResponse } from "next/server";

import { buildAuthorizationUrl, GmailAuthError } from "@/lib/google-oauth";

/**
 * Démarre le flux OAuth : redirige vers l'écran de consentement Google.
 * Aucun identifiant ne transite par le navigateur — seule l'URL Google est
 * construite côté serveur.
 */
export async function GET() {
  try {
    return NextResponse.redirect(buildAuthorizationUrl());
  } catch (error) {
    const message =
      error instanceof GmailAuthError ? error.message : "Impossible de démarrer la connexion Gmail.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

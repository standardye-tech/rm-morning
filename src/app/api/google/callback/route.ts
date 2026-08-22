import { NextResponse } from "next/server";

import { exchangeCodeForTokens, GmailAuthError } from "@/lib/google-oauth";

/**
 * Retour de Google après consentement. Échange le code contre les jetons,
 * stocke le jeton de rafraîchissement en local, puis renvoie l'utilisateur
 * vers la page Données. Aucun jeton n'apparaît dans l'URL de retour.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const error = url.searchParams.get("error");
  if (error) {
    // Refus de l'utilisateur, ou blocage par la politique de l'organisation.
    const detail = url.searchParams.get("error_subtype") ?? "";
    return NextResponse.redirect(
      `${origin}/donnees?gmail=refus&detail=${encodeURIComponent(`${error} ${detail}`.trim())}`,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(`${origin}/donnees?gmail=incomplet`);
  }

  try {
    // Le compte autorisé n'est pas repassé en paramètre : la page le relit
    // directement du profil Gmail. L'URL de retour reste ainsi propre, et
    // l'adresse ne traîne pas dans l'historique du navigateur.
    await exchangeCodeForTokens(code, state);
    return NextResponse.redirect(`${origin}/donnees`);
  } catch (cause) {
    const message =
      cause instanceof GmailAuthError ? cause.message : "Échec de la connexion Gmail.";
    return NextResponse.redirect(`${origin}/donnees?gmail=erreur&detail=${encodeURIComponent(message)}`);
  }
}

/**
 * OAuth Google pour Gmail — LECTURE SEULE.
 *
 * Un seul scope est demandé : `gmail.readonly`. Aucune fonction d'envoi, de
 * modification, de suppression, d'archivage ou d'étiquetage n'existe dans ce
 * fichier ni ailleurs dans l'application — c'est volontaire.
 *
 * Sécurité :
 *   — `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` vivent dans `.env.local`,
 *     ignoré par Git ; ils ne sont jamais renvoyés au navigateur ;
 *   — le jeton de rafraîchissement est écrit dans `data/`, ignoré par Git,
 *     jamais en base, jamais journalisé, jamais affiché ;
 *   — le jeton d'accès reste en mémoire du processus.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as fsSync from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { GOOGLE_OAUTH } from "./config";

/** Connexion Gmail absente ou révoquée : l'interface propose de se reconnecter. */
export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

type StoredToken = {
  refreshToken: string;
  /** Compte réellement autorisé, pour vérifier que c'est bien le bon. */
  account: string | null;
  scope: string;
  obtainedAt: string;
};

const tokenPath = () => path.resolve(process.cwd(), GOOGLE_OAUTH.tokenFile);

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GmailAuthError(
      "GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET absent de .env.local. " +
        "Redémarrez le serveur après avoir créé le fichier.",
    );
  }
  return { clientId, clientSecret };
}

// --- Étape 1 : construire l'URL d'autorisation -----------------------------

/**
 * PKCE : le vérificateur ne doit pas quitter le serveur, mais il doit survivre
 * au rechargement à chaud des modules pendant la redirection vers Google.
 * Il est donc déposé dans un fichier éphémère de `data/`, supprimé dès
 * l'échange effectué. Un seul flux à la fois : l'application n'a qu'un
 * utilisateur.
 */
const pendingPath = () => path.resolve(process.cwd(), GOOGLE_OAUTH.pendingFile);

function writePending(pending: { verifier: string; state: string }): void {
  const file = pendingPath();
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.writeFileSync(file, JSON.stringify(pending), { encoding: "utf8", mode: 0o600 });
}

function takePending(): { verifier: string; state: string } | null {
  const file = pendingPath();
  if (!fsSync.existsSync(file)) return null;
  try {
    const pending = JSON.parse(fsSync.readFileSync(file, "utf8")) as {
      verifier: string;
      state: string;
    };
    fsSync.rmSync(file);
    return pending;
  } catch {
    return null;
  }
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

export function buildAuthorizationUrl(): string {
  const { clientId } = credentials();

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  writePending({ verifier, state });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_OAUTH.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH.scope,
    // Indispensable pour obtenir un jeton de rafraîchissement.
    access_type: "offline",
    // Force l'écran de consentement : sans cela Google ne renvoie le jeton de
    // rafraîchissement qu'à la toute première autorisation, et une seconde
    // tentative repartirait sans.
    prompt: "consent",
    // Restreint le sélecteur au compte attendu.
    login_hint: GOOGLE_OAUTH.account,
    state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });

  return `${GOOGLE_OAUTH.authUri}?${params.toString()}`;
}

// --- Étape 2 : échanger le code contre des jetons --------------------------

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_OAUTH.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.error) {
    // Seul le message d'erreur de Google remonte : jamais le corps envoyé,
    // qui contient le secret client.
    throw new GmailAuthError(
      `Google a refusé l'échange de jetons : ${payload.error_description ?? payload.error ?? response.status}`,
    );
  }
  return payload;
}

export async function exchangeCodeForTokens(
  code: string,
  state: string,
): Promise<{ account: string | null; hasRefreshToken: boolean; scope: string }> {
  const pending = takePending();

  if (!pending || pending.state !== state) {
    throw new GmailAuthError(
      "État OAuth invalide ou expiré. Relancez « Connecter Gmail » depuis la page Données.",
    );
  }

  const { clientId, clientSecret } = credentials();
  const payload = await postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: GOOGLE_OAUTH.redirectUri,
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  );

  if (!payload.refresh_token) {
    throw new GmailAuthError(
      "Google n'a pas délivré de jeton de rafraîchissement. Révoquez l'accès de RM Morning " +
        "sur https://myaccount.google.com/permissions puis recommencez.",
    );
  }

  const account = await fetchAccountEmail(payload.access_token ?? "");
  await storeToken({
    refreshToken: payload.refresh_token,
    account,
    scope: payload.scope ?? GOOGLE_OAUTH.scope,
    obtainedAt: new Date().toISOString(),
  });

  cachedAccess = payload.access_token
    ? { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 }
    : null;

  return { account, hasRefreshToken: true, scope: payload.scope ?? GOOGLE_OAUTH.scope };
}

// --- Stockage local --------------------------------------------------------

async function storeToken(token: StoredToken): Promise<void> {
  const file = tokenPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function loadToken(): Promise<StoredToken | null> {
  const file = tokenPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredToken;
  } catch {
    return null;
  }
}

/** Supprime la connexion locale. Ne révoque rien côté Google. */
export async function forgetToken(): Promise<void> {
  const file = tokenPath();
  if (existsSync(file)) await rm(file);
  cachedAccess = null;
}

// --- Jeton d'accès ---------------------------------------------------------

let cachedAccess: { value: string; expiresAt: number } | null = null;

/**
 * Jeton d'accès valide, renouvelé si besoin. Reste en mémoire du processus :
 * il n'est jamais écrit sur disque.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 60_000) return cachedAccess.value;

  const stored = await loadToken();
  if (!stored) {
    throw new GmailAuthError("Gmail n'est pas connecté. Utilisez « Connecter Gmail ».");
  }

  const { clientId, clientSecret } = credentials();
  const payload = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    }),
  );

  if (!payload.access_token) {
    throw new GmailAuthError("Google n'a pas renvoyé de jeton d'accès.");
  }
  cachedAccess = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cachedAccess.value;
}

// --- Lecture Gmail : profil uniquement à ce stade --------------------------

/** Adresse du compte autorisé, via le profil Gmail. */
async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const response = await fetch(`${GOOGLE_OAUTH.gmailApi}/users/me/profile`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const profile = (await response.json()) as { emailAddress?: string };
    return profile.emailAddress ?? null;
  } catch {
    return null;
  }
}

export type GmailConnection = {
  connected: boolean;
  account?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  scope?: string;
  connectedSince?: string;
  error?: string;
};

/**
 * Vérifie la connexion en lisant le profil Gmail. Aucune donnée de message
 * n'est touchée ici — uniquement les compteurs du compte.
 */
export async function checkGmailConnection(): Promise<GmailConnection> {
  const stored = await loadToken();
  if (!stored) return { connected: false };

  try {
    const accessToken = await getAccessToken();
    const response = await fetch(`${GOOGLE_OAUTH.gmailApi}/users/me/profile`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: { message?: string; status?: string };
      } | null;
      return {
        connected: false,
        account: stored.account ?? undefined,
        error: `Gmail a répondu ${response.status} — ${detail?.error?.message ?? "accès refusé"}`,
      };
    }
    const profile = (await response.json()) as {
      emailAddress?: string;
      messagesTotal?: number;
      threadsTotal?: number;
    };
    return {
      connected: true,
      account: profile.emailAddress ?? stored.account ?? undefined,
      messagesTotal: profile.messagesTotal,
      threadsTotal: profile.threadsTotal,
      scope: stored.scope,
      connectedSince: stored.obtainedAt,
    };
  } catch (error) {
    return {
      connected: false,
      account: stored.account ?? undefined,
      error: error instanceof Error ? error.message : "Erreur inconnue",
    };
  }
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Accès privé à RM Morning.
 *
 * `proxy.ts` — et non `middleware.ts`, déprécié en Next 16 — s'exécute avant
 * toute route, en runtime Node. C'est ce qui permet de protéger d'un seul geste
 * les pages ET les routes `/api/*` : il n'existe aucun chemin qui contourne ce
 * fichier, donc aucune API sensible exposée par oubli.
 *
 * POURQUOI SI PEU DE CODE. Un utilisateur, des données commerciales internes,
 * HTTPS fourni par Fly. Un fournisseur d'identité, une base d'utilisateurs ou
 * une gestion de rôles seraient du décor. Ce qu'il faut : un secret que seul le
 * propriétaire connaît, une comparaison qui ne fuit pas par le temps de réponse,
 * et une session signée qu'on ne peut pas forger. Tout tient ici.
 *
 * CE QUE CE N'EST PAS. Il n'y a pas de limitation du nombre d'essais : la
 * documentation de Next déconseille de s'appuyer sur un état global dans un
 * proxy. La protection contre la force brute repose donc entièrement sur la
 * longueur du mot de passe — d'où la consigne d'en générer un aléatoire de
 * 24 caractères ou plus, jamais un mot de passe choisi à la main.
 *
 * REMPLAÇABLE. Le jour où un collègue doit entrer, Cloudflare Access se pose
 * devant l'application et ce fichier se supprime sans rien casser ailleurs.
 */

const COOKIE = "rm_session";
const LOGIN_PATH = "/rm-login";
/** Trente jours : assez pour ne pas ressaisir à chaque consultation du matin. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Seule route exemptée. Fly doit pouvoir la sonder sans session. */
const PUBLIC_PATHS = new Set(["/api/health"]);

const b64url = (b: Buffer) => b.toString("base64url");

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** Comparaison à temps constant, insensible aux différences de longueur. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function validSession(value: string | undefined, secret: string): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const expires = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!/^\d{1,15}$/.test(expires)) return false;
  if (Number(expires) <= Date.now()) return false;
  return sameSecret(signature, sign(expires, secret));
}

/**
 * Destination après connexion. Refuse tout ce qui n'est pas un chemin interne :
 * sans ce filtre, `?next=https://ailleurs` ferait de la page de connexion une
 * redirection ouverte.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function loginPage(next: string, error: boolean): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RM Morning</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         font:15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background:#f5f7f9; color:#141a24; }
  @media (prefers-color-scheme: dark) { body { background:#0d1118; color:#e5eaf1; } }
  form { display:grid; gap:.9rem; width:min(21rem, calc(100vw - 2.5rem));
         padding:1.9rem; border-radius:6px; background:#fff;
         box-shadow:0 1px 3px rgba(0,0,0,.09), 0 8px 28px rgba(0,0,0,.07); }
  @media (prefers-color-scheme: dark) { form { background:#151b24; box-shadow:none; border:1px solid #262f3c; } }
  h1 { margin:0; font-size:1.1rem; font-weight:600; letter-spacing:-.01em; }
  p  { margin:0; font-size:.8125rem; opacity:.68; }
  input, button { font:inherit; padding:.6rem .7rem; border-radius:4px; border:1px solid #b9c2ce; }
  @media (prefers-color-scheme: dark) { input { background:#0d1118; color:inherit; border-color:#3a4655; } }
  input:focus-visible, button:focus-visible { outline:2px solid #26356b; outline-offset:2px; }
  button { background:#26356b; color:#fff; border-color:#26356b; font-weight:500; cursor:pointer; }
  .err { color:#94182b; font-size:.8125rem; }
  @media (prefers-color-scheme: dark) { .err { color:#e58089; } }
</style>
</head>
<body>
  <form method="post" action="${LOGIN_PATH}?next=${encodeURIComponent(next)}">
    <h1>RM Morning</h1>
    <p>Accès réservé.</p>
    <input type="password" name="password" autocomplete="current-password"
           autofocus required aria-label="Mot de passe" placeholder="Mot de passe">
    ${error ? '<span class="err">Mot de passe incorrect.</span>' : ""}
    <button type="submit">Entrer</button>
  </form>
</body>
</html>`;
}

const html = (body: string, status = 200) =>
  new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const password = process.env.RM_AUTH_PASSWORD;
  const secret = process.env.RM_AUTH_SECRET;

  // Sans secrets configurés : ouvert en développement, FERMÉ en production.
  // Le sens de ce défaut est délibéré — une erreur de configuration doit rendre
  // l'application inaccessible, jamais publique.
  if (!password || !secret) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return html(
      "<!doctype html><meta charset=utf-8><p>Authentification non configurée : " +
        "RM_AUTH_PASSWORD et RM_AUTH_SECRET sont absents.</p>",
      503,
    );
  }

  const authenticated = validSession(request.cookies.get(COOKIE)?.value, secret);

  if (pathname === LOGIN_PATH) {
    const next = safeNext(searchParams.get("next"));

    if (request.method === "POST") {
      const form = await request.formData();
      const given = String(form.get("password") ?? "");
      if (!sameSecret(given, password)) return html(loginPage(next, true), 401);

      const expires = String(Date.now() + SESSION_MS);
      const response = NextResponse.redirect(new URL(next, request.url), 303);
      response.cookies.set(COOKIE, `${expires}.${sign(expires, secret)}`, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: Math.floor(SESSION_MS / 1000),
      });
      return response;
    }

    if (authenticated) return NextResponse.redirect(new URL(next, request.url));
    return html(loginPage(next, false));
  }

  if (authenticated) return NextResponse.next();

  // Une requête `fetch` doit recevoir un refus lisible, pas la page de connexion :
  // les composants clients attendent du JSON et afficheraient sinon une erreur de
  // parsing en guise de message.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Non authentifié." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const target = new URL(LOGIN_PATH, request.url);
  target.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(target);
}

export const config = {
  // Sans matcher, le proxy s'exécuterait aussi sur les fichiers statiques et
  // bloquerait le CSS et le JavaScript de sa propre page de connexion.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

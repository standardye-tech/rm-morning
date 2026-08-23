/**
 * Résolveur minimal pour les scripts de validation.
 *
 * Les fichiers de `src/lib` s'importent entre eux sans extension, comme le
 * veut TypeScript. Node en ESM exige l'extension. Ce hook ajoute `.ts` aux
 * imports relatifs qui n'en portent pas — rien de plus. Il ne sert qu'aux
 * harnais : l'application, elle, est compilée par Next.
 *
 * Il traduit aussi l'alias `@/…` en `src/…`, comme le fait `tsconfig.json`.
 * Sans cela, un harnais ne peut pas importer un module applicatif qui emploie
 * l'alias — c'est le cas des routes d'API, dont `/api/health`.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSIONS = [".ts", ".tsx", ""];

async function tryEach(base, context, next) {
  let last;
  for (const ext of EXTENSIONS) {
    try {
      return await next(`${base}${ext}`, context);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const base = pathToFileURL(path.resolve(process.cwd(), "src", specifier.slice(2))).href;
    return tryEach(base, context, next);
  }

  if (specifier.startsWith(".") && !/\.[cm]?[jt]s(on)?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Pas un module TypeScript : on laisse Node résoudre normalement.
    }
  }

  try {
    return await next(specifier, context);
  } catch (error) {
    // `next` ne publie pas de table `exports` : `next/server` n'est résoluble
    // qu'avec son extension en ESM strict, alors que le bundler de Next l'accepte
    // sans. On ne comble ce trou qu'après un échec, pour ne rien changer aux
    // résolutions qui aboutissent déjà.
    if (error?.code === "ERR_MODULE_NOT_FOUND" && !/\.[cm]?js$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw error;
  }
}

/**
 * Résolveur minimal pour les scripts de validation.
 *
 * Les fichiers de `src/lib` s'importent entre eux sans extension, comme le
 * veut TypeScript. Node en ESM exige l'extension. Ce hook ajoute `.ts` aux
 * imports relatifs qui n'en portent pas — rien de plus. Il ne sert qu'aux
 * harnais : l'application, elle, est compilée par Next.
 */

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]s(on)?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Pas un module TypeScript : on laisse Node résoudre normalement.
    }
  }
  return next(specifier, context);
}

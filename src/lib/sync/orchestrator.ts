/**
 * Actualisation globale — l'orchestrateur.
 *
 * Un seul point d'entrée : `startGlobalSync()`. Il pose le verrou, crée le run,
 * puis exécute les étapes dans l'ordre déclaré par `steps.ts`. Le client ne
 * connaît ni l'ordre ni les dépendances : toute la logique vit ici, côté serveur.
 *
 * PAS DE PARALLÉLISME. Les étapes sont séquentielles parce que presque toutes
 * dépendent de la précédente, et que les deux seules réellement indépendantes —
 * pistes et Perspective — ne durent que quelques secondes. La cohérence primait
 * sur la vitesse : gagner cinq secondes ne vaut pas le risque de scorer un pipe
 * à moitié importé.
 *
 * Écritures locales uniquement.
 */

import {
  beat,
  completeRun,
  createRun,
  activeRun,
  finishStep,
  getRun,
  mergeSources,
  startStep,
  type SyncRunState,
} from "./store";
import { buildSteps, type SyncStep } from "./steps";

export class SyncBusyError extends Error {
  readonly runId: number;
  constructor(runId: number) {
    super("Une actualisation est déjà en cours.");
    this.name = "SyncBusyError";
    this.runId = runId;
  }
}

/**
 * Démarre une actualisation et rend le run immédiatement.
 *
 * L'exécution continue en arrière-plan : l'interface interroge ensuite l'état.
 * Une actualisation complète dure plus longtemps qu'une requête HTTP raisonnable,
 * et laisser le navigateur attendre plusieurs minutes exposerait à un timeout
 * réseau qui donnerait l'illusion d'un échec.
 */
export function startGlobalSync(
  triggerKind = "ui",
  /**
   * Liste d'étapes injectable. La production utilise toujours `buildSteps()` ;
   * seule la suite de contrôles en fournit d'autres, pour provoquer un échec sans
   * ajouter de branche de test dans le code d'exécution.
   */
  steps: SyncStep[] = buildSteps(),
): { run: SyncRunState; done: Promise<void> } {
  const busy = activeRun();
  if (busy) throw new SyncBusyError(busy.id);

  const run = createRun(
    steps.map((s) => ({ key: s.key, label: s.label, blocking: s.blocking })),
    triggerKind,
  );
  return { run, done: execute(run.id, steps) };
}

/** Exécute une actualisation de bout en bout et attend sa fin. */
export async function runGlobalSyncToCompletion(
  triggerKind = "script",
  steps?: SyncStep[],
): Promise<SyncRunState> {
  const { run, done } = startGlobalSync(triggerKind, steps);
  await done;
  return getRun(run.id)!;
}

async function execute(runId: number, steps: SyncStep[]): Promise<void> {
  const warnings: string[] = [];
  let blockingFailure: string | null = null;

  for (const step of steps) {
    // Une étape bloquante en échec interrompt la suite : scorer un pipe non
    // importé produirait un chiffre faux, pas un chiffre incomplet.
    if (blockingFailure) {
      finishStep(runId, step.key, "skipped", null, null);
      continue;
    }
    startStep(runId, step.key);
    try {
      const outcome = await withTimeout(step.run(), step.timeoutMs, step.label);
      if (outcome.sources) mergeSources(runId, outcome.sources);
      if (outcome.warning) warnings.push(`${step.label} : ${outcome.warning}`);
      finishStep(
        runId,
        step.key,
        outcome.warning ? "warning" : "success",
        outcome.detail,
        outcome.warning ?? null,
      );
    } catch (error) {
      const message = readable(error);
      finishStep(runId, step.key, "failed", null, message);
      if (step.blocking) blockingFailure = `${step.label} : ${message}`;
      else warnings.push(`${step.label} non actualisé — ${message}`);
    }
    beat(runId, step.key);
  }

  if (blockingFailure) {
    completeRun(runId, "failed", warnings, blockingFailure);
  } else if (warnings.length > 0) {
    completeRun(runId, "warning", warnings, null);
  } else {
    completeRun(runId, "success", [], null);
  }
}

/**
 * Borne la durée d'une étape.
 *
 * Le timeout de `execFile` ne couvre que les processus enfants ; une API HTTP
 * bloquée laisserait sinon le bouton indéfiniment en « en cours ». La promesse
 * sous-jacente n'est pas annulable : on l'abandonne, et l'étape est déclarée en
 * échec. C'est acceptable ici parce que chaque étape écrit dans une transaction
 * qui aboutit ou n'aboutit pas.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} n'a pas répondu en ${Math.round(ms / 1000)} s.`)),
        ms,
      );
    }),
  ]);
}

/**
 * Message d'erreur lisible par un manager.
 *
 * Les erreurs des connecteurs sont verbeuses — sortie JSON de la CLI Salesforce,
 * traces Python. On garde la première ligne utile et on nomme la cause quand elle
 * est reconnaissable.
 */
function readable(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name;
    if (name === "SalesforceAuthError") {
      return "connexion Salesforce expirée — reconnectez-vous depuis Données";
    }
    if (name === "GmailAuthError") return "Gmail non connecté";
    if (name === "ForecastAuthError" || name === "ForecastAccessError") {
      return "Google Sheet Perspective inaccessible";
    }
    const first = error.message.split("\n").find((l) => l.trim().length > 0) ?? error.message;
    return first.trim().slice(0, 300);
  }
  return String(error).slice(0, 300);
}

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
  HEARTBEAT_INTERVAL_MS,
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
    // Battement pendant l'étape, et pas seulement à ses bornes : sans lui, une
    // étape plus longue que HEARTBEAT_TIMEOUT_MS fait passer un run vivant pour
    // mort. `unref` pour que ce minuteur ne retienne jamais le processus.
    const pulse = setInterval(() => beat(runId, step.key), HEARTBEAT_INTERVAL_MS);
    pulse.unref();
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
    } finally {
      clearInterval(pulse);
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
 * Motifs masqués avant toute journalisation d'une sortie de processus enfant.
 *
 * La CLI Salesforce recopie parfois son URL d'authentification dans un message
 * d'erreur, et cette URL porte un jeton de rafraîchissement. Les traces Python
 * peuvent exposer une clé d'API. Rien de tout cela ne doit atterrir en base ni à
 * l'écran : le résumé d'erreur est utile, pas au prix d'une fuite.
 */
const SECRETS = [
  /force:\/\/\S+/g,
  /sk-ant-[A-Za-z0-9_-]+/g,
  /GOCSPX-[A-Za-z0-9_-]+/g,
  /\b(?:Bearer|access_token|refresh_token)[=:\s]+\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, "[masqué]"), text);
}

/**
 * Message d'erreur lisible par un manager.
 *
 * On nomme la cause quand elle est reconnaissable. Sinon on garde la première
 * ligne — celle qui dit QUOI a échoué — ET les dernières lignes utiles, celles
 * qui disent POURQUOI.
 *
 * Ce second morceau a été ajouté après l'incident du 23/08 : `execFile` produit
 * « Command failed: <commande> » en première ligne et le vrai message en
 * dernière. Ne garder que la première ligne réduisait un FileNotFoundError
 * parfaitement explicite à un « Command failed » inexploitable, et obligeait à
 * rejouer la commande à la main pour savoir ce qui s'était passé.
 *
 * Ce n'est pas un dump : trois lignes au plus, 600 caractères au plus, et tout
 * ce qui ressemble à un secret est masqué.
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

    const lines = redact(error.message)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return error.message.slice(0, 300);

    const first = lines[0].slice(0, 300);
    // Les tracebacks placent la cause réelle en dernier. On prend les deux
    // dernières lignes distinctes de la première, sans jamais tout recopier.
    const tail = lines
      .slice(1)
      .filter((l) => l !== lines[0])
      .slice(-2)
      .map((l) => l.slice(0, 200));

    return [first, ...tail].join(" · ").slice(0, 600);
  }
  return redact(String(error)).slice(0, 300);
}

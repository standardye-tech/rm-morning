/**
 * Source Salesforce via l'API REST, en LECTURE SEULE.
 *
 * L'authentification est entièrement déléguée à la CLI Salesforce déjà
 * connectée localement (`sf org login web --alias rm-morning`) :
 *   — RM Morning ne voit, ne stocke, ne journalise et n'affiche aucun jeton ;
 *   — aucun secret ne transite par `.env.local` ni par la base ;
 *   — seules deux sous-commandes sont autorisées ici, `sobject describe` et
 *     `data query`. Il n'existe volontairement aucune fonction d'écriture.
 *
 * La sortie est un `RawOpportunity[]` strictement identique en forme à celui de
 * `ManualSalesforceSource` : la normalisation en aval est commune aux deux, et
 * le moteur de reporting ignore d'où viennent les données.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { SALESFORCE_API, SALESFORCE_LOGIN_COMMAND } from "../config";
import {
  RAW_FIELDS,
  type ParseIssue,
  type RawOpportunity,
  type SalesforceFetchResult,
  type SalesforceSource,
} from "./salesforce";

const execFileAsync = promisify(execFile);

/** Session CLI absente ou expirée : l'interface propose de se reconnecter. */
export class SalesforceAuthError extends Error {
  readonly loginCommand = SALESFORCE_LOGIN_COMMAND;
  constructor(message: string) {
    super(message);
    this.name = "SalesforceAuthError";
  }
}

/**
 * Sous-commandes autorisées. Toute écriture est hors de portée par construction :
 * ce type interdit d'écrire un jour `data create`, `data update` ou `data delete`.
 */
type ReadOnlyCommand =
  | ["sobject", "describe", ...string[]]
  | ["data", "query", ...string[]]
  | ["org", "display", ...string[]];

/**
 * Localise le script d'entrée de la CLI.
 *
 * On invoque `run.js` avec Node plutôt que le shim `sf.cmd` : depuis Node 20,
 * Windows refuse de lancer un `.cmd` sans shell, et passer par un shell
 * obligerait à échapper la requête SOQL (guillemets, accents, emoji).
 */
function resolveCliEntry(): string {
  const fromEnv = process.env.SF_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const suffix = "node_modules/@salesforce/cli/bin/run.js";
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", suffix),
    process.env.PREFIX && path.join(process.env.PREFIX, "lib", suffix),
    `/usr/local/lib/${suffix}`,
    `/usr/lib/${suffix}`,
    process.env.HOME && path.join(process.env.HOME, ".npm-global/lib", suffix),
  ].filter((p): p is string => Boolean(p));

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new SalesforceAuthError(
      "CLI Salesforce introuvable. Installez-la avec « npm install -g @salesforce/cli », " +
        "ou renseignez SF_CLI_PATH avec le chemin de bin/run.js.",
    );
  }
  return found;
}

type CliResponse<T> = { status: number; result: T; message?: string; name?: string };

/**
 * Délai au-delà duquel une invocation de la CLI est abandonnée.
 *
 * C'était le seul `execFile` du projet sans délai. Le garde-fou de
 * l'orchestrateur borne bien la DURÉE D'UNE ÉTAPE, mais son propre commentaire
 * le dit : « la promesse sous-jacente n'est pas annulable : on l'abandonne ».
 * Une CLI réellement figée survivait donc à l'étape, en processus orphelin, sans
 * que rien ne la tue.
 *
 * Trois minutes : un appel normal prend une à huit secondes ; le pire cas
 * observé sous bridage CPU reste très en deçà. Assez généreux pour ne pas
 * inventer d'échec, assez court pour ne jamais faire attendre dix minutes.
 */
const CLI_TIMEOUT_MS = Number(process.env.RM_SF_CLI_TIMEOUT_MS ?? 180_000);

async function runCli<T>(command: ReadOnlyCommand): Promise<T> {
  const entry = resolveCliEntry();
  const args = [entry, ...command, "--target-org", SALESFORCE_API.orgAlias, "--json"];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
      // SIGKILL et non SIGTERM : la CLI est un processus Node avec ses propres
      // gestionnaires de signaux, et l'objectif ici est la garantie qu'aucun
      // orphelin ne subsiste. La commande est en lecture seule — la tuer net
      // n'a aucun effet de bord.
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        // Next impose FORCE_COLOR à ses processus enfants ; la CLI colorise
        // alors son JSON avec des séquences ANSI, qui le rendent illisible.
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    }));
  } catch (error) {
    const withOutput = error as {
      stdout?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };

    // Délai dépassé : le processus a été tué. À traiter AVANT la reprise de
    // `stdout`, qui ne contiendrait ici qu'un JSON tronqué — et donnerait un
    // « réponse illisible » qui masquerait la vraie cause. Ce n'est pas une
    // erreur d'authentification : ne pas envoyer l'utilisateur se reconnecter.
    if (withOutput.killed || withOutput.signal === "SIGKILL") {
      throw new Error(
        `La CLI Salesforce n'a pas répondu en ${Math.round(CLI_TIMEOUT_MS / 1000)} s ` +
          `(commande « ${command.slice(0, 2).join(" ")} ») et a été arrêtée. ` +
          `Réessayez ; si cela persiste, vérifiez la disponibilité de Salesforce.`,
      );
    }

    // La CLI sort en code non nul mais écrit quand même un JSON exploitable.
    if (!withOutput.stdout) {
      throw new SalesforceAuthError(
        `Impossible d'exécuter la CLI Salesforce : ${withOutput.message ?? "erreur inconnue"}`,
      );
    }
    stdout = withOutput.stdout;
  }

  let parsed: CliResponse<T>;
  try {
    parsed = JSON.parse(stdout) as CliResponse<T>;
  } catch {
    // On expose le début de la sortie : c'est le seul moyen de diagnostiquer
    // une bannière ou un avertissement que la CLI écrirait avant son JSON.
    throw new Error(
      `Réponse illisible de la CLI Salesforce. Début de la sortie : ${JSON.stringify(
        stdout.slice(0, 300),
      )}`,
    );
  }

  if (parsed.status !== 0) {
    const message = parsed.message ?? "Erreur Salesforce inconnue.";
    // Session absente, expirée, ou alias inconnu : cas « reconnexion requise ».
    if (
      /no authorization information|not found|expired|invalid_grant|INVALID_SESSION_ID|NamedOrgNotFound/i.test(
        `${parsed.name ?? ""} ${message}`,
      )
    ) {
      throw new SalesforceAuthError(message);
    }
    throw new Error(message);
  }

  return parsed.result;
}

type DescribeField = {
  name: string;
  label?: string;
  picklistValues?: { value: string; label: string; active?: boolean }[];
};

/**
 * Métadonnée mise en cache pour la durée du processus : le `describe` pèse
 * ~460 Ko et doublait le temps de synchronisation, alors que les listes de choix
 * ne changent qu'exceptionnellement. Redémarrer l'application la recharge.
 */
let picklistCache: Record<string, Map<string, string>> | null = null;

/**
 * Construit, à partir de la métadonnée Salesforce, la table de correspondance
 * valeur technique → libellé pour les champs picklist. Jamais écrite à la main.
 */
async function fetchPicklistLabels(): Promise<Record<string, Map<string, string>>> {
  if (picklistCache) return picklistCache;

  const described = await runCli<{ fields: DescribeField[] }>([
    "sobject",
    "describe",
    "--sobject",
    SALESFORCE_API.sobject,
  ]);

  const maps: Record<string, Map<string, string>> = {};
  for (const fieldName of SALESFORCE_API.picklistFields) {
    const field = described.fields.find((f) => f.name === fieldName);
    if (!field?.picklistValues?.length) continue;
    maps[fieldName] = new Map(field.picklistValues.map((v) => [v.value, v.label ?? v.value]));
  }
  picklistCache = maps;
  return maps;
}

type SalesforceRecord = Record<string, unknown>;

/** Lit un chemin « Owner.Name » dans un enregistrement imbriqué. */
function readPath(record: SalesforceRecord, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object") return (node as SalesforceRecord)[key];
    return undefined;
  }, record);
}

/** Convertit une valeur Salesforce en chaîne, en laissant la normalisation en aval. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function buildSoql(): string {
  const stages = SALESFORCE_API.stages.map((s) => `'${s.replace(/'/g, "\\'")}'`).join(", ");
  return (
    `SELECT ${SALESFORCE_API.fields.join(", ")} ` +
    `FROM ${SALESFORCE_API.sobject} ` +
    `WHERE StageName IN (${stages})`
  );
}

export class ApiSalesforceSource implements SalesforceSource {
  readonly kind = "api";

  async fetch(): Promise<SalesforceFetchResult> {
    const issues: ParseIssue[] = [];
    const labels = await fetchPicklistLabels();

    const queried = await runCli<{ records: SalesforceRecord[]; totalSize: number; done: boolean }>([
      "data",
      "query",
      "--query",
      buildSoql(),
    ]);

    if (queried.done === false) {
      issues.push({
        message:
          "Salesforce a signalé un résultat tronqué : toutes les opportunités n'ont peut-être pas été récupérées.",
      });
    }

    /** Traduit une valeur picklist en libellé quand la métadonnée le permet. */
    const label = (fieldName: string, value: unknown): string | null => {
      const text = asText(value);
      if (text === null) return null;
      return labels[fieldName]?.get(text) ?? text;
    };

    const rows: RawOpportunity[] = [];
    for (const record of queried.records) {
      const id = asText(record.Id);
      if (!id) {
        issues.push({ message: "Enregistrement Salesforce sans Id, ignoré." });
        continue;
      }

      rows.push({
        // L'API renvoie l'Id sur 18 caractères ; l'export historique en donnait
        // 15. On garde les 15 premiers pour que les deux sources produisent la
        // même clé, et que l'historique déjà en base reste rattaché.
        opportunityId: id.slice(0, 15),
        name: asText(record.Name),
        clientContact: asText(record.TECHNomCompletClient__c),
        clientEmail: asText(readPath(record, "Contact_client__r.Email")),
        ownerName: asText(readPath(record, "Owner.Name")),
        gmv: asText(record.Amount),
        stage: label("StageName", record.StageName),
        probability: asText(record.Probability),
        kanbanProjection: asText(record.Projection_Kanban__c),
        createdAt: asText(record.CreatedDate),
        leadCreatedAt: asText(record.Date_de_creation_de_la_piste__c),
        quoteSignatureDate: asText(record.DateSignatureDevis__c),
        lastActivityAt: asText(record.LastActivityDate),
        lastModifiedAt: asText(record.LastModifiedDate),
        postalCode: asText(readPath(record, "Account.BillingPostalCode")),
        city: asText(readPath(record, "Account.BillingCity")),
        acquisitionChannel: label("Canal_d_acquisition__c", record.Canal_d_acquisition__c),
        leadSource: label("LeadSource", record.LeadSource),
        service: label("Prestation__c", record.Prestation__c),
        standByUntil: asText(record.En_stand_by_jusqu_au__c),
        standByFlag: asText(record.En_stand_by__c),
      });
    }

    return {
      sourceKind: this.kind,
      sourceLabel: `Salesforce API — org ${SALESFORCE_API.orgAlias}`,
      fileName: null,
      fetchedAt: new Date(),
      detectedFields: [...RAW_FIELDS],
      missingFields: [],
      rawHeaders: [...SALESFORCE_API.fields],
      rows,
      issues,
    };
  }
}

export type SalesforceConnection = {
  connected: boolean;
  username?: string;
  instanceUrl?: string;
  apiVersion?: string;
  error?: string;
  loginCommand: string;
};

/**
 * Vérifie que la session CLI répond.
 *
 * `org display` renvoie aussi un `accessToken` : on n'extrait explicitement que
 * trois champs sûrs, et rien d'autre ne sort de cette fonction — ni vers la
 * base, ni vers les journaux, ni vers l'interface.
 */
/**
 * Exécute une requête SOQL en lecture et rend les enregistrements.
 *
 * Exposé pour que les autres sources (pistes, jalons) réutilisent la même
 * session CLI et la même gestion d'erreur, sans réimplémenter l'invocation.
 * Aucune écriture n'est possible par ce chemin : seule la sous-commande
 * `data query` est utilisée.
 */
export async function runSoql<T>(soql: string): Promise<T[]> {
  const queried = await runCli<{ records: T[]; totalSize: number; done: boolean }>([
    "data",
    "query",
    "--query",
    soql,
  ]);
  return queried.records ?? [];
}

export async function checkSalesforceConnection(): Promise<SalesforceConnection> {
  try {
    const org = await runCli<{
      username?: string;
      instanceUrl?: string;
      apiVersion?: string;
      connectedStatus?: string;
    }>(["org", "display"]);

    const connected = (org.connectedStatus ?? "").toLowerCase() === "connected";
    return {
      connected,
      username: org.username,
      instanceUrl: org.instanceUrl,
      apiVersion: org.apiVersion,
      error: connected ? undefined : (org.connectedStatus ?? "Statut de connexion inconnu"),
      loginCommand: SALESFORCE_LOGIN_COMMAND,
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Erreur inconnue",
      loginCommand: SALESFORCE_LOGIN_COMMAND,
    };
  }
}

/**
 * Source principale du forecast : Google Sheets API, authentifiée par un
 * compte de service, en LECTURE SEULE.
 *
 * Le classeur n'est pas public : il est simplement partagé en « Lecteur » avec
 * l'adresse du compte de service. Aucun scope Drive, aucun accès Gmail, aucune
 * écriture — le seul scope demandé est `spreadsheets.readonly`.
 *
 * La clé privée est lue depuis `data/` (ignoré par Git), utilisée uniquement
 * en mémoire pour signer l'assertion JWT, et n'est jamais journalisée, affichée
 * ni recopiée ailleurs. Le jeton d'accès obtenu n'est pas persisté non plus.
 *
 * Pas de dépendance : l'échange JWT tient en quelques lignes avec `node:crypto`.
 */

import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import path from "node:path";

import { FORECAST_SHEET, GOOGLE_SHEETS } from "../config";
import { parseForecastGrid, type SheetRowIssue } from "./forecast-sheet-parser";
import type {
  ForecastCurrentLine,
  ForecastFetchResult,
  ForecastSnapshotLine,
  ForecastSnapshotSource,
} from "./forecast-snapshot";
import type { ParseIssue } from "./salesforce";

/** Le compte de service ne peut pas lire le classeur : l'interface l'explique. */
export class ForecastAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastAuthError";
  }
}

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

async function loadKey(): Promise<ServiceAccountKey> {
  const file = path.resolve(/* turbopackIgnore: true */ process.cwd(), GOOGLE_SHEETS.keyFile);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ForecastAuthError(
      `Clé du compte de service introuvable (${GOOGLE_SHEETS.keyFile}). ` +
        "Déposez le fichier JSON téléchargé depuis Google Cloud à cet emplacement.",
    );
  }

  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch {
    throw new ForecastAuthError("La clé du compte de service n'est pas un JSON valide.");
  }
  if (!key.client_email || !key.private_key || !key.token_uri) {
    throw new ForecastAuthError(
      "Clé du compte de service incomplète : client_email, private_key ou token_uri manquant.",
    );
  }
  return key as ServiceAccountKey;
}

/**
 * Jeton d'accès mis en cache pour la durée du processus, renouvelé une minute
 * avant expiration. Jamais écrit sur disque ni en base.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(key: ServiceAccountKey): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${base64url({ alg: "RS256", typ: "JWT" })}.` +
    base64url({
      iss: key.client_email,
      scope: GOOGLE_SHEETS.scope,
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    });

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(key.private_key, "base64url")}`;

  const response = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    // On ne remonte que le message d'erreur de Google, jamais l'assertion.
    throw new ForecastAuthError(
      `Authentification Google refusée : ${payload.error_description ?? payload.error ?? response.status}`,
    );
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function callSheets<T>(token: string, url: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 403 || response.status === 404) {
    throw new ForecastAuthError(
      `Le compte de service n'a pas accès au classeur (HTTP ${response.status}). ` +
        "Partagez le Google Sheet en « Lecteur » avec l'adresse du compte de service.",
    );
  }
  if (!response.ok) {
    throw new Error(`Google Sheets a répondu ${response.status}.`);
  }
  return (await response.json()) as T;
}

export class SheetsApiForecastSnapshotSource implements ForecastSnapshotSource {
  readonly kind = "sheet-api";

  /**
   * `months` sert de filtre indicatif : les onglets sont découverts dans le
   * classeur, ce qui permet d'importer aussi les mois historiques sans avoir à
   * deviner leur nom.
   */
  async fetch(months: string[]): Promise<ForecastFetchResult> {
    const key = await loadKey();
    const token = await getAccessToken(key);
    const id = encodeURIComponent(FORECAST_SHEET.spreadsheetId);

    // 1. Découverte des onglets.
    const meta = await callSheets<{
      properties?: { title?: string };
      sheets?: { properties?: { title?: string } }[];
    }>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties.title`,
    );

    const ignored = new Set(GOOGLE_SHEETS.ignoredTabs.map((t) => t.toLowerCase()));
    const tabs = (meta.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t))
      .filter((t) => !ignored.has(t.toLowerCase()))
      .filter((t) => GOOGLE_SHEETS.monthTabPattern.test(t));

    const issues: ParseIssue[] = [];
    if (tabs.length === 0) {
      issues.push({
        message: "Aucun onglet mensuel « AAAA-MM » trouvé dans le classeur.",
      });
    }
    // `months` n'exclut rien : on importe tout l'historique disponible. La
    // fenêtre reste utile aux autres sources, qui ne savent pas lister.
    void months;

    // 2. Lecture des valeurs, tous onglets en un appel.
    const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`'${t}'!A:ZZ`)}`).join("&");
    const values = await callSheets<{ valueRanges?: { values?: string[][] }[] }>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${ranges}` +
        "&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS",
    );

    const lines: ForecastSnapshotLine[] = [];
    const currentLines: ForecastCurrentLine[] = [];
    const rowIssues: SheetRowIssue[] = [];
    const readMonths: string[] = [];
    const currentMonths: string[] = [];
    const snapshotDates = new Set<string>();
    const updatedAts = new Set<string>();

    tabs.forEach((tab, index) => {
      const grid = values.valueRanges?.[index]?.values ?? [];
      if (grid.length === 0) {
        issues.push({ message: `Onglet ${tab} : vide.` });
        return;
      }
      const parsed = parseForecastGrid(grid, tab);
      if (parsed.lines.length > 0 || parsed.currentLines.length > 0) readMonths.push(tab);
      // Le mois est déclaré « courant » dès que son bloc EN COURS a été LU,
      // même s'il ne porte aucune ligne : c'est ce qui permet de vider l'état
      // courant d'un mois qui s'est vidé, au lieu de laisser traîner l'ancien.
      if (parsed.currentUpdatedAt !== null || parsed.currentLines.length > 0) {
        currentMonths.push(tab);
      }
      lines.push(...parsed.lines);
      currentLines.push(...parsed.currentLines);
      issues.push(...parsed.issues);
      rowIssues.push(...parsed.rowIssues);
      for (const date of parsed.snapshotDates) snapshotDates.add(date);
      if (parsed.currentUpdatedAt) updatedAts.add(parsed.currentUpdatedAt);
    });

    return {
      sourceKind: this.kind,
      sourceLabel: `Google Sheets API — ${meta.properties?.title ?? "classeur"} (compte de service)`,
      fetchedAt: new Date(),
      months: readMonths,
      snapshotDates: [...snapshotDates].sort(),
      currentMonths,
      currentUpdatedAt: [...updatedAts].sort().pop() ?? null,
      lines,
      currentLines,
      issues,
      rowIssues,
    };
  }
}

/** Vérifie l'accès au classeur sans rien exposer de la clé. */
export async function checkForecastSheetAccess(): Promise<{
  connected: boolean;
  serviceAccount?: string;
  spreadsheetTitle?: string;
  tabs?: string[];
  error?: string;
}> {
  try {
    const key = await loadKey();
    const token = await getAccessToken(key);
    const meta = await callSheets<{
      properties?: { title?: string };
      sheets?: { properties?: { title?: string } }[];
    }>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        FORECAST_SHEET.spreadsheetId,
      )}?fields=properties.title,sheets.properties.title`,
    );
    return {
      connected: true,
      serviceAccount: key.client_email,
      spreadsheetTitle: meta.properties?.title,
      tabs: (meta.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => Boolean(t)),
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Erreur inconnue",
    };
  }
}

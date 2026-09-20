/**
 * « Perspective ajustée » : lecture du classeur manuel de la Région.
 *
 * Lecture seule, à la demande, avec cache mémoire. Aucune donnée n'est écrite en
 * base : le classeur est retouché à la main et la Forecast doit toujours refléter
 * son état, pas une copie vieillie. Toute panne (accès refusé, réseau, onglet
 * absent) rend `null` et une raison lisible — jamais une autre valeur à la place.
 */

import { ADJUSTED_PERSPECTIVE_SHEET } from "./config";
import {
  callSheets,
  getAccessToken,
  loadKey,
} from "./sources/sheets-api-forecast";
import {
  parseAdjustedTab,
  pickTab,
  type AdjustedPerspective,
  type Grid,
} from "./sources/adjusted-perspective-parser";

export type AdjustedResult =
  | { ok: true; value: AdjustedPerspective }
  | { ok: false; reason: string };

const cache = new Map<string, { at: number; ttl: number; result: AdjustedResult }>();

async function read(month: string, allowSelection: boolean): Promise<AdjustedResult> {
  const id = encodeURIComponent(ADJUSTED_PERSPECTIVE_SHEET.spreadsheetId);
  const token = await getAccessToken(await loadKey());
  const meta = await callSheets<{ sheets?: { properties?: { title?: string } }[] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
  );
  const titles = (meta.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => Boolean(t));
  const tab = pickTab(titles, month);
  if (!tab.title) return { ok: false, reason: tab.issue ?? "onglet introuvable" };

  const range = encodeURIComponent(`'${tab.title}'!${ADJUSTED_PERSPECTIVE_SHEET.range}`);
  const values = await callSheets<{ values?: Grid }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}` +
      "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&majorDimension=ROWS",
  );
  const parsed = parseAdjustedTab(values.values ?? [], month, { allowSelection });
  return parsed
    ? { ok: true, value: parsed }
    : { ok: false, reason: "aucun snapshot renseigné pour ce mois" };
}

/**
 * `future` = le mois affiché est postérieur au mois courant : seul cas où la liste
 * manuelle d'un onglet sans snapshot tient lieu de Perspective ajustée.
 */
export async function loadAdjustedPerspective(month: string, future: boolean): Promise<AdjustedResult> {
  const cacheKey = `${month}:${future}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;

  let result: AdjustedResult;
  let ttl: number = ADJUSTED_PERSPECTIVE_SHEET.cacheMs;
  try {
    result = await read(month, future);
  } catch (error) {
    ttl = ADJUSTED_PERSPECTIVE_SHEET.failureCacheMs;
    const message = error instanceof Error ? error.message : "erreur inconnue";
    result = {
      ok: false,
      reason: /accès au classeur|HTTP 40[34]/.test(message)
        ? "classeur non partagé avec RM Morning"
        : "classeur illisible pour le moment",
    };
  }
  cache.set(cacheKey, { at: Date.now(), ttl, result });
  return result;
}

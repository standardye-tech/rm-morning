import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { importForecastSnapshots } from "@/lib/forecast-import";
import { ForecastAccessError, HttpForecastSnapshotSource } from "@/lib/sources/http-forecast-snapshot";
import { ManualForecastSnapshotSource } from "@/lib/sources/manual-forecast-snapshot";
import { ForecastAuthError, SheetsApiForecastSnapshotSource } from "@/lib/sources/sheets-api-forecast";
import type { ForecastSnapshotSource } from "@/lib/sources/forecast-snapshot";

/**
 * Import des snapshots hebdomadaires de forecast.
 *
 *   POST /api/forecast              → API Google Sheets, compte de service
 *   POST /api/forecast?source=file  → CSV locaux, secours
 *   POST /api/forecast?source=gviz  → export CSV par lien public, secours
 *
 * Lecture seule : rien n'est écrit dans le Sheet.
 */
export async function POST(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("source");
    const source: ForecastSnapshotSource =
      requested === "file"
        ? new ManualForecastSnapshotSource()
        : requested === "gviz"
          ? new HttpForecastSnapshotSource()
          : new SheetsApiForecastSnapshotSource();

    const summary = await importForecastSnapshots(source);

    revalidatePath("/");
    revalidatePath("/donnees");

    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof ForecastAuthError) {
      return NextResponse.json(
        { error: "Accès au Google Sheet impossible", detail: error.message, needsSharing: true },
        { status: 403 },
      );
    }
    if (error instanceof ForecastAccessError) {
      return NextResponse.json(
        { error: "Google Sheet non accessible", detail: error.message, needsSharing: true },
        { status: 403 },
      );
    }
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import path from "node:path";

import { EXPORT_DIR } from "@/lib/config";
import { importFromSource } from "@/lib/import";
import { ApiSalesforceSource, SalesforceAuthError } from "@/lib/sources/api-salesforce";
import { ManualSalesforceSource, findLatestExport } from "@/lib/sources/manual-salesforce";
import type { SalesforceSource } from "@/lib/sources/salesforce";

/**
 * Import des opportunités.
 *
 *   POST /api/import              → API Salesforce (source principale)
 *   POST /api/import?source=file  → dernier export `report*.xls` du dossier
 *   POST /api/import (multipart)  → fichier joint, fallback manuel
 *
 * Aucune écriture Salesforce n'est possible depuis cette route.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const requested = new URL(request.url).searchParams.get("source");
    const contentType = request.headers.get("content-type") ?? "";
    let source: SalesforceSource;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "Aucun fichier reçu." }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      source = new ManualSalesforceSource({ buffer, fileName: file.name });
    } else if (requested === "file") {
      // Le dossier scruté est choisi à l'exécution : c'est voulu, l'export est
      // déposé à la racine du projet. Application locale, jamais déployée.
      const dir = path.resolve(/* turbopackIgnore: true */ process.cwd(), EXPORT_DIR);
      const filePath = await findLatestExport(dir);
      if (!filePath) {
        return NextResponse.json(
          { error: `Aucun export « report*.xls » trouvé dans ${dir}.` },
          { status: 404 },
        );
      }
      source = new ManualSalesforceSource({ filePath });
    } else {
      source = new ApiSalesforceSource();
    }

    const summary = await importFromSource(source);

    revalidatePath("/");
    revalidatePath("/donnees");
    revalidatePath("/historique");

    return NextResponse.json({
      ...summary,
      sourceKind: source.kind,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof SalesforceAuthError) {
      return NextResponse.json(
        {
          error: "Connexion Salesforce requise",
          detail: error.message,
          loginCommand: error.loginCommand,
          needsLogin: true,
        },
        { status: 401 },
      );
    }
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

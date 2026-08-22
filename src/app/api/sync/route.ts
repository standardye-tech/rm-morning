import { NextResponse } from "next/server";

import { SyncBusyError, startGlobalSync } from "@/lib/sync/orchestrator";
import { activeRun, lastCompleteRun, lastRealRun } from "@/lib/sync/store";

export const dynamic = "force-dynamic";

/**
 * Actualisation globale.
 *
 *   POST /api/sync   démarre une actualisation et rend son identifiant
 *   GET  /api/sync   état d'avancement, pour l'interrogation par l'interface
 *
 * Toute la logique d'ordre vit côté serveur, dans `sync/orchestrator`. Le client
 * ne fait que déclencher et lire.
 *
 * Le POST rend la main immédiatement : une actualisation complète dure plus
 * longtemps qu'une requête HTTP raisonnable. L'exécution se poursuit dans le
 * processus du serveur — acceptable pour une application locale, où le serveur
 * n'est ni répliqué ni recyclé entre les requêtes.
 */
export async function POST() {
  try {
    const { run, done } = startGlobalSync("ui");
    // L'erreur est déjà consignée dans le run par l'orchestrateur ; ce catch
    // n'existe que pour ne pas laisser un rejet non traité tuer le processus.
    void done.catch(() => {});
    return NextResponse.json({ runId: run.id, status: run.status });
  } catch (error) {
    if (error instanceof SyncBusyError) {
      return NextResponse.json(
        { error: "Une actualisation est déjà en cours.", runId: error.runId, busy: true },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  // `activeRun` est appelé en premier : c'est lui qui referme un run dont le
  // battement s'est tu, pour qu'un plantage ne laisse pas l'interface en
  // « actualisation en cours » pour toujours.
  const active = activeRun();
  return NextResponse.json({
    active: active?.id ?? null,
    run: lastRealRun(),
    lastComplete: lastCompleteRun(),
  });
}

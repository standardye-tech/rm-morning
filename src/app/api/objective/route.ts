import { NextResponse } from "next/server";

import { businessMonth } from "@/lib/business-time";
import { clearObjective, listObjectives, setObjective } from "@/lib/objective-store";

export const dynamic = "force-dynamic";

/**
 * Objectif mensuel de la Région.
 *
 *   GET    /api/objective   objectifs renseignés pour M à M+3
 *   POST   /api/objective   enregistre un objectif   { month: "AAAA-MM", amount: number }
 *   DELETE /api/objective   retire un objectif       { month: "AAAA-MM" }
 *
 * Aucun montant par défaut : un mois sans objectif est « non renseigné ».
 */
const horizon = () => [0, 1, 2, 3].map((i) => businessMonth(new Date(), i));

export async function GET() {
  return NextResponse.json({ objectives: listObjectives(horizon()) });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { month?: unknown; amount?: unknown };
    if (typeof body.month !== "string") return NextResponse.json({ error: "Mois manquant." }, { status: 400 });
    const amount = typeof body.amount === "number" ? body.amount : Number(String(body.amount ?? "").replace(/\s/g, "").replace(",", "."));
    const objective = setObjective(body.month, amount);
    return NextResponse.json({ objective, objectives: listObjectives(horizon()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur inconnue" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { month?: unknown };
    if (typeof body.month !== "string") return NextResponse.json({ error: "Mois manquant." }, { status: 400 });
    clearObjective(body.month);
    return NextResponse.json({ objectives: listObjectives(horizon()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur inconnue" }, { status: 400 });
  }
}

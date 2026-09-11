import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import {
  addRadarContact,
  listRadarContacts,
  updateRadarContact,
  type RadarInput,
} from "@/lib/radar-store";

export const dynamic = "force-dynamic";

/**
 * Radar recrutement ET / sourcing architectes.
 *
 *   GET  /api/semaine/radar   tous les contacts
 *   POST /api/semaine/radar   { action: "ajouter", contact: RadarInput }
 *                             { action: "modifier", id, patch: Partial<RadarInput> }
 *
 * Saisie manuelle uniquement. Aucune source externe n'est interrogée ici.
 */
export async function GET() {
  return NextResponse.json({ contacts: listRadarContacts() });
}

const FIELDS: (keyof RadarInput)[] = [
  "category",
  "name",
  "company",
  "location",
  "url",
  "phone",
  "email",
  "notes",
  "status",
  "nextActionAt",
];

/** Ne garde que les champs connus, en chaînes ou null. Rien d'autre ne passe. */
function pick(raw: unknown): Partial<RadarInput> {
  const out: Record<string, string | null> = {};
  if (raw && typeof raw === "object") {
    for (const key of FIELDS) {
      const value = (raw as Record<string, unknown>)[key];
      if (value === undefined) continue;
      out[key] = value === null ? null : typeof value === "string" ? value : String(value);
    }
  }
  return out as Partial<RadarInput>;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      contact?: unknown;
      id?: unknown;
      patch?: unknown;
    };

    switch (body.action) {
      case "ajouter": {
        const input = pick(body.contact);
        if (!input.name || !input.category) {
          return NextResponse.json({ error: "Nom et catégorie sont obligatoires." }, { status: 400 });
        }
        const contact = addRadarContact(input as RadarInput);
        revalidatePath("/semaine");
        return NextResponse.json({ ok: true, contact, contacts: listRadarContacts() });
      }
      case "modifier": {
        const id = Number(body.id);
        if (!Number.isInteger(id)) return NextResponse.json({ error: "Identifiant manquant." }, { status: 400 });
        const contact = updateRadarContact(id, pick(body.patch));
        revalidatePath("/semaine");
        return NextResponse.json({ ok: true, contact, contacts: listRadarContacts() });
      }
      default:
        return NextResponse.json({ error: "action inconnue" }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

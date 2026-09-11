/**
 * Radar recrutement ET et sourcing architectes — persistance.
 *
 * Un pipeline commun, saisi à la main. V1 SANS automatisation : ni HelloWork,
 * ni Google, ni scraping. La colonne `source` vaut « manuel » partout ; les
 * sources futures y écriront leur nom et rien d'autre n'aura à changer.
 */

import { RADAR, type RadarCategory, type RadarStatus } from "./config";
import { getDb, queryAll, queryOne, type Row } from "./db";

export type RadarContact = {
  id: number;
  category: RadarCategory;
  name: string;
  company: string | null;
  location: string | null;
  url: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: RadarStatus;
  /** Date ISO « AAAA-MM-JJ » de la prochaine action, ou null. */
  nextActionAt: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type RadarInput = {
  category: RadarCategory;
  name: string;
  company?: string | null;
  location?: string | null;
  url?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  status?: RadarStatus;
  nextActionAt?: string | null;
};

const CATEGORY_KEYS = RADAR.categories.map((c) => c.key) as string[];
const STATUS_KEYS = RADAR.statuses.map((s) => s.key) as string[];

export function isRadarCategory(value: unknown): value is RadarCategory {
  return typeof value === "string" && CATEGORY_KEYS.includes(value);
}

export function isRadarStatus(value: unknown): value is RadarStatus {
  return typeof value === "string" && STATUS_KEYS.includes(value);
}

const text = (v: Row[string]) => (v == null ? null : String(v));
const clean = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

function toContact(row: Row): RadarContact {
  return {
    id: Number(row.id),
    category: String(row.category) as RadarCategory,
    name: String(row.name),
    company: text(row.company),
    location: text(row.location),
    url: text(row.url),
    phone: text(row.phone),
    email: text(row.email),
    notes: text(row.notes),
    status: String(row.status) as RadarStatus,
    nextActionAt: text(row.next_action_at),
    source: String(row.source),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listRadarContacts(): RadarContact[] {
  return queryAll<Row>(
    `SELECT * FROM radar_contact
      ORDER BY CASE WHEN status = 'ecarte' THEN 1 ELSE 0 END,
               COALESCE(next_action_at, '9999-12-31'), updated_at DESC`,
  ).map(toContact);
}

export function getRadarContact(id: number): RadarContact | null {
  const row = queryOne<Row>("SELECT * FROM radar_contact WHERE id = ?", id);
  return row ? toContact(row) : null;
}

export function addRadarContact(input: RadarInput, now = new Date()): RadarContact {
  const name = clean(input.name);
  if (!name) throw new Error("Le nom est obligatoire.");
  if (!isRadarCategory(input.category)) throw new Error("Catégorie inconnue.");
  const status = input.status ?? "nouveau";
  if (!isRadarStatus(status)) throw new Error("Statut inconnu.");
  const iso = now.toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO radar_contact
         (category, name, company, location, url, phone, email, notes, status, next_action_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manuel', ?, ?)`,
    )
    .run(
      input.category,
      name,
      clean(input.company),
      clean(input.location),
      clean(input.url),
      clean(input.phone),
      clean(input.email),
      clean(input.notes),
      status,
      clean(input.nextActionAt),
      iso,
      iso,
    );
  const created = getRadarContact(Number(result.lastInsertRowid));
  if (!created) throw new Error("Contact non relu après insertion.");
  return created;
}

export function updateRadarContact(id: number, patch: Partial<RadarInput>, now = new Date()): RadarContact {
  const existing = getRadarContact(id);
  if (!existing) throw new Error("Contact inconnu.");
  if (patch.status !== undefined && !isRadarStatus(patch.status)) throw new Error("Statut inconnu.");
  if (patch.category !== undefined && !isRadarCategory(patch.category)) throw new Error("Catégorie inconnue.");
  const name = patch.name === undefined ? existing.name : clean(patch.name);
  if (!name) throw new Error("Le nom est obligatoire.");

  const next = {
    category: patch.category ?? existing.category,
    name,
    company: patch.company === undefined ? existing.company : clean(patch.company),
    location: patch.location === undefined ? existing.location : clean(patch.location),
    url: patch.url === undefined ? existing.url : clean(patch.url),
    phone: patch.phone === undefined ? existing.phone : clean(patch.phone),
    email: patch.email === undefined ? existing.email : clean(patch.email),
    notes: patch.notes === undefined ? existing.notes : clean(patch.notes),
    status: patch.status ?? existing.status,
    nextActionAt: patch.nextActionAt === undefined ? existing.nextActionAt : clean(patch.nextActionAt),
  };

  getDb()
    .prepare(
      `UPDATE radar_contact
          SET category = ?, name = ?, company = ?, location = ?, url = ?, phone = ?, email = ?,
              notes = ?, status = ?, next_action_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      next.category,
      next.name,
      next.company,
      next.location,
      next.url,
      next.phone,
      next.email,
      next.notes,
      next.status,
      next.nextActionAt,
      now.toISOString(),
      id,
    );
  return getRadarContact(id)!;
}

/**
 * « Candidatures à traiter » : les contacts qui attendent une première action,
 * plus ceux dont la prochaine action tombe au plus tard en fin de semaine.
 * Pur, pour être contrôlable.
 */
export function radarToProcess(contacts: RadarContact[], weekEnd: string): RadarContact[] {
  const toProcess = RADAR.toProcess as readonly string[];
  return contacts.filter(
    (c) =>
      c.status !== "ecarte" &&
      (toProcess.includes(c.status) || (c.nextActionAt != null && c.nextActionAt <= weekEnd)),
  );
}

/** Contacts au stade « RDV » : ils alimentent le créneau Entretiens. */
export function radarInterviews(contacts: RadarContact[]): RadarContact[] {
  return contacts.filter((c) => c.status === RADAR.interview);
}

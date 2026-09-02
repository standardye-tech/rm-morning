/**
 * PÉRIMÈTRE COMMERCIAL RM MORNING — source de vérité unique.
 *
 * Avant, l'équipe était une constante de `config.ts` : la faire évoluer
 * demandait de modifier le code, de reconstruire et de redéployer. Elle vit
 * désormais dans SQLite, à côté du reste, et se gère depuis l'écran Données.
 *
 * UN SEUL PÉRIMÈTRE POUR TOUT. Salesforce, Perspective, Forecast, Performance et
 * les analyses passent tous par `matchTeamMember` / `activeTeamMembers` de
 * `normalize.ts`. Ce module est le seul à remplir ces deux fonctions : il n'y a
 * donc aucune seconde liste à tenir à jour ailleurs.
 *
 * CLÉ INTERNE. Salesforce ne nous expose pas d'identifiant de propriétaire —
 * l'API ne remonte que `Owner.Name`. La clé est donc la forme normalisée du nom
 * (minuscules, sans accents, sans ponctuation), ce qui neutralise justement ce
 * qu'on veut neutraliser : casse, accents, tirets, espaces doubles. Le nom
 * affiché reste, lui, la valeur lisible.
 *
 * RETRAIT NON DESTRUCTIF. Retirer un commercial bascule `active` à 0. Aucune
 * donnée Salesforce n'est supprimée : ses opportunités, ses snapshots et son
 * historique restent en base. Le réactiver le fait réapparaître tel quel.
 */

import { TEAM, TEAM_SEED_INACTIVE, type TeamMember } from "./config";
import { getDb } from "./db";
import { activeTeamMembers, normalizeKey, setActiveTeam } from "./normalize";
import type { TerritoryScope } from "./territory";

export type TeamMemberRecord = TeamMember & {
  /** Clé interne stable, insensible à la casse et aux accents. */
  key: string;
  active: boolean;
  updatedAt: string;
};

export type TeamCandidate = {
  key: string;
  name: string;
  /** Où ce nom a été vu : « salesforce », « perspective ». */
  sources: string[];
  lastSeenAt: string;
  /** Déjà présent dans le périmètre (actif ou non) ? */
  known: boolean;
};

type Row = {
  member_key: string;
  name: string;
  first_name: string;
  aliases: string;
  territory: string | null;
  active: number;
  updated_at: string;
};

/** Prénom par défaut d'un nom complet, quand l'interface n'en propose pas. */
function defaultFirstName(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? name;
}

function toMember(row: Row): TeamMemberRecord {
  const aliases = JSON.parse(row.aliases) as string[];
  return {
    key: row.member_key,
    name: row.name,
    firstName: row.first_name,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(row.territory === "idf" ? { territory: "idf" as const } : {}),
    active: row.active === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * Amorçage : la graine de `config.ts` n'est écrite que si la table est vide.
 * Un ré-amorçage n'écraserait jamais un choix fait dans l'interface.
 */
function seedIfEmpty(): void {
  const db = getDb();
  const { n } = db.prepare("SELECT count(*) AS n FROM team_member").get() as { n: number };
  if (n > 0) return;

  const inactive = new Set(TEAM_SEED_INACTIVE.map(normalizeKey));
  const insert = db.prepare(
    `INSERT INTO team_member (member_key, name, first_name, aliases, territory, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const member of TEAM) {
    insert.run(
      normalizeKey(member.name),
      member.name,
      member.firstName,
      JSON.stringify(member.aliases ?? []),
      member.territory ?? null,
      inactive.has(normalizeKey(member.name)) ? 0 : 1,
      now,
    );
  }
}

/** Version du périmètre en mémoire, pour ne relire la base qu'en cas de changement. */
let loadedRevision = -1;
let revision = 0;

/**
 * Charge le périmètre depuis la base et l'installe dans `normalize.ts`.
 *
 * À appeler au début de tout traitement serveur qui filtre sur l'équipe. Le
 * coût est celui d'une requête sur treize lignes, et la relecture est évitée
 * tant que rien n'a changé dans le processus.
 */
export function loadTeam(): readonly TeamMember[] {
  if (loadedRevision === revision) return activeTeamMembers();
  seedIfEmpty();
  const rows = getDb()
    .prepare("SELECT * FROM team_member WHERE active = 1 ORDER BY name")
    .all() as unknown as Row[];
  setActiveTeam(rows.map(toMember));
  loadedRevision = revision;
  return activeTeamMembers();
}

/** Tous les membres, actifs et retirés, pour l'écran de gestion. */
export function allTeamMembers(): TeamMemberRecord[] {
  seedIfEmpty();
  const rows = getDb()
    .prepare("SELECT * FROM team_member ORDER BY active DESC, name")
    .all() as unknown as Row[];
  return rows.map(toMember);
}

/**
 * Ajoute un commercial, ou réactive celui qui avait été retiré.
 *
 * Le nom vient de la liste des commerciaux vus dans les sources : c'est ce qui
 * évite les fautes, les variantes et les doublons.
 */
export function addTeamMember(input: {
  name: string;
  firstName?: string;
  territory?: TerritoryScope;
}): TeamMemberRecord {
  const name = input.name.trim();
  if (!name) throw new Error("Le nom du commercial est vide.");
  const key = normalizeKey(name);
  if (!key) throw new Error(`Nom de commercial inexploitable : « ${input.name} ».`);

  const db = getDb();
  seedIfEmpty();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT * FROM team_member WHERE member_key = ?")
    .get(key) as unknown as Row | undefined;

  if (existing) {
    // Réactivation : on ne réécrit ni le nom canonique ni les alias, qui ont pu
    // être affinés, et on ne perd donc rien de ce qui était configuré.
    db.prepare("UPDATE team_member SET active = 1, updated_at = ? WHERE member_key = ?").run(
      now,
      key,
    );
  } else {
    db.prepare(
      `INSERT INTO team_member (member_key, name, first_name, aliases, territory, active, updated_at)
       VALUES (?, ?, ?, '[]', ?, 1, ?)`,
    ).run(key, name, input.firstName?.trim() || defaultFirstName(name), input.territory ?? null, now);
  }

  revision++;
  loadTeam();
  const saved = db
    .prepare("SELECT * FROM team_member WHERE member_key = ?")
    .get(key) as unknown as Row;
  return toMember(saved);
}

/**
 * Retire un commercial du périmètre.
 *
 * SANS RIEN SUPPRIMER : la ligne reste, `active` passe à 0, et les données
 * Salesforce du commercial ne sont pas touchées. Le prochain import cessera
 * simplement de le retenir, et le réactiver le fera revenir.
 */
export function removeTeamMember(key: string): void {
  const db = getDb();
  seedIfEmpty();
  const changed = db
    .prepare("UPDATE team_member SET active = 0, updated_at = ? WHERE member_key = ?")
    .run(new Date().toISOString(), key);
  if (changed.changes === 0) throw new Error("Commercial inconnu dans le périmètre.");
  revision++;
  loadTeam();
}

/** Change la restriction territoriale d'un membre (« idf » ou aucune). */
export function setTeamMemberTerritory(key: string, territory: TerritoryScope): void {
  const db = getDb();
  seedIfEmpty();
  const changed = db
    .prepare("UPDATE team_member SET territory = ?, updated_at = ? WHERE member_key = ?")
    .run(territory, new Date().toISOString(), key);
  if (changed.changes === 0) throw new Error("Commercial inconnu dans le périmètre.");
  revision++;
  loadTeam();
}

/**
 * Enregistre les noms de commerciaux rencontrés dans une source.
 *
 * Appelé par les imports, avec TOUS les noms lus — y compris hors équipe. C'est
 * ce qui permet à l'écran d'équipe de proposer une liste au lieu d'une saisie
 * libre. Aucun de ces noms n'entre dans le périmètre du seul fait d'être vu.
 */
export function recordTeamCandidates(source: string, names: Iterable<string | null>): void {
  const db = getDb();
  const seen = new Map<string, string>();
  for (const raw of names) {
    const name = (raw ?? "").replace(/\s+/gu, " ").trim();
    if (!name) continue;
    const key = normalizeKey(name);
    if (key) seen.set(key, name);
  }
  if (seen.size === 0) return;

  const now = new Date().toISOString();
  const read = db.prepare("SELECT sources FROM team_candidate WHERE member_key = ?");
  const upsert = db.prepare(
    `INSERT INTO team_candidate (member_key, display_name, sources, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(member_key) DO UPDATE SET
       display_name = excluded.display_name,
       sources = excluded.sources,
       last_seen_at = excluded.last_seen_at`,
  );
  for (const [key, name] of seen) {
    const previous = read.get(key) as { sources: string } | undefined;
    const sources = new Set<string>(previous ? (JSON.parse(previous.sources) as string[]) : []);
    sources.add(source);
    upsert.run(key, name, JSON.stringify([...sources].sort()), now);
  }
}

/** Commerciaux proposables à l'ajout, les plus récemment vus d'abord. */
export function teamCandidates(): TeamCandidate[] {
  const db = getDb();
  seedIfEmpty();
  const known = new Set(
    (db.prepare("SELECT member_key FROM team_member").all() as unknown as { member_key: string }[])
      .map((r) => r.member_key),
  );
  const rows = db
    .prepare("SELECT * FROM team_candidate ORDER BY display_name")
    .all() as unknown as { member_key: string; display_name: string; sources: string; last_seen_at: string }[];
  return rows.map((r) => ({
    key: r.member_key,
    name: r.display_name,
    sources: JSON.parse(r.sources) as string[],
    lastSeenAt: r.last_seen_at,
    known: known.has(r.member_key),
  }));
}

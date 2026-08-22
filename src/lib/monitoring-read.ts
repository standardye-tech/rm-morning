/**
 * Monitoring — état de lecture, et détection de ce qui a changé depuis.
 *
 * LE BESOIN. Les listes du Monitoring ne se vident jamais : elles sont
 * reconstruites à chaque synchronisation depuis l'état Salesforce, si bien
 * qu'avoir tout traité ne produit aucun signe visible. Le travail ne finit
 * jamais, et une liste qui ne finit jamais cesse d'être lue.
 *
 * LE PRINCIPE, en une phrase : on ne mémorise pas « vu », on mémorise CE QUI
 * ÉTAIT VU. Chaque lecture enregistre une signature — la valeur des champs de
 * décision au moment du clic. À la synchronisation suivante, on recompare :
 *
 *   — signature identique  → l'élément reste masqué, rien n'a bougé ;
 *   — signature différente → il revient, et l'on sait DIRE lequel des champs a
 *     changé, avec l'ancienne et la nouvelle valeur ;
 *   — jamais lu            → il apparaît, comme aujourd'hui.
 *
 * Conséquence voulue : la liste peut réellement atteindre zéro, et elle ne
 * remonte que ce qui mérite un second regard. C'est la différence avec un
 * simple masquage à durée fixe, qui ferait soit tout revenir demain matin, soit
 * cacher une échéance qui vient de sauter de deux semaines.
 *
 * CE QUI N'ENTRE JAMAIS DANS LA SIGNATURE : toute grandeur qui bouge d'elle-même.
 * Une durée de retard augmente à chaque minute ; l'y inclure ferait clignoter la
 * liste entière en permanence et viderait le mécanisme de son sens.
 */

import { getDb } from "./db";
import type { StoredLead } from "./lead-store";
import { OPERATIONAL_LABEL } from "./lead-rules";
import { MILESTONE_LABEL, NEXT_EVENT_LABEL } from "./opportunity-milestones";
import type { MilestoneOpportunity } from "./opportunity-metrics";

export type MonitoringScope = "piste" | "opportunite";

export const SCOPE_LABEL: Record<MonitoringScope, string> = {
  piste: "pistes",
  opportunite: "opportunités",
};

/** Nature d'un champ suivi, pour le formater sans le deviner à l'affichage. */
export type FieldKind = "texte" | "date" | "mois" | "euros";

export type WatchedField = {
  key: string;
  label: string;
  kind: FieldKind;
  value: string | null;
};

export type FieldChange = {
  label: string;
  kind: FieldKind;
  before: string | null;
  after: string | null;
};

export type ReadStatus = "jamais_lu" | "modifie" | "lu";

export type ReadVerdict = {
  status: ReadStatus;
  readAt: string | null;
  changes: FieldChange[];
};

type ReadRow = { item_id: string; read_at: string; fingerprint: string };

// --- Signatures -----------------------------------------------------------

/**
 * Les champs d'une piste qui justifient de la relire.
 *
 * Statut, échéance, First Call, rendez-vous, consignation : ce sont exactement
 * les faits sur lesquels le manager décide d'appeler ou non le commercial. Le
 * nom et le canal n'y sont pas — ils identifient la piste, ils ne la font pas
 * changer d'état.
 */
export function leadFields(lead: StoredLead): WatchedField[] {
  return [
    { key: "statut", label: "Statut Salesforce", kind: "texte", value: lead.status },
    {
      key: "suivi",
      label: "État de suivi",
      kind: "texte",
      value: OPERATIONAL_LABEL[lead.operationalStatus] ?? lead.operationalStatus,
    },
    { key: "echeance", label: "Échéance de rappel", kind: "date", value: lead.recallDate },
    { key: "first_call", label: "First Call", kind: "date", value: lead.firstCallAt },
    { key: "rendez_vous", label: "Prochain rendez-vous", kind: "date", value: lead.nextAppointmentAt },
    { key: "consignation", label: "Consignation", kind: "date", value: lead.consignedAt },
    { key: "commercial", label: "Commercial", kind: "texte", value: lead.owner },
  ];
}

/**
 * Les champs d'une opportunité qui justifient de la relire.
 *
 * `mois_prevu` est la Projection Kanban : dans le vocabulaire de RM Morning,
 * c'est le mois où le commercial annonce la signature. C'est l'équivalent local
 * de la Close Date, et le champ dont le glissement doit sauter aux yeux.
 */
export function opportunityFields(o: MilestoneOpportunity): WatchedField[] {
  return [
    { key: "etape", label: "Étape", kind: "texte", value: o.stage },
    { key: "gmv", label: "GMV", kind: "euros", value: o.gmv == null ? null : String(o.gmv) },
    {
      key: "mois_prevu",
      label: "Mois de signature prévu",
      kind: "mois",
      value: o.plannedMonth,
    },
    {
      key: "suivi",
      label: "État de suivi",
      kind: "texte",
      value: MILESTONE_LABEL[o.milestoneStatus] ?? o.milestoneStatus,
    },
    {
      key: "prochain_jalon",
      label: "Prochain jalon",
      kind: "texte",
      value: o.nextExpectedEvent ? (NEXT_EVENT_LABEL[o.nextExpectedEvent] ?? o.nextExpectedEvent) : null,
    },
    { key: "echeance_jalon", label: "Échéance du jalon", kind: "date", value: o.nextExpectedDueAt },
    { key: "standby", label: "Stand-by jusqu'au", kind: "date", value: o.standbyUntil },
    {
      key: "client_attend",
      label: "Client en attente",
      kind: "texte",
      value: o.clientWaiting ? "oui" : "non",
    },
    { key: "commercial", label: "Commercial", kind: "texte", value: o.owner },
  ];
}

function toFingerprint(fields: WatchedField[]): Record<string, string | null> {
  return Object.fromEntries(fields.map((f) => [f.key, f.value]));
}

// --- Persistance ----------------------------------------------------------

function loadRead(scope: MonitoringScope): Map<string, { readAt: string; fingerprint: Record<string, string | null> }> {
  const rows = getDb()
    .prepare("SELECT item_id, read_at, fingerprint FROM monitoring_read WHERE scope = ?")
    .all(scope) as ReadRow[];
  const map = new Map<string, { readAt: string; fingerprint: Record<string, string | null> }>();
  for (const r of rows) {
    let parsed: Record<string, string | null> = {};
    try {
      const v = JSON.parse(r.fingerprint) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsed = v as Record<string, string | null>;
      }
    } catch {
      // Signature illisible : l'élément est traité comme jamais lu. Une donnée
      // de confort corrompue ne doit pas faire disparaître une alerte.
    }
    map.set(r.item_id, { readAt: r.read_at, fingerprint: parsed });
  }
  return map;
}

/**
 * Compare la liste courante au dernier état lu.
 *
 * Renvoie un verdict par élément, dans l'ordre reçu. Aucune écriture : la
 * lecture d'un écran ne doit jamais modifier l'état de lecture, sinon le simple
 * fait d'ouvrir la page ferait disparaître ce qu'on n'a pas encore traité.
 */
export function compareWithRead(
  scope: MonitoringScope,
  items: { id: string; fields: WatchedField[] }[],
): Map<string, ReadVerdict> {
  const read = loadRead(scope);
  const out = new Map<string, ReadVerdict>();

  for (const item of items) {
    const before = read.get(item.id);
    if (!before) {
      out.set(item.id, { status: "jamais_lu", readAt: null, changes: [] });
      continue;
    }
    const changes: FieldChange[] = [];
    for (const field of item.fields) {
      // Un champ que la signature ne connaît pas encore — parce qu'il a été
      // ajouté depuis la dernière lecture — n'est pas une modification : on ne
      // peut pas prétendre qu'il a changé si on ne l'observait pas.
      if (!(field.key in before.fingerprint)) continue;
      const was = before.fingerprint[field.key] ?? null;
      if (was === (field.value ?? null)) continue;
      changes.push({ label: field.label, kind: field.kind, before: was, after: field.value ?? null });
    }
    out.set(item.id, {
      status: changes.length > 0 ? "modifie" : "lu",
      readAt: before.readAt,
      changes,
    });
  }
  return out;
}

/**
 * Enregistre que tout ce qui est passé en argument vient d'être lu.
 *
 * L'appelant fournit la liste EXACTE qu'il affiche, avec ses signatures : c'est
 * la seule façon de garantir que « Tout lire » porte sur ce que l'utilisateur a
 * eu sous les yeux, et pas sur un périmètre recalculé différemment.
 */
export function markAllRead(
  scope: MonitoringScope,
  items: { id: string; fields: WatchedField[] }[],
  now = new Date(),
): number {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO monitoring_read (scope, item_id, read_at, fingerprint) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, item_id) DO UPDATE SET
       read_at = excluded.read_at, fingerprint = excluded.fingerprint`,
  );
  const iso = now.toISOString();
  db.exec("BEGIN");
  try {
    for (const item of items) {
      upsert.run(scope, item.id, iso, JSON.stringify(toFingerprint(item.fields)));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return items.length;
}

/** Dernière lecture d'un périmètre, pour l'annoncer à l'écran. */
export function lastReadAt(scope: MonitoringScope): string | null {
  const row = getDb()
    .prepare("SELECT MAX(read_at) AS at FROM monitoring_read WHERE scope = ?")
    .get(scope) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** Remet un périmètre à l'état non lu. Utilisé par les contrôles, jamais par l'UI. */
export function resetRead(scope: MonitoringScope): number {
  const r = getDb().prepare("DELETE FROM monitoring_read WHERE scope = ?").run(scope);
  return Number(r.changes);
}

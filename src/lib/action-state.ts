/**
 * État utilisateur partagé des actions — LA source de vérité de « traité ».
 *
 * Morning, Monitoring et Ma semaine ne possèdent plus chacune leur vérité : elles
 * consultent toutes ce module, par ActionKey (`action-keys.ts`). Traiter une
 * action ici la fait disparaître de TOUTES les surfaces qui montrent cette même
 * clé ; la rétablir la rouvre partout où son signal métier existe encore — elle
 * n'est jamais recréée si la donnée source ne la produit plus.
 *
 * DEUX STOCKAGES, UNE SEULE API :
 *   — `mail:…` → `morning_event.status`, déjà tenu message par message (un
 *     message = un événement) ;
 *   — tout le reste → `action_state`.
 *
 * État utilisateur ≠ réalité métier : rien ici ne touche une donnée source. Une
 * attente client acquittée reste une attente dans `canonicalClientAttend` ;
 * une anomalie Salesforce acquittée reste une anomalie. Et une LECTURE
 * (`monitoring_read`) n'est jamais un traitement.
 */

import { parisDate } from "./business-time";
import { getDb } from "./db";
import { actionSource, mailMessageId } from "./action-keys";

/** Où le geste a été fait — traçabilité seulement, jamais un critère. */
export type ActionSurface =
  | "morning_bloc1"
  | "morning_bloc2"
  | "plan"
  | "monitoring_piste"
  | "monitoring_opportunite"
  | "semaine";

export type TreatInput = { key: string; surface: ActionSurface; owner?: string | null; label?: string | null };

type StateRow = { action_key: string; status: string; treated_at: string | null };

/** Marque une action traitée. Renvoie vrai si l'état a changé. */
export function treatAction(input: TreatInput, now = new Date()): boolean {
  const source = actionSource(input.key);
  if (!source) return false;
  const db = getDb();
  const iso = now.toISOString();
  if (source === "mail") {
    const id = mailMessageId(input.key);
    if (!id) return false;
    const r = db
      .prepare(
        "UPDATE morning_event SET status = 'pris_en_compte', acknowledged_at = ? WHERE gmail_message_id = ? AND status <> 'pris_en_compte'",
      )
      .run(iso, id);
    return Number(r.changes) > 0;
  }
  const r = db
    .prepare(
      `INSERT INTO action_state (action_key, source_type, status, surface, owner, label, treated_at, restored_at, updated_at)
       VALUES (?, ?, 'traite', ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(action_key) DO UPDATE SET
         status = 'traite', surface = excluded.surface,
         owner = COALESCE(excluded.owner, action_state.owner),
         label = COALESCE(excluded.label, action_state.label),
         treated_at = excluded.treated_at, restored_at = NULL, updated_at = excluded.updated_at
       WHERE action_state.status <> 'traite'`,
    )
    .run(input.key, source, input.surface, input.owner ?? null, input.label ?? null, iso, iso);
  return Number(r.changes) > 0;
}

/**
 * Rouvre une action. Elle ne réapparaît que là où sa donnée source la produit
 * encore : rien n'est recréé ici.
 */
export function restoreAction(key: string, now = new Date()): boolean {
  const source = actionSource(key);
  if (!source) return false;
  const db = getDb();
  if (source === "mail") {
    const id = mailMessageId(key);
    if (!id) return false;
    const r = db
      .prepare(
        "UPDATE morning_event SET status = 'nouveau', acknowledged_at = NULL WHERE gmail_message_id = ? AND status = 'pris_en_compte'",
      )
      .run(id);
    return Number(r.changes) > 0;
  }
  const iso = now.toISOString();
  const r = db
    .prepare(
      "UPDATE action_state SET status = 'ouvert', restored_at = ?, updated_at = ? WHERE action_key = ? AND status = 'traite'",
    )
    .run(iso, iso, key);
  return Number(r.changes) > 0;
}

/**
 * Parmi `keys`, celles qui sont traitées, avec la date du geste. Une clé
 * inconnue est ouverte : l'absence d'état ne ferme jamais une action.
 */
export function treatedActions(keys: Iterable<string>): Map<string, string | null> {
  const wanted = [...new Set(keys)];
  const out = new Map<string, string | null>();
  if (wanted.length === 0) return out;
  const db = getDb();

  const mailIds = new Map<string, string>();
  const others: string[] = [];
  for (const k of wanted) {
    const source = actionSource(k);
    if (source === "mail") {
      const id = mailMessageId(k);
      if (id) mailIds.set(id, k);
    } else if (source) others.push(k);
  }

  if (mailIds.size > 0) {
    const rows = db
      .prepare("SELECT gmail_message_id AS id, acknowledged_at FROM morning_event WHERE status = 'pris_en_compte'")
      .all() as { id: string; acknowledged_at: string | null }[];
    for (const r of rows) {
      const k = mailIds.get(r.id);
      if (k) out.set(k, r.acknowledged_at);
    }
  }
  if (others.length > 0) {
    const want = new Set(others);
    const rows = db
      .prepare("SELECT action_key, status, treated_at FROM action_state WHERE status = 'traite'")
      .all() as StateRow[];
    for (const r of rows) if (want.has(r.action_key)) out.set(r.action_key, r.treated_at);
  }
  return out;
}

/** Actions d'une source traitées pendant le jour métier `now` (heure de Paris). */
export function actionsTreatedOn(source: "plan" | "opportunity" | "lead", now = new Date()): Set<string> {
  const day = parisDate(now);
  // Fenêtre large en UTC, puis filtre exact sur le jour de Paris.
  const from = new Date(now.getTime() - 2 * 864e5).toISOString();
  const rows = getDb()
    .prepare(
      "SELECT action_key, status, treated_at FROM action_state WHERE status = 'traite' AND source_type = ? AND treated_at >= ?",
    )
    .all(source, from) as StateRow[];
  return new Set(rows.filter((r) => r.treated_at && parisDate(new Date(r.treated_at)) === day).map((r) => r.action_key));
}

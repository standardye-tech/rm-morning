/**
 * GMV signé OFFICIEL — source unique de l'application.
 *
 * Définition arrêtée à l'audit C10, reproduite à l'euro depuis le rapport de
 * pilotage du directeur régional :
 *
 *   — objet `Travaux__c` (table locale `travaux`) ;
 *   — `Date_de_signature_du_devis__c` dans le mois demandé ;
 *   — `Statut_travaux__c` ∈ { Signé, Réalisé } ;
 *   — propriétaire de l'opportunité dans l'équipe suivie ;
 *   — somme de `Montant__c`, avenants, moins-values et annulations comprises,
 *     montants négatifs inclus.
 *
 * CE QUI N'EST PAS CETTE MESURE : la transition `OpportunityHistory` vers
 * « Signé ». Elle date un ÉVÉNEMENT commercial et reste la cible d'apprentissage
 * d'Expected ; elle ne chiffre pas un GMV. Confondre les deux produisait un écart
 * de 61 615 € sur août 2026.
 */

import { TRAVAUX } from "./config";
import { getDb } from "./db";
import { matchTeamMember } from "./normalize";

export type OfficialSignedLine = {
  travauxId: string;
  opportunityId: string | null;
  client: string | null;
  salesperson: string | null;
  signatureDate: string;
  gmv: number;
  worksType: string | null;
  worksStatus: string | null;
};

export type OfficialSigned = {
  month: string;
  gmv: number;
  lines: number;
  /** Détail par nature, pour rendre les avenants et annulations visibles. */
  byType: { worksType: string; lines: number; gmv: number }[];
  bySalesperson: { salesperson: string; lines: number; gmv: number }[];
  /** Opportunités distinctes concernées. */
  opportunities: number;
  rows: OfficialSignedLine[];
};

type Row = {
  travaux_id: string;
  opportunity_id: string | null;
  opportunity_name: string | null;
  owner_raw: string | null;
  signature_date: string;
  gmv: number | null;
  works_type: string | null;
  works_status: string | null;
};

/**
 * GMV signé officiel d'un mois « AAAA-MM ».
 *
 * Le filtre d'équipe passe par `matchTeamMember`, seule table d'alias de
 * l'application : le propriétaire est porté par la ligne Travaux sous forme de
 * texte, avec les mêmes variantes de casse que partout ailleurs.
 */
export function officialSignedGmv(month: string): OfficialSigned {
  const db = getDb();
  const statuses = TRAVAUX.signedStatuses;
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT travaux_id, opportunity_id, opportunity_name, owner_raw, signature_date,
              gmv, works_type, works_status
         FROM travaux
        WHERE substr(signature_date, 1, 7) = ?
          AND works_status IN (${placeholders})
        ORDER BY signature_date, opportunity_name`,
    )
    .all(month, ...statuses) as Row[];

  const kept: OfficialSignedLine[] = [];
  for (const r of rows) {
    const member = matchTeamMember(r.owner_raw);
    if (!member) continue;
    kept.push({
      travauxId: r.travaux_id,
      opportunityId: r.opportunity_id,
      client: r.opportunity_name,
      salesperson: member.name,
      signatureDate: r.signature_date,
      gmv: r.gmv ?? 0,
      worksType: r.works_type,
      worksStatus: r.works_status,
    });
  }

  const group = <K extends string>(key: (l: OfficialSignedLine) => K) => {
    const m = new Map<K, { lines: number; gmv: number }>();
    for (const l of kept) {
      const k = key(l);
      const cur = m.get(k) ?? { lines: 0, gmv: 0 };
      m.set(k, { lines: cur.lines + 1, gmv: cur.gmv + l.gmv });
    }
    return m;
  };

  return {
    month,
    gmv: kept.reduce((t, l) => t + l.gmv, 0),
    lines: kept.length,
    byType: [...group((l) => l.worksType ?? "(sans type)")]
      .map(([worksType, v]) => ({ worksType, ...v }))
      .sort((a, b) => b.gmv - a.gmv),
    bySalesperson: [...group((l) => l.salesperson ?? "(inconnu)")]
      .map(([salesperson, v]) => ({ salesperson, ...v }))
      .sort((a, b) => b.gmv - a.gmv),
    opportunities: new Set(kept.map((l) => l.opportunityId).filter(Boolean)).size,
    rows: kept,
  };
}

/**
 * Repère historique mensuel, sur la définition officielle.
 *
 * Remplace le repère construit sur les signatures Opportunity. Le mois courant
 * est exclu — il est en cours — et les mois manifestement partiels du début de
 * la fenêtre importée sont écartés.
 */
/**
 * Repère historique mensuel, mesuré sur la source OFFICIELLE.
 *
 * Le type vivait dans `historical-reference.ts`, dont la fonction jumelle
 * mesurait l'ancienne vérité (transitions d'opportunités). C10 l'a remplacée par
 * la somme des lignes Travaux ; la fonction n'était plus appelée nulle part et a
 * été supprimée à l'audit V1. Seul ce chemin subsiste.
 */
export type HistoricalReference = {
  /** Moyenne mensuelle sur les mois complets retenus. */
  monthlyAverage: number;
  /** Mois complets effectivement mesurés. */
  months: number;
  /** Plus petit et plus grand mois observés, pour dire l'amplitude réelle. */
  min: number;
  max: number;
  from: string;
  to: string;
};

export function officialMonthlyReference(
  months = 24,
  now = new Date(),
): HistoricalReference | null {
  const db = getDb();
  const statuses = TRAVAUX.signedStatuses;
  const placeholders = statuses.map(() => "?").join(", ");
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Le filtre d'équipe se fait en mémoire, comme ci-dessus : la table d'alias
  // n'est pas exprimable en SQL sans la dupliquer.
  const rows = db
    .prepare(
      `SELECT substr(signature_date, 1, 7) month, owner_raw, gmv
         FROM travaux
        WHERE works_status IN (${placeholders})
          AND substr(signature_date, 1, 7) < ?`,
    )
    .all(...statuses, currentMonth) as { month: string; owner_raw: string | null; gmv: number | null }[];

  const perMonth = new Map<string, number>();
  for (const r of rows) {
    if (!matchTeamMember(r.owner_raw)) continue;
    perMonth.set(r.month, (perMonth.get(r.month) ?? 0) + (r.gmv ?? 0));
  }
  const entries = [...perMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, months);
  if (entries.length === 0) return null;

  const values = entries.map(([, v]) => v);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const kept = entries.filter(([, v]) => v >= median * 0.2);
  if (kept.length === 0) return null;
  const keptValues = kept.map(([, v]) => v);

  return {
    monthlyAverage: keptValues.reduce((t, v) => t + v, 0) / keptValues.length,
    months: kept.length,
    min: Math.min(...keptValues),
    max: Math.max(...keptValues),
    from: kept[kept.length - 1][0],
    to: kept[0][0],
  };
}

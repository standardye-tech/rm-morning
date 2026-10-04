/**
 * Monitoring — libellés des en-têtes de liste et du geste de lecture.
 *
 * PUR, sans base : importable par les composants client et contrôlable par les
 * harnais. Les accords suivent la règle française (0 et 1 au singulier). Le
 * geste de lecture dit ce qu'il fait — marquer comme lu — et rien de plus :
 * lire n'est jamais traiter.
 */

export type MonitoringNoun = "piste" | "opportunite";

const NOUN: Record<MonitoringNoun, [string, string]> = {
  piste: ["piste", "pistes"],
  opportunite: ["opportunité", "opportunités"],
};

const many = (n: number) => n > 1;
const agree = (n: number, one: string, other: string) => `${n} ${many(n) ? other : one}`;

/**
 * « 8 pistes à traiter · 3 mises à jour depuis votre dernière lecture · 23 déjà
 * lues · 2 traitées ». Les morceaux à zéro disparaissent, sauf le premier.
 */
export function monitoringSummary(
  noun: MonitoringNoun,
  s: { visibleCount: number; changedCount: number; readCount: number; treatedCount: number },
): string {
  const [one, other] = NOUN[noun];
  return [
    `${agree(s.visibleCount, one, other)} à traiter`,
    s.changedCount > 0 ? `${agree(s.changedCount, "mise à jour", "mises à jour")} depuis votre dernière lecture` : null,
    s.readCount > 0 ? agree(s.readCount, "déjà lue", "déjà lues") : null,
    s.treatedCount > 0 ? agree(s.treatedCount, "traitée", "traitées") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** « Marquer les 13 comme lues » ; une seule : « Marquer la dernière comme lue ». */
export function markReadLabel(unread: number): string {
  return many(unread) ? `Marquer les ${unread} comme lues` : "Marquer la dernière comme lue";
}

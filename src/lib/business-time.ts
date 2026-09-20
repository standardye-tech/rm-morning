/**
 * Temps métier de RM Morning : une seule horloge, un seul mois.
 *
 * Le fuseau métier est Europe/Paris et la clé de mois canonique est « AAAA-MM ».
 * Avant ce module, le « mois courant » était déterminé de quatre façons — date du
 * dernier import, horloge locale du processus, UTC, mois scoré par le modèle —
 * et deux pages pouvaient donc afficher deux mois différents au même instant,
 * notamment entre minuit et 2 h heure de Paris (la machine de production tourne
 * en UTC) et le lendemain d'un import de fin de mois.
 *
 * Module PUR : aucune dépendance base, aucun réseau. Tout ce qui répond à « quel
 * jour, quel mois sommes-nous ? » passe ici, avec un `now` injectable pour les
 * tests.
 *
 * Ce que ce module ne fait PAS : le mois d'un jeu de données (`snap.month` du
 * scoring Python, `kanbanMonth` d'une affaire) reste une propriété de la donnée.
 * On le compare au mois métier, on ne le remplace pas.
 */

export const BUSINESS_TIMEZONE = "Europe/Paris";

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Jour métier « AAAA-MM-JJ » de l'instant `now`, à l'heure de Paris. */
export function parisDate(now: Date = new Date()): string {
  const p = Object.fromEntries(PARTS.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Ajoute `offset` mois (négatif accepté) à une clé « AAAA-MM ». Pur, sans fuseau. */
export function shiftBusinessMonth(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + offset;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/**
 * Mois métier « AAAA-MM » : M (offset 0), M+1 (offset 1), M+2 (offset 2)…
 * Toujours dérivé du jour de Paris, jamais de la date d'un import.
 */
export function businessMonth(now: Date = new Date(), offset = 0): string {
  return shiftBusinessMonth(parisDate(now).slice(0, 7), offset);
}

/** Les mois de l'année civile en cours (Paris), de janvier au mois courant inclus. */
export function businessYearToDateMonths(now: Date = new Date()): string[] {
  const [year, month] = parisDate(now).slice(0, 7).split("-").map(Number);
  return Array.from({ length: month }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/** Jour de la semaine à Paris, lundi = 1 … dimanche = 7. */
export function parisWeekday(now: Date = new Date()): number {
  const [y, m, d] = parisDate(now).split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

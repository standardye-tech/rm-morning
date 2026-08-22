/**
 * Performance commerciale — le classement analytique de l'équipe.
 *
 * CE QUE CE N'EST PAS : un classement au GMV. Le commercial à qui l'on confie
 * les plus gros dossiers serait premier tous les mois, et le classement
 * n'apprendrait rien à personne. Quatre piliers mesurent quatre choses
 * différentes — ce qu'il produit, comment il traite ses pistes, comment il tient
 * ses affaires, ce que vaut son pipe futur — et aucun ne peut à lui seul faire
 * le classement.
 *
 * NORMALISATION, en deux familles et deux seulement :
 *
 *   — RANG DANS L'ÉQUIPE (percentile) pour les grandeurs de volume : GMV signé,
 *     nombre d'affaires, Expected. Il n'existe aucun barème absolu pour dire ce
 *     qu'est « un bon GMV » sur un mois donné ; la seule référence honnête est
 *     ce que font les douze autres, sur les mêmes semaines et le même marché.
 *
 *   — TAUX BORNÉ pour les grandeurs de qualité : part d'anomalies, part de
 *     dossiers stagnants, délai de prise en charge. Là un barème existe et il
 *     est défendable — zéro anomalie vaut mieux que d'être le moins mauvais
 *     d'une équipe qui en a partout.
 *
 * Conséquence assumée : les sous-scores de volume se répartissent toujours entre
 * 0 et le maximum, même une excellente semaine collective. Le classement dit qui
 * fait mieux que les autres ; il ne dit pas si l'équipe va bien — c'est le rôle
 * de Forecast et d'Expected GMV.
 *
 * DÉTERMINISME. Aucun aléa, aucun appel à un modèle de langage. À données
 * identiques, le score, le rang et le commentaire sont identiques. Les
 * commentaires sont composés à partir des mesures effectivement calculées : une
 * phrase ne peut pas exister sans le chiffre qui la soutient.
 *
 * CE QUI N'EST PAS MESURÉ, et pourquoi :
 *
 *   — le taux d'abandon des opportunités. Une affaire abandonnée disparaît
 *     simplement de la source Salesforce : jusqu'au rapprochement des
 *     disparitions, rien ne permettait de la dater. La colonne `absent_since`
 *     l'ouvre désormais, mais son historique commence aujourd'hui — il n'y a
 *     donc rien à mesurer rétroactivement, et une part d'abandons calculée sur
 *     quelques jours serait un artefact ;
 *   — la réactivité client. Voir la note du cinquième pilier dans `config`.
 *
 * AJOUTER UN CINQUIÈME PILIER — « Réactivité », le jour où la mesure Gmail sera
 * fiable — se fait en quatre gestes et sans toucher au moteur :
 *
 *   1. ajouter sa clé à `PillarKey` et son libellé à `PILLAR_LABEL` ;
 *   2. ajouter son poids à `PERFORMANCE.weights`, en rééquilibrant les autres
 *      pour que la somme reste 100 — le garde-fou ci-dessous refuse de démarrer
 *      sinon ;
 *   3. ajouter ses mesures à `METRICS`, avec leur barème et leurs deux phrases ;
 *   4. les alimenter dans `collectRawMetrics`.
 *
 * Le calcul, le classement, l'historique, le détail par commercial et les
 * commentaires suivent d'eux-mêmes : il n'existe nulle part de seconde liste de
 * piliers ni de seconde liste de mesures.
 */

import { PERFORMANCE, PERFORMANCE_MODEL_VERSION, TEAM } from "./config";
import { buildExpectedGmvSnapshot } from "./expected-gmv-live";
import { buildExpectedM1 } from "./expected-m1";
import { monthKey, shiftMonth, monthLabel } from "./forecast-board";
import { loadLeads } from "./lead-store";
import { officialSignedGmv } from "./official-signed";
import { loadMilestoneOpportunities } from "./opportunity-metrics";
import { MILESTONE_ANOMALIES } from "./opportunity-milestones";
import { loadOpportunities } from "./repository";
import { formatEurShort } from "./normalize";

// --- Contrat des piliers ---------------------------------------------------

export type PillarKey = "signed" | "leads" | "deals" | "pipeline";

export const PILLAR_LABEL: Record<PillarKey, string> = {
  signed: "Production signée",
  leads: "Traitement des pistes",
  deals: "Gestion des opportunités",
  pipeline: "Qualité du pipeline futur",
};

/**
 * Une mesure élémentaire, avec tout ce qu'il faut pour l'expliquer.
 *
 * `strong` et `weak` sont des phrases FACTUELLES : elles reprennent la valeur
 * mesurée, jamais une appréciation. C'est ce qui rend le commentaire
 * automatique vérifiable — on peut toujours remonter au chiffre.
 */
type MetricSpec = {
  key: string;
  label: string;
  pillar: PillarKey;
  weight: number;
  /** « rang » = percentile dans l'équipe ; « taux » = barème absolu borné. */
  scale: "rang" | "taux";
  format: (value: number | null) => string;
  strong: (display: string) => string;
  weak: (display: string) => string;
};

export type MetricResult = {
  key: string;
  label: string;
  pillar: PillarKey;
  weight: number;
  scale: "rang" | "taux";
  /** Valeur brute mesurée. Nulle quand la donnée n'existe pas pour ce commercial. */
  value: number | null;
  display: string;
  /**
   * La valeur telle qu'elle entre dans une PHRASE.
   *
   * Distincte de `display` pour une seule mesure aujourd'hui : le taux
   * d'affaires probables s'affiche « 2 / 5 affaires ≥ 25 % · 40 % » dans le
   * tableau, où le comptage est l'assise du chiffre, mais une phrase qui le
   * reprend tel quel se répète — « 1 / 34 affaires ≥ 25 % · 3 % de son pipe à
   * plus de 25 % de chance de signer ». Le tableau montre, la phrase dit.
   */
  phrase: string;
  /** Valeur ramenée à [0, 1]. */
  normalized: number;
  points: number;
  /**
   * Faux quand la donnée n'existe pas pour ce commercial. La mesure reçoit alors
   * la moitié de son poids — position neutre, qui ne peut ni le faire gagner ni
   * le faire perdre des places — et elle est exclue des points forts comme des
   * points de vigilance. Toujours annoncé à l'écran.
   */
  measured: boolean;
  /** Dénominateur de la mesure, quand c'en est un taux. Nul sinon. */
  sample: number | null;
  /**
   * Le dénominateur, dit en français. Affiché à côté de la valeur dans le
   * détail, jamais dans les phrases : « 43 % sur 53 de son pipe sans mouvement »
   * ne se lit pas. Une phrase porte la mesure, le tableau porte l'assise.
   */
  sampleText: string | null;
  /**
   * Valeur effectivement notée. Elle diffère de `value` pour les taux calculés
   * sur peu de dossiers, tirés vers le taux de l'équipe : le score est alors
   * prudent, tandis que la valeur affichée reste la mesure réelle.
   *
   * Sans objet lorsque la mesure est absente : la note ne vient alors d'aucune
   * valeur, mais de la règle de neutralité (moitié du poids).
   */
  scored: number;
};

export type PillarResult = {
  key: PillarKey;
  label: string;
  weight: number;
  points: number;
  /** Points ramenés sur 100, pour comparer les piliers entre eux. */
  outOf100: number;
  metrics: MetricResult[];
};

export type PerformanceRow = {
  salesperson: string;
  firstName: string;
  rank: number;
  score: number;
  pillars: Record<PillarKey, PillarResult>;
  /** Écart de rang depuis la photo précédente. Positif = a gagné des places. */
  rankChange: number | null;
  previousRank: number | null;
  /** Trajectoire de production sur 3 mois, indépendante du rang. */
  dynamic: DynamicScore;
  /**
   * Profondeur d'historique réellement observée cette année.
   *
   * N'ENTRE DANS AUCUN CALCUL. Le score n'est pas corrigé de l'ancienneté : un
   * commercial arrivé en juin a moins de GMV cumulé, et c'est un fait, pas un
   * biais à compenser. Mais le lecteur doit pouvoir le savoir avant de conclure.
   */
  history: { firstMonth: string | null; monthsObserved: number; ytdMonths: number };
  strengths: Explanation[];
  watch: Explanation[];
  /** Commentaire court, composé de faits mesurés. */
  comment: string;
};

/**
 * Une phrase d'explication, avec la mesure dont elle sort.
 *
 * La clé n'est pas décorative : elle rend le commentaire VÉRIFIABLE par un
 * contrôle automatique. Sans elle, on ne peut rapprocher une phrase de son
 * chiffre que par comparaison de texte — et « 0 % » est produit par cinq mesures
 * différentes, ce qui rend le rapprochement ambigu au moment précis où il
 * faudrait être certain de la source.
 */
export type Explanation = { key: string; text: string };

export type PerformanceBoard = {
  computedAt: string;
  /** Version du modèle ayant produit ces scores. */
  modelVersion: string;
  /** Mois de référence de la production signée : l'année civile en cours. */
  months: string[];
  monthsLabel: string;
  salespeople: PerformanceRow[];
  /** Date de la photo à laquelle les rangs sont comparés. Même version seulement. */
  comparedTo: string | null;
  /** Les plus fortes progressions et dégradations de production sur 3 mois. */
  movers: { up: PerformanceRow[]; down: PerformanceRow[] };
  notes: string[];
};

// --- Outils de normalisation ----------------------------------------------

/**
 * Rang dans l'équipe, ramené à [0, 1].
 *
 * Part des coéquipiers STRICTEMENT en dessous. Deux commerciaux à égalité
 * obtiennent donc la même note — indispensable au déterminisme du classement,
 * et juste : rien ne les départage.
 */
function percentile(value: number, all: number[]): number {
  if (all.length <= 1) return 1;
  const below = all.filter((v) => v < value).length;
  return below / (all.length - 1);
}

/** Taux ramené à [0, 1] entre deux bornes. `best` peut être au-dessus de `worst`. */
function scale01(value: number, best: number, worst: number): number {
  if (best === worst) return 1;
  const raw = (value - worst) / (best - worst);
  return Math.min(1, Math.max(0, raw));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const pctText = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} %`);
const countText = (v: number | null) => (v == null ? "—" : `${Math.round(v)}`);
const eurText = (v: number | null) => (v == null ? "—" : formatEurShort(v));
const hoursText = (v: number | null) =>
  v == null ? "—" : v < 48 ? `${Math.round(v)} h` : `${Math.round(v / 24)} j`;

// --- Définition des mesures ------------------------------------------------
//
// L'ordre est celui de la lecture, et les poids sont ceux de `config`. Toute
// mesure ajoutée ici entre automatiquement dans le score, dans le détail du
// commercial et dans les explications : il n'existe pas de seconde liste.

const METRICS: MetricSpec[] = [
  // --- Pilier 1 : production signée (30) ---------------------------------
  {
    key: "signed_gmv",
    label: "GMV signée sur la période",
    pillar: "signed",
    weight: 12,
    scale: "rang",
    format: eurText,
    strong: (d) => `${d} de GMV signée sur la période`,
    weak: (d) => `seulement ${d} de GMV signée sur la période`,
  },
  {
    key: "signed_deals",
    label: "Affaires signées",
    pillar: "signed",
    weight: 6,
    scale: "rang",
    format: countText,
    strong: (d) => `${d} affaires signées`,
    weak: (d) => `${d} affaire(s) signée(s) seulement`,
  },
  {
    key: "signed_yield",
    label: "Rendement du portefeuille",
    pillar: "signed",
    weight: 7,
    scale: "rang",
    format: pctText,
    strong: (d) => `${d} de son portefeuille transformé en signature`,
    weak: (d) => `seulement ${d} de son portefeuille transformé en signature`,
  },
  {
    key: "signed_regularity",
    label: "Régularité",
    pillar: "signed",
    weight: 5,
    scale: "taux",
    format: pctText,
    strong: (d) => `signe régulièrement (${d} des mois de la période)`,
    weak: (d) => `production irrégulière (${d} des mois de la période)`,
  },

  // --- Pilier 2 : traitement des pistes (20) -----------------------------
  {
    key: "lead_first_call",
    label: "Délai de prise en charge",
    pillar: "leads",
    weight: 6,
    scale: "taux",
    format: hoursText,
    strong: (d) => `prend ses pistes en charge en ${d}`,
    weak: (d) => `met ${d} à prendre ses pistes en charge`,
  },
  {
    key: "lead_anomaly_rate",
    label: "Pistes en anomalie",
    pillar: "leads",
    weight: 6,
    scale: "taux",
    format: pctText,
    strong: (d) => `pistes tenues à jour (${d} en anomalie)`,
    weak: (d) => `${d} de ses pistes ouvertes en anomalie`,
  },
  {
    key: "lead_missed_calls",
    label: "First Calls sans consignation",
    pillar: "leads",
    weight: 3,
    scale: "taux",
    format: pctText,
    strong: (d) => `First Calls consignés (${d} de manquants)`,
    weak: (d) => `${d} de First Calls passés sans consignation`,
  },
  {
    key: "lead_conversion",
    label: "Conversion piste → opportunité",
    pillar: "leads",
    weight: 5,
    scale: "rang",
    format: pctText,
    strong: (d) => `${d} de ses pistes converties en opportunité`,
    weak: (d) => `seulement ${d} de ses pistes converties en opportunité`,
  },

  // --- Pilier 3 : gestion des opportunités (20) --------------------------
  {
    key: "deal_hygiene",
    label: "Jalons tenus",
    pillar: "deals",
    weight: 8,
    scale: "taux",
    format: pctText,
    strong: (d) => `jalons tenus sur son pipe (${d} en exception de suivi)`,
    weak: (d) => `${d} de ses affaires en exception de suivi`,
  },
  {
    key: "deal_stagnation",
    label: "Affaires sans mouvement",
    pillar: "deals",
    weight: 8,
    scale: "taux",
    format: pctText,
    strong: (d) => `pipe vivant (${d} sans mouvement depuis plus de 45 jours)`,
    weak: (d) => `${d} de son pipe sans mouvement depuis plus de 45 jours`,
  },
  // `deal_overdue_month` — « mois de signature annoncé déjà passé » — a été
  // RETIRÉE à la calibration V1. Mesurée sur les données réelles, elle valait
  // 0 % pour les treize commerciaux : aucune opportunité active ne porte de
  // Projection Kanban antérieure au mois courant, parce que le commercial
  // repousse le mois plutôt que de le laisser expirer. Quatre points étaient
  // donc attribués à tout le monde, ce qui ne classe personne et dilue les
  // mesures qui, elles, discriminent. Ses points sont redistribués aux trois
  // autres mesures du pilier, qui reste à 20.
  {
    key: "deal_client_waiting",
    label: "Clients en attente",
    pillar: "deals",
    weight: 4,
    scale: "taux",
    format: pctText,
    strong: (d) => `clients sans attente de réponse (${d})`,
    weak: (d) => `${d} de ses clients en attente d'une réponse`,
  },

  // --- Pilier 4 : qualité du pipeline futur (30) -------------------------
  //
  // Pondération rééquilibrée à la calibration V1. Les deux mesures de VOLUME
  // — Expected du mois et pipe M+1 — pesaient 20 des 30 points, et leur rang
  // dans l'équipe suivait la taille du portefeuille confié (corrélation de rang
  // mesurée à 0,83). Elles descendent à 16 ; les deux mesures de QUALITÉ du pipe
  // — densité d'affaires réellement probables, et répartition du risque sur
  // plusieurs dossiers — montent à 14. Le pilier continue de mesurer l'avenir,
  // mais moins ce qu'on a confié au commercial et davantage ce qu'il en a fait.
  {
    key: "pipe_expected_month",
    label: "GMV probable ce mois",
    pillar: "pipeline",
    weight: 8,
    scale: "rang",
    format: eurText,
    strong: (d) => `${d} de GMV probable d'ici la fin du mois`,
    weak: (d) => `seulement ${d} de GMV probable d'ici la fin du mois`,
  },
  {
    key: "pipe_expected_m1",
    label: "Pipe du mois prochain",
    pillar: "pipeline",
    weight: 8,
    scale: "rang",
    format: eurText,
    strong: (d) => `pipe du mois prochain à ${d}`,
    weak: (d) => `pipe du mois prochain limité à ${d}`,
  },
  {
    key: "pipe_high_probability",
    label: "Part d'affaires à forte probabilité",
    pillar: "pipeline",
    weight: 7,
    scale: "rang",
    format: pctText,
    strong: (d) => `${d} de son pipe à plus de 25 % de chance de signer`,
    weak: (d) => `${d} de son pipe à plus de 25 % de chance de signer`,
  },
  {
    key: "pipe_concentration",
    label: "Répartition du pipe",
    pillar: "pipeline",
    weight: 7,
    scale: "taux",
    format: pctText,
    strong: (d) => `pipe réparti (plus grosse affaire : ${d} du total)`,
    weak: (d) => `pipe concentré sur une affaire (${d} du total)`,
  },
];

/**
 * Taux lissés par la taille de l'échantillon.
 *
 * Ce sont exactement les mesures dont le dénominateur varie d'un facteur
 * soixante d'un commercial à l'autre — un portefeuille de 1 affaire contre 64.
 * Les mesures de VOLUME n'y figurent pas : elles sont déjà notées au rang, où la
 * taille de l'échantillon n'a pas de sens.
 */
const SHRUNK_RATES = new Set([
  // Un pipe de sept affaires dont une seule dépasse le seuil donne 14 % ; un
  // pipe d'une affaire qui le dépasse donnerait 100 %. Le lissage ramène le
  // second vers le taux de l'équipe tant qu'il n'a rien prouvé.
  "pipe_high_probability",
  "lead_anomaly_rate",
  "lead_missed_calls",
  "lead_conversion",
  "deal_hygiene",
  "deal_stagnation",
  "deal_client_waiting",
]);

// Garde-fou de cohérence : le score doit valoir 100 points, ni plus ni moins.
// Une erreur de pondération produirait un classement silencieusement faux.
for (const [pillar, weight] of Object.entries(PERFORMANCE.weights)) {
  const sum = METRICS.filter((m) => m.pillar === pillar).reduce((t, m) => t + m.weight, 0);
  if (sum !== weight) {
    throw new Error(
      `Performance : le pilier ${pillar} pèse ${sum} points alors que sa pondération est ${weight}.`,
    );
  }
}

// --- Fenêtres de temps -----------------------------------------------------

/** Les mois de l'année civile en cours, de janvier au mois courant inclus. */
export function yearToDateMonths(now: Date): string[] {
  const year = now.getFullYear();
  const last = now.getMonth() + 1;
  return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * Les deux fenêtres de la dynamique : les trois derniers mois CLÔTURÉS, et les
 * trois qui les précèdent.
 *
 * Le mois en cours n'entre dans aucune des deux. Au 21 du mois il ne contient
 * que les deux tiers de son chiffre ; l'ajouter à la fenêtre récente ferait
 * apparaître un décrochage général en début de mois et une envolée en fin de
 * mois, chez tout le monde, sans qu'aucun commercial n'ait rien changé.
 */
export function dynamicWindows(now: Date): { recent: string[]; previous: string[] } {
  const n = PERFORMANCE.dynamicWindowMonths;
  const lastClosed = shiftMonth(monthKey(now), -1);
  const recent = Array.from({ length: n }, (_, i) => shiftMonth(lastClosed, -i)).reverse();
  const previous = Array.from({ length: n }, (_, i) => shiftMonth(recent[0], -(i + 1))).reverse();
  return { recent, previous };
}

// --- Mesures brutes --------------------------------------------------------

type RawMetrics = Record<string, number | null>;
/** Dénominateur de chaque taux, par clé de mesure. */
type RawSamples = Record<string, number>;

/**
 * Toutes les mesures brutes, par commercial.
 *
 * Chaque source garde son autorité : le Signé vient des lignes Travaux, les
 * probabilités du service Expected, les anomalies du moteur de jalons. Aucune
 * n'est recalculée ici — ce fichier les met en regard, il ne les produit pas.
 */
function collectRawMetrics(now: Date): {
  byOwner: Map<string, RawMetrics>;
  samples: Map<string, RawSamples>;
  /** Premier mois de l'année où une trace datée du commercial est observée. */
  presence: Map<string, string | null>;
  months: string[];
  notes: string[];
} {
  const notes: string[] = [];
  const currentMonth = monthKey(now);
  const months = yearToDateMonths(now);

  // --- Signé officiel, mois par mois.
  //
  // Le SOLDE de chaque mois est conservé, pas seulement le total de la fenêtre :
  // la régularité se mesure mois par mois, et un mois se juge à son solde net,
  // avenants et annulations compris.
  const signedByOwner = new Map<
    string,
    { gmv: number; deals: Set<string>; netByMonth: Map<string, number> }
  >();
  for (const month of months) {
    const official = officialSignedGmv(month);
    for (const line of official.rows) {
      if (!line.salesperson) continue;
      const cur = signedByOwner.get(line.salesperson) ?? {
        gmv: 0,
        deals: new Set<string>(),
        netByMonth: new Map<string, number>(),
      };
      cur.gmv += line.gmv;
      if (line.opportunityId) cur.deals.add(line.opportunityId);
      cur.netByMonth.set(month, (cur.netByMonth.get(month) ?? 0) + line.gmv);
      signedByOwner.set(line.salesperson, cur);
    }
  }

  // --- Mois retenus pour la RÉGULARITÉ : les mois clôturés, et eux seuls.
  //
  // Deux corrections de la calibration V1, distinctes mais de même nature —
  // ne pas laisser un mois incomplet ou déficitaire passer pour un mois produit :
  //
  //   1. le mois EN COURS est exclu. Au 20 du mois, il n'a pas eu lieu en
  //      entier ; l'y inclure punissait celui qui signe en fin de mois et
  //      récompensait celui qui avait déjà signé le 5 ;
  //   2. un mois au solde NET négatif ou nul ne compte pas. L'ancienne règle
  //      regardait chaque ligne : un mois soldé à −5 000 € comptait comme
  //      produit dès qu'une seule ligne était positive, ce qui donnait 5/5 de
  //      régularité à un mois qui a détruit du chiffre.
  //
  // Le GMV et le nombre d'affaires signées continuent, eux, de porter sur toute
  // la fenêtre, mois en cours compris : ils mesurent ce qui a été produit, et le
  // mois en cours en fait partie.
  const closedMonths = months.filter((m) => m < currentMonth);
  if (closedMonths.length > 0) {
    notes.push(
      `Régularité mesurée sur les mois clôturés uniquement (${monthLabel(closedMonths[0])} → ` +
        `${monthLabel(closedMonths[closedMonths.length - 1])}) : ${monthLabel(currentMonth)} n'est pas terminé. ` +
        "Un mois au solde négatif ou nul n'y compte pas comme mois produit.",
    );
  }

  // --- Pipe ouvert, pour rapporter le signé au portefeuille confié.
  //
  // La même passe relève le premier mois de l'année où une AFFAIRE a été créée
  // pour ce commercial. Croisé avec sa première signature, il donne la
  // profondeur d'historique dont on dispose sur lui — une information
  // d'affichage, qui n'entre dans aucun score.
  const openByOwner = new Map<string, number>();
  const firstSeen = new Map<string, string>();
  const year = `${now.getFullYear()}-`;
  const noteFirst = (owner: string, month: string | null | undefined) => {
    if (!month || !month.startsWith(year)) return;
    const known = firstSeen.get(owner);
    if (!known || month < known) firstSeen.set(owner, month);
  };
  for (const o of loadOpportunities()) {
    noteFirst(o.owner, o.createdAt?.slice(0, 7));
    if (o.isTerminal) continue;
    openByOwner.set(o.owner, (openByOwner.get(o.owner) ?? 0) + (o.gmv ?? 0));
  }
  for (const [owner, s] of signedByOwner) {
    for (const [month, net] of s.netByMonth) if (net !== 0) noteFirst(owner, month);
  }

  // --- Pistes.
  const leadFrom = now.getTime() - PERFORMANCE.leadWindowDays * 864e5;
  const leads = loadLeads();
  const leadsByOwner = new Map<string, typeof leads>();
  for (const l of leads) {
    leadsByOwner.set(l.owner, [...(leadsByOwner.get(l.owner) ?? []), l]);
  }

  // --- Opportunités suivies.
  const dealsByOwner = new Map<string, ReturnType<typeof loadMilestoneOpportunities>>();
  for (const o of loadMilestoneOpportunities()) {
    dealsByOwner.set(o.owner, [...(dealsByOwner.get(o.owner) ?? []), o]);
  }

  // --- Expected du mois et du mois suivant.
  const expected = buildExpectedGmvSnapshot();
  const m1 = buildExpectedM1();
  if (expected == null) notes.push("Aucun scoring Expected du mois : le pilier pipeline est incomplet.");
  if (m1 == null) notes.push("Aucune projection M+1 publiée : le pipe du mois prochain n'est pas mesuré.");
  notes.push(
    "Aucun horizon M+2 n'est utilisé : le classement des affaires à cet horizon a été mesuré moins fiable que le hasard, et rejeté.",
  );

  /**
   * Le pipe futur d'un commercial, vu comme un ENSEMBLE D'AFFAIRES.
   *
   * Une même opportunité est scorée deux fois — une chance de signer ce mois,
   * une chance de signer le mois prochain. Les compter comme deux lignes serait
   * faux à deux endroits :
   *
   *   — le TAUX d'affaires probables aurait un dénominateur gonflé, et une
   *     affaire probable sur les deux horizons compterait double au numérateur ;
   *   — la part de la plus grosse AFFAIRE serait en réalité la part de sa plus
   *     grosse contribution mensuelle, ce qui sous-estime la concentration :
   *     une affaire unique répartie sur deux horizons paraît deux affaires.
   *
   * On agrège donc par identifiant d'affaire : `eligible` compte des dossiers
   * distincts, `high` les dossiers probables sur au moins un des deux horizons,
   * et `byDeal` porte le poids total de chaque dossier.
   */
  const m1Threshold = m1?.threshold ?? PERFORMANCE.highProbability;
  type PipeOwner = {
    month: number;
    gmv: number;
    eligible: Set<string>;
    high: Set<string>;
    byDeal: Map<string, number>;
  };
  const pipeByOwner = new Map<string, PipeOwner>();
  const pipeOf = (owner: string): PipeOwner => {
    const cur = pipeByOwner.get(owner) ?? {
      month: 0,
      gmv: 0,
      eligible: new Set<string>(),
      high: new Set<string>(),
      byDeal: new Map<string, number>(),
    };
    pipeByOwner.set(owner, cur);
    return cur;
  };
  const addDeal = (cur: PipeOwner, id: string, amount: number) => {
    if (amount > 0) cur.byDeal.set(id, (cur.byDeal.get(id) ?? 0) + amount);
  };

  for (const o of expected?.opportunities ?? []) {
    const cur = pipeOf(o.owner);
    cur.month += o.expectedMonthEnd;
    cur.eligible.add(o.opportunityId);
    if (o.pMonthEnd >= PERFORMANCE.highProbability) cur.high.add(o.opportunityId);
    addDeal(cur, o.opportunityId, o.expectedMonthEnd);
  }
  for (const o of m1?.opportunities ?? []) {
    const cur = pipeOf(o.owner);
    // Indicateur de CLASSEMENT, jamais un montant attendu du mois : la
    // projection M+1 ne se somme pas depuis les lignes, et le pilier ne prétend
    // pas le contraire — il compare des pipes entre eux.
    if (o.frozenM1) continue;
    cur.gmv += o.expectedGmv;
    cur.eligible.add(o.opportunityId);
    if (o.probability >= m1Threshold) cur.high.add(o.opportunityId);
    addDeal(cur, o.opportunityId, o.expectedGmv);
  }

  const nowMs = now.getTime();
  const byOwner = new Map<string, RawMetrics>();
  const samples = new Map<string, RawSamples>();

  for (const member of TEAM) {
    const name = member.name;
    const signed = signedByOwner.get(name);
    const open = openByOwner.get(name) ?? 0;
    const signedGmv = signed?.gmv ?? 0;

    const mine = leadsByOwner.get(name) ?? [];
    const inWindow = mine.filter((l) => new Date(l.createdAt).getTime() >= leadFrom);
    const openLeads = mine.filter(
      (l) => l.operationalStatus !== "convertie" && l.operationalStatus !== "abandonnee",
    );
    const anomalies = openLeads.filter(
      (l) =>
        !l.isLegacy &&
        ["a_traiter", "en_retard", "critique", "sans_rendez_vous"].includes(l.operationalStatus),
    );
    const firstCallDelays = inWindow
      .map((l) =>
        l.firstCallAt
          ? (new Date(l.firstCallAt).getTime() - new Date(l.createdAt).getTime()) / 36e5
          : null,
      )
      .filter((v): v is number => v != null && v >= 0);
    const pastFirstCalls = mine.filter(
      (l) => l.firstCallAt && new Date(l.firstCallAt).getTime() < nowMs,
    );
    const missed = mine.filter((l) => l.firstCallMissed);

    // « milestones » et non « deals » : plus bas, `deals` désigne les montants du
    // pipe futur agrégés par affaire. Deux notions distinctes, deux noms.
    const milestones = dealsByOwner.get(name) ?? [];
    const dealAnomalies = milestones.filter(
      (o) => !o.isLegacy && MILESTONE_ANOMALIES.includes(o.milestoneStatus),
    );
    const stagnant = milestones.filter(
      (o) =>
        o.milestoneStatus === "dormant_candidate" ||
        (o.nextExpectedDueAt == null &&
          o.milestoneStatus !== "standby" &&
          o.latenessHours > PERFORMANCE.stagnantDays * 24),
    );
    const waiting = milestones.filter((o) => o.clientWaiting);

    const pipe = pipeByOwner.get(name);
    const eligible = pipe?.eligible.size ?? 0;
    const deals = [...(pipe?.byDeal.values() ?? [])];
    const totalContribution = deals.reduce((t, v) => t + v, 0);

    byOwner.set(name, {
      signed_gmv: signedGmv,
      signed_deals: signed?.deals.size ?? 0,
      // Rendement : ce qui a été signé rapporté à ce qui a été confié.
      // APPROXIMATION ASSUMÉE — le portefeuille confié est approché par « signé
      // sur la période + pipe encore ouvert aujourd'hui ». Le dénominateur exact
      // demanderait l'historique des affaires perdues, que la source ne publie
      // pas. L'approximation ne favorise ni les gros ni les petits portefeuilles.
      signed_yield: signedGmv + open > 0 ? signedGmv / (signedGmv + open) : null,
      // Nulle — donc « non mesurée » — si la fenêtre ne contient aucun mois
      // clôturé : on ne prétend pas mesurer une régularité sans mois complet.
      signed_regularity:
        closedMonths.length === 0
          ? null
          : closedMonths.filter((m) => (signed?.netByMonth.get(m) ?? 0) > 0).length /
            closedMonths.length,

      // Une médiane sur une ou deux pistes ne mesure rien : en dessous du seuil,
      // la donnée est déclarée absente plutôt que présentée comme un délai.
      lead_first_call:
        firstCallDelays.length >= PERFORMANCE.minFirstCallSample ? median(firstCallDelays) : null,
      lead_anomaly_rate: openLeads.length > 0 ? anomalies.length / openLeads.length : null,
      lead_missed_calls: pastFirstCalls.length > 0 ? missed.length / pastFirstCalls.length : null,
      lead_conversion:
        inWindow.length > 0
          ? inWindow.filter((l) => l.operationalStatus === "convertie").length / inWindow.length
          : null,

      deal_hygiene: milestones.length > 0 ? dealAnomalies.length / milestones.length : null,
      deal_stagnation: milestones.length > 0 ? stagnant.length / milestones.length : null,
      deal_client_waiting: milestones.length > 0 ? waiting.length / milestones.length : null,

      pipe_expected_month: pipe?.month ?? 0,
      pipe_expected_m1: pipe?.gmv ?? 0,
      // TAUX d'affaires probables, et non plus leur NOMBRE. Un comptage suit la
      // taille du portefeuille confié : celui à qui l'on donne soixante dossiers
      // en aura mécaniquement plus au-dessus du seuil que celui qui en a sept,
      // sans que cela dise quoi que ce soit de la qualité de son pipe. Le taux
      // répond à la vraie question : quelle part de ce qu'il a en main a une
      // chance réelle de signer.
      pipe_high_probability: eligible > 0 ? (pipe?.high.size ?? 0) / eligible : null,
      // Part de la plus grosse AFFAIRE, agrégée sur les deux horizons. Mesurée
      // seulement si le portefeuille est assez fourni pour que le barème ait un
      // sens — voir `PERFORMANCE.minConcentrationSample`.
      pipe_concentration:
        eligible >= PERFORMANCE.minConcentrationSample && totalContribution > 0
          ? Math.max(...deals) / totalContribution
          : null,
    });

    samples.set(name, {
      lead_anomaly_rate: openLeads.length,
      lead_missed_calls: pastFirstCalls.length,
      lead_conversion: inWindow.length,
      deal_hygiene: milestones.length,
      deal_stagnation: milestones.length,
      deal_client_waiting: milestones.length,
      // Nombre de délais réellement mesurés : sert à afficher l'assise de la
      // médiane et à interdire un commentaire fondé sur deux pistes.
      lead_first_call: firstCallDelays.length,
      pipe_high_probability: eligible,
      pipe_concentration: eligible,
    });
  }

  const presence = new Map<string, string | null>(
    TEAM.map((m) => [m.name, firstSeen.get(m.name) ?? null]),
  );

  return { byOwner, samples, presence, months, notes };
}

/** Passage d'une valeur brute à [0, 1], selon le barème propre à la mesure. */
function normalize(spec: MetricSpec, value: number, all: number[]): number {
  const c = PERFORMANCE;
  switch (spec.key) {
    // Barèmes absolus : plus c'est bas, mieux c'est.
    case "lead_first_call":
      return scale01(value, c.firstCallFastHours, c.firstCallSlowHours);
    case "lead_anomaly_rate":
      return scale01(value, 0, c.maxAnomalyRate);
    case "lead_missed_calls":
      return scale01(value, 0, c.maxMissedRate);
    case "deal_hygiene":
      return scale01(value, 0, c.maxAnomalyRate);
    case "deal_stagnation":
      return scale01(value, 0, c.maxStaleRate);
    case "deal_client_waiting":
      return scale01(value, 0, c.maxWaitingRate);
    // Barème absolu croissant.
    case "signed_regularity":
      return scale01(value, 1, 0);
    case "pipe_concentration":
      return scale01(value, c.concentrationFloor, c.concentrationCeiling);
    // Tout le reste se compare à l'équipe.
    default:
      return percentile(value, all);
  }
}

// --- Dynamique 3 mois ------------------------------------------------------

export type DynamicWindow = {
  months: string[];
  label: string;
  /** Score de la fenêtre, sur 100. */
  score: number;
  gmv: number;
  deals: number;
  /** Mois de la fenêtre au solde net positif. */
  producedMonths: number;
};

export type DynamicScore = {
  recent: DynamicWindow;
  previous: DynamicWindow;
  /** Score récent − score précédent, en points. Positif = progression. */
  delta: number;
  /** Faux quand la fenêtre précédente sort de la période couverte par la source. */
  comparable: boolean;
};

/**
 * Dynamique 3 mois — ce qu'elle mesure, et ce qu'elle ne mesure pas.
 *
 * ELLE NE PORTE QUE SUR LA PRODUCTION SIGNÉE, et ce n'est pas un choix de
 * confort : c'est la seule chose que les données permettent de reconstituer
 * honnêtement en arrière.
 *
 *   — les lignes Travaux sont DATÉES à la signature et conservées : le chiffre
 *     de mars 2026 est aussi vrai aujourd'hui qu'il l'était en mars ;
 *   — l'état des pistes, les jalons d'opportunités et l'Expected GMV sont des
 *     ÉTATS COURANTS, écrasés à chaque import. Leurs photos quotidiennes ne
 *     remontent qu'au 16/08/2026, soit cinq jours : il n'existe aucun moyen de
 *     dire quel était le taux d'anomalie d'un commercial en mars, ni son pipe
 *     futur. Les inclure obligerait à inventer un passé.
 *
 * La conversion des pistes a été écartée pour une raison différente et tout
 * aussi nette : une piste créée en juillet a eu six semaines pour se convertir,
 * une piste de mars en a eu cinq mois. Le cohort récent est mécaniquement plus
 * bas, et la « dynamique » mesurerait le temps écoulé, pas le travail.
 *
 * ÉCHELLE COMMUNE. Les deux fenêtres sont notées sur le MÊME barème, construit
 * à partir de toutes les observations des deux fenêtres réunies. C'est la
 * condition pour qu'un écart veuille dire « il a produit plus », et non « il est
 * remonté parce qu'un autre a baissé » — un rang relatif recalculé dans chaque
 * fenêtre aurait exactement ce défaut.
 */
export function buildDynamicScores(now: Date): {
  byOwner: Map<string, DynamicScore>;
  note: string;
} {
  const { recent, previous } = dynamicWindows(now);
  const all = [...previous, ...recent];

  // Production de chaque commercial sur chaque mois des deux fenêtres.
  const net = new Map<string, Map<string, number>>();
  const deals = new Map<string, Map<string, Set<string>>>();
  for (const month of all) {
    for (const line of officialSignedGmv(month).rows) {
      if (!line.salesperson) continue;
      const byMonth = net.get(line.salesperson) ?? new Map<string, number>();
      byMonth.set(month, (byMonth.get(month) ?? 0) + line.gmv);
      net.set(line.salesperson, byMonth);
      const dealsByMonth = deals.get(line.salesperson) ?? new Map<string, Set<string>>();
      const set = dealsByMonth.get(month) ?? new Set<string>();
      if (line.opportunityId) set.add(line.opportunityId);
      dealsByMonth.set(month, set);
      deals.set(line.salesperson, dealsByMonth);
    }
  }

  const measure = (owner: string, months: string[]) => {
    const byMonth = net.get(owner);
    const dealsByMonth = deals.get(owner);
    const gmv = months.reduce((t, m) => t + (byMonth?.get(m) ?? 0), 0);
    const signed = new Set<string>();
    for (const m of months) for (const id of dealsByMonth?.get(m) ?? []) signed.add(id);
    return {
      gmv,
      deals: signed.size,
      producedMonths: months.filter((m) => (byMonth?.get(m) ?? 0) > 0).length,
    };
  };

  const raw = TEAM.map((member) => ({
    owner: member.name,
    recent: measure(member.name, recent),
    previous: measure(member.name, previous),
  }));

  // Le barème, commun aux deux fenêtres. La meilleure production observée vaut
  // la note pleine ; un GMV négatif — un trimestre soldé par des annulations —
  // vaut zéro et jamais moins.
  const refGmv = Math.max(1, ...raw.flatMap((r) => [r.recent.gmv, r.previous.gmv]));
  const refDeals = Math.max(1, ...raw.flatMap((r) => [r.recent.deals, r.previous.deals]));
  const n = PERFORMANCE.dynamicWindowMonths;

  // Poids repris du pilier Signé, à l'identique, moins le rendement — qui
  // demanderait de connaître le pipe ouvert tel qu'il était à l'époque. Les
  // trois retenus pèsent 12, 6 et 5 dans le modèle ; ils sont ramenés à 100.
  const total = 12 + 6 + 5;
  const score = (m: { gmv: number; deals: number; producedMonths: number }) =>
    (100 *
      (12 * Math.min(1, Math.max(0, m.gmv / refGmv)) +
        6 * Math.min(1, m.deals / refDeals) +
        5 * (m.producedMonths / n))) /
    total;

  const label = (months: string[]) =>
    `${monthLabel(months[0])} → ${monthLabel(months[months.length - 1])}`;

  const byOwner = new Map<string, DynamicScore>();
  for (const r of raw) {
    const rec = { months: recent, label: label(recent), score: score(r.recent), ...r.recent };
    const prev = {
      months: previous,
      label: label(previous),
      score: score(r.previous),
      ...r.previous,
    };
    byOwner.set(r.owner, {
      recent: rec,
      previous: prev,
      delta: Math.round((rec.score - prev.score) * 10) / 10,
      comparable: true,
    });
  }

  return {
    byOwner,
    note:
      `Momentum 3 mois : production signée de ${label(recent)} comparée à ${label(previous)}, ` +
      "sur une échelle commune aux deux fenêtres. Elle ne couvre QUE la production : " +
      "l'état des pistes, les jalons et l'Expected GMV sont des états courants, dont les photos " +
      "ne remontent qu'au 16/08/2026 — leur passé n'est pas reconstituable et n'est pas inventé.",
  };
}

// --- Composition du classement --------------------------------------------

export function buildPerformanceBoard(
  now = new Date(),
  previousRanks: Map<string, number> = new Map(),
  comparedTo: string | null = null,
): PerformanceBoard {
  const { byOwner, samples, presence, months, notes } = collectRawMetrics(now);
  const dynamics = buildDynamicScores(now);

  // Taux de l'équipe, POOLÉ : total des cas sur total des dossiers, et non
  // moyenne des taux individuels. Un commercial à un seul dossier ne doit pas
  // peser autant qu'un autre à soixante dans la définition de la référence.
  const pooled = new Map<string, number>();
  for (const key of SHRUNK_RATES) {
    let cases = 0;
    let total = 0;
    for (const [name, values] of byOwner) {
      const den = samples.get(name)?.[key] ?? 0;
      const rate = values[key];
      if (den > 0 && rate != null) {
        cases += rate * den;
        total += den;
      }
    }
    pooled.set(key, total > 0 ? cases / total : 0);
  }

  /**
   * Valeur retenue pour la NOTE. Le taux mesuré est tiré vers celui de l'équipe
   * d'autant plus fort que le dossier est mince : à un dossier, la note est
   * presque celle de l'équipe ; à soixante, elle est presque la sienne.
   */
  const scoredValue = (key: string, owner: string, value: number): number => {
    if (!SHRUNK_RATES.has(key)) return value;
    const den = samples.get(owner)?.[key] ?? 0;
    const k = PERFORMANCE.smoothing;
    return (value * den + k * (pooled.get(key) ?? 0)) / (den + k);
  };

  const rows: Pick<PerformanceRow, "salesperson" | "firstName" | "score" | "pillars">[] = TEAM.map(
    (member) => {
      const raw = byOwner.get(member.name) ?? {};
      const pillars = {} as Record<PillarKey, PillarResult>;

      for (const key of Object.keys(PERFORMANCE.weights) as PillarKey[]) {
        pillars[key] = {
          key,
          label: PILLAR_LABEL[key],
          weight: PERFORMANCE.weights[key],
          points: 0,
          outOf100: 0,
          metrics: [],
        };
      }

      for (const spec of METRICS) {
        const value = raw[spec.key] ?? null;
        const measured = value != null;
        const sample = samples.get(member.name)?.[spec.key] ?? null;
        // La comparaison à l'équipe porte sur les valeurs NOTÉES : comparer une
        // valeur lissée à des valeurs brutes mélangerait deux échelles. Seuls
        // les commerciaux réellement mesurés entrent dans le repère — une note
        // de remplacement ne doit pas déplacer le rang des autres.
        const all = [...byOwner.entries()]
          .map(([name, m]) =>
            m[spec.key] == null ? null : scoredValue(spec.key, name, m[spec.key] as number),
          )
          .filter((v): v is number => v != null);
        // MESURE ABSENTE : exactement la moitié du poids, et rien d'autre.
        // Ni la médiane de l'équipe — qui valait la note maximale sur les
        // critères où « moins c'est mieux » —, ni zéro, qui punirait de n'avoir
        // rien eu à traiter. Voir `PERFORMANCE.unmeasuredShare`.
        const effective = measured ? scoredValue(spec.key, member.name, value) : 0;
        const normalized = measured
          ? normalize(spec, effective, all)
          : PERFORMANCE.unmeasuredShare;
        // Aucune note négative, jamais : le barème est borné des deux côtés.
        const points = Math.max(0, Math.min(spec.weight, normalized * spec.weight));

        pillars[spec.pillar].metrics.push({
          key: spec.key,
          label: spec.label,
          pillar: spec.pillar,
          weight: spec.weight,
          scale: spec.scale,
          value,
          // La valeur affichée est la MESURE, jamais la valeur lissée : le score
          // est prudent, la mesure reste vraie.
          //
          // Le taux d'affaires probables s'affiche avec son comptage : « 2 / 5
          // affaires ≥ 25 % · 40 % ». Le seul pourcentage laisserait croire à un
          // pipe fourni là où il n'y a que cinq dossiers.
          display:
            spec.key === "pipe_high_probability" && measured && sample != null
              ? `${Math.round(value * sample)} / ${sample} affaires ≥ 25 % · ${spec.format(value)}`
              : spec.format(value),
          phrase: spec.format(value),
          normalized,
          points,
          measured,
          sample,
          // « sur 1 dossier » explique à lui seul pourquoi une note parfaite en
          // apparence ne l'est pas : c'est l'assise de la mesure, pas la mesure.
          sampleText:
            sample != null && measured && spec.key !== "pipe_high_probability"
              ? `sur ${sample}`
              : null,
          scored: effective,
        });
        pillars[spec.pillar].points += points;
      }

      for (const pillar of Object.values(pillars)) {
        pillar.points = Math.round(pillar.points * 10) / 10;
        pillar.outOf100 = Math.round((pillar.points / pillar.weight) * 100);
      }

      const score =
        Math.round(Object.values(pillars).reduce((t, p) => t + p.points, 0) * 10) / 10;

      return {
        salesperson: member.name,
        firstName: member.firstName,
        score,
        pillars,
      };
    },
  );

  // Classement. À score égal, l'ordre alphabétique tranche : n'importe quel
  // départage arbitraire ferait varier le rang d'un rafraîchissement à l'autre.
  const sorted = [...rows].sort(
    (a, b) => b.score - a.score || a.salesperson.localeCompare(b.salesperson, "fr"),
  );

  const salespeople: PerformanceRow[] = sorted.map((row, index) => {
    const rank = index + 1;
    const previous = previousRanks.get(row.salesperson) ?? null;
    const dynamic = dynamics.byOwner.get(row.salesperson)!;
    const { strengths, watch, comment } = explain(
      row.firstName,
      row.pillars,
      rank,
      sorted.length,
      dynamic,
    );
    const firstMonth = presence.get(row.salesperson) ?? null;
    return {
      ...row,
      rank,
      previousRank: previous,
      history: {
        firstMonth,
        monthsObserved: firstMonth == null ? 0 : months.filter((m) => m >= firstMonth).length,
        ytdMonths: months.length,
      },
      // Positif = a gagné des places. Un rang qui BAISSE en valeur est une
      // progression : l'écart est donc calculé dans ce sens, et pas l'inverse.
      rankChange: previous == null ? null : previous - rank,
      dynamic,
      strengths,
      watch,
      comment: `#${rank} — ${comment}`,
    };
  });

  // « Qui monte » et « Qui décroche » se lisent sur le DELTA DE SCORE, jamais sur
  // le rang : un commercial qui n'a rien changé remonterait au classement dès
  // qu'un autre décroche, et serait annoncé en progression sans avoir rien
  // produit de plus. Le seuil écarte le bruit des petits écarts.
  const seuil = PERFORMANCE.dynamicSignificantDelta;
  const movers = {
    up: salespeople
      .filter((r) => r.dynamic.comparable && r.dynamic.delta >= seuil)
      .sort((a, b) => b.dynamic.delta - a.dynamic.delta)
      .slice(0, PERFORMANCE.maxMovers),
    down: salespeople
      .filter((r) => r.dynamic.comparable && r.dynamic.delta <= -seuil)
      .sort((a, b) => a.dynamic.delta - b.dynamic.delta)
      .slice(0, PERFORMANCE.maxMovers),
  };

  return {
    computedAt: now.toISOString(),
    modelVersion: PERFORMANCE_MODEL_VERSION,
    months,
    monthsLabel: `${monthLabel(months[0])} → ${monthLabel(months[months.length - 1])}`,
    salespeople,
    comparedTo,
    movers,
    notes: [...notes, dynamics.note],
  };
}

// --- Explications ----------------------------------------------------------

/** Seuils de qualification. Au-dessus : un point fort. En dessous : à surveiller. */
const STRONG_AT = 0.65;
const WATCH_AT = 0.35;

/**
 * Points forts, points de vigilance et commentaire — tous déterministes.
 *
 * La sélection est mécanique : on trie les mesures par note normalisée, on garde
 * les meilleures au-dessus du seuil et les moins bonnes en dessous. La phrase
 * est ensuite composée depuis le gabarit de la mesure, alimenté par la valeur
 * réellement calculée.
 *
 * AUCUN texte n'est produit librement. Une phrase ne peut pas exister sans le
 * chiffre qui la soutient : c'est ce qui rend le commentaire vérifiable, et
 * c'est la raison pour laquelle aucun modèle de langage n'intervient ici.
 */
function explain(
  firstName: string,
  pillars: Record<PillarKey, PillarResult>,
  rank: number,
  total: number,
  dynamic: DynamicScore,
): { strengths: Explanation[]; watch: Explanation[]; comment: string } {
  const all = Object.values(pillars).flatMap((p) => p.metrics);
  const specs = new Map(METRICS.map((m) => [m.key, m]));

  // DEUX CONDITIONS pour qu'une mesure ait le droit de parler.
  //
  //   1. elle est mesurée. Une mesure absente ne décrit rien de ce commercial ;
  //      elle vaut la moitié du poids par neutralité, et se taire fait partie de
  //      cette neutralité.
  //   2. elle repose sur assez de dossiers. « 100 % de ses pistes converties »
  //      sur une piste est vrai et trompeur : le lecteur y entendra un jugement
  //      sur sa façon de travailler, alors que la mesure décrit un tirage. Le
  //      score, lui, retient la mesure — déjà tempérée par le lissage — et le
  //      détail l'affiche avec son dénominateur.
  //
  // Les mesures de volume (GMV signé, Expected) n'ont pas de dénominateur : elles
  // ne sont pas des taux, la question du petit échantillon ne se pose pas.
  const measurable = all.filter(
    (m) => m.measured && (m.sample == null || m.sample >= PERFORMANCE.minCommentSample),
  );

  // L'ordre est celui des POINTS, pas des pourcentages : une mesure à 90 % sur
  // 4 points pèse moins dans le classement qu'une mesure à 70 % sur 12. Trier
  // sur la note brute ferait remonter en tête des faits vrais mais secondaires
  // — « aucun client en attente » avant « 452 k€ signés ».
  const best = [...measurable]
    .filter((m) => m.normalized >= STRONG_AT)
    .sort((a, b) => b.normalized * b.weight - a.normalized * a.weight);
  const worst = [...measurable]
    .filter((m) => m.normalized <= WATCH_AT)
    .sort((a, b) => (1 - a.normalized) * a.weight - (1 - b.normalized) * b.weight)
    .reverse();

  const strengths = best
    .slice(0, 3)
    .map((m): Explanation => ({ key: m.key, text: specs.get(m.key)!.strong(m.phrase) }));
  const watch = worst
    .slice(0, 3)
    .map((m): Explanation => ({ key: m.key, text: specs.get(m.key)!.weak(m.phrase) }));

  // Le commentaire nomme le pilier le plus fort et le plus faible, puis le fait
  // qui les explique. Deux propositions au plus : au-delà, on ne lit plus.
  const ordered = Object.values(pillars).sort((a, b) => b.outOf100 - a.outOf100);
  const top = ordered[0];
  const bottom = ordered[ordered.length - 1];

  const head =
    strengths.length > 0
      ? `${firstName} : ${strengths[0].text}`
      : `${firstName} : ${top.label.toLowerCase()} à ${top.outOf100}/100`;
  const tail =
    watch.length > 0
      ? ` ; à surveiller, ${watch[0].text}`
      : bottom.outOf100 < 50
        ? ` ; son point le plus faible reste ${bottom.label.toLowerCase()} (${bottom.outOf100}/100)`
        : "";

  return { strengths, watch, comment: `${head}${tail}${situation(rank, total, dynamic)}` };
}

/**
 * NIVEAU et TRAJECTOIRE, dits séparément.
 *
 * Ce sont deux choses différentes et le manager a besoin des deux : un
 * deuxième de l'année dont la production recule appelle une conversation, un
 * huitième qui progresse fortement en appelle une autre — et un classement seul
 * ne distingue pas les deux cas.
 *
 * La phrase n'est produite que si l'écart dépasse le seuil de significativité.
 * En deçà, on ne dit rien plutôt que d'appeler « stable » ce qui n'est que du
 * bruit de mesure sur trois mois de chiffre.
 */
function situation(rank: number, total: number, dynamic: DynamicScore): string {
  const rangText = `${rank}${rank === 1 ? "er" : "e"} sur l'année`;
  if (!dynamic.comparable) {
    return `. ${rangText}, sans historique suffisant pour juger la tendance.`;
  }
  const d = dynamic.delta;
  const seuil = PERFORMANCE.dynamicSignificantDelta;
  const haut = rank <= Math.ceil(total / 3);
  const bas = rank > total - Math.ceil(total / 3);

  if (d >= seuil) {
    return bas
      ? `. ${rangText}, mais l'une des meilleures progressions de production sur les 3 derniers mois (+${d} pts).`
      : `. ${rangText}, et production en hausse sur les 3 derniers mois (+${d} pts).`;
  }
  if (d <= -seuil) {
    return haut
      ? `. ${rangText}, mais dynamique récente en baisse (${d} pts).`
      : `. ${rangText}, et production en recul sur les 3 derniers mois (${d} pts).`;
  }
  // « Stable » suppose qu'il y a quelque chose à stabiliser. Deux fenêtres à
  // zéro décrivent une absence de production, pas une trajectoire plate, et le
  // dire ainsi évite de rassurer à tort.
  if (dynamic.recent.gmv <= 0 && dynamic.previous.gmv <= 0) {
    return `. ${rangText}, sans production signée sur les 6 derniers mois clôturés.`;
  }
  return `. ${rangText}, production stable sur les 3 derniers mois.`;
}

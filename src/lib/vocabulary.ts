/**
 * Vocabulaire visible de RM Morning.
 *
 * Règle : un nouveau directeur régional doit comprendre chaque intitulé sans
 * connaître Salesforce, les statistiques, ni les noms de variables internes.
 * Si ce n'est pas le cas, l'intitulé change ici — pas à l'écran, pour que les
 * quatre pages disent la même chose du même chiffre.
 *
 * Les termes techniques ne disparaissent pas : ils sont relégués derrière un
 * « Voir le détail technique », où l'on peut vérifier. Ils ne doivent jamais
 * apparaître dans une lecture principale.
 */

/** Ce que mesure chaque chiffre, en une formule que l'on peut lire à voix haute. */
export const LABEL = {
  // --- Réalisé et déclaratif -------------------------------------------------
  signed: "Signé ce mois",
  signedToDate: "Signé à date",
  kanban: "Prévu par les commerciaux",
  kanbanRow: "Prévu par le commercial",
  // Les deux prévisions de fin de mois se lisaient « Prévision commerciale de
  // fin de mois » et « Prévision RM Morning de fin de mois » : côte à côte dans
  // le bandeau, elles étaient impossibles à distinguer d'un coup d'œil. Les
  // libellés portent maintenant l'AUTEUR de la prévision, qui est la seule chose
  // qui les sépare ; « fin de mois » passe en sous-titre commun.
  kanbanFinish: "Prévu par l'équipe",
  perspective: "Dernière Perspective",

  // --- Prévision statistique -------------------------------------------------
  expectedFinish: "Prévision RM Morning",
  expectedRemaining: "GMV encore probable ce mois",
  expectedRegion: "Prévision RM Morning",
  probableZone: "Zone probable",
  probableGmv: "GMV probable",
  chanceThisMonth: "Chance de signer ce mois",
  chanceSevenDays: "Chance de signer sous 7 jours",
  gmvSevenDays: "GMV susceptible de signer sous 7 jours",

  // --- Horizon M+1 -----------------------------------------------------------
  // « Projection » et non « Prévision » : le mot marque que ce chiffre ne se
  // construit pas comme celui du mois en cours. Il part du niveau historique de
  // l'équipe, alors que la prévision du mois somme des affaires identifiées.
  // « Fourchette indicative » et non « Zone probable » : sa couverture n'est pas
  // calibrée — mesurée sur trois mois seulement, elle ne porte aucun taux.
  projectionM1: "Projection RM Morning",
  indicativeRange: "Fourchette indicative",
  confidence: "Confiance",
  historicalMark: "Repère historique",

  // --- Suivi et discipline ---------------------------------------------------
  nextStep: "Prochaine étape attendue",
  stageAge: "Temps dans l'étape",
  dormant: "Affaire sans mouvement récent",
  legacy: "Retards déjà présents au démarrage",
  freshException: "Nouveau retard",
  challenge: "À challenger",
  divergence: "Écart avec le Forecast",

  // --- Objectif --------------------------------------------------------------
  objective: "Objectif du mois",
  gapToObjective: "Écart avec l'objectif",
} as const;

/**
 * Lecture du rapprochement déclaratif / estimation, au niveau Région.
 *
 * DÉSACTIVÉE au checkpoint du 17/08/2026, et volontairement conservée en place
 * pour être réactivée plus tard.
 *
 * Deux raisons, toutes deux dirimantes :
 *
 *   1. les seuils 70 % / 45 % n'ont jamais été validés sur des données ;
 *   2. surtout, les deux chiffres ne portent pas sur le même univers. La
 *      prévision commerciale ne compte que les affaires portant une Projection
 *      Kanban sur le mois — 8 au 17/08 — quand la prévision RM Morning score
 *      les 279 affaires ouvertes du pipe. Un rapport entre les deux ne mesure
 *      donc pas un optimisme : il mélange deux périmètres.
 *
 * Tant que ce n'est pas tranché, l'interface énonce les deux chiffres et leur
 * écart, sans conclure.
 */
export const FORECAST_READING_ENABLED = false;

export const FORECAST_READING = {
  coherent: 0.7,
  ambitious: 0.45,
} as const;

export type ForecastReading =
  | "coherent"
  | "ambitieux"
  | "tres_ambitieux"
  | "indisponible"
  /** Aucune conclusion : périmètres différents et seuils non validés. */
  | "non_conclu";

export const READING_LABEL: Record<ForecastReading, string> = {
  coherent: "Forecast cohérent",
  ambitieux: "Forecast ambitieux",
  tres_ambitieux: "Forecast très ambitieux",
  indisponible: "Pas encore de prévision pour ce mois",
  non_conclu: "Deux périmètres différents",
};

export const READING_HINT: Record<ForecastReading, string> = {
  coherent: "L'estimation rejoint ce que l'équipe annonce.",
  ambitieux: "L'équipe annonce sensiblement plus que ce que l'historique laisse attendre.",
  tres_ambitieux:
    "L'écart est important : la prévision commerciale mérite une revue affaire par affaire.",
  indisponible: "Aucun modèle validé ne couvre encore ce mois.",
  non_conclu:
    "Les deux chiffres ne comptent pas les mêmes affaires : la prévision commerciale ne retient que celles portant une Projection Kanban sur le mois, la prévision RM Morning score tout le pipe ouvert. L'écart ne se lit donc pas comme un excès d'optimisme.",
};

/**
 * Compare la prévision RM Morning à la prévision commerciale.
 *
 * `null` quand l'un des deux manque : on n'invente pas une lecture.
 */
export function readForecast(
  expectedFinish: number | null,
  kanbanFinish: number | null,
): ForecastReading {
  if (!FORECAST_READING_ENABLED) return "non_conclu";
  if (expectedFinish == null || kanbanFinish == null || kanbanFinish <= 0) return "indisponible";
  const ratio = expectedFinish / kanbanFinish;
  if (ratio >= FORECAST_READING.coherent) return "coherent";
  if (ratio >= FORECAST_READING.ambitious) return "ambitieux";
  return "tres_ambitieux";
}

/**
 * « Chance de signer en septembre », à partir d'un libellé « septembre 2026 ».
 *
 * Nommer le mois évite la question « ce mois-ci ou le mois prochain ? » quand les
 * vues M et M+1 se ressemblent volontairement.
 */
export function chanceInMonth(monthLabel: string): string {
  return `Chance de signer en ${monthLabel.split(" ")[0]}`;
}

/** Format court en k€, espace insécable pour rester lisible dans un grand chiffre. */
export function kEur(value: number | null | undefined): string {
  if (value == null) return "—";
  const k = Math.round(value / 1000);
  const grouped = Math.abs(k)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${k < 0 ? "−" : ""}${grouped} k€`;
}

/** Pourcentage à une décimale, virgule française. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(digits).replace(".", ",")} %`;
}

/**
 * Le nom d'un client, tel qu'il doit s'afficher.
 *
 * Trois replis, dans cet ordre : le contact renseigné, le libellé de
 * l'opportunité amputé de sa prestation, puis une mention explicite. Jamais un
 * identifiant Salesforce, jamais une case vide — l'audit V1 a trouvé les deux :
 * un identifiant technique en guise de nom dans Expected, et une cellule vide
 * pour la seule affaire dont le contact n'est pas renseigné.
 *
 * Une case vide laisse croire à un défaut d'affichage ; « Client non renseigné »
 * dit ce qui manque et où le corriger.
 */
export function clientLabel(
  contact: string | null | undefined,
  opportunityName?: string | null,
): string {
  const c = (contact ?? "").trim();
  if (c) return c;
  const fromName = (opportunityName ?? "").split(/\s+[-–—]\s+/)[0].trim();
  if (fromName) return fromName;
  return "Client non renseigné";
}

/** Le commercial, quand l'affaire n'en porte aucun de l'équipe. */
export const UNKNOWN_SALESPERSON = "Commercial non identifié";

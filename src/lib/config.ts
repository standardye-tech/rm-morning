/**
 * RM Morning — configuration métier.
 *
 * Tout ce qui est susceptible de changer sans toucher au moteur vit ici :
 * équipe suivie, alias Salesforce, étapes terminées, couleurs Kanban, seuils.
 */

/** Équipe suivie. Le Morning Brief n'analyse QUE ces commerciaux. */
export type TeamMember = {
  /** Nom canonique affiché dans l'application. */
  name: string;
  /** Prénom utilisé dans les phrases d'action ("Challenger David sur ..."). */
  firstName: string;
  /**
   * Variantes telles qu'écrites dans Salesforce.
   * Inutile d'y lister les différences de casse ou d'accent : le matching est
   * fait sur une forme normalisée (minuscules, sans accents, sans tirets ni espaces).
   * On n'y met que les vraies divergences de patronyme.
   */
  aliases?: string[];
};

export const TEAM: TeamMember[] = [
  { name: "Anthony Ramaherison", firstName: "Anthony" },
  { name: "Mahery Raza", firstName: "Mahery", aliases: ["Mahery RAZAFINDRAZAKA"] },
  { name: "Guillaume Fontaine", firstName: "Guillaume F." },
  { name: "Mathis Coulon", firstName: "Mathis" },
  { name: "Daravith Chan Fah", firstName: "Daravith", aliases: ["Daravith CHAN-FAH"] },
  { name: "Vincent Bouzy", firstName: "Vincent B." },
  { name: "Jonathan Florville", firstName: "Jonathan" },
  { name: "Vincent Da Silva", firstName: "Vincent D." },
  { name: "David Bernstein", firstName: "David" },
  { name: "Stéphane Strat", firstName: "Stéphane" },
  { name: "Valentin Marion", firstName: "Valentin" },
  { name: "Guillaume Huc", firstName: "Guillaume H." },
  { name: "Sami Lazari", firstName: "Sami" },
];

/**
 * Étapes considérées comme terminées : l'opportunité est conservée et historisée
 * mais sort du pipe actif (ce n'est plus du stock à convertir).
 * Comparaison sur forme normalisée. "Signature" (90 %) reste du pipe actif.
 */
export const TERMINAL_STAGES = [
  "Signé",
  // Non présentes dans l'export actuel, prévues si elles apparaissent plus tard :
  "Perdu",
  "Annulé",
  "Fermé",
  "Closed Won",
  "Closed Lost",
];

/** Étape gagnée (sous-ensemble des étapes terminées), pour distinguer signé et perdu. */
export const WON_STAGES = ["Signé", "Closed Won"];

/**
 * Ordre d'avancement des étapes. Sert à définir la « phase avancée ».
 * Une étape inconnue reçoit le rang 0 et n'est jamais traitée comme avancée.
 */
export const STAGE_ORDER: Record<string, number> = {
  "Etude dossier": 1,
  "Examen estimation": 2,
  "Visite artisan": 3,
  "Examen devis": 4,
  Signature: 5,
  "Signé": 6,
};

/** Rang à partir duquel une opportunité est dite « en phase avancée ». */
export const ADVANCED_STAGE_RANK = 4; // Examen devis et au-delà

/**
 * Pastilles de la Projection Kanban.
 *
 * ATTENTION : la légende officielle Salesforce ne nous a pas été communiquée.
 * On ne devine pas la signification des couleurs — on se contente de les
 * identifier, et le poids ci-dessous n'est qu'une pondération de confiance
 * PROVISOIRE utilisée par le scoring. À corriger ici dès que la légende est connue.
 *
 * Une pastille absente de cette table (ex. celle détruite par l'export
 * ISO-8859-1 et remplacée par « ? ») est conservée telle quelle en base,
 * avec un poids neutre.
 */
export const KANBAN_COLORS: Record<string, { key: string; label: string; weight: number }> = {
  "\u{1F7E2}": { key: "vert", label: "Vert", weight: 1.0 },
  "\u{1F535}": { key: "bleu", label: "Bleu", weight: 1.0 },
  "\u{1F7E1}": { key: "jaune", label: "Jaune", weight: 0.6 },
  "\u{1F7E0}": { key: "orange", label: "Orange", weight: 0.35 },
  "\u{1F534}": { key: "rouge", label: "Rouge", weight: 0.2 },
};

/** Poids appliqué à une pastille présente mais non identifiable (ex. « ? »). */
export const KANBAN_UNKNOWN_WEIGHT = 0.5;

/**
 * Seuils métier. Volontairement regroupés et nommés pour rester discutables.
 */
export const THRESHOLDS = {
  /**
   * Benchmark de stock confortable par commercial.
   * HEURISTIQUE MÉTIER PROVISOIRE — ce n'est pas une vérité statistique.
   * À terme RM Morning devra apprendre le taux de transformation réel de chacun
   * à partir des snapshots historisés, et ce seuil deviendra un calcul.
   */
  activeGmvComfortable: 700_000,
  activeGmvLow: 600_000,

  /** GMV à partir de laquelle une opportunité est jugée « importante ». */
  bigDealGmv: 100_000,

  /** Jours sans activité au-delà desquels une opportunité est jugée dormante. */
  staleDays: 45,
  veryStaleDays: 90,

  /** Âge (depuis création) au-delà duquel le stock est jugé très ancien. */
  oldStockDays: 365,

  /** Nombre d'éléments affichés sur la page Morning. */
  maxTopDeals: 3,
  maxAlerts: 4,
  maxActions: 5,
} as const;

/**
 * Chemin du fichier SQLite, relatif à la racine du projet.
 *
 * `RM_DB_PATH` permet de le détourner vers une COPIE. C'est la seule façon de
 * faire tourner des contrôles qui écrivent — lecture du Monitoring, plan du jour
 * coché, historique de Performance — sans toucher à la base de travail. Aucun
 * usage en production : sans la variable, le chemin est celui d'origine.
 */
export const DB_PATH = process.env.RM_DB_PATH ?? "data/rm-morning.db";

/** Dossier scruté par ManualSalesforceSource pour trouver le dernier export. */
export const EXPORT_DIR = ".";

/**
 * Accès API Salesforce.
 *
 * L'authentification est déléguée à la CLI Salesforce déjà connectée en local :
 * RM Morning ne détient, ne stocke et ne journalise aucun jeton. Elle n'émet
 * que des lectures (`sobject describe` et `data query`).
 */
export const SALESFORCE_API = {
  /** Alias d'org de la CLI (`sf org login web --alias rm-morning`). */
  orgAlias: "rm-morning",

  sobject: "Opportunity",

  /**
   * Champs interrogés, validés lors de l'audit du 16/08/2026 contre l'export.
   * `Account.Billing*` fournit CP et ville (vérifié : le contact diverge parfois).
   */
  fields: [
    "Id",
    "Name",
    "Owner.Name",
    "TECHNomCompletClient__c",
    "Contact_client__r.Email",
    "Amount",
    "StageName",
    "Probability",
    "Projection_Kanban__c",
    "CreatedDate",
    "DateSignatureDevis__c",
    "LastModifiedDate",
    "Date_de_creation_de_la_piste__c",
    "LastActivityDate",
    "Canal_d_acquisition__c",
    "Prestation__c",
    "En_stand_by_jusqu_au__c",
    "En_stand_by__c",
    "Account.BillingPostalCode",
    "Account.BillingCity",
    "LeadSource",
  ],

  /**
   * Étapes retenues : exactement le périmètre du rapport Salesforce historique.
   * Vérifié le 16/08/2026 : ce filtre seul renvoie 760 lignes, comme l'export.
   * Le filtrage de l'équipe n'est PAS fait en SOQL — il reste dans le moteur
   * d'import, via le mapping d'alias de TEAM, commun aux deux sources.
   */
  stages: [
    "Etude dossier",
    "Examen estimation",
    "Visite artisan",
    "Examen devis",
    "Signature",
    "Signé",
  ],

  /**
   * Champs picklist dont la valeur technique doit être traduite en libellé
   * (`FLAT` → « Appartement »). La correspondance vient de `sobject describe`,
   * jamais d'une liste écrite à la main.
   */
  picklistFields: ["Canal_d_acquisition__c", "Prestation__c", "LeadSource", "StageName"],
} as const;

/** Commande à afficher à l'utilisateur si la session CLI a expiré. */
export const SALESFORCE_LOGIN_COMMAND = `sf org login web --alias ${SALESFORCE_API.orgAlias}`;

/**
 * Accès au Google Sheet de forecast via l'API Sheets, authentifié par un
 * compte de service. Le classeur reste privé : il est simplement partagé en
 * « Lecteur » avec l'adresse du compte de service. Lecture seule stricte.
 */
export const GOOGLE_SHEETS = {
  /** Clé JSON du compte de service. Dans `data/`, ignoré par Git. */
  keyFile: "data/google-service-account.json",

  /** Seul scope demandé. Ni Drive, ni Gmail, ni écriture. */
  scope: "https://www.googleapis.com/auth/spreadsheets.readonly",

  /** Onglets non mensuels à ignorer lors de la découverte. */
  ignoredTabs: ["Introduction"],

  /** Un onglet mensuel est nommé « AAAA-MM ». */
  monthTabPattern: /^\d{4}-\d{2}$/,
} as const;

/**
 * Google Sheet de forecast hebdomadaire (« Perspectives M »).
 *
 * Les onglets sont découverts via l'API. La fenêtre de mois ci-dessous ne sert
 * plus qu'aux sources de secours, qui ne savent pas lister les onglets.
 */
export const FORECAST_SHEET = {
  spreadsheetId: "1IvfzxZvStORqpiQsEWKp3VZZDb7MJxJlNpRYKvB0WX8",

  /**
   * Fenêtre d'onglets mensuels lue à chaque import, relative au mois courant.
   * Le classeur tourne sur trois mois ; on ratisse un peu plus large et les
   * onglets inexistants sont simplement ignorés.
   */
  monthsBack: 1,
  monthsForward: 3,

  /** Dossier des CSV déposés à la main, pour la source de secours. */
  manualDir: "forecast-exports",
} as const;

/** URL d'export CSV d'un onglet, par son nom. */
export function forecastSheetCsvUrl(sheetName: string): string {
  const id = FORECAST_SHEET.spreadsheetId;
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

/**
 * Seuils de comparaison entre le forecast déclaré et l'état Salesforce.
 * Volontairement peu nombreux, et tous discutables.
 */
/**
 * Lignes Travaux — source OFFICIELLE du GMV signé.
 *
 * Le rapport de pilotage du directeur régional somme `Montant__c` sur les lignes
 * dont le devis est signé dans le mois et dont le statut est « Signé » ou
 * « Réalisé ». Avenants, moins-values et annulations sont inclus, montants
 * négatifs compris : les exclure fabriquerait un chiffre qui n'existe nulle part.
 */
export const TRAVAUX = {
  /** Début de la fenêtre importée. */
  from: "2024-01-01",
  /** Statuts qui comptent dans le GMV signé officiel. */
  signedStatuses: ["Signé", "Réalisé"] as const,
} as const;

export const FORECAST_THRESHOLDS = {
  /** Variation de GMV considérée comme significative (montant ou proportion). */
  significantGmvDelta: 20_000,
  significantGmvRatio: 0.15,

  /** Baisse de confiance considérée comme une fragilisation (points de 0 à 1). */
  significantConfidenceDrop: 0.2,

  /** Nombre d'opportunités à challenger affichées dans le Bloc 2. */
  maxToChallenge: 3,
} as const;

/**
 * Qualification de l'écart entre Projection Kanban et Expected (Forecast V2).
 *
 * L'Expected est structurellement bien inférieur au déclaratif : au 17/08/2026
 * il en couvre 30 %. Comparer chaque commercial à l'égalité Kanban = Expected
 * les classerait donc tous en « forte divergence », ce qui ne dirait rien.
 * La référence est le taux de couverture RÉGIONAL, et l'on mesure l'écart de
 * chaque commercial à cette référence commune.
 *
 * Ces seuils posent une question de management. Ils ne jugent pas un commercial.
 */
/**
 * Priorité d'action du Morning.
 *
 * Ces poids ordonnent le plan du matin. Ils ne touchent JAMAIS la probabilité
 * Expected, qui reste la statistique pure : Gmail n'entre que dans la priorité
 * opérationnelle, faute d'assez d'historique pour backtester son apport.
 *
 * L'ordre voulu est celui du §9 : client motivé, client qui attend, affaire
 * décisive, affaire à challenger vivante, proche de la signature. Les poids de
 * base sont donc espacés pour que la catégorie domine, et les bonus servent
 * seulement à trancher à l'intérieur d'une catégorie.
 */
export const MORNING_PRIORITY = {
  weightMotivated: 1000,
  weightWaiting: 800,
  weightDecisive: 600,
  weightChallenge: 400,
  weightSignature: 300,

  /** Modulations internes à une catégorie. */
  weightFreshness: 120,
  weightGmv: 100,
  weightExpected: 80,
  bonusKanban: 30,
  bonusChallenge: 20,

  /** GMV au-delà duquel le poids montant est saturé. */
  gmvReference: 250_000,
  /** GMV à partir duquel une affaire du mois est jugée décisive. */
  decisiveGmv: 100_000,
  /** GMV probable au-delà duquel une affaire silencieuse est signalée à part. */
  strongExpected: 8_000,
} as const;

/**
 * Projection M+1 — paramètres issus de l'audit C8.1.
 *
 * Rien ici n'est un choix esthétique : chaque valeur a été retenue par le
 * backtest sur mois cible, et le rapport C8.1 en donne la mesure. Elles sont
 * regroupées ici pour qu'un ajustement n'oblige jamais à toucher un composant.
 *
 * `probabilityThreshold` est le seuil des lignes jaunes M+1 : 30,6 % de
 * précision et un lift de 5,4× sur le test, pour 2,8 suggestions par instantané.
 * Le nombre de lignes n'est PAS plafonné — le seuil fait varier le volume avec
 * la qualité réelle du pipe, ce qu'un Top N fixe ne sait pas faire.
 */
export const EXPECTED_M1 = {
  probabilityThreshold: 0.2,
  /** Poids du signal pipe dans l'ajustement (approche H4 shrinkage 50 %). */
  pipeWeight: 0.5,
  /** Bornes du multiplicateur, pour qu'un gros dossier ne déplace pas la Région. */
  strengthClamp: { lo: 0.6, hi: 1.5 },
  /** Plafond de contribution d'une affaire à l'index de force, en euros. */
  capPerDeal: 100_000,
  /** Quantiles 15/85 des ratios réel/projeté mesurés en C8.1. */
  range: { lo: 0.85, hi: 1.25 },
  /** Version de règle inscrite dans l'historisation des suggestions. */
  ruleVersion: "c8.1-m1-h4-50-seuil-20",
} as const;

/** Confiance déclarée par horizon. M+2 n'a aucun modèle validé. */
export const HORIZON_CONFIDENCE = {
  m: "élevée",
  m1: "moyenne",
  m2: "faible",
} as const;

export const FORECAST_DIVERGENCE = {
  /** Au-dessus de cette part du taux régional : lecture « proche ». */
  closeRatio: 0.8,
  /** En dessous : « forte divergence ». Entre les deux : « plus prudent ». */
  prudentRatio: 0.4,
  /** En deçà de cet écart absolu, aucune qualification n'est prononcée. */
  minGap: 50_000,
  /** Nombre maximal d'affaires listées dans le bloc « À examiner ». */
  maxToExamine: 5,
  /** Contribution Expected minimale pour signaler une affaire hors Kanban M. */
  minExpectedOutsideKanban: 4_000,
  /** GMV Kanban minimal pour signaler une affaire déclarée mais fragile. */
  minKanbanFragile: 80_000,
  /** Probabilité fin de mois en dessous de laquelle une affaire est fragile. */
  fragileProbability: 0.03,
} as const;

/**
 * Performance commerciale — le classement analytique.
 *
 * PARTI PRIS. Le classement ne récompense pas le GMV brut : un commercial à qui
 * l'on confie de plus gros dossiers serait mécaniquement premier, ce qui ne dit
 * rien de son travail. Chaque pilier mesure donc une chose différente — ce qu'il
 * produit, comment il traite ses pistes, comment il tient ses affaires, ce que
 * vaut son pipe futur — et les mesures de volume sont ramenées à un rang dans
 * l'équipe plutôt qu'à un montant.
 *
 * LES POIDS SONT UNE DÉCISION DE MANAGEMENT, pas un résultat statistique. Ils
 * sont ici pour être discutés et modifiés ; leur somme doit rester à 100, ce que
 * le moteur vérifie au démarrage.
 *
 * CINQUIÈME PILIER. « Réactivité client » est volontairement absent de la V1 :
 * mesurer un délai de réponse Gmail suppose de distinguer un mail client d'une
 * notification, un message qui appelle une réponse d'un simple accusé, et une
 * réponse dans un fil d'un nouveau message. Tant que cette distinction n'est pas
 * fiable, un score de réactivité serait faussement précis. L'architecture
 * l'accueille sans rien casser : ajouter un pilier consiste à ajouter une entrée
 * ici et à rééquilibrer les poids.
 */
/**
 * Version du modèle de score Performance.
 *
 * À CHANGER À CHAQUE MODIFICATION DE FORMULE — poids, barème, fenêtre, mesure
 * ajoutée ou retirée. Deux photos d'historique ne sont comparées que si elles
 * portent la même version : sans cela, une recalibration produirait des
 * « tendances » qui ne décrivent rien d'autre que le changement de règle, et
 * elles seraient indiscernables d'une vraie évolution commerciale.
 *
 *   v1  — modèle initial (13 mesures, fenêtre signé de 4 mois glissants).
 *   v2  — calibration : non mesuré = 50 % du poids, régularité sur mois clôturés
 *         au solde positif, retrait de « mois de signature dépassé », Pipeline
 *         8/8/7/7, taux d'affaires probables au lieu du comptage.
 *   v3  — fenêtre de production ramenée à l'année civile en cours (YTD) et
 *         ajout de la dynamique 3 mois. Les poids et barèmes de v2 sont inchangés.
 */
export const PERFORMANCE_MODEL_VERSION = "v3-ytd";

export const PERFORMANCE = {
  /** Poids des piliers, sur 100. */
  weights: {
    signed: 30,
    leads: 20,
    deals: 20,
    pipeline: 30,
  },

  /**
   * Fenêtre de la production signée : L'ANNÉE CIVILE EN COURS, du 1er janvier au
   * mois courant inclus.
   *
   * Le classement principal répond à « où en est-on cette année », qui est la
   * question que se pose le directeur régional. Une fenêtre glissante de quatre
   * mois répondait à autre chose — « comment va-t-il en ce moment » — et cette
   * question-là a désormais sa propre lecture, la dynamique 3 mois.
   *
   * Les trois autres piliers ne sont PAS ramenés à janvier, et c'est délibéré :
   * ils décrivent un ÉTAT, pas un cumul. La façon dont un commercial traite ses
   * pistes aujourd'hui ne se juge pas sur son mois de janvier, et son pipe futur
   * est par définition celui d'aujourd'hui. Le score YTD se lit donc :
   * production accumulée cette année + qualité commerciale actuelle + potentiel
   * futur actuel.
   */
  signedWindow: "annee-civile",

  /**
   * Dynamique 3 mois : nombre de mois CLÔTURÉS de chaque fenêtre.
   *
   * Les deux fenêtres sont faites de mois complets, et le mois en cours est
   * exclu des deux. Comparer un mois de vingt jours à des mois entiers ferait
   * apparaître un décrochage chez les treize commerciaux le 5 de chaque mois,
   * puis une envolée le 30 — un artefact de calendrier, pas une trajectoire.
   */
  dynamicWindowMonths: 3,

  /** Écart de score à partir duquel une progression ou un décrochage est signalé. */
  dynamicSignificantDelta: 5,

  /** Nombre maximal de commerciaux dans « Qui monte » et « Qui décroche ». */
  maxMovers: 3,

  /** Fenêtre d'observation des pistes, en jours. */
  leadWindowDays: 90,

  /**
   * Bornes du délai de prise en charge d'une piste, en heures.
   * En deçà de la première : note pleine. Au-delà de la seconde : zéro.
   * Repères tirés des mesures de C1 (p75 à 48,7 h, p90 à 98,5 h).
   */
  firstCallFastHours: 24,
  firstCallSlowHours: 96,

  /** Part d'anomalies vivantes au-delà de laquelle le sous-score est nul. */
  maxAnomalyRate: 0.25,
  /** Idem pour les First Calls manqués. */
  maxMissedRate: 0.15,
  /** Idem pour les opportunités stagnantes et les clients en attente. */
  maxStaleRate: 0.5,
  maxWaitingRate: 0.2,

  /** Jours sans mouvement au-delà desquels une affaire est dite stagnante. */
  stagnantDays: 45,

  /**
   * Lissage des taux calculés sur peu de dossiers.
   *
   * LE PROBLÈME, mesuré : un commercial avec une seule opportunité et aucune
   * anomalie obtenait 100/100 en gestion des opportunités, devant celui qui en
   * tient soixante avec trois retards. Un taux sur un dénominateur de 1 n'est
   * pas une performance, c'est un tirage.
   *
   * LA CORRECTION : chaque taux est tiré vers le taux de l'équipe d'autant plus
   * fort que le dossier est mince — comme si l'on ajoutait à chacun `smoothing`
   * dossiers fictifs se comportant comme la moyenne de l'équipe. À dix dossiers
   * l'effet est faible, à un il est décisif. C'est la façon la plus simple de
   * dire « on n'en sait pas encore assez sur lui » sans le pénaliser ni le
   * récompenser.
   *
   * Le taux BRUT reste celui affiché : le score est prudent, la mesure est vraie.
   */
  smoothing: 5,

  /** Nombre minimal de pistes prises en charge pour que le délai médian ait un sens. */
  minFirstCallSample: 3,

  /**
   * Note attribuée à une mesure réellement non mesurable, en part de son poids.
   *
   * POURQUOI PAS LA MÉDIANE D'ÉQUIPE, qui était la règle précédente : sur les
   * critères où « moins c'est mieux », la médiane de l'équipe vaut souvent le
   * meilleur score possible — zéro anomalie, zéro First Call manqué. Un
   * commercial sans aucune piste héritait donc de la note MAXIMALE sur deux
   * mesures, mesuré à 14,93 points sur 20 obtenus sans aucune donnée.
   *
   * Une donnée absente ne doit jamais produire un avantage compétitif. Elle ne
   * doit pas non plus produire une sanction : on ne sait rien, et ne rien savoir
   * n'est pas une faute. La moitié du poids est la seule position neutre — elle
   * ne peut ni faire gagner ni faire perdre des places à celui qu'on n'a pas pu
   * mesurer, et elle rend l'absence de donnée visible dans le score lui-même.
   */
  unmeasuredShare: 0.5,

  /** Chance de signer à partir de laquelle une affaire est dite « à forte probabilité ». */
  highProbability: 0.25,

  /**
   * Concentration du pipe futur. En deçà de la première borne, aucune pénalité :
   * qu'une affaire pèse un quart du pipe est normal. Au-delà de la seconde, le
   * pipe tient sur un seul dossier et le sous-score est nul.
   */
  concentrationFloor: 0.3,
  concentrationCeiling: 0.8,

  /**
   * Portefeuille minimal pour que la concentration ait un sens, en affaires
   * distinctes éligibles sur M et M+1.
   *
   * LE SEUIL EST DÉDUIT DU BARÈME, il n'est pas choisi au jugé. Avec n affaires,
   * la plus grosse pèse au mieux 1/n du pipe — même parfaitement équilibré. Donc :
   *
   *     n = 1 → part ≥ 100 %   n = 2 → ≥ 50 %   n = 3 → ≥ 33 %
   *     n = 4 → ≥ 25 %         n = 5 → ≥ 20 %
   *
   * Le barème accorde le plein score sous 30 %. À trois affaires, ce plein score
   * est donc MÉCANIQUEMENT inatteignable ; à quatre, il n'est atteint qu'en cas
   * de répartition parfaite. Cinq est le premier effectif où un commercial peut
   * réellement être bien noté sans que le hasard de son portefeuille décide à sa
   * place — et le premier où être mal noté signifie vraiment quelque chose.
   *
   * En dessous, la mesure est déclarée non mesurée : moitié du poids, position
   * neutre, exclue des commentaires. Mesuré sur les données du 20/08/2026, ce
   * seuil n'écarte qu'un seul commercial (1 affaire éligible) et conserve le cas
   * réellement concentré (7 affaires, 57 % sur une seule).
   */
  minConcentrationSample: 5,

  /**
   * Échantillon minimal pour qu'une mesure puisse justifier une PHRASE — point
   * fort, point de vigilance, commentaire automatique.
   *
   * Le score, lui, reste calculé : il est déjà rendu prudent par le lissage. Mais
   * un score prudent et une affirmation sont deux choses différentes. « 100 % de
   * ses pistes converties » sur une seule piste, ou « jalons parfaitement tenus »
   * sur une seule affaire, sont des phrases vraies au sens strict et fausses au
   * sens managérial : elles seront lues comme un jugement sur son travail alors
   * qu'elles décrivent un tirage. En dessous de ce seuil, la mesure compte dans
   * le score et s'affiche dans le détail avec son dénominateur, mais elle ne
   * parle pas.
   */
  minCommentSample: 5,
} as const;

/**
 * Ce que Forecast montre par défaut.
 *
 * Forecast n'est pas l'inventaire du pipe : c'est l'écran où l'on complète et
 * challenge la Perspective. Toutes les affaires scorées y remontaient, y compris
 * celles à 2 % de chance de signer, ce qui allongeait la feuille sans rien
 * apporter à la conversation.
 *
 * DEUX PORTES D'ENTRÉE, et deux seulement :
 *
 *   — le commercial la déclare sur le mois (Projection Kanban ou Perspective) —
 *     c'est son engagement, il est affiché quelle que soit la probabilité ;
 *   — RM Morning lui donne au moins `minProbability` de chance de signer sur le
 *     mois, d'après le modèle Expected GMV.
 *
 * La Probability Salesforce n'entre PAS dans cette règle. Elle est attachée à
 * l'étape, pas au dossier : elle vaut 40 % pour tout « Examen devis », qu'il
 * soit vivant ou mort. L'Expected, lui, est mesuré et backtesté.
 *
 * Les affaires écartées ne sont pas perdues : elles restent dépliables par
 * commercial, et « tout=1 » les rouvre toutes.
 */
export const FORECAST_VISIBILITY = {
  /** Chance de signer sur le mois à partir de laquelle une affaire s'affiche. */
  minProbability: 0.25,
} as const;

/**
 * OAuth Google pour Gmail, en lecture seule.
 *
 * Un seul compte est lu — celui du dirigeant, déjà en copie des échanges
 * clients de l'équipe. Les boîtes individuelles des commerciaux ne sont
 * jamais interrogées.
 */
export const GOOGLE_OAUTH = {
  /** Compte attendu. Sert de `login_hint` et de contrôle après autorisation. */
  account: "sami@renovationman.com",

  /** Scope unique. Aucune permission d'écriture n'est demandée. */
  scope: "https://www.googleapis.com/auth/gmail.readonly",

  /** Port fixe : Horizon-2031 occupe le 3000. */
  redirectUri: "http://localhost:3001/api/google/callback",

  authUri: "https://accounts.google.com/o/oauth2/auth",
  tokenUri: "https://oauth2.googleapis.com/token",
  gmailApi: "https://gmail.googleapis.com/gmail/v1",

  /** Jeton de rafraîchissement. Dans `data/`, ignoré par Git. */
  tokenFile: "data/google-gmail-token.json",

  /** Vérificateur PKCE, éphémère : écrit avant la redirection, supprimé après. */
  pendingFile: "data/.google-oauth-pending.json",
} as const;

/**
 * Synchronisation Gmail incrémentale.
 *
 * La boîte contient plus de 115 000 messages : elle n'est jamais parcourue en
 * entier. Chaque passage n'interroge qu'une fenêtre temporelle, et le curseur
 * (`mail_sync.window_end`) est stocké en base pour survivre au redémarrage.
 */
export const GMAIL_SYNC = {
  /**
   * Fenêtre du tout premier passage, quand aucun curseur n'existe encore.
   * Sept jours : assez pour couvrir un cycle commercial complet (relances,
   * allers-retours de devis) sans ouvrir un historique que rien n'exploite.
   */
  bootstrapDays: 7,

  /**
   * Chevauchement repris avant le curseur. Couvre les messages arrivés
   * pendant la synchronisation précédente et les latences d'indexation Gmail.
   * Sans risque : la clé primaire `gmail_message_id` absorbe les doublons.
   */
  overlapHours: 2,

  /** Garde-fou : un passage ne traite jamais plus de messages que cela. */
  maxMessagesPerRun: 600,

  /** Messages demandés en parallèle à l'API. Reste très en deçà des quotas. */
  concurrency: 8,

  /** Fils classés en parallèle. Plus bas : chaque fil peut appeler le modèle. */
  classifyConcurrency: 4,
} as const;

/**
 * Monitoring des pistes — seuils métier.
 *
 * PRINCIPE : le moteur juge le respect d'une ÉCHÉANCE, jamais l'inactivité
 * brute. Une piste dont l'échéance est future est protégée, quelle que soit
 * son inactivité apparente.
 *
 * Tous les seuils sont ici, et le périmètre équipe vient de `TEAM` : rien
 * n'est écrit en dur dans le moteur, pour qu'une autre direction régionale
 * puisse être branchée sans le réécrire.
 */
export const LEAD_MONITORING = {
  /**
   * Délai de grâce avant de signaler une piste sans First Call horodaté.
   * 72 h : au-delà, on est dans les 17 % les plus lents (p75 mesuré à 48,7 h,
   * p90 à 98,5 h sur 474 pistes réelles).
   */
  noAppointmentGraceHours: 72,

  /** Paliers de retard après échéance dépassée, en heures. */
  lateAfterHours: 24,
  criticalAfterHours: 168, // 7 jours

  /**
   * Au-delà, une anomalie est de la dette manifeste plutôt qu'un incident de
   * traitement courant. Sert à l'affichage, pas au verdict.
   */
  legacyDebtDays: 30,

  /** Fenêtre d'import des pistes, en jours. */
  importWindowDays: 180,

  /** Objets de tâches purement automatiques : jamais une preuve de traitement. */
  automatedTaskPattern:
    /créneau de rappel|bienvenue chez renovation man|votre estimation est disponible|votre devis est disponible|trustpilot/i,

  /** Longueur minimale d'une consignation pour être jugée réelle. */
  minConsignationLength: 15,

  /** Nombre d'éléments du bloc « À traiter maintenant ». */
  maxTodoItems: 8,

  /** Actions Pistes autorisées dans les 5 actions du Morning. */
  maxMorningActions: 2,
} as const;

/**
 * Monitoring des opportunités — seuils de jalons.
 *
 * Séparés de ceux des pistes et séparés entre eux : estimation et devis
 * partagent aujourd'hui la même valeur, mais rien ne garantit qu'ils la
 * partageront demain.
 */
export const OPPORTUNITY_MONITORING = {
  /** Délai maximal avant la PREMIÈRE relance après envoi, en jours. */
  estimationSlaDays: 5,
  devisSlaDays: 5,

  /**
   * Sans jalon connu ni action client, l'opportunité devient candidate au
   * dormant. Seuil PROVISOIRE, sans fondement métier mesuré — contrairement
   * au délai de grâce des pistes. À revoir par étape quand l'historique
   * 24 mois le permettra.
   */
  dormantAfterDays: 45,

  /** Jours au-delà desquels un client sans réponse est signalé. */
  clientWaitingAfterDays: 3,

  /** Éléments du bloc « À débloquer maintenant ». */
  maxValueItems: 8,

  /** Exceptions Opportunités autorisées dans les 5 actions du Morning. */
  maxMorningActions: 2,

  /**
   * Couverture minimale attendue par type de preuve. En dessous, un template
   * Salesforce a probablement été renommé : alerte TECHNIQUE, jamais
   * commerciale.
   */
  minEvidence: {
    estimation_envoyee: 50,
    devis_envoye: 20,
    rappel_dedie: 50,
    appel_consigne: 50,
    visite_expert_travaux: 10,
    visite_artisan: 5,
  } as Record<string, number>,
} as const;

/**
 * Dataset historique Expected GMV (C4).
 *
 * Les bornes de disponibilité ne sont pas des choix mais des mesures : elles
 * viennent de l'audit des sources et doivent être révisées si la couverture
 * change.
 */
export const EXPECTED_GMV_DATASET = {
  /** Fenêtre d'observation. 24 mois pleins de créations mesurés. */
  from: "2024-08-01",

  /**
   * Les activités ne deviennent denses qu'au troisième trimestre 2025 :
   * 18 tâches au T3 2024 contre 6 743 au T3 2025. Avant cette date, les
   * jalons sont marqués indisponibles — jamais « absents ».
   */
  milestonesFrom: "2025-07-01",

  /**
   * Premier snapshot Perspective réellement stocké. Cinq semaines d'historique
   * ne permettent aucune feature déclarative : conservé pour mémoire.
   */
  kanbanFrom: "2026-07-13",

  /** Découpage temporel, appliqué à la DATE D'OBSERVATION. */
  trainUntil: "2025-12-31",
  validationUntil: "2026-04-30",
} as const;

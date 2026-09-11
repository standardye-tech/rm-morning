# RM Morning

Brief commercial du matin : pipe actif, projection et actions du jour, à partir
de l'export Salesforce.

## Démarrer

```bash
npm run dev
```

L'application écoute sur `http://localhost:3000` (un autre port est utilisé si
3000 est déjà pris).

## Charger les données

**Source principale — API Salesforce.** Cliquer sur **Synchroniser Salesforce**
depuis la page Morning ou Données.

L'authentification est déléguée à la CLI Salesforce, connectée une fois pour toutes :

```bash
sf org login web --alias rm-morning
```

RM Morning ne détient, ne stocke, ne journalise et n'affiche aucun jeton, et
n'émet que des lectures (`sobject describe`, `data query`). Si la session
expire, l'application affiche « Connexion Salesforce requise » avec la commande
à relancer — elle ne casse pas.

**Fallback — export de fichier.** Déposer un export `report*.xls` à la racine
du projet et cliquer sur **Importer le fichier .xls** depuis la page Données.

Chaque chargement crée un snapshot daté du jour : les jours précédents ne sont
jamais écrasés. Recharger le même jour corrige uniquement la photo du jour courant.

## Vérifier la lecture des données

```bash
node scripts/verify.mjs
```

Relit la base SQLite et recalcule les agrégats à la main, sans passer par le code
de l'application.

Pour comparer deux sources (par exemple API contre fichier) :

```bash
node scripts/compare-sources.mjs capture etat.json
```

puis, après avoir rechargé depuis l'autre source :

```bash
node scripts/compare-sources.mjs compare etat.json
```

## Structure

```
src/lib/config.ts       équipe suivie, alias, seuils, couleurs Kanban — tout le paramétrable
src/lib/normalize.ts    dates FR, montants FR, Projection Kanban, rattachement équipe
src/lib/sources/        SalesforceSource (API + fichier), ForecastSnapshotSource, MailSource
src/lib/db.ts           SQLite (node:sqlite) — trois tables
src/lib/import.ts       normalisation, filtrage équipe, snapshot quotidien
src/lib/metrics.ts      pipe actif par commercial
src/lib/scoring.ts      Top 3, alertes, actions du matin
src/lib/forecast.ts     comparaison hebdomadaire (Bloc 2)
```

Le format du fichier Salesforce (HTML déguisé en `.xls`, ISO-8859-1) n'est connu
que de `src/lib/sources/manual-salesforce.ts` ; l'accès API n'est connu que de
`src/lib/sources/api-salesforce.ts`. Les deux produisent le même modèle
normalisé : le moteur de reporting ignore d'où viennent les données.

## Règles métier

- **Signé** : conservé et historisé, exclu du pipe actif.
- **Stand-by** : le champ Salesforce `En stand-by jusqu'au`. Tant que la date de
  réveil est future, l'opportunité sort du pipe actif ; la GMV et la date de
  réveil restent conservées. À l'échéance, elle revient automatiquement.
- **Date de signature du devis** : jamais utilisée comme prévision (la majorité
  des opportunités ouvertes portent artificiellement la fin du mois courant).
- **Projection Kanban** : seul signal de projection aujourd'hui. Valeur brute,
  mois, année et pastille sont stockés ; la signification des couleurs est
  configurable dans `config.ts` et n'est pas devinée. L'API restitue les
  pastilles intactes, là où l'export ISO-8859-1 détruisait ⚪ en `?`.

## Forecast hebdomadaire (Google Sheet)

Le classeur « Perspectives M » porte un onglet par mois (`2026-08`) et un bloc de
colonnes par snapshot du lundi.

**Source principale — API Google Sheets, compte de service.** Le classeur reste
**privé** : il est simplement partagé en « Lecteur » avec l'adresse du compte de
service. Les onglets sont découverts automatiquement ; `Introduction` est ignoré.
Seul le scope `spreadsheets.readonly` est demandé — ni Drive, ni Gmail, ni
écriture. Bouton **Importer le forecast**, page Données.

La clé JSON vit dans `data/google-service-account.json` (ignoré par Git). Elle
n'est lue qu'en mémoire pour signer l'assertion JWT, jamais journalisée ni
affichée, et le jeton d'accès obtenu n'est pas persisté.

Deux secours restent disponibles : `ManualForecastSnapshotSource` lit des CSV
déposés dans `forecast-exports/` (un fichier par onglet, `2026-08.csv`), et
`HttpForecastSnapshotSource` lit l'export gviz si le classeur est un jour
partagé par lien. Les trois passent par le même parseur.

Le snapshot de référence est le plus récent **≤ aujourd'hui** pour le mois
courant ; un snapshot futur n'est jamais retenu. Le précédent sert à lire la
trajectoire. Le rapprochement avec Salesforce se fait par ID sur 15 caractères.

Une affaire présente au forecast mais absente de Salesforce est signalée comme
**écart à investiguer** — jamais comptée perdue d'office.

```bash
node scripts/verify-forecast.mjs
```

## Ma semaine (moteur de recommandation managériale)

Page `/semaine`. Répond à une seule question : cette semaine, où le directeur
régional doit-il investir son temps ? Ce n'est pas un agenda : Google Calendar
garde les blocs, RM Morning dit lesquels remplir, avec qui et pour obtenir quoi.

Deux lectures par Expert Travaux, jamais confondues :

- **Performance** — comment il va commercialement. Score de la page Performance,
  paliers vert / neutre / orange. Jamais de rouge.
- **Attention managériale** — faut-il intervenir maintenant. Vert (rien de
  particulier), orange (intervention utile), rouge (intervention prioritaire).
  Un ET rouge n'est pas un mauvais ET.

Le moteur (`src/lib/attention.ts`) est pur : sept règles nommées, chacune pesée
« fort » ou « modéré », et un verdict qui découle du nombre et du poids des
raisons — rouge dès une raison forte accompagnée d'une autre ou deux fortes,
orange dès une forte ou deux modérées, vert sinon. Une raison modérée isolée est
affichée, pas planifiée. Tous les seuils sont dans `config.ts` (`ATTENTION`).
Le directeur (`ATTENTION.excluded`) n'est pas évalué ; ses affaires restent
éligibles aux gros dossiers.

Les changements d'étape ne sont observables que depuis le premier snapshot
quotidien : une immobilité est toujours dite « depuis au moins N jours », jamais
plus (`src/lib/stage-history.ts`).

- **Gros dossiers** (`big-deals.ts`, seuils `BIG_DEALS`) : ≥ 100 k€ et au moins
  un critère de maturité ; objectif closer / débloquer / accélérer / arbitrer.
- **Affaire de la semaine** (`deal-of-week-recommend.ts`, `deal-of-week-store.ts`,
  table `deal_of_week`) : RM Morning propose une affaire et deux alternatives,
  Sami arbitre. Présélection lisible (active, ≥ 10 k€, ET du périmètre,
  activité récente, ni dormante ni gros dossier), points nommés par critère
  (étape, mouvement, montant, prochaine étape floue, attention de l'ET),
  pénalités d'historique tirées de la table, diversité d'ET et d'angle. L'angle
  de challenge est suggéré d'après l'étape et reste modifiable. Ignorer la
  semaine est un choix enregistré, jamais une affaire imposée. Le choix manuel
  parmi tout le pipe reste disponible en secours.
- **Planning recommandé** (`week-plan.ts`, grille `WEEK_SLOTS`) : chaque
  créneau-type reçoit le meilleur élément de son type ; un créneau vide est
  réaffecté dans l'ordre `WEEK_FALLBACK_ORDER`, sinon affiché disponible. Rien
  n'est rempli artificiellement.
- **Radar** (`radar-store.ts`, table `radar_contact`) : pipeline commun ET /
  architectes, saisi à la main. Ni HelloWork, ni Google, ni scraping.

```bash
npm run semaine:verify
```

## Non branché à ce stade

Gmail : seule l'interface `MailSource` existe.

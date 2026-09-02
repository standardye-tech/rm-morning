/**
 * Accès SQLite via `node:sqlite` (module natif de Node, aucune dépendance,
 * aucune compilation native). Le schéma tient ici, en entier.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { DB_PATH } from "./config";

let instance: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at     TEXT NOT NULL,
  snapshot_date   TEXT NOT NULL,
  source_kind     TEXT NOT NULL,
  source_label    TEXT NOT NULL,
  file_name       TEXT,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  team_rows       INTEGER NOT NULL DEFAULT 0,
  active_rows     INTEGER NOT NULL DEFAULT 0,
  signed_rows     INTEGER NOT NULL DEFAULT 0,
  standby_rows    INTEGER NOT NULL DEFAULT 0,
  detected_fields TEXT NOT NULL DEFAULT '[]',
  missing_fields  TEXT NOT NULL DEFAULT '[]',
  raw_headers     TEXT NOT NULL DEFAULT '[]',
  issues          TEXT NOT NULL DEFAULT '[]'
);

-- État courant d'une opportunité de l'équipe suivie (écrasé à chaque import).
CREATE TABLE IF NOT EXISTS opportunity (
  opportunity_id       TEXT PRIMARY KEY,
  name                 TEXT,
  client_contact       TEXT,
  client_email         TEXT,
  owner                TEXT NOT NULL,
  owner_raw            TEXT,
  gmv                  REAL,
  stage                TEXT,
  probability          INTEGER,
  kanban_raw           TEXT,
  kanban_color         TEXT,
  kanban_color_raw     TEXT,
  kanban_month         INTEGER,
  kanban_year          INTEGER,
  created_at           TEXT,
  lead_created_at      TEXT,
  quote_signature_date TEXT,
  last_activity_at     TEXT,
  last_modified_at     TEXT,
  postal_code          TEXT,
  city                 TEXT,
  acquisition_channel  TEXT,
  lead_source          TEXT,
  service              TEXT,
  standby_until        TEXT,
  standby_flag         INTEGER,
  is_signed            INTEGER NOT NULL DEFAULT 0,
  is_terminal          INTEGER NOT NULL DEFAULT 0,
  is_standby           INTEGER NOT NULL DEFAULT 0,
  is_active            INTEGER NOT NULL DEFAULT 0,
  -- Date du premier import où l'affaire n'était plus publiée par la source, et
  -- pourquoi. Non nul = sortie du périmètre actif (abandon, annulation, reprise
  -- par un commercial hors équipe). Remis à NULL si elle réapparaît.
  absent_since         TEXT,
  absent_reason        TEXT,
  first_seen_on        TEXT NOT NULL,
  last_import_id       INTEGER NOT NULL
);

-- Historique : une ligne par opportunité et par jour. Jamais écrasé d'un jour
-- à l'autre ; un ré-import le même jour corrige la photo du jour courant.
CREATE TABLE IF NOT EXISTS opportunity_snapshot (
  snapshot_date    TEXT NOT NULL,
  opportunity_id   TEXT NOT NULL,
  import_id        INTEGER NOT NULL,
  owner            TEXT NOT NULL,
  gmv              REAL,
  stage            TEXT,
  probability      INTEGER,
  kanban_raw       TEXT,
  kanban_color     TEXT,
  kanban_month     INTEGER,
  kanban_year      INTEGER,
  last_activity_at TEXT,
  standby_until    TEXT,
  is_standby       INTEGER NOT NULL DEFAULT 0,
  is_signed        INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_date, opportunity_id)
);

-- Snapshots hebdomadaires du forecast déclaré (Google Sheet).
-- Signal distinct de la Projection Kanban Salesforce : jamais fusionnés, pour
-- pouvoir mesurer plus tard leur cohérence et la fiabilité de chaque commercial.
CREATE TABLE IF NOT EXISTS forecast_snapshot (
  snapshot_date     TEXT NOT NULL,
  forecast_month    TEXT NOT NULL,
  row_key           TEXT NOT NULL,
  opportunity_id    TEXT,
  salesperson       TEXT,
  salesperson_raw   TEXT,
  region            TEXT,
  opportunity_label TEXT,
  confidence        REAL,
  gmv               REAL,
  ca                REAL,
  projected_gmv     REAL,
  state             TEXT,
  source            TEXT NOT NULL,
  imported_at       TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, forecast_month, row_key)
);

-- Signaux mail retenus après filtrage. Une ligne par message conservé.
-- AUCUN corps de message n'est stocké : uniquement des identifiants, des
-- métadonnées d'en-tête, le verdict du filtre et le rattachement.
CREATE TABLE IF NOT EXISTS mail_signal (
  gmail_message_id  TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL,
  sent_at           TEXT,
  from_email        TEXT,
  from_name         TEXT,
  subject           TEXT,
  direction         TEXT,
  filter_rule       TEXT,
  opportunity_id    TEXT,
  match_level       TEXT,
  match_reason      TEXT,
  salesperson       TEXT,
  signal_type       TEXT NOT NULL DEFAULT 'non_classifie',
  signal_confidence REAL,
  blocker           TEXT,
  summary           TEXT,
  classifier        TEXT,
  analyzed_at       TEXT,
  sync_id           INTEGER
);

-- Pistes Salesforce. État courant, écrasé à chaque import.
-- Les colonnes de preuve (consignation, dernière action valide) sont
-- calculées à l'import : le moteur ne relit jamais LastActivityDate, jugé
-- circulaire à l'audit.
CREATE TABLE IF NOT EXISTS lead (
  lead_id             TEXT PRIMARY KEY,
  name                TEXT,
  owner               TEXT NOT NULL,
  owner_raw           TEXT,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  recall_date         TEXT,
  converted_date      TEXT,
  converted_opportunity_id TEXT,
  abandoned_at        TEXT,
  abandon_reason      TEXT,
  acquisition_channel TEXT,
  service             TEXT,
  postal_code         TEXT,
  city                TEXT,
  first_call_at       TEXT,
  next_appointment_at TEXT,
  consigned_at        TEXT,
  consigned_by        TEXT,
  last_action_at      TEXT,
  operational_status  TEXT NOT NULL,
  flag_reason         TEXT,
  lateness_hours      INTEGER NOT NULL DEFAULT 0,
  first_call_missed   INTEGER NOT NULL DEFAULT 0,
  -- Date à laquelle RM Morning a constaté l'anomalie pour la première fois.
  anomaly_since       TEXT,
  -- 1 = anomalie déjà présente à l'activation du Monitoring (dette héritée).
  is_legacy           INTEGER NOT NULL DEFAULT 0,
  first_seen_on       TEXT NOT NULL,
  last_import_id      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_owner ON lead (owner);
CREATE INDEX IF NOT EXISTS idx_lead_status ON lead (operational_status);
CREATE INDEX IF NOT EXISTS idx_lead_created ON lead (created_at);

-- Photo quotidienne, pour comparer aujourd'hui, hier, la semaine et le mois.
CREATE TABLE IF NOT EXISTS lead_snapshot (
  snapshot_date      TEXT NOT NULL,
  lead_id            TEXT NOT NULL,
  owner              TEXT NOT NULL,
  status             TEXT NOT NULL,
  operational_status TEXT NOT NULL,
  lateness_hours     INTEGER NOT NULL DEFAULT 0,
  is_legacy          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_date, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_snapshot_date ON lead_snapshot (snapshot_date);

-- Une seule ligne : la date d'activation du Monitoring. C'est elle qui sépare
-- la dette héritée des exceptions réellement observées par RM Morning.
CREATE TABLE IF NOT EXISTS monitoring_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  activated_at             TEXT NOT NULL,
  opportunities_activated_at TEXT
);

-- Couverture des libellés Salesforce à chaque import de jalons.
-- Sert UNIQUEMENT à détecter un template renommé : c'est une alerte technique,
-- jamais une exception commerciale.
CREATE TABLE IF NOT EXISTS milestone_coverage (
  checked_at TEXT PRIMARY KEY,
  counters   TEXT NOT NULL,
  degraded   TEXT NOT NULL DEFAULT '[]'
);

-- Dataset historique Expected GMV (C4). Aucun modèle : uniquement des
-- observations « état à T → résultat réel après T ». Colonnes explicites
-- plutôt qu'un JSON opaque : l'auditabilité passe avant l'élégance.
CREATE TABLE IF NOT EXISTS expected_gmv_observation (
  observation_date  TEXT NOT NULL,
  opportunity_id    TEXT NOT NULL,
  owner             TEXT NOT NULL,
  observation_kind  TEXT NOT NULL,

  -- état du pipe à T, reconstruit d'OpportunityHistory
  stage             TEXT,
  amount            REAL,
  age_days          INTEGER,
  days_in_stage     INTEGER,
  stage_changes     INTEGER,

  -- attributs de l'affaire
  acquisition_channel TEXT,
  lead_source       TEXT,
  service           TEXT,
  postal_code       TEXT,
  city              TEXT,

  -- saisonnalité
  month             INTEGER,
  iso_week          INTEGER,
  day_of_month      INTEGER,
  days_left_in_month INTEGER,

  -- jalons, disponibles depuis juillet 2025 seulement
  estimation_sent_at TEXT,
  days_since_estimation INTEGER,
  estimation_relance_at TEXT,
  estimation_relance_delay_days INTEGER,
  devis_sent_at     TEXT,
  days_since_devis  INTEGER,
  devis_relance_at  TEXT,
  devis_relance_delay_days INTEGER,
  visit_et_past     INTEGER,
  visit_et_future   INTEGER,
  visit_artisan_past INTEGER,
  visit_artisan_future INTEGER,

  -- déclaratif : aucun historique exploitable, colonnes réservées
  kanban_month      TEXT,
  kanban_weeks_on_month INTEGER,

  -- disponibilité des sources : « indisponible » n'est jamais « n'a pas eu lieu »
  milestones_available INTEGER NOT NULL,
  kanban_history_available INTEGER NOT NULL,
  gmail_available   INTEGER NOT NULL,
  standby_available INTEGER NOT NULL,

  -- labels
  signed_within_7d  INTEGER NOT NULL,
  signed_by_month_end INTEGER NOT NULL,
  actual_signature_at TEXT,
  days_to_signature REAL,
  final_outcome     TEXT NOT NULL,

  dataset_split     TEXT NOT NULL,
  PRIMARY KEY (observation_date, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_obs_split ON expected_gmv_observation (dataset_split);
CREATE INDEX IF NOT EXISTS idx_obs_owner ON expected_gmv_observation (owner);
CREATE INDEX IF NOT EXISTS idx_obs_opp ON expected_gmv_observation (opportunity_id);

-- Journal des reconstructions du dataset.
CREATE TABLE IF NOT EXISTS expected_gmv_build (
  built_at      TEXT PRIMARY KEY,
  window_from   TEXT NOT NULL,
  window_to     TEXT NOT NULL,
  opportunities INTEGER NOT NULL,
  observations  INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  notes         TEXT NOT NULL DEFAULT '[]'
);

-- Scoring live Expected GMV. Écrit par la commande npm expected:score, jamais
-- par l'application : l'interface ne fait que lire. Un scoring est immuable, on
-- en empile un par exécution et l'interface lit le plus récent.
CREATE TABLE IF NOT EXISTS expected_gmv_snapshot (
  scored_at               TEXT PRIMARY KEY,
  as_of_date              TEXT NOT NULL,
  month                   TEXT NOT NULL,
  days_left               INTEGER NOT NULL,
  source_observation_date TEXT NOT NULL,
  model_version           TEXT NOT NULL,
  model_7d                TEXT NOT NULL,
  model_month_end         TEXT NOT NULL,
  scored_count            INTEGER NOT NULL,
  open_gmv                REAL NOT NULL,
  expected_7d             REAL NOT NULL,
  signed_to_date          REAL NOT NULL,
  expected_remaining      REAL NOT NULL,
  sim_mean                REAL,
  sim_p10                 REAL,
  sim_p50                 REAL,
  sim_p90                 REAL,
  draws                   INTEGER NOT NULL,
  reliability             TEXT NOT NULL DEFAULT '{}'
);

-- Une ligne par opportunité et par scoring. Les deux horizons cohabitent dans
-- la ligne mais restent deux colonnes distinctes : jamais de probabilité
-- combinée.
CREATE TABLE IF NOT EXISTS expected_gmv_score (
  scored_at          TEXT NOT NULL,
  opportunity_id     TEXT NOT NULL,
  opportunity_id_18  TEXT NOT NULL,
  owner              TEXT NOT NULL,
  stage              TEXT,
  amount             REAL,
  amount_bin         TEXT,
  age_days           REAL,
  days_in_stage      REAL,
  stage_changes      INTEGER,
  days_left_in_month INTEGER,
  p_7d               REAL NOT NULL,
  p_month_end        REAL NOT NULL,
  expected_7d        REAL NOT NULL,
  expected_month_end REAL NOT NULL,
  factors            TEXT NOT NULL DEFAULT '[]',
  is_standby         INTEGER NOT NULL DEFAULT 0,
  standby_until      TEXT,
  -- Contribution neutralisée par la règle stand-by : la probabilité du modèle
  -- est conservée telle quelle, seule la contribution est mise à zéro.
  frozen_7d          INTEGER NOT NULL DEFAULT 0,
  frozen_month_end   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scored_at, opportunity_id)
);

-- Signé à date du mois scoré, mesuré sur actual_signature_at et non sur
-- quote_signature_date, qui est vide pour les mois passés.
CREATE TABLE IF NOT EXISTS expected_gmv_signed (
  scored_at      TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  owner          TEXT NOT NULL,
  gmv            REAL NOT NULL,
  signed_at      TEXT NOT NULL,
  PRIMARY KEY (scored_at, opportunity_id)
);

-- Observation « aujourd'hui » : l'état Salesforce réellement importé, mis en
-- forme de features. Reconstruite à chaque scoring, jamais historisée : ce
-- n'est pas un jeu d'apprentissage et elle ne porte aucun label.
CREATE TABLE IF NOT EXISTS expected_gmv_today (
  opportunity_id      TEXT PRIMARY KEY,
  built_at            TEXT NOT NULL,
  observation_date    TEXT NOT NULL,
  data_as_of          TEXT NOT NULL,
  history_as_of       TEXT NOT NULL,
  owner               TEXT NOT NULL,
  stage               TEXT,
  amount              REAL,
  age_days            REAL,
  days_in_stage       REAL,
  stage_changes       INTEGER,
  acquisition_channel TEXT,
  lead_source         TEXT,
  service             TEXT,
  postal_code         TEXT,
  city                TEXT,
  month               INTEGER,
  iso_week            INTEGER,
  day_of_month        INTEGER,
  days_left_in_month  INTEGER,
  stage_source        TEXT NOT NULL,
  stage_since         TEXT,
  is_standby          INTEGER NOT NULL DEFAULT 0,
  standby_until       TEXT
);

-- Lignes Travaux Salesforce (Travaux__c). SOURCE OFFICIELLE du GMV signé.
--
-- Distinction essentielle, établie à l'audit C10 : l'Opportunity porte un
-- ÉVÉNEMENT de signature, la ligne Travaux porte le MONTANT. Une opportunité a
-- n lignes Travaux — l'originale, ses avenants, ses annulations — et le GMV
-- officiel est leur somme, montants négatifs compris.
CREATE TABLE IF NOT EXISTS travaux (
  travaux_id           TEXT PRIMARY KEY,
  opportunity_id       TEXT,
  name                 TEXT,
  opportunity_name     TEXT,
  owner_raw            TEXT,
  signature_date       TEXT,
  gmv                  REAL,
  revenue              REAL,
  works_type           TEXT,
  works_status         TEXT,
  cancels_travaux_id   TEXT,
  last_modified_at     TEXT,
  first_seen_at        TEXT NOT NULL,
  last_import_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_travaux_opp ON travaux (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_travaux_signature ON travaux (signature_date, works_status);

-- Projection régionale M+1 (C8.1). Une ligne par génération.
--
-- La projection n'est PAS une extrapolation du modèle du mois en cours : elle
-- part du niveau historique officiel de l'équipe et l'ajuste de façon bornée
-- selon la force du pipe observable. Elle vit donc dans sa propre table, avec
-- ses propres métriques de fiabilité, pour qu'aucune lecture ne puisse la
-- confondre avec la prévision du mois.
CREATE TABLE IF NOT EXISTS expected_m1_snapshot (
  generated_at         TEXT PRIMARY KEY,
  observation_date     TEXT NOT NULL,
  target_month         TEXT NOT NULL,
  rule_version         TEXT NOT NULL,
  baseline             REAL NOT NULL,
  strength             REAL NOT NULL,
  multiplier           REAL NOT NULL,
  projection           REAL NOT NULL,
  range_lo             REAL NOT NULL,
  range_hi             REAL NOT NULL,
  confidence           TEXT NOT NULL,
  -- Hors de cette plage, la force du pipe est une extrapolation : l'interface
  -- doit le dire au lieu de publier un chiffre muet.
  calibrated_lo        REAL,
  calibrated_hi        REAL,
  strength_in_range    INTEGER NOT NULL,
  open_gmv             REAL NOT NULL,
  scored_count         INTEGER NOT NULL,
  probability_threshold REAL NOT NULL,
  data_as_of           TEXT,
  reliability          TEXT NOT NULL
);

-- Probabilité de signature officielle en M+1, affaire par affaire.
CREATE TABLE IF NOT EXISTS expected_m1_score (
  generated_at         TEXT NOT NULL,
  opportunity_id       TEXT NOT NULL,
  owner                TEXT,
  stage                TEXT,
  amount               REAL,
  p_m1                 REAL NOT NULL,
  expected_gmv         REAL NOT NULL,
  is_standby           INTEGER,
  standby_until        TEXT,
  PRIMARY KEY (generated_at, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_m1score_owner ON expected_m1_score (generated_at, owner);

-- Historisation DURABLE des suggestions M+1, exigée par C11 §10.
--
-- La validation historique de C8.1 ne porte que sur trois mois cibles. Attendre
-- douze mois avant de commencer à mesurer reviendrait à ne jamais savoir si le
-- seuil de 20 % tient. Chaque génération est donc conservée avec son contexte
-- déclaratif, et l'issue est renseignée une fois le mois cible terminé.
CREATE TABLE IF NOT EXISTS expected_m1_suggestion (
  snapshot_date        TEXT NOT NULL,
  opportunity_id       TEXT NOT NULL,
  target_month         TEXT NOT NULL,
  owner                TEXT,
  gmv                  REAL,
  probability          REAL NOT NULL,
  expected_gmv         REAL NOT NULL,
  declared_kanban      INTEGER NOT NULL,
  in_perspective       INTEGER NOT NULL,
  suggested_yellow     INTEGER NOT NULL,
  rule_version         TEXT NOT NULL,
  recorded_at          TEXT NOT NULL,
  -- Renseignés après la clôture du mois cible, par le même script.
  outcome_signed       INTEGER,
  outcome_gmv          REAL,
  outcome_recorded_at  TEXT,
  PRIMARY KEY (snapshot_date, opportunity_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_m1sugg_target ON expected_m1_suggestion (target_month, suggested_yellow);

-- Actualisation globale : une ligne par exécution du bouton unique.
--
-- Sert trois choses distinctes, et c'est pourquoi elle est persistante plutôt
-- qu'en mémoire :
--   1. le verrou — deux actualisations simultanées liraient et écriraient les
--      mêmes tables dans un ordre imprévisible ;
--   2. la cohérence temporelle — la colonne sources répond à la question
--      "sur quelles versions exactes des données ce Morning est-il construit ?" ;
--   3. la mémoire du dernier état valide, conservé séparément d'un échec, pour
--      qu'une tentative interrompue ne fasse jamais croire que tout est à jour.
--
-- heartbeat_at est réécrit à chaque étape. Un processus tué net laisse une ligne
-- en cours dont le battement s'arrête : c'est ce qui permet de détecter un verrou
-- mort au lieu de le subir indéfiniment.
CREATE TABLE IF NOT EXISTS global_sync_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  heartbeat_at  TEXT NOT NULL,
  status        TEXT NOT NULL,
  current_step  TEXT,
  duration_ms   INTEGER,
  trigger_kind  TEXT NOT NULL DEFAULT 'ui',
  error         TEXT,
  warnings      TEXT NOT NULL DEFAULT '[]',
  sources       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sync_run_status ON global_sync_run (status, started_at);

CREATE TABLE IF NOT EXISTS global_sync_step (
  run_id       INTEGER NOT NULL,
  step_key     TEXT NOT NULL,
  position     INTEGER NOT NULL,
  label        TEXT NOT NULL,
  blocking     INTEGER NOT NULL,
  status       TEXT NOT NULL,
  started_at   TEXT,
  completed_at TEXT,
  duration_ms  INTEGER,
  detail       TEXT,
  error        TEXT,
  PRIMARY KEY (run_id, step_key)
);

-- Photographie du pipe rattachée à l'IMPORT et non au jour.
--
-- Correction additive du défaut identifié en C12 : opportunity_snapshot a pour
-- clé (snapshot_date, opportunity_id), donc deux imports le même jour écrasent
-- l'un l'autre et l'état intermédiaire est perdu. Cette table conserve chaque
-- import séparément, ce qui rendra les journées à plusieurs imports
-- reconstructibles pour les modèles futurs.
--
-- L'ancienne table n'est PAS touchée : les lectures existantes continuent de
-- fonctionner à l'identique.
CREATE TABLE IF NOT EXISTS opportunity_snapshot_run (
  import_id        INTEGER NOT NULL,
  opportunity_id   TEXT NOT NULL,
  imported_at      TEXT NOT NULL,
  snapshot_date    TEXT NOT NULL,
  owner            TEXT NOT NULL,
  gmv              REAL,
  stage            TEXT,
  probability      INTEGER,
  kanban_raw       TEXT,
  kanban_month     INTEGER,
  kanban_year      INTEGER,
  created_at       TEXT,
  acquisition_channel TEXT,
  service          TEXT,
  last_activity_at TEXT,
  standby_until    TEXT,
  is_standby       INTEGER NOT NULL DEFAULT 0,
  is_signed        INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (import_id, opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_run_opp ON opportunity_snapshot_run (opportunity_id, imported_at);
CREATE INDEX IF NOT EXISTS idx_snapshot_run_date ON opportunity_snapshot_run (snapshot_date);

-- Annuaire des adresses vues dans Gmail, résolues vers Salesforce (C13).
--
-- CIBLÉ, jamais exhaustif : l'org compte 86 000 pistes et 37 650 contacts. On ne
-- résout que les adresses réellement apparues dans la boîte, ce qui représente
-- quelques dizaines de lignes. Interroger tout l'annuaire serait long, inutile et
-- ferait grossir la base sans bénéfice.
--
-- Cette table répond à une question que la table opportunity ne peut pas
-- résoudre : elle ne contient que le pipe courant. Un client qui écrit à propos
-- d'un chantier en cours ou d'un projet terminé n'y figure pas, et son message
-- restait « affaire non identifiée » alors que Salesforce sait parfaitement qui il
-- est. Le champ resolved_kind dit dans quel état se trouve l'affaire, pour que
-- Morning ne présente jamais un GMV déjà signé comme du pipe à aller chercher.
CREATE TABLE IF NOT EXISTS mail_directory (
  email                 TEXT PRIMARY KEY,
  resolved_kind         TEXT NOT NULL,
  confidence            TEXT NOT NULL,
  reason                TEXT NOT NULL,
  opportunity_id        TEXT,
  opportunity_name      TEXT,
  opportunity_stage     TEXT,
  opportunity_is_closed INTEGER,
  opportunity_amount    REAL,
  opportunity_owner     TEXT,
  lead_id               TEXT,
  lead_name             TEXT,
  lead_owner            TEXT,
  lead_status           TEXT,
  contact_id            TEXT,
  contact_name          TEXT,
  candidates            TEXT NOT NULL DEFAULT '[]',
  first_seen_at         TEXT NOT NULL,
  refreshed_at          TEXT NOT NULL
);

-- Mémoire de rattachement par fil, et validations manuelles.
--
-- Le fil primer sur l'expéditeur : un même client peut avoir plusieurs projets, et
-- une nouvelle conversation doit pouvoir désigner une autre affaire que la
-- précédente. Une validation manuelle porte donc sur le fil, et n'est jamais
-- écrasée par une inférence automatique.
CREATE TABLE IF NOT EXISTS mail_thread_link (
  thread_id      TEXT PRIMARY KEY,
  opportunity_id TEXT,
  lead_id        TEXT,
  kind           TEXT NOT NULL,
  source         TEXT NOT NULL,
  confidence     TEXT NOT NULL,
  is_manual      INTEGER NOT NULL DEFAULT 0,
  confirmed_at   TEXT NOT NULL,
  first_linked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_link_opp ON mail_thread_link (opportunity_id);

-- Journal DURABLE des signatures réelles, daté par la première transition
-- OpportunityHistory vers une étape post-signature. Jamais reconstruit, jamais
-- effacé : contrairement à expected_gmv_observation, qui est régénéré à chaque
-- reconstruction du dataset, cette table accumule l'historique dont une V2
-- M+1/M+2 aura besoin dans douze à dix-huit mois.
CREATE TABLE IF NOT EXISTS signature_event (
  opportunity_id      TEXT PRIMARY KEY,
  signed_at           TEXT NOT NULL,
  gmv                 REAL,
  owner               TEXT,
  stage_before        TEXT,
  acquisition_channel TEXT,
  service             TEXT,
  postal_code         TEXT,
  created_at          TEXT,
  -- Délai création → signature, en jours.
  days_to_sign        INTEGER,
  first_recorded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signature_event_month ON signature_event (signed_at);

-- Morning V2. Une ligne par message Gmail que le Morning a retenu, avec son
-- état de prise en compte. C'est un état PROPRE à RM Morning : le lu/non-lu de
-- Gmail ne dit rien du travail commercial, et rien n'est jamais écrit dans
-- Gmail.
--
-- Acquitter porte sur un MESSAGE, jamais sur un client : si le même client
-- réécrit, le nouveau message revient au Morning suivant.
CREATE TABLE IF NOT EXISTS morning_event (
  gmail_message_id TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL,
  sent_at          TEXT,
  category         TEXT NOT NULL,
  reason           TEXT NOT NULL,
  opportunity_id   TEXT,
  match_level      TEXT,
  status           TEXT NOT NULL DEFAULT 'nouveau',
  acknowledged_at  TEXT,
  first_seen_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_morning_event_status ON morning_event (status, sent_at);

-- Curseur de lecture du Morning : jusqu'où le directeur régional a déjà lu.
-- Distinct du curseur de synchronisation Gmail, qui avance tout seul.
CREATE TABLE IF NOT EXISTS morning_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_read_at TEXT
);

-- Plan du jour : les actions déjà faites. L'état porte sur une JOURNÉE, pas sur
-- une affaire : le plan est reconstruit chaque matin depuis les données du jour,
-- et une action cochée hier doit pouvoir revenir aujourd'hui si le motif
-- persiste. C'est la différence avec morning_event, qui acquitte un message une
-- fois pour toutes.
CREATE TABLE IF NOT EXISTS morning_action_done (
  action_key TEXT NOT NULL,
  done_on    TEXT NOT NULL,
  done_at    TEXT NOT NULL,
  PRIMARY KEY (action_key, done_on)
);

-- Monitoring — état de lecture d'un élément de liste, et photo des champs vus
-- au moment de la lecture.
--
-- DEUX RÔLES, tenus par la même ligne :
--   — masquer ce qui a été lu, pour que la liste puisse revenir à vide ;
--   — retenir CE QUI ÉTAIT AFFICHÉ, pour ne remonter l'élément que si une
--     valeur a réellement changé, et pouvoir désigner laquelle.
--
-- La signature (fingerprint) est un objet JSON champ vers valeur, volontairement
-- restreint aux champs de décision : une durée de retard, qui augmente toute
-- seule, en est exclue, sinon tout serait « modifié » à chaque minute.
CREATE TABLE IF NOT EXISTS monitoring_read (
  scope       TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  read_at     TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (scope, item_id)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_read_scope ON monitoring_read (scope);

-- Historique du classement Performance. Une photo par jour et par commercial :
-- c'est la même cadence que opportunity_snapshot, donc la même façon de
-- comparer « aujourd'hui » à « la dernière fois ». Les sous-scores sont
-- historisés avec le score global pour qu'une évolution de rang puisse toujours
-- être expliquée après coup.
CREATE TABLE IF NOT EXISTS performance_snapshot (
  snapshot_date TEXT NOT NULL,
  salesperson   TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  rank          INTEGER NOT NULL,
  score         REAL NOT NULL,
  signed_score  REAL NOT NULL,
  leads_score   REAL NOT NULL,
  deals_score   REAL NOT NULL,
  pipeline_score REAL NOT NULL,
  metrics       TEXT NOT NULL DEFAULT '{}',
  -- Version du modèle de scoring. Deux photos ne sont comparées que si elles
  -- portent la même : sans cela, une recalibration se lirait comme une tendance.
  model_version TEXT,
  -- Dynamique 3 mois de production, historisée avec le score.
  score_recent   REAL,
  score_previous REAL,
  dynamic_delta  REAL,
  PRIMARY KEY (snapshot_date, salesperson)
);

CREATE INDEX IF NOT EXISTS idx_performance_snapshot_date ON performance_snapshot (snapshot_date);

CREATE INDEX IF NOT EXISTS idx_egscore_owner ON expected_gmv_score (scored_at, owner);

CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_signal (thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_opportunity ON mail_signal (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_mail_sent ON mail_signal (sent_at);

-- Journal des synchronisations Gmail. Sert aussi de curseur : la fenêtre
-- suivante repart du window_end de la dernière synchro terminée.
CREATE TABLE IF NOT EXISTS mail_sync (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  window_start      TEXT NOT NULL,
  window_end        TEXT NOT NULL,
  seen              INTEGER NOT NULL DEFAULT 0,
  excluded          INTEGER NOT NULL DEFAULT 0,
  kept              INTEGER NOT NULL DEFAULT 0,
  matched_certain   INTEGER NOT NULL DEFAULT 0,
  matched_probable  INTEGER NOT NULL DEFAULT 0,
  matched_uncertain INTEGER NOT NULL DEFAULT 0,
  errors            TEXT NOT NULL DEFAULT '[]'
);

-- ÉTAT COURANT du forecast déclaré — bloc « EN COURS » du classeur.
--
-- Table SÉPARÉE de forecast_snapshot, et c'est tout l'intérêt : l'historique
-- hebdomadaire est immuable, alors que cet état-ci est remplacé à chaque
-- lecture. Les mélanger revenait à fabriquer chaque jour un faux snapshot, ou
-- à écraser le vrai snapshot du lundi par des valeurs de milieu de semaine.
--
-- La clé ne porte donc PAS de date : une ligne par (mois, opportunité), et
-- updated_at dit de quand date la fraîcheur annoncée par le classeur.
CREATE TABLE IF NOT EXISTS forecast_current (
  forecast_month    TEXT NOT NULL,
  row_key           TEXT NOT NULL,
  opportunity_id    TEXT,
  salesperson       TEXT,
  salesperson_raw   TEXT,
  region            TEXT,
  opportunity_label TEXT,
  confidence        REAL,
  gmv               REAL,
  ca                REAL,
  projected_gmv     REAL,
  state             TEXT,
  -- « MAJ le 02/09/2026 08:00 » tel qu'annoncé par le classeur.
  updated_at        TEXT,
  source            TEXT NOT NULL,
  imported_at       TEXT NOT NULL,
  PRIMARY KEY (forecast_month, row_key)
);

CREATE INDEX IF NOT EXISTS idx_forecast_current_opp ON forecast_current (opportunity_id);

-- PÉRIMÈTRE COMMERCIAL — source de vérité unique de l'équipe RM Morning.
--
-- Amorcée depuis la graine TEAM de config.ts au premier démarrage, puis gérée
-- depuis l'écran Données. Retirer un commercial met active à 0 : la ligne est
-- conservée, aucune donnée Salesforce n'est touchée, et le réactiver fait
-- revenir son historique tel quel.
CREATE TABLE IF NOT EXISTS team_member (
  member_key   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  first_name   TEXT NOT NULL,
  aliases      TEXT NOT NULL DEFAULT '[]',
  -- 'idf' restreint le périmètre aux chantiers franciliens ; NULL = aucune
  -- restriction. Le champ utilisé est le code postal (voir territory.ts).
  territory    TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

-- Commerciaux RENCONTRÉS dans les sources, en équipe ou non. Alimente la liste
-- de choix de l'écran d'équipe, pour n'avoir jamais à saisir un nom à la main.
-- Purement indicatif : aucune ligne ici n'entre dans le périmètre.
CREATE TABLE IF NOT EXISTS team_candidate (
  member_key   TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sources      TEXT NOT NULL DEFAULT '[]',
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forecast_month ON forecast_snapshot (forecast_month, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_forecast_opp ON forecast_snapshot (opportunity_id);

CREATE INDEX IF NOT EXISTS idx_snapshot_date ON opportunity_snapshot (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snapshot_owner ON opportunity_snapshot (owner, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_opportunity_owner ON opportunity (owner);
`;

/**
 * Migrations additives. `CREATE TABLE IF NOT EXISTS` ne modifie pas une table
 * existante : on ajoute ici les colonnes apparues après coup, sans jamais
 * toucher aux données déjà historisées.
 */
function migrate(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info(opportunity)")
    .all() as { name: string }[];
  if (!columns.some((c) => c.name === "standby_flag")) {
    db.exec("ALTER TABLE opportunity ADD COLUMN standby_flag INTEGER");
  }
  //  préexiste au Passage C2 : la colonne d'activation
  // des opportunités doit être ajoutée, pas recréée.
  const stateColumns = db
    .prepare("PRAGMA table_info(monitoring_state)")
    .all() as { name: string }[];
  if (stateColumns.length > 0 && !stateColumns.some((c) => c.name === "opportunities_activated_at")) {
    db.exec("ALTER TABLE monitoring_state ADD COLUMN opportunities_activated_at TEXT");
  }

  // Jalons C2. Colonnes additives sur  : aucune table nouvelle,
  // les KPI se recalculent par agrégation.
  const milestoneColumns: [string, string][] = [
    ["estimation_sent_at", "TEXT"],
    ["estimation_relance_at", "TEXT"],
    ["devis_sent_at", "TEXT"],
    ["devis_relance_at", "TEXT"],
    ["last_visit_at", "TEXT"],
    ["next_visit_at", "TEXT"],
    ["visit_kind", "TEXT"],
    ["last_human_action_at", "TEXT"],
    ["next_expected_event", "TEXT"],
    ["next_expected_due_at", "TEXT"],
    ["milestone_status", "TEXT"],
    ["milestone_reason", "TEXT"],
    ["milestone_lateness_hours", "INTEGER"],
    ["client_waiting", "INTEGER"],
    ["milestone_anomaly_since", "TEXT"],
    ["milestone_is_legacy", "INTEGER"],
  ];
  for (const [name, type] of milestoneColumns) {
    if (!columns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE opportunity ADD COLUMN ${name} ${type}`);
    }
  }

  const snapshotColumns = db
    .prepare("PRAGMA table_info(opportunity_snapshot)")
    .all() as { name: string }[];
  for (const [name, type] of [
    ["milestone_status", "TEXT"],
    ["next_expected_event", "TEXT"],
    ["milestone_lateness_hours", "INTEGER"],
    ["milestone_is_legacy", "INTEGER"],
    // C9 — la photo quotidienne doit se suffire à elle-même pour reconstituer
    // plus tard le flux de créations : sans la date de création ni le canal, la
    // composante « pipe futur » de M+1/M+2 restait non mesurable sans
    // réinterroger Salesforce.
    ["created_at", "TEXT"],
    ["acquisition_channel", "TEXT"],
    ["service", "TEXT"],
  ] as [string, string][]) {
    if (!snapshotColumns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE opportunity_snapshot ADD COLUMN ${name} ${type}`);
    }
  }

  if (!columns.some((c) => c.name === "client_email")) {
    db.exec("ALTER TABLE opportunity ADD COLUMN client_email TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_opportunity_email ON opportunity (client_email)");
  }

  // C13 — l'adresse de la piste. Elle existe dans Salesforce (Lead.Email, 85 996
  // pistes sur 86 028) mais n'était pas importée : un client qui écrit alors que
  // son dossier est encore une piste ne pouvait donc être identifié d'aucune façon.
  // C13 — ce que le message désigne, et la piste quand il n'y a pas d'affaire.
  // Sans ces colonnes, Morning ne pouvait pas distinguer « affaire du pipe » de
  // « chantier en cours » ni afficher une piste identifiée.
  const signalColumns = db.prepare("PRAGMA table_info(mail_signal)").all() as { name: string }[];
  for (const [name, type] of [
    ["match_kind", "TEXT"],
    ["lead_id", "TEXT"],
  ] as [string, string][]) {
    if (signalColumns.length > 0 && !signalColumns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE mail_signal ADD COLUMN ${name} ${type}`);
    }
  }

  const leadColumns = db.prepare("PRAGMA table_info(lead)").all() as { name: string }[];
  if (leadColumns.length > 0 && !leadColumns.some((c) => c.name === "email")) {
    db.exec("ALTER TABLE lead ADD COLUMN email TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_lead_email ON lead (email)");
  }

  // C6.1 — fraîcheur des sources du scoring. La table existait déjà sans ces
  // colonnes : elles s'ajoutent, l'historique des scorings n'est pas effacé.
  const snapshotCols = db
    .prepare("PRAGMA table_info(expected_gmv_snapshot)")
    .all() as { name: string }[];
  for (const [name, type] of [
    ["data_as_of", "TEXT"],
    ["history_as_of", "TEXT"],
    ["stage_from_import", "INTEGER"],
    ["standby_count", "INTEGER"],
    ["standby_gmv", "REAL"],
    ["standby_frozen_month_end", "INTEGER"],
  ] as [string, string][]) {
    if (snapshotCols.length > 0 && !snapshotCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE expected_gmv_snapshot ADD COLUMN ${name} ${type}`);
    }
  }

  // C7 — traçabilité du gel stand-by, ajoutée sur des tables déjà créées.
  const scoreCols = db.prepare("PRAGMA table_info(expected_gmv_score)").all() as { name: string }[];
  for (const [name, type] of [
    ["is_standby", "INTEGER"],
    ["standby_until", "TEXT"],
    ["frozen_7d", "INTEGER"],
    ["frozen_month_end", "INTEGER"],
  ] as [string, string][]) {
    if (scoreCols.length > 0 && !scoreCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE expected_gmv_score ADD COLUMN ${name} ${type}`);
    }
  }
  const todayCols = db.prepare("PRAGMA table_info(expected_gmv_today)").all() as { name: string }[];
  if (todayCols.length > 0 && !todayCols.some((c) => c.name === "standby_until")) {
    db.exec("ALTER TABLE expected_gmv_today ADD COLUMN standby_until TEXT");
  }

  // Historisation Performance : version du modèle et dynamique 3 mois.
  //
  // Les photos antérieures gardent une version NULLE. C'est volontaire : elles
  // ont été calculées avec un modèle différent, et les relire comme si elles
  // étaient comparables produirait des tendances qui ne décrivent qu'un
  // changement de formule. Une version nulle n'est jamais rapprochée d'une autre.
  const perfCols = db.prepare("PRAGMA table_info(performance_snapshot)").all() as {
    name: string;
  }[];
  for (const [name, type] of [
    ["model_version", "TEXT"],
    ["score_recent", "REAL"],
    ["score_previous", "REAL"],
    ["dynamic_delta", "REAL"],
  ] as [string, string][]) {
    if (perfCols.length > 0 && !perfCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE performance_snapshot ADD COLUMN ${name} ${type}`);
    }
  }

  // Sortie du périmètre source. La requête Salesforce ne ramène que six étapes :
  // une affaire abandonnée, annulée ou reprise par un commercial hors équipe
  // cesse simplement d'apparaître dans l'import. Sans ces deux colonnes, sa
  // dernière étape connue restait figée en base et elle continuait à peser dans
  // le pipe — c'est la cause générique des « fantômes » du Forecast.
  for (const [name, type] of [
    ["absent_since", "TEXT"],
    ["absent_reason", "TEXT"],
  ] as [string, string][]) {
    if (!columns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE opportunity ADD COLUMN ${name} ${type}`);
    }
  }
}

export function getDb(): DatabaseSync {
  if (instance) return instance;

  // Chemin résolu à l'exécution : base locale, jamais empaquetée.
  const file = path.resolve(/* turbopackIgnore: true */ process.cwd(), DB_PATH);

  // GARDE ANTI-BASE VIDE.
  //
  // `new DatabaseSync(file)` crée le fichier s'il n'existe pas, et `db.exec(SCHEMA)`
  // le peuple de tables vides. En local c'est exactement ce qu'on veut : la
  // première exécution amorce la base. En production, où la base vit sur un
  // volume monté, c'est un piège — un montage raté donnerait une application qui
  // démarre normalement, affiche zéro partout, et que la première actualisation
  // remplirait de données fraîches. Il y aurait alors deux bases divergentes, et
  // rien pour le signaler.
  //
  // `RM_REQUIRE_DB=1` interdit ce cas. La variable n'est posée que dans l'image
  // de production : en développement, le comportement d'amorçage est inchangé.
  if (process.env.RM_REQUIRE_DB === "1" && !existsSync(file)) {
    throw new Error(
      `Base introuvable : ${file}. RM_REQUIRE_DB=1 interdit d'en créer une vide. ` +
        `Vérifiez que le volume est monté et que la base de production y a bien été déposée.`,
    );
  }

  mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  // Le serveur Next et les scripts Python de scoring écrivent dans la même base,
  // et l'application est désormais ouverte depuis plusieurs appareils. Sans délai
  // d'attente, une écriture qui tombe pendant une transaction concurrente reçoit
  // SQLITE_BUSY immédiatement au lieu de patienter. Cinq secondes couvrent très
  // largement les transactions du projet, toutes courtes.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);

  instance = db;
  return db;
}

/** Lignes retournées par node:sqlite (valeurs SQLite brutes). */
export type Row = Record<string, string | number | bigint | null | Uint8Array>;

export function queryAll<T = Row>(sql: string, ...params: unknown[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...(params as never[])) as T[];
}

export function queryOne<T = Row>(sql: string, ...params: unknown[]): T | null {
  return (getDb()
    .prepare(sql)
    .get(...(params as never[])) as T | undefined) ?? null;
}

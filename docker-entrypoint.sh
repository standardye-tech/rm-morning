#!/bin/sh
#
# RM Morning — démarrage en conteneur.
#
# Ce script a UNE responsabilité principale : refuser de démarrer plutôt que de
# démarrer sur une base vide. Sans lui, un volume mal monté produirait une
# application qui s'ouvre normalement, affiche zéro partout, et que la première
# actualisation remplirait de données fraîches — laissant deux bases divergentes
# sans qu'aucune alerte ne le dise.
#
# Aucun secret n'est écrit dans la sortie standard : les valeurs sont redirigées
# vers des fichiers, et les commandes qui pourraient les recracher sont muettes.

set -eu

log()  { printf '[rm-morning] %s\n' "$*"; }
fail() { printf '[rm-morning] ARRÊT — %s\n' "$*" >&2; exit 1; }

DATA_DIR="${RM_DATA_DIR:-/data}"
DB_FILE="${RM_DB_PATH:-$DATA_DIR/rm-morning.db}"
SENTINEL="$DATA_DIR/.rm-volume-ok"

log "démarrage — données dans $DATA_DIR"

# --- 1. Le volume est-il monté et amorcé ? ----------------------------------

[ -d "$DATA_DIR" ] || fail "$DATA_DIR n'existe pas : le volume n'est pas monté."

[ -f "$SENTINEL" ] || fail \
  "sentinelle $SENTINEL absente. Soit le volume n'est pas celui de production, soit la première mise en service n'a pas été faite. Aucune base ne sera créée."

[ -f "$DB_FILE" ] || fail \
  "base $DB_FILE absente alors que la sentinelle est présente. Volume incomplet — transfert interrompu ? Aucune base ne sera créée."

# --- 2. La base a-t-elle du contenu ? ---------------------------------------
# Ouverture en lecture seule : ce contrôle ne doit rien créer, rien migrer,
# rien réparer. Une base présente mais vide est aussi dangereuse qu'une base
# absente — c'est exactement le scénario « deux bases divergentes ».

OPP_COUNT="$(sqlite3 -readonly "$DB_FILE" 'SELECT COUNT(*) FROM opportunity;' 2>/dev/null || echo "ERREUR")"

case "$OPP_COUNT" in
  ERREUR|"")
    fail "base $DB_FILE illisible ou sans table 'opportunity'. Fichier corrompu ou non initialisé."
    ;;
  0)
    fail "base $DB_FILE lisible mais VIDE (0 opportunité). Refus de démarrer : ce serait la base vide silencieuse."
    ;;
esac

log "base vérifiée — $OPP_COUNT opportunité(s)"

# --- 3. Fichiers indispensables au scoring ----------------------------------
# `dataset-cache` porte un nom trompeur : ce ne sont pas des caches jetables.
# `build-expected-today.mjs` sort en erreur s'ils manquent, ce qui fait échouer
# l'étape BLOQUANTE « Prévision du mois », donc toute l'actualisation. Mieux vaut
# le découvrir ici, au démarrage, que le lendemain matin.

for f in dataset-cache/history.json dataset-cache/opportunities.json; do
  [ -f "$DATA_DIR/$f" ] || fail \
    "$DATA_DIR/$f absent. L'étape « Prévision du mois » échouerait. Transférez le dossier dataset-cache sur le volume."
done

# Artefacts lus par `expected_gmv_score.py --phase score`. La liste vient d'un
# relevé EXHAUSTIF des lectures `ARTIFACTS / …` dans les scripts du chemin
# d'actualisation, pas des seuls fichiers évidents :
#   — les deux .joblib sont chargés par joblib au début du scoring ;
#   — les deux .json d'évaluation sont lus par `reliability()`, tout à la FIN,
#     sans aucune garde. Leur absence a fait échouer la production le 23/08 après
#     que le scoring ait pourtant tourné en entier. Ils sont ici pour que cet
#     échec se produise désormais au démarrage, avec un message explicite.
for f in expected-gmv/model-7d.joblib \
         expected-gmv/model-monthend.joblib \
         expected-gmv/forecast-evaluation.json \
         expected-gmv/evaluation.json; do
  [ -f "$DATA_DIR/$f" ] || fail \
    "$DATA_DIR/$f absent. Le scoring Expected GMV échouerait : modèles figés ou métriques de fiabilité manquants."
done

[ -f "$DATA_DIR/google-gmail-token.json" ] \
  || log "AVERTISSEMENT — jeton Gmail absent du volume : l'étape « Emails » échouera (non bloquante)."

log "fichiers de scoring présents"

# --- 4. Compte de service Google, reconstruit en éphémère --------------------
# Écrit hors du volume, dans le disque racine de la machine : le secret ne
# survit pas à un redéploiement et ne se retrouve dans aucune sauvegarde.
# Le chemin est imposé par GOOGLE_SERVICE_ACCOUNT_FILE.

if [ -n "${GOOGLE_SERVICE_ACCOUNT_JSON:-}" ]; then
  SA_FILE="${GOOGLE_SERVICE_ACCOUNT_FILE:-/run/secrets/google-service-account.json}"
  mkdir -p "$(dirname "$SA_FILE")"
  chmod 700 "$(dirname "$SA_FILE")"
  ( umask 077; printf '%s' "$GOOGLE_SERVICE_ACCOUNT_JSON" > "$SA_FILE" )
  if [ -s "$SA_FILE" ]; then
    log "compte de service Google reconstruit dans $SA_FILE"
  else
    fail "écriture du compte de service Google vide — secret mal formé ?"
  fi
else
  log "AVERTISSEMENT — GOOGLE_SERVICE_ACCOUNT_JSON absent : l'étape « Perspective » échouera (non bloquante)."
fi

# --- 5. Session Salesforce --------------------------------------------------
# Rejouée à CHAQUE démarrage, donc idempotente : une session perdue se répare
# par un simple redémarrage, sans intervention.
#
# La sortie de `sf` est intégralement supprimée. Ce n'est pas de la paranoïa :
# en cas d'URL malformée, la CLI la recopie dans son message d'erreur, et les
# journaux Fly sont conservés. Pour diagnostiquer, ouvrir une session avec
# `fly ssh console` et rejouer la commande à la main.

if [ -n "${SF_AUTH_URL:-}" ]; then
  ( umask 077; printf '%s' "$SF_AUTH_URL" > /tmp/sf-auth-url )
  if sf org login sfdx-url \
       --sfdx-url-file /tmp/sf-auth-url \
       --alias "${SF_ORG_ALIAS:-rm-morning}" \
       >/dev/null 2>&1
  then
    log "Salesforce connecté — alias ${SF_ORG_ALIAS:-rm-morning}"
  else
    log "AVERTISSEMENT — connexion Salesforce refusée. Les étapes Salesforce échoueront. Diagnostic : fly ssh console."
  fi
  rm -f /tmp/sf-auth-url
else
  log "AVERTISSEMENT — SF_AUTH_URL absent : aucune session Salesforce."
fi

# --- 6. Démarrage -----------------------------------------------------------
# `exec` pour que Next reçoive directement SIGTERM et referme SQLite proprement.
# `--hostname 0.0.0.0` explicite : Fly route vers l'interface interne, pas vers
# la boucle locale.

log "lancement de Next.js sur 0.0.0.0:${PORT:-3001}"
exec node_modules/.bin/next start --hostname 0.0.0.0 --port "${PORT:-3001}"

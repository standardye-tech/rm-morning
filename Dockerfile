# RM Morning — image de production.
#
# TROIS RUNTIMES DANS LE MÊME CONTENEUR, et c'est délibéré : l'orchestrateur
# d'actualisation lance des processus enfants Python et Node via `execFile`.
# Séparer ces runtimes obligerait à réécrire `src/lib/sync/steps.ts`, donc à
# toucher à la logique métier. L'image est plus lourde ; l'application est
# identique à celle qui tourne en local.
#
# BASE PYTHON, PAS BASE NODE. Les modèles `.joblib` ont été produits sous
# Python 3.14 avec scikit-learn 1.9.0. Coller à la version exacte supprime toute
# question de compatibilité de sérialisation. Node est ajouté par-dessus.
#
# PAS DE `output: "standalone"`. `scripts/build-expected-today.mjs` importe
# `src/lib/*.ts` à l'exécution (via `ts-resolver.mjs` et `--experimental-strip-types`)
# et résout tout depuis `process.cwd()`. Un build standalone n'embarque ni `src/`
# ni `scripts/` : l'étape bloquante « Prévision du mois » échouerait.

FROM python:3.14-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NEXT_TELEMETRY_DISABLED=1

# --- 1. Outils système et Node 24 ------------------------------------------
# Node 24 est requis : `node:sqlite` / `DatabaseSync` n'y est stable qu'à partir
# de cette version, et le poste de développement tourne en 24.19.
# `sqlite3` sert aux contrôles de l'entrypoint et aux opérations manuelles.
# `tini` récolte les processus enfants : sans init, les `execFile` de
# l'orchestrateur laisseraient des zombies sur un conteneur qui vit des mois.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sqlite3 tini \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*

# --- 2. Pile scientifique Python -------------------------------------------
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && rm -f /tmp/requirements.txt

# --- 3. CLI Salesforce ------------------------------------------------------
# Version épinglée sur celle du poste de développement (2.147.7).
RUN npm install -g @salesforce/cli@2.147.7 \
 && npm cache clean --force

WORKDIR /app

# --- 4. Dépendances npm -----------------------------------------------------
# Avant le code source : la couche reste en cache tant que le lockfile ne bouge
# pas. NODE_ENV n'est PAS encore à `production` — `next build` a besoin des
# devDependencies (TypeScript, Tailwind, eslint-config-next).
COPY package.json package-lock.json ./
RUN npm ci

# --- 5. Code source et build ------------------------------------------------
# `data/` est exclu par `.dockerignore` : ni base, ni secrets, ni cache dans
# l'image. Le build ne l'ouvre jamais — les sept pages portent toutes
# `export const dynamic = "force-dynamic"`, donc rien n'est prérendu.
COPY . .
RUN npm run build

# --- 6. Le volume, vu depuis le code ---------------------------------------
# POINT CENTRAL. Le code résout ses fichiers depuis `process.cwd()/data` :
#   — `src/lib/config.ts`      base, jeton Gmail, compte de service
#   — `src/lib/signature-record.ts`      dataset-cache/opportunities.json
#   — `scripts/build-expected-today.mjs` dataset-cache/history.json
#   — `scripts/expected_gmv.py`          ROOT/data/rm-morning.db, en dur
# Les scripts Python ne lisent aucune variable d'environnement pour ce chemin.
# Ce lien symbolique fait pointer tous ces accès vers le volume persistant, sans
# modifier une seule ligne de résolution de chemin, en TypeScript comme en Python.
RUN rm -rf /app/data && ln -s /data /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3001 \
    RM_DATA_DIR=/data \
    RM_DB_PATH=/data/rm-morning.db \
    RM_REQUIRE_DB=1 \
    GOOGLE_SERVICE_ACCOUNT_FILE=/run/secrets/google-service-account.json \
    SF_USE_GENERIC_UNIX_KEYCHAIN=true

# CLI Salesforce : silence radio.
#
# Trois variables, trois effets distincts, chacun mesuré le 23/08 sur la machine
# de production, cache vidé entre chaque essai pour que le test discrimine :
#
#   SF_DISABLE_TELEMETRY   — supprime le processus DÉTACHÉ d'envoi de télémétrie
#                            lancé à chaque invocation. 1 orphelin par appel sans
#                            elle, 0 avec.
#
#   SF_DISABLE_AUTOUPDATE  — LE correctif. Sans elle, le premier `sf` du conteneur
#                            lance `sf update --autoupdate`, un processus qui
#                            DORT UNE HEURE puis tente de remplacer la CLI dans
#                            le conteneur en production — possiblement en pleine
#                            actualisation. Nom exact lu dans le code :
#                            `scopedEnvVarTrue('DISABLE_AUTOUPDATE')` de
#                            @oclif/plugin-update 4.7.57. Attention au piège :
#                            SF_AUTOUPDATE_DISABLE, mots inversés, ne l'empêche
#                            pas — vérifié, 1 processus contre 0.
#
#   SF_AUTOUPDATE_DISABLE  — n'a PAS cet effet, mais étouffe l'avertissement
#                            « update available » écrit sur stderr. Utile : ce
#                            flux nourrit désormais le résumé d'erreur de
#                            l'orchestrateur, où la bannière masquerait la cause.
#
# SF_SKIP_NEW_VERSION_CHECK a été retirée : aucun effet démontrable, ni sur les
# processus ni sur stderr.
ENV SF_DISABLE_TELEMETRY=true \
    SF_DISABLE_AUTOUPDATE=true \
    SF_AUTOUPDATE_DISABLE=true

EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

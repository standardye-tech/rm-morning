"""
Publication de la projection M+1 et du scoring individuel M+1 (C11).

    npm run m1:publish

Reprend EXACTEMENT le modèle retenu par C8.1, sans le rejouer ni le rechoisir :

  — régional : baseline officielle 12 mois × ajustement borné par la force du
    pipe, approche H4 shrinkage 50 %, index de force détendancé sur les treize
    instantanés précédents ;
  — individuel : régression logistique sur étape, tranche de GMV, montant,
    ancienneté, ancienneté dans l'étape, changements d'étape et jour du mois.
    Cible : signature officielle du premier devis Travaux ORIGINAL dans le mois
    cible.

Aucune sélection de modèle ici. Aucune saisonnalité — C8.1 l'a testée et rejetée
(elle gagne la validation et perd le test). Aucun modèle M ou 7 jours n'est
touché.

ÉCRIT uniquement dans `expected_m1_snapshot` et `expected_m1_score`.
LECTURE SEULE partout ailleurs. Aucun appel Salesforce.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from expected_gmv_hybrid import (  # noqa: E402
    DB,
    TEAM_INDEX,
    euro,
    norm_name,
    shift_month,
)
from hybrid_models import (  # noqa: E402
    AMOUNT_BINS,
    AMOUNT_LABELS,
    TRAIN_TARGET_END,
    add_targets,
    clip_to_support,
    pipe_metrics,
    prepare,
    support,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Doivent rester identiques aux valeurs de src/lib/config.ts (EXPECTED_M1).
PIPE_WEIGHT = 0.50
CLAMP_LO, CLAMP_HI = 0.60, 1.50
RANGE_LO, RANGE_HI = 0.85, 1.25
THRESHOLD = 0.20
RULE_VERSION = "c8.1-m1-h4-50-seuil-20"
CONFIDENCE = "moyenne"

NUM = ["amount", "log_amount", "age_days", "days_in_stage", "stage_changes", "day_of_month"]
CAT = ["stage_str", "amount_bin"]


def last_complete_month(today: date) -> str:
    """Dernier mois entièrement écoulé. Jamais codé en dur : la projection doit
    rester juste après une bascule de mois."""
    return shift_month(f"{today.year}-{today.month:02d}", -1)


def load(con: sqlite3.Connection):
    obs = pd.read_sql_query("SELECT * FROM expected_gmv_observation", con)
    obs["key"] = obs["opportunity_id"].str.slice(0, 15)
    trx = pd.read_sql_query(
        "SELECT opportunity_id, owner_raw, signature_date, gmv, works_type, works_status FROM travaux",
        con,
    )
    trx = trx[trx["works_status"].isin(["Signé", "Réalisé"])].copy()
    trx["owner"] = trx["owner_raw"].map(lambda x: TEAM_INDEX.get(norm_name(x)))
    trx = trx[trx["owner"].notna()].copy()
    trx["month"] = trx["signature_date"].str.slice(0, 7)
    today = pd.read_sql_query("SELECT * FROM expected_gmv_today", con)
    return obs, trx, today


def official_truth(trx: pd.DataFrame, last_month: str) -> pd.Series:
    s = trx.groupby("month")["gmv"].sum().sort_index()
    s = s[s.index <= last_month]
    return s[s >= s.median() * 0.2]


def weekly_snapshots(obs: pd.DataFrame) -> list[str]:
    w = obs[obs["observation_kind"] == "weekly"].copy()
    w["dow"] = pd.to_datetime(w["observation_date"]).dt.dayofweek
    g = w[w["dow"] == 0].groupby("observation_date").size()
    return sorted(g[g >= 30].index)


def prepare_today(today: pd.DataFrame) -> pd.DataFrame:
    """Mêmes features que l'apprentissage, calculées depuis la même définition.

    `expected_gmv_today` est produit par `buildTodayFeatures`, qui réutilise le
    `stateAt` du dataset : les colonnes ont donc le même sens qu'en apprentissage.
    Contrôle effectué au moment de C11 : 247 affaires communes entre l'état du
    17/08 et l'instantané hebdomadaire du 10/08, 33 entrées réelles, 2 sorties
    par signature. Les deux chaînes décrivent bien le même pipe.
    """
    d = today.copy()
    a = d["amount"].astype(float)
    d["log_amount"] = np.log1p(a.fillna(a.median()))
    d["amount_bin"] = pd.cut(a, AMOUNT_BINS, labels=AMOUNT_LABELS, right=False).astype(str)
    d["stage_str"] = d["stage"].fillna("(sans etape)").astype(str)
    d["stage_changes"] = d["stage_changes"].fillna(0)
    return d


def main() -> None:
    t0 = time.time()
    con = sqlite3.connect(DB)
    obs, trx, today_raw = load(con)

    now = datetime.now().astimezone()
    today = now.date()
    last_month = last_complete_month(today)
    obs_month = f"{today.year}-{today.month:02d}"
    target = shift_month(obs_month, 1)

    print("\n" + "=" * 74)
    print(f"  PUBLICATION M+1 — cible {target}")
    print("=" * 74)

    # --- Vivier live : on écarte les affaires dont le premier devis Travaux est
    #     déjà signé. L'information est disponible aujourd'hui, l'exclure ne
    #     triche pas — et sans elle 40 affaires gagnées gonflaient le pipe (C8.1).
    orig = trx[trx["works_type"] == "ORIGINAL"]
    first = orig.sort_values("signature_date").groupby("opportunity_id", as_index=False).head(1)
    sig_date = dict(zip(first["opportunity_id"], first["signature_date"]))
    live = prepare_today(today_raw)
    live["already_signed"] = live["opportunity_id"].map(
        lambda k: (sig_date.get(k) or "9999") < today.isoformat()
    )
    dropped = int(live["already_signed"].sum())
    live = live[~live["already_signed"]].copy()
    print(f"\n  vivier live      : {len(live)} affaires ({dropped} écartée(s), devis déjà signé)")

    # --- A. Projection régionale.
    truth = official_truth(trx, last_month)
    hist = truth[truth.index < obs_month]
    baseline = float(hist.tail(12).mean())

    snaps = weekly_snapshots(obs)
    hist_obs = add_targets(prepare(obs), trx)
    rows = []
    for T in snaps:
        p = hist_obs[(hist_obs["observation_date"] == T) & (hist_obs["observation_kind"] == "weekly")]
        p = p[~p["signed_before_T"]]
        if len(p) < 30:
            continue
        rows.append({"T": T, **pipe_metrics(p)})
    ref = pd.DataFrame(rows)
    prev = ref[ref["T"] < today.isoformat()].tail(13)
    ref_total = float(prev["open_gmv_capped"].median())
    ref_adv = float(prev["advanced_gmv"].median())

    m = pipe_metrics(live)
    strength = PIPE_WEIGHT * (m["open_gmv_capped"] / ref_total) + (1 - PIPE_WEIGHT) * (
        m["advanced_gmv"] / ref_adv
    )
    multiplier = PIPE_WEIGHT + PIPE_WEIGHT * float(np.clip(strength, CLAMP_LO, CLAMP_HI))
    projection = baseline * multiplier

    # Plage de force réellement observée. `min_periods` vaut 13 et non 6 : avec
    # six instantanés la médiane glissante est elle-même instable et produisait
    # une borne haute de 2,14, qui n'a jamais été observée.
    hs = 0.5 * ref["open_gmv_capped"] / ref["open_gmv_capped"].shift(1).rolling(
        13, min_periods=13
    ).median() + 0.5 * ref["advanced_gmv"] / ref["advanced_gmv"].shift(1).rolling(
        13, min_periods=13
    ).median()
    hs = hs.dropna()
    cal_lo, cal_hi = float(hs.min()), float(hs.max())
    in_range = bool(cal_lo <= strength <= cal_hi)

    print(f"\n  baseline 12 mois : {euro(baseline)}   ({hist.index[-12]} → {hist.index[-1]})")
    print(f"  pipe ouvert      : {euro(m['open_gmv'])} · plafonné {euro(m['open_gmv_capped'])}")
    print(f"  dont avancé      : {euro(m['advanced_gmv'])} sur {m['advanced_count']} affaires")
    print(f"  référence 13 sem.: {euro(ref_total)} plafonné · {euro(ref_adv)} avancé")
    print(f"  force du pipe    : {strength:.3f}   (plage calibrée {cal_lo:.2f} → {cal_hi:.2f})")
    if not in_range:
        print("  HORS PLAGE — la projection est une extrapolation, à signaler dans l'interface.")
    print(f"  multiplicateur   : ×{multiplier:.3f}")
    print(f"\n  PROJECTION       : {euro(projection)}")
    print(f"  fourchette       : {euro(projection * RANGE_LO)} → {euro(projection * RANGE_HI)}")

    # --- B. Scoring individuel.
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    usable = hist_obs[(~hist_obs["signed_before_T"]) & (hist_obs["target_month_m1"] <= last_month)]
    # Bornes du support mesurées sur la MÊME fenêtre d'apprentissage que le
    # backtest C8.1, pour que la fonction publiée soit celle qui a été mesurée.
    bounds = support(usable[usable["target_month_m1"] <= TRAIN_TARGET_END], NUM)
    train = clip_to_support(usable, bounds)
    live = clip_to_support(live, bounds)
    pre = ColumnTransformer(
        [
            ("num", Pipeline([("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]), NUM),
            (
                "cat",
                OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=30, sparse_output=False),
                CAT,
            ),
        ]
    )
    model = Pipeline([("pre", pre), ("m", LogisticRegression(max_iter=2000))])
    model.fit(train[NUM + CAT], train["target_m1"])
    live["p_m1"] = np.clip(model.predict_proba(live[NUM + CAT])[:, 1], 0, 1)
    # `gmv_true` et non `amount` : le montant a été borné comme feature.
    live["expected_gmv"] = live["gmv_true"] * live["p_m1"]

    # Le modèle est ajusté sur TOUT l'historique complet, y compris la fenêtre de
    # test de C8.1 : c'est l'usage normal une fois la forme du modèle arrêtée. Les
    # métriques publiées restent celles mesurées hors échantillon par C8.1, et ne
    # sont pas recalculées ici — elles seraient optimistes.
    over = int((live["p_m1"] >= THRESHOLD).sum())
    print(f"\n  apprentissage    : {len(train)} observations, {int(train['target_m1'].sum())} signatures")
    print(f"  scoring          : {len(live)} affaires · {over} au-dessus du seuil de {THRESHOLD:.0%}")
    print(f"  probabilité      : médiane {live['p_m1'].median():.1%} · max {live['p_m1'].max():.1%}")

    reliability = {
        "source": "C8.1",
        "approach": "H4 shrinkage 50 % pipe, index détendancé",
        "region_test": {"mae": 51_000, "median_abs_pct": 0.051, "bias_pct": -0.040, "target_months": 3},
        "region_h0_test": {"mae": 77_000, "median_abs_pct": 0.074, "bias_pct": -0.086},
        "ranking_validation": {"model": "logistique", "pr_auc": 0.1148, "base_rate": 0.0544},
        "rule_test": {
            "threshold": THRESHOLD,
            "precision": 0.256,
            "lift": 4.5,
            "per_snapshot": 3.3,
            "gmv_captured": 0.06,
        },
        "caveats": [
            "3 mois cibles de test seulement, tous au-dessus de la moyenne.",
            "Aucune capacité directionnelle démontrée.",
            "Un mois d'effondrement type août 2025 (240 k€) ne serait pas vu.",
            "La couverture de la fourchette n'est pas calibrée : indicative seulement.",
        ],
    }

    generated_at = now.isoformat(timespec="seconds")
    data_as_of = (
        live["data_as_of"].dropna().max() if "data_as_of" in live.columns and len(live) else None
    )
    cur = con.cursor()
    cur.execute(
        """INSERT OR REPLACE INTO expected_m1_snapshot
             (generated_at, observation_date, target_month, rule_version, baseline, strength,
              multiplier, projection, range_lo, range_hi, confidence, calibrated_lo, calibrated_hi,
              strength_in_range, open_gmv, scored_count, probability_threshold, data_as_of, reliability)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            generated_at,
            str(live["observation_date"].iloc[0]) if len(live) else today.isoformat(),
            target,
            RULE_VERSION,
            baseline,
            strength,
            multiplier,
            projection,
            projection * RANGE_LO,
            projection * RANGE_HI,
            CONFIDENCE,
            cal_lo,
            cal_hi,
            1 if in_range else 0,
            m["open_gmv"],
            len(live),
            THRESHOLD,
            data_as_of,
            json.dumps(reliability, ensure_ascii=False),
        ),
    )
    cur.executemany(
        """INSERT OR REPLACE INTO expected_m1_score
             (generated_at, opportunity_id, owner, stage, amount, p_m1, expected_gmv,
              is_standby, standby_until)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        [
            (
                generated_at,
                r.opportunity_id,
                r.owner,
                r.stage,
                float(r.gmv_true or 0),
                float(r.p_m1),
                float(r.expected_gmv),
                int(r.is_standby or 0),
                r.standby_until,
            )
            for r in live.itertuples()
        ],
    )
    con.commit()
    con.close()
    print(f"\n  → expected_m1_snapshot + {len(live)} lignes expected_m1_score ({time.time() - t0:.0f} s)\n")


if __name__ == "__main__":
    main()

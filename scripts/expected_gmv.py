"""
Expected GMV V1 — entraînement et évaluation.

    npm run expected:train      phase de sélection (A→I) : baselines, modèles,
                                variantes, calibration. NE LIT JAMAIS LE TEST.
    npm run expected:evaluate   phase finale (J→N) : évaluation unique sur le
                                test, backtest agrégé, scoring live, artefacts.

Deux phases séparées par construction : la discipline temporelle ne repose pas
sur ma vigilance mais sur le fait que la phase de sélection n'a pas accès aux
observations postérieures au 30/04/2026.

Aucune écriture Salesforce, aucune écriture Google. Lecture SQLite seule ;
les artefacts vont dans `data/expected-gmv/`, hors Git.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "rm-morning.db"
ARTIFACTS = ROOT / "data" / "expected-gmv"

TRAIN_END = "2025-12-31"
VALID_END = "2026-04-30"
# Le test s'arrête au 31/07 : août est encore ouvert, son label fin de mois
# n'est pas resolu.
TEST_END = "2026-07-31"

LABELS = ["signed_within_7d", "signed_by_month_end"]

NUMERIC_CORE = [
    "amount",
    "age_days",
    "days_in_stage",
    "stage_changes",
    "days_left_in_month",
    "day_of_month",
]
CATEGORICAL_CORE = ["stage", "acquisition_channel", "lead_source", "service", "department", "month"]

NUMERIC_RICH = [
    "days_since_estimation",
    "estimation_relance_delay_days",
    "days_since_devis",
    "devis_relance_delay_days",
    "visit_et_past",
    "visit_artisan_past",
]
CATEGORICAL_RICH = ["has_estimation", "has_estimation_relance", "has_devis", "has_devis_relance"]


def load() -> pd.DataFrame:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    df = pd.read_sql_query("SELECT * FROM expected_gmv_observation", con)
    con.close()

    # Code postal réduit au département : deux chiffres suffisent à porter le
    # signal géographique sans faire exploser la dimension (des centaines de CP
    # bruts produiraient autant de colonnes que d'observations rares).
    df["department"] = df["postal_code"].astype(str).str.extract(r"^(\d{2})")[0].fillna("inconnu")
    df["month"] = df["month"].astype(str)

    for col, src in [
        ("has_estimation", "estimation_sent_at"),
        ("has_estimation_relance", "estimation_relance_at"),
        ("has_devis", "devis_sent_at"),
        ("has_devis_relance", "devis_relance_at"),
    ]:
        df[col] = df[src].notna().map({True: "oui", False: "non"})

    return df


def split(df: pd.DataFrame, include_test: bool) -> dict[str, pd.DataFrame]:
    d = df["observation_date"]
    out = {
        "train": df[d <= TRAIN_END].copy(),
        "validation": df[(d > TRAIN_END) & (d <= VALID_END)].copy(),
    }
    if include_test:
        out["test"] = df[(d > VALID_END) & (d <= TEST_END)].copy()
    return out


def features(rich: bool, with_owner: bool) -> tuple[list[str], list[str]]:
    numeric = list(NUMERIC_CORE)
    categorical = list(CATEGORICAL_CORE)
    if rich:
        numeric += NUMERIC_RICH
        categorical += CATEGORICAL_RICH
    if with_owner:
        categorical = categorical + ["owner"]
    return numeric, categorical


def make_pipeline(kind: str, numeric: list[str], categorical: list[str], class_weight):
    """Une seule fabrique : les deux familles partagent la même préparation."""
    if kind == "logistic":
        pre = ColumnTransformer(
            [
                (
                    "num",
                    Pipeline(
                        [
                            # Imputation par la médiane + indicateur : « valeur
                            # absente » reste une information, jamais un zéro.
                            ("impute", SimpleImputer(strategy="median", add_indicator=True)),
                            ("scale", StandardScaler()),
                        ]
                    ),
                    numeric,
                ),
                (
                    "cat",
                    OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=20, sparse_output=False),
                    categorical,
                ),
            ]
        )
        model = LogisticRegression(max_iter=2000, class_weight=class_weight, C=1.0)
        return Pipeline([("pre", pre), ("model", model)])

    # Les arbres gèrent nativement les valeurs manquantes et les catégories :
    # aucune imputation, donc aucune information inventée.
    pre = ColumnTransformer(
        [
            ("num", "passthrough", numeric),
            ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=20, sparse_output=False), categorical),
        ]
    )
    model = HistGradientBoostingClassifier(
        max_iter=300,
        learning_rate=0.05,
        max_leaf_nodes=15,
        min_samples_leaf=40,
        l2_regularization=1.0,
        class_weight=class_weight,
        random_state=42,
    )
    return Pipeline([("pre", pre), ("model", model)])


# --- Métriques ---------------------------------------------------------------


def deciles(y: np.ndarray, p: np.ndarray) -> list[dict]:
    order = np.argsort(-p)
    y, p = y[order], p[order]
    n = len(y)
    out = []
    for i in range(10):
        a, b = i * n // 10, (i + 1) * n // 10
        if b <= a:
            continue
        out.append(
            {
                "decile": i + 1,
                "n": int(b - a),
                "predicted": float(p[a:b].mean()),
                "observed": float(y[a:b].mean()),
            }
        )
    return out


def metrics(y: np.ndarray, p: np.ndarray, threshold: float | None = None) -> dict:
    base = float(y.mean())
    if threshold is None:
        # Seuil = taux de base : on ne cherche pas à flatter la précision.
        threshold = float(np.quantile(p, 1 - max(base, 1e-4)))
    pred = (p >= threshold).astype(int)
    dec = deciles(y, p)
    top = dec[0]["observed"] if dec else 0.0
    return {
        "n": int(len(y)),
        "positives": int(y.sum()),
        "base_rate": base,
        "pr_auc": float(average_precision_score(y, p)) if y.sum() else float("nan"),
        "roc_auc": float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else float("nan"),
        "brier": float(brier_score_loss(y, p)),
        "log_loss": float(log_loss(y, p, labels=[0, 1])),
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "lift_top_decile": float(top / base) if base > 0 else float("nan"),
        "deciles": dec,
        "threshold": float(threshold),
    }


def show(label: str, m: dict) -> None:
    print(
        f"  {label:<44} PR-AUC {m['pr_auc']:.4f} | ROC {m['roc_auc']:.3f} | Brier {m['brier']:.5f} "
        f"| P {m['precision']:.3f} | R {m['recall']:.3f} | lift D1 {m['lift_top_decile']:.2f}x"
    )


# --- Baselines ---------------------------------------------------------------


def baselines(train: pd.DataFrame, evaluate: pd.DataFrame, label: str) -> dict[str, dict]:
    y = evaluate[label].to_numpy()
    out: dict[str, dict] = {}

    # A — taux global.
    rate = float(train[label].mean())
    out["A. taux global"] = metrics(y, np.full(len(evaluate), rate))

    # B — taux par étape.
    by_stage = train.groupby("stage")[label].mean()
    out["B. taux par etape"] = metrics(
        y, evaluate["stage"].map(by_stage).fillna(rate).to_numpy(dtype=float)
    )

    # C — étape x jours restants dans le mois (pertinent pour la fin de mois).
    bins = [-1, 3, 7, 14, 21, 40]
    train = train.assign(dr=pd.cut(train["days_left_in_month"], bins))
    ev = evaluate.assign(dr=pd.cut(evaluate["days_left_in_month"], bins))
    by_sd = train.groupby(["stage", "dr"], observed=True)[label].mean()
    out["C. etape x jours restants"] = metrics(
        y,
        pd.MultiIndex.from_arrays([ev["stage"], ev["dr"]])
        .map(by_sd)
        .to_series()
        .fillna(rate)
        .to_numpy(dtype=float),
    )

    # D — étape x âge x temps dans l'étape, par régression logistique minimale.
    cols = ["age_days", "days_in_stage"]
    pipe = Pipeline(
        [
            (
                "pre",
                ColumnTransformer(
                    [
                        ("num", Pipeline([("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]), cols),
                        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), ["stage"]),
                    ]
                ),
            ),
            ("model", LogisticRegression(max_iter=1000)),
        ]
    )
    pipe.fit(train[cols + ["stage"]], train[label])
    out["D. etape + age + temps dans etape"] = metrics(
        y, pipe.predict_proba(evaluate[cols + ["stage"]])[:, 1]
    )
    return out


# --- Phases ------------------------------------------------------------------


def phase_select() -> None:
    print("\n" + "=" * 78)
    print("  PHASE DE SELECTION — le jeu de test n'est PAS chargé")
    print("=" * 78)

    df = load()
    parts = split(df, include_test=False)
    train, valid = parts["train"], parts["validation"]
    print(f"\n  train      : {len(train):>6} obs · {train['observation_date'].min()} → {train['observation_date'].max()}")
    print(f"  validation : {len(valid):>6} obs · {valid['observation_date'].min()} → {valid['observation_date'].max()}")

    results: dict = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "labels": {}}

    for label in LABELS:
        print(f"\n{'-' * 78}\n  LABEL : {label}   (base train {train[label].mean() * 100:.2f} %)\n{'-' * 78}")
        entry: dict = {"baselines": {}, "models": {}}

        print("\n  BASELINES (mesurées sur validation)")
        for name, m in baselines(train, valid, label).items():
            show(name, m)
            entry["baselines"][name] = m

        print("\n  MODELES (entraînés sur train, mesurés sur validation)")
        for dataset in ("core", "rich"):
            rich = dataset == "rich"
            tr = train[train["milestones_available"] == 1] if rich else train
            va = valid[valid["milestones_available"] == 1] if rich else valid
            if len(tr) < 500 or va[label].sum() == 0:
                print(f"  (jeu {dataset} insuffisant : {len(tr)} train, {int(va[label].sum())} positifs validation)")
                continue
            for kind in ("logistic", "tree"):
                for with_owner in (False, True):
                    # Deux pondérations : « balanced » optimise le classement
                    # mais gonfle les probabilités, ce qui ruine la calibration
                    # dont Expected GMV a besoin. On mesure les deux.
                    for weight in (None, "balanced"):
                        num, cat = features(rich, with_owner)
                        pipe = make_pipeline(kind, num, cat, weight)
                        pipe.fit(tr[num + cat], tr[label])
                        p = pipe.predict_proba(va[num + cat])[:, 1]
                        m = metrics(va[label].to_numpy(), p)
                        key = (
                            f"{dataset}/{kind}/{'owner' if with_owner else 'sans owner'}"
                            f"/{'pondere' if weight else 'brut'}"
                        )
                        show(key, m)
                        entry["models"][key] = m

        # --- Calibration, uniquement sur validation.
        print("\n  CALIBRATION (ajustée sur validation, jamais sur test)")
        # Le candidat à calibrer est choisi sur le classement, la calibration
        # étant précisément ce qui corrigera ses probabilités.
        best = max(entry["models"], key=lambda k: entry["models"][k]["pr_auc"])
        dataset, kind, owner, weight_key = best.split("/")
        rich = dataset == "rich"
        with_owner = owner == "owner"
        weight = "balanced" if weight_key == "pondere" else None
        tr = train[train["milestones_available"] == 1] if rich else train
        va = valid[valid["milestones_available"] == 1] if rich else valid
        num, cat = features(rich, with_owner)

        for method in ("aucune", "sigmoid", "isotonic"):
            if method == "aucune":
                pipe = make_pipeline(kind, num, cat, weight)
                pipe.fit(tr[num + cat], tr[label])
            else:
                # La calibration est ajustée par validation croisée interne sur
                # le TRAIN, puis mesurée sur la validation : le test reste vierge.
                pipe = CalibratedClassifierCV(
                    make_pipeline(kind, num, cat, None), method=method, cv=3
                )
                pipe.fit(tr[num + cat], tr[label])
            p = pipe.predict_proba(va[num + cat])[:, 1]
            m = metrics(va[label].to_numpy(), p)
            show(f"{best} + {method}", m)
            entry["models"][f"{best} + calib {method}"] = m

        # --- Règle de sélection, énoncée avant de regarder les chiffres :
        #
        #   1. Expected GMV a besoin de probabilités crédibles. On écarte donc
        #      tout candidat dont le Brier dépasse de plus de 5 % celui de la
        #      meilleure baseline — un bon classement mal calibré est inutile ici.
        #   2. Parmi les survivants, on prend la meilleure PR-AUC.
        #   3. À moins de 3 % d'écart relatif, on préfère le plus simple :
        #      baseline > core > rich, sans owner > avec owner, non calibré >
        #      calibré. Owner est de surcroît imparfaitement historique.
        candidates = {**{f"baseline {k}": v for k, v in entry["baselines"].items()}, **entry["models"]}
        best_baseline_brier = min(v["brier"] for v in entry["baselines"].values())
        eligible = {k: v for k, v in candidates.items() if v["brier"] <= best_baseline_brier * 1.05}
        if not eligible:
            eligible = candidates
        top = max(v["pr_auc"] for v in eligible.values())

        def simplicity(name: str) -> tuple[int, int, int, int]:
            return (
                0 if name.startswith("baseline") else 1,
                1 if "rich" in name else 0,
                1 if "/owner/" in name else 0,
                1 if "calib" in name else 0,
            )

        near = [k for k, v in eligible.items() if v["pr_auc"] >= top * 0.97]
        chosen = sorted(near, key=simplicity)[0]

        print("\n  SELECTION")
        print(f"    Brier plafond (meilleure baseline +5 %) : {best_baseline_brier * 1.05:.5f}")
        print(f"    candidats eligibles                     : {len(eligible)}/{len(candidates)}")
        print(f"    a moins de 3 % de la meilleure PR-AUC    : {', '.join(sorted(near, key=simplicity))}")
        print(f"    RETENU                                  : {chosen}")
        print(
            f"      PR-AUC {eligible[chosen]['pr_auc']:.4f} | Brier {eligible[chosen]['brier']:.5f}"
            f" | lift D1 {eligible[chosen]['lift_top_decile']:.2f}x"
        )

        entry["best_ranking_on_validation"] = best
        entry["selected"] = chosen
        entry["selection_rule"] = {
            "brier_ceiling": best_baseline_brier * 1.05,
            "eligible": len(eligible),
            "near_best": sorted(near, key=simplicity),
        }
        results["labels"][label] = entry

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "selection.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"\n  résultats de sélection écrits dans data/expected-gmv/selection.json\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["select", "final"], default="select")
    args = parser.parse_args()
    if args.phase == "select":
        phase_select()
    else:
        from expected_gmv_final import phase_final  # noqa: PLC0415

        phase_final()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    os.environ.setdefault("PYTHONHASHSEED", "0")
    main()

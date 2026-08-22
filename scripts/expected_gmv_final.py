"""
Expected GMV V1 — phase finale (J→N).

Lit le jeu de test UNE SEULE FOIS, avec les modèles et la calibration figés par
`npm run expected:train`. Aucun hyperparamètre n'est ajusté ici.

Les modèles retenus sont réentraînés sur train + validation avant l'évaluation
du test : c'est la pratique standard, et l'information utilisée reste
antérieure au test.
"""

from __future__ import annotations

import json
import sqlite3
import time

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from expected_gmv import (
    ARTIFACTS,
    DB,
    LABELS,
    TEST_END,
    TRAIN_END,
    VALID_END,
    features,
    load,
    make_pipeline,
    metrics,
    show,
)

BASELINE_D_NUM = ["age_days", "days_in_stage"]
BASELINE_D_CAT = ["stage"]


def build_selected(key: str, label: str, train: pd.DataFrame):
    """Reconstruit exactement le candidat retenu, et rien d'autre."""
    if key.startswith("baseline D"):
        pipe = Pipeline(
            [
                (
                    "pre",
                    ColumnTransformer(
                        [
                            (
                                "num",
                                Pipeline(
                                    [("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]
                                ),
                                BASELINE_D_NUM,
                            ),
                            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), BASELINE_D_CAT),
                        ]
                    ),
                ),
                ("model", LogisticRegression(max_iter=1000)),
            ]
        )
        cols = BASELINE_D_NUM + BASELINE_D_CAT
        pipe.fit(train[cols], train[label])
        return pipe, cols, False

    dataset, kind, owner, weight_key = key.split("/")
    rich = dataset == "rich"
    with_owner = owner == "owner"
    weight = "balanced" if weight_key == "pondere" else None
    num, cat = features(rich, with_owner)
    pipe = make_pipeline(kind, num, cat, weight)
    subset = train[train["milestones_available"] == 1] if rich else train
    pipe.fit(subset[num + cat], subset[label])
    return pipe, num + cat, rich


def euro(v: float) -> str:
    return f"{v / 1000:,.0f} k€".replace(",", " ")


def top_k(test: pd.DataFrame, p: np.ndarray, label: str, ks=(5, 10, 20)) -> dict:
    """Précision et GMV capté dans les K meilleures probabilités."""
    out = {}
    order = np.argsort(-p)
    y = test[label].to_numpy()
    amount = test["amount"].fillna(0).to_numpy()
    total_signed_gmv = float(amount[y == 1].sum())
    for k in ks:
        idx = order[:k]
        hits = int(y[idx].sum())
        out[f"precision@{k}"] = hits / k
        out[f"gmv_capte@{k}"] = float(amount[idx][y[idx] == 1].sum())
        out[f"part_gmv_signe@{k}"] = (
            float(amount[idx][y[idx] == 1].sum()) / total_signed_gmv if total_signed_gmv else float("nan")
        )
    out["gmv_signe_total"] = total_signed_gmv
    return out


def aggregate_backtest(test: pd.DataFrame, p: np.ndarray, label: str) -> pd.DataFrame:
    """Expected GMV agrégé par date d'observation, face au GMV réellement signé."""
    d = test.assign(p=p, amount0=test["amount"].fillna(0))
    d["expected"] = d["amount0"] * d["p"]
    d["realise"] = d["amount0"] * d[label]
    g = d.groupby("observation_date").agg(
        n=("p", "size"),
        expected=("expected", "sum"),
        realise=("realise", "sum"),
        jours_restants=("days_left_in_month", "median"),
    )
    g["erreur"] = g["expected"] - g["realise"]
    g["erreur_relative"] = np.where(g["realise"] > 0, g["erreur"] / g["realise"], np.nan)
    return g.reset_index()


def phase_final() -> None:
    started = time.time()
    selection = json.loads((ARTIFACTS / "selection.json").read_text(encoding="utf-8"))

    print("\n" + "=" * 78)
    print("  PHASE FINALE — le jeu de test est lu UNE SEULE FOIS")
    print("=" * 78)

    df = load()
    d = df["observation_date"]
    train_valid = df[d <= VALID_END].copy()
    test = df[(d > VALID_END) & (d <= TEST_END)].copy()
    live = df[d > TEST_END].copy()

    print(f"\n  train + validation : {len(train_valid):>6} obs · jusqu'au {VALID_END}")
    print(f"  TEST               : {len(test):>6} obs · {test['observation_date'].min()} → {test['observation_date'].max()}")
    print(f"  hors test (live)   : {len(live):>6} obs · réservées au scoring courant")

    seen = set(train_valid["opportunity_id"])
    report: dict = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "labels": {}}

    for label in LABELS:
        key = selection["labels"][label]["selected"]
        print(f"\n{'-' * 78}\n  {label} — modèle retenu : {key}\n{'-' * 78}")
        pipe, cols, rich = build_selected(key, label, train_valid)

        subset = test[test["milestones_available"] == 1] if rich else test
        p = pipe.predict_proba(subset[cols])[:, 1]
        m = metrics(subset[label].to_numpy(), p)
        show("TEST", m)
        print(f"    base test {m['base_rate'] * 100:.2f} % · log loss {m['log_loss']:.4f} · F1 {m['f1']:.3f}")

        print("\n  CALIBRATION PAR DECILE (test)")
        print(f"    {'décile':<8}{'n':>6}{'prédit':>10}{'observé':>10}{'écart':>9}")
        for row in m["deciles"]:
            print(
                f"    {row['decile']:<8}{row['n']:>6}{row['predicted'] * 100:>9.2f}%{row['observed'] * 100:>9.2f}%"
                f"{(row['predicted'] - row['observed']) * 100:>8.2f}pt"
            )

        # --- Robustesse : opportunités jamais vues à l'entraînement.
        unseen = subset[~subset["opportunity_id"].isin(seen)]
        if len(unseen) > 50 and unseen[label].sum() > 0:
            pu = pipe.predict_proba(unseen[cols])[:, 1]
            mu = metrics(unseen[label].to_numpy(), pu)
            show("TEST — opportunités jamais vues", mu)
            print(f"    {len(unseen)} obs · {int(unseen[label].sum())} positifs")
        else:
            mu = None
            print(f"  (sous-ensemble jamais vu trop petit : {len(unseen)} obs)")

        tk = top_k(subset, p, label)
        print("\n  TOP AFFAIRES (test)")
        for k in (5, 10, 20):
            print(
                f"    top {k:<3} précision {tk[f'precision@{k}'] * 100:>5.1f} % · GMV capté {euro(tk[f'gmv_capte@{k}']):>10}"
                f" · {tk[f'part_gmv_signe@{k}'] * 100:>5.1f} % du GMV signé"
            )
        print(f"    GMV signé total sur le test : {euro(tk['gmv_signe_total'])}")

        # --- Expected GMV agrégé.
        agg = aggregate_backtest(subset, p, label)
        mae = float(np.abs(agg["erreur"]).mean())
        bias = float(agg["erreur"].mean())
        tot_e, tot_r = float(agg["expected"].sum()), float(agg["realise"].sum())
        print("\n  EXPECTED GMV AGREGE (test)")
        print(f"    Expected cumulé {euro(tot_e)} · réalisé {euro(tot_r)} · biais total {euro(tot_e - tot_r)}")
        print(f"    MAE par date {euro(mae)} · biais moyen {euro(bias)}")
        print(f"    erreur relative globale {((tot_e - tot_r) / tot_r * 100 if tot_r else float('nan')):.1f} %")

        print("\n    par position dans le mois")
        bins = [-1, 3, 7, 14, 21, 40]
        agg["tranche"] = pd.cut(agg["jours_restants"], bins)
        for tranche, grp in agg.groupby("tranche", observed=True):
            e, r = grp["expected"].sum(), grp["realise"].sum()
            print(
                f"      {str(tranche):<12} {len(grp):>3} dates · Expected {euro(e):>10} · réalisé {euro(r):>10}"
                f" · écart {((e - r) / r * 100 if r else float('nan')):>7.1f} %"
            )

        # --- Distribution des probabilités par étape : garde-fou.
        print("\n  DISTRIBUTION DES PROBABILITES PAR ETAPE (test)")
        dist = subset.assign(p=p).groupby("stage")["p"]
        print(f"    {'étape':<22}{'n':>6}{'min':>8}{'p50':>8}{'p90':>8}{'p99':>8}{'max':>8}")
        for stage, s in dist:
            print(
                f"    {stage:<22}{len(s):>6}{s.min() * 100:>7.1f}%{s.quantile(0.5) * 100:>7.1f}%"
                f"{s.quantile(0.9) * 100:>7.1f}%{s.quantile(0.99) * 100:>7.1f}%{s.max() * 100:>7.1f}%"
            )

        # --- Importance des variables, par permutation sur le test.
        print("\n  IMPORTANCE DES VARIABLES (permutation, test)")
        imp = permutation_importance(
            pipe, subset[cols], subset[label], n_repeats=5, random_state=42, scoring="average_precision"
        )
        ranked = sorted(zip(cols, imp.importances_mean, imp.importances_std), key=lambda x: -x[1])
        for name, mean, std in ranked[:10]:
            print(f"    {name:<32}{mean:+.4f}  ±{std:.4f}")

        report["labels"][label] = {
            "selected": key,
            "test": {k: v for k, v in m.items() if k != "deciles"},
            "calibration_deciles": m["deciles"],
            "robustness_unseen": {k: v for k, v in (mu or {}).items() if k != "deciles"} if mu else None,
            "top_k": tk,
            "aggregate": {
                "expected_total": tot_e,
                "realised_total": tot_r,
                "mae_per_date": mae,
                "bias_per_date": bias,
                "by_date": agg.drop(columns=["tranche"]).to_dict("records"),
            },
            "feature_importance": [{"feature": n, "mean": float(a), "std": float(b)} for n, a, b in ranked],
        }

    # --- M. Scoring live sur l'état courant.
    print(f"\n{'=' * 78}\n  SCORING LIVE — état courant, non affiché dans l'application\n{'=' * 78}")
    open_now = df[df["final_outcome"] == "open"].sort_values("observation_date")
    latest = open_now.groupby("opportunity_id").tail(1).copy()
    print(f"\n  opportunités non terminales scorées : {len(latest)} · observation la plus récente {latest['observation_date'].max()}")

    scores: dict[str, np.ndarray] = {}
    for label in LABELS:
        key = selection["labels"][label]["selected"]
        pipe, cols, rich = build_selected(key, label, train_valid)
        subset = latest[latest["milestones_available"] == 1] if rich else latest
        pr = pipe.predict_proba(subset[cols])[:, 1]
        col = "p7d" if label == "signed_within_7d" else "p_month_end"
        latest[col] = np.nan
        latest.loc[subset.index, col] = pr
        scores[col] = pr

    latest["amount0"] = latest["amount"].fillna(0)
    latest["expected_7d"] = latest["amount0"] * latest["p7d"]
    latest["expected_month_end"] = latest["amount0"] * latest["p_month_end"]

    print(f"\n  REGION")
    print(f"    GMV ouvert                : {euro(latest['amount0'].sum())}")
    print(f"    Expected GMV 7 jours      : {euro(latest['expected_7d'].sum())}")
    print(f"    Expected GMV fin de mois  : {euro(latest['expected_month_end'].sum())}")

    print(f"\n  PAR COMMERCIAL")
    print(f"    {'Commercial':<24}{'opps':>6}{'GMV':>11}{'Exp. 7j':>11}{'Exp. fin mois':>15}")
    by_owner = latest.groupby("owner").agg(
        n=("amount0", "size"), gmv=("amount0", "sum"), e7=("expected_7d", "sum"), em=("expected_month_end", "sum")
    ).sort_values("em", ascending=False)
    for owner, r in by_owner.iterrows():
        print(f"    {owner:<24}{int(r['n']):>6}{euro(r['gmv']):>11}{euro(r['e7']):>11}{euro(r['em']):>15}")

    print(f"\n  TOP 10 par probabilité à 7 jours")
    for _, r in latest.nlargest(10, "p7d").iterrows():
        print(
            f"    {r['p7d'] * 100:>5.1f}%  {euro(r['amount0']):>10}  {str(r['stage']):<20}{r['owner']:<22}"
            f"{r['opportunity_id'][-6:]}"
        )

    print(f"\n  TOP 10 par contribution Expected 7 jours")
    for _, r in latest.nlargest(10, "expected_7d").iterrows():
        print(
            f"    {euro(r['expected_7d']):>9}  ({r['p7d'] * 100:>4.1f}% × {euro(r['amount0'])})  "
            f"{str(r['stage']):<20}{r['owner']:<22}{r['opportunity_id'][-6:]}"
        )

    report["live"] = {
        "scored": int(len(latest)),
        "as_of": str(latest["observation_date"].max()),
        "region": {
            "open_gmv": float(latest["amount0"].sum()),
            "expected_7d": float(latest["expected_7d"].sum()),
            "expected_month_end": float(latest["expected_month_end"].sum()),
        },
        "by_owner": [
            {"owner": o, "n": int(r["n"]), "gmv": float(r["gmv"]), "expected_7d": float(r["e7"]), "expected_month_end": float(r["em"])}
            for o, r in by_owner.iterrows()
        ],
    }

    # --- N. Artefacts.
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "evaluation.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    latest[
        ["opportunity_id", "owner", "stage", "amount", "p7d", "p_month_end", "expected_7d", "expected_month_end"]
    ].to_csv(ARTIFACTS / "live-scores.csv", index=False)

    manifest = {
        "version": "expected-gmv-v1",
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "train_period": f"début → {VALID_END} (train + validation)",
        "test_period": f"{VALID_END} → {TEST_END}",
        "models": {label: selection["labels"][label]["selected"] for label in LABELS},
        "features": {
            label: build_selected(selection["labels"][label]["selected"], label, train_valid)[1] for label in LABELS
        },
        "duration_s": round(time.time() - started, 1),
    }
    (ARTIFACTS / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    con = sqlite3.connect(DB)
    con.execute(
        "CREATE TABLE IF NOT EXISTS expected_gmv_model (version TEXT PRIMARY KEY, trained_at TEXT NOT NULL, manifest TEXT NOT NULL)"
    )
    con.execute(
        "INSERT OR REPLACE INTO expected_gmv_model (version, trained_at, manifest) VALUES (?,?,?)",
        (manifest["version"], manifest["trained_at"], json.dumps(manifest)),
    )
    con.commit()
    con.close()

    print(f"\n  artefacts : data/expected-gmv/{{selection,evaluation,manifest}}.json · live-scores.csv")
    print(f"  durée totale {time.time() - started:.1f} s\n")
    void = TRAIN_END
    del void

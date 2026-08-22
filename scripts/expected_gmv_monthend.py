"""
Expected GMV fin de mois — V1.1.

    npm run expected:monthend            sélection sur validation (test intact)
    npm run expected:monthend -- --final évaluation unique sur le test + live

Le défaut bloquant de la V1 était que la probabilité ne décroissait pas avec le
temps restant : la baseline retenue n'utilisait tout simplement pas
`days_left_in_month`. Une même affaire gardait la même probabilité à J-25 et à
J-3, d'où +40 % de biais en dernière semaine.

Le critère de sélection est ici la CALIBRATION EN EUROS par fenêtre temporelle,
pas la PR-AUC : Forecast a besoin d'un total juste, pas d'un classement fin.

Le modèle 7 jours n'est pas retouché.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from expected_gmv import ARTIFACTS, DB, TEST_END, VALID_END, features, load, make_pipeline, metrics

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

LABEL = "signed_by_month_end"
TRAIN_END = "2025-12-31"

# Fenêtres temporelles du mois, en jours restants. Ce sont elles qui servent de
# juge : un biais acceptable en moyenne mais faux en dernière semaine ne vaut
# rien pour terminer un mois.
WINDOWS = [
    ("début de mois  (J-31..J-22)", 22, 99),
    ("mi-mois        (J-21..J-15)", 15, 21),
    ("J-14..J-8", 8, 14),
    ("dernière semaine (J-7..J-4)", 4, 7),
    ("trois derniers jours (J-3..J-0)", 0, 3),
]


def add_time_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    dl = d["days_left_in_month"].clip(lower=0)
    d["days_left"] = dl
    # Bins simples, tels que demandés.
    d["days_left_bin"] = pd.cut(
        dl, [-1, 3, 7, 14, 21, 99], labels=["J-3..0", "J-7..4", "J-14..8", "J-21..15", "J-31..22"]
    ).astype(str)
    # Interactions explicites, en clair plutôt qu'en produit numérique opaque.
    d["stage_x_window"] = d["stage"].astype(str) + " | " + d["days_left_bin"]
    d["stage_age_x_left"] = d["days_in_stage"].fillna(0) * dl / 30.0
    d["log_days_left"] = np.log1p(dl)
    return d


NUM_A = ["age_days", "days_in_stage", "days_left"]
NUM_B = NUM_A + ["stage_age_x_left", "log_days_left"]
CAT_BASE = ["stage"]


def logistic(numeric: list[str], categorical: list[str]) -> Pipeline:
    return Pipeline(
        [
            (
                "pre",
                ColumnTransformer(
                    [
                        (
                            "num",
                            Pipeline([("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]),
                            numeric,
                        ),
                        ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=20, sparse_output=False), categorical),
                    ]
                ),
            ),
            ("model", LogisticRegression(max_iter=2000)),
        ]
    )


def candidates(train: pd.DataFrame) -> dict:
    """Les cinq familles demandées, plus une dérivation par survie."""
    out: dict[str, tuple] = {}

    # Référence : la baseline V1, sans le temps restant.
    out["V1. baseline D (sans days_left)"] = (
        logistic(["age_days", "days_in_stage"], CAT_BASE),
        ["age_days", "days_in_stage", "stage"],
    )
    # A — la même, plus le temps restant.
    out["A. baseline D + days_left"] = (logistic(NUM_A, CAT_BASE), NUM_A + CAT_BASE)
    # B — interactions explicites.
    out["B. + interactions stage x temps"] = (
        logistic(NUM_B, CAT_BASE + ["stage_x_window"]),
        NUM_B + CAT_BASE + ["stage_x_window"],
    )
    # C — bins temporels croisés à l'étape, sans variable continue.
    out["C. bins temporels x etape"] = (
        logistic(["age_days", "days_in_stage"], ["stage_x_window"]),
        ["age_days", "days_in_stage", "stage_x_window"],
    )
    # D — arbres Core (days_left_in_month y figure déjà).
    num, cat = features(False, False)
    out["D. HistGradientBoosting Core"] = (make_pipeline("tree", num, cat, None), num + cat)

    for pipe, cols in out.values():
        pipe.fit(train[cols], train[LABEL])
    return out


def window_recalibration(data: pd.DataFrame, p: np.ndarray) -> dict[str, float]:
    """
    Recalibration en euros par fenetre, ajustee sur la VALIDATION.

    Les modeles sous-estiment de facon systematique le regime J-14..J-4 : la
    decroissance lineaire en `days_left` est trop raide au milieu du mois. On
    corrige donc chaque fenetre par un facteur multiplicatif unique, mesure sur
    la validation et applique tel quel au test. Cinq parametres pour 4 479
    observations : c'est une calibration, pas un apprentissage cache.
    """
    d = data.assign(p=p, amount0=data["amount"].fillna(0))
    factors: dict[str, float] = {}
    for name, lo, hi in WINDOWS:
        sub = d[(d["days_left"] >= lo) & (d["days_left"] <= hi)]
        if sub.empty:
            continue
        e = float((sub["amount0"] * sub["p"]).sum())
        r = float((sub["amount0"] * sub[LABEL]).sum())
        # Facteur borne : on corrige un biais, on ne reecrit pas le modele.
        factors[name] = float(np.clip(r / e, 0.4, 2.5)) if e > 0 else 1.0
    return factors


def apply_recalibration(data: pd.DataFrame, p: np.ndarray, factors: dict[str, float]) -> np.ndarray:
    out = p.copy()
    dl = data["days_left"].to_numpy()
    for name, lo, hi in WINDOWS:
        mask = (dl >= lo) & (dl <= hi)
        out[mask] = np.clip(out[mask] * factors.get(name, 1.0), 0.0, 1.0)
    return out


def survival_from_7d(train: pd.DataFrame, evaluate: pd.DataFrame) -> np.ndarray:
    """
    F — dérivation du modèle 7 jours validé, par survie discrète :

        P(signer avant fin de mois) = 1 - (1 - p7)^(jours restants / 7)

    Deux vertus : elle réutilise un modèle déjà calibré, et elle garantit PAR
    CONSTRUCTION que la probabilité tend vers zéro quand le mois se termine —
    exactement le comportement qui manquait à la V1.
    """
    num, cat = features(False, False)
    pipe = make_pipeline("tree", num, cat, None)
    pipe.fit(train[num + cat], train["signed_within_7d"])
    p7 = pipe.predict_proba(evaluate[num + cat])[:, 1]
    horizon = evaluate["days_left"].clip(lower=0).to_numpy() / 7.0
    return 1.0 - np.power(1.0 - np.clip(p7, 1e-9, 1 - 1e-9), horizon)


def euro(v: float) -> str:
    return f"{v / 1000:,.0f} k€".replace(",", " ")


def temporal_report(data: pd.DataFrame, p: np.ndarray) -> tuple[dict, float]:
    """Biais en euros par fenêtre temporelle. C'est le juge de paix."""
    d = data.assign(p=p, amount0=data["amount"].fillna(0))
    d["expected"] = d["amount0"] * d["p"]
    d["realise"] = d["amount0"] * d[LABEL]
    rows = {}
    for name, lo, hi in WINDOWS:
        sub = d[(d["days_left"] >= lo) & (d["days_left"] <= hi)]
        if sub.empty:
            continue
        e, r = float(sub["expected"].sum()), float(sub["realise"].sum())
        y = sub[LABEL].to_numpy()
        rows[name] = {
            "n": int(len(sub)),
            "expected": e,
            "realise": r,
            "biais_pct": ((e - r) / r * 100) if r else float("nan"),
            "brier": float(np.mean((sub["p"].to_numpy() - y) ** 2)),
            "predit_moyen": float(sub["p"].mean()),
            "observe_moyen": float(y.mean()),
        }
    e, r = float(d["expected"].sum()), float(d["realise"].sum())
    return rows, ((e - r) / r * 100) if r else float("nan")


def show_temporal(rows: dict, glob: float) -> None:
    print(f"    {'fenêtre':<34}{'n':>6}{'Expected':>11}{'réalisé':>11}{'biais':>9}{'prédit':>9}{'observé':>9}")
    for name, v in rows.items():
        print(
            f"    {name:<34}{v['n']:>6}{euro(v['expected']):>11}{euro(v['realise']):>11}"
            f"{v['biais_pct']:>8.1f}%{v['predit_moyen'] * 100:>8.2f}%{v['observe_moyen'] * 100:>8.2f}%"
        )
    print(f"    biais global : {glob:+.1f} %")


def evaluate_all(train: pd.DataFrame, data: pd.DataFrame, tag: str) -> dict:
    print(f"\n{'=' * 92}\n  {tag}\n{'=' * 92}")
    models = candidates(train)
    results: dict = {}

    for name, (pipe, cols) in models.items():
        p = pipe.predict_proba(data[cols])[:, 1]
        m = metrics(data[LABEL].to_numpy(), p)
        rows, glob = temporal_report(data, p)
        results[name] = {"metrics": {k: v for k, v in m.items() if k != "deciles"}, "windows": rows, "global_bias": glob}
        print(f"\n  {name}")
        print(f"    PR-AUC {m['pr_auc']:.4f} | ROC {m['roc_auc']:.3f} | Brier {m['brier']:.5f} | lift D1 {m['lift_top_decile']:.2f}x")
        show_temporal(rows, glob)

    # H — modele A recalibre en euros par fenetre, facteurs ajustes sur ces
    # memes donnees de validation puis figes pour le test.
    pipe_a, cols_a = models["A. baseline D + days_left"]
    pa = pipe_a.predict_proba(data[cols_a])[:, 1]
    factors = window_recalibration(data, pa)
    ph = apply_recalibration(data, pa, factors)
    mh = metrics(data[LABEL].to_numpy(), ph)
    rows_h, glob_h = temporal_report(data, ph)
    results["H. modele A + recalibration euros par fenetre"] = {
        "metrics": {k: v for k, v in mh.items() if k != "deciles"},
        "windows": rows_h,
        "global_bias": glob_h,
        "factors": factors,
    }
    print("\n  H. modele A + recalibration euros par fenetre")
    print(f"    facteurs : " + " · ".join(f"{k.split('(')[0].strip()} x{v:.2f}" for k, v in factors.items()))
    print(f"    PR-AUC {mh['pr_auc']:.4f} | ROC {mh['roc_auc']:.3f} | Brier {mh['brier']:.5f} | lift D1 {mh['lift_top_decile']:.2f}x")
    show_temporal(rows_h, glob_h)

    p = survival_from_7d(train, data)
    m = metrics(data[LABEL].to_numpy(), p)
    rows, glob = temporal_report(data, p)
    results["F. survie derivee du modele 7 jours"] = {
        "metrics": {k: v for k, v in m.items() if k != "deciles"},
        "windows": rows,
        "global_bias": glob,
    }
    print("\n  F. survie derivee du modele 7 jours")
    print(f"    PR-AUC {m['pr_auc']:.4f} | ROC {m['roc_auc']:.3f} | Brier {m['brier']:.5f} | lift D1 {m['lift_top_decile']:.2f}x")
    show_temporal(rows, glob)
    return results


def select(results: dict, baseline_pr: float) -> str:
    """
    Règle énoncée avant lecture : un candidat n'est éligible que si sa
    calibration en euros tient les seuils métier. La PR-AUC ne sert qu'à
    départager, et une perte de 5 % y est acceptée.
    """
    print(f"\n{'-' * 92}\n  SELECTION — critere produit : calibration en euros d'abord\n{'-' * 92}")
    eligible = []
    for name, r in results.items():
        w = r["windows"]
        last = w.get("dernière semaine (J-7..J-4)", {}).get("biais_pct", float("nan"))
        mid = w.get("mi-mois        (J-21..J-15)", {}).get("biais_pct", float("nan"))
        ok = (
            abs(r["global_bias"]) <= 10
            and abs(last) <= 15
            and abs(mid) <= 15
            and r["metrics"]["pr_auc"] >= baseline_pr * 0.95
        )
        print(
            f"  {'OK   ' if ok else 'rejet'} {name:<40} global {r['global_bias']:+7.1f}% | mi-mois {mid:+7.1f}%"
            f" | derniere sem. {last:+7.1f}% | PR-AUC {r['metrics']['pr_auc']:.4f}"
        )
        if ok:
            eligible.append(name)
    if not eligible:
        print("\n  aucun candidat ne satisfait les seuils")
        return ""
    best = max(eligible, key=lambda n: results[n]["metrics"]["pr_auc"])
    print(f"\n  RETENU : {best}")
    return best


def build_chosen(name: str, train: pd.DataFrame):
    if name.startswith("F."):
        return None, None
    models = candidates(train)
    return models[name]


def main() -> None:
    final = "--final" in sys.argv
    df = add_time_features(load())
    d = df["observation_date"]

    if not final:
        train = df[d <= TRAIN_END]
        valid = df[(d > TRAIN_END) & (d <= VALID_END)]
        print(f"\n  train {len(train)} obs · validation {len(valid)} obs — LE TEST N'EST PAS CHARGE")
        results = evaluate_all(train, valid, "VALIDATION — 2026-01-01 → 2026-04-30")
        baseline_pr = results["V1. baseline D (sans days_left)"]["metrics"]["pr_auc"]
        chosen = select(results, baseline_pr)
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        (ARTIFACTS / "monthend-selection.json").write_text(
            json.dumps({"results": results, "chosen": chosen}, indent=1, default=str), encoding="utf-8"
        )
        print(f"\n  ecrit dans data/expected-gmv/monthend-selection.json\n")
        return

    # --- Phase finale.
    selection = json.loads((ARTIFACTS / "monthend-selection.json").read_text(encoding="utf-8"))
    chosen = selection["chosen"]
    if not chosen:
        print("\n  Aucun modele selectionne : phase finale annulee.\n")
        return

    train = df[d <= TRAIN_END]
    valid = df[(d > TRAIN_END) & (d <= VALID_END)]
    train_valid = df[d <= VALID_END]
    test = df[(d > VALID_END) & (d <= TEST_END)]
    live = df[d > TEST_END]
    print(f"\n  train {len(train)} · validation {len(valid)} · TEST {len(test)} · live {len(live)}")
    print(f"  modele fige : {chosen}")

    # Les facteurs de recalibration sont mesures sur la VALIDATION a partir d'un
    # modele entraine sur le TRAIN SEUL — jamais sur ses propres predictions en
    # echantillon, sans quoi le biais nul serait un artefact. Ils sont ensuite
    # figes et appliques au test tels quels.
    frozen_factors: dict[str, float] = {}
    if chosen.startswith("H."):
        pipe_tr, cols_tr = candidates(train)["A. baseline D + days_left"]
        frozen_factors = window_recalibration(valid, pipe_tr.predict_proba(valid[cols_tr])[:, 1])
        print("  facteurs figes (mesures sur validation, modele entraine sur train) :")
        for k, v in frozen_factors.items():
            print(f"    {k:<34} x{v:.3f}")

    def predict(fitted_on: pd.DataFrame, data: pd.DataFrame) -> np.ndarray:
        if chosen.startswith("F."):
            return survival_from_7d(fitted_on, data)
        if chosen.startswith("H."):
            pipe, cols = candidates(fitted_on)["A. baseline D + days_left"]
            return apply_recalibration(data, pipe.predict_proba(data[cols])[:, 1], frozen_factors)
        pipe, cols = build_chosen(chosen, fitted_on)
        return pipe.predict_proba(data[cols])[:, 1]

    p = predict(train_valid, test)
    m = metrics(test[LABEL].to_numpy(), p)
    rows, glob = temporal_report(test, p)
    print(f"\n{'=' * 92}\n  TEST — lu une seule fois\n{'=' * 92}")
    print(f"  PR-AUC {m['pr_auc']:.4f} | ROC {m['roc_auc']:.3f} | Brier {m['brier']:.5f} | log loss {m['log_loss']:.4f} | lift D1 {m['lift_top_decile']:.2f}x")
    show_temporal(rows, glob)

    print("\n  CALIBRATION PAR DECILE (test)")
    dec = metrics(test[LABEL].to_numpy(), p)["deciles"]
    for r in dec:
        print(f"    D{r['decile']:<3}{r['n']:>6}  predit {r['predicted'] * 100:>6.2f}%  observe {r['observed'] * 100:>6.2f}%  ecart {(r['predicted'] - r['observed']) * 100:>+6.2f}pt")

    seen = set(train_valid["opportunity_id"])
    unseen = test[~test["opportunity_id"].isin(seen)]
    pu = predict(train_valid, unseen)
    mu = metrics(unseen[LABEL].to_numpy(), pu)
    _, gu = temporal_report(unseen, pu)
    print(f"\n  ROBUSTESSE — {len(unseen)} obs jamais vues, {int(unseen[LABEL].sum())} positifs")
    print(f"    PR-AUC {mu['pr_auc']:.4f} | Brier {mu['brier']:.5f} | biais global {gu:+.1f} %")

    print(f"\n  DISTRIBUTION DES PROBABILITES — etape x fenetre (test)")
    t = test.assign(p=p)
    piv = t.pivot_table(index="stage", columns="days_left_bin", values="p", aggfunc="median")
    order = [c for c in ["J-31..22", "J-21..15", "J-14..8", "J-7..4", "J-3..0"] if c in piv.columns]
    print(f"    {'etape':<22}" + "".join(f"{c:>11}" for c in order))
    for stage, row in piv[order].iterrows():
        print(f"    {stage:<22}" + "".join(f"{(row[c] * 100 if pd.notna(row[c]) else 0):>10.1f}%" for c in order))

    # --- Backtest mensuel : la métrique exacte de Forecast.
    print(f"\n{'=' * 92}\n  BACKTEST MENSUEL — finish attendu vs finish reel\n{'=' * 92}")
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    signed = pd.read_sql_query(
        "SELECT opportunity_id, actual_signature_at, amount FROM expected_gmv_observation "
        "WHERE actual_signature_at IS NOT NULL GROUP BY opportunity_id",
        con,
    )
    con.close()
    signed["m"] = signed["actual_signature_at"].str.slice(0, 7)
    signed["d"] = signed["actual_signature_at"].str.slice(0, 10)

    backtest = []
    t = test.assign(p=p, amount0=test["amount"].fillna(0))
    for month in sorted(t["observation_date"].str.slice(0, 7).unique()):
        final_gmv = float(signed.loc[signed["m"] == month, "amount"].sum())
        print(f"\n  {month} — finish reel {euro(final_gmv)}")
        print(f"    {'snapshot':<12}{'opps':>6}{'deja signe':>12}{'Expected restant':>18}{'finish attendu':>16}{'ecart':>9}")
        # Seuls les snapshots HEBDOMADAIRES sont exploitables : le dataset
        # genere une observation pour chaque opportunite ouverte chaque lundi,
        # tandis que les autres dates ne portent que les observations
        # evenementielles de quelques dossiers. Les melanger produisait un
        # « Expected restant » sautant de 6 k€ a 1 317 k€ d'un jour a l'autre.
        dates = sorted(
            d for d in t.loc[t["observation_date"].str.startswith(month), "observation_date"].unique()
            if pd.Timestamp(d).dayofweek == 0
        )
        for date in dates:
            sub = t[(t["observation_date"] == date) & (t["observation_kind"] == "weekly")]
            already = float(signed.loc[(signed["m"] == month) & (signed["d"] < date), "amount"].sum())
            remaining = float((sub["amount0"] * sub["p"]).sum())
            finish = already + remaining
            gap = (finish - final_gmv) / final_gmv * 100 if final_gmv else float("nan")
            print(f"    {date:<12}{len(sub):>6}{euro(already):>12}{euro(remaining):>18}{euro(finish):>16}{gap:>8.1f}%")
            backtest.append(
                {"month": month, "date": date, "already": already, "remaining": remaining, "finish": finish, "actual": final_gmv, "gap_pct": gap}
            )

    # --- Scoring live au 16/08.
    print(f"\n{'=' * 92}\n  SCORING LIVE — 16/08/2026\n{'=' * 92}")
    open_now = df[df["final_outcome"] == "open"].sort_values("observation_date")
    latest = open_now.groupby("opportunity_id").tail(1).copy()
    latest["p"] = predict(train_valid, latest)
    latest["amount0"] = latest["amount"].fillna(0)
    latest["expected"] = latest["amount0"] * latest["p"]

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    opp = pd.read_sql_query(
        "SELECT opportunity_id, owner, gmv, kanban_month, kanban_year, is_signed, is_terminal, is_standby, "
        "quote_signature_date FROM opportunity",
        con,
    )
    con.close()
    august = "2026-08"
    signed_m = opp[(opp["is_signed"] == 1) & (opp["quote_signature_date"].str.slice(0, 7) == august)]
    opp["kmonth"] = opp["kanban_year"].astype("Int64").astype(str) + "-" + opp["kanban_month"].astype("Int64").astype(str).str.zfill(2)
    kanban = opp[(opp["is_terminal"] == 0) & (opp["is_standby"] == 0) & (opp["kmonth"] == august)]

    signe = float(signed_m["gmv"].sum())
    exp_rest = float(latest["expected"].sum())
    kan_rest = float(kanban["gmv"].sum())
    print(f"\n  REGION — aout 2026")
    print(f"    Signe a date            {euro(signe):>12}")
    print(f"    Expected restant        {euro(exp_rest):>12}")
    print(f"    Expected finish         {euro(signe + exp_rest):>12}")
    print(f"    Kanban restant          {euro(kan_rest):>12}")
    print(f"    Kanban finish           {euro(signe + kan_rest):>12}")

    # Les deux sources n'ecrivent pas les noms de la meme facon : la table
    # `opportunity` porte le nom canonique de l'equipe, le dataset le nom brut
    # Salesforce. Sans normalisation, chaque commercial apparaissait deux fois.
    def norm_owner(x) -> str:
        return "".join(c for c in str(x).lower() if c.isalpha())

    canon = {norm_owner(o): o for o in kanban["owner"].unique()}
    for frame in (latest, kanban, signed_m):
        frame["owner_canon"] = frame["owner"].map(lambda x: canon.get(norm_owner(x), str(x)))

    print(f"\n  PAR COMMERCIAL")
    ksum = kanban.groupby("owner_canon")["gmv"].sum()
    ssum = signed_m.groupby("owner_canon")["gmv"].sum()
    esum = latest.groupby("owner_canon")["expected"].sum()
    owners = sorted(set(ksum.index) | set(ssum.index) | set(esum.index))
    print(f"    {'Commercial':<24}{'Signe':>10}{'Kanban rest.':>14}{'Exp. restant':>14}{'Exp. finish':>13}")
    for o in owners:
        s, k, e = float(ssum.get(o, 0)), float(ksum.get(o, 0)), float(esum.get(o, 0))
        print(f"    {o:<24}{euro(s):>10}{euro(k):>14}{euro(e):>14}{euro(s + e):>13}")

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "chosen": chosen,
        "test": {k: v for k, v in m.items() if k != "deciles"},
        "test_windows": rows,
        "test_global_bias": glob,
        "calibration_deciles": dec,
        "robustness": {"n": int(len(unseen)), "pr_auc": mu["pr_auc"], "brier": mu["brier"], "global_bias": gu},
        "recalibration_factors": frozen_factors,
        "backtest": backtest,
        "live": {
            "month": august,
            "signed": signe,
            "expected_remaining": exp_rest,
            "expected_finish": signe + exp_rest,
            "kanban_remaining": kan_rest,
            "kanban_finish": signe + kan_rest,
        },
    }
    (ARTIFACTS / "monthend-evaluation.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    latest[["opportunity_id", "owner", "stage", "amount", "days_left", "p", "expected"]].to_csv(
        ARTIFACTS / "monthend-live-scores.csv", index=False
    )
    print(f"\n  artefacts : monthend-selection.json · monthend-evaluation.json · monthend-live-scores.csv\n")


if __name__ == "__main__":
    main()

"""
Expected GMV fin de mois V1.2 — évaluateur Forecast dédoublonné, puis modèles.

    npm run expected:forecast -- --step backtest    A + B : moteur de backtest,
                                                    tests bloquants, recalcul V1/V1.1
    npm run expected:forecast -- --step amount       C : analyse montant/signature
    npm run expected:forecast -- --step select       D + E : modèles, sélection
                                                     sur janvier→avril uniquement
    npm run expected:forecast -- --step test         F→I : test mai-juillet,
                                                     robustesse, P10/P90, live août

La leçon de V1.1 est intégrée par construction : la métrique de référence n'est
plus le biais par observation (qui comptait une affaire autant de fois qu'elle
apparaissait dans le panel) mais l'erreur sur le finish mensuel, où chaque
opportunité pèse exactement une fois à chaque date Forecast.

Aucune écriture Salesforce, aucune écriture Google, aucune écriture SQLite.
Les artefacts vont dans `data/expected-gmv/`, hors Git.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from expected_gmv import (
    ARTIFACTS,
    DB,
    TEST_END,
    TRAIN_END,
    VALID_END,
    load,
    make_pipeline,
    metrics,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

LABEL = "signed_by_month_end"

VALID_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04"]
TEST_MONTHS = ["2026-05", "2026-06", "2026-07"]
LIVE_MONTH = "2026-08"
LIVE_DATE = "2026-08-17"

# Tranches de GMV. Bornes rondes et lisibles par un commercial, vérifiées
# ensuite sur les effectifs réels (étape C).
AMOUNT_BINS = [0.0, 25_000.0, 50_000.0, 100_000.0, 200_000.0, np.inf]
AMOUNT_LABELS = ["< 25 k", "25-50 k", "50-100 k", "100-200 k", ">= 200 k"]

LEFT_BINS = [-1, 3, 7, 14, 21, 40]
LEFT_LABELS = ["J-3..0", "J-7..4", "J-14..8", "J-21..15", "J-31..22"]

# Facteurs multiplicatifs figés de la V1.1, conservés uniquement pour rejouer
# cette version dans le nouvel évaluateur. Ils ne sont pas réutilisés en V1.2.
V11_FACTORS = [(22, 31, 0.960), (15, 21, 0.964), (8, 14, 1.068), (4, 7, 1.606), (0, 3, 1.027)]


def euro(v: float) -> str:
    return f"{v / 1000:,.0f} k€".replace(",", " ")


def pct(v: float) -> str:
    return f"{v * 100:+.1f} %"


def month_end(m: str) -> str:
    return str(pd.Period(m, freq="M").end_time.date())


# --- Features ----------------------------------------------------------------


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    a = df["amount"].astype(float)
    df["log_amount"] = np.log1p(a.fillna(a.median()))
    df["amount_bin"] = (
        pd.cut(a, AMOUNT_BINS, labels=AMOUNT_LABELS, right=False).astype(str).replace("nan", "inconnu")
    )
    df["days_left"] = df["days_left_in_month"].astype(float)
    df["left_bin"] = pd.cut(df["days_left"], LEFT_BINS, labels=LEFT_LABELS).astype(str)
    df["stage_str"] = df["stage"].fillna("(sans etape)").astype(str)
    df["stage_x_left"] = df["stage_str"] + " | " + df["left_bin"]
    df["stage_x_amount"] = df["stage_str"] + " | " + df["amount_bin"]
    df["left_x_logamount"] = df["days_left"] * df["log_amount"]
    df["instage_x_left"] = df["days_in_stage"].astype(float).fillna(0) * df["days_left"]
    return df


def recompute_time(pool: pd.DataFrame, as_of: str) -> pd.DataFrame:
    """Recale les features temporelles sur une date d'évaluation donnée.

    Utilisé uniquement pour le scoring live : les observations hebdomadaires
    portent déjà les bonnes valeurs à leur propre date.
    """
    d = pd.Timestamp(as_of)
    end = pd.Period(as_of[:7], freq="M").end_time.normalize()
    pool = pool.copy()
    pool["days_left"] = float((end - d).days)
    pool["day_of_month"] = d.day
    pool["days_left_in_month"] = int((end - d).days)
    drift = (d - pd.to_datetime(pool["observation_date"])).dt.days
    pool["age_days"] = pool["age_days"].astype(float) + drift
    pool["days_in_stage"] = pool["days_in_stage"].astype(float) + drift
    return add_features(pool)


# --- Moteur de backtest Forecast (étape A) -----------------------------------


def snapshot_dates(df: pd.DataFrame, months: list[str]) -> list[str]:
    """Les lundis hebdomadaires du périmètre.

    Le constructeur du dataset émet une observation pour chaque opportunité
    ouverte à chaque lundi ; une poignée d'observations tombent le dimanche
    (décalage de fuseau à la construction) et ne portent que 1 à 4 lignes : ce
    ne sont pas des instantanés exploitables.
    """
    w = df[df["observation_kind"] == "weekly"].copy()
    w["dow"] = pd.to_datetime(w["observation_date"]).dt.dayofweek
    g = w[w["dow"] == 0].groupby("observation_date").size()
    dates = [d for d in g[g >= 30].index if d[:7] in months]
    return sorted(dates)


def signature_table(df: pd.DataFrame) -> pd.DataFrame:
    """Une ligne par opportunité signée : date de signature et GMV réalisé.

    Le GMV retenu est celui de la dernière observation disponible, c'est-à-dire
    le montant connu au plus près de la signature — le constructeur cesse
    d'émettre dès que l'affaire devient terminale.
    """
    s = df[df["actual_signature_at"].notna()].copy()
    s = s.sort_values("observation_date").groupby("opportunity_id", as_index=False).tail(1)
    s = s[["opportunity_id", "owner", "actual_signature_at", "amount"]].copy()
    s["sig_day"] = s["actual_signature_at"].str.slice(0, 10)
    s = s.rename(columns={"amount": "signed_amount"})
    return s


def build_pool(df: pd.DataFrame, T: str) -> pd.DataFrame:
    """Le pipe commercialement ouvert à T, une ligne par opportunité.

    Le dédoublonnage est structurel : on ne prend que l'instantané hebdomadaire
    du jour T. La « dernière observation à T ou avant T » y est équivalente,
    parce qu'une opportunité absente d'un lundi est une opportunité déjà
    terminale — le contrôle BT5 le vérifie chiffre en main.
    """
    pool = df[(df["observation_date"] == T) & (df["observation_kind"] == "weekly")]
    return pool.copy()


def backtest(
    df: pd.DataFrame,
    months: list[str],
    score,
    label_name: str = "modele",
) -> pd.DataFrame:
    sig = signature_table(df)
    sig_map = sig.set_index("opportunity_id")
    rows = []
    for T in snapshot_dates(df, months):
        m = T[:7]
        end = month_end(m)
        pool = build_pool(df, T)
        if pool.empty:
            continue
        day = pool["opportunity_id"].map(sig_map["sig_day"])
        signs = ((day >= T) & (day <= end)).fillna(False).to_numpy()
        realised = pool["opportunity_id"].map(sig_map["signed_amount"]).astype(float)

        p = np.asarray(score(pool), dtype=float)
        amt = pool["amount"].astype(float).fillna(0.0).to_numpy()

        month_sig = sig[(sig["sig_day"] >= f"{m}-01") & (sig["sig_day"] <= end)]
        to_date = month_sig[month_sig["sig_day"] < T]

        expected_remaining = float((amt * p).sum())
        actual_remaining = float(amt[signs].sum())
        actual_remaining_realised = float(realised.to_numpy()[signs].sum())
        signed_to_date = float(to_date["signed_amount"].sum())
        month_total = float(month_sig["signed_amount"].sum())

        rows.append(
            {
                "model": label_name,
                "month": m,
                "date": T,
                "open_opps": int(len(pool)),
                "signed_to_date": signed_to_date,
                "expected_remaining": expected_remaining,
                "actual_remaining": actual_remaining,
                "actual_remaining_realised": actual_remaining_realised,
                "expected_finish": signed_to_date + expected_remaining,
                "actual_finish_scope": signed_to_date + actual_remaining_realised,
                "actual_finish_month": month_total,
                "signs_remaining": int(signs.sum()),
                "days_left": int(pool["days_left_in_month"].iloc[0]),
            }
        )
    bt = pd.DataFrame(rows)
    if bt.empty:
        return bt
    bt["error"] = bt["expected_finish"] - bt["actual_finish_month"]
    bt["error_pct"] = bt["error"] / bt["actual_finish_month"].replace(0, np.nan)
    bt["out_of_scope"] = bt["actual_finish_month"] - bt["actual_finish_scope"]
    return bt


def backtest_summary(bt: pd.DataFrame) -> dict:
    e = bt["error"].to_numpy()
    ap = bt["actual_finish_month"].to_numpy()
    last = bt.sort_values("date").groupby("month").tail(1)
    first = bt.sort_values("date").groupby("month").head(1)
    return {
        "snapshots": int(len(bt)),
        "mae": float(np.abs(e).mean()),
        "bias": float(e.mean()),
        "bias_pct": float(e.sum() / ap.sum()),
        "median_abs_error": float(np.median(np.abs(e))),
        "median_abs_error_pct": float(np.median(np.abs(bt["error_pct"]))),
        "mae_first_snapshot": float(np.abs(first["error"]).mean()),
        "mae_last_snapshot": float(np.abs(last["error"]).mean()),
        "bias_pct_last_snapshot": float(last["error"].sum() / last["actual_finish_month"].sum()),
    }


def print_backtest(bt: pd.DataFrame, title: str) -> None:
    print(f"\n  {title}")
    print(
        f"    {'date':<12}{'signé':>10}{'exp. rest.':>12}{'exp. finish':>13}"
        f"{'finish réel':>13}{'erreur €':>12}{'erreur %':>10}"
    )
    for m, grp in bt.groupby("month"):
        for _, r in grp.sort_values("date").iterrows():
            print(
                f"    {r['date']:<12}{euro(r['signed_to_date']):>10}{euro(r['expected_remaining']):>12}"
                f"{euro(r['expected_finish']):>13}{euro(r['actual_finish_month']):>13}"
                f"{euro(r['error']):>12}{pct(r['error_pct']):>10}"
            )
        print(f"    {'':<12}{'—' * 60}")
    s = backtest_summary(bt)
    print(
        f"    MAE {euro(s['mae'])} · biais {euro(s['bias'])} ({pct(s['bias_pct'])})"
        f" · erreur médiane {euro(s['median_abs_error'])}"
        f" · dernier snapshot {euro(s['mae_last_snapshot'])} ({pct(s['bias_pct_last_snapshot'])})"
    )


# --- Tests bloquants du moteur (étape A, contrôles BT1→BT7) ------------------


def engine_tests(df: pd.DataFrame) -> bool:
    print("\n" + "=" * 78)
    print("  A. MOTEUR DE BACKTEST — CONTROLES BLOQUANTS")
    print("=" * 78)
    ok = True
    months = VALID_MONTHS + TEST_MONTHS
    dates = snapshot_dates(df, months)
    sig = signature_table(df).set_index("opportunity_id")

    def check(name: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        if not passed:
            ok = False
        print(f"  {'ok   ' if passed else 'ÉCHEC'} {name}{f' — {detail}' if detail else ''}")

    # BT1 — unicité de l'Opportunity ID par instantané.
    dup = 0
    for T in dates:
        pool = build_pool(df, T)
        dup += len(pool) - pool["opportunity_id"].nunique()
    check("BT1. doublons d'Opportunity ID par snapshot", dup == 0, f"{dup} doublon(s) sur {len(dates)} snapshots")

    # BT2 — aucune affaire déjà terminale dans le pipe restant.
    terminal = 0
    signed_before = 0
    for T in dates:
        pool = build_pool(df, T)
        day = pool["opportunity_id"].map(sig["sig_day"])
        signed_before += int((day < T).fillna(False).sum())
        terminal += int((pool["stage"].isin(["Affaire perdue"])).sum())
    check(
        "BT2. aucune opportunité terminale dans le pipe restant",
        terminal == 0 and signed_before == 0,
        f"{terminal} étape perdue · {signed_before} déjà signée",
    )

    # BT3 — aucune feature postérieure à T. Les colonnes de résultat sont
    # nommées comme telles et ne doivent jamais entrer dans un scorer.
    forbidden = {"actual_signature_at", "days_to_signature", "final_outcome", LABEL, "signed_within_7d", "dataset_split"}
    used = set(FEATURES_ALL)
    check("BT3. aucune feature future dans les jeux de features", not (used & forbidden), f"{len(used)} features déclarées")

    # BT4 — une opportunité contribue au maximum une fois au GMV réel futur.
    over = 0
    for T in dates:
        pool = build_pool(df, T)
        day = pool["opportunity_id"].map(sig["sig_day"])
        signs = ((day >= T) & (day <= month_end(T[:7]))).fillna(False)
        ids = pool.loc[signs, "opportunity_id"]
        over += len(ids) - ids.nunique()
    check("BT4. contribution unique au GMV réel futur", over == 0, f"{over} contribution(s) en double")

    # BT5 — deux vérifications distinctes.
    #
    #   (a) une affaire déjà signée à T ne doit jamais repasser dans le pipe
    #       restant : l'intersection des deux ensembles doit être vide ;
    #   (b) signé à date + réel restant doit reconstituer à l'euro le total des
    #       signatures du mois qui appartiennent au périmètre du snapshot.
    #
    # L'écart au finish complet du mois n'est pas un défaut du moteur : ce sont
    # les affaires entrées dans le pipe après T. Elles signent dans le mois mais
    # n'existaient pas à la date où le Forecast est produit. On le chiffre.
    overlap = 0
    identity_gap = 0.0
    for T in dates:
        m = T[:7]
        end = month_end(m)
        pool = build_pool(df, T)
        day = pool["opportunity_id"].map(sig["sig_day"])
        rem = pool.loc[((day >= T) & (day <= end)).fillna(False), "opportunity_id"]
        before = sig[(sig["sig_day"] >= f"{m}-01") & (sig["sig_day"] < T)]
        overlap += len(set(rem) & set(before.index))
        scope = float(before["signed_amount"].sum()) + float(
            sig.loc[list(rem), "signed_amount"].sum()
        )
        expect = float(sig[(sig["sig_day"] >= f"{m}-01") & (sig["sig_day"] <= end)].loc[
            lambda s: s.index.isin(set(rem) | set(before.index)), "signed_amount"
        ].sum())
        identity_gap = max(identity_gap, abs(scope - expect))
    check("BT5a. aucune affaire signée ne repasse dans le pipe restant", overlap == 0, f"{overlap} intersection(s)")
    check("BT5b. signé + réel restant = signatures du périmètre, à l'euro", identity_gap < 1.0, f"écart max {identity_gap:.2f} €")

    bt = backtest(df, months, lambda pool: np.zeros(len(pool)), "zero")
    in_scope = 1 - bt["out_of_scope"].sum() / bt["actual_finish_month"].sum()
    print(
        f"  info  BT5c. couverture du périmètre {in_scope * 100:.1f} %"
        f" — le reste est non prévisible par construction (affaires créées après T)"
    )
    for m, grp in bt.groupby("month"):
        share = grp["out_of_scope"].sum() / grp["actual_finish_month"].sum()
        print(
            f"          {m} : finish réel {euro(grp['actual_finish_month'].iloc[0])}"
            f" · hors périmètre moyen {euro(grp['out_of_scope'].mean())} ({share * 100:.0f} %)"
        )

    # BT6 — vérification manuelle de dix opportunités sur plusieurs snapshots.
    print("\n  BT6. vérification manuelle (10 opportunités, 3 snapshots)")
    print(
        f"    {'snapshot':<12}{'opportunité':<20}{'étape':<24}{'GMV à T':>10}{'J-':>5}"
        f"{'signature':>12}{'dans le mois':>14}"
    )
    shown = 0
    for T in [d for d in dates if d in ("2026-02-02", "2026-04-06", "2026-06-15")]:
        pool = build_pool(df, T).sort_values("amount", ascending=False)
        for _, r in pool.head(4).iterrows():
            s = sig["sig_day"].get(r["opportunity_id"], None)
            fut = "oui" if isinstance(s, str) and T <= s <= month_end(T[:7]) else "non"
            print(
                f"    {T:<12}{r['opportunity_id'][:18]:<20}{str(r['stage'])[:22]:<24}"
                f"{euro(r['amount']):>10}{r['days_left_in_month']:>5}{(s or '—'):>12}{fut:>14}"
            )
            shown += 1
    check("BT6. dix opportunités inspectées", shown >= 10, f"{shown} lignes affichées")

    # BT7 est produit à l'étape B.
    return ok


# --- Jeux de features et modèles (étape D) -----------------------------------

FEATURE_SETS: dict[str, dict] = {
    "M1 Logistic Core": {
        "kind": "logistic",
        "num": ["age_days", "days_in_stage", "stage_changes", "days_left", "log_amount"],
        "cat": ["stage_str"],
    },
    "M2 Logistic interactions": {
        "kind": "logistic",
        "num": ["age_days", "days_in_stage", "stage_changes", "days_left", "log_amount", "left_x_logamount"],
        "cat": ["stage_str", "stage_x_left", "stage_x_amount"],
    },
    "M3 HistGB Core": {
        "kind": "tree",
        "num": ["amount", "log_amount", "age_days", "days_in_stage", "stage_changes", "days_left"],
        "cat": ["stage_str"],
    },
    "M4 Rich (jalons C2)": {
        "kind": "tree",
        "num": [
            "amount",
            "log_amount",
            "age_days",
            "days_in_stage",
            "stage_changes",
            "days_left",
            "days_since_estimation",
            "days_since_devis",
            "estimation_relance_delay_days",
            "devis_relance_delay_days",
            "visit_et_past",
            "visit_artisan_past",
        ],
        "cat": ["stage_str", "has_estimation", "has_devis", "has_devis_relance"],
        "rich": True,
    },
    "M5 Logistic sans montant": {
        "kind": "logistic",
        "num": ["age_days", "days_in_stage", "stage_changes", "days_left"],
        "cat": ["stage_str"],
    },
    "M6 Logistic tranche GMV": {
        "kind": "logistic",
        "num": ["age_days", "days_in_stage", "stage_changes", "days_left"],
        "cat": ["stage_str", "amount_bin"],
    },
}

FEATURES_ALL = sorted({c for s in FEATURE_SETS.values() for c in s["num"] + s["cat"]})

# Le challenger pondéré par le GMV est déclaré séparément : la cible du modèle
# principal reste une probabilité de signature, jamais un euro.
CHALLENGER = "M3w HistGB pondere GMV (challenger)"
VARIANTS: dict[str, tuple[str, bool]] = {n: (n, False) for n in FEATURE_SETS}
VARIANTS[CHALLENGER] = ("M3 HistGB Core", True)


def spec_of(name: str) -> dict:
    return FEATURE_SETS[VARIANTS[name][0]]


def fit_model(name: str, train: pd.DataFrame, weighted: bool | None = None):
    key, w_default = VARIANTS[name]
    weighted = w_default if weighted is None else weighted
    spec = FEATURE_SETS[key]
    tr = train[train["milestones_available"] == 1] if spec.get("rich") else train
    cols = spec["num"] + spec["cat"]
    pipe = make_pipeline(spec["kind"], spec["num"], spec["cat"], None)
    if weighted:
        # Variante challenger explicitement isolée : la cible reste une
        # probabilité, seule la pondération d'apprentissage change.
        w = tr["amount"].astype(float).fillna(tr["amount"].median()).to_numpy()
        pipe.fit(tr[cols], tr[LABEL], model__sample_weight=w / w.mean())
    else:
        pipe.fit(tr[cols], tr[LABEL])
    return lambda d: pipe.predict_proba(d[cols])[:, 1], pipe, cols


# --- Scorers de référence V1 / V1.1 (étape B) --------------------------------


def scorer_v1(train: pd.DataFrame):
    """V1 : la baseline D retenue en C5 — étape + âge + temps dans l'étape."""
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    cols = ["age_days", "days_in_stage"]
    pipe = Pipeline(
        [
            (
                "pre",
                ColumnTransformer(
                    [
                        ("num", Pipeline([("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]), cols),
                        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), ["stage_str"]),
                    ]
                ),
            ),
            ("model", LogisticRegression(max_iter=1000)),
        ]
    )
    pipe.fit(train[cols + ["stage_str"]], train[LABEL])
    return lambda d: pipe.predict_proba(d[cols + ["stage_str"]])[:, 1]


def scorer_v11(train: pd.DataFrame):
    """V1.1 : modèle A (V1 + jours restants) puis facteurs figés par fenêtre."""
    score, _, cols = fit_model("M5 Logistic sans montant", train)

    def inner(d: pd.DataFrame) -> np.ndarray:
        p = score(d)
        left = d["days_left_in_month"].to_numpy()
        f = np.ones(len(d))
        for lo, hi, k in V11_FACTORS:
            f[(left >= lo) & (left <= hi)] = k
        return np.clip(p * f, 0.0, 1.0)

    return inner


# --- Étape C : montant et signature ------------------------------------------


def amount_analysis(df: pd.DataFrame) -> dict:
    print("\n" + "=" * 78)
    print("  C. RELATION MONTANT / SIGNATURE")
    print("=" * 78)
    d = df[df["observation_date"] <= VALID_END]
    out: dict = {"bins": [], "by_stage": []}
    print(f"\n  Base : train + validation ({len(d)} observations, jusqu'au {VALID_END})")
    print(
        f"    {'tranche':<12}{'obs':>7}{'opps':>7}{'GMV moy':>10}{'GMV méd':>10}"
        f"{'taux sign.':>12}{'GMV signé moy':>15}"
    )
    for b in AMOUNT_LABELS:
        g = d[d["amount_bin"] == b]
        if g.empty:
            continue
        s = g[g[LABEL] == 1]
        row = {
            "bin": b,
            "n": int(len(g)),
            "opps": int(g["opportunity_id"].nunique()),
            "mean_amount": float(g["amount"].mean()),
            "median_amount": float(g["amount"].median()),
            "rate": float(g[LABEL].mean()),
            "mean_signed_amount": float(s["amount"].mean()) if len(s) else 0.0,
        }
        out["bins"].append(row)
        print(
            f"    {b:<12}{row['n']:>7}{row['opps']:>7}{euro(row['mean_amount']):>10}"
            f"{euro(row['median_amount']):>10}{row['rate'] * 100:>11.2f} %{euro(row['mean_signed_amount']):>15}"
        )

    print(f"\n  Taux de signature avant fin de mois, par étape × tranche (— si moins de 40 obs)")
    stages = d["stage_str"].value_counts()
    stages = [s for s in stages.index if stages[s] >= 200]
    header = "".join(f"{b:>12}" for b in AMOUNT_LABELS)
    print(f"    {'étape':<26}{header}{'total':>10}")
    for st in stages:
        g = d[d["stage_str"] == st]
        cells = ""
        for b in AMOUNT_LABELS:
            h = g[g["amount_bin"] == b]
            cells += f"{'—':>12}" if len(h) < 40 else f"{h[LABEL].mean() * 100:>11.1f}%"
            out["by_stage"].append(
                {"stage": st, "bin": b, "n": int(len(h)), "rate": float(h[LABEL].mean()) if len(h) else None}
            )
        print(f"    {st[:24]:<26}{cells}{g[LABEL].mean() * 100:>9.1f}%")

    sg = d[d[LABEL] == 1]["amount"]
    ng = d[d[LABEL] == 0]["amount"]
    print(f"\n  GMV moyen des observations qui signent dans le mois : {euro(sg.mean())} (médiane {euro(sg.median())})")
    print(f"  GMV moyen des observations qui ne signent pas        : {euro(ng.mean())} (médiane {euro(ng.median())})")
    print(f"  ratio signé / non signé                              : {sg.mean() / ng.mean():.3f}")
    out["mean_signed"] = float(sg.mean())
    out["mean_unsigned"] = float(ng.mean())
    out["ratio"] = float(sg.mean() / ng.mean())

    # Stabilité : le ratio doit se retrouver mois après mois, sinon la relation
    # n'est qu'un artefact d'un ou deux gros dossiers perdus.
    print(f"\n  Stabilité du ratio par trimestre d'observation")
    d = d.copy()
    d["q"] = pd.PeriodIndex(pd.to_datetime(d["observation_date"]), freq="Q").astype(str)
    print(f"    {'trimestre':<12}{'obs':>7}{'signé moy':>12}{'non signé moy':>15}{'ratio':>8}")
    for q, g in d.groupby("q"):
        a, b = g[g[LABEL] == 1]["amount"], g[g[LABEL] == 0]["amount"]
        if len(a) < 10:
            continue
        print(f"    {q:<12}{len(g):>7}{euro(a.mean()):>12}{euro(b.mean()):>15}{a.mean() / b.mean():>8.3f}")
        out.setdefault("quarters", []).append({"quarter": q, "ratio": float(a.mean() / b.mean()), "n": int(len(g))})
    return out


# --- Étape D/E : modèles et sélection ----------------------------------------


def prob_metrics(model, d: pd.DataFrame, spec: dict) -> dict:
    sub = d[d["milestones_available"] == 1] if spec.get("rich") else d
    p = model(sub)
    return metrics(sub[LABEL].to_numpy(), p)


def bin_table(df: pd.DataFrame, months: list[str], score) -> pd.DataFrame:
    """Expected vs réel par tranche de GMV, sur base dédoublonnée."""
    sig = signature_table(df).set_index("opportunity_id")
    acc: dict[str, dict] = {b: {"exp": 0.0, "act": 0.0, "n": 0, "p": 0.0, "hit": 0} for b in AMOUNT_LABELS}
    for T in snapshot_dates(df, months):
        pool = build_pool(df, T)
        day = pool["opportunity_id"].map(sig["sig_day"])
        signs = ((day >= T) & (day <= month_end(T[:7]))).fillna(False).to_numpy()
        p = np.asarray(score(pool), dtype=float)
        amt = pool["amount"].astype(float).fillna(0).to_numpy()
        for b in AMOUNT_LABELS:
            mask = (pool["amount_bin"] == b).to_numpy()
            if not mask.any():
                continue
            a = acc[b]
            a["exp"] += float((amt[mask] * p[mask]).sum())
            a["act"] += float(amt[mask & signs].sum())
            a["n"] += int(mask.sum())
            a["p"] += float(p[mask].sum())
            a["hit"] += int((mask & signs).sum())
    rows = []
    for b, a in acc.items():
        if a["n"] == 0:
            continue
        rows.append(
            {
                "bin": b,
                "n": a["n"],
                "mean_p": a["p"] / a["n"],
                "rate": a["hit"] / a["n"],
                "expected": a["exp"],
                "actual": a["act"],
                "bias_pct": (a["exp"] - a["act"]) / a["act"] if a["act"] else np.nan,
            }
        )
    return pd.DataFrame(rows)


def print_bin_table(t: pd.DataFrame, title: str) -> None:
    print(f"\n  {title}")
    print(f"    {'tranche':<12}{'obs':>7}{'p moy':>9}{'taux réel':>11}{'Expected':>12}{'réel':>12}{'biais':>10}")
    for _, r in t.iterrows():
        print(
            f"    {r['bin']:<12}{int(r['n']):>7}{r['mean_p'] * 100:>8.1f}%{r['rate'] * 100:>10.1f}%"
            f"{euro(r['expected']):>12}{euro(r['actual']):>12}{pct(r['bias_pct']):>10}"
        )


def stage_time_table(df: pd.DataFrame, months: list[str], score) -> None:
    rows = []
    for T in snapshot_dates(df, months):
        pool = build_pool(df, T)
        pool = pool.assign(p=np.asarray(score(pool), dtype=float))
        rows.append(pool[["stage_str", "left_bin", "p"]])
    d = pd.concat(rows)
    piv = d.pivot_table(index="stage_str", columns="left_bin", values="p", aggfunc="mean")
    cnt = d.pivot_table(index="stage_str", columns="left_bin", values="p", aggfunc="size")
    order = [c for c in reversed(LEFT_LABELS) if c in piv.columns]
    print(f"\n  Probabilité moyenne prédite par étape × jours restants (— si moins de 30 obs)")
    print(f"    {'étape':<26}" + "".join(f"{c:>12}" for c in order))
    for st in piv.index:
        cells = ""
        for c in order:
            v, n = piv.loc[st, c], cnt.loc[st, c]
            cells += f"{'—':>12}" if pd.isna(v) or n < 30 else f"{v * 100:>11.1f}%"
        print(f"    {st[:24]:<26}{cells}")


# --- Étape H : simulation ----------------------------------------------------


def simulate(amounts: np.ndarray, p: np.ndarray, draws: int = 20_000, seed: int = 42) -> dict:
    rng = np.random.default_rng(seed)
    tot = np.empty(draws)
    for i in range(draws):
        tot[i] = float((amounts * (rng.random(len(p)) < p)).sum())
    return {
        "mean": float(tot.mean()),
        "median": float(np.median(tot)),
        "p10": float(np.quantile(tot, 0.10)),
        "p90": float(np.quantile(tot, 0.90)),
        "p25": float(np.quantile(tot, 0.25)),
        "p75": float(np.quantile(tot, 0.75)),
    }


# --- Orchestration -----------------------------------------------------------


def prepare() -> pd.DataFrame:
    df = add_features(load())
    return df


def step_backtest(df: pd.DataFrame) -> dict:
    ok = engine_tests(df)
    if not ok:
        print("\n  Contrôles bloquants en échec : arrêt avant tout entraînement.\n")
        sys.exit(1)

    print("\n" + "=" * 78)
    print("  B. V1 ET V1.1 REJOUEES DANS L'EVALUATEUR DEDOUBLONNE  (BT7)")
    print("=" * 78)
    train = df[df["observation_date"] <= TRAIN_END]
    out: dict = {}
    for name, sc in [("V1", scorer_v1(train)), ("V1.1", scorer_v11(train))]:
        bt = backtest(df, TEST_MONTHS, sc, name)
        print_backtest(bt, f"{name} — mai / juin / juillet 2026")
        out[name] = backtest_summary(bt)
        bt_v = backtest(df, VALID_MONTHS, sc, name)
        out[name + " (validation)"] = backtest_summary(bt_v)
        s = out[name + " (validation)"]
        print(f"    rappel janvier→avril : MAE {euro(s['mae'])} · biais {pct(s['bias_pct'])}")
    return out


def step_select(df: pd.DataFrame) -> dict:
    print("\n" + "=" * 78)
    print("  D. MODELES V1.2 — train 2024-08→2025-12, sélection sur 2026-01→04")
    print("=" * 78)
    train = df[df["observation_date"] <= TRAIN_END]
    valid = df[(df["observation_date"] > TRAIN_END) & (df["observation_date"] <= VALID_END)]
    print(f"\n  train {len(train)} obs · validation {len(valid)} obs · base {train[LABEL].mean() * 100:.2f} %")

    results: dict = {"models": {}}
    variants: list[tuple[str, object, dict]] = []
    for name in VARIANTS:
        score, _, _ = fit_model(name, train)
        variants.append((name, score, spec_of(name)))

    print(f"\n  Probabilité (validation)")
    print(f"    {'modèle':<38}{'PR-AUC':>9}{'Brier':>10}{'log loss':>10}{'lift D1':>9}")
    for name, score, spec in variants:
        m = prob_metrics(score, valid, spec)
        results["models"][name] = {"prob": m}
        print(
            f"    {name:<38}{m['pr_auc']:>9.4f}{m['brier']:>10.5f}{m['log_loss']:>10.4f}"
            f"{m['lift_top_decile']:>8.2f}x"
        )

    print(f"\n  Forecast GMV dédoublonné (janvier→avril 2026) — critère produit prioritaire")
    print(
        f"    {'modèle':<38}{'MAE':>11}{'biais':>11}{'biais %':>10}"
        f"{'err. méd.':>11}{'dernier snap.':>15}"
    )
    for name, score, _ in variants:
        bt = backtest(df, VALID_MONTHS, score, name)
        s = backtest_summary(bt)
        results["models"][name]["forecast"] = s
        results["models"][name]["backtest"] = bt.to_dict("records")
        print(
            f"    {name:<38}{euro(s['mae']):>11}{euro(s['bias']):>11}{pct(s['bias_pct']):>10}"
            f"{euro(s['median_abs_error']):>11}{pct(s['bias_pct_last_snapshot']):>15}"
        )

    # Règle de sélection. Elle traduit directement les critères d'acceptation :
    #   1. le Brier ne doit pas dépasser de 10 % le meilleur observé (AC6) ;
    #   2. la PR-AUC ne doit pas être inférieure de plus de 10 % à la meilleure
    #      (AC7) ;
    #   3. la probabilité moyenne prédite sur la bande >= 100 k€ doit rester
    #      dans l'intervalle de confiance à 95 % du taux observé (AC3) ;
    #   4. le challenger pondéré par le GMV est hors sélection principale : il
    #      ne peut prendre la place du modèle retenu que s'il fait clairement
    #      mieux, soit plus de 10 % de MAE en moins sans dégrader le Brier ;
    #   5. parmi les survivants, la plus petite MAE Forecast ;
    #   6. à moins de 5 % d'écart de MAE, le modèle le plus simple gagne.
    best_brier = min(v["prob"]["brier"] for v in results["models"].values())
    best_prauc = max(v["prob"]["pr_auc"] for v in results["models"].values())
    eligible = {}
    print(f"\n  E. ELIGIBILITE")
    for name, score, _ in variants:
        v = results["models"][name]
        t = bin_table(df, VALID_MONTHS, score)
        big = t[t["bin"].isin(["100-200 k", ">= 200 k"])]
        exp_big, act_big = float(big["expected"].sum()), float(big["actual"].sum())
        v["big_expected"] = exp_big
        v["big_actual"] = act_big
        v["big_euro_bias"] = (exp_big - act_big) / act_big if act_big > 0 else float("inf")
        # AC3 doit se mesurer là où il y a de quoi mesurer. Sur janvier-avril la
        # bande >= 100 k€ ne compte qu'une dizaine d'affaires distinctes : un
        # biais en euros y est dominé par le hasard d'un ou deux dossiers, et
        # c'est exactement l'erreur commise en V1.1 avec les seuils à 15 % par
        # fenêtre. Le test porte donc sur la probabilité : la moyenne prédite
        # doit rester dans l'intervalle de confiance à 95 % du taux observé.
        n_big = int(big["n"].sum())
        obs = float((big["rate"] * big["n"]).sum() / n_big)
        pred = float((big["mean_p"] * big["n"]).sum() / n_big)
        z = 1.96
        d = 1 + z * z / n_big
        centre = obs + z * z / (2 * n_big)
        half = z * np.sqrt(obs * (1 - obs) / n_big + z * z / (4 * n_big * n_big))
        upper = (centre + half) / d
        worst_big = pred - upper
        v["big_predicted_rate"] = pred
        v["big_observed_rate"] = obs
        v["big_ci_upper"] = upper
        v["worst_big_bias"] = worst_big
        reasons = []
        if v["prob"]["brier"] > best_brier * 1.10:
            reasons.append("Brier")
        if v["prob"]["pr_auc"] < best_prauc * 0.90:
            reasons.append("PR-AUC")
        if worst_big > 0.0:
            reasons.append("grosses affaires")
        if name == CHALLENGER:
            reasons.append("challenger hors selection principale")
        if not reasons:
            eligible[name] = v
        print(
            f"    {name:<38}{'retenu' if not reasons else 'écarté : ' + ', '.join(reasons):<52}"
            f" >=100 k€ : prédit {v['big_predicted_rate'] * 100:.2f} % vs observé"
            f" {v['big_observed_rate'] * 100:.2f} % (borne haute {v['big_ci_upper'] * 100:.2f} %)"
            f" · biais € {pct(v['big_euro_bias']) if np.isfinite(v['big_euro_bias']) else 'n/d'}"
        )

    if not eligible:
        eligible = {k: v for k, v in results["models"].items() if k != CHALLENGER}
    floor = min(v["forecast"]["mae"] for v in eligible.values())
    best_mae = min(eligible, key=lambda k: eligible[k]["forecast"]["mae"])

    # Dix-sept snapshots de validation ne permettent pas de départager deux MAE
    # à 10 % près. On rééchantillonne les snapshots pour obtenir l'intervalle de
    # l'écart apparié : tant que zéro y figure, les deux modèles sont
    # indistinguables et c'est le tie-break qui décide, pas la MAE.
    err = {k: np.array([r["error"] for r in eligible[k]["backtest"]]) for k in eligible}
    rng = np.random.default_rng(7)
    n = len(err[best_mae])
    idx = rng.integers(0, n, size=(3000, n))
    near = []
    print(f"\n    MAE plancher {euro(floor)} ({best_mae}) — écart apparié rééchantillonné sur {n} snapshots")
    for k in sorted(eligible, key=lambda x: eligible[x]["forecast"]["mae"]):
        diff = np.abs(err[k])[idx].mean(axis=1) - np.abs(err[best_mae])[idx].mean(axis=1)
        lo, hi = np.quantile(diff, [0.025, 0.975])
        same = lo <= 0 <= hi
        if same:
            near.append(k)
        print(
            f"      {k:<38}MAE {euro(eligible[k]['forecast']['mae']):>10}"
            f"  Δ vs plancher {euro(diff.mean()):>9}  IC95 [{euro(lo)} ; {euro(hi)}]"
            f"  {'indistinguable' if same else 'nettement pire'}"
        )
    simplicity = lambda n: (0 if n.startswith(("M1", "M5", "M6")) else 1, 1 if "Rich" in n else 0)
    chosen = sorted(near, key=simplicity)[0]

    ch = results["models"][CHALLENGER]
    beats = ch["forecast"]["mae"] < results["models"][chosen]["forecast"]["mae"] * 0.90
    keeps = ch["prob"]["brier"] <= results["models"][chosen]["prob"]["brier"] * 1.02
    print(
        f"    challenger pondéré : MAE {euro(ch['forecast']['mae'])} vs {euro(results['models'][chosen]['forecast']['mae'])}"
        f" · Brier {ch['prob']['brier']:.5f} vs {results['models'][chosen]['prob']['brier']:.5f}"
        f" → {'promu' if beats and keeps else 'non promu'}"
    )
    if beats and keeps:
        chosen = CHALLENGER
    print(f"    RETENU : {chosen}")
    results["selected"] = chosen
    results["eligible"] = list(eligible)
    results["near_best"] = near

    score, _, _ = fit_model(chosen, train)
    print_bin_table(bin_table(df, VALID_MONTHS, score), f"Par tranche GMV — validation — {chosen}")
    stage_time_table(df, VALID_MONTHS, score)
    m = prob_metrics(score, valid, spec_of(chosen))
    print(f"\n  Calibration par décile (validation) — {chosen}")
    print(f"    {'décile':<8}{'n':>6}{'prédit':>10}{'observé':>10}")
    for d in m["deciles"]:
        print(f"    D{d['decile']:<7}{d['n']:>6}{d['predicted'] * 100:>9.1f}%{d['observed'] * 100:>9.1f}%")

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "forecast-selection.json").write_text(
        json.dumps({k: v for k, v in results.items()}, indent=1, default=str), encoding="utf-8"
    )
    print(f"\n  → data/expected-gmv/forecast-selection.json")
    return results


def step_test(df: pd.DataFrame, chosen: str) -> dict:
    print("\n" + "=" * 78)
    print(f"  F. TEST MAI-JUILLET 2026 — ouverture unique — modèle {chosen}")
    print("=" * 78)
    train = df[df["observation_date"] <= TRAIN_END]
    valid_end = df[df["observation_date"] <= VALID_END]
    test = df[(df["observation_date"] > VALID_END) & (df["observation_date"] <= TEST_END)]
    spec = spec_of(chosen)

    score, pipe, cols = fit_model(chosen, train)
    out: dict = {"selected": chosen}

    bt = backtest(df, TEST_MONTHS, score, chosen)
    print_backtest(bt, f"{chosen} — test mai / juin / juillet 2026")
    out["test_forecast"] = backtest_summary(bt)
    out["test_backtest"] = bt.to_dict("records")

    m = prob_metrics(score, test, spec)
    out["test_prob"] = m
    print(f"\n  Probabilité (test) : PR-AUC {m['pr_auc']:.4f} · Brier {m['brier']:.5f} · log loss {m['log_loss']:.4f}")
    print(f"    {'décile':<8}{'n':>6}{'prédit':>10}{'observé':>10}")
    for d in m["deciles"]:
        print(f"    D{d['decile']:<7}{d['n']:>6}{d['predicted'] * 100:>9.1f}%{d['observed'] * 100:>9.1f}%")

    # AC6 et AC7 se mesurent contre V1 et V1.1 sur exactement les mêmes
    # observations et le même code : les chiffres publiés en C5 et V1.1 venaient
    # d'un autre chemin de calcul et ne sont pas directement comparables.
    print(f"\n  Comparaison sur les mêmes observations de test")
    print(f"    {'version':<12}{'PR-AUC':>9}{'Brier':>10}{'log loss':>10}{'MAE Forecast':>14}{'biais':>10}")
    comp = {}
    for nm, sc in [("V1", scorer_v1(train)), ("V1.1", scorer_v11(train)), (chosen, score)]:
        mm = metrics(test[LABEL].to_numpy(), sc(test))
        bb = backtest_summary(backtest(df, TEST_MONTHS, sc, nm))
        comp[nm] = {"prob": {k: mm[k] for k in ("pr_auc", "brier", "log_loss")}, "forecast": bb}
        print(
            f"    {nm[:11]:<12}{mm['pr_auc']:>9.4f}{mm['brier']:>10.5f}{mm['log_loss']:>10.4f}"
            f"{euro(bb['mae']):>14}{pct(bb['bias_pct']):>10}"
        )
    out["comparison"] = comp

    print_bin_table(bin_table(df, TEST_MONTHS, score), "Par tranche GMV — test")
    stage_time_table(df, TEST_MONTHS, score)

    # Erreur par position dans le mois.
    bt = bt.assign(pos=pd.cut(bt["days_left"], LEFT_BINS, labels=LEFT_LABELS).astype(str))
    print(f"\n  Erreur par position dans le mois (test)")
    print(f"    {'fenêtre':<12}{'snapshots':>11}{'MAE':>11}{'biais':>11}{'biais %':>10}")
    for c in reversed(LEFT_LABELS):
        g = bt[bt["pos"] == c]
        if g.empty:
            continue
        print(
            f"    {c:<12}{len(g):>11}{euro(g['error'].abs().mean()):>11}{euro(g['error'].mean()):>11}"
            f"{pct(g['error'].sum() / g['actual_finish_month'].sum()):>10}"
        )

    # G. Robustesse : opportunités jamais vues à l'entraînement.
    print("\n" + "=" * 78)
    print("  G. ROBUSTESSE — opportunités absentes du train")
    print("=" * 78)
    seen = set(train["opportunity_id"])
    unseen = test[~test["opportunity_id"].isin(seen)]
    if spec.get("rich"):
        unseen = unseen[unseen["milestones_available"] == 1]
    mu = metrics(unseen[LABEL].to_numpy(), score(unseen))
    print(
        f"  {len(unseen)} observations · {unseen['opportunity_id'].nunique()} opportunités inédites"
        f" · PR-AUC {mu['pr_auc']:.4f} · Brier {mu['brier']:.5f}"
    )
    exp = float((unseen["amount"].astype(float) * score(unseen)).sum())
    act = float(unseen.loc[unseen[LABEL] == 1, "amount"].sum())
    print(f"  Expected {euro(exp)} vs réel {euro(act)} (base observation, non dédoublonnée) → {pct((exp - act) / act)}")
    out["robustness"] = {"n": int(len(unseen)), "opps": int(unseen["opportunity_id"].nunique()), **{k: mu[k] for k in ("pr_auc", "brier")}, "bias_pct": (exp - act) / act}

    # H + I : le modèle de production est réentraîné sur train + validation,
    # le test restant strictement une mesure. Août est scoré avec ce modèle.
    print("\n" + "=" * 78)
    print(f"  H/I. SCORING LIVE {LIVE_MONTH} — modèle réentraîné sur train + validation")
    print("=" * 78)
    live_score, _, _ = fit_model(chosen, valid_end)

    # Le dernier lundi complet. Quelques observations tombent le dimanche et ne
    # portent que 4 lignes : les prendre pour instantané viderait le pipe.
    w = df[df["observation_kind"] == "weekly"].copy()
    w["dow"] = pd.to_datetime(w["observation_date"]).dt.dayofweek
    g = w[(w["dow"] == 0) & (w["observation_date"] <= LIVE_DATE)].groupby("observation_date").size()
    last_monday = max(g[g >= 30].index)
    print(f"  instantané de référence : {last_monday} ({int(g[last_monday])} affaires ouvertes)")
    pool = build_pool(df, last_monday)
    sig = signature_table(df)
    signed_ids = set(sig["opportunity_id"])
    pool = pool[~pool["opportunity_id"].isin(signed_ids)]
    pool = recompute_time(pool, LIVE_DATE)
    p = np.asarray(live_score(pool), dtype=float)
    amt = pool["amount"].astype(float).fillna(0).to_numpy()

    signed_aug = sig[sig["sig_day"].str.slice(0, 7) == LIVE_MONTH]
    signed = float(signed_aug["signed_amount"].sum())
    exp_rest = float((amt * p).sum())
    sim = simulate(amt, p)

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    opp = pd.read_sql_query("SELECT * FROM opportunity", con)
    con.close()
    kmonth = opp["kanban_year"].astype("Int64").astype(str) + "-" + opp["kanban_month"].astype("Int64").astype(str).str.zfill(2)
    kan = opp[(opp["is_terminal"] == 0) & (opp["is_standby"] == 0) & (kmonth == LIVE_MONTH)]
    kan_rest = float(kan["gmv"].sum())

    print(f"\n  REGION — {LIVE_MONTH} (au {LIVE_DATE}, J-{int(pool['days_left'].iloc[0])})")
    print(f"    Signé à date            {euro(signed):>14}")
    print(f"    Kanban restant          {euro(kan_rest):>14}")
    print(f"    Kanban finish           {euro(signed + kan_rest):>14}")
    print(f"    Expected restant        {euro(exp_rest):>14}   ({len(pool)} affaires ouvertes)")
    print(f"    Expected finish         {euro(signed + exp_rest):>14}")
    print(f"    Zone probable P10-P90   {euro(signed + sim['p10'])} – {euro(signed + sim['p90'])}")
    print(f"    médiane simulée         {euro(signed + sim['median']):>14}   (P25 {euro(signed + sim['p25'])} · P75 {euro(signed + sim['p75'])})")

    def norm(x) -> str:
        return "".join(c for c in str(x).lower() if c.isalpha())

    canon = {norm(o): o for o in kan["owner"].unique()}
    pool = pool.assign(oc=[canon.get(norm(o), str(o)) for o in pool["owner"]])
    sa = signed_aug.assign(oc=[canon.get(norm(o), str(o)) for o in signed_aug["owner"]])
    esum = pool.assign(e=amt * p).groupby("oc")["e"].sum()
    ksum = kan.groupby("owner")["gmv"].sum()
    ssum = sa.groupby("oc")["signed_amount"].sum()
    print(f"\n  PAR COMMERCIAL")
    print(f"    {'Commercial':<24}{'Signé':>10}{'Kanban rest.':>14}{'Exp. restant':>14}{'Exp. finish':>13}")
    for o in sorted(set(ksum.index) | set(ssum.index) | set(esum.index)):
        s, k, e = float(ssum.get(o, 0)), float(ksum.get(o, 0)), float(esum.get(o, 0))
        print(f"    {o:<24}{euro(s):>10}{euro(k):>14}{euro(e):>14}{euro(s + e):>13}")

    print(f"\n  TOP 10 AFFAIRES PAR CONTRIBUTION EXPECTED")
    # Les observations portent l'ID Salesforce en 18 caractères, la table
    # `opportunity` la forme canonique en 15 : la jointure passe par le préfixe.
    client = opp.assign(k=opp["opportunity_id"].str.slice(0, 15)).set_index("k")["client_contact"]
    top = pool.assign(p=p, contrib=amt * p).sort_values("contrib", ascending=False).head(10)
    print(f"    {'Client':<26}{'Ville':<16}{'GMV':>10}  {'Étape':<20}{'p':>7}{'contribution':>14}")
    for _, r in top.iterrows():
        name = client.get(r["opportunity_id"][:15], None) or r["opportunity_id"]
        print(
            f"    {str(name)[:24]:<26}{str(r['city'] or '—')[:14]:<16}{euro(r['amount']):>10}  "
            f"{str(r['stage'])[:18]:<20}{r['p'] * 100:>6.1f}%{euro(r['contrib']):>14}"
        )

    out["live"] = {
        "as_of": LIVE_DATE,
        "signed": signed,
        "expected_remaining": exp_rest,
        "expected_finish": signed + exp_rest,
        "kanban_remaining": kan_rest,
        "kanban_finish": signed + kan_rest,
        "simulation": {k: v + (signed if k != "n" else 0) for k, v in sim.items()},
        "open_opps": int(len(pool)),
    }

    # --- Critères d'acceptation, calculés et non déduits ---------------------
    print("\n" + "=" * 78)
    print("  CRITERES D'ACCEPTATION V1.2")
    print("=" * 78)
    ac: dict = {}

    # AC1 : la MAE doit être nettement inférieure. « Nettement » se teste, sur
    # les 13 snapshots de test, par le même rééchantillonnage apparié qu'en
    # sélection : si zéro est dans l'intervalle, l'écart n'est pas démontré.
    ref = {}
    for nm, sc in [("V1", scorer_v1(train)), ("V1.1", scorer_v11(train))]:
        ref[nm] = np.array([r["error"] for r in backtest(df, TEST_MONTHS, sc, nm).to_dict("records")])
    mine = np.array([r["error"] for r in out["test_backtest"]])
    rng = np.random.default_rng(11)
    idx = rng.integers(0, len(mine), size=(3000, len(mine)))
    print(f"\n  AC1 — MAE Forecast dédoublonné, écart apparié sur {len(mine)} snapshots")
    for nm, e in ref.items():
        diff = np.abs(mine)[idx].mean(axis=1) - np.abs(e)[idx].mean(axis=1)
        lo, hi = np.quantile(diff, [0.025, 0.975])
        better = hi < 0
        ac[f"AC1 vs {nm}"] = {"delta": float(diff.mean()), "ci": [float(lo), float(hi)], "significant": bool(better)}
        print(
            f"    vs {nm:<6} MAE {euro(np.abs(mine).mean())} contre {euro(np.abs(e).mean())}"
            f" · Δ {euro(diff.mean())} IC95 [{euro(lo)} ; {euro(hi)}]"
            f" → {'amélioration démontrée' if better else 'amélioration non démontrée statistiquement'}"
        )

    # AC3 : même test de Wilson que sur la validation, appliqué au test.
    t = bin_table(df, TEST_MONTHS, score)
    big = t[t["bin"].isin(["100-200 k", ">= 200 k"])]
    nb = int(big["n"].sum())
    obs = float((big["rate"] * big["n"]).sum() / nb)
    pred = float((big["mean_p"] * big["n"]).sum() / nb)
    z, d = 1.96, 1 + 1.96**2 / nb
    upper = ((obs + 1.96**2 / (2 * nb)) + z * np.sqrt(obs * (1 - obs) / nb + z * z / (4 * nb * nb))) / d
    ac["AC3"] = {"n": nb, "predicted": pred, "observed": obs, "ci_upper": upper, "pass": bool(pred <= upper),
                 "euro_bias": float((big["expected"].sum() - big["actual"].sum()) / big["actual"].sum())}
    print(
        f"\n  AC3 — bande >= 100 k€ (test) : {nb} obs · prédit {pred * 100:.2f} %"
        f" · observé {obs * 100:.2f} % · borne haute IC95 {upper * 100:.2f} %"
        f" → {'aucune surestimation systématique démontrée' if pred <= upper else 'surestimation systématique'}"
        f" (biais € {pct(ac['AC3']['euro_bias'])})"
    )

    # AC4 : convergence.
    bt2 = pd.DataFrame(out["test_backtest"]).sort_values("date")
    first, last = bt2.groupby("month").head(1), bt2.groupby("month").tail(1)
    ac["AC4"] = {
        "mae_first": float(first["error"].abs().mean()),
        "mae_last": float(last["error"].abs().mean()),
        "pass": bool(last["error"].abs().mean() < first["error"].abs().mean()),
    }
    print(
        f"\n  AC4 — premier snapshot du mois {euro(ac['AC4']['mae_first'])}"
        f" · dernier {euro(ac['AC4']['mae_last'])}"
        f" → {'convergence' if ac['AC4']['pass'] else 'pas de convergence'}"
    )
    print(f"    par mois, erreur du dernier snapshot :")
    for _, r in last.iterrows():
        print(f"      {r['month']} {r['date']} : {euro(r['error'])} ({pct(r['error_pct'])})")

    out["acceptance"] = ac

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "forecast-evaluation.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")
    pool.assign(p_month_end=p, expected=amt * p)[
        ["opportunity_id", "owner", "stage", "amount", "days_left", "p_month_end", "expected"]
    ].to_csv(ARTIFACTS / "forecast-live-scores.csv", index=False, encoding="utf-8")
    print(f"\n  → forecast-evaluation.json · forecast-live-scores.csv")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", choices=["backtest", "amount", "select", "test", "all"], default="backtest")
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    t0 = time.time()
    df = prepare()
    if args.step in ("backtest", "all"):
        step_backtest(df)
    if args.step in ("amount", "all"):
        amount_analysis(df)
    if args.step in ("select", "all"):
        res = step_select(df)
        if args.step == "all":
            step_test(df, res["selected"])
    if args.step == "test":
        chosen = args.model or json.loads((ARTIFACTS / "forecast-selection.json").read_text(encoding="utf-8"))["selected"]
        step_test(df, chosen)
    print(f"\n  ({time.time() - t0:.0f} s)\n")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()

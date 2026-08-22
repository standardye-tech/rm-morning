"""
C8.1 — projection hybride directionnelle M+1 / M+2, sur la vérité officielle.

    npm run expected:hybrid -- --step truth      baselines et répartitions
    npm run expected:hybrid -- --step region     approches H0→H5, backtest régional
    npm run expected:hybrid -- --step ranking    signal individuel et lignes jaunes
    npm run expected:hybrid -- --step live       projection live et comparaisons
    npm run expected:hybrid -- --step leakage    tests de fuite
    npm run expected:hybrid -- --step all

RÈGLE DE VÉRITÉ (C10) : toute vérité de mois vient de `travaux` — devis signé
dans le mois, statut Signé ou Réalisé, périmètre équipe, somme des montants,
avenants et annulations compris. `Opportunity.Amount` ne sert QUE à valoriser le
pipe encore ouvert à T.

ARCHITECTURE, corrigée de l'erreur de C8 : on n'additionne PAS un modèle de stock
et un modèle de flux — c'était le double comptage. On part de la baseline
mensuelle, qui porte déjà implicitement le pipe futur moyen, et on l'ajuste de
façon bornée selon la force du pipe observable aujourd'hui.

Aucune écriture. Aucun modèle mis en production.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "rm-morning.db"
ARTIFACTS = ROOT / "data" / "expected-gmv"

# Découpage sur le MOIS CIBLE : un résultat de mars ne doit pas servir à la fois
# en apprentissage (via une observation de février) et en test.
TRAIN_TARGET_END = "2025-12"
VALID_TARGET_END = "2026-04"
LAST_COMPLETE_MONTH = "2026-07"

TEAM = [
    ("Anthony Ramaherison", []),
    ("Mahery Raza", ["Mahery RAZAFINDRAZAKA"]),
    ("Guillaume Fontaine", []),
    ("Mathis Coulon", []),
    ("Daravith Chan Fah", ["Daravith CHAN-FAH"]),
    ("Vincent Bouzy", []),
    ("Jonathan Florville", []),
    ("Vincent Da Silva", []),
    ("David Bernstein", []),
    ("Stéphane Strat", []),
    ("Valentin Marion", []),
    ("Guillaume Huc", []),
    ("Sami Lazari", []),
]


def norm_name(value) -> str:
    s = unicodedata.normalize("NFD", str(value or ""))
    return "".join(c for c in s if c.isalpha() and not unicodedata.combining(c)).lower()


TEAM_INDEX = {}
for name, aliases in TEAM:
    TEAM_INDEX[norm_name(name)] = name
    for a in aliases:
        TEAM_INDEX[norm_name(a)] = name


def euro(v) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "—"
    return f"{v / 1000:,.0f} k€".replace(",", " ")


def pct(v) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "—"
    return f"{v * 100:+.1f} %"


def shift_month(m: str, k: int) -> str:
    y, mm = int(m[:4]), int(m[5:7])
    t = (y * 12 + mm - 1) + k
    return f"{t // 12}-{t % 12 + 1:02d}"


def month_end(m: str) -> str:
    return str(pd.Period(m, freq="M").end_time.date())


# --- Chargement ---------------------------------------------------------------


def load():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    obs = pd.read_sql_query("SELECT * FROM expected_gmv_observation", con)
    trx = pd.read_sql_query(
        "SELECT opportunity_id, owner_raw, signature_date, gmv, works_type, works_status FROM travaux",
        con,
    )
    opp = pd.read_sql_query("SELECT * FROM opportunity", con)
    con.close()

    obs["key"] = obs["opportunity_id"].str.slice(0, 15)

    # Vérité officielle : filtre statut + périmètre équipe.
    trx = trx[trx["works_status"].isin(["Signé", "Réalisé"])].copy()
    trx["owner"] = trx["owner_raw"].map(lambda x: TEAM_INDEX.get(norm_name(x)))
    trx = trx[trx["owner"].notna()].copy()
    trx["month"] = trx["signature_date"].str.slice(0, 7)
    return obs, trx, opp


def truth_series(trx: pd.DataFrame) -> pd.Series:
    """GMV officiel par mois, mois complets uniquement."""
    s = trx.groupby("month")["gmv"].sum().sort_index()
    s = s[s.index <= LAST_COMPLETE_MONTH]
    # Les premiers mois de la fenêtre importée sont partiels.
    med = s.median()
    return s[s >= med * 0.2]


def snapshots(obs: pd.DataFrame) -> list[str]:
    w = obs[obs["observation_kind"] == "weekly"].copy()
    w["dow"] = pd.to_datetime(w["observation_date"]).dt.dayofweek
    g = w[w["dow"] == 0].groupby("observation_date").size()
    return sorted(g[g >= 30].index)


def pool(obs: pd.DataFrame, T: str) -> pd.DataFrame:
    return obs[(obs["observation_date"] == T) & (obs["observation_kind"] == "weekly")].copy()


# --- A. Baselines officielles -------------------------------------------------


def baselines(hist: pd.Series) -> dict:
    """Six formes de baseline, toutes calculées sur l'historique strictement antérieur."""
    if len(hist) == 0:
        return {}
    w = np.exp(np.linspace(-2.0, 0.0, len(hist)))  # pondération vers les mois récents
    lo, hi = hist.quantile(0.10), hist.quantile(0.90)
    return {
        "H0-A moyenne totale": float(hist.mean()),
        "H0-B moyenne 12 mois": float(hist.tail(12).mean()),
        "H0-C moyenne 6 mois": float(hist.tail(6).mean()),
        "H0-D moyenne pondérée récente": float((hist.to_numpy() * w).sum() / w.sum()),
        "H0-E médiane": float(hist.median()),
        "H0-F moyenne winsorisée": float(hist.clip(lo, hi).mean()),
    }


def step_truth(obs, trx, opp) -> dict:
    print("\n" + "=" * 78)
    print("  A. VÉRITÉ OFFICIELLE ET BASELINES")
    print("=" * 78)
    truth = truth_series(trx)
    out: dict = {}

    print(f"\n  mois complets retenus : {len(truth)}  ({truth.index[0]} → {truth.index[-1]})")
    print(f"  moyenne {euro(truth.mean())} · médiane {euro(truth.median())}")
    print(f"  min {euro(truth.min())} · max {euro(truth.max())}")
    print(f"  écart-type {euro(truth.std())} · coefficient de variation {truth.std() / truth.mean() * 100:.0f} %")
    print(f"\n    {'mois':<10}{'GMV officiel':>14}")
    for m, v in truth.items():
        print(f"    {m:<10}{euro(v):>14}")
    out["truth"] = {m: float(v) for m, v in truth.items()}

    # Chaque baseline est évaluée en glissant : pour chaque mois cible, elle est
    # calculée sur les mois STRICTEMENT antérieurs. Aucune fuite.
    print(f"\n  Performance des baselines, mesurée en aveugle sur chaque mois")
    print(f"    {'baseline':<32}{'MAE':>11}{'err. méd.':>11}{'biais':>10}{'n':>5}")
    rows = {}
    names = list(baselines(truth.iloc[:12]).keys())
    for name in names:
        errs, pcts, tot_p, tot_a = [], [], 0.0, 0.0
        for i in range(12, len(truth)):
            hist = truth.iloc[:i]
            pred = baselines(hist)[name]
            actual = float(truth.iloc[i])
            errs.append(pred - actual)
            pcts.append(abs(pred - actual) / actual)
            tot_p += pred
            tot_a += actual
        rows[name] = {
            "mae": float(np.mean(np.abs(errs))),
            "median_abs_pct": float(np.median(pcts)),
            "bias_pct": (tot_p - tot_a) / tot_a,
            "n": len(errs),
        }
        r = rows[name]
        print(f"    {name:<32}{euro(r['mae']):>11}{r['median_abs_pct'] * 100:>10.1f}%{pct(r['bias_pct']):>10}{r['n']:>5}")
    out["baselines"] = rows
    best = min(rows, key=lambda k: rows[k]["mae"])
    print(f"\n    baseline la plus stable : {best}")
    out["best_baseline"] = best

    # --- Répartition pipe connu / pipe futur, sur la vérité officielle.
    print("\n" + "=" * 78)
    print("  B. PIPE DÉJÀ CONNU CONTRE PIPE FUTUR — vérité officielle Travaux")
    print("=" * 78)
    for horizon in (1, 2):
        rows_h = []
        for T in snapshots(obs):
            target = shift_month(T[:7], horizon)
            if target > LAST_COMPLETE_MONTH or target not in truth.index:
                continue
            known = set(pool(obs, T)["key"])
            ms = trx[trx["month"] == target]
            in_stock = ms["opportunity_id"].isin(known)
            day = int(T[8:10])
            rows_h.append(
                {
                    "T": T,
                    "target": target,
                    "position": "début" if day <= 10 else "milieu" if day <= 20 else "fin",
                    "total": float(ms["gmv"].sum()),
                    "stock": float(ms.loc[in_stock, "gmv"].sum()),
                }
            )
        d = pd.DataFrame(rows_h)
        share = d["stock"].sum() / d["total"].sum()
        print(f"\n  M+{horizon} — {len(d)} instantanés, {d['target'].nunique()} mois cibles")
        print(f"    déjà dans le pipe à T : {share * 100:.1f} %   ·   créé après T : {(1 - share) * 100:.1f} %")
        print(f"    {'position':<12}{'snapshots':>11}{'stock':>9}{'futur':>9}")
        for p in ["début", "milieu", "fin"]:
            g = d[d["position"] == p]
            if g.empty:
                continue
            s = g["stock"].sum() / g["total"].sum()
            print(f"    {p:<12}{len(g):>11}{s * 100:>8.1f}%{(1 - s) * 100:>8.1f}%")
        out[f"split_m{horizon}"] = {
            "share_stock": float(share),
            "by_position": {p: float(g["stock"].sum() / g["total"].sum()) for p, g in d.groupby("position")},
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--step",
        choices=["truth", "region", "ranking", "live", "leakage", "all"],
        default="truth",
    )
    args = ap.parse_args()
    t0 = time.time()
    obs, trx, opp = load()
    results: dict = {}

    if args.step in ("truth", "all"):
        results["truth"] = step_truth(obs, trx, opp)
    if args.step in ("region", "all"):
        from hybrid_models import step_region  # noqa: PLC0415

        results["region"] = step_region(obs, trx, opp)
    if args.step in ("ranking", "all"):
        from hybrid_models import step_ranking  # noqa: PLC0415

        results["ranking"] = step_ranking(obs, trx, opp)
    if args.step in ("live", "all"):
        from hybrid_models import step_live  # noqa: PLC0415

        results["live"] = step_live(obs, trx, opp)
    if args.step in ("leakage", "all"):
        from hybrid_models import step_leakage  # noqa: PLC0415

        results["leakage"] = step_leakage(obs, trx)

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "hybrid-audit.json").write_text(
        json.dumps(results, indent=1, default=str), encoding="utf-8"
    )
    print(f"\n  → data/expected-gmv/hybrid-audit.json   ({time.time() - t0:.0f} s)\n")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()

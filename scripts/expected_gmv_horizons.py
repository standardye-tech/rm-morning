"""
C8 — audit et conception d'Expected GMV pour M+1 et M+2.

    npm run expected:horizons -- --step audit     A à C : profondeur, features,
                                                  décomposition stock / pipe futur
    npm run expected:horizons -- --step models    D à G : baselines, modèles,
                                                  backtests, saisonnalité
    npm run expected:horizons -- --step leakage   H : tests de fuite
    npm run expected:horizons -- --step all

AUCUN MODÈLE N'EST MIS EN PRODUCTION ICI. Ce fichier mesure ce qui est
prédictible et écrit un rapport ; il ne touche ni l'application, ni les modèles
M déjà figés.

Le problème de M+1 et M+2 n'est pas celui de M. Une partie du GMV signé dans ces
mois viendra d'affaires qui n'existent pas encore à la date d'observation. On
mesure donc deux composantes séparément :

  A. STOCK — les affaires déjà ouvertes à T qui signeront pendant le mois cible ;
  B. PIPE FUTUR — les affaires créées après T, puis signées pendant ce mois.

Les additionner sans les avoir mesurées séparément serait la même faute que le
double comptage de V1.1.

Lecture seule SQLite. Aucune écriture Salesforce ni Google.
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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "rm-morning.db"
CACHE = ROOT / "data" / "dataset-cache" / "opportunities.json"
ARTIFACTS = ROOT / "data" / "expected-gmv"

# Découpage temporel, identique en esprit à C5 : jamais de tirage aléatoire.
TRAIN_END = "2025-12-31"
VALID_END = "2026-04-30"

# Août 2026 est le mois courant : son propre résultat n'est pas connu, et donc
# aucun mois cible postérieur à juillet ne peut servir de vérité.
LAST_COMPLETE_MONTH = "2026-07"


def euro(v: float) -> str:
    return f"{v / 1000:,.0f} k€".replace(",", " ")


def pct(v: float) -> str:
    return f"{v * 100:+.1f} %"


def month_of(day: str) -> str:
    return day[:7]


def shift_month(m: str, k: int) -> str:
    y, mm = int(m[:4]), int(m[5:7])
    t = (y * 12 + mm - 1) + k
    return f"{t // 12}-{t % 12 + 1:02d}"


def month_bounds(m: str) -> tuple[str, str]:
    p = pd.Period(m, freq="M")
    return f"{m}-01", str(p.end_time.date())


# --- Chargement ---------------------------------------------------------------


def load() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Observations, et table des signatures avec date de création.

    La date de création vient de l'extraction Salesforce du dataset : c'est la
    seule information qui permette de dire si une affaire existait à T, donc de
    séparer le stock du pipe futur.
    """
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    obs = pd.read_sql_query("SELECT * FROM expected_gmv_observation", con)
    con.close()

    created = {}
    if CACHE.exists():
        for o in json.loads(CACHE.read_text(encoding="utf-8")):
            created[o["Id"][:15]] = (o.get("CreatedDate") or "")[:10]
    obs["key"] = obs["opportunity_id"].str.slice(0, 15)
    obs["created_day"] = obs["key"].map(created)

    # Repli : la date de création se déduit de l'âge à la première observation.
    missing = obs["created_day"].isna()
    if missing.any():
        first = obs.sort_values("observation_date").groupby("key", as_index=False).head(1)
        derived = {
            r["key"]: (pd.Timestamp(r["observation_date"]) - pd.Timedelta(days=float(r["age_days"] or 0)))
            .strftime("%Y-%m-%d")
            for _, r in first.iterrows()
        }
        obs.loc[missing, "created_day"] = obs.loc[missing, "key"].map(derived)

    sig = obs[obs["actual_signature_at"].notna()].copy()
    sig = sig.sort_values("observation_date").groupby("key", as_index=False).tail(1)
    sig["sig_day"] = sig["actual_signature_at"].str.slice(0, 10)
    sig = sig[["key", "owner", "stage", "amount", "sig_day", "created_day", "acquisition_channel", "postal_code"]]
    sig = sig.rename(columns={"amount": "signed_amount"})
    return obs, sig


def snapshots(obs: pd.DataFrame) -> list[str]:
    """Les lundis hebdomadaires exploitables, comme en V1.2."""
    w = obs[obs["observation_kind"] == "weekly"].copy()
    w["dow"] = pd.to_datetime(w["observation_date"]).dt.dayofweek
    g = w[w["dow"] == 0].groupby("observation_date").size()
    return sorted(g[g >= 30].index)


def pool(obs: pd.DataFrame, T: str) -> pd.DataFrame:
    """Le pipe ouvert à T, une ligne par opportunité (dédoublonnage structurel)."""
    return obs[(obs["observation_date"] == T) & (obs["observation_kind"] == "weekly")].copy()


# --- A. Profondeur et couverture ---------------------------------------------


def step_audit(obs: pd.DataFrame, sig: pd.DataFrame) -> dict:
    print("\n" + "=" * 78)
    print("  A. PROFONDEUR HISTORIQUE ET COUVERTURE")
    print("=" * 78)
    snaps = snapshots(obs)
    out: dict = {}

    print(f"\n  observations              : {len(obs):,}".replace(",", " "))
    print(f"  opportunités distinctes   : {obs['key'].nunique()}")
    print(f"  fenêtre d'observation     : {obs['observation_date'].min()} → {obs['observation_date'].max()}")
    print(f"  instantanés hebdomadaires : {len(snaps)}  ({snaps[0]} → {snaps[-1]})")
    print(f"  signatures datées         : {len(sig)}")
    print(f"  dernier mois cible connu  : {LAST_COMPLETE_MONTH}")

    # Mois cibles utilisables : il faut que le mois soit terminé.
    usable_m1 = [T for T in snaps if shift_month(month_of(T), 1) <= LAST_COMPLETE_MONTH]
    usable_m2 = [T for T in snaps if shift_month(month_of(T), 2) <= LAST_COMPLETE_MONTH]
    print(f"\n  instantanés exploitables pour M+1 : {len(usable_m1)}  (jusqu'au {usable_m1[-1] if usable_m1 else '—'})")
    print(f"  instantanés exploitables pour M+2 : {len(usable_m2)}  (jusqu'au {usable_m2[-1] if usable_m2 else '—'})")

    months = sorted({month_of(d) for d in sig["sig_day"]})
    months = [m for m in months if m <= LAST_COMPLETE_MONTH]
    print(f"\n  mois de signature complets : {len(months)}  ({months[0]} → {months[-1]})")
    print(f"    {'mois':<10}{'signatures':>12}{'GMV':>12}")
    for m in months:
        g = sig[sig["sig_day"].str.slice(0, 7) == m]
        print(f"    {m:<10}{len(g):>12}{euro(g['signed_amount'].sum()):>12}")
    out["months"] = months
    out["usable_m1"] = len(usable_m1)
    out["usable_m2"] = len(usable_m2)

    print(f"\n  COUVERTURE DES FEATURES (sur toutes les observations)")
    print(f"    {'feature':<28}{'renseignée':>12}{'taux':>9}{'modalités':>11}")
    for col in [
        "stage",
        "amount",
        "age_days",
        "days_in_stage",
        "stage_changes",
        "owner",
        "acquisition_channel",
        "lead_source",
        "service",
        "postal_code",
        "kanban_month",
        "estimation_sent_at",
        "devis_sent_at",
    ]:
        n = obs[col].notna().sum()
        card = obs[col].nunique(dropna=True)
        print(f"    {col:<28}{n:>12}{n / len(obs) * 100:>8.1f}%{card:>11}")

    print(f"\n  Les colonnes Kanban sont vides par construction (aucun historique de")
    print(f"  Projection Kanban n'existe au-delà de quelques semaines). Elles ne")
    print(f"  peuvent donc pas devenir des features de M+1/M+2 en V1.")
    return out


# --- B. Décomposition stock / pipe futur -------------------------------------


def decompose(obs: pd.DataFrame, sig: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Pour chaque instantané, part du GMV du mois cible déjà présente à T.

    C'est la mesure qui décide de l'architecture : si le pipe futur pèse peu, un
    modèle de stock suffit ; s'il pèse lourd, il faut le modéliser explicitement.
    """
    rows = []
    for T in snapshots(obs):
        target = shift_month(month_of(T), horizon)
        if target > LAST_COMPLETE_MONTH:
            continue
        lo, hi = month_bounds(target)
        # Pour M, on ne compte que ce qui RESTE à signer à T : les signatures
        # déjà faites appartiennent au réalisé, pas à une prévision. Pour M+1 et
        # M+2 le mois cible est entièrement postérieur à T, la borne est inerte.
        low = max(lo, T) if horizon == 0 else lo
        month_sig = sig[(sig["sig_day"] >= low) & (sig["sig_day"] <= hi)]
        if month_sig.empty:
            continue
        # Le pipe ouvert à T fixe ce qui est « déjà connu ». Une affaire créée
        # avant T mais absente de l'instantané est déjà terminale : elle ne
        # compte pas comme stock.
        known = set(pool(obs, T)["key"])
        in_stock = month_sig["key"].isin(known)
        day = int(T[8:10])
        rows.append(
            {
                "T": T,
                "target": target,
                "position": "début" if day <= 10 else "milieu" if day <= 20 else "fin",
                "total": float(month_sig["signed_amount"].sum()),
                "stock": float(month_sig.loc[in_stock, "signed_amount"].sum()),
                "future": float(month_sig.loc[~in_stock, "signed_amount"].sum()),
                "n_total": int(len(month_sig)),
                "n_stock": int(in_stock.sum()),
            }
        )
    d = pd.DataFrame(rows)
    if not d.empty:
        d["share_stock"] = d["stock"] / d["total"]
    return d


def step_decomposition(obs: pd.DataFrame, sig: pd.DataFrame) -> dict:
    print("\n" + "=" * 78)
    print("  B. STOCK DÉJÀ CONNU CONTRE PIPE FUTUR")
    print("=" * 78)
    out: dict = {}
    for horizon, label in [(0, "M (référence)"), (1, "M+1"), (2, "M+2")]:
        d = decompose(obs, sig, horizon)
        if d.empty:
            print(f"\n  {label} : aucune donnée exploitable")
            continue
        share = d["stock"].sum() / d["total"].sum()
        print(f"\n  {label} — {len(d)} instantanés, {d['target'].nunique()} mois cibles")
        print(f"    déjà dans le pipe à T : {share * 100:.1f} %")
        print(f"    créé après T          : {(1 - share) * 100:.1f} %")
        print(f"    {'position dans M':<18}{'snapshots':>11}{'stock':>9}{'pipe futur':>12}")
        for pos in ["début", "milieu", "fin"]:
            g = d[d["position"] == pos]
            if g.empty:
                continue
            s = g["stock"].sum() / g["total"].sum()
            print(f"    {pos:<18}{len(g):>11}{s * 100:>8.1f}%{(1 - s) * 100:>11.1f}%")
        out[f"h{horizon}"] = {
            "share_stock": share,
            "snapshots": int(len(d)),
            "by_position": {
                pos: float(g["stock"].sum() / g["total"].sum())
                for pos, g in d.groupby("position")
                if len(g) > 0
            },
        }
    return out


# --- C. Cibles ----------------------------------------------------------------


def add_targets(obs: pd.DataFrame, sig: pd.DataFrame) -> pd.DataFrame:
    """Cibles calendaires M, M+1, M+2, calculées depuis la vraie signature.

    Aucune fenêtre glissante en jours : l'usage produit est calendaire, et
    « signé sous 60 jours » ne répond pas à « combien en octobre ».
    """
    sig_day = obs["key"].map(sig.set_index("key")["sig_day"])
    obs = obs.assign(sig_day=sig_day)
    m = obs["observation_date"].str.slice(0, 7)
    for k in (0, 1, 2):
        target = m.map(lambda x, k=k: shift_month(x, k))
        lo = target + "-01"
        hi = target.map(lambda t: month_bounds(t)[1])
        # Borne basse stricte pour M : on ne compte que ce qui reste à signer.
        low = obs["observation_date"] if k == 0 else lo
        obs[f"target_m{k}"] = ((sig_day >= low) & (sig_day <= hi)).fillna(False).astype(int)
        obs[f"target_month_m{k}"] = target
    return obs


def step_targets(obs: pd.DataFrame) -> dict:
    print("\n" + "=" * 78)
    print("  C. CIBLES CALENDAIRES")
    print("=" * 78)
    out: dict = {}
    print(f"\n    {'cible':<12}{'positifs':>10}{'taux':>9}{'GMV positif':>14}")
    for k in (0, 1, 2):
        col = f"target_m{k}"
        p = int(obs[col].sum())
        gmv = float(obs.loc[obs[col] == 1, "amount"].sum())
        print(f"    {'M+' + str(k) if k else 'M':<12}{p:>10}{obs[col].mean() * 100:>8.2f}%{euro(gmv):>14}")
        out[col] = {"positives": p, "rate": float(obs[col].mean())}

    print(f"\n  Taux par étape (part des affaires ouvertes qui signent sur l'horizon)")
    print(f"    {'étape':<24}{'obs':>8}{'M':>9}{'M+1':>9}{'M+2':>9}")
    for st, g in obs.groupby("stage"):
        if len(g) < 200:
            continue
        print(
            f"    {str(st)[:22]:<24}{len(g):>8}"
            f"{g['target_m0'].mean() * 100:>8.2f}%{g['target_m1'].mean() * 100:>8.2f}%{g['target_m2'].mean() * 100:>8.2f}%"
        )

    print(f"\n  Délai création → signature (affaires signées)")
    s = obs[obs["sig_day"].notna()].sort_values("observation_date").groupby("key").tail(1)
    delay = (pd.to_datetime(s["sig_day"]) - pd.to_datetime(s["created_day"])).dt.days
    print(f"    médiane {delay.median():.0f} j · moyenne {delay.mean():.0f} j")
    for q in (0.1, 0.25, 0.5, 0.75, 0.9):
        print(f"      {int(q * 100)}e centile : {delay.quantile(q):.0f} j")
    out["delay_median_days"] = float(delay.median())
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", choices=["audit", "models", "leakage", "all"], default="audit")
    args = ap.parse_args()
    t0 = time.time()

    obs, sig = load()
    obs = add_targets(obs, sig)

    results: dict = {}
    if args.step in ("audit", "all"):
        results["audit"] = step_audit(obs, sig)
        results["decomposition"] = step_decomposition(obs, sig)
        results["targets"] = step_targets(obs)

    if args.step in ("models", "all"):
        from horizons_models import step_diagnostics, step_models  # noqa: PLC0415

        results["models"] = step_models(obs, sig)
        results["diagnostics"] = step_diagnostics(obs, sig)

    if args.step in ("leakage", "all"):
        from horizons_models import step_leakage  # noqa: PLC0415

        results["leakage"] = step_leakage(obs, sig)

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "horizons-audit.json").write_text(
        json.dumps(results, indent=1, default=str), encoding="utf-8"
    )
    print(f"\n  → data/expected-gmv/horizons-audit.json   ({time.time() - t0:.0f} s)\n")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()

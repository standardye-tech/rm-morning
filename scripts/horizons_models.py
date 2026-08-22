"""
C8 — modèles candidats pour M+1 et M+2, et leur backtest.

Deux modèles distincts, jamais confondus :

  STOCK       : pour chaque affaire ouverte à T, probabilité qu'elle signe
                pendant le mois cible. Somme des GMV × probabilité.
  PIPE FUTUR  : GMV attendu d'affaires qui n'existent pas encore à T. Ce n'est
                pas une probabilité par affaire — il n'y a pas d'affaire — mais
                une estimation de flux.

Le découpage temporel porte sur le MOIS CIBLE et non sur la date d'observation :
c'est le seul moyen d'éviter qu'un résultat de mars serve à la fois en
apprentissage (via une observation de février) et en test.

Rien n'est mis en production ici.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from expected_gmv_horizons import (
    LAST_COMPLETE_MONTH,
    euro,
    month_bounds,
    pct,
    pool,
    shift_month,
    snapshots,
)

TRAIN_TARGET_END = "2025-12"
VALID_TARGET_END = "2026-04"

AMOUNT_BINS = [0.0, 25_000.0, 50_000.0, 100_000.0, 200_000.0, np.inf]
AMOUNT_LABELS = ["< 25 k", "25-50 k", "50-100 k", "100-200 k", ">= 200 k"]

NUM = ["amount", "log_amount", "age_days", "days_in_stage", "stage_changes", "day_of_month"]
CAT = ["stage_str", "amount_bin"]
CAT_RICH = CAT + ["acquisition_channel", "service", "department"]

# Lissage bayésien des taux par commercial : un commercial à 5 affaires ne doit
# pas hériter d'un taux brut de 40 %. `PRIOR_WEIGHT` est le nombre d'observations
# équivalentes de l'a priori d'équipe.
PRIOR_WEIGHT = 300


def prepare(obs: pd.DataFrame) -> pd.DataFrame:
    d = obs.copy()
    a = d["amount"].astype(float)
    d["log_amount"] = np.log1p(a.fillna(a.median()))
    d["amount_bin"] = pd.cut(a, AMOUNT_BINS, labels=AMOUNT_LABELS, right=False).astype(str)
    d["stage_str"] = d["stage"].fillna("(sans etape)").astype(str)
    d["department"] = d["postal_code"].astype(str).str.extract(r"^(\d{2})")[0].fillna("inconnu")
    d["target_month_of_obs"] = d["observation_date"].str.slice(0, 7)
    return d


def split_by_target(d: pd.DataFrame, horizon: int) -> dict[str, pd.DataFrame]:
    """Découpage sur le mois cible, pas sur la date d'observation."""
    tm = d[f"target_month_m{horizon}"]
    usable = tm <= LAST_COMPLETE_MONTH
    return {
        "train": d[usable & (tm <= TRAIN_TARGET_END)],
        "valid": d[usable & (tm > TRAIN_TARGET_END) & (tm <= VALID_TARGET_END)],
        "test": d[usable & (tm > VALID_TARGET_END)],
    }


# --- Modèles de stock ---------------------------------------------------------


def shrunk_rate(train: pd.DataFrame, keys: list[str], label: str) -> dict:
    """Taux par groupe, ramenés vers la moyenne d'équipe selon l'effectif."""
    base = float(train[label].mean())
    g = train.groupby(keys)[label].agg(["sum", "count"])
    rate = (g["sum"] + PRIOR_WEIGHT * base) / (g["count"] + PRIOR_WEIGHT)
    return {"base": base, "rate": rate}


def apply_rate(model: dict, d: pd.DataFrame, keys: list[str]) -> np.ndarray:
    idx = pd.MultiIndex.from_frame(d[keys]) if len(keys) > 1 else pd.Index(d[keys[0]])
    return np.asarray(idx.map(model["rate"]).to_series().fillna(model["base"]), dtype=float)


def make_pipeline(kind: str, num: list[str], cat: list[str]):
    if kind == "logistic":
        pre = ColumnTransformer(
            [
                ("num", Pipeline([("i", SimpleImputer(strategy="median", add_indicator=True)), ("s", StandardScaler())]), num),
                ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=30, sparse_output=False), cat),
            ]
        )
        return Pipeline([("pre", pre), ("model", LogisticRegression(max_iter=2000))])
    pre = ColumnTransformer(
        [
            ("num", "passthrough", num),
            ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=30, sparse_output=False), cat),
        ]
    )
    return Pipeline(
        [
            ("pre", pre),
            (
                "model",
                HistGradientBoostingClassifier(
                    max_iter=300, learning_rate=0.05, max_leaf_nodes=15,
                    min_samples_leaf=40, l2_regularization=1.0, random_state=42,
                ),
            ),
        ]
    )


def stock_models(parts: dict[str, pd.DataFrame], horizon: int) -> dict:
    """Construit les candidats de stock et renvoie leurs fonctions de score."""
    label = f"target_m{horizon}"
    train = parts["train"]
    out: dict = {}

    r1 = shrunk_rate(train, ["stage_str"], label)
    out["B1 taux par étape"] = lambda d, m=r1: apply_rate(m, d, ["stage_str"])

    r2 = shrunk_rate(train, ["stage_str", "amount_bin"], label)
    out["B2 étape × tranche GMV"] = lambda d, m=r2: apply_rate(m, d, ["stage_str", "amount_bin"])

    r3 = shrunk_rate(train, ["stage_str", "owner"], label)
    out["B3 étape × commercial (lissé)"] = lambda d, m=r3: apply_rate(m, d, ["stage_str", "owner"])

    p1 = make_pipeline("logistic", NUM, CAT)
    p1.fit(train[NUM + CAT], train[label])
    out["M1 logistique"] = lambda d, p=p1: p.predict_proba(d[NUM + CAT])[:, 1]

    p2 = make_pipeline("logistic", NUM, CAT_RICH)
    p2.fit(train[NUM + CAT_RICH], train[label])
    out["M2 logistique + canal/zone"] = lambda d, p=p2: p.predict_proba(d[NUM + CAT_RICH])[:, 1]

    p3 = make_pipeline("tree", NUM, CAT)
    p3.fit(train[NUM + CAT], train[label])
    out["M3 HistGB"] = lambda d, p=p3: p.predict_proba(d[NUM + CAT])[:, 1]

    p4 = make_pipeline("tree", NUM, CAT_RICH)
    p4.fit(train[NUM + CAT_RICH], train[label])
    out["M4 HistGB + canal/zone"] = lambda d, p=p4: p.predict_proba(d[NUM + CAT_RICH])[:, 1]
    return out


# --- Modèle de pipe futur -----------------------------------------------------


def future_frame(d: pd.DataFrame, sig: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Une ligne par instantané : GMV du mois cible venu d'affaires créées après T."""
    rows = []
    for T in snapshots(d):
        target = shift_month(T[:7], horizon)
        if target > LAST_COMPLETE_MONTH:
            continue
        lo, hi = month_bounds(target)
        ms = sig[(sig["sig_day"] >= lo) & (sig["sig_day"] <= hi)]
        if ms.empty:
            continue
        known = set(pool(d, T)["key"])
        is_stock = ms["key"].isin(known)
        day = int(T[8:10])
        rows.append(
            {
                "T": T,
                "target": target,
                "target_calendar_month": int(target[5:7]),
                "position": "début" if day <= 10 else "milieu" if day <= 20 else "fin",
                "day_of_month": day,
                "total": float(ms["signed_amount"].sum()),
                "stock_actual": float(ms.loc[is_stock, "signed_amount"].sum()),
                "future_actual": float(ms.loc[~is_stock, "signed_amount"].sum()),
                "open_count": int(len(pool(d, T))),
                "open_gmv": float(pool(d, T)["amount"].sum()),
            }
        )
    return pd.DataFrame(rows)


def future_models(train: pd.DataFrame) -> dict:
    """Trois baselines de flux, de la plus simple à la plus conditionnée."""
    out: dict = {}
    overall = float(train["future_actual"].mean())
    out["F1 moyenne historique"] = lambda r, v=overall: v

    by_pos = train.groupby("position")["future_actual"].mean().to_dict()
    out["F2 moyenne par position dans le mois"] = lambda r, m=by_pos, v=overall: m.get(r["position"], v)

    by_pos_month = train.groupby(["position", "target_calendar_month"])["future_actual"].mean().to_dict()
    out["F3 position × mois calendaire"] = lambda r, m=by_pos_month, p=by_pos, v=overall: m.get(
        (r["position"], r["target_calendar_month"]), p.get(r["position"], v)
    )

    # F4 : proportionnel au pipe ouvert. L'idée est qu'une région dont le pipe
    # grossit crée aussi plus d'affaires nouvelles.
    ratio = float((train["future_actual"] / train["open_gmv"].replace(0, np.nan)).median())
    out["F4 part du pipe ouvert"] = lambda r, k=ratio: float(r["open_gmv"]) * k
    return out


# --- Backtest combiné ---------------------------------------------------------


def backtest(
    d: pd.DataFrame,
    sig: pd.DataFrame,
    horizon: int,
    stock_score,
    future_score,
    months: tuple[str, str],
) -> pd.DataFrame:
    rows = []
    for T in snapshots(d):
        target = shift_month(T[:7], horizon)
        if not (months[0] < target <= months[1]):
            continue
        lo, hi = month_bounds(target)
        ms = sig[(sig["sig_day"] >= lo) & (sig["sig_day"] <= hi)]
        p = pool(d, T)
        if p.empty or ms.empty:
            continue
        prob = np.asarray(stock_score(p), dtype=float)
        amt = p["amount"].astype(float).fillna(0).to_numpy()
        stock_pred = float((amt * prob).sum())
        day = int(T[8:10])
        ctx = {
            "position": "début" if day <= 10 else "milieu" if day <= 20 else "fin",
            "target_calendar_month": int(target[5:7]),
            "open_gmv": float(p["amount"].sum()),
        }
        future_pred = float(future_score(ctx)) if future_score else 0.0
        known = set(p["key"])
        rows.append(
            {
                "T": T,
                "target": target,
                "stock_pred": stock_pred,
                "future_pred": future_pred,
                "pred": stock_pred + future_pred,
                "actual": float(ms["signed_amount"].sum()),
                "stock_actual": float(ms.loc[ms["key"].isin(known), "signed_amount"].sum()),
                "future_actual": float(ms.loc[~ms["key"].isin(known), "signed_amount"].sum()),
            }
        )
    bt = pd.DataFrame(rows)
    if bt.empty:
        return bt
    bt["error"] = bt["pred"] - bt["actual"]
    bt["error_pct"] = bt["error"] / bt["actual"].replace(0, np.nan)
    return bt


def summarize(bt: pd.DataFrame) -> dict:
    if bt.empty:
        return {}
    e = bt["error"].to_numpy()
    return {
        "snapshots": int(len(bt)),
        "mae": float(np.abs(e).mean()),
        "median_abs_pct": float(np.nanmedian(np.abs(bt["error_pct"]))),
        "bias": float(e.mean()),
        "bias_pct": float(e.sum() / bt["actual"].sum()),
    }


def step_models(obs: pd.DataFrame, sig: pd.DataFrame) -> dict:
    d = prepare(obs)
    results: dict = {}

    for horizon in (1, 2):
        label = f"M+{horizon}"
        print("\n" + "=" * 78)
        print(f"  D. MODÈLES DE STOCK — {label}")
        print("=" * 78)
        parts = split_by_target(d, horizon)
        y = f"target_m{horizon}"
        print(
            f"\n  train {len(parts['train'])} obs ({parts['train'][y].sum()} positifs) ·"
            f" validation {len(parts['valid'])} ({parts['valid'][y].sum()}) ·"
            f" test {len(parts['test'])} ({parts['test'][y].sum()})"
        )
        print(f"  découpage sur le mois cible : train ≤ {TRAIN_TARGET_END} · validation ≤ {VALID_TARGET_END}")

        models = stock_models(parts, horizon)
        fut = future_frame(d, sig, horizon)
        fut_train = fut[fut["target"] <= TRAIN_TARGET_END]
        fut_models = future_models(fut_train)

        # --- Qualité de classement sur la validation.
        print(f"\n  Qualité du modèle d'opportunité (validation)")
        print(f"    {'modèle':<32}{'PR-AUC':>9}{'Brier':>10}")
        prob_scores = {}
        for name, fn in models.items():
            v = parts["valid"]
            p = np.clip(fn(v), 0, 1)
            ap = float(average_precision_score(v[y], p)) if v[y].sum() else float("nan")
            br = float(brier_score_loss(v[y], p))
            prob_scores[name] = {"pr_auc": ap, "brier": br}
            print(f"    {name:<32}{ap:>9.4f}{br:>10.5f}")

        # --- Backtest GMV sur la validation, stock seul puis stock + flux.
        print(f"\n  Backtest GMV sur la validation — stock seul")
        print(f"    {'modèle':<32}{'MAE':>11}{'err. méd.':>11}{'biais %':>10}")
        combos: dict = {}
        for name, fn in models.items():
            bt = backtest(d, sig, horizon, fn, None, (TRAIN_TARGET_END, VALID_TARGET_END))
            s = summarize(bt)
            combos[f"{name} (stock seul)"] = s
            print(f"    {name:<32}{euro(s['mae']):>11}{s['median_abs_pct'] * 100:>10.1f}%{pct(s['bias_pct']):>10}")

        print(f"\n  Backtest GMV sur la validation — stock + pipe futur")
        best_stock = min(combos, key=lambda k: combos[k]["mae"]).replace(" (stock seul)", "")
        print(f"    (modèle de stock retenu pour la comparaison : {best_stock})")
        print(f"    {'flux':<38}{'MAE':>11}{'err. méd.':>11}{'biais %':>10}")
        for fname, ffn in fut_models.items():
            bt = backtest(d, sig, horizon, models[best_stock], ffn, (TRAIN_TARGET_END, VALID_TARGET_END))
            s = summarize(bt)
            combos[f"{best_stock} + {fname}"] = s
            print(f"    {fname:<38}{euro(s['mae']):>11}{s['median_abs_pct'] * 100:>10.1f}%{pct(s['bias_pct']):>10}")

        # --- Baseline de référence : moyenne du GMV mensuel historique.
        hist = fut_train.groupby("target")["total"].first()
        naive = float(hist.mean())
        bt_naive = backtest(d, sig, horizon, lambda p: np.zeros(len(p)), lambda r, v=naive: v,
                            (TRAIN_TARGET_END, VALID_TARGET_END))
        s_naive = summarize(bt_naive)
        combos["B0 moyenne mensuelle historique"] = s_naive
        print(f"\n  Baseline la plus simple — on prédit toujours la moyenne mensuelle ({euro(naive)})")
        print(f"    MAE {euro(s_naive['mae'])} · err. médiane {s_naive['median_abs_pct'] * 100:.1f} %"
              f" · biais {pct(s_naive['bias_pct'])}")

        results[label] = {"prob": prob_scores, "combos": combos, "best_stock": best_stock,
                          "future_share_train": float(fut_train["future_actual"].sum() / fut_train["total"].sum())}

        # --- Sélection puis test unique.
        eligible = {k: v for k, v in combos.items() if "+" in k or k.startswith("B0")}
        chosen = min(eligible, key=lambda k: eligible[k]["mae"])
        print(f"\n  Retenu pour le test : {chosen}")
        fname = chosen.split(" + ")[-1] if " + " in chosen else None
        stock_fn = models[best_stock] if fname else (lambda p: np.zeros(len(p)))
        fut_fn = fut_models[fname] if fname else (lambda r, v=naive: v)

        print("\n" + "=" * 78)
        print(f"  E. TEST — {label} · mois cibles {VALID_TARGET_END} → {LAST_COMPLETE_MONTH}")
        print("=" * 78)
        bt = backtest(d, sig, horizon, stock_fn, fut_fn, (VALID_TARGET_END, LAST_COMPLETE_MONTH))
        print(
            f"\n    {'T':<12}{'cible':<9}{'stock prév.':>12}{'flux prév.':>11}"
            f"{'total prév.':>12}{'réel':>11}{'erreur':>11}{'%':>8}"
        )
        for _, r in bt.iterrows():
            print(
                f"    {r['T']:<12}{r['target']:<9}{euro(r['stock_pred']):>12}{euro(r['future_pred']):>11}"
                f"{euro(r['pred']):>12}{euro(r['actual']):>11}{euro(r['error']):>11}"
                f"{r['error_pct'] * 100:>7.0f}%"
            )
        s = summarize(bt)
        print(f"\n    MAE {euro(s['mae'])} · erreur médiane {s['median_abs_pct'] * 100:.1f} %"
              f" · biais {euro(s['bias'])} ({pct(s['bias_pct'])})")
        results[label]["test"] = s
        results[label]["chosen"] = chosen
        results[label]["backtest"] = bt.to_dict("records")

        # --- Zone probable : distribution empirique de l'erreur relative,
        #     mesurée sur la validation et appliquée au test.
        bt_v = backtest(d, sig, horizon, stock_fn, fut_fn, (TRAIN_TARGET_END, VALID_TARGET_END))
        rel = (bt_v["actual"] / bt_v["pred"].replace(0, np.nan)).dropna()
        lo_k, hi_k = float(rel.quantile(0.10)), float(rel.quantile(0.90))
        covered = int(
            ((bt["actual"] >= bt["pred"] * lo_k) & (bt["actual"] <= bt["pred"] * hi_k)).sum()
        )
        print(f"\n    Zone probable — facteurs {lo_k:.2f}× à {hi_k:.2f}× la prévision")
        print(f"    (calibrés sur la validation, appliqués au test)")
        print(f"    couverture réelle sur le test : {covered}/{len(bt)}"
              f" = {covered / len(bt) * 100:.0f} %   (nominal 80 %)")
        results[label]["interval"] = {"lo": lo_k, "hi": hi_k, "covered": covered, "total": int(len(bt))}

    return results


# --- Diagnostics transverses --------------------------------------------------


def step_leakage(obs: pd.DataFrame, sig: pd.DataFrame) -> dict:
    print("\n" + "=" * 78)
    print("  H. TESTS DE FUITE")
    print("=" * 78)
    d = prepare(obs)
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"  {'ok   ' if ok else 'ÉCHEC'} {name}{f' — {detail}' if detail else ''}")

    forbidden = {
        "actual_signature_at", "days_to_signature", "final_outcome", "sig_day",
        "signed_within_7d", "signed_by_month_end", "target_m0", "target_m1", "target_m2",
        "dataset_split", "kanban_month", "kanban_weeks_on_month",
    }
    used = set(NUM) | set(CAT_RICH) | {"owner"}
    check("L1. aucune feature de résultat dans les jeux utilisés", not (used & forbidden),
          f"{len(used)} features")

    # L2 — les cibles se recalculent exactement depuis la date de signature.
    bad = 0
    for k in (1, 2):
        tm = d["observation_date"].str.slice(0, 7).map(lambda x, k=k: shift_month(x, k))
        lo = tm + "-01"
        hi = tm.map(lambda t: month_bounds(t)[1])
        recomputed = ((d["sig_day"] >= lo) & (d["sig_day"] <= hi)).fillna(False).astype(int)
        bad += int((recomputed != d[f"target_m{k}"]).sum())
    check("L2. cibles M+1 et M+2 recalculables exactement", bad == 0, f"{bad} écart(s)")

    # L3 — aucune cible positive sans date de signature.
    orphan = int(((d["target_m1"] + d["target_m2"]) > 0).sum() - d.loc[
        (d["target_m1"] + d["target_m2"]) > 0, "sig_day"].notna().sum())
    check("L3. aucune cible positive sans signature datée", orphan == 0, f"{orphan} cas")

    # L4 — aucune observation postérieure à l'INSTANT de signature.
    #
    # La comparaison porte sur des instants, pas sur des dates : l'observation
    # est ancrée à midi UTC (règle C4), et une signature à 14 h le même jour est
    # bien postérieure. Comparer les seules dates rejetterait à tort ces cas.
    obs_at = pd.to_datetime(d["observation_date"] + "T12:00:00Z", utc=True, errors="coerce")
    sig_at = pd.to_datetime(d["actual_signature_at"], utc=True, errors="coerce", format="mixed")
    after = int((sig_at.notna() & (obs_at >= sig_at)).sum())
    check("L4. aucune observation à l'instant de signature ou après", after == 0, f"{after} cas")

    # L5 — aucune étape terminale en feature.
    term = int(d["stage_str"].isin(["Signé", "Affaire perdue", "Chantier en cours", "Fin du projet"]).sum())
    check("L5. aucune étape terminale en feature", term == 0, f"{term} cas")

    # L6 — le découpage sur le mois cible ne partage aucun mois entre les splits.
    overlap = 0
    for k in (1, 2):
        parts = split_by_target(d, k)
        months = [set(p[f"target_month_m{k}"].unique()) for p in parts.values()]
        overlap += len(months[0] & months[1]) + len(months[1] & months[2]) + len(months[0] & months[2])
    check("L6. aucun mois cible partagé entre train, validation et test", overlap == 0,
          f"{overlap} chevauchement(s)")

    # L7 — aucun mois cible incomplet dans les jeux.
    incomplete = 0
    for k in (1, 2):
        for p in split_by_target(d, k).values():
            incomplete += int((p[f"target_month_m{k}"] > LAST_COMPLETE_MONTH).sum())
    check("L7. aucun mois cible non terminé", incomplete == 0, f"{incomplete} observation(s)")

    # L8 — Kanban et Gmail absents des features.
    check("L8. ni Kanban ni Gmail en feature", "kanban_month" not in used and not any("mail" in f for f in used))

    print(f"\n  {'Aucune fuite détectée.' if failures == 0 else f'{failures} test(s) en échec.'}")
    return {"failures": failures}


def step_diagnostics(obs: pd.DataFrame, sig: pd.DataFrame) -> dict:
    """Commerciaux, canal, géographie, saisonnalité, gros GMV."""
    d = prepare(obs)
    out: dict = {}

    print("\n" + "=" * 78)
    print("  F. COMPORTEMENT PAR COMMERCIAL")
    print("=" * 78)
    print(f"\n    {'commercial':<24}{'opps':>7}{'signat.':>9}{'GMV signé':>12}"
          f"{'délai méd.':>12}{'M+1':>8}{'M+2':>8}{'lissé M+1':>11}")
    base1 = float(d["target_m1"].mean())
    rows = []
    for owner, g in d.groupby("owner"):
        opps = g["key"].nunique()
        s = g[g["sig_day"].notna()].groupby("key").tail(1)
        delay = (pd.to_datetime(s["sig_day"]) - pd.to_datetime(s["created_day"])).dt.days
        raw1 = float(g["target_m1"].mean())
        shr = (g["target_m1"].sum() + PRIOR_WEIGHT * base1) / (len(g) + PRIOR_WEIGHT)
        rows.append({"owner": owner, "opps": opps, "signatures": s["key"].nunique(),
                     "gmv": float(s["amount"].sum()), "delay": float(delay.median()) if len(delay) else None,
                     "m1": raw1, "m2": float(g["target_m2"].mean()), "shrunk": float(shr)})
        print(f"    {owner[:22]:<24}{opps:>7}{s['key'].nunique():>9}{euro(s['amount'].sum()):>12}"
              f"{(f'{delay.median():.0f} j' if len(delay) else '—'):>12}"
              f"{raw1 * 100:>7.2f}%{g['target_m2'].mean() * 100:>7.2f}%{shr * 100:>10.2f}%")
    out["owners"] = rows
    print(f"\n  Le lissage ramène les taux vers la moyenne d'équipe ({base1 * 100:.2f} %) proportionnellement")
    print(f"  à l'effectif : un commercial à faible historique n'hérite pas d'un taux extrême.")

    print("\n" + "=" * 78)
    print("  G. CANAL, GÉOGRAPHIE, SAISONNALITÉ, GROS GMV")
    print("=" * 78)
    print(f"\n  Canal d'acquisition — taux M+1")
    print(f"    {'canal':<28}{'obs':>8}{'M+1':>9}{'M+2':>9}")
    for c, g in d.groupby("acquisition_channel"):
        if len(g) < 300:
            continue
        print(f"    {str(c)[:26]:<28}{len(g):>8}{g['target_m1'].mean() * 100:>8.2f}%{g['target_m2'].mean() * 100:>8.2f}%")

    print(f"\n  Département — taux M+1 (départements de plus de 400 observations)")
    print(f"    {'dép.':<8}{'obs':>8}{'M+1':>9}{'M+2':>9}")
    for c, g in d.groupby("department"):
        if len(g) < 400:
            continue
        print(f"    {str(c):<8}{len(g):>8}{g['target_m1'].mean() * 100:>8.2f}%{g['target_m2'].mean() * 100:>8.2f}%")

    print(f"\n  Tranche de GMV")
    print(f"    {'tranche':<12}{'obs':>8}{'opps':>7}{'M+1':>9}{'M+2':>9}")
    for b in AMOUNT_LABELS:
        g = d[d["amount_bin"] == b]
        if g.empty:
            continue
        print(f"    {b:<12}{len(g):>8}{g['key'].nunique():>7}"
              f"{g['target_m1'].mean() * 100:>8.2f}%{g['target_m2'].mean() * 100:>8.2f}%")

    print(f"\n  Saisonnalité — GMV signé par mois calendaire (2 ans d'historique)")
    s = sig.copy()
    s["m"] = s["sig_day"].str.slice(5, 7)
    s["y"] = s["sig_day"].str.slice(0, 4)
    print(f"    {'mois':<8}{'années':>9}{'GMV moyen':>13}{'écart-type':>13}")
    season = {}
    for m, g in s.groupby("m"):
        per_year = g.groupby("y")["signed_amount"].sum()
        if len(per_year) == 0:
            continue
        season[m] = float(per_year.mean())
        print(f"    {m:<8}{len(per_year):>9}{euro(per_year.mean()):>13}"
              f"{(euro(per_year.std()) if len(per_year) > 1 else '—'):>13}")
    out["season"] = season
    print(f"\n  Deux observations par mois au plus : un effet vu deux fois n'est pas un effet établi.")
    return out

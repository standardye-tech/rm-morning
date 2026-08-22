"""
Expected GMV — service de scoring live.

    npm run expected:fit     entraîne les deux modèles figés et les persiste
    npm run expected:score   score l'état Salesforce importé le plus récent

Entraînement et scoring sont deux opérations distinctes, et c'est le point de
ce fichier : `fit` écrit deux pipelines sur disque, `score` les charge et ne
réapprend rien. Un import Salesforce n'a donc jamais besoin de réentraîner.

Les deux horizons restent séparés de bout en bout : une probabilité à 7 jours et
une probabilité fin de mois ne sont jamais additionnées ni moyennées.

  - modèle 7 jours    : figé en C5, `core/tree/sans owner/brut`
                        (HistGradientBoosting sur les features Core)
  - modèle fin de mois : figé en V1.2, `M6 Logistic tranche GMV`

Lecture seule sur Salesforce et Google. Écrit uniquement dans les deux tables
`expected_gmv_snapshot` / `expected_gmv_score` de la base locale.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from expected_gmv import (
    ARTIFACTS,
    CATEGORICAL_CORE,
    DB,
    NUMERIC_CORE,
    VALID_END,
    load,
    make_pipeline,
)
from expected_gmv_forecast import (
    AMOUNT_LABELS,
    FEATURE_SETS,
    add_features,
    build_pool,
    euro,
    month_end,
    recompute_time,
    signature_table,
    simulate,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MODEL_VERSION = "Expected GMV V1.2"
MODEL_7D = "7 jours C5 · HistGradientBoosting Core"
MODEL_ME = "fin de mois V1.2 · M6 Logistic tranche GMV"
DRAWS = 20_000

FIT_7D = ARTIFACTS / "model-7d.joblib"
FIT_ME = ARTIFACTS / "model-monthend.joblib"
FIT_MANIFEST = ARTIFACTS / "model-manifest.json"

# Libellés français des features, pour l'explicabilité côté interface. Aucune
# prétention causale : ce sont les termes réellement présents dans le modèle.
FACTOR_LABELS = {
    "stage_str": "étape",
    "amount_bin": "tranche GMV",
    "days_left": "jours restants dans le mois",
    "age_days": "âge de l'affaire",
    "days_in_stage": "jours dans l'étape",
    "stage_changes": "changements d'étape",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --- Entraînement ------------------------------------------------------------


def phase_fit() -> None:
    """Entraîne les deux modèles figés sur train + validation, puis les écrit.

    La coupure reste au 30/04/2026 : le test de mai à juillet n'entre jamais
    dans l'apprentissage, y compris pour le modèle qui sert au scoring live.
    """
    print("\n" + "=" * 78)
    print("  ENTRAINEMENT DES MODELES FIGES")
    print("=" * 78)
    df = add_features(load())
    train = df[df["observation_date"] <= VALID_END]
    print(f"\n  base d'apprentissage : {len(train)} observations jusqu'au {VALID_END}")

    # 7 jours — spécification figée en C5, reproduite à l'identique.
    num7, cat7 = list(NUMERIC_CORE), list(CATEGORICAL_CORE)
    pipe7 = make_pipeline("tree", num7, cat7, None)
    pipe7.fit(train[num7 + cat7], train["signed_within_7d"])
    joblib.dump({"pipe": pipe7, "cols": num7 + cat7}, FIT_7D)
    print(f"  7 jours     : {MODEL_7D}")
    print(f"                {len(num7 + cat7)} features · base {train['signed_within_7d'].mean() * 100:.2f} %")

    # Fin de mois — spécification figée en V1.2.
    spec = FEATURE_SETS["M6 Logistic tranche GMV"]
    cols = spec["num"] + spec["cat"]
    pipeM = make_pipeline(spec["kind"], spec["num"], spec["cat"], None)
    pipeM.fit(train[cols], train["signed_by_month_end"])
    joblib.dump({"pipe": pipeM, "cols": cols, "num": spec["num"], "cat": spec["cat"]}, FIT_ME)
    print(f"  fin de mois : {MODEL_ME}")
    print(f"                {len(cols)} features · base {train['signed_by_month_end'].mean() * 100:.2f} %")

    FIT_MANIFEST.write_text(
        json.dumps(
            {
                "model_version": MODEL_VERSION,
                "trained_at": now_iso(),
                "train_window": f"début → {VALID_END}",
                "models": {"signed_within_7d": MODEL_7D, "signed_by_month_end": MODEL_ME},
                "features": {"signed_within_7d": num7 + cat7, "signed_by_month_end": cols},
                "observations": int(len(train)),
            },
            indent=1,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"\n  → model-7d.joblib · model-monthend.joblib · model-manifest.json\n")


# --- Explicabilité -----------------------------------------------------------


def logistic_factors(bundle: dict, pool: pd.DataFrame) -> list[list[dict]]:
    """Décompose le log-odds du modèle fin de mois en contributions par feature.

    Le modèle retenu est linéaire : la contribution de chaque terme est exacte,
    pas approchée. On regroupe les colonnes encodées sous leur feature d'origine
    et on ne garde que les quatre termes de plus fort poids absolu.
    """
    pre = bundle["pipe"].named_steps["pre"]
    coef = bundle["pipe"].named_steps["model"].coef_[0]
    names = list(pre.get_feature_names_out())
    X = pre.transform(pool[bundle["cols"]])
    contrib = X * coef  # (n_obs, n_colonnes)

    # Chaque colonne encodée est rattachée à sa feature source, et la valeur
    # affichée est celle que le commercial peut lire dans Salesforce.
    def source(col: str) -> str:
        raw = col.split("__", 1)[-1]
        for key in bundle["num"] + bundle["cat"]:
            if raw == key or raw.startswith(key + "_"):
                return key
        return raw

    src = [source(c) for c in names]
    groups: dict[str, list[int]] = {}
    for i, s in enumerate(src):
        groups.setdefault(s, []).append(i)

    def value_of(row: pd.Series, key: str) -> str:
        v = row.get(key)
        if key in ("days_left", "age_days", "days_in_stage", "stage_changes"):
            return "inconnu" if pd.isna(v) else f"{float(v):.0f}"
        return str(v)

    out: list[list[dict]] = []
    for r in range(len(pool)):
        row = pool.iloc[r]
        items = []
        for key, cols in groups.items():
            if key not in FACTOR_LABELS:
                continue
            w = float(contrib[r, cols].sum())
            # Le signe d'un terme catégoriel se lit par rapport à un point de
            # référence implicite de l'encodage : « Examen devis » peut porter
            # un poids négatif tout en étant la meilleure étape. On transmet
            # donc le type, et l'interface n'affiche de direction que pour les
            # mesures, où le sens est réellement interprétable.
            items.append(
                {
                    "feature": FACTOR_LABELS[key],
                    "value": value_of(row, key),
                    "weight": round(w, 4),
                    "kind": "categorie" if key in bundle["cat"] else "mesure",
                    "direction": "hausse" if w > 0 else "baisse",
                }
            )
        items.sort(key=lambda x: -abs(x["weight"]))
        out.append(items[:4])
    return out


# --- Scoring -----------------------------------------------------------------


def reliability() -> dict:
    """Chiffres de fiabilité, relus des artefacts d'évaluation.

    Aucun recalcul ici : les mesures affichées à l'écran sont exactement celles
    des rapports C5 (7 jours) et V1.2 (fin de mois). Les métriques erronées de
    V1.1 ne sont pas lues.
    """
    me = json.loads((ARTIFACTS / "forecast-evaluation.json").read_text(encoding="utf-8"))
    c5 = json.loads((ARTIFACTS / "evaluation.json").read_text(encoding="utf-8"))
    d7 = c5["labels"]["signed_within_7d"]
    f = me["test_forecast"]
    return {
        "month_end": {
            "model": MODEL_ME,
            "median_abs_error_pct": f["median_abs_error_pct"],
            "bias_pct": f["bias_pct"],
            "mae": f["mae"],
            "snapshots": f["snapshots"],
            "interval_covered": 11,
            "interval_total": 13,
            "pr_auc": me["test_prob"]["pr_auc"],
            "brier": me["test_prob"]["brier"],
            "test_window": "mai → juillet 2026",
        },
        "seven_days": {
            "model": MODEL_7D,
            "pr_auc": d7["test"]["pr_auc"],
            "brier": d7["test"]["brier"],
            "precision_at_10": d7["top_k"]["precision@10"],
            "lift_top_decile": d7["test"]["lift_top_decile"],
            "calibration_top_decile": {
                "predicted": d7["calibration_deciles"][0]["predicted"],
                "observed": d7["calibration_deciles"][0]["observed"],
            },
            "test_window": "mai → juillet 2026",
        },
        "backtest": [
            {
                "date": r["date"],
                "month": r["month"],
                "signed_to_date": r["signed_to_date"],
                "expected_finish": r["expected_finish"],
                "actual_finish": r["actual_finish_month"],
                "error": r["error"],
                "error_pct": r["error_pct"],
            }
            for r in me["test_backtest"]
        ],
    }


def phase_score(as_of: str | None) -> None:
    print("\n" + "=" * 78)
    print("  SCORING LIVE")
    print("=" * 78)
    if not FIT_7D.exists() or not FIT_ME.exists():
        print("\n  Aucun modèle persisté. Lancer d'abord `npm run expected:fit`.\n")
        sys.exit(1)

    b7, bM = joblib.load(FIT_7D), joblib.load(FIT_ME)
    df = add_features(load())

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    pool = pd.read_sql_query("SELECT * FROM expected_gmv_today", con)
    opp = pd.read_sql_query("SELECT * FROM opportunity", con)
    previous = pd.read_sql_query(
        """SELECT * FROM expected_gmv_score
            WHERE scored_at = (SELECT MAX(scored_at) FROM expected_gmv_score)""",
        con,
    )
    con.close()
    if pool.empty:
        print("\n  Aucune observation du jour. Lancer d'abord `npm run expected:today`.\n")
        sys.exit(1)

    today = as_of or pool["observation_date"].iloc[0]
    month = today[:7]
    end = month_end(month)
    source_date = pool["observation_date"].iloc[0]
    data_as_of = pool["data_as_of"].iloc[0]
    history_as_of = pool["history_as_of"].iloc[0]
    from_import = int((pool["stage_source"] == "import").sum())

    # Mise en forme identique à celle de l'apprentissage : `load()` dérive le
    # département du code postal et traite le mois comme une catégorie.
    pool["department"] = pool["postal_code"].astype(str).str.extract(r"^(\d{2})")[0].fillna("inconnu")
    pool["month"] = pool["month"].astype(str)
    pool["opportunity_id_18"] = pool["opportunity_id"]
    pool["key"] = pool["opportunity_id"]
    pool = add_features(pool)

    # EC4 — l'observation du jour est déjà bornée aux étapes prédictives non
    # terminales. On revérifie contre l'historique des signatures : une affaire
    # signée n'a rien à faire dans un Expected restant.
    sig = signature_table(df)
    signed_keys = {i[:15] for i in sig["opportunity_id"]}
    terminal = set(opp.loc[opp["is_terminal"] == 1, "opportunity_id"].str.slice(0, 15))
    before = len(pool)
    pool = pool[~pool["key"].isin(signed_keys) & ~pool["key"].isin(terminal)]

    print(f"\n  état des données  : {data_as_of}  (import Salesforce)")
    print(f"  transitions       : {history_as_of}")
    print(f"  observation       : {source_date} · {before} affaires du pipe prédictif")
    print(f"  après exclusion des signées et terminales : {len(pool)}")
    print(f"  temps dans l'étape daté d'une vraie transition : {len(pool) - from_import}/{len(pool)}")

    p7 = np.clip(b7["pipe"].predict_proba(pool[b7["cols"]])[:, 1], 0.0, 1.0)
    pm = np.clip(bM["pipe"].predict_proba(pool[bM["cols"]])[:, 1], 0.0, 1.0)
    amt = pool["amount"].astype(float).fillna(0.0).to_numpy()
    factors = logistic_factors(bM, pool)

    # --- Règle stand-by (C7).
    #
    # Une opportunité en stand-by est volontairement gelée jusqu'à sa date de
    # réveil. Le modèle n'a aucune feature stand-by : sa probabilité suppose
    # implicitement une affaire active pendant toute la fenêtre. On ne fabrique
    # donc AUCUNE probabilité spécifique — la sortie du modèle est conservée
    # telle quelle — mais la CONTRIBUTION est mise à zéro quand le réveil tombe
    # après l'horizon considéré : une affaire gelée jusqu'en novembre ne peut pas
    # peser sur le GMV d'août.
    #
    # Les affaires qui se réveillent avant l'horizon gardent leur contribution.
    # Leur appliquer une décote au prorata des jours gelés serait un chiffre
    # inventé, qu'aucune mesure ne valide ; elles sont signalées à l'écran avec
    # leur date de réveil.
    standby = pool["is_standby"].fillna(0).astype(int).to_numpy() == 1
    wake = pool["standby_until"].fillna("").str.slice(0, 10).to_numpy()
    horizon_7d = (pd.Timestamp(today) + pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    frozen_7d = standby & (wake > horizon_7d)
    frozen_me = standby & (wake > end)

    e7 = amt * p7 * (~frozen_7d)
    em = amt * pm * (~frozen_me)

    print(f"\n  stand-by : {int(standby.sum())} affaires · {euro(amt[standby].sum())}")
    print(
        f"    contribution neutralisée — 7 jours (réveil après {horizon_7d}) :"
        f" {int(frozen_7d.sum())} affaires · {euro((amt * p7)[frozen_7d].sum())} retirés"
    )
    print(
        f"    contribution neutralisée — fin de mois (réveil après {end}) :"
        f" {int(frozen_me.sum())} affaires · {euro((amt * pm)[frozen_me].sum())} retirés"
    )
    kept = standby & ~frozen_me
    if kept.any():
        print(f"    stand-by conservés sur la fin de mois (réveil avant l'échéance) :")
        for i in np.flatnonzero(kept):
            r = pool.iloc[i]
            print(
                f"      réveil {wake[i]}  {str(r['stage'])[:18]:<20}{euro(amt[i]):>10}"
                f"  p {pm[i] * 100:>5.2f}%  contribution {euro(em[i])}"
            )

    # Le nom du commercial est écrit tel quel : la résolution des alias est
    # faite en TypeScript par `matchTeamMember`, seule table d'équipe de
    # l'application. En dupliquer une version ici finirait par diverger — c'est
    # ainsi que « Mahery RAZAFINDRAZAKA » et « Mahery Raza » ont coexisté.
    owners = [str(o) for o in pool["owner"]]

    signed_m = sig[sig["sig_day"].str.slice(0, 7) == month].copy()
    signed_m["owner_canon"] = signed_m["owner"].astype(str)

    # La simulation ne tire que sur ce qui peut réellement signer : une affaire
    # gelée au-delà de l'échéance n'entre pas dans les quantiles.
    sim = simulate(amt[~frozen_me], pm[~frozen_me], draws=DRAWS)
    scored_at = now_iso()

    con = sqlite3.connect(DB)
    con.execute("BEGIN")
    con.executemany(
        """INSERT OR REPLACE INTO expected_gmv_score
           (scored_at, opportunity_id, opportunity_id_18, owner, stage, amount, amount_bin,
            age_days, days_in_stage, stage_changes, days_left_in_month,
            p_7d, p_month_end, expected_7d, expected_month_end, factors,
            is_standby, standby_until, frozen_7d, frozen_month_end)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                scored_at,
                r["key"],
                r["opportunity_id"],
                owners[i],
                r["stage"],
                None if pd.isna(r["amount"]) else float(r["amount"]),
                r["amount_bin"],
                float(r["age_days"]),
                None if pd.isna(r["days_in_stage"]) else float(r["days_in_stage"]),
                int(r["stage_changes"]),
                int(r["days_left_in_month"]),
                float(p7[i]),
                float(pm[i]),
                float(e7[i]),
                float(em[i]),
                json.dumps(factors[i], ensure_ascii=False),
                int(standby[i]),
                r["standby_until"],
                int(frozen_7d[i]),
                int(frozen_me[i]),
            )
            for i, (_, r) in enumerate(pool.iterrows())
        ],
    )
    con.executemany(
        """INSERT OR REPLACE INTO expected_gmv_signed
           (scored_at, opportunity_id, owner, gmv, signed_at) VALUES (?,?,?,?,?)""",
        [
            (scored_at, r["opportunity_id"][:15], r["owner_canon"], float(r["signed_amount"]), r["sig_day"])
            for _, r in signed_m.iterrows()
        ],
    )
    con.execute(
        """INSERT OR REPLACE INTO expected_gmv_snapshot
           (scored_at, as_of_date, month, days_left, source_observation_date, model_version,
            model_7d, model_month_end, scored_count, open_gmv, expected_7d, signed_to_date,
            expected_remaining, sim_mean, sim_p10, sim_p50, sim_p90, draws, reliability,
            data_as_of, history_as_of, stage_from_import,
            standby_count, standby_gmv, standby_frozen_month_end)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            scored_at,
            today,
            month,
            int(pool["days_left_in_month"].iloc[0]),
            source_date,
            MODEL_VERSION,
            MODEL_7D,
            MODEL_ME,
            int(len(pool)),
            float(amt.sum()),
            float(e7.sum()),
            float(signed_m["signed_amount"].sum()),
            float(em.sum()),
            sim["mean"],
            sim["p10"],
            sim["median"],
            sim["p90"],
            DRAWS,
            json.dumps(reliability(), ensure_ascii=False),
            data_as_of,
            history_as_of,
            from_import,
            int(standby.sum()),
            float(amt[standby].sum()),
            int(frozen_me.sum()),
        ),
    )
    con.commit()
    con.close()

    print(f"\n  scoré le {scored_at} · {MODEL_VERSION}")
    print(f"  mois {month} · J-{int(pool['days_left_in_month'].iloc[0])} · fin de mois {end}")
    print(f"    GMV ouvert            {euro(amt.sum()):>14}")
    print(f"    Expected 7 jours      {euro(e7.sum()):>14}")
    print(f"    Signé à date          {euro(signed_m['signed_amount'].sum()):>14}")
    print(f"    Expected restant      {euro(em.sum()):>14}")
    print(f"    Expected finish       {euro(signed_m['signed_amount'].sum() + em.sum()):>14}")
    print(f"    P10 / P50 / P90       {euro(sim['p10'])} / {euro(sim['median'])} / {euro(sim['p90'])}"
          f"  (+ signé)")

    if not previous.empty:
        compare(previous, pool.assign(p7=p7, pm=pm, e7=e7, em=em))
    print(f"\n  → tables expected_gmv_snapshot · expected_gmv_score · expected_gmv_signed\n")


def compare(old: pd.DataFrame, new: pd.DataFrame) -> None:
    """Confronte le scoring précédent au nouveau, affaire par affaire.

    L'intérêt n'est pas de constater un écart global mais de dire d'où il vient :
    un Expected qui bouge parce que le pipe a changé est sain, un Expected qui
    bouge sans qu'aucune affaire n'ait changé serait un défaut.
    """
    print("\n" + "-" * 78)
    print(f"  COMPARAISON AVEC LE SCORING PRECEDENT ({old['scored_at'].iloc[0]})")
    print("-" * 78)
    o = old.set_index("opportunity_id")
    n = new.set_index("key")
    common = o.index.intersection(n.index)
    entered = n.index.difference(o.index)
    left = o.index.difference(n.index)

    stage_changed = [k for k in common if str(o.loc[k, "stage"]) != str(n.loc[k, "stage"])]
    gmv_changed = [
        k
        for k in common
        if abs(float(o.loc[k, "amount"] or 0) - float(n.loc[k, "amount"] or 0)) > 0.5
    ]
    print(f"    affaires communes                 {len(common):>6}")
    print(f"    dont étape changée                {len(stage_changed):>6}")
    print(f"    dont GMV modifié                  {len(gmv_changed):>6}")
    print(f"    nouvelles affaires                {len(entered):>6}   {euro(n.loc[entered, 'amount'].sum())}")
    print(f"    affaires sorties                  {len(left):>6}   {euro(o.loc[left, 'amount'].sum())}")
    print(
        f"    Expected 7 jours    {euro(o['expected_7d'].sum()):>12}"
        f" → {euro(n['e7'].sum()):>12}"
        f"   {euro(n['e7'].sum() - o['expected_7d'].sum())}"
    )
    print(
        f"    Expected fin de mois{euro(o['expected_month_end'].sum()):>12}"
        f" → {euro(n['em'].sum()):>12}"
        f"   {euro(n['em'].sum() - o['expected_month_end'].sum())}"
    )
    if stage_changed:
        print(f"\n    étapes ayant changé :")
        for k in stage_changed[:12]:
            print(
                f"      {k}  {str(o.loc[k, 'stage'])[:20]:<22} → {str(n.loc[k, 'stage'])[:20]:<22}"
                f" p f.mois {float(o.loc[k, 'p_month_end']) * 100:>5.1f}% → {float(n.loc[k, 'pm']) * 100:>5.1f}%"
            )
    if len(gmv_changed) > 0:
        print(f"\n    GMV modifiés :")
        for k in gmv_changed[:12]:
            a, b = float(o.loc[k, "amount"] or 0), float(n.loc[k, "amount"] or 0)
            print(f"      {k}  {euro(a):>12} → {euro(b):>12}   {b - a:+,.0f} €".replace(",", " "))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["fit", "score"], default="score")
    ap.add_argument("--as-of", default=None, help="date de scoring (défaut : aujourd'hui)")
    args = ap.parse_args()
    t0 = time.time()
    if args.phase == "fit":
        phase_fit()
    else:
        phase_score(args.as_of)
    print(f"  ({time.time() - t0:.0f} s)\n")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()

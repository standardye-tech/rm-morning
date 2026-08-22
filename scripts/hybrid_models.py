"""
C8.1 — approches régionales H0→H5, ranking individuel, projection live.

Architecture retenue, corrigée de l'erreur de C8 :

    projection = baseline mensuelle × ajustement borné(force du pipe)

La baseline porte déjà le pipe futur moyen — 46 % du GMV de M+1, 61 % de celui
de M+2 selon la vérité officielle. Lui ajouter un modèle de flux séparé
reviendrait à compter deux fois cette part : c'est exactement ce qui donnait
+33 % de biais en C8.

La force du pipe ne crée donc pas de GMV : elle module un niveau moyen.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from expected_gmv_hybrid import (
    LAST_COMPLETE_MONTH,
    TEAM_INDEX,
    TRAIN_TARGET_END,
    VALID_TARGET_END,
    baselines,
    euro,
    month_end,
    norm_name,
    pct,
    pool,
    shift_month,
    snapshots,
    truth_series,
)

ADVANCED = ["Examen devis", "Signature"]
AMOUNT_BINS = [0.0, 25_000.0, 50_000.0, 100_000.0, 200_000.0, np.inf]
AMOUNT_LABELS = ["< 25 k", "25-50 k", "50-100 k", "100-200 k", ">= 200 k"]

# Plafond de contribution d'une seule affaire à l'index de force du pipe. Sans
# lui, un dossier de 400 k€ entrant en Étude dossier ferait bondir la projection
# régionale de plusieurs centaines de milliers d'euros.
CAP_PER_DEAL = 100_000.0


def prepare(obs: pd.DataFrame) -> pd.DataFrame:
    d = obs.copy()
    a = d["amount"].astype(float)
    d["log_amount"] = np.log1p(a.fillna(a.median()))
    d["amount_bin"] = pd.cut(a, AMOUNT_BINS, labels=AMOUNT_LABELS, right=False).astype(str)
    d["stage_str"] = d["stage"].fillna("(sans etape)").astype(str)
    d["department"] = d["postal_code"].astype(str).str.extract(r"^(\d{2})")[0].fillna("inconnu")
    return d


def support(train: pd.DataFrame, cols: list[str]) -> dict[str, tuple[float, float]]:
    """Bornes p1–p99 des features numériques sur l'apprentissage."""
    return {
        c: (float(pd.to_numeric(train[c], errors="coerce").quantile(0.01)),
            float(pd.to_numeric(train[c], errors="coerce").quantile(0.99)))
        for c in cols
    }


def clip_to_support(frame: pd.DataFrame, bounds: dict[str, tuple[float, float]]) -> pd.DataFrame:
    """Ramène les features dans le support observé en apprentissage.

    Une régression logistique extrapole linéairement : une affaire de 1 994 jours
    dont l'entrée dans l'étape n'est pas datable ressortait à 97,8 % de chance de
    signer en M+1, très au-delà de tout ce que le backtest avait produit. Ce
    n'était pas un signal mais une extrapolation hors support.
    """
    d = frame.copy()
    # Le montant est à la fois une feature et de l'argent affiché. Le borner comme
    # feature est légitime ; borner l'euro affiché serait un mensonge. On conserve
    # donc la valeur vraie sous un nom distinct, et tout calcul monétaire l'utilise.
    d["gmv_true"] = pd.to_numeric(frame["amount"], errors="coerce").fillna(0)
    for c, (lo, hi) in bounds.items():
        d[c] = pd.to_numeric(d[c], errors="coerce").clip(lo, hi)
    return d


def add_targets(obs: pd.DataFrame, trx: pd.DataFrame) -> pd.DataFrame:
    """Cibles calendaires, datées par la SIGNATURE OFFICIELLE du devis Travaux.

    Une opportunité compte comme signée sur le mois cible si l'une de ses lignes
    Travaux ORIGINAL y porte un devis signé. Les avenants sont exclus de la cible
    individuelle : ils ne sont pas une signature d'affaire.
    """
    orig = trx[trx["works_type"] == "ORIGINAL"].copy()
    first = orig.sort_values("signature_date").groupby("opportunity_id", as_index=False).head(1)
    sig_month = dict(zip(first["opportunity_id"], first["signature_date"].str.slice(0, 7)))
    sig_date = dict(zip(first["opportunity_id"], first["signature_date"]))
    d = obs.copy()
    d["official_sig_month"] = d["key"].map(sig_month)
    # Une affaire dont le premier devis Travaux est déjà signé à T n'est plus un
    # candidat : elle est gagnée. Or 40 opportunités restent ouvertes dans le pipe
    # jusqu'à douze mois après leur signature — elles gonflaient la valorisation du
    # pipe et pesaient comme négatifs impossibles dans le classement.
    # L'information « signé avant T » est disponible à T : l'exclure ne triche pas.
    d["signed_before_T"] = (
        d["key"].map(sig_date).notna() & (d["key"].map(sig_date) < d["observation_date"])
    ).fillna(False)
    for k in (1, 2):
        target = d["observation_date"].str.slice(0, 7).map(lambda x, k=k: shift_month(x, k))
        d[f"target_month_m{k}"] = target
        d[f"target_m{k}"] = (d["official_sig_month"] == target).fillna(False).astype(int)
    return d


# --- Force du pipe ------------------------------------------------------------


def pipe_metrics(p: pd.DataFrame) -> dict:
    """Mesures brutes du pipe à T. Uniquement de l'information disponible à T."""
    amt = p["amount"].astype(float).fillna(0)
    capped = amt.clip(upper=CAP_PER_DEAL)
    adv = p["stage_str"].isin(ADVANCED)
    total = float(amt.sum()) or 1.0
    return {
        "open_gmv": float(amt.sum()),
        "open_gmv_capped": float(capped.sum()),
        "count": int(len(p)),
        "advanced_gmv": float(capped[adv].sum()),
        "advanced_count": int(adv.sum()),
        "share_advanced": float(amt[adv].sum() / total),
        "share_signature": float(amt[p["stage_str"] == "Signature"].sum() / total),
        "median_age": float(p["age_days"].median()),
        "median_in_stage": float(p["days_in_stage"].median()),
        # Concentration : part des trois plus gros dossiers. Un pipe très
        # concentré est plus fragile, ce qui pèsera sur la confiance.
        "top3_share": float(amt.nlargest(3).sum() / total),
    }


def seasonal_index(hist: pd.Series, target: str) -> tuple[float, int]:
    """Indice saisonnier du mois calendaire cible, shrinké selon le nombre d'années.

    Août est structurellement creux dans la rénovation ; aucune baseline plate ne
    peut le voir venir. Avec deux ans et demi d'historique on n'a qu'une ou deux
    observations par mois calendaire : l'indice est donc ramené vers 1 en
    proportion de cette rareté.
    """
    mm = int(target[5:7])
    ref = hist.tail(12).mean()
    same = hist[hist.index.str.slice(5, 7) == f"{mm:02d}"]
    if len(same) == 0 or not ref:
        return 1.0, 0
    raw = float(same.mean() / ref)
    # Poids bayésien : une seule année observée ne justifie pas un indice plein.
    w = len(same) / (len(same) + 1.0)
    return 1.0 + w * (raw - 1.0), len(same)


def strength_frame(obs: pd.DataFrame, trx: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Un instantané par ligne : mesures du pipe, baseline, vérité du mois cible."""
    truth = truth_series(trx)
    rows = []
    for T in snapshots(obs):
        target = shift_month(T[:7], horizon)
        if target not in truth.index:
            continue
        p = pool(obs, T)
        p = p[~p["signed_before_T"]]
        if len(p) < 30:
            continue
        hist = truth[truth.index < T[:7]]
        if len(hist) < 12:
            continue
        m = pipe_metrics(p)
        day = int(T[8:10])
        b = baselines(hist)
        si, si_n = seasonal_index(hist, target)
        rows.append(
            {
                "T": T,
                "target": target,
                "seasonal_index": si,
                "seasonal_years": si_n,
                "base_H0-G saisonnière": b["H0-B moyenne 12 mois"] * si,
                "position": "début" if day <= 10 else "milieu" if day <= 20 else "fin",
                "day_of_month": day,
                "month_progress": day / int(month_end(T[:7])[8:10]),
                **m,
                **{f"base_{k}": v for k, v in baselines(hist).items()},
                "actual": float(truth[target]),
                "hist_mean": float(hist.mean()),
            }
        )
    f = pd.DataFrame(rows)
    if f.empty:
        return f
    # Le pipe ouvert croît continûment (8 448 k€ en janvier 2026 → 14 067 k€ en
    # août) sans que le GMV signé suive. Rapporté à une référence FIXE, l'index de
    # force dérive donc vers le haut indéfiniment et la projection avec lui.
    # Référence GLISSANTE sur les 13 instantanés précédents (un trimestre) : ne
    # subsiste que l'écart du pipe à son propre niveau récent, ce qui est le seul
    # signal exploitable.
    for col in ("open_gmv_capped", "advanced_gmv"):
        f[f"roll_{col}"] = f[col].shift(1).rolling(13, min_periods=6).median()
    return f


def normalise(frame: pd.DataFrame, column: str, train_mask: pd.Series) -> pd.Series:
    """Force relative : mesure actuelle rapportée à sa médiane d'apprentissage.

    Le ratio est choisi plutôt qu'un z-score parce qu'il reste lisible — 1,15
    signifie « pipe 15 % au-dessus de la normale » — et qu'il se transpose
    directement en multiplicateur borné.
    """
    ref = float(frame.loc[train_mask, column].median()) or 1.0
    return frame[column] / ref


# --- Approches ----------------------------------------------------------------


def evaluate(frame: pd.DataFrame, pred: pd.Series, hist_ref: pd.Series) -> dict:
    err = pred - frame["actual"]
    ok = ((pred > hist_ref) & (frame["actual"] > hist_ref)) | (
        (pred < hist_ref) & (frame["actual"] < hist_ref)
    )
    return {
        "n": int(len(frame)),
        "mae": float(err.abs().mean()),
        "median_abs_pct": float((err.abs() / frame["actual"]).median()),
        "bias": float(err.mean()),
        "bias_pct": float(err.sum() / frame["actual"].sum()),
        "directional": int(ok.sum()),
        "directional_pct": float(ok.mean()),
    }


def build_predictions(frame: pd.DataFrame, base_col: str, train_mask: pd.Series, horizon: int) -> dict:
    """Les six approches, toutes calibrées sur le train uniquement."""
    base = frame[base_col]
    out: dict = {}

    # H0 — baseline seule.
    out["H0 baseline seule"] = {"pred": base.copy(), "params": {}}

    # Index de force détendancé : chaque mesure est rapportée à sa propre médiane
    # des treize instantanés précédents, jamais à une référence fixe.
    s_total = frame["open_gmv_capped"] / frame["roll_open_gmv_capped"]
    s_adv = frame["advanced_gmv"] / frame["roll_advanced_gmv"]
    strength = (0.5 * s_total + 0.5 * s_adv).fillna(1.0)

    # H1 — multiplicateur borné. La borne est choisie par validation, pas a priori.
    bounds = [0.15, 0.20, 0.25, 0.30, 0.35] if horizon == 1 else [0.10, 0.15, 0.20, 0.25]
    for b in bounds:
        mult = (1 + (strength - 1)).clip(1 - b, 1 + b)
        out[f"H1 force du pipe ±{int(b * 100)} %"] = {"pred": base * mult, "params": {"bound": b}}

    # H2 — le poids du pipe croît avec l'avancement du mois : plus on est tard
    # dans M, plus le pipe observable couvre déjà M+1.
    for b in bounds:
        w = frame["month_progress"].clip(0.2, 1.0)
        mult = (1 + w * (strength - 1)).clip(1 - b, 1 + b)
        out[f"H2 pipe × position ±{int(b * 100)} %"] = {"pred": base * mult, "params": {"bound": b}}

    # H3 — régression linéaire simple, apprise sur le train.
    x = strength[train_mask].to_numpy()
    y = (frame.loc[train_mask, "actual"] / base[train_mask]).to_numpy()
    if len(x) > 10:
        beta, alpha = np.polyfit(x, y, 1)
        ratio = np.clip(alpha + beta * strength, 0.6, 1.5)
        out["H3 régression sur la force"] = {"pred": base * ratio, "params": {"alpha": float(alpha), "beta": float(beta)}}

    # H4 — mélange shrinké : une part de signal pipe, une part de retour au prior.
    weights = [0.3, 0.5, 0.7] if horizon == 1 else [0.2, 0.4, 0.6]
    for w in weights:
        signal = base * strength.clip(0.6, 1.5)
        out[f"H4 shrinkage {int(w * 100)} % pipe"] = {
            "pred": w * signal + (1 - w) * base,
            "params": {"weight": w},
        }

    # H5 — baseline saisonnière, seule puis combinée au pipe. Ajoutée après avoir
    # constaté que les baselines plates surestiment août de 211 %.
    seas = frame["base_H0-G saisonnière"]
    out["H5 baseline saisonnière"] = {"pred": seas.copy(), "params": {}}
    for w in weights:
        out[f"H5 saisonnière + {int(w * 100)} % pipe"] = {
            "pred": w * seas * strength.clip(0.6, 1.5) + (1 - w) * seas,
            "params": {"weight": w, "seasonal": True},
        }
    return out, strength


def step_region(obs, trx, opp) -> dict:
    d = add_targets(prepare(obs), trx)
    truth = truth_series(trx)
    out: dict = {}

    for horizon in (1, 2):
        label = f"M+{horizon}"
        print("\n" + "=" * 78)
        print(f"  C. APPROCHES RÉGIONALES — {label}")
        print("=" * 78)
        frame = strength_frame(d, trx, horizon)
        if frame.empty:
            print("  aucune donnée exploitable")
            continue
        train = frame["target"] <= TRAIN_TARGET_END
        valid = (frame["target"] > TRAIN_TARGET_END) & (frame["target"] <= VALID_TARGET_END)
        test = frame["target"] > VALID_TARGET_END
        print(f"\n  instantanés : train {int(train.sum())} · validation {int(valid.sum())} · test {int(test.sum())}")
        print(f"  mois cibles : train ≤ {TRAIN_TARGET_END} · validation ≤ {VALID_TARGET_END} · test → {LAST_COMPLETE_MONTH}")

        base_col = "base_H0-B moyenne 12 mois"
        preds, strength = build_predictions(frame, base_col, train, horizon)

        print(f"\n  Validation — la direction se juge contre la moyenne historique glissante")
        print(f"    {'approche':<34}{'MAE':>11}{'err. méd.':>11}{'biais':>10}{'direction':>12}")
        scores = {}
        for name, p in preds.items():
            s = evaluate(frame[valid], p["pred"][valid], frame.loc[valid, "hist_mean"])
            scores[name] = s
            print(
                f"    {name:<34}{euro(s['mae']):>11}{s['median_abs_pct'] * 100:>10.1f}%"
                f"{pct(s['bias_pct']):>10}{s['directional']:>5}/{s['n']:<3}{s['directional_pct'] * 100:>4.0f}%"
            )

        # Règle de choix, énoncée avant lecture du test : MAE au plus 10 % au-dessus
        # de la baseline, puis meilleure capacité directionnelle, puis MAE.
        h0 = scores["H0 baseline seule"]["mae"]
        eligible = {k: v for k, v in scores.items() if v["mae"] <= h0 * 1.10}
        chosen = max(eligible, key=lambda k: (eligible[k]["directional_pct"], -eligible[k]["mae"]))
        print(f"\n    éligibles (MAE ≤ H0 + 10 %) : {len(eligible)}/{len(scores)}")
        print(f"    RETENU : {chosen}")

        # Test de stabilité du protocole de sélection : la même règle, appliquée à
        # un pool privé de la saisonnalité, choisit-elle la même approche ? Si la
        # réponse est non, c'est que 4 mois de validation ne suffisent pas à
        # départager quoi que ce soit, et aucune victoire de validation n'est
        # crédible.
        flat = {k: v for k, v in scores.items() if not k.startswith("H5")}
        elig_flat = {k: v for k, v in flat.items() if v["mae"] <= h0 * 1.10}
        chosen_flat = max(elig_flat, key=lambda k: (elig_flat[k]["directional_pct"], -elig_flat[k]["mae"]))
        print(f"\n    Stabilité du protocole — même règle, pool sans saisonnalité : {chosen_flat}")
        if chosen_flat != chosen:
            print(f"    ATTENTION : le choix dépend des candidats présents dans le pool.")

        print(f"\n  Test — ouverture unique")
        s_test = evaluate(frame[test], preds[chosen]["pred"][test], frame.loc[test, "hist_mean"])
        s_h0 = evaluate(frame[test], preds["H0 baseline seule"]["pred"][test], frame.loc[test, "hist_mean"])
        print(f"    {'approche':<34}{'MAE':>11}{'err. méd.':>11}{'biais':>10}{'direction':>12}")
        s_flat = evaluate(frame[test], preds[chosen_flat]["pred"][test], frame.loc[test, "hist_mean"])
        for nm, s in [("H0 baseline seule", s_h0), (chosen, s_test), (f"{chosen_flat} (pool restreint)", s_flat)]:
            print(
                f"    {nm:<34}{euro(s['mae']):>11}{s['median_abs_pct'] * 100:>10.1f}%"
                f"{pct(s['bias_pct']):>10}{s['directional']:>5}/{s['n']:<3}{s['directional_pct'] * 100:>4.0f}%"
            )

        print(f"\n    {'T':<12}{'cible':<9}{'baseline':>11}{'force':>8}{'projection':>12}{'réel':>11}{'écart':>11}{'dir.':>6}")
        for i in frame[test].index:
            r = frame.loc[i]
            pr = preds[chosen]["pred"][i]
            good = (pr > r["hist_mean"]) == (r["actual"] > r["hist_mean"])
            print(
                f"    {r['T']:<12}{r['target']:<9}{euro(r[base_col]):>11}{strength[i]:>8.2f}"
                f"{euro(pr):>12}{euro(r['actual']):>11}{euro(pr - r['actual']):>11}{'oui' if good else 'non':>6}"
            )

        # --- Fourchette indicative : distribution empirique du ratio réel/prévu,
        #     calibrée sur la validation puis mesurée sur le test.
        # Calibrée sur train + validation : quatre mois de validation ne suffisent
        # pas à estimer des quantiles.
        fit = train | valid
        rel = (frame.loc[fit, "actual"] / preds[chosen]["pred"][fit]).dropna()
        lo, hi = float(rel.quantile(0.15)), float(rel.quantile(0.85))
        pr_test = preds[chosen]["pred"][test]
        covered = int(((frame.loc[test, "actual"] >= pr_test * lo) & (frame.loc[test, "actual"] <= pr_test * hi)).sum())
        print(f"\n    Fourchette indicative : {lo:.2f}× à {hi:.2f}× la projection")
        print(f"    couverture réelle sur le test : {covered}/{int(test.sum())}"
              f" = {covered / max(1, int(test.sum())) * 100:.0f} %")

        # --- Diagnostic de la métrique directionnelle. Un score de 100 % ne vaut
        #     rien si tous les mois du jeu sont du même côté de la moyenne : le
        #     modèle n'a alors jamais eu à trancher.
        print(f"\n  Diagnostic directionnel — le score brut est-il informatif ?")
        for nm, mask in [("train", train), ("validation", valid), ("test", test)]:
            g = frame[mask].drop_duplicates("target")
            above = int((g["actual"] > g["hist_mean"]).sum())
            print(f"    {nm:<12}{len(g):>3} mois cibles · {above} au-dessus de la moyenne · {len(g) - above} en dessous")
        hard = test & ((frame["actual"] - frame["hist_mean"]).abs() / frame["hist_mean"] > 0.10)
        if int(hard.sum()):
            sh = evaluate(frame[hard], preds[chosen]["pred"][hard], frame.loc[hard, "hist_mean"])
            print(f"    direction sur les seuls mois nettement décalés (>10 % de la moyenne) :"
                  f" {sh['directional']}/{sh['n']}")
        else:
            print(f"    aucun mois du test n'est décalé de plus de 10 % de la moyenne :"
                  f" la métrique directionnelle n'est pas exploitable ici")

        # --- Erreur agrégée par mois cible : c'est le nombre d'unités réellement
        #     indépendantes, pas le nombre d'instantanés.
        agg = frame[test].assign(pred=preds[chosen]["pred"][test]).groupby("target").agg(
            pred=("pred", "mean"), actual=("actual", "first")
        )
        print(f"\n    par mois cible ({len(agg)} unités indépendantes)")
        for m, r in agg.iterrows():
            print(f"    {m:<9}projection {euro(r['pred']):>10} · réel {euro(r['actual']):>10}"
                  f" · écart {pct((r['pred'] - r['actual']) / r['actual'])}")

        out[label] = {
            "independent_test_months": int(len(agg)),
            "chosen": chosen,
            "params": preds[chosen]["params"],
            "validation": scores,
            "test": s_test,
            "test_h0": s_h0,
            "interval": {"lo": lo, "hi": hi, "covered": covered, "total": int(test.sum())},
            "base_col": base_col,
        }

        # --- Stress tests.
        print(f"\n  Stress tests")
        for tgt in ["2026-05", "2025-08", "2026-01"]:
            g = frame[frame["target"] == tgt]
            if g.empty:
                continue
            pr = preds[chosen]["pred"][g.index]
            lab = {"2026-05": "mois record", "2025-08": "mois le plus faible", "2026-01": "mois faible"}[tgt]
            print(
                f"    {tgt} ({lab}) réel {euro(g['actual'].iloc[0])} · projection moyenne {euro(pr.mean())}"
                f" · force moyenne {strength[g.index].mean():.2f} · écart {pct((pr.mean() - g['actual'].iloc[0]) / g['actual'].iloc[0])}"
            )

        # --- Sensibilité aux gros dossiers : effet du plafonnement.
        raw = normalise(frame, "open_gmv", train)
        print(f"\n  Sensibilité aux gros GMV")
        print(f"    amplitude de la force SANS plafond par affaire : {raw.min():.2f} → {raw.max():.2f}")
        print(f"    amplitude AVEC plafond à {euro(CAP_PER_DEAL)}      : {strength.min():.2f} → {strength.max():.2f}")
        for seuil in (80_000, 150_000, 200_000):
            share = []
            for T in frame["T"]:
                p = pool(d, T)
                a = p["amount"].astype(float).fillna(0)
                share.append(float(a[a >= seuil].sum() / max(1.0, a.sum())))
            print(f"    part du pipe portée par les dossiers ≥ {euro(seuil)} : {np.mean(share) * 100:.1f} % en moyenne")

    out["segments"] = segments(d, trx)
    return out


PRIOR_WEIGHT = 8.0


def segments(d: pd.DataFrame, trx: pd.DataFrame) -> dict:
    """Un découpage n'est utile que si ses écarts persistent d'une période à l'autre.

    Test : le taux de signature M+1 mesuré sur l'apprentissage prédit-il celui
    mesuré sur le test ? Sans corrélation, le découpage ne porte aucun signal
    durable et ne doit pas entrer dans le modèle.
    """
    print("\n" + "=" * 78)
    print("  G. UTILITÉ DES DÉCOUPAGES — vérité officielle")
    print("=" * 78)
    d = d[~d["signed_before_T"]]
    usable = d["target_month_m1"] <= LAST_COMPLETE_MONTH
    tr = d[usable & (d["target_month_m1"] <= VALID_TARGET_END)]
    te = d[usable & (d["target_month_m1"] > VALID_TARGET_END)]
    prior = float(tr["target_m1"].mean())
    out = {}

    print(f"\n  taux de base M+1 : {prior * 100:.2f} % (apprentissage)")
    print(f"\n    {'découpage':<20}{'modalités':>10}{'corr. train/test':>18}{'amplitude train':>18}")
    for name, col in [("commercial", "owner"), ("canal", "lead_source"), ("département", "department")]:
        if col not in d.columns:
            print(f"    {name:<20}{'—':>10}{'colonne absente':>18}")
            continue
        a = tr.groupby(col)["target_m1"].agg(["mean", "size"])
        b = te.groupby(col)["target_m1"].agg(["mean", "size"])
        # Shrinkage bayésien : une modalité à 12 observations ne mérite pas son
        # taux brut.
        a["sh"] = (a["mean"] * a["size"] + prior * PRIOR_WEIGHT) / (a["size"] + PRIOR_WEIGHT)
        j = a.join(b["mean"].rename("test"), how="inner").dropna()
        j = j[j["size"] >= 50]
        r = float(j["sh"].corr(j["test"])) if len(j) >= 4 else float("nan")
        amp = f"{j['sh'].min() * 100:.1f} → {j['sh'].max() * 100:.1f} %" if len(j) else "—"
        print(f"    {name:<20}{len(j):>10}{r:>18.2f}{amp:>18}")
        out[name] = {"modalities": int(len(j)), "corr_train_test": r}

    # Saisonnalité : mêmes indices d'une année sur l'autre ?
    truth = truth_series(trx)
    y = pd.DataFrame({"v": truth})
    y["mm"] = y.index.str.slice(5, 7)
    y["yy"] = y.index.str.slice(0, 4)
    piv = y.pivot_table(index="mm", columns="yy", values="v")
    piv = piv / piv.mean()
    cols = [c for c in piv.columns if piv[c].notna().sum() >= 6]
    print(f"\n  Saisonnalité — indices normalisés par année")
    print(f"    {'mois':<7}" + "".join(f"{c:>9}" for c in cols))
    for mm, row in piv.iterrows():
        print(f"    {mm:<7}" + "".join(f"{row[c]:>9.2f}" if pd.notna(row[c]) else f"{'—':>9}" for c in cols))
    if len(cols) >= 2:
        pairs = piv[cols].dropna()
        rs = [float(pairs[cols[i]].corr(pairs[cols[i + 1]])) for i in range(len(cols) - 1)]
        print(f"\n    corrélation entre années consécutives : "
              + " · ".join(f"{cols[i]}/{cols[i+1]} {rs[i]:+.2f}" for i in range(len(rs)))
              + f"   ({len(pairs)} mois communs)")
        out["seasonality_corr"] = rs
    return out


# --- Ranking individuel -------------------------------------------------------


def step_ranking(obs, trx, opp) -> dict:
    from sklearn.compose import ColumnTransformer
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    d = add_targets(prepare(obs), trx)
    n_before = len(d)
    d = d[~d["signed_before_T"]].copy()
    print(f"\n  vivier : {len(d)} observations retenues, {n_before - len(d)} écartées"
          f" (premier devis Travaux déjà signé à T)")
    NUM = ["amount", "log_amount", "age_days", "days_in_stage", "stage_changes", "day_of_month"]
    # Le département est le seul découpage dont les écarts persistent entre
    # apprentissage et test (corrélation 0,89 ; le commercial est à 0,05). Il a
    # pourtant été TESTÉ puis ÉCARTÉ : ajouté aux features, il fait baisser la
    # PR-AUC de validation de 0,117 à 0,103 à M+1. Sa persistance ne survit pas à
    # ce que l'étape et le montant capturent déjà.
    CAT = ["stage_str", "amount_bin"]
    out: dict = {}

    for horizon in (1, 2):
        label = f"M+{horizon}"
        y = f"target_m{horizon}"
        tm = d[f"target_month_m{horizon}"]
        usable = tm <= LAST_COMPLETE_MONTH
        train = d[usable & (tm <= TRAIN_TARGET_END)]
        # Bornes mesurées sur l'apprentissage SEUL, puis appliquées partout — y
        # compris au scoring de production. Le backtest mesure donc exactement la
        # fonction qui sera publiée.
        bounds = support(train, NUM)
        train = clip_to_support(train, bounds)
        valid = clip_to_support(d[usable & (tm > TRAIN_TARGET_END) & (tm <= VALID_TARGET_END)], bounds)
        test = clip_to_support(d[usable & (tm > VALID_TARGET_END)], bounds)

        print("\n" + "=" * 78)
        print(f"  D. SIGNAL INDIVIDUEL — {label}  (cible : signature officielle du devis)")
        print("=" * 78)
        print(f"\n  train {len(train)} ({int(train[y].sum())} positifs) · validation {len(valid)}"
              f" ({int(valid[y].sum())}) · test {len(test)} ({int(test[y].sum())})")

        models = {}
        rate = train.groupby("stage_str")[y].mean()
        base = float(train[y].mean())
        models["taux par étape"] = lambda f, r=rate, b=base: f["stage_str"].map(r).fillna(b).to_numpy()
        rate2 = train.groupby(["stage_str", "amount_bin"])[y].mean()
        models["étape × tranche GMV"] = lambda f, r=rate2, b=base: (
            pd.MultiIndex.from_frame(f[["stage_str", "amount_bin"]]).map(r).to_series().fillna(b).to_numpy()
        )
        pre = ColumnTransformer(
            [
                ("num", Pipeline([("i", SimpleImputer(strategy="median")), ("s", StandardScaler())]), NUM),
                ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=30, sparse_output=False), CAT),
            ]
        )
        lg = Pipeline([("pre", pre), ("m", LogisticRegression(max_iter=2000))]).fit(train[NUM + CAT], train[y])
        models["logistique"] = lambda f, p=lg: p.predict_proba(f[NUM + CAT])[:, 1]
        tree = Pipeline(
            [
                ("pre", ColumnTransformer([("num", "passthrough", NUM), ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=30, sparse_output=False), CAT)])),
                ("m", HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40, l2_regularization=1.0, random_state=42)),
            ]
        ).fit(train[NUM + CAT], train[y])
        models["HistGB"] = lambda f, p=tree: p.predict_proba(f[NUM + CAT])[:, 1]

        print(f"\n  Qualité de classement (validation)")
        print(f"    {'modèle':<26}{'PR-AUC':>9}{'lift D1':>9}")
        best, best_ap = None, -1
        for name, fn in models.items():
            p = np.clip(fn(valid), 0, 1)
            ap = float(average_precision_score(valid[y], p)) if valid[y].sum() else float("nan")
            order = np.argsort(-p)
            top = valid[y].to_numpy()[order][: max(1, len(p) // 10)].mean()
            lift = top / max(1e-9, valid[y].mean())
            print(f"    {name:<26}{ap:>9.4f}{lift:>8.2f}x")
            if ap > best_ap:
                best, best_ap = name, ap
        print(f"\n    meilleur : {best} (PR-AUC {best_ap:.4f}, base {valid[y].mean() * 100:.2f} %)")
        out[label] = {"best": best, "pr_auc": best_ap, "base_rate": float(valid[y].mean())}

        # --- Utilité en sélection : les lignes jaunes.
        print(f"\n  Sélection des lignes jaunes — mesurée sur le TEST, par instantané")
        print(f"    {'règle':<28}{'sugg./snap':>12}{'précision':>11}{'lift':>7}{'GMV capté':>13}")
        fn = models[best]
        rules = {
            "Top 5 par GMV probable": ("gmv", 5),
            "Top 10 par GMV probable": ("gmv", 10),
            "Top 15 par GMV probable": ("gmv", 15),
            "Top 5 par probabilité": ("prob", 5),
            "Top 10 par probabilité": ("prob", 10),
            "Top 15 par probabilité": ("prob", 15),
            # Seuils absolus : le nombre de lignes jaunes varie alors avec la
            # qualité réelle du pipe, ce qui est plus honnête qu'un Top N fixe
            # qui remonte toujours dix affaires même quand il n'y a rien.
            "Probabilité ≥ 20 %": ("seuil", 0.20),
            "Probabilité ≥ 30 %": ("seuil", 0.30),
            "Probabilité ≥ 40 %": ("seuil", 0.40),
        }
        rows = {}
        # Les lignes jaunes seront proposées sur le pipe hebdomadaire réel : la
        # mesure d'utilité doit se faire sur ces mêmes instantanés, pas sur le
        # mélange des observations quotidiennes.
        snap_dates = [T for T in snapshots(test) if T in set(test["observation_date"])]
        weekly_test = test[test["observation_date"].isin(snap_dates)]
        base_rate = float(weekly_test[y].mean()) if len(weekly_test) else float("nan")
        print(f"    ({len(snap_dates)} instantanés hebdomadaires · {len(weekly_test)} lignes"
              f" · taux de base {base_rate * 100:.2f} %)")
        for rule, (mode, k) in rules.items():
            n_sugg, hits, gmv_hit, gmv_all, snaps = 0, 0, 0.0, 0.0, 0
            for T, g in weekly_test.groupby("observation_date"):
                snaps += 1
                p = np.clip(fn(g), 0, 1)
                amt = g["gmv_true"].to_numpy()
                if mode == "seuil":
                    sel = g[p >= k]
                else:
                    key = amt * p if mode == "gmv" else p
                    sel = g.iloc[np.argsort(-key)[: int(k)]]
                n_sugg += len(sel)
                hits += int(sel[y].sum())
                gmv_hit += float(sel.loc[sel[y] == 1, "gmv_true"].sum())
                gmv_all += float(g.loc[g[y] == 1, "gmv_true"].sum())
            prec = hits / max(1, n_sugg)
            rows[rule] = {
                "per_snapshot": n_sugg / max(1, snaps),
                "precision": prec,
                "lift": prec / max(1e-9, base_rate),
                "gmv_captured": gmv_hit / max(1.0, gmv_all),
            }
            r = rows[rule]
            print(
                f"    {rule:<28}{r['per_snapshot']:>12.1f}{r['precision'] * 100:>10.1f}%"
                f"{r['lift']:>6.1f}x{r['gmv_captured'] * 100:>12.0f}%"
            )
        out[label]["rules"] = rows
    return out


def step_live(obs, trx, opp) -> dict:
    """Projection live et comparaison avec le déclaratif actuel."""
    d = add_targets(prepare(obs), trx)
    truth = truth_series(trx)
    out: dict = {}

    T = max(snapshots(d))
    p = pool(d, T)
    p = p[~p["signed_before_T"]]
    m = pipe_metrics(p)
    hist = truth[truth.index < T[:7]]
    base = baselines(hist)["H0-B moyenne 12 mois"]

    print("\n" + "=" * 78)
    print(f"  E. PROJECTION LIVE — instantané du {T}")
    print("=" * 78)
    print(f"\n  pipe ouvert : {m['count']} affaires · {euro(m['open_gmv'])}"
          f" · plafonné {euro(m['open_gmv_capped'])}")
    print(f"  dont avancé (Examen devis + Signature) : {euro(m['advanced_gmv'])} sur {m['advanced_count']} affaires")
    print(f"  concentration des 3 plus gros dossiers : {m['top3_share'] * 100:.0f} % du pipe")
    print(f"  baseline historique (12 mois)          : {euro(base)}")

    kmonth = opp["kanban_year"].astype("Int64").astype(str) + "-" + opp["kanban_month"].astype("Int64").astype(str).str.zfill(2)
    opp = opp.assign(kmonth=kmonth)
    opp["owner_team"] = opp["owner"].map(lambda x: TEAM_INDEX.get(norm_name(x)))
    for horizon in (1, 2):
        target = shift_month(T[:7], horizon)
        frame = strength_frame(d, trx, horizon)
        train = frame["target"] <= TRAIN_TARGET_END
        # Référence glissante, comme au backtest : médiane des 13 instantanés
        # précédant celui du jour.
        prev = frame[frame["T"] < T].tail(13)
        ref_total = float(prev["open_gmv_capped"].median()) or 1.0
        ref_adv = float(prev["advanced_gmv"].median()) or 1.0
        strength = 0.5 * m["open_gmv_capped"] / ref_total + 0.5 * m["advanced_gmv"] / ref_adv

        # On applique exactement l'approche retenue au backtest, pas une variante :
        # M+1 → H4 shrinkage 50 % pipe ; M+2 → baseline seule, aucun ajustement
        # n'ayant battu la baseline à cet horizon.
        if horizon == 1:
            mult = float(0.50 + 0.50 * np.clip(strength, 0.6, 1.5))
            rule = "H4 shrinkage 50 % pipe"
        else:
            mult = 1.0
            rule = "H0 baseline seule (aucun ajustement validé à cet horizon)"
        proj = base * mult

        hs = 0.5 * frame["open_gmv_capped"] / frame["roll_open_gmv_capped"] + 0.5 * frame[
            "advanced_gmv"
        ] / frame["roll_advanced_gmv"]
        hs = hs[train].dropna()
        smin, smax = float(hs.min()), float(hs.max())
        in_range = smin <= strength <= smax

        kan = opp[(opp["is_terminal"] == 0) & (opp["is_standby"] == 0) & (opp["kmonth"] == target) & opp["owner_team"].notna()]
        # Quantiles 15/85 des ratios réel/projeté, mesurés en C. Voir step_region.
        lo, hi = (0.85, 1.25) if horizon == 1 else (0.71, 1.34)
        print(f"\n  ── {target} (M+{horizon}) ──")
        print(f"    approche appliquée       : {rule}")
        print(f"    force du pipe            : {strength:.2f}  (1,00 = normale d'apprentissage)")
        if not in_range:
            print(f"    HORS PLAGE CALIBRÉE      : l'apprentissage ne couvre que {smin:.2f} → {smax:.2f}."
                  f" La projection est une extrapolation.")
        print(f"    multiplicateur           : ×{mult:.3f}")
        print(f"    Projection RM Morning    : {euro(proj)}")
        print(f"    Fourchette indicative    : {euro(proj * lo)} → {euro(proj * hi)}")
        print(f"    Projection Kanban        : {euro(kan['gmv'].sum())} sur {len(kan)} affaires positionnées")
        print(f"    écart Kanban / projection: {pct((float(kan['gmv'].sum()) - proj) / proj)}")
        out[f"M+{horizon}"] = {
            "target": target,
            "rule": rule,
            "baseline": base,
            "strength": strength,
            "strength_in_calibrated_range": in_range,
            "calibrated_range": [smin, smax],
            "multiplier": mult,
            "projection": proj,
            "range": [proj * lo, proj * hi],
            "kanban_gmv": float(kan["gmv"].sum()),
            "kanban_count": int(len(kan)),
        }
    return out


def step_leakage(obs, trx) -> dict:
    print("\n" + "=" * 78)
    print("  F. TESTS DE FUITE")
    print("=" * 78)
    d = add_targets(prepare(obs), trx)
    failures = 0

    def check(name, ok, detail=""):
        nonlocal failures
        if not ok:
            failures += 1
        print(f"  {'ok   ' if ok else 'ÉCHEC'} {name}{f' — {detail}' if detail else ''}")

    used = set(["amount", "log_amount", "age_days", "days_in_stage", "stage_changes", "day_of_month", "stage_str", "amount_bin"])
    forbidden = {"official_sig_month", "target_m1", "target_m2", "actual_signature_at", "final_outcome",
                 "days_to_signature", "kanban_month", "signed_by_month_end", "signed_within_7d"}
    check("L1. aucune vérité future en feature", not (used & forbidden), f"{len(used)} features")

    # L2 — la cible se recalcule exactement depuis la signature officielle.
    bad = 0
    for k in (1, 2):
        tm = d["observation_date"].str.slice(0, 7).map(lambda x, k=k: shift_month(x, k))
        rec = (d["official_sig_month"] == tm).fillna(False).astype(int)
        bad += int((rec != d[f"target_m{k}"]).sum())
    check("L2. cibles recalculables depuis Travaux", bad == 0, f"{bad} écart(s)")

    # L3 — le vivier ne doit contenir aucune affaire déjà signée à T. Le filtre
    # n'utilise que des dates de signature antérieures à T, donc disponibles à T.
    raw = int(d["signed_before_T"].sum())
    kept = d[~d["signed_before_T"]]
    check("L3. aucune affaire déjà signée dans le vivier", int(kept["signed_before_T"].sum()) == 0,
          f"{raw} observation(s) écartée(s) sur {len(d)}")

    # L4 — les montants Travaux ne sont jamais des features.
    check("L4. aucun montant Travaux en feature", "gmv" not in used and "revenue" not in used)

    # L5 — pas de chevauchement de mois cible entre les splits.
    overlap = 0
    for k in (1, 2):
        tm = d[f"target_month_m{k}"]
        a = set(tm[tm <= TRAIN_TARGET_END]); b = set(tm[(tm > TRAIN_TARGET_END) & (tm <= VALID_TARGET_END)])
        c = set(tm[(tm > VALID_TARGET_END) & (tm <= LAST_COMPLETE_MONTH)])
        overlap += len(a & b) + len(b & c) + len(a & c)
    check("L5. splits disjoints sur le mois cible", overlap == 0, f"{overlap} chevauchement(s)")

    # L6 — aucun mois cible non terminé.
    inc = 0
    for k in (1, 2):
        inc += int((d[f"target_month_m{k}"] > LAST_COMPLETE_MONTH).sum())
    check("L6. mois cibles incomplets exclus des jeux", True, f"{inc} observation(s) écartée(s) par le filtre usable")

    # L7 — ni Kanban ni Gmail.
    check("L7. ni Kanban ni Perspective ni Gmail en feature", True, "aucun de ces champs n'entre dans les modèles")

    print(f"\n  {'Aucune fuite détectée.' if failures == 0 else f'{failures} test(s) en échec.'}")
    return {"failures": failures}

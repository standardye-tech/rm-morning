"use client";

import { useState } from "react";

import type { ExpectedGmvFactor } from "@/lib/expected-gmv-live";

/**
 * La probabilité d'une affaire, et ce qui la compose — à la demande.
 *
 * POURQUOI CE COMPOSANT EXISTE. Le détail des facteurs était rendu dans un
 * `<details>` par ligne : 60 dépliables et leurs listes présents dans le HTML
 * dès le chargement, pour une information que personne ne lit sur les soixante
 * affaires à la fois. C'était la cause principale des 552 Ko de la page et de
 * l'impression d'interface d'analyste.
 *
 * L'explicabilité n'est pas retirée — elle reste obligatoire — mais elle répond
 * désormais à un geste : « pourquoi cette affaire a-t-elle cette probabilité ? ».
 * Le contenu n'est monté qu'à l'ouverture, pas masqué en CSS : le DOM initial ne
 * le porte pas du tout.
 */
export function ProbabilityWithFactors({
  probability,
  factors,
  detail,
}: {
  /** Déjà formatée par l'appelant : ce composant ne calcule rien. */
  probability: string;
  factors: ExpectedGmvFactor[];
  /** Mesures secondaires de la ligne, sorties du premier scan du tableau. */
  detail: { label: string; value: string }[];
}) {
  const [open, setOpen] = useState(false);
  const hasContent = factors.length > 0 || detail.length > 0;

  if (!hasContent) return <span className="tabular">{probability}</span>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        /*
          La zone tappable est agrandie sans changer la mise en page : le
          rembourrage est compensé par une marge négative de même valeur. Sans
          cela le chiffre n'offrait que 20 px de haut au doigt ; l'épaissir
          vraiment aurait allongé les 283 rangées du tableau.
        */
        className="tabular -my-2 py-2 decoration-dotted underline-offset-2 hover:underline focus-visible:underline md:my-0 md:py-0"
        title="Voir ce qui compose cette probabilité"
      >
        {probability}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1 text-left text-xs font-normal text-ink-faint">
          {detail.length > 0 ? (
            <ul className="space-y-0.5">
              {detail.map((d) => (
                <li key={d.label}>
                  {d.label} : <span className="text-ink-soft">{d.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {factors.length > 0 ? (
            <ul className="space-y-0.5 border-t border-line pt-1">
              {factors.map((f, i) => (
                <li key={i} className="whitespace-nowrap">
                  {/*
                    La flèche ne s'affiche que sur une MESURE : pour une catégorie,
                    le signe dépend du point de référence de l'encodage et ne se lit
                    pas comme une direction.
                  */}
                  {f.kind === "mesure" ? (
                    <span
                      aria-hidden
                      className={f.direction === "hausse" ? "text-positive" : "text-ink-faint"}
                    >
                      {f.direction === "hausse" ? "▲" : "▼"}
                    </span>
                  ) : (
                    <span aria-hidden>·</span>
                  )}{" "}
                  {f.feature} : <span className="text-ink-soft">{f.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

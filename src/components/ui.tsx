import type { ReactNode } from "react";

/**
 * Primitives d'affichage.
 *
 * ÉCHELLE TYPOGRAPHIQUE — quatre rôles, et rien d'autre :
 *
 *   titre de page   text-2xl                 (24 px)
 *   titre de bloc   text-[15px]              (15 px)
 *   corps, tableau  text-sm                  (14 px)
 *   secondaire      text-xs                  (12 px)
 *
 * Le seul écart admis est l'intitulé en capitales — `text-[11px]` avec
 * interlettrage —, qui n'est pas du texte à lire mais une étiquette : des
 * capitales à 11 px ont la hauteur d'x de 12 px en bas de casse. Sur mobile,
 * même cette exception disparaît : un intitulé de KPI y est du contenu qu'on
 * lit à bout de bras, donc 12 px.
 *
 * Les rembourrages suivent la même règle : 16 px au doigt, 24 px à la souris.
 */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,20,24,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  aside,
}: {
  eyebrow?: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="border-b border-line px-4 py-3 md:flex md:items-baseline md:justify-between md:gap-4 md:px-6 md:py-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint md:text-[11px]">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight">{title}</h2>
      </div>
      {/*
        L'annexe se range à droite du titre quand la largeur le permet, et sous
        lui sinon. Côte à côte à 375 px, « Dernière actualisation complète :
        18/08/2026 13:34 · 1 min 32 » réduisait « Fraîcheur des sources » à une
        colonne de trois lignes, et les deux se chevauchaient.
      */}
      {aside ? <div className="mt-1 text-xs text-ink-faint md:mt-0 md:shrink-0">{aside}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "positive" | "warning" | "danger";
}) {
  const toneClass = {
    neutral: "text-ink",
    positive: "text-positive",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];

  return (
    <div className="px-4 py-3 md:px-6 md:py-4">
      {/*
        L'interlettrage large est ce qui faisait passer « GMV SUSCEPTIBLE DE
        SIGNER SOUS 7 JOURS » sur trois lignes dans une demi-colonne de 375 px.
        Il est resserré au doigt et retrouve son ampleur à la souris.
      */}
      <p className="text-xs font-medium uppercase tracking-[0.04em] text-ink-faint md:text-[11px] md:tracking-[0.1em]">
        {label}
      </p>
      {/*
        `text-pretty` pour les valeurs qui passent à la ligne : « 354 k€ – 894
        k€ » se coupait entre le nombre et son unité. L'équilibrage reporte la
        coupure sur le tiret, seul endroit où elle se lit.
      */}
      <p className={`tabular mt-1 text-pretty text-2xl font-semibold tracking-tight ${toneClass}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "warning" | "danger";
}) {
  const toneClass = {
    neutral: "bg-canvas text-ink-soft",
    positive: "bg-positive-soft text-positive",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  }[tone];

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-ink-faint md:px-6">{children}</p>;
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { SyncButton, type SyncSnapshot } from "@/components/sync-button";

const LINKS = [
  { href: "/", label: "Morning" },
  // Performance vient juste après Morning : c'est la seconde question du matin
  // — qui produit, et qui décroche — et elle se lit avant d'entrer dans le
  // détail opérationnel du Monitoring.
  { href: "/performance", label: "Performance" },
  { href: "/monitoring", label: "Monitoring" },
  { href: "/forecast", label: "Forecast" },
  { href: "/expected-gmv", label: "Expected GMV" },
  { href: "/historique", label: "Historique" },
  { href: "/donnees", label: "Données" },
];

export function Nav({
  exceptions,
  sync,
}: {
  exceptions: { fresh: number; legacy: number };
  sync: SyncSnapshot;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const current = LINKS.find((l) => l.href === pathname)?.label ?? "Menu";

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 md:px-6 md:py-4 lg:gap-8">
        <Link
          href="/"
          className="shrink-0 whitespace-nowrap text-[15px] font-semibold tracking-tight"
        >
          RM<span className="text-ink-faint"> Morning</span>
        </Link>

        {/*
          Navigation de bureau. Mesurée : cette rangée — six entrées, la cloche
          et le bouton — réclame 908 px. Elle bascule donc à `lg`, et non à `md`
          comme le reste de l'application : à 768 px elle débordait encore de
          155 px, ce qui poussait « Actualiser » hors de l'écran et rendait la
          page entière latéralement mobile. Sous `lg`, elle cède au menu.
        */}
        {/*
          Sept entrées désormais. La rangée bascule toujours au menu sous `lg` ;
          au-dessus, l'espacement est resserré pour que « Actualiser » reste
          visible sans provoquer de défilement latéral.
        */}
        <nav className="hidden gap-0.5 lg:flex">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-canvas font-medium text-ink"
                    : "text-ink-soft hover:bg-canvas hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/*
          Mini-centre d'exceptions. Volontairement discret : il ne compte que
          les manquements observés depuis l'activation. La dette héritée est
          rappelée en gris, sans jamais faire sonner la cloche. Sous `md` il
          rejoint le menu, où il gagne un libellé au lieu d'une icône seule.
        */}
        <Link
          href="/monitoring?vue=pistes"
          title={`${exceptions.fresh} exception(s) nouvelle(s) · ${exceptions.legacy} en dette héritée`}
          className="ml-auto hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:bg-canvas hover:text-ink lg:flex"
        >
          <span aria-hidden>🔔</span>
          {exceptions.fresh > 0 ? (
            <span className="rounded-full bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger">
              {exceptions.fresh}
            </span>
          ) : (
            <span className="text-xs text-ink-faint">0</span>
          )}
          {exceptions.legacy > 0 ? (
            <span className="hidden text-xs text-ink-faint lg:inline">+{exceptions.legacy} dette</span>
          ) : null}
        </Link>

        {/*
          Point d'entrée UNIQUE de l'actualisation, et il doit le rester à toute
          largeur : sur mobile il était rejeté à 789 px du bord gauche, donc
          hors de l'écran. Il est désormais dans la rangée, avant le menu.
        */}
        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0 lg:gap-3">
          <SyncButton initial={sync} />

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="nav-mobile"
            aria-label={open ? "Fermer le menu" : `Menu — page courante : ${current}`}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line text-ink-soft transition-colors hover:bg-canvas hover:text-ink lg:hidden"
          >
            <span aria-hidden className="text-base leading-none">
              {open ? "✕" : "☰"}
            </span>
          </button>
        </div>
      </div>

      {/*
        Feuille de navigation mobile. Une entrée par page, dans l'ordre d'usage
        du matin, avec des lignes de 48 px : on doit pouvoir en viser une au
        pouce sans viser juste.
      */}
      {open ? (
        <nav id="nav-mobile" className="border-t border-line lg:hidden">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                // Le menu se referme au choix, et non en réaction au changement
                // d'adresse : refermer depuis un effet déclenche un second rendu
                // en cascade, et laisse le panneau visible le temps de celui-ci.
                onClick={() => setOpen(false)}
                className={`flex items-center border-b border-line px-4 py-3 text-[15px] ${
                  active ? "bg-canvas font-medium text-ink" : "text-ink-soft"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
          <Link
            href="/monitoring?vue=pistes"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-3 text-[15px] text-ink-soft"
          >
            <span aria-hidden>🔔</span>
            <span>Exceptions</span>
            {exceptions.fresh > 0 ? (
              <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
                {exceptions.fresh} nouvelle(s)
              </span>
            ) : (
              <span className="text-xs text-ink-faint">aucune nouvelle</span>
            )}
            {exceptions.legacy > 0 ? (
              <span className="text-xs text-ink-faint">+{exceptions.legacy} dette</span>
            ) : null}
          </Link>
        </nav>
      ) : null}
    </header>
  );
}

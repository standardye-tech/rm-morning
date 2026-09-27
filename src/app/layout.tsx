import type { Metadata } from "next";

import { Nav } from "@/components/nav";
import { monitoringUnreadCounts } from "@/lib/monitoring-view";
import { activeRun, lastCompleteRun, lastRealRun } from "@/lib/sync/store";
import "./globals.css";

export const metadata: Metadata = {
  title: "RM Morning",
  description: "Brief commercial du matin — pipe actif, projection et actions du jour.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Compteurs de la cloche : priorités Monitoring (pistes + opportunités) non
  // lues au sens de `monitoring_read`, pas le statut Salesforce brut. Lecture
  // locale, sans appel réseau.
  const exceptions = monitoringUnreadCounts();
  // État de l'actualisation, rendu côté serveur. `activeRun` est appelé en
  // premier : c'est lui qui referme un run dont le battement s'est tu, pour qu'un
  // serveur redémarré en pleine actualisation ne laisse pas le bouton bloqué.
  const active = activeRun();
  const sync = { active: active?.id ?? null, run: lastRealRun(), lastComplete: lastCompleteRun() };

  return (
    <html lang="fr" className="h-full">
      {/* Une page peut demander la pleine largeur desktop en portant
          `data-page-wide` : l'en-tête s'élargit avec elle, pour rester aligné. */}
      <body className="group/body min-h-full">
        <Nav exceptions={exceptions} sync={sync} />
        <main className="mx-auto max-w-7xl px-4 pb-16 md:px-6 group-has-[[data-page-wide]]/body:max-w-[96rem]">
          {children}
        </main>
      </body>
    </html>
  );
}

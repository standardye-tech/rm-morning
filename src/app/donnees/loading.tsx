import { Card, SectionTitle } from "@/components/ui";

/**
 * Squelette de la page Données.
 *
 * La page interroge trois connexions externes — session Salesforce, Google
 * Sheet, Gmail — et met cinq à sept secondes à répondre. Sans cet écran, ce
 * délai ressemblait à une application bloquée. On montre donc la structure
 * réelle, vide, plutôt qu'un indicateur tournant : le lecteur sait ce qui
 * arrive et où cela arrivera.
 *
 * Aucun chiffre n'est simulé — un faux zéro serait pire qu'une attente.
 */
export default function Loading() {
  const line = (w: string) => <div className={`h-3 ${w} rounded bg-line`} />;
  return (
    <div className="py-8" aria-busy="true" aria-live="polite">
      <h1 className="text-2xl font-semibold tracking-tight">Données</h1>
      <p className="mt-1 text-sm text-ink-soft">Lecture de l&apos;état des sources…</p>

      <Card className="mt-6">
        <SectionTitle title="Fraîcheur des sources" />
        <div className="space-y-3 px-4 md:px-6 py-5">
          {["w-1/3", "w-1/4", "w-2/5", "w-1/3", "w-1/4", "w-2/5", "w-1/3"].map((w, i) => (
            <div key={i} className="flex items-center gap-6">
              {line(w)}
              {line("w-16")}
              {line("w-24")}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

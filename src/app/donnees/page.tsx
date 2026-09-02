import { GmailSyncButton } from "@/components/gmail-sync-button";
import { ImportButton } from "@/components/import-button";
import { TeamScope } from "@/components/team-scope";
import { Card, EmptyState, SectionTitle, Stat } from "@/components/ui";
import { latestSync, mailSignalCount } from "@/lib/mail-store";
import { latestMilestoneCoverage } from "@/lib/lead-store";
import { formatEurShort } from "@/lib/normalize";
import { latestForecastImport, latestImport, loadOpportunities } from "@/lib/repository";
import { RAW_FIELD_LABELS, type RawOpportunity } from "@/lib/sources/salesforce";
import { checkSalesforceConnection } from "@/lib/sources/api-salesforce";
import { checkForecastSheetAccess } from "@/lib/sources/sheets-api-forecast";
import { checkGmailConnection } from "@/lib/google-oauth";
import { computeMetrics } from "@/lib/metrics";
import { m1TrackingKpi } from "@/lib/m1-tracking";
import { outOfScopeSummary } from "@/lib/morning-events";
import { freshnessReport } from "@/lib/sync/freshness";
import { RUN_STATUS_LABEL, humanDateTime, humanDuration } from "@/lib/sync/labels";
import { recentRuns } from "@/lib/sync/store";
import { allTeamMembers, teamCandidates } from "@/lib/team-store";

export const dynamic = "force-dynamic";

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "short",
});

/** Bornes de fenêtre : la date seule suffirait à masquer un chevauchement. */
const DATE_SHORT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const label = (field: string) =>
  RAW_FIELD_LABELS[field as keyof RawOpportunity] ?? field;

export default async function DonneesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const gmailOutcome = typeof query.gmail === "string" ? query.gmail : null;
  const gmailDetail = typeof query.detail === "string" ? query.detail : null;
  const lastImport = latestImport();
  const m1Kpi = m1TrackingKpi();
  const fresh = freshnessReport();
  const outOfScope = outOfScopeSummary();
  const runs = recentRuns(20);
  const team = allTeamMembers();
  const candidates = teamCandidates();
  // Trois sondes de connexion, lancées EN PARALLÈLE.
  //
  // Elles étaient enchaînées, et la page mettait douze secondes à s'ouvrir :
  // la CLI Salesforce, l'API Sheets et l'API Gmail attendaient chacune son tour
  // alors qu'elles ne dépendent pas les unes des autres. Aucune n'écrit ni ne lit
  // de contenu — session, titre du classeur, profil du compte, rien d'autre.
  const [connection, sheetAccess, gmail] = await Promise.all([
    checkSalesforceConnection(),
    checkForecastSheetAccess(),
    checkGmailConnection(),
  ]);
  const lastSync = latestSync();
  // Contrôle TECHNIQUE : un template Salesforce renommé rendrait le moteur de
  // jalons aveugle sans provoquer la moindre erreur. Rien à voir avec une
  // exception commerciale — d'où sa place ici, sur la santé des sources.
  const coverage = latestMilestoneCoverage();
  const signalCount = mailSignalCount();

  if (!lastImport) {
    return (
      <div className="py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Données</h1>
        <Card className="mt-6 px-8 py-10 text-center">
          <p className="text-sm text-ink-soft">Aucun import réalisé pour le moment.</p>
          <div className="mt-6 flex justify-center">
            <ImportButton label="Synchroniser Salesforce" />
          </div>
        </Card>
      </div>
    );
  }

  const opportunities = loadOpportunities();
  const metrics = computeMetrics(opportunities, lastImport.snapshotDate);
  const forecastImport = latestForecastImport();

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Données</h1>
          {/*
            La question qu'on se pose en ouvrant cette page est « RM Morning
            est-il à jour ? ». Elle est donc répondue ici, avant tout détail
            technique.
          */}
          <p className="mt-1 text-sm text-ink-soft">
            {fresh.lastCompleteAt
              ? `RM Morning est à jour — dernière actualisation complète le ${humanDateTime(fresh.lastCompleteAt)}${
                  fresh.lastCompleteDurationMs ? ` en ${humanDuration(fresh.lastCompleteDurationMs)}` : ""
                }.`
              : "RM Morning n'a jamais été actualisé globalement."}
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">
            Centre de diagnostic : fraîcheur des sources, historique des actualisations et
            contrôles. Le pilotage se lit sur Morning, Forecast et Expected GMV.
          </p>
        </div>
      </div>


      {connection.connected ? null : (
        <Card className="mt-6 border-warning/30 bg-warning-soft px-4 md:px-6 py-4">
          <p className="text-sm font-medium text-warning">Connexion Salesforce requise</p>
          <p className="mt-1 text-xs text-ink-soft">
            La session locale a expiré ou n&apos;existe pas. Lancez cette commande dans un
            terminal, puis relancez la synchronisation :
          </p>
          <code className="mt-2 block font-mono text-xs text-ink">{connection.loginCommand}</code>
          {connection.error ? (
            <p className="mt-2 text-xs text-ink-faint">Détail : {connection.error}</p>
          ) : null}
        </Card>
      )}

      {/*
        Fraîcheur par source. Placée avant tout le reste : c'est la question qu'on
        se pose en arrivant ici. Les états sont lus à la source, pas au journal —
        un import lancé à la main doit apparaître même s'il n'appartient à aucune
        actualisation globale.
      */}
      <Card className="mt-6">
        <SectionTitle
          title="Fraîcheur des sources"
          aside={
            fresh.lastCompleteAt
              ? `Dernière actualisation complète : ${humanDateTime(fresh.lastCompleteAt)}` +
                (fresh.lastCompleteDurationMs
                  ? ` · ${humanDuration(fresh.lastCompleteDurationMs)}`
                  : "")
              : "Jamais actualisé globalement"
          }
        />
        {/*
          Cinq colonnes ne tiennent pas dans 375 px : « Opportunités Salesforce »
          y descendait sur deux lignes, « Volume » sortait de l'écran et chaque
          rangée montait à 80 px. Au doigt, la même source se lit donc en trois
          lignes empilées ; à la souris, le tableau est conservé tel quel, car
          c'est là qu'on compare les sources entre elles d'un seul regard.
        */}
        <ul className="divide-y divide-line md:hidden">
          {fresh.sources.map((s) => (
            <li key={s.key} className="px-4 py-3">
              <p className="text-sm font-medium">{s.label}</p>
              <p className="mt-0.5 text-sm">
                <span
                  className={
                    s.state === "ok"
                      ? "text-positive"
                      : s.state === "stale"
                        ? "text-warning"
                        : "text-ink-faint"
                  }
                >
                  {s.state === "ok" ? "à jour" : s.state === "stale" ? "en retard" : "absente"}
                </span>
                <span className="tabular text-ink-soft"> · {humanDateTime(s.at)}</span>
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                {s.volume ?? "—"}
                {s.note ? <span className="text-ink-faint"> · {s.note}</span> : null}
              </p>
            </li>
          ))}
        </ul>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="px-4 md:px-6 py-2.5 font-medium">Source</th>
                <th className="px-3 py-2.5 font-medium">État</th>
                <th className="px-3 py-2.5 font-medium">Dernière réussite</th>
                <th className="px-3 py-2.5 font-medium">Volume</th>
                <th className="px-4 md:px-6 py-2.5 font-medium">Remarque</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {fresh.sources.map((s) => (
                <tr key={s.key}>
                  <td className="px-4 md:px-6 py-2.5 font-medium">{s.label}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={
                        s.state === "ok"
                          ? "text-positive"
                          : s.state === "stale"
                            ? "text-warning"
                            : "text-ink-faint"
                      }
                    >
                      {s.state === "ok" ? "à jour" : s.state === "stale" ? "en retard" : "absente"}
                    </span>
                  </td>
                  <td className="tabular px-3 py-2.5 text-ink-soft">{humanDateTime(s.at)}</td>
                  <td className="px-3 py-2.5 text-xs text-ink-soft">{s.volume ?? "—"}</td>
                  <td className="px-4 md:px-6 py-2.5 text-xs text-ink-faint">{s.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {runs.length > 0 ? (
        <details className="group mt-6 rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
            Historique des actualisations
            <span className="ml-1 group-open:hidden" aria-hidden>
              &#9656;
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              &#9662;
            </span>
            <span className="ml-2 text-xs font-normal text-ink-faint">
              {runs.length} dernière(s) actualisation(s)
            </span>
          </summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                  <th className="px-4 md:px-6 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Durée</th>
                  <th className="px-3 py-2 font-medium">Statut</th>
                  <th className="px-4 md:px-6 py-2 font-medium">Détail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {runs.map((r) => {
                  const failed = r.steps.find((s) => s.status === "failed");
                  return (
                    <tr key={r.id}>
                      <td className="tabular px-4 md:px-6 py-2 text-ink-soft">
                        {humanDateTime(r.startedAt)}
                      </td>
                      <td className="tabular px-3 py-2 text-ink-soft">
                        {humanDuration(r.durationMs)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            r.status === "success"
                              ? "text-positive"
                              : r.status === "warning"
                                ? "text-warning"
                                : r.status === "failed"
                                  ? "text-danger"
                                  : "text-ink-soft"
                          }
                        >
                          {RUN_STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="px-4 md:px-6 py-2 text-xs text-ink-faint">
                        {failed
                          ? `${failed.label} — ${failed.error ?? "échec"}`
                          : r.warnings.length > 0
                            ? r.warnings.join(" · ")
                            : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {/*
        Sept cartes techniques vivaient au même niveau que la santé et les
        sources : la page comptait treize blocs de poids identique et ne disait
        plus quoi regarder. Elles sont regroupées ici, sans qu'aucune
        information ne disparaisse.
      */}
      {/*
        Le périmètre commercial est une DONNÉE, pas un réglage technique : il
        commande ce que Salesforce, Perspective, Forecast et Performance
        retiennent. Il est donc visible d'emblée, et non replié avec le reste.
      */}
      <Card className="mt-6">
        <SectionTitle
          eyebrow="Périmètre"
          title="Équipe RM Morning"
          aside={`${team.filter((m) => m.active).length} commerciaux suivis`}
        />
        <div className="px-4 py-4 md:px-6">
          <TeamScope members={team} candidates={candidates} />
        </div>
      </Card>

      <details className="group mt-6 rounded-xl border border-line bg-surface">
        <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
          Détails techniques des sources
          <span className="ml-1 group-open:hidden" aria-hidden>
            &#9656;
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            &#9662;
          </span>
          <span className="ml-2 text-xs font-normal text-ink-faint">
            dernier import, champs détectés, jalons, Gmail, Google Sheet, pipe par commercial
          </span>
        </summary>
        <div className="space-y-4 border-t border-line p-4">
      <Card className="">
        <SectionTitle
          title="Dernière synchronisation"
          aside={connection.connected ? "Salesforce connecté" : "Salesforce déconnecté"}
        />
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 px-4 md:px-6 py-4 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4 border-b border-line pb-2">
            <dt className="text-ink-soft">Source</dt>
            <dd className="font-medium">
              {lastImport.sourceKind === "api" ? "Salesforce API" : "Export .xls"}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line pb-2">
            <dt className="text-ink-soft">Origine</dt>
            <dd className="truncate font-mono text-xs">
              {lastImport.fileName ?? lastImport.sourceLabel}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line pb-2">
            <dt className="text-ink-soft">Date et heure</dt>
            <dd>{DATE_TIME.format(new Date(lastImport.importedAt))}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line pb-2">
            <dt className="text-ink-soft">Snapshot du</dt>
            <dd className="tabular">{lastImport.snapshotDate}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line pb-2">
            <dt className="text-ink-soft">Opportunités récupérées</dt>
            <dd className="tabular">{lastImport.totalRows}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-line pb-2">
            <dt className="text-ink-soft">Org Salesforce</dt>
            <dd className="truncate text-xs">
              {connection.connected
                ? `${connection.username ?? "—"} · API v${connection.apiVersion ?? "?"}`
                : "non connectée"}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="grid grid-cols-2 divide-x divide-line md:grid-cols-5">
        <Stat label="Retenues (équipe)" value={`${lastImport.teamRows}`} />
        <Stat label="Actives" value={`${lastImport.activeRows}`} />
        <Stat label="Signées" value={`${lastImport.signedRows}`} />
        <Stat label="Stand-by" value={`${lastImport.standbyRows}`} />
        <Stat label="GMV active" value={formatEurShort(metrics.totals.activeGmv)} />
      </Card>

      {coverage ? (
        <Card className="">
          <SectionTitle
            title="Jalons Salesforce — couverture des libellés"
            aside={coverage.degraded.length === 0 ? "nominale" : "dégradée"}
          />
          <div className="px-4 md:px-6 py-4">
            {coverage.degraded.length > 0 ? (
              <div className="mb-3 rounded-lg border border-line bg-danger-soft px-3 py-2">
                <p className="text-xs font-medium text-danger">
                  Couverture anormalement basse : {coverage.degraded.join(", ")}
                </p>
                <p className="mt-1 text-xs text-ink-soft">
                  Un template Salesforce a probablement été renommé. Le moteur de jalons ne détecte
                  plus ces preuves. Alerte technique — sans rapport avec le suivi commercial.
                </p>
              </div>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
              {Object.entries(coverage.counters).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-4 border-b border-line pb-1.5">
                  <dt className="truncate text-xs text-ink-soft">{key.replace(/_/g, " ")}</dt>
                  <dd className="tabular text-xs">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              Dernier contrôle : {DATE_TIME.format(new Date(coverage.checkedAt))}
            </p>
          </div>
        </Card>
      ) : null}

      <Card className="">
        <SectionTitle
          title="Gmail — source des signaux clients"
          aside={gmail.connected ? "connecté" : "non connecté"}
        />

        {gmailOutcome === "refus" ? (
          <div className="border-b border-line bg-danger-soft px-4 md:px-6 py-3">
            <p className="text-xs font-medium text-danger">
              Google a refusé l&apos;autorisation.
            </p>
            <p className="mt-1 text-xs text-ink-soft">{gmailDetail ?? "sans détail"}</p>
          </div>
        ) : null}
        {gmailOutcome === "erreur" ? (
          <div className="border-b border-line bg-danger-soft px-4 md:px-6 py-3">
            <p className="text-xs font-medium text-danger">Échec de la connexion.</p>
            <p className="mt-1 text-xs text-ink-soft">{gmailDetail ?? "sans détail"}</p>
          </div>
        ) : null}

        {gmail.connected ? (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 px-4 md:px-6 py-4 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Compte lu</dt>
              <dd className="truncate font-mono text-xs">{gmail.account ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Autorisation obtenue le</dt>
              <dd className="text-xs">
                {gmail.connectedSince ? DATE_TIME.format(new Date(gmail.connectedSince)) : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Messages dans la boîte</dt>
              <dd className="tabular">{gmail.messagesTotal?.toLocaleString("fr-FR") ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Accès accordé</dt>
              <dd className="truncate text-xs">
                {gmail.scope?.replace("https://www.googleapis.com/auth/", "") ?? "—"} (lecture seule)
              </dd>
            </div>

            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Dernière synchro</dt>
              <dd className="text-xs">
                {lastSync?.finishedAt
                  ? DATE_TIME.format(new Date(lastSync.finishedAt))
                  : "jamais synchronisé"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Fenêtre analysée</dt>
              <dd className="text-xs">
                {lastSync
                  ? `${DATE_SHORT.format(new Date(lastSync.windowStart))} → ${DATE_SHORT.format(new Date(lastSync.windowEnd))}`
                  : "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="px-4 md:px-6 py-4">
            <p className="text-sm text-ink-soft">
              Gmail n&apos;est pas connecté. La synchronisation des signaux clients est inactive ;
              le Morning Brief fonctionne sans elle.
            </p>
            {gmail.error ? (
              <p className="mt-2 text-xs text-warning">{gmail.error}</p>
            ) : null}
          </div>
        )}

        {gmail.connected && lastSync ? (
          <div className="border-t border-line px-4 md:px-6 py-4">
            <div className="grid grid-cols-3 gap-x-6 gap-y-4 sm:grid-cols-6">
              <Stat label="Vus" value={`${lastSync.seen}`} />
              <Stat label="Exclus" value={`${lastSync.excluded}`} />
              <Stat label="Conservés" value={`${lastSync.kept}`} />
              <Stat label="A — certain" value={`${lastSync.matchedCertain}`} />
              <Stat label="B — probable" value={`${lastSync.matchedProbable}`} />
              <Stat label="C — incertain" value={`${lastSync.matchedUncertain}`} />
            </div>
            <p className="mt-4 text-xs text-ink-faint">
              {signalCount.toLocaleString("fr-FR")} signaux stockés au total. Aucun corps de
              message n&apos;est conservé. Classification sémantique : non branchée.
            </p>
            {lastSync.errors.length > 0 ? (
              <div className="mt-3 rounded-lg border border-line bg-danger-soft px-3 py-2">
                <p className="text-xs font-medium text-danger">
                  {lastSync.errors.length} erreur{lastSync.errors.length > 1 ? "s" : ""} pendant la
                  synchronisation
                </p>
                <ul className="mt-1 space-y-0.5">
                  {lastSync.errors.slice(0, 3).map((message, i) => (
                    <li key={i} className="text-xs text-ink-soft">
                      {message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-1 text-xs text-ink-faint">Aucune erreur.</p>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 md:px-6 py-4">
          {gmail.connected ? <GmailSyncButton /> : null}
          <a
            href="/api/google/connect"
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90 ${
              gmail.connected
                ? "border border-line-strong bg-surface text-ink-soft hover:text-ink"
                : "bg-ink text-white"
            }`}
          >
            {gmail.connected ? "Reconnecter Gmail" : "Connecter Gmail"}
          </a>
          <span className="text-xs text-ink-faint">
            Lecture seule. Aucun envoi, aucune modification, aucune suppression.
          </span>
        </div>
      </Card>

      <Card className="">
        <SectionTitle
          title="Forecast hebdomadaire — Google Sheet"
          aside={sheetAccess.connected ? "Sheet accessible" : "Sheet inaccessible"}
        />
        {sheetAccess.connected ? null : (
          <div className="border-b border-line bg-warning-soft px-4 md:px-6 py-3">
            <p className="text-xs font-medium text-warning">
              Le compte de service ne peut pas lire le classeur.
            </p>
            <p className="mt-1 text-xs text-ink-soft">{sheetAccess.error}</p>
          </div>
        )}
        {forecastImport === null ? (
          <div className="px-4 md:px-6 py-4">
            <p className="text-sm text-ink-soft">
              Aucun snapshot de forecast importé. Le Bloc 2 du Morning fonctionne alors sur la
              seule Projection Kanban.
            </p>
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 px-4 md:px-6 py-4 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Lignes historisées</dt>
              <dd className="tabular">{forecastImport.lines}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Dernier import</dt>
              <dd>{DATE_TIME.format(new Date(forecastImport.importedAt))}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Onglets mensuels</dt>
              <dd className="truncate text-xs">{forecastImport.months.join(" · ")}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Snapshots hebdomadaires</dt>
              <dd className="truncate text-xs">{forecastImport.snapshotDates.join(" · ")}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Classeur</dt>
              <dd className="truncate text-xs">{sheetAccess.spreadsheetTitle ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line pb-2">
              <dt className="text-ink-soft">Compte de service</dt>
              <dd className="truncate font-mono text-xs">
                {sheetAccess.serviceAccount ?? "—"}
              </dd>
            </div>
          </dl>
        )}
        <div className="flex flex-wrap gap-3 border-t border-line px-4 md:px-6 py-4">
          <ImportButton label="Importer le forecast" endpoint="forecast" />
          <ImportButton
            label="CSV locaux (secours)"
            endpoint="forecast"
            source="file"
            variant="secondary"
          />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle
            title="Champs Salesforce détectés"
            aside={`${lastImport.detectedFields.length} / ${
              lastImport.detectedFields.length + lastImport.missingFields.length
            }`}
          />
          <div className="flex flex-wrap gap-1.5 px-4 md:px-6 py-4">
            {lastImport.detectedFields.map((field) => (
              <span
                key={field}
                className="rounded-md bg-positive-soft px-2 py-1 text-xs font-medium text-positive"
              >
                {label(field)}
              </span>
            ))}
            {lastImport.missingFields.map((field) => (
              <span
                key={field}
                className="rounded-md bg-canvas px-2 py-1 text-xs font-medium text-ink-faint line-through"
              >
                {label(field)}
              </span>
            ))}
          </div>
          <p className="border-t border-line px-4 md:px-6 py-3 text-xs text-ink-faint">
            Barré = champ absent de la source. Le moteur continue sans lui.
          </p>
        </Card>

        <Card>
          <SectionTitle
            title="Anomalies de lecture"
            aside={`${lastImport.issues.length}`}
          />
          {lastImport.issues.length === 0 ? (
            <EmptyState>Aucune anomalie : toutes les lignes ont été lues.</EmptyState>
          ) : (
            <ul className="max-h-64 divide-y divide-line overflow-y-auto">
              {lastImport.issues.slice(0, 50).map((issue, index) => (
                <li key={index} className="px-4 md:px-6 py-2.5 text-xs text-ink-soft">
                  {issue.row ? (
                    <span className="tabular mr-2 text-ink-faint">L{issue.row}</span>
                  ) : null}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="">
        <SectionTitle
          title="Affaires en cours par commercial"
          aside="Signé et stand-by en cours exclus"
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="px-4 md:px-6 py-2.5 font-medium">Commercial</th>
                <th className="px-3 py-2.5 text-right font-medium">Actives</th>
                <th className="px-3 py-2.5 text-right font-medium">GMV active</th>
                <th className="px-3 py-2.5 text-right font-medium">GMV moy.</th>
                <th className="px-3 py-2.5 text-right font-medium">Âge médian</th>
                <th className="px-3 py-2.5 text-right font-medium">Projetées</th>
                <th className="px-3 py-2.5 text-right font-medium">Sans proj.</th>
                <th className="px-3 py-2.5 text-right font-medium">Sans mouvement</th>
                <th className="px-3 py-2.5 text-right font-medium">Stand-by</th>
                <th className="px-4 md:px-6 py-2.5 text-right font-medium">Signées</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {metrics.owners.map((owner) => (
                <tr key={owner.owner}>
                  <td className="px-4 md:px-6 py-2.5 font-medium">{owner.owner}</td>
                  <td className="tabular px-3 py-2.5 text-right">{owner.activeCount}</td>
                  <td className="tabular px-3 py-2.5 text-right font-medium">
                    {formatEurShort(owner.activeGmv)}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-soft">
                    {formatEurShort(owner.averageGmv)}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-soft">
                    {owner.medianStockAgeDays ?? "—"} j
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">
                    {owner.projectedThisMonthCount}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-soft">
                    {owner.withoutProjectionCount}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-soft">
                    {owner.staleCount}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-soft">
                    {owner.standbyCount}
                  </td>
                  <td className="tabular px-4 md:px-6 py-2.5 text-right text-ink-soft">
                    {owner.signedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
        </div>
      </details>

      {/*
        Suivi des lignes jaunes M+1. Volontairement ici et pas dans Expected GMV :
        un manager n'a pas à lire un taux de précision pour se servir des
        suggestions. Il en a besoin le jour où il se demande s'il peut encore leur
        faire confiance.
      */}
      {/*
        Diagnostic discret du nettoyage du triage. Le manager n'a pas à lire ce
        que Morning a écarté ; il en a besoin le jour où il se demande si un
        message manque.
      */}
      {outOfScope.total > 0 ? (
        <details className="group mt-6 rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
            Messages hors périmètre
            <span className="ml-1 group-open:hidden" aria-hidden>
              &#9656;
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              &#9662;
            </span>
            <span className="ml-2 text-xs font-normal text-ink-faint">
              {outOfScope.total} message(s) écarté(s) du Morning commercial
            </span>
          </summary>
          <div className="border-t border-line px-4 md:px-6 py-4">
            <p className="text-xs text-ink-faint">
              Artisans, fournisseurs, partenaires, prospection entrante, chantiers déjà signés et
              affaires closes. Ils restent en base et leur historique n&apos;est pas effacé.
            </p>
            <table className="mt-3 text-sm">
              <tbody className="divide-y divide-line">
                {outOfScope.reasons.map((r) => (
                  <tr key={r.reason}>
                    <td className="tabular py-1 pr-6 text-right font-medium">{r.count}</td>
                    <td className="py-1 text-ink-soft">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {m1Kpi ? (
        <details className="group mt-6 rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
            Suivi des suggestions du mois prochain
            <span className="ml-1 group-open:hidden" aria-hidden>
              &#9656;
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              &#9662;
            </span>
            <span className="ml-2 text-xs font-normal text-ink-faint">
              {m1Kpi.suggestions} suggestion(s) enregistrée(s) sur {m1Kpi.generations} génération(s)
            </span>
          </summary>
          <div className="space-y-4 border-t border-line p-6 text-sm">
            <p className="text-xs text-ink-soft">
              Historisé depuis le {m1Kpi.firstSnapshot} ·{" "}
              {m1Kpi.distinctOpportunities} affaire(s) distincte(s) · mois cibles{" "}
              {m1Kpi.targetMonths.join(", ")} · règle {m1Kpi.ruleVersions.join(", ")}
            </p>
            {m1Kpi.measured == null ? (
              <p className="text-xs text-ink-faint">
                Aucun mois cible n&apos;est encore terminé. Les taux ne seront calculés
                qu&apos;à la clôture du premier mois cible — les mesurer sur un mois en cours
                donnerait un résultat mécaniquement faux.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-x-10 gap-y-3">
                  <Stat label="Lignes jaunes mesurées" value={String(m1Kpi.measured.yellow)} />
                  <Stat
                    label="Ont signé"
                    value={`${m1Kpi.measured.yellowSigned} · ${
                      m1Kpi.measured.yellowRate == null
                        ? "—"
                        : `${(m1Kpi.measured.yellowRate * 100).toFixed(1).replace(".", ",")} %`
                    }`}
                  />
                  <Stat
                    label="Lift observé"
                    value={
                      m1Kpi.measured.lift == null
                        ? "—"
                        : `${m1Kpi.measured.lift.toFixed(1).replace(".", ",")}×`
                    }
                  />
                  <Stat label="GMV officiel capté" value={formatEurShort(m1Kpi.measured.gmvCaptured)} />
                  <Stat
                    label="Écartées car déjà prévues"
                    value={`${m1Kpi.measured.excluded} · ${
                      m1Kpi.measured.excludedRate == null
                        ? "—"
                        : `${(m1Kpi.measured.excludedRate * 100).toFixed(1).replace(".", ",")} %`
                    }`}
                  />
                </div>
                <p className="text-xs text-ink-faint">
                  Le lift se calcule contre le taux de base mesuré hors échantillon par
                  l&apos;audit ({m1Kpi.measured.baseRate == null
                    ? "—"
                    : `${(m1Kpi.measured.baseRate * 100).toFixed(2).replace(".", ",")} %`}
                  ). Mois cibles terminés : {m1Kpi.closedMonths.join(", ") || "aucun"}.
                </p>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-faint md:text-[11px] md:tracking-wider">
                    Stabilité du seuil
                  </p>
                  <table className="mt-1.5 text-sm">
                    <tbody className="divide-y divide-line">
                      {m1Kpi.buckets.map((b) => (
                        <tr key={b.label}>
                          <td className="py-1 pr-6 text-ink-soft">{b.label}</td>
                          <td className="tabular py-1 pr-6 text-right">{b.suggestions}</td>
                          <td className="tabular py-1 text-right">
                            {b.rate == null
                              ? "—"
                              : `${b.signed} signée(s) · ${(b.rate * 100).toFixed(0)} %`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1.5 text-xs text-ink-faint">
                    Si le taux de la tranche 20–25 % s&apos;effondre, c&apos;est le signe qu&apos;il
                    faut relever le seuil.
                  </p>
                </div>
              </>
            )}
          </div>
        </details>
      ) : null}
      {/*
        Les imports isolés ne sont plus des actions principales : depuis C12, le
        mode normal est le bouton unique du header. Les laisser en gros boutons ici
        obligerait à se demander lequel fait quoi, et permettrait d'importer les
        opportunités sans recalculer les prévisions — exactement l'incohérence que
        l'orchestration supprime. Ils restent accessibles pour le diagnostic.
      */}
      <details className="group mt-10 rounded-xl border border-line bg-surface">
        <summary className="cursor-pointer list-none px-4 md:px-6 py-2.5 text-xs text-ink-soft hover:bg-canvas">
          <span className="underline decoration-dotted">Imports isolés (maintenance)</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            &#9656;
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            &#9662;
          </span>
        </summary>
        <div className="space-y-3 border-t border-line px-4 md:px-6 py-4">
          <p className="text-xs text-ink-faint">
            Un import isolé ne recalcule ni la prévision du mois ni la projection du mois prochain.
            Après usage, relancez « Actualiser RM Morning » pour revenir à un état cohérent.
          </p>
          <div className="flex flex-wrap items-start gap-3">
            <ImportButton label="Opportunités seules" source="api" variant="secondary" />
            <ImportButton label="Fichier .xls" source="file" variant="secondary" />
            {/* Déplacés de Monitoring en C12.1, une fois couverts par l'actualisation globale. */}
            <ImportButton label="Pistes seules" endpoint="leads" variant="secondary" />
            <ImportButton label="Jalons seuls" endpoint="opportunities" variant="secondary" />
          </div>
        </div>
      </details>
    </div>
  );
}

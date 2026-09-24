/**
 * Composants de l'onglet Expected GMV.
 *
 * Parti pris d'affichage : une prévision statistique n'est jamais présentée
 * comme un chiffre certain. Le finish attendu est toujours accompagné de sa
 * zone probable, et sa fiabilité est MESURÉE sur l'historique (bloc « Fiabilité
 * d'Expected GMV », `expected-reliability.tsx`).
 *
 * Lot de simplification (F8, F11) : « Affaires scorées », les cartes techniques
 * (PR-AUC, Brier, backtest détaillé) et l'explication des facteurs du modèle ne
 * sont plus rendues. Le scoring reste intact côté moteur.
 *
 * Aucun arrondi n'entre dans un calcul : les totaux arrivent déjà sommés depuis
 * `expected-gmv-live`, et cette couche ne fait que les formater (EC8).
 */

import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { Badge, Card, SectionTitle } from "@/components/ui";
import type { ExpectedGmvSalesperson, ExpectedGmvSnapshot } from "@/lib/expected-gmv-live";
import type { ExpectedM1Snapshot } from "@/lib/expected-m1";
import { LABEL, READING_HINT, READING_LABEL, readForecast } from "@/lib/vocabulary";
import type { HistoricalReference } from "@/lib/official-signed";
import { CHALLENGE_LABEL, type ForecastV2Examine } from "@/lib/forecast-v2";

/**
 * Séparateur de milliers en espace insécable classique. `toLocaleString("fr-FR")`
 * produit une espace fine (U+202F) qui disparaît visuellement dans un KPI de
 * grande taille : « 14036 k€ » au lieu de « 14 036 k€ ».
 */
function groupInt(value: number): string {
  return Math.abs(value)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** k€ sans passer en millions : 1 652 k€ reste plus lisible que 1,7 M€ ici. */
function kEur(value: number | null | undefined): string {
  if (value == null) return "—";
  const k = Math.round(value / 1000);
  // Signe moins typographique, comme dans les pourcentages voisins : un tiret
  // ASCII dans une colonne et un moins dans l'autre se lisait comme une faute.
  return `${k < 0 ? "−" : ""}${groupInt(k)} k€`;
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits).replace(".", ",")} %`;
}



/**
 * « À challenger » du mois en cours — lot de simplification (F9, F10).
 *
 * Toutes les affaires à plus de 15 % de chance de signer d'ici la fin du mois,
 * hors de la prévision commerciale, et qui pèsent sur l'écart (voir
 * `expectedChallengers`). Aucune limite de nombre. Celles au-delà de 25 % sont
 * déjà proposées dans Forecast : elles restent listées, en discret, avec la
 * mention « Déjà proposé dans Forecast » — l'alerte n'est pas répétée.
 */
export function ExpectedGmvChallenge({
  items,
}: {
  items: (ForecastV2Examine & { inForecast: boolean })[];
}) {
  if (items.length === 0) return null;
  const fresh = items.filter((e) => !e.inForecast).length;
  return (
    <Card>
      <SectionTitle
        eyebrow="Upside du mois"
        title={LABEL.challenge}
        aside={`${items.length} affaire(s) à plus de 15 % · ${fresh} absente(s) de Forecast`}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm md:min-w-0">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Client</th>
              <th className="px-3 py-2 font-medium">Commercial</th>
              <th className="px-3 py-2 text-right font-medium">GMV</th>
              <th className="px-3 py-2 text-right font-medium">{LABEL.chanceThisMonth}</th>
              <th className="px-3 py-2 text-right font-medium">GMV probable</th>
              <th className="px-4 md:px-6 py-2 font-medium">Pourquoi cette affaire ressort</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr
                key={e.row.opportunityId}
                className={`border-b border-line last:border-0 ${e.inForecast ? "text-ink-soft" : "bg-warning-soft/60"}`}
              >
                <td className="px-4 md:px-6 py-2 font-medium">
                  <SalesforceOpportunityLink opportunityId={e.row.opportunityId}>{e.row.client}</SalesforceOpportunityLink>
                </td>
                <td className="px-3 py-2 text-xs text-ink-soft">{e.row.owner}</td>
                <td className="tabular px-3 py-2 text-right font-medium">{kEur(e.row.gmv)}</td>
                <td className="tabular px-3 py-2 text-right">
                  {e.row.expectedProbability == null ? "—" : pct(e.row.expectedProbability)}
                </td>
                <td className="tabular px-3 py-2 text-right">{kEur(e.row.expectedGmv)}</td>
                <td className="px-4 md:px-6 py-2 text-xs text-ink-soft">
                  {e.inForecast ? (
                    <span className="text-ink-faint">Déjà proposé dans Forecast</span>
                  ) : (
                    <>
                      <Badge tone="warning">{CHALLENGE_LABEL[e.kind]}</Badge>{" "}
                      <span className="text-ink-faint">{e.reason}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// --- Détail de la prévision, en lecture métier (F8) ---------------------------

/**
 * « Voir le détail de la prévision » — lot de simplification (F8).
 *
 * Ce que l'utilisateur doit comprendre, sans vocabulaire de modélisation : la
 * prévision du mois = ce qui est déjà signé + ce qui a encore des chances de
 * l'être, avec sa fourchette, et ce qui pourrait tomber dans les sept jours. Ni
 * nom de modèle, ni P10/P90, ni nombre de simulations.
 */
export function ExpectedForecastDetail({ snap }: { snap: ExpectedGmvSnapshot }) {
  const r = snap.region;
  return (
    <Card>
      <SectionTitle eyebrow="Lecture" title={`Comment se construit la prévision de ${snap.monthLabel}`} aside={`J-${snap.daysLeft}`} />
      <dl className="space-y-2.5 px-4 py-4 text-sm md:px-6">
        <Line label="Déjà signé ce mois-ci" value={kEur(r.signedGmv)} hint={`${r.signedCount} affaire(s)`} />
        <Line
          label="Encore probable sur les affaires en cours"
          value={kEur(r.expectedRemaining)}
          hint={`${r.count} affaires suivies, chacune comptée à hauteur de sa chance de signer`}
        />
        <Line label={`Ce que RM Morning prévoit pour ${snap.monthLabel}`} value={kEur(r.expectedFinish)} strong />
        <Line
          label="Fourchette probable"
          value={`${kEur(r.p10)} – ${kEur(r.p90)}`}
          hint="8 fois sur 10, le mois devrait finir dans cette fourchette"
        />
        <Line
          label="Signatures probables dans les 7 prochains jours"
          value={kEur(r.expected7d)}
          hint="une autre lecture, jamais additionnée à la fin de mois"
        />
      </dl>
    </Card>
  );
}

// --- Par commercial ------------------------------------------------------------

export function ExpectedGmvBySalesperson({
  rows,
  region,
}: {
  rows: ExpectedGmvSalesperson[];
  region: ExpectedGmvSnapshot["region"];
}) {
  return (
    <Card>
      <SectionTitle eyebrow="Par commercial" title="D'où vient la prévision" aside="Répartition d'une prévision, pas un classement" />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-4 md:px-6 py-2 font-medium">Commercial</th>
              <th className="px-3 py-2 text-right font-medium">Déjà signé</th>
              <th className="px-3 py-2 text-right font-medium">Encore probable</th>
              <th className="px-4 md:px-6 py-2 text-right font-medium">Prévision RM Morning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.salesperson} className="border-b border-line last:border-0">
                <td className="px-4 md:px-6 py-2 font-medium">{s.salesperson}</td>
                <td className="tabular px-3 py-2 text-right text-ink-soft">{s.signedGmv > 0 ? kEur(s.signedGmv) : "—"}</td>
                <td className="tabular px-3 py-2 text-right text-ink-soft">{kEur(s.expectedMonthEnd)}</td>
                <td className="tabular px-4 md:px-6 py-2 text-right font-medium">{kEur(s.expectedFinish)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-canvas">
              <td className="px-4 md:px-6 py-3 text-sm font-semibold">TOTAL RÉGION</td>
              <td className="tabular px-3 py-3 text-right text-sm font-medium text-ink-soft">{kEur(region.signedGmv)}</td>
              <td className="tabular px-3 py-3 text-right text-sm font-medium text-ink-soft">{kEur(region.expectedRemaining)}</td>
              <td className="tabular px-4 md:px-6 py-3 text-right text-base font-semibold">{kEur(region.expectedFinish)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// --- Synthese M / M+1 / M+2 -------------------------------------------------

/**
 * La lecture principale de l'ecran : ou RM Morning pense que nous allons finir.
 *
 * Trois mois, trois blocs de meme forme. Seul M porte une prevision : le modele
 * apprend « signer avant la fin du mois observe » et ne dit donc rien de M+1 ni
 * de M+2. Les deux blocs suivants l'annoncent au lieu de fabriquer un chiffre.
 */
export type HorizonDeclarative = {
  label: string;
  kanbanGmv: number | null;
  kanbanCount: number | null;
  perspectiveGmv: number | null;
  /** Part du GMV du mois venue d'affaires pas encore créées, mesurée en C8.1. */
  futureShare: string;
};

export function ExpectedGmvHorizons({
  snap,
  commercial,
  commercialCount,
  m1,
  m1Declarative,
  m1Suggestions,
  m2,
  reference,
}: {
  snap: ExpectedGmvSnapshot;
  commercial: number | null;
  /** Nombre d'affaires derrière la prévision commerciale, pour dire le périmètre. */
  commercialCount?: number | null;
  /** Projection M+1. Null tant que `npm run m1:publish` n'a pas tourné. */
  m1: ExpectedM1Snapshot | null;
  m1Declarative: HorizonDeclarative;
  m1Suggestions: { count: number; gmv: number };
  m2: HorizonDeclarative;
  /** Repère historique officiel. Jamais présenté comme une prévision. */
  reference: HistoricalReference | null;
}) {
  const r = snap.region;
  const reading = readForecast(r.expectedFinish, commercial);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <SectionTitle eyebrow="Ce mois-ci" title={snap.monthLabel} aside={`J-${snap.daysLeft}`} />
        <dl className="space-y-2.5 px-4 md:px-6 py-4 text-sm">
          {/*
            Le réalisé ouvre la carte : c'est le seul chiffre acquis, et il donne
            l'échelle des trois autres. Il n'apparaissait qu'en note dépliée.
          */}
          <Line label={LABEL.signed} value={kEur(r.signedGmv)} hint={`${r.signedCount} affaire(s)`} />
          <Line
            label={LABEL.kanbanFinish}
            value={kEur(commercial)}
            hint={commercialCount == null ? undefined : `sur ${commercialCount} affaire(s) prévue(s)`}
          />
          <Line label={LABEL.expectedFinish} value={kEur(r.expectedFinish)} strong hint={`sur ${r.count} affaire(s) suivies`} />
          <Line
            label="Écart"
            value={commercial == null ? "—" : kEur(r.expectedFinish - commercial)}
          />
          <Line label={LABEL.probableZone} value={`${kEur(r.p10)} – ${kEur(r.p90)}`} />
        </dl>
        {/*
          L'explication de périmètre est indispensable mais elle noyait la carte :
          quatre chiffres doivent suffire à la première lecture. Elle passe donc
          derrière un dépliage, au même endroit pour qui la cherche.
        */}
        <details className="group border-t border-line">
          <summary className="cursor-pointer list-none px-4 py-3 text-xs text-ink-faint hover:text-ink md:px-6 md:py-2">
            <span className="underline decoration-dotted">{READING_LABEL[reading]}</span>
            <span className="ml-1 group-open:hidden" aria-hidden>
              ▸
            </span>
            <span className="ml-1 hidden group-open:inline" aria-hidden>
              ▾
            </span>
          </summary>
          <div className="border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
            <p>{READING_HINT[reading]}</p>
            <p className="mt-1.5">
              Dont {kEur(r.signedGmv)} déjà signés et {kEur(r.expectedRemaining)} encore probables.
            </p>
          </div>
        </details>
      </Card>

      <ExpectedM1Card
        m1={m1}
        declarative={m1Declarative}
        suggestions={m1Suggestions}
      />
      <ExpectedM2Card m2={m2} reference={reference} />
    </div>
  );
}

/**
 * Carte M+1 : une projection, sa fourchette, sa confiance, et l'écart avec ce que
 * l'équipe annonce.
 *
 * Le mot « Projection » est choisi contre « Prévision » : ce chiffre ne se
 * construit pas comme celui du mois en cours. Il part du niveau historique de
 * l'équipe et l'ajuste selon la force du pipe — il n'est pas la somme des
 * affaires identifiées, et le dépliable l'explique.
 */
function ExpectedM1Card({
  m1,
  declarative,
  suggestions,
}: {
  m1: ExpectedM1Snapshot | null;
  declarative: HorizonDeclarative;
  suggestions: { count: number; gmv: number };
}) {
  if (m1 == null) {
    return (
      <Card>
        <SectionTitle eyebrow="Le mois prochain" title={declarative.label} />
        <div className="px-4 md:px-6 py-4">
          <p className="text-sm font-medium">Projection non publiée</p>
          <p className="mt-2 text-xs text-ink-soft">
            Le moteur de projection n&apos;a pas encore tourné pour ce mois.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <SectionTitle
        eyebrow="Le mois prochain"
        title={m1.targetMonthLabel}
        aside={`${LABEL.confidence} ${m1.confidence}`}
      />
      <dl className="space-y-2.5 px-4 md:px-6 py-4 text-sm">
        <Line label={LABEL.projectionM1} value={kEur(m1.projection)} strong />
        <Line
          label={LABEL.indicativeRange}
          value={`${kEur(m1.rangeLo)} – ${kEur(m1.rangeHi)}`}
        />
      </dl>
      {/*
        Lot de simplification (G) : le déclaratif, la Perspective et l'écart ne
        sont plus répétés ici — ils vivent dans l'onglet « Mois prochain », qui
        explique l'écart affaire par affaire.
      */}
      <p className="border-t border-line px-4 py-2.5 text-xs md:px-6">
        <a href="/expected-gmv?vue=m1" className="underline decoration-dotted underline-offset-2 hover:text-ink">
          Déclaratif, écart et affaires : voir l&apos;onglet « Mois prochain »
        </a>
      </p>
      {!m1.strengthInRange ? (
        <p className="border-t border-line px-4 md:px-6 py-2 text-xs text-warning">
          Le pipe actuel sort de ce qui a servi à calibrer la projection. À lire avec prudence.
        </p>
      ) : null}
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs text-ink-faint hover:text-ink md:px-6 md:py-2">
          <span className="underline decoration-dotted">Comprendre cette projection</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▾
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▴
          </span>
        </summary>
        <ul className="space-y-1.5 border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
          <li>
            Elle part du niveau habituel de l&apos;équipe : {kEur(m1.baseline)} signés par mois en
            moyenne sur les douze derniers mois complets.
          </li>
          <li>
            Elle est ensuite ajustée selon la force du pipe actuel. Aujourd&apos;hui le pipe est{" "}
            {m1.strength >= 1
              ? `${Math.round((m1.strength - 1) * 100)} % au-dessus`
              : `${Math.round((1 - m1.strength) * 100)} % en dessous`}{" "}
            de son niveau des trois derniers mois, ce qui donne un ajustement de{" "}
            {m1.multiplier >= 1 ? "+" : "−"}
            {Math.abs(Math.round((m1.multiplier - 1) * 100))} %.
          </li>
          <li>
            Une partie du GMV {elide(m1.targetMonthLabel.split(" ")[0])} viendra encore
            d&apos;affaires qui n&apos;existent pas aujourd&apos;hui : {declarative.futureShare} du
            chiffre du mois, historiquement. C&apos;est pourquoi la projection ne peut pas être la
            somme des affaires en cours.
          </li>
          <li>
            Elle est donc moins sûre que celle du mois en cours, où presque tout le chiffre est
            déjà identifiable.
          </li>
          <li>
            <span className="font-medium text-ink-soft">
              {LABEL.confidence} {m1.confidence}
            </span>{" "}
            : la projection réagit au pipe actuel, mais l&apos;historique de validation reste encore
            court — trois mois seulement. Elle ne verrait pas venir un mois exceptionnellement
            creux, comme un mois d&apos;août.
          </li>
          {suggestions.count > 0 ? (
            <li>
              {suggestions.count} affaire(s) ont une chance réelle de signer sans être prévues par
              leur commercial, pour {kEur(suggestions.gmv)} au total. Elles apparaissent surlignées
              dans Forecast.
            </li>
          ) : null}
        </ul>
      </details>
    </Card>
  );
}

/**
 * Carte M+2 : aucun modèle.
 *
 * C8.1 a rejeté les deux briques M+2 — aucune approche ne bat une moyenne plate,
 * et le classement individuel fait moins bien que le hasard. On affiche donc le
 * repère historique officiel et le déclaratif, sans fourchette : une fourchette
 * supposerait une méthode calibrée, et il n'y en a pas.
 */
function ExpectedM2Card({
  m2,
  reference,
}: {
  m2: HorizonDeclarative;
  reference: HistoricalReference | null;
}) {
  return (
    <Card>
      <SectionTitle
        eyebrow="Dans deux mois"
        title={m2.label}
        aside={`${LABEL.confidence} faible`}
      />
      <div className="px-4 md:px-6 py-4">
        <p className="text-sm font-medium">Pas encore de projection suffisamment fiable</p>
        <dl className="mt-3 space-y-2.5 text-sm">
          {reference ? (
            <Line
              label={LABEL.historicalMark}
              value={kEur(reference.monthlyAverage)}
              hint={`moyenne signée sur ${reference.months} mois, de ${kEur(reference.min)} à ${kEur(reference.max)}`}
            />
          ) : null}
          <Line
            label={LABEL.kanban}
            value={kEur(m2.kanbanGmv)}
            hint={m2.kanbanCount == null ? undefined : `sur ${m2.kanbanCount} affaire(s) prévue(s)`}
          />
          <Line label={LABEL.perspective} value={kEur(m2.perspectiveGmv)} />
        </dl>
      </div>
      <details className="group border-t border-line">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs text-ink-faint hover:text-ink md:px-6 md:py-2">
          <span className="underline decoration-dotted">Pourquoi pas de projection ?</span>
          <span className="ml-1 group-open:hidden" aria-hidden>
            ▾
          </span>
          <span className="ml-1 hidden group-open:inline" aria-hidden>
            ▴
          </span>
        </summary>
        <ul className="space-y-1.5 border-t border-line px-4 md:px-6 py-2.5 text-xs text-ink-faint">
          {/*
            Ce point était au premier niveau de la carte. Il y disait la même
            chose que la puce générique qu'il remplace ici, mais en quatre
            lignes de texte technique placées avant les chiffres du mois.
          */}
          <li>
            Une grande partie du GMV {elide(m2.label.split(" ")[0])} viendra d&apos;affaires qui
            n&apos;existent pas encore aujourd&apos;hui : {m2.futureShare} du chiffre du mois,
            historiquement. Aucune donnée d&apos;aujourd&apos;hui ne les décrit, et le repère ne
            tient pas compte du pipe actuel — ce n&apos;est pas une prévision.
          </li>
          <li>
            Toutes les méthodes essayées font moins bien qu&apos;une simple moyenne historique.
            Afficher un chiffre précis donnerait une fausse impression de maîtrise.
          </li>
          <li>
            Pour la même raison, RM Morning ne suggère aucune affaire à challenger sur ce mois :
            son classement ne distingue pas mieux que le hasard.
          </li>
        </ul>
      </details>
    </Card>
  );
}

/** « de septembre » mais « d'octobre » : l'élision se fait sur la voyelle. */
function elide(month: string): string {
  return /^[aeiouâéêîôû]/i.test(month) ? `d'${month}` : `de ${month}`;
}

function Line({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 md:gap-4">
      <dt className="min-w-0 text-ink-soft">
        {label}
        {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      </dt>
      {/* « 782 k€ » passait à la ligne entre le nombre et son unité à 375 px. */}
      <dd
        className={`tabular shrink-0 whitespace-nowrap text-right ${strong ? "text-xl font-semibold" : "font-medium"}`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Fraîcheur des données. Un écran de prévision qui ne dit pas de quand datent
 * ses données laisse croire qu'il est temps réel ; au-delà de vingt-quatre
 * heures l'avertissement passe en orange.
 */
export function ExpectedGmvFreshness({ snap }: { snap: ExpectedGmvSnapshot }) {
  // Deux sources structurantes, deux fraîcheurs. L'import porte l'étape et le
  // GMV ; l'extraction des transitions porte le temps passé dans l'étape. Un
  // scoring dont l'une des deux est périmée ne doit pas se présenter comme à
  // jour, même si l'autre est fraîche.
  const dataStale = snap.dataAgeHours != null && snap.dataAgeHours > 24;
  const historyStale = snap.historyAgeHours != null && snap.historyAgeHours > 24;
  const stale = dataStale || historyStale || snap.supersededByImport;
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
  const age = (h: number | null) =>
    h == null ? "" : h < 24 ? `${h.toFixed(1)} h` : `${Math.floor(h / 24)} j`;

  // Deux niveaux. Au premier, les trois horodatages : c'est ce qu'on vient
  // vérifier. Au second, ce que la vétusté change concrètement — des phrases
  // entières, qui occupaient six lignes en tête d'écran sur 375 px et faisaient
  // passer le diagnostic technique avant la prévision elle-même. Rien n'est
  // retiré : le repli est signalé et le compte des remarques est visible.
  const notes: string[] = [];
  if (snap.supersededByImport)
    notes.push(
      `Un import Salesforce plus récent (${fmt(snap.currentImportAt)}) a été chargé depuis ce scoring : relancer le scoring pour que cette prévision décrive l'état actuel.`,
    );
  if (dataStale && historyStale)
    notes.push("Les deux sources ont plus de 24 h : cette prévision n'est pas à jour.");
  else if (dataStale)
    notes.push("L'état Salesforce a plus de 24 h : cette prévision n'est pas à jour.");
  else if (historyStale)
    notes.push(
      "L'historique des étapes a plus de 24 h : le temps passé dans l'étape est approximatif.",
    );
  if (snap.stageFromImport > 0)
    notes.push(`${snap.stageFromImport} affaire(s) sans date d'entrée dans l'étape.`);
  if (snap.standby.count > 0)
    notes.push(
      `${snap.standby.count} stand-by (${kEur(snap.standby.gmv)}), dont ${snap.standby.frozenMonthEnd} gelé(s) au-delà du mois et donc comptés à zéro.`,
    );

  return (
    <div
      className={`rounded-lg border px-4 py-2.5 text-xs ${
        stale ? "border-warning-soft bg-warning-soft text-warning" : "border-line bg-surface text-ink-soft"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
      <span>
        État des données : <span className="tabular font-medium">{fmt(snap.dataAsOf)}</span>
        {snap.dataAgeHours != null ? (
          <span className={dataStale ? " font-medium" : " text-ink-faint"}> ({age(snap.dataAgeHours)})</span>
        ) : null}
      </span>
      <span>
        Historique des étapes : <span className="tabular font-medium">{fmt(snap.historyAsOf)}</span>
        {snap.historyAgeHours != null ? (
          <span className={historyStale ? " font-medium" : " text-ink-faint"}>
            {" "}
            ({age(snap.historyAgeHours)})
          </span>
        ) : null}
      </span>
      <span>
        Expected scoré : <span className="tabular font-medium">{fmt(snap.scoredAt)}</span>
      </span>
      </div>
      {notes.length > 0 ? (
        <details className="mt-1">
          <summary className="inline-flex min-h-9 cursor-pointer list-none items-center underline decoration-dotted underline-offset-2 md:min-h-0">
            {notes.length === 1 ? "1 remarque sur ces données" : `${notes.length} remarques sur ces données`}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function ExpectedGmvLimits({ outOfScopeShare }: { outOfScopeShare: number }) {
  return (
    <Card>
      <SectionTitle eyebrow="Honnêteté" title="À savoir" />
      <ul className="space-y-2 px-4 md:px-6 py-4 text-sm text-ink-soft">
        <li>
          Environ <span className="font-medium text-ink">{pct(outOfScopeShare, 0)}</span> du GMV final
          d&apos;un mois vient d&apos;affaires créées après la date du forecast. Aucune prévision ne
          peut les anticiper.
        </li>
        <li>
          La Projection Kanban et la Perspective ne sont pas utilisées comme variables : leur
          historique est trop court pour être appris.
        </li>
        <li>Les signaux Gmail ne sont pas utilisés par les modèles.</li>
        <li>
          Les très grosses affaires sont rares dans l&apos;historique. Au-delà de 200 k€, les
          probabilités reposent sur peu de cas.
        </li>
      </ul>
    </Card>
  );
}

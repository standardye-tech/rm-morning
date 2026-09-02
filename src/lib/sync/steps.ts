/**
 * Les étapes de l'actualisation globale, dans leur ordre de dépendance.
 *
 * ORDRE, et pourquoi il n'est pas négociable :
 *
 *   1. les opportunités d'abord — tout le reste en dépend : Forecast, Monitoring,
 *      l'Expected du mois, l'historique d'étapes, la Projection Kanban ;
 *   2. les Travaux avant toute lecture du Signé officiel ;
 *   3. l'Expected du mois APRÈS les opportunités, sinon il scorerait un pipe que
 *      la base n'a plus — c'est exactement l'incohérence que le garde-fou
 *      « scoring périmé » signalait, et que cette orchestration supprime ;
 *   4. la projection M+1 après les opportunités ET les Travaux : elle a besoin du
 *      pipe du jour et de la vérité GMV des douze derniers mois ;
 *   5. l'historisation des suggestions après le calcul M+1, jamais avant.
 *
 * POLITIQUE BLOQUANT / NON BLOQUANT, décidée explicitement :
 *
 *   BLOQUANTES — opportunités, Travaux, Expected du mois, projection M+1,
 *   historisation des suggestions, finalisation. Sans elles, un chiffre affiché
 *   serait faux ou périmé sans le dire. Leur échec interdit le statut « terminée ».
 *
 *   NON BLOQUANTES — pistes, Perspective, emails, journal des signatures. Leur
 *   échec rend une PARTIE de l'application moins fraîche, mais ne rend aucun
 *   chiffre faux :
 *     — les pistes n'alimentent que Monitoring Pistes ;
 *     — la Perspective est un déclaratif : son bloc « EN COURS » est rafraîchi
 *       chaque jour, ses snapshots consolidés chaque lundi, et l'écran affiche
 *       la date réelle de ce qu'il montre. Un Sheet non mis à jour n'est pas
 *       une panne ;
 *     — les emails : le bloc Gmail du Morning vieillit, tous les montants restent
 *       justes ;
 *     — le journal des signatures ne sert qu'aux modèles futurs.
 *   Leur échec donne « terminée avec avertissement ».
 *
 * SÉCURITÉ. Salesforce, Gmail et Google Sheets restent en LECTURE SEULE. Aucune
 * étape n'écrit ailleurs que dans la base SQLite locale.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { importForecastSnapshots } from "../forecast-import";
import { addressesToResolve, refreshDirectory } from "../mail-directory";
import { rematchSignals } from "../mail-rematch";
import { importFromSource } from "../import";
import { importOpportunityMilestones } from "../opportunity-import";
import { importLeads } from "../lead-import";
import { recordM1Suggestions } from "../m1-record";
import { syncMorningEvents } from "../morning-events";
import { officialSignedGmv } from "../official-signed";
import { latestImport } from "../repository";
import { recordSignatureEvents } from "../signature-record";
import { ApiSalesforceSource } from "../sources/api-salesforce";
import { GmailSource } from "../sources/gmail";
import { SheetsApiForecastSnapshotSource } from "../sources/sheets-api-forecast";
import { importTravaux } from "../travaux-import";
import type { SyncSources } from "./store";

const execFileAsync = promisify(execFile);

export type StepOutcome = {
  /** Une phrase lisible, affichable telle quelle dans Données. */
  detail: string;
  /** Versions de données produites, fusionnées dans le run. */
  sources?: SyncSources;
  /** Anomalie non bloquante rencontrée malgré la réussite de l'étape. */
  warning?: string;
};

export type SyncStep = {
  key: string;
  label: string;
  /** Regroupement affiché pendant l'actualisation. */
  group: string;
  blocking: boolean;
  /** Délai au-delà duquel l'étape est abandonnée, pour ne jamais rester bloqué. */
  timeoutMs: number;
  run: () => Promise<StepOutcome>;
};

/**
 * Lance un script du projet dans un processus séparé.
 *
 * Les deux moteurs de prévision sont en Python et en Node, hors du serveur.
 * L'écriture concurrente sur SQLite est sûre : la base est en mode WAL, et ces
 * scripts sont les seuls à écrire dans leurs tables.
 */
async function runScript(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
  });
  return stdout;
}

/**
 * Rend une liste d'anomalies lisible dans le bandeau d'actualisation.
 *
 * « 1 ligne(s) non exploitable(s) » ne disait ni où chercher, ni s'il fallait
 * agir. Une anomalie unique est donc énoncée en entier ; au-delà, seul le
 * compte tient dans le statut, le détail restant dans le panneau de l'étape.
 *
 * Les lignes hors équipe et hors territoire n'arrivent jamais ici : elles sont
 * écartées en amont, et ne sont pas des anomalies.
 */
function describeIssues(issues: { message: string }[]): string | undefined {
  if (issues.length === 0) return undefined;
  if (issues.length === 1) return issues[0].message;
  return `${issues.length} anomalies dans le périmètre — ${issues[0].message}`;
}

const NODE_TS = [
  "--experimental-strip-types",
  "--experimental-loader",
  "./scripts/ts-resolver.mjs",
];

const MINUTE = 60_000;

export function buildSteps(): SyncStep[] {
  return [
    {
      key: "salesforce-opportunites",
      label: "Opportunités Salesforce",
      group: "Salesforce",
      blocking: true,
      timeoutMs: 10 * MINUTE,
      async run() {
        const s = await importFromSource(new ApiSalesforceSource());
        const run = latestImport();
        return {
          detail:
            `${s.totalRows} opportunité(s) lues, ${s.teamRows} dans l'équipe · ` +
            `${s.activeRows} active(s), ${s.signedRows} signée(s), ${s.standbyRows} en stand-by` +
            // Les sorties de périmètre sont dites ici, et pas seulement dans les
            // remarques : une affaire qui quitte le pipe est un mouvement de
            // pilotage, pas un détail technique d'import.
            (s.departedRows > 0 ? ` · ${s.departedRows} sortie(s) du périmètre` : "") +
            (s.returnedRows > 0 ? ` · ${s.returnedRows} revenue(s)` : "") +
            // Exclusion territoriale : dite, mais jamais comptée comme anomalie.
            (s.outOfTerritoryRows > 0
              ? ` · ${s.outOfTerritoryRows} hors territoire (autre DR)`
              : ""),
          sources: {
            opportunityImportId: s.importId,
            opportunityImportedAt: run?.importedAt ?? null,
          },
          // Comme pour Perspective : une remarque unique est énoncée, plutôt
          // que comptée. « 1 remarque(s) à l'import » n'indiquait ni quoi
          // regarder, ni s'il fallait agir.
          warning: describeIssues(s.issues),
        };
      },
    },
    {
      // Les jalons COMPLÈTENT les opportunités importées à l'étape précédente :
      // ils ne les créent pas. Ils doivent donc suivre immédiatement, et jamais
      // précéder. Ils lisent l'activité Salesforce — événements et tâches — en
      // lecture seule, et n'écrivent que les colonnes de jalon.
      key: "jalons-opportunites",
      label: "Jalons des opportunités",
      group: "Salesforce",
      // NON BLOQUANTE, et c'est un choix explicite. Un échec ici rend les
      // anomalies de Monitoring Opportunités périmées, mais ne rend faux aucun
      // chiffre de Forecast, d'Expected ou du Signé officiel. Le statut global
      // devient « actualisation partielle » avec le motif nommé, plutôt qu'un
      // échec qui laisserait croire que le pilotage est compromis.
      blocking: false,
      timeoutMs: 15 * MINUTE,
      async run() {
        const s = await importOpportunityMilestones();
        return {
          detail:
            `${s.opportunities} opportunité(s) analysée(s) · ${s.newExceptions} nouvelle(s) exception(s)` +
            ` · ${s.legacyBacklog} en dette héritée`,
          sources: { milestonesComputedAt: new Date().toISOString() },
          warning:
            s.degraded.length > 0
              ? `couverture des libellés dégradée : ${s.degraded.join(", ")}`
              : undefined,
        };
      },
    },
    {
      key: "salesforce-pistes",
      label: "Pistes Salesforce",
      group: "Salesforce",
      blocking: false,
      timeoutMs: 10 * MINUTE,
      async run() {
        const s = await importLeads();
        return {
          detail:
            `${s.totalLeads} piste(s) dans l'équipe · ${s.newExceptions} nouvelle(s) exception(s)` +
            ` · snapshot ${s.snapshotDate}`,
          sources: { leadImportedAt: new Date().toISOString() },
        };
      },
    },
    {
      key: "travaux",
      label: "Travaux",
      group: "Travaux",
      blocking: true,
      timeoutMs: 10 * MINUTE,
      async run() {
        const s = await importTravaux();
        // Contrôle léger, exigé après l'import : la table est-elle lisible et le
        // montant officiel calculable ? La réconciliation SOQL complète reste une
        // opération de maintenance, trop coûteuse pour chaque actualisation.
        const month = new Date().toISOString().slice(0, 7);
        const official = officialSignedGmv(month);
        return {
          detail:
            `${s.extracted} ligne(s) lues, ${s.total} en base (${s.added} nouvelle(s)) · ` +
            `Signé officiel du mois ${Math.round(official.gmv / 1000)} k€ sur ${official.lines} ligne(s)`,
          sources: {
            travauxImportedAt: s.importedAt,
            officialSignedMonth: month,
            officialSignedGmv: official.gmv,
          },
        };
      },
    },
    {
      key: "perspective",
      label: "Perspective",
      group: "Perspective",
      blocking: false,
      timeoutMs: 5 * MINUTE,
      async run() {
        const s = await importForecastSnapshots(new SheetsApiForecastSnapshotSource());
        // Le Sheet peut légitimement n'avoir pas bougé : sa cadence est
        // hebdomadaire. On publie la date réellement lue, sans la commenter.
        const latest = s.snapshotDates.slice().sort().pop() ?? null;
        // Deux natures de donnée, dites séparément : l'historique figé, et
        // l'état courant du classeur, qui est la donnée réellement fraîche.
        const current = s.currentUpdatedAt
          ? `état courant du ${s.currentUpdatedAt.replace("T", " à ")} · ${s.currentLines} ligne(s)`
          : "aucun état courant";
        return {
          detail:
            `${current} · snapshot ${latest ?? "—"} · ` +
            `${s.teamLines} ligne(s) d'équipe sur ${s.totalLines} lues` +
            ` · ${s.months.length} mois` +
            // Les exclusions de périmètre sont DITES, mais dans le détail, pas
            // dans l'avertissement : ce sont des lignes qui ne nous concernent
            // pas, et non des anomalies à traiter.
            ` · ${s.ignoredLines} hors équipe` +
            (s.outOfTerritoryLines > 0 ? `, ${s.outOfTerritoryLines} hors territoire` : "") +
            " (exclues)",
          sources: {
            perspectiveSnapshotDate: latest,
            perspectiveCurrentUpdatedAt: s.currentUpdatedAt,
          },
          // Un avertissement nomme désormais ce qu'il faut aller regarder. Une
          // anomalie unique est décrite en toutes lettres ; au-delà, le nombre
          // suffit au statut compact et le détail vit dans le panneau.
          warning: describeIssues(s.issues),
        };
      },
    },
    {
      key: "emails",
      label: "Emails",
      group: "Emails",
      blocking: false,
      timeoutMs: 10 * MINUTE,
      async run() {
        // TROIS temps, et l'ordre compte.
        //
        // 1. L'annuaire est rafraîchi AVANT la lecture des messages, pour que les
        //    adresses vues au passage précédent soient déjà résolues quand le
        //    rattachement s'exécute. Une adresse apparue aujourd'hui sera résolue
        //    à la prochaine actualisation : c'est volontaire, cela évite une
        //    requête Salesforce par message entrant.
        const pending = addressesToResolve();
        const dir = await refreshDirectory(pending);

        // 2. Lecture, classification et rattachement.
        const report = await new GmailSource().sync();

        // 3. Les nouvelles adresses de ce passage, résolues tout de suite : sans
        //    cela, un client identifiable resterait « affaire non identifiée »
        //    pendant une journée entière.
        const fresh = addressesToResolve();
        const dir2 = fresh.length > 0 ? await refreshDirectory(fresh) : { resolved: 0, byKind: {} };
        if (fresh.length > 0) rematchSignals();

        // 4. Les alertes Morning sont recalculées depuis les signaux. Idempotent :
        //    le statut « Pris en compte » et sa date ne sont jamais réécrits.
        const events = syncMorningEvents();
        const resolved = dir.resolved + dir2.resolved;
        return {
          detail:
            `${report.inserted} nouveau(x) message(s) sur ${report.seen} vus · ` +
            `${report.classified} fil(s) classé(s) · ${resolved} adresse(s) résolue(s) · ` +
            `${events.created} nouvel(le)(s) alerte(s) Morning`,
          sources: {
            gmailCursorAt: report.windowEnd,
            gmailLastMessageAt: report.windowEnd,
          },
          warning:
            report.errors.length > 0
              ? `${report.errors.length} message(s) illisible(s) ignoré(s)`
              : undefined,
        };
      },
    },
    {
      key: "historisation",
      label: "Historisation durable",
      group: "Finalisation",
      blocking: false,
      timeoutMs: 5 * MINUTE,
      async run() {
        const s = recordSignatureEvents();
        return {
          detail:
            `${s.total} signature(s) au journal (${s.added} nouvelle(s)) · ` +
            `${s.months} mois couverts · ${s.withCreatedAt} avec date de création`,
        };
      },
    },
    {
      key: "expected-m",
      label: "Prévision du mois",
      group: "Prévisions",
      blocking: true,
      timeoutMs: 15 * MINUTE,
      async run() {
        // Deux temps, et dans cet ordre : construire l'observation « aujourd'hui »
        // depuis l'état fraîchement importé, puis la scorer. Aucun modèle n'est
        // réentraîné, aucun dataset reconstruit.
        await runScript(process.execPath, [...NODE_TS, "scripts/build-expected-today.mjs"], 5 * MINUTE);
        await runScript("python", ["scripts/expected_gmv_score.py", "--phase", "score"], 10 * MINUTE);
        const { buildExpectedGmvSnapshot } = await import("../expected-gmv-live");
        const snap = buildExpectedGmvSnapshot();
        if (snap == null) throw new Error("Aucun scoring produit.");
        return {
          detail:
            `${snap.region.count} affaire(s) scorée(s) · prévision de fin de mois ` +
            `${Math.round(snap.region.expectedFinish / 1000)} k€`,
          sources: { expectedScoredAt: snap.scoredAt, expectedSourceImportAt: snap.dataAsOf },
          warning: snap.supersededByImport
            ? "La prévision du mois décrit un état antérieur au dernier import."
            : undefined,
        };
      },
    },
    {
      key: "projection-m1",
      label: "Projection du mois prochain",
      group: "Prévisions",
      blocking: true,
      timeoutMs: 15 * MINUTE,
      async run() {
        await runScript("python", ["scripts/publish_m1.py"], 15 * MINUTE);
        const { buildExpectedM1 } = await import("../expected-m1");
        const m1 = buildExpectedM1();
        if (m1 == null) throw new Error("Aucune projection M+1 produite.");
        return {
          detail:
            `${m1.targetMonthLabel} · projection ${Math.round(m1.projection / 1000)} k€ ` +
            `(${Math.round(m1.rangeLo / 1000)}–${Math.round(m1.rangeHi / 1000)} k€) · ` +
            `force du pipe ${m1.strength.toFixed(2)} · confiance ${m1.confidence}`,
          sources: { m1GeneratedAt: m1.generatedAt },
          warning: m1.strengthInRange
            ? undefined
            : "La force du pipe sort de la plage calibrée : projection extrapolée.",
        };
      },
    },
    {
      key: "suggestions-m1",
      label: "Affaires à challenger",
      group: "Prévisions",
      blocking: true,
      timeoutMs: 5 * MINUTE,
      async run() {
        const s = recordM1Suggestions();
        if (s == null) throw new Error("Aucune projection M+1 à historiser.");
        const outcomes = s.outcomes
          .map((o) => `${o.month} : ${o.signed}/${o.rows} signée(s)`)
          .join(" · ");
        return {
          detail:
            `${s.yellow} affaire(s) à challenger sur ${s.candidates} au-dessus du seuil · ` +
            `${s.total} ligne(s) historisées${outcomes ? ` · issues relevées — ${outcomes}` : ""}`,
        };
      },
    },
    {
      // Le classement Performance se recalcule ENTIÈREMENT à partir des sources
      // qui viennent d'être rafraîchies : Travaux, opportunités, jalons, pistes,
      // Expected du mois et projection M+1. Il n'a donc aucune source propre, et
      // sa place est ici — après la dernière d'entre elles, avant la
      // finalisation qui contrôle la cohérence de l'ensemble.
      //
      // Sans cette étape, la photo quotidienne du classement n'était écrite qu'à
      // l'ouverture de l'écran : un jour sans consultation laissait un trou dans
      // l'historique, et donc une tendance calculée sur une comparaison plus
      // ancienne que prévu. C'est l'actualisation qui doit produire la photo.
      //
      // NON BLOQUANTE, et c'est un choix. Un échec ici ne rend aucun chiffre
      // faux : Performance se recalcule de toute façon à l'affichage. Il prive
      // seulement l'historique d'une photo, ce que le statut « terminée avec
      // avertissement » dit exactement.
      key: "performance",
      label: "Classement Performance",
      group: "Finalisation",
      blocking: false,
      timeoutMs: 5 * MINUTE,
      async run() {
        const [{ buildPerformanceBoard }, { recordPerformanceSnapshot, previousSnapshotDate, ranksAt }] =
          await Promise.all([import("../performance"), import("../performance-store")]);

        const now = new Date();
        // Les rangs de la photo précédente sont lus AVANT d'écrire celle du jour,
        // et seulement parmi les photos du même modèle de calcul.
        const previousDate = previousSnapshotDate(now.toISOString().slice(0, 10));
        const board = buildPerformanceBoard(
          now,
          previousDate ? ranksAt(previousDate) : new Map<string, number>(),
          previousDate,
        );
        const written = recordPerformanceSnapshot(board.salespeople, now);
        const up = board.movers.up.length;
        const down = board.movers.down.length;
        return {
          detail:
            `${board.salespeople.length} commerciaux classés · modèle ${board.modelVersion} · ` +
            `photo du ${written.snapshotDate}` +
            (up + down > 0 ? ` · ${up} en progression, ${down} en recul` : " · aucun mouvement marqué"),
          sources: {
            performanceComputedAt: board.computedAt,
            performanceModelVersion: board.modelVersion,
          },
        };
      },
    },
    {
      key: "finalisation",
      label: "Finalisation",
      group: "Finalisation",
      blocking: true,
      timeoutMs: 5 * MINUTE,
      async run() {
        // Le contrôle central : la prévision porte-t-elle bien sur l'état importé
        // à l'instant ? Sans lui, l'orchestration pourrait « réussir » en laissant
        // exactement l'incohérence qu'elle est censée supprimer.
        const [{ buildExpectedGmvSnapshot }, { buildExpectedM1 }, { buildForecastV2 }] =
          await Promise.all([
            import("../expected-gmv-live"),
            import("../expected-m1"),
            import("../forecast-v2"),
          ]);
        const snap = buildExpectedGmvSnapshot();
        const m1 = buildExpectedM1();
        const problems: string[] = [];
        if (snap == null) problems.push("prévision du mois absente");
        else if (snap.supersededByImport) problems.push("prévision du mois antérieure au dernier import");
        if (m1 == null) problems.push("projection du mois prochain absente");
        else if (m1.supersededByImport)
          problems.push("projection du mois prochain antérieure au dernier import");
        if (problems.length > 0) throw new Error(problems.join(" ; "));

        // Les vues sont dérivées : on vérifie qu'elles se construisent sur le
        // nouvel état, sans aucun import qui leur soit propre.
        const boards = [0, 1, 2].map((h) => buildForecastV2(h));
        const [m, mp1, mp2] = boards;
        if (mp2.examine.length > 0) {
          throw new Error("Des affaires à challenger sont apparues sur M+2, ce qui est interdit.");
        }
        return {
          detail:
            `vues reconstruites · Signé ${Math.round(m.region.signedGmvActual / 1000)} k€ · ` +
            `Kanban M ${Math.round(m.region.kanbanGmv / 1000)} k€ · ` +
            `Kanban M+1 ${Math.round(mp1.region.kanbanGmv / 1000)} k€ · ` +
            `Kanban M+2 ${Math.round(mp2.region.kanbanGmv / 1000)} k€ · ` +
            `${mp1.examine.length} affaire(s) à challenger le mois prochain`,
        };
      },
    },
  ];
}

/** Chemin du projet, utile aux tests qui vérifient l'absence d'écriture externe. */
export const PROJECT_ROOT = path.resolve(process.cwd());

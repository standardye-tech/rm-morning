"use client";

import { useState, useTransition } from "react";

import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui";
import {
  ASK_LABEL,
  planAsk,
  received,
  type MorningAction,
  type MorningEvent,
} from "@/lib/morning-types";
import { SalesforceOpportunityLink } from "@/components/salesforce-link";
import { kEur } from "@/lib/vocabulary";

/**
 * Composants Morning V2.
 *
 * Client components parce qu'ils portent un seul geste : « Pris en compte ».
 * Ce geste acquitte un MESSAGE, pas un client : le prochain message du même
 * client reviendra. Rien n'est écrit dans Gmail.
 *
 * Les trois blocs partagent UN état (`MorningBoard`) : un message acquitté dans
 * « Clients chauds » ou « Clients qui attendent » disparaît aussitôt du plan du
 * jour s'il y figurait pour la même raison, et une action cochée dans le plan
 * marque son message « traité » dans le bloc du dessus. Avant, chaque bloc
 * gardait son propre état et la même affaire restait affichée deux fois.
 *
 * Vocabulaire : aucune ligne ne suppose de connaître Salesforce, les
 * statistiques, ni un nom de variable. Le score de priorité existe mais ne
 * s'affiche jamais — l'utilisateur lit une raison, pas une formule.
 */

const VISIBLE = 8;

type Category = "chaud" | "attente";

/** L'état partagé des trois blocs, et les gestes qui le font évoluer. */
type Board = {
  /** Messages pris en compte, quel que soit le bloc où le geste a été fait. */
  acknowledged: Set<string>;
  /** Messages acquittés DEPUIS les blocs 1 et 2 : ceux-là quittent le plan du jour. */
  handledAbove: Set<string>;
  /** Actions du plan cochées « Done ». */
  doneActions: Set<string>;
  acknowledge: (messageId: string) => void;
  acknowledgeAll: (category: Category | null) => void;
  complete: (actionKey: string, messageId: string | null) => void;
  completeAll: (targets: { key: string; messageId: string | null }[]) => void;
  busy: boolean;
};

async function post(body: object) {
  await fetch("/api/morning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function AckButton({
  messageId,
  done,
  onClick,
}: {
  messageId: string;
  done: boolean;
  onClick: (id: string) => void;
}) {
  if (done) {
    return <span className="text-xs text-positive">✓ traité</span>;
  }
  // Action SECONDAIRE : on lit l'affaire d'abord, on décide de la traiter
  // ensuite. Le bouton encadré était l'élément le plus lourd de la ligne ; il
  // devient un lien discret qui se révèle au survol de la ligne.
  return (
    <button
      type="button"
      onClick={() => onClick(messageId)}
      className="h-9 rounded border border-line px-3 text-xs text-ink-soft transition-opacity hover:text-ink focus-visible:opacity-100 md:h-auto md:border-0 md:px-1 md:py-0  md:text-ink-faint md:underline md:decoration-dotted md:underline-offset-2 md:opacity-0 md:group-hover/row:opacity-100"
    >
      Pris en compte
    </button>
  );
}

/**
 * « Tout traiter ».
 *
 * Annonce ce qu'il change pour l'utilisateur — le nombre de lignes encore
 * ouvertes — et disparaît à zéro. La persistance est celle des cases
 * individuelles : même statut, même colonne, et les acquittements déjà
 * enregistrés ne sont pas réécrits. Le libellé a changé (post-RC) ; le geste
 * et son appel API restent identiques.
 */
function MarkAllButton({
  count,
  busy,
  onClick,
  label = "Tout traiter",
}: {
  count: number;
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50 md:min-h-0"
    >
      {label} ({count})
    </button>
  );
}

/**
 * Le rattachement, dit en français : jamais « match level B ».
 *
 * Quatre situations bien distinctes, et c'est l'apport de C13. Identifier
 * l'interlocuteur ne signifie pas qu'il y a du chiffre à aller chercher : un
 * chantier en cours ou un projet terminé sont parfaitement identifiés et ne
 * portent aucun GMV de pipe. Les confondre ferait croire à une affaire à
 * conclure là où il n'y a qu'un suivi après-vente.
 */
function Attachment({ event }: { event: MorningEvent }) {
  if (event.attachment === "a_verifier" && event.opportunityId) {
    return (
      <span>
        <span className="text-ink-soft">{event.stage ?? "affaire liée"}</span>{" "}
        <Badge tone="warning">rattachement à vérifier</Badge>
      </span>
    );
  }
  switch (event.matchKind) {
    case "affaire_pipe":
      return <span className="text-ink-soft">{event.stage ?? "affaire liée"}</span>;
    case "affaire_hors_pipe":
      return (
        <span className="text-ink-soft">
          {event.externalStage ?? "chantier en cours"}
          <span className="ml-1.5 text-xs text-ink-faint">déjà signée</span>
        </span>
      );
    case "affaire_fermee":
      return (
        <span className="text-ink-soft">
          {event.externalStage ?? "affaire close"}
          <span className="ml-1.5 text-xs text-ink-faint">projet terminé</span>
        </span>
      );
    case "piste":
      return (
        <span className="text-ink-soft">
          Piste
          {event.leadStatus ? (
            <span className="ml-1.5 text-xs text-ink-faint">{event.leadStatus.toLowerCase()}</span>
          ) : null}
        </span>
      );
    case "contact":
      return <span className="text-ink-soft">Client connu, sans affaire en cours</span>;
    case "ambigu":
      return <Badge tone="warning">Rattachement à vérifier</Badge>;
    default:
      return <span className="text-ink-faint">Affaire non identifiée</span>;
  }
}

/**
 * La preuve d'intérêt, telle qu'on la lit.
 *
 * La phrase citée d'abord — c'est elle qui rend la ligne reconnaissable —,
 * puis, dans le bloc « attend une réponse », ce qu'il attend entre parenthèses
 * (« attend : confirmation planning »). Quand le message a été relu sans rien
 * de probant, la ligne le dit en clair plutôt que de montrer une phrase
 * générique. La parenthèse disparaît quand elle répéterait la phrase.
 */
function Said({ event, withExpectation }: { event: MorningEvent; withExpectation: boolean }) {
  const showExpectation = withExpectation && event.expects && event.said !== event.reason;
  return (
    <>
      <span className={event.quote ? "text-ink" : "text-ink-soft"}>{event.said}</span>
      {showExpectation ? <span className="text-ink-faint"> ({event.expects})</span> : null}
    </>
  );
}

const saidTitle = (event: MorningEvent) =>
  event.said === event.reason ? event.said : `${event.said} — ${event.reason}`;

/**
 * Une action, telle qu'on la lit au pouce.
 *
 * Sous `md` la grille à sept colonnes ne tient pas : la ramener de force dans
 * 375 px produisait une feuille de calcul illisible, avec des noms de clients
 * tronqués à trois lettres. On garde exactement les mêmes informations, mais
 * empilées en trois lignes — identité et montant, ce que dit le client, puis le
 * contexte. Aucune donnée n'est retirée, aucun calcul n'est refait.
 */
function MobileEventRow({
  event,
  when,
  done,
  onAck,
  withExpectation,
}: {
  event: MorningEvent;
  when: string;
  done: boolean;
  onAck: (id: string) => void;
  withExpectation: boolean;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
          <SalesforceOpportunityLink opportunityId={event.opportunityId}>
            {event.client ?? "Client non identifié"}
          </SalesforceOpportunityLink>
        </span>
        <span className="tabular shrink-0 text-[15px] font-medium">{kEur(event.gmv)}</span>
      </div>
      {/*
        Deux lignes avant l'ellipse. Le survol n'existe pas au doigt : se
        reposer sur `title` aurait rendu la raison inaccessible sur mobile.
      */}
      <p className="mt-1 line-clamp-2 text-sm leading-snug text-ink">
        <Said event={event} withExpectation={withExpectation} />
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-ink-soft">
          {event.salesperson ?? "—"} · <Attachment event={event} /> · {when}
        </p>
        <span className="shrink-0">
          <AckButton messageId={event.messageId} done={done} onClick={onAck} />
        </span>
      </div>
    </li>
  );
}

function EventTable({
  events,
  columns,
  board,
  withExpectation,
}: {
  events: MorningEvent[];
  columns: { what: string; when: string };
  board: Board;
  withExpectation: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? events : events.slice(0, VISIBLE);
  const done = board.acknowledged;

  return (
    <>
      <ul className="divide-y divide-line md:hidden">
        {shown.map((e) => (
          <MobileEventRow
            key={e.messageId}
            event={e}
            when={received(e.sentAt)}
            done={done.has(e.messageId)}
            onAck={board.acknowledge}
            withExpectation={withExpectation}
          />
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[52rem] table-fixed text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="w-[15%] px-4 md:px-6 py-1.5 font-medium">Client</th>
              <th className="w-[10%] px-3 py-1.5 font-medium">Commercial</th>
              <th className="px-3 py-1.5 font-medium">{columns.what}</th>
              {/* Largeur figée : « 116 k€ » passait à la ligne, cassant la hauteur. */}
              <th className="w-[5.5rem] px-3 py-1.5 text-right font-medium">GMV</th>
              {/* Le contenu est une étape Salesforce, pas une affaire. */}
              <th className="w-[11%] px-3 py-1.5 font-medium">Étape</th>
              <th className="w-[5rem] px-3 py-1.5 font-medium">{columns.when}</th>
              <th className="w-[6.5rem] px-4 md:px-6 py-1.5 text-right font-medium">Suivi</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr
                key={e.messageId}
                className="group/row border-b border-line/70 align-middle last:border-0 hover:bg-canvas/60"
              >
                <td className="truncate px-4 md:px-6 py-1">
                  <span className="font-medium">
                    <SalesforceOpportunityLink opportunityId={e.opportunityId}>
                      {e.client ?? "Client non identifié"}
                    </SalesforceOpportunityLink>
                  </span>
                </td>
                <td className="truncate px-3 py-1 text-xs text-ink-soft">
                  {e.salesperson ?? "—"}
                </td>
                {/*
                  Une ligne, toujours. La phrase est parfois longue et la faire
                  passer sur deux lignes rendait la hauteur irrégulière, ce qui
                  casse le balayage vertical. Le texte complet reste accessible
                  au survol : rien n'est perdu, seule la mise en forme est fixe.
                */}
                <td className="truncate px-3 py-1" title={saidTitle(e)}>
                  <Said event={e} withExpectation={withExpectation} />
                </td>
                <td className="tabular whitespace-nowrap px-3 py-1 text-right font-medium">
                  {kEur(e.gmv)}
                </td>
                <td className="truncate px-3 py-1 text-xs">
                  <Attachment event={e} />
                </td>
                <td className="whitespace-nowrap px-3 py-1 text-xs text-ink-soft">
                  {received(e.sentAt)}
                </td>
                <td className="px-4 md:px-6 py-1 text-right">
                  <AckButton
                    messageId={e.messageId}
                    done={done.has(e.messageId)}
                    onClick={board.acknowledge}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.length > VISIBLE ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-line px-4 py-3 text-left text-sm text-ink-soft hover:text-ink md:px-6 md:py-2.5"
        >
          <span className="underline decoration-dotted">
            {expanded ? "Replier" : `Voir tout (${events.length})`}
          </span>
          <span className="ml-1" aria-hidden>
            {expanded ? "▴" : "▾"}
          </span>
        </button>
      ) : null}
    </>
  );
}

function remainingOf(events: MorningEvent[], board: Board): number {
  return events.filter((e) => !board.acknowledged.has(e.messageId)).length;
}

export function HotClients({ events, board }: { events: MorningEvent[]; board: Board }) {
  const remaining = remainingOf(events, board);
  return (
    <Card>
      <SectionTitle
        eyebrow="Bloc 1"
        title="Clients chauds à traiter"
        aside={
          <span className="flex items-center gap-3">
            <span>{events.length} client(s)</span>
            <MarkAllButton count={remaining} busy={board.busy} onClick={() => board.acknowledgeAll("chaud")} />
          </span>
        }
      />
      {events.length === 0 ? (
        <EmptyState>Aucun client n&apos;a manifesté l&apos;envie d&apos;avancer.</EmptyState>
      ) : (
        <EventTable
          events={events}
          columns={{ what: "Preuve d'intérêt", when: "Reçu" }}
          board={board}
          withExpectation={false}
        />
      )}
    </Card>
  );
}

export function WaitingClients({ events, board }: { events: MorningEvent[]; board: Board }) {
  const remaining = remainingOf(events, board);
  return (
    <Card>
      <SectionTitle
        eyebrow="Bloc 2"
        title="Clients qui attendent une réponse"
        aside={
          <span className="flex items-center gap-3">
            {/*
              Limite structurelle (holdout du 24/09/2026) : RM Morning ne lit que
              la boîte synchronisée. Une réponse envoyée depuis la boîte d'un
              commercial, sans copie, reste invisible — le bloc n'est donc pas
              exhaustif et ne doit pas le laisser croire.
            */}
            <span title="Détection limitée à la boîte synchronisée : une réponse envoyée depuis la boîte d'un commercial, sans copie, n'est pas visible.">
              {events.length} client(s)
            </span>
            <MarkAllButton count={remaining} busy={board.busy} onClick={() => board.acknowledgeAll("attente")} />
          </span>
        }
      />
      {events.length === 0 ? (
        <EmptyState>
          Aucune attente détectée dans la boîte synchronisée. Les réponses envoyées depuis la boîte d&apos;un
          commercial sans copie ne sont pas visibles.
        </EmptyState>
      ) : (
        <EventTable
          events={events}
          columns={{ what: "Preuve d'intérêt", when: "Depuis" }}
          board={board}
          withExpectation
        />
      )}
    </Card>
  );
}

// --- Plan du jour -----------------------------------------------------------

const REASON_TONE: Record<string, "neutral" | "positive" | "warning" | "danger"> = {
  securiser: "warning",
  basculer: "positive",
  bloque: "danger",
  upside: "neutral",
  divergence: "warning",
};

/**
 * La case « Done » du plan du jour.
 *
 * Une vraie case à cocher, et non un lien : c'est le geste que le directeur
 * régional répète le plus, et il doit être visible sans survol — la liste se
 * lit et se coche de haut en bas. Une fois cochée, la ligne s'efface visuellement
 * puis disparaît au prochain affichage du Morning.
 */
function DoneCheckbox({
  actionKey,
  messageId,
  done,
  onDone,
}: {
  actionKey: string;
  messageId: string | null;
  done: boolean;
  onDone: (key: string, messageId: string | null) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer select-none items-center gap-2 text-xs ${
        done ? "text-positive" : "text-ink-faint hover:text-ink"
      }`}
    >
      <input
        type="checkbox"
        checked={done}
        disabled={done}
        onChange={() => onDone(actionKey, messageId)}
        aria-label="Marquer cette situation comme traitée"
        className="h-4 w-4 cursor-pointer rounded border-line accent-[var(--color-positive)]"
      />
      {done ? "✓ traité" : "Traité"}
    </label>
  );
}

export function TodayPlan({
  actions,
  doneToday = 0,
  board,
}: {
  actions: MorningAction[];
  /** Situations déjà traitées aujourd'hui. Comptées, jamais listées. */
  doneToday?: number;
  board: Board;
}) {
  const done = board.doneActions;

  // Le Plan est court par construction (7 affaires au plus, voir `MORNING_PLAN`) :
  // il n'y a ni « voir tout » ni pagination. Ce qui a été coché ICI reste visible,
  // estompé : c'est le geste habituel. Une ligne = une affaire ; les messages des
  // Blocs 1 et 2 n'y sont plus recopiés.
  const visible = actions;
  const remainingActions = visible.filter((a) => !done.has(a.key));
  const remaining = remainingActions.length;
  // Pas de total GMV en en-tête : une situation « N affaires figées » embarque
  // presque tout le pipe d'un commercial, et la somme laisserait croire que des
  // millions sont actionnables aujourd'hui. Les montants restent lisibles
  // situation par situation.

  return (
    <Card className="ring-1 ring-ink/5">
      <SectionTitle
        eyebrow="Plan du jour"
        title={`${visible.length} affaire${visible.length > 1 ? "s" : ""} prioritaire${visible.length > 1 ? "s" : ""}`}
        aside={
          <span className="flex items-center gap-3">
            {doneToday > 0 ? (
              <span>{`${doneToday} traitée${doneToday > 1 ? "s" : ""} aujourd'hui`}</span>
            ) : null}
            <MarkAllButton
              count={remaining}
              busy={board.busy}
              onClick={() => board.completeAll(remainingActions.map((a) => ({ key: a.key, messageId: a.messageId })))}
              label="Tout traiter"
            />
          </span>
        }
      />
      {visible.length === 0 ? (
        <EmptyState>
          {doneToday > 0
            ? `Plan du jour terminé — ${doneToday} affaire(s) traitée(s) aujourd'hui.`
            : "Aucune affaire ne peut modifier fortement le mois ce matin."}
        </EmptyState>
      ) : (
        <>
          {remaining === 0 ? (
            <p className="border-b border-line bg-positive-soft px-4 py-2.5 text-sm text-positive md:px-6">
              Tout est traité. Les situations traitées disparaîtront au prochain affichage.
            </p>
          ) : null}
          <ol className="divide-y divide-line">
            {visible.map((a, i) => (
              <li
                key={a.key}
                className={`flex gap-3 px-4 py-3.5 md:gap-4 md:px-6 ${
                  done.has(a.key) ? "opacity-45" : ""
                }`}
              >
                <span className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-canvas text-xs font-semibold text-ink-soft">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">
                      {a.ownerFirstName ?? "Commercial à identifier"} —{" "}
                      <SalesforceOpportunityLink opportunityId={a.opportunityId}>{a.client}</SalesforceOpportunityLink>
                    </span>
                    <Badge tone={REASON_TONE[a.reason] ?? "neutral"}>{ASK_LABEL[a.reason]}</Badge>
                  </div>
                  {/*
                    L'action manager d'abord, quand le badge ne suffit pas ; puis
                    la justification, qui ne dit que ce qui a compté au score :
                    GMV, étape, signal, mouvement. Le signal reste du contexte.
                  */}
                  {planAsk(a) ? <p className="mt-1 text-sm text-ink">{planAsk(a)}</p> : null}
                  <p className="mt-1 text-xs text-ink-soft">{a.detail}</p>
                </div>
                {/*
                  « Traité » veut dire : Sami a vu et arbitré cette situation
                  aujourd'hui. Cela ne crée aucune relance : demain, le Plan repart
                  de l'état courant et la situation revient si elle persiste.
                */}
                <div className="shrink-0 self-center">
                  <DoneCheckbox
                    actionKey={a.key}
                    messageId={a.messageId}
                    done={done.has(a.key)}
                    onDone={board.complete}
                  />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}

// --- Les trois blocs, un seul état ----------------------------------------------

/**
 * Tient l'état commun des blocs 1, 2 et 3 et porte le bouton global « Tout
 * marquer comme lu ». La persistance ne change pas : chaque geste écrit ce
 * qu'écrivaient déjà les cases individuelles, et l'affichage local anticipe le
 * résultat comme avant.
 */
export function MorningBoard({
  hot,
  waiting,
  actions,
  doneToday = 0,
}: {
  hot: MorningEvent[];
  waiting: MorningEvent[];
  actions: MorningAction[];
  doneToday?: number;
}) {
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [handledAbove, setHandledAbove] = useState<Set<string>>(new Set());
  const [doneActions, setDoneActions] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const add = (set: Set<string>, ids: string[]) => {
    const next = new Set(set);
    for (const id of ids) next.add(id);
    return next;
  };

  const acknowledge = (messageId: string) => {
    setAcknowledged((s) => add(s, [messageId]));
    setHandledAbove((s) => add(s, [messageId]));
    start(async () => {
      await post({ action: "pris_en_compte", messageId });
    });
  };

  const acknowledgeAll = (category: "chaud" | "attente" | null) => {
    const events = category === "chaud" ? hot : category === "attente" ? waiting : [...hot, ...waiting];
    const ids = events.map((e) => e.messageId);
    setAcknowledged((s) => add(s, ids));
    setHandledAbove((s) => add(s, ids));
    start(async () => {
      // Seuls les messages affichés sont traités, un par un.
      await post({ action: "tout_pris_en_compte", category, messageIds: ids });
    });
  };

  const complete = (actionKey: string, messageId: string | null) => {
    setDoneActions((s) => add(s, [actionKey]));
    // Cocher dans le plan acquitte aussi le message : le bloc du dessus le
    // montre « traité », exactement comme le fait déjà la route côté serveur.
    if (messageId) setAcknowledged((s) => add(s, [messageId]));
    start(async () => {
      await post({ action: "action_faite", actionKey, messageId });
    });
  };

  const completeAll = (targets: { key: string; messageId: string | null }[]) => {
    setDoneActions((s) => add(s, targets.map((t) => t.key)));
    const messageIds = targets.filter((t) => t.messageId).map((t) => t.messageId!);
    if (messageIds.length > 0) setAcknowledged((s) => add(s, messageIds));
    start(async () => {
      // La liste est RECALCULÉE côté serveur (voir la route), puis restreinte
      // aux clés ci-dessous : « Tout traiter » ne traite que ce qui est affiché
      // à l'écran, jamais une situation qu'aucun œil n'a vue.
      await post({ action: "tout_faire", keys: targets.map((t) => t.key) });
    });
  };

  const board: Board = {
    acknowledged,
    handledAbove,
    doneActions,
    acknowledge,
    acknowledgeAll,
    complete,
    completeAll,
    busy: pending,
  };
  const remainingAll = remainingOf(hot, board) + remainingOf(waiting, board);

  return (
    <div className="space-y-6">
      {remainingAll > 0 ? (
        <div className="flex items-center justify-end gap-3 text-xs text-ink-faint">
          <span>
            {remainingAll} message(s) à traiter dans les blocs 1 et 2
          </span>
          <MarkAllButton count={remainingAll} busy={pending} onClick={() => acknowledgeAll(null)} />
        </div>
      ) : null}
      <HotClients events={hot} board={board} />
      <WaitingClients events={waiting} board={board} />
      <TodayPlan actions={actions} doneToday={doneToday} board={board} />
    </div>
  );
}


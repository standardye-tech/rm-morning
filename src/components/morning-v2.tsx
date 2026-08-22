"use client";

import { useState, useTransition } from "react";

import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui";
import {
  REASON_LABEL,
  received,
  type MorningAction,
  type MorningEvent,
} from "@/lib/morning-types";
import { kEur } from "@/lib/vocabulary";

/**
 * Composants Morning V2.
 *
 * Client components parce qu'ils portent un seul geste : « Pris en compte ».
 * Ce geste acquitte un MESSAGE, pas un client : le prochain message du même
 * client reviendra. Rien n'est écrit dans Gmail.
 *
 * Vocabulaire : aucune ligne ne suppose de connaître Salesforce, les
 * statistiques, ni un nom de variable. Le score de priorité existe mais ne
 * s'affiche jamais — l'utilisateur lit une raison, pas une formule.
 */

const VISIBLE = 8;

function useAcknowledge() {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const acknowledge = (messageId: string) => {
    setDone((s) => new Set(s).add(messageId));
    start(async () => {
      await fetch("/api/morning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pris_en_compte", messageId }),
      });
    });
  };
  return { done, pending, acknowledge };
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
}: {
  event: MorningEvent;
  when: string;
  done: boolean;
  onAck: (id: string) => void;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
          {event.client ?? "Client non identifié"}
        </span>
        <span className="tabular shrink-0 text-[15px] font-medium">{kEur(event.gmv)}</span>
      </div>
      {/*
        Deux lignes avant l'ellipse. Le survol n'existe pas au doigt : se
        reposer sur `title` aurait rendu la raison inaccessible sur mobile.
      */}
      <p className="mt-1 line-clamp-2 text-sm leading-snug text-ink">{event.reason}</p>
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
}: {
  events: MorningEvent[];
  columns: { what: string; when: string };
}) {
  const { done, acknowledge } = useAcknowledge();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? events : events.slice(0, VISIBLE);
  // Un marqueur porté par toutes les lignes ne hiérarchise rien.
  const allNew = events.length > 0 && events.every((e) => e.isNew);

  return (
    <>
      <ul className="divide-y divide-line md:hidden">
        {shown.map((e) => (
          <MobileEventRow
            key={e.messageId}
            event={e}
            when={received(e.sentAt)}
            done={done.has(e.messageId)}
            onAck={acknowledge}
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
                  <span className="font-medium">{e.client ?? "Client non identifié"}</span>
                  {/*
                    Le point ne s'affiche que lorsqu'il DISTINGUE : si tous les
                    messages sont nouveaux, il n'apprend rien et disparaît. Le
                    champ métier `isNew` est inchangé, seule sa mise en forme l'est.
                  */}
                  {e.isNew && !allNew ? (
                    <span
                      className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-positive align-middle"
                      title="Nouveau depuis votre dernière lecture"
                      aria-label="nouveau"
                    />
                  ) : null}
                </td>
                <td className="truncate px-3 py-1 text-xs text-ink-soft">
                  {e.salesperson ?? "—"}
                </td>
                {/*
                  Une ligne, toujours. La raison est parfois longue et la faire
                  passer sur deux lignes rendait la hauteur irrégulière, ce qui
                  casse le balayage vertical. Le texte complet reste accessible
                  au survol : rien n'est perdu, seule la mise en forme est fixe.
                */}
                <td className="truncate px-3 py-1" title={e.reason}>
                  {e.reason}
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
                    onClick={acknowledge}
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

export function HotClients({ events }: { events: MorningEvent[] }) {
  return (
    <Card>
      <SectionTitle
        eyebrow="Bloc 1"
        title="Clients chauds depuis votre dernière lecture"
        aside={`${events.length} client(s)`}
      />
      {events.length === 0 ? (
        <EmptyState>Aucun client n&apos;a manifesté l&apos;envie d&apos;avancer depuis votre dernière lecture.</EmptyState>
      ) : (
        <EventTable events={events} columns={{ what: "Ce que dit le client", when: "Reçu" }} />
      )}
    </Card>
  );
}

export function WaitingClients({ events }: { events: MorningEvent[] }) {
  return (
    <Card>
      <SectionTitle
        eyebrow="Bloc 2"
        title="Clients qui attendent une réponse"
        aside={`${events.length} client(s)`}
      />
      {events.length === 0 ? (
        <EmptyState>Aucun client n&apos;attend de réponse de notre côté.</EmptyState>
      ) : (
        <EventTable events={events} columns={{ what: "Ce qu'il attend", when: "Depuis" }} />
      )}
    </Card>
  );
}

// --- Plan du jour -----------------------------------------------------------

const REASON_TONE: Record<string, "neutral" | "positive" | "warning" | "danger"> = {
  client_motive: "positive",
  client_attend: "warning",
  affaire_decisive: "neutral",
  a_challenger_vivante: "warning",
  proche_signature: "positive",
};

/**
 * Cocher une action du plan.
 *
 * Symétrique de `useAcknowledge`, et distinct pour une raison de fond : « Pris
 * en compte » acquitte un MESSAGE une fois pour toutes, « Done » clôt une
 * ACTION pour la journée. Le plan est reconstruit chaque matin ; une affaire
 * décisive traitée aujourd'hui doit pouvoir revenir demain si elle est toujours
 * décisive. Les deux gestes cohabitent : lorsque l'action porte un message, le
 * cocher l'acquitte aussi, exactement comme dans les blocs 1 et 2.
 */
function useActionDone() {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [, start] = useTransition();
  const complete = (actionKey: string, messageId: string | null) => {
    setDone((s) => new Set(s).add(actionKey));
    start(async () => {
      await fetch("/api/morning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "action_faite", actionKey, messageId }),
      });
    });
  };
  return { done, complete };
}

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
        aria-label="Marquer cette action comme faite"
        className="h-4 w-4 cursor-pointer rounded border-line accent-[var(--color-positive)]"
      />
      {done ? "✓ fait" : "Done"}
    </label>
  );
}

export function TodayPlan({
  actions,
  doneToday = 0,
}: {
  actions: MorningAction[];
  /** Actions déjà cochées aujourd'hui. Comptées, jamais listées. */
  doneToday?: number;
}) {
  const { done, complete } = useActionDone();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? actions : actions.slice(0, VISIBLE);
  const remaining = actions.filter((a) => !done.has(a.key)).length;

  return (
    <Card className="ring-1 ring-ink/5">
      <SectionTitle
        eyebrow="Plan du jour"
        title="À faire aujourd'hui"
        aside={
          doneToday > 0
            ? `${actions.length} action(s) · ${doneToday} faite(s) aujourd'hui`
            : `${actions.length} action(s)`
        }
      />
      {actions.length === 0 ? (
        <EmptyState>
          {doneToday > 0
            ? `Plan du jour terminé — ${doneToday} action(s) traitée(s) aujourd'hui.`
            : "Rien de prioritaire à lancer ce matin."}
        </EmptyState>
      ) : (
        <>
          {remaining === 0 ? (
            <p className="border-b border-line bg-positive-soft px-4 py-2.5 text-sm text-positive md:px-6">
              Tout est traité. Les actions cochées disparaîtront au prochain affichage.
            </p>
          ) : null}
          <ol className="divide-y divide-line">
            {shown.map((a, i) => (
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
                    <span className="font-medium">{a.client}</span>
                    <span className="text-xs text-ink-soft">{a.salesperson ?? "commercial à identifier"}</span>
                    <span className="tabular text-xs font-medium">{kEur(a.gmv)}</span>
                    <Badge tone={REASON_TONE[a.reason] ?? "neutral"}>{REASON_LABEL[a.reason]}</Badge>
                  </div>
                  <p className="mt-1 text-[15px] leading-snug">{a.todo}</p>
                  <p className="mt-0.5 text-xs text-ink-soft">{a.why}</p>
                  {a.facts.length > 0 ? (
                    <p className="mt-1 text-xs text-ink-faint">{a.facts.join(" · ")}</p>
                  ) : null}
                </div>
                {/*
                  La case est portée par TOUTES les actions, y compris celles qui
                  ne viennent d'aucun message : c'était précisément le manque —
                  une affaire décisive ou proche de la signature n'avait aucun
                  moyen d'être clôturée pour la journée.
                */}
                <div className="shrink-0 self-center">
                  <DoneCheckbox
                    actionKey={a.key}
                    messageId={a.messageId}
                    done={done.has(a.key)}
                    onDone={complete}
                  />
                </div>
              </li>
            ))}
          </ol>
          {actions.length > VISIBLE ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-full border-t border-line px-4 py-3 text-left text-sm text-ink-soft hover:text-ink md:px-6 md:py-2.5"
            >
              <span className="underline decoration-dotted">
                {expanded ? "Replier" : `Voir toutes les actions (${actions.length})`}
              </span>
              <span className="ml-1" aria-hidden>
                {expanded ? "▴" : "▾"}
              </span>
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Ce que Morning a délibérément laissé de côté.
 *
 * Rendre l'arbitrage visible : ces affaires sont statistiquement intéressantes
 * mais silencieuses. Elles restent dans Forecast et Expected GMV ; elles ne
 * monopolisent pas le haut du Morning.
 */
export function SilentButStrong({
  items,
}: {
  items: { client: string; salesperson: string; gmv: number | null; expected: number }[];
}) {
  if (items.length === 0) return null;
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-medium hover:bg-canvas md:px-6 md:py-3">
        Affaires prometteuses mais silencieuses
        <span className="ml-1 group-open:hidden" aria-hidden>
          ▸
        </span>
        <span className="ml-1 hidden group-open:inline" aria-hidden>
          ▾
        </span>
        <span className="ml-2 text-xs font-normal text-ink-faint">
          {items.length} affaire(s) écartée(s) du plan du jour, faute de signe de vie du client
        </span>
      </summary>
      <ul className="divide-y divide-line border-t border-line">
        {items.map((s) => (
          <li key={s.client} className="flex flex-wrap items-baseline gap-x-4 px-4 py-2 text-sm md:px-6">
            <span className="font-medium">{s.client}</span>
            <span className="text-xs text-ink-soft">{s.salesperson}</span>
            <span className="tabular text-xs">{kEur(s.gmv)}</span>
            <span className="tabular text-xs text-ink-faint">
              GMV probable {kEur(s.expected)}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-2.5 text-xs text-ink-faint md:px-6">
        Une affaire statistiquement forte n&apos;est pas une affaire chaude. Celles-ci restent
        visibles dans Forecast et Expected GMV.
      </p>
    </details>
  );
}

/**
 * Contrôles du scanner Morning — Blocs 1 et 2 (lot de simplification, A2).
 *
 *   npm run morning:scanner-verify
 *
 * Cas ANONYMISÉS, écrits pour l'occasion : aucun nom de client, aucun corps de
 * message réel. Chaque cas reproduit une FORME rencontrée à l'audit de la copie
 * production du 24/09/2026 (faux positif supprimé ou faux négatif récupéré).
 *
 * Deux familles, toutes deux pures (aucun accès base) :
 *   — `triage()` : la catégorie d'UN message ;
 *   — `selectVisible()` : ce que Morning montre, fil et client compris.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (n) => pathToFileURL(path.resolve(process.cwd(), `src/lib/${n}.ts`)).href;
const { triage, selectVisible } = await import(lib("morning-events"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n${t}`);

// Un client d'une affaire ouverte du pipe : éligible, rattachement certain.
const PIPE = {
  direction: "entrant",
  from_email: "client@exemple.fr",
  match_kind: "affaire_pipe",
  stage: "Examen devis",
  is_terminal: 0,
  owner: null,
  blocker: null,
  quote: null,
};
// Un expéditeur que Salesforce ne connaît pas.
const UNKNOWN = { ...PIPE, from_email: "contact@inconnu-exemple.fr", match_kind: "inconnu", stage: null };

const model = (summary, over = {}) =>
  triage({ ...PIPE, subject: "Re: Votre projet", summary, signal_type: "neutre", classifier: "modele-test", ...over });
const rules = (subject, summary, over = {}) =>
  triage({ ...PIPE, subject, summary, signal_type: "neutre", classifier: "rules_fallback", ...over });
const said = (quote, over = {}) =>
  rules("Re: Votre projet", "Échange sans effet clair sur la signature", { quote, ...over });

// ────────────────────────────────────────────────────────────────────────
section("BLOC 1 — intention réelle d'avancer");
{
  check("accord explicite (citation) -> chaud", said("C'est validé de notre côté, on peut avancer.").category === "chaud");
  check("disponibilité proposée pour poursuivre -> chaud", said("Pas de problème, nous sommes disponibles lundi à 12h.").category === "chaud");
  check("choix arrêté -> chaud", said("Nous avons décidé de garder l'option parquet.").category === "chaud");
  check("contre-visite demandée -> chaud", said("J'aimerais faire une contre visite pour affiner.").category === "chaud");
  check("visite confirmée (modèle) -> chaud", model("Confirme la visite du 12/10 à 10h").category === "chaud");
  check("rendez-vous réservé (modèle) -> chaud", model("Client a réservé un RDV jeudi à 15h").category === "chaud");
  check("demande de rendez-vous (modèle) -> chaud", model("Demande de rendez-vous mardi 12:30").category === "chaud");
}

section("BLOC 1 — ne sont PAS chauds");
{
  check("« on réfléchit » -> écarté", model("Client réfléchit encore au devis").category === "ignore");
  check("« on reviendra vers vous » -> écarté", said("Nous reviendrons vers vous d'ici quelques semaines.").category === "ignore");
  check("report à une date -> écarté", model("Client demande de revenir fin octobre").category === "ignore");
  check("attente d'un tiers (banque) -> écarté", model("Client revient dès obtention du prêt auprès de la banque").category === "ignore");
  check("attente d'un tiers (mairie) -> écarté", model("Dossier complété, attend le retour de la mairie avant de progresser").category === "ignore");
  check("accusé de réception (modèle) -> écarté", model("Accuse réception du devis, sans demande explicite").category === "ignore");
  check("simple transmission -> écarté", model("Transmet son attestation comme convenu").category === "ignore");
  check("rappel de paiement -> écarté", model("Notification de rappel de paiement").category === "ignore");
  check("négation : « pas disponible » -> pas chaud", said("Je ne suis pas disponible lundi prochain.").category !== "chaud");
  check("« merci » seul -> écarté", said("Merci beaucoup, bonne journée.").category === "ignore");
  check(
    "positif des règles sur un seul mot-clé (financement) -> pas chaud",
    triage({ ...PIPE, subject: "Re: devis", summary: "Client engagé, en attente : financement", signal_type: "positif_bloque", classifier: "rules_fallback", blocker: "financement" }).category !== "chaud",
  );
  check(
    "positif du modèle sans volonté exprimée -> pas chaud",
    triage({ ...PIPE, subject: "Re: devis", summary: "Client favorable, dossier en cours", signal_type: "positif_bloque", classifier: "modele-test" }).category !== "chaud",
  );
  check("résumé écrit du point de vue de RM -> écarté", model("Commercial tente de relancer le prospect").category === "ignore");
}

section("BLOC 2 — une vraie demande, pas un dernier message quelconque");
{
  const q = said("Pourriez-vous m'envoyer le nouveau chiffrage ?");
  check("question explicite (citation) -> attente", q.category === "attente", q.reason);
  check("demande d'avancement (modèle) -> attente", model("Client demande l'avancement du devis").category === "attente");
  check("client attend notre devis (modèle) -> attente", model("Client en attente du devis").category === "attente");
  check("documents envoyés POUR une estimation -> attente", model("Envoie les plans pour estimation des travaux").category === "attente");
  check("question sur une prestation -> attente", model("Client demande si nous assurons cette prestation").category === "attente");
  check("documents envoyés sans demande -> écarté", model("Envoi de documents (plans et diagnostics)").category === "ignore");
  check("« Documents » en objet, accusé de réception -> écarté", triage({ ...PIPE, subject: "Documents", summary: "Accuse réception de documents, sans demande explicite", signal_type: "neutre", classifier: "modele-test" }).category === "ignore");
}

section("PÉRIMÈTRE — expéditeurs inconnus et non-clients");
{
  check("inconnu, objet seul (« Modification devis ») -> écarté", triage({ ...UNKNOWN, subject: "RE: Modification Devis", summary: "Échange sans effet clair sur la signature", signal_type: "neutre", classifier: "rules_fallback" }).category === "ignore");
  check("inconnu avec une vraie question -> attente", triage({ ...UNKNOWN, subject: "Re: Votre projet", summary: "Échange sans effet clair sur la signature", signal_type: "neutre", classifier: "rules_fallback", quote: "Seriez-vous disponible cette semaine ?" }).category === "attente");
  check("inconnu : confirmation sans demande -> écarté", triage({ ...UNKNOWN, subject: "RE: Proposition de rdv", summary: "Confirme rendez-vous le 6 octobre", signal_type: "neutre", classifier: "modele-test" }).category === "ignore");
  check("réponse d'un fournisseur à notre demande de prix -> écarté", triage({ ...UNKNOWN, subject: "Réponse à votre demande de tarification", summary: "Échange sans effet clair sur la signature", signal_type: "neutre", classifier: "rules_fallback" }).category === "ignore");
  check("sollicitation non commerciale -> écarté", triage({ ...UNKNOWN, subject: "Question", summary: "Demande de recherche scolaire sur l'entreprise", signal_type: "neutre", classifier: "modele-test" }).category === "ignore");
  check("réponse automatique d'agenda -> écarté", triage({ ...PIPE, subject: "Accepted: Appel de votre Expert Travaux", summary: "Confirmation de rendez-vous", signal_type: "neutre", classifier: "modele-test" }).category === "ignore");
}

// ────────────────────────────────────────────────────────────────────────
section("VISIBILITÉ — dernier message du client, réponse RM, un client = une ligne");
{
  const m = (id, thread, at, direction, category, over = {}) => ({
    id, thread_id: thread, sent_at: at, direction, category, reason: null,
    opportunity_id: null, match_level: "C", from_email: `${thread}@exemple.fr`, ...over,
  });

  let v = selectVisible([m("a1", "t1", "2026-09-01T09:00:00Z", "entrant", "attente")]);
  check("attente seule, sans réponse -> visible", v.waiting.has("a1"));

  v = selectVisible([
    m("a1", "t1", "2026-09-01T09:00:00Z", "entrant", "attente"),
    m("r1", "t1", "2026-09-01T11:00:00Z", "sortant", null),
  ]);
  check("RM a répondu APRÈS -> plus visible", !v.waiting.has("a1"));

  v = selectVisible([
    m("r1", "t1", "2026-09-01T08:00:00Z", "sortant", null),
    m("a1", "t1", "2026-09-01T09:00:00Z", "entrant", "attente"),
  ]);
  check("réponse RM ANTÉRIEURE -> toujours visible", v.waiting.has("a1"));

  v = selectVisible([
    m("a1", "t1", "2026-09-01T09:00:00Z", "entrant", "attente"),
    m("a2", "t1", "2026-09-02T09:00:00Z", "entrant", "ignore"),
  ]);
  check("le client a écrit ensuite « merci » -> plus visible", !v.waiting.has("a1") && !v.waiting.has("a2"));

  v = selectVisible([
    m("h1", "t1", "2026-09-01T09:00:00Z", "entrant", "chaud"),
    m("n1", "t1", "2026-09-02T09:00:00Z", "entrant", "hors_perimetre"),
  ]);
  check("un message hors périmètre postérieur ne masque pas le client", v.hot.has("h1"));

  v = selectVisible([
    m("h1", "t1", "2026-09-01T09:00:00Z", "entrant", "chaud", { opportunity_id: "006X", match_level: "A" }),
    m("a2", "t2", "2026-09-03T09:00:00Z", "entrant", "attente", { opportunity_id: "006X", match_level: "A" }),
  ]);
  check("même affaire sur deux fils -> une seule ligne, la plus récente", v.waiting.has("a2") && !v.hot.has("h1"));

  v = selectVisible([
    m("a1", "t1", "2026-09-01T09:00:00Z", "entrant", "attente", { from_email: "meme@exemple.fr" }),
    m("a2", "t2", "2026-09-01T09:05:00Z", "entrant", "attente", { from_email: "meme@exemple.fr" }),
  ]);
  check("même expéditeur sans affaire, deux fils -> une seule ligne", v.waiting.size === 1 && v.waiting.has("a2"));

  v = selectVisible([
    m("h1", "t1", "2026-09-01T09:00:00Z", "entrant", "chaud", { opportunity_id: "006X", match_level: "C" }),
    m("h2", "t2", "2026-09-02T09:00:00Z", "entrant", "chaud", { opportunity_id: "006X", match_level: "C" }),
  ]);
  check("rattachement incertain (C) : pas de fusion par affaire", v.hot.size === 2);
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);

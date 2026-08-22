/**
 * Contrôle des règles corrigées au Passage A, sur des cas construits.
 *
 *   node --experimental-strip-types scripts/verify-mail-rules.mjs
 *
 * Purement local et déterministe : aucun appel réseau, aucune donnée réelle.
 * Chaque cas dit ce qu'on attend ET pourquoi.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const { filterMessage } = await import(
  pathToFileURL(path.resolve(process.cwd(), "src/lib/mail-rules.ts")).href
);

const message = (over) => ({
  id: "x",
  threadId: "t",
  date: new Date().toISOString(),
  from: "client@exemple.fr",
  to: ["contact@renovationman.com"],
  cc: [],
  subject: "",
  snippet: "",
  ...over,
});

const cases = [
  // --- contact@ : canal d'arrivée des leads, plus jamais « hors périmètre ».
  {
    why: "prospect écrivant à contact@, aucun commercial encore affecté",
    m: message({ subject: "Rdv téléphonique ce jour", snippet: "Suite à notre échange" }),
    kept: true,
  },
  {
    why: "réponse de l'entreprise depuis contact@ vers un prospect",
    m: message({
      from: "contact@renovationman.com",
      to: ["client@exemple.fr"],
      subject: "Votre projet de rénovation",
    }),
    kept: true,
  },
  {
    why: "contact@ mais publicité d'un domaine de bruit connu",
    m: message({ from: "news@spotify.com", subject: "Votre récap" }),
    kept: false,
    rule: "domaine-bruit",
  },
  {
    why: "trafic purement interne via contact@, aucun externe",
    m: message({
      from: "contact@renovationman.com",
      to: ["sami@renovationman.com"],
      subject: "note interne",
    }),
    kept: false,
  },
  {
    why: "ni commercial, ni boîte générique",
    m: message({ from: "a@ailleurs.fr", to: ["b@ailleurs.fr"], subject: "bonjour" }),
    kept: false,
    rule: "hors-perimetre",
  },

  // --- contact@ est un groupe Google : Precedence/List-Unsubscribe y sont
  //     posés par Google sur TOUT, prospects compris.
  {
    why: "prospect arrivé par le groupe contact@ — en-têtes de liste posés par Google",
    m: message({
      from: "claire.bastard@hotmail.fr",
      subject: "Rdv téléphonique ce jour",
      bulk: true,
      listId: "<contact.renovationman.com>",
    }),
    kept: true,
  },
  {
    why: "vrai envoi en masse d'une plateforme tierce, hors liste interne",
    m: message({
      from: "news@salon-quelconque.fr",
      to: ["sami@renovationman.com"],
      subject: "Derniers jours pour bénéficier de -30 %",
      bulk: true,
    }),
    kept: false,
    rule: "envoi-en-masse",
  },
  {
    why: "notification du standard téléphonique arrivée par le groupe",
    m: message({
      from: "contact@renovationman.com",
      to: ["sami@renovationman.com"],
      subject: "Message vocal (50s) de 06 30 39 59 59 sur Standard RM",
      bulk: true,
      listId: "<contact.renovationman.com>",
    }),
    kept: false,
    rule: "telephonie",
  },
  {
    why: "réponse interne à une notification d'appel manqué",
    m: message({
      from: "david.bernstein@renovationman.com",
      to: ["contact@renovationman.com"],
      subject: "Fwd: Appel manqué de 06 12 08 82 39 sur Standard RM",
    }),
    kept: false,
    rule: "telephonie",
  },
  {
    why: "rapport de non-remise du serveur de messagerie",
    m: message({
      from: "mailer-daemon@googlemail.com",
      to: ["sami@renovationman.com"],
      subject: "Delivery Status Notification (Failure)",
    }),
    kept: false,
    rule: "retour-technique",
  },

  // --- Administratif : écarté, sauf acompte.
  {
    why: "client actif réclamant sa facture d'acompte — signal de signature",
    m: message({
      from: "client@exemple.fr",
      to: ["david.bernstein@renovationman.com"],
      subject: "Demande de facture d'acompte",
      snippet: "Pouvez-vous m'envoyer la facture d'acompte pour lancer les travaux",
    }),
    kept: true,
  },
  {
    why: "échéancier de paiement côté client — également un engagement",
    m: message({
      from: "client@exemple.fr",
      to: ["valentin@renovationman.com"],
      subject: "Échéancier de paiement",
    }),
    kept: true,
  },
  {
    why: "attestation de vigilance URSSAF d'un artisan",
    m: message({
      from: "artisan@plomberie.fr",
      to: ["mathis.coulon@renovationman.com"],
      subject: "Attestation de vigilance URSSAF",
    }),
    kept: false,
    rule: "administratif",
  },
  {
    why: "facture fournisseur à régler",
    m: message({
      from: "compta@fournisseur.fr",
      to: ["sami@renovationman.com"],
      subject: "Facture fournisseur n°8871 à régler",
    }),
    kept: false,
    rule: "administratif",
  },
  {
    why: "relance d'impayé",
    m: message({
      from: "recouvrement@fournisseur.fr",
      to: ["sami@renovationman.com"],
      subject: "Relance de paiement — impayé",
    }),
    kept: false,
    rule: "administratif",
  },
  {
    why: "demande d'attestation d'assurance décennale",
    m: message({
      from: "artisan@toiture.fr",
      to: ["guillaume@renovationman.com"],
      subject: "Assurance décennale et Kbis",
    }),
    kept: false,
    rule: "administratif",
  },
  {
    why: "le mot « facture » seul ne doit jamais suffire à écarter",
    m: message({
      from: "client@exemple.fr",
      to: ["jonathan.florville@renovationman.com"],
      subject: "Question sur la facture",
      snippet: "Je voulais valider un point avant de signer",
    }),
    kept: true,
  },
];

let failures = 0;
for (const c of cases) {
  const verdict = filterMessage(c.m);
  const okKept = verdict.kept === c.kept;
  const okRule = !c.rule || verdict.rule === c.rule;
  const ok = okKept && okRule;
  if (!ok) failures += 1;
  const got = verdict.kept ? "conservé" : `écarté (${verdict.rule})`;
  console.log(
    `  ${ok ? "ok  " : "ÉCHEC"} ${c.why}\n         attendu ${c.kept ? "conservé" : `écarté${c.rule ? ` (${c.rule})` : ""}`} — obtenu ${got}`,
  );
}

console.log(`\n  ${cases.length - failures}/${cases.length} cas conformes`);
process.exit(failures === 0 ? 0 : 1);

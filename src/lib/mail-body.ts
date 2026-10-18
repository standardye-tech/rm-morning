/**
 * Corps utile du DERNIER message humain entrant — scanner mail V2 (18/10/2026).
 *
 * POURQUOI. Jusqu'ici, règles et modèle ne lisaient que l'extrait Gmail, au plus
 * ~200 caractères : « Bonjour, merci pour… ». La phrase qui compte — « Avant de
 * signer dans les prochaines heures la phase 1… » — venait presque toujours
 * après (audit du 18/10/2026). On lit donc le corps, mais seulement ce que
 * l'expéditeur a ÉCRIT dans ce message : sans historique cité, sans signature,
 * sans mentions légales, borné.
 *
 * RÈGLE DE MINIMISATION INCHANGÉE : ce texte vit en mémoire le temps de la
 * classification. Il n'est jamais écrit en base ; seule la citation bornée
 * (160 caractères) l'est, comme avant.
 *
 * Aucune dépendance : testable tel quel.
 */

/** Taille maximale du corps nettoyé transmis au classifieur. */
export const CLEAN_BODY_MAX = 3000;

type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

const decodeBase64Url = (data: string): string =>
  Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findPart(part: GmailPart | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&eacute;": "é", "&egrave;": "è", "&ecirc;": "ê", "&agrave;": "à", "&acirc;": "â", "&ccedil;": "ç",
  "&ocirc;": "ô", "&ucirc;": "û", "&icirc;": "î", "&euml;": "ë", "&iuml;": "ï", "&rsquo;": "'", "&laquo;": "«", "&raquo;": "»",
};

/** Entités HTML courantes et numériques. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);
}

/** HTML → texte lisible : blocs en sauts de ligne, citations HTML retirées. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      // Historique cité par Gmail, Outlook et Apple Mail : retiré à la source.
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
      .replace(/<div[^>]*class="?gmail_quote[\s\S]*$/i, "\n")
      .replace(/<div[^>]*id="?(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)[\s\S]*$/i, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

/**
 * Début de l'historique cité, dans un corps en texte : « Le 12 oct. 2026 à 13:57,
 * X a écrit : », « On Mon, Oct 12… wrote: », « De : … Envoyé : », « -----Message
 * d'origine----- », lignes « > ».
 */
const QUOTE_START: RegExp[] = [
  /^\s*>/m,
  // L'en-tête de citation peut être coupé sur deux lignes par le client mail.
  /\bLe [\s\S]{3,160}?a [ée]crit\s*:/i,
  /\bOn [A-Z][a-z]{2},? [\s\S]{3,160}?wrote\s*:/,
  /^\s*(De|From)\s*:\s.+$(\s*^\s*(Envoy[ée]|Sent|Date)\s*:)/im,
  /^\s*(De|From)\s*:.*\n(.*\n){0,3}\s*(Objet|Subject)\s*:/im,
  /-{2,}\s*(Message d'origine|Original Message|Forwarded message|Message transf[ée]r[ée])\s*-{2,}/i,
  /^_{8,}\s*$/m,
  /\bD[ée]but du message (r[ée]exp[ée]di[ée]|transf[ée]r[ée])\s*:/i,
  /^Envoy[ée] (de|à partir de) (mon|Outlook|Yahoo|l'application)/im,
];

/** Fin du texte écrit : formule de clôture suivie d'une signature, mentions légales. */
const SIGNATURE_START: RegExp[] = [
  /^\s*--\s*$/m,
  /^\s*(Envoy[ée] (de|depuis) mon (iPhone|iPad|Android|smartphone)|Sent from my)/im,
  /\n\s*(Ce (message|courriel|mail) (et (ses|toutes les) pi[èe]ces jointes )?(est|sont) (confidentiel|strictement)|This (e-?mail|message) and any attachments|Le contenu de ce (message|courriel)|Avertissement\s*:|Disclaimer)/i,
  /\n\s*(Pensez [àa] l'environnement|Please consider the environment)/i,
];

/** Formule de politesse finale : on garde la phrase, on coupe ce qui suit si c'est long. */
const CLOSING = /\n\s*(cordialement|bien (cordialement|[àa] vous)|bonne (journ[ée]e|soir[ée]e|fin de journ[ée]e)|sinc[èe]res salutations|salutations|merci d'avance|best regards|kind regards|regards)\b[^\n]*\n/i;

/**
 * Le texte réellement écrit dans le message, nettoyé et borné. `null` quand le
 * message n'a aucune partie texte exploitable.
 */
export function cleanLatestInboundBody(payload: GmailPart | undefined, max = CLEAN_BODY_MAX): string | null {
  const plain = findPart(payload, "text/plain");
  const html = plain ? null : findPart(payload, "text/html");
  const raw = plain ?? (html ? htmlToText(html) : null);
  if (!raw) return null;
  return cleanText(raw, max);
}

/** Nettoyage d'un texte déjà extrait. Exporté pour les harnais. */
export function cleanText(raw: string, max = CLEAN_BODY_MAX): string | null {
  let text = decodeEntities(raw.replace(/\r/g, "")).replace(/ /g, " ");

  // Historique : coupé au premier marqueur trouvé APRÈS un peu de texte écrit.
  let cut = text.length;
  for (const pattern of QUOTE_START) {
    const m = pattern.exec(text);
    if (m && m.index >= 10 && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);

  // Signature longue et mentions légales.
  for (const pattern of SIGNATURE_START) {
    const m = pattern.exec(text);
    if (m && m.index >= 20) text = text.slice(0, m.index);
  }
  const closing = CLOSING.exec(text);
  // On garde la formule de politesse, on retire le bloc qui la suit
  // (coordonnées, logos, réseaux sociaux) — seulement s'il est long.
  if (closing && text.length - (closing.index + closing[0].length) > 120) {
    text = text.slice(0, closing.index + closing[0].length);
  }

  text = text
    .replace(/\[(cid|image)[^\]]*\]/gi, " ")
    .replace(/<?https?:\/\/\S+>?/g, "[lien]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
}

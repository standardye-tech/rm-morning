/**
 * Source Salesforce « manuelle » : l'export de rapport téléchargé depuis
 * Salesforce, nommé `.xls` mais qui est en réalité une page HTML contenant
 * un unique <table>, encodée en ISO-8859-1.
 *
 * C'est le SEUL fichier de l'application qui connaît ce format.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { cleanText, normalizeKey } from "../normalize";
import {
  RAW_FIELDS,
  type ParseIssue,
  type RawOpportunity,
  type SalesforceFetchResult,
  type SalesforceSource,
} from "./salesforce";

/**
 * Libellés Salesforce acceptés pour chaque champ du contrat, comparés sous
 * forme normalisée (sans accents, casse ni ponctuation). Plusieurs variantes
 * sont admises : l'export peut changer de libellé sans casser l'import.
 */
const COLUMN_ALIASES: Record<keyof RawOpportunity, string[]> = {
  opportunityId: ["ID de l'opportunité", "Opportunity ID", "ID opportunité"],
  name: ["Nom de l'opportunité", "Opportunity Name", "Nom opportunité"],
  clientContact: ["Contact client", "Client", "Contact"],
  clientEmail: ["E-mail client", "Email client", "Adresse e-mail du contact"],
  ownerName: [
    "Propriétaire de l'opportunité - Opp",
    "Propriétaire de l'opportunité",
    "Opportunity Owner",
    "Propriétaire",
  ],
  gmv: ["GMV (HT) - Opp", "GMV (HT)", "GMV", "Montant"],
  stage: ["Étape - Opp", "Étape", "Etape - Opp", "Etape", "Stage"],
  probability: ["Probabilité (%)", "Probabilité", "Probability (%)"],
  kanbanProjection: ["Projection Kanban", "Kanban"],
  createdAt: ["Date de création", "Date de création - Opp", "Created Date"],
  leadCreatedAt: ["Date de création de la piste", "Lead Created Date"],
  quoteSignatureDate: [
    "Date de signature du devis - Opp",
    "Date de signature du devis",
    "Date de clôture",
    "Close Date",
  ],
  lastActivityAt: ["Dernière activité", "Last Activity", "Date dernière activité"],
  lastModifiedAt: [
    "Date de dernière modification",
    "Last Modified Date",
    "Date dernière modification",
  ],
  postalCode: ["Code postal", "CP", "Postal Code"],
  city: ["Ville", "City"],
  acquisitionChannel: ["Canal d'acquisition", "Canal"],
  leadSource: ["Lead Source", "Source de la piste", "Origine de la piste"],
  service: ["Prestation - Opp", "Prestation", "Type de prestation"],
  standByFlag: ["En stand-by", "Stand-by ?"],
  standByUntil: [
    "En stand-by jusqu'au",
    "En stand by jusqu'au",
    "Stand-by jusqu'au",
    "Date de stand-by",
  ],
};

const ALIAS_INDEX = new Map<string, keyof RawOpportunity>();
for (const field of RAW_FIELDS) {
  for (const alias of COLUMN_ALIASES[field]) {
    ALIAS_INDEX.set(normalizeKey(alias), field);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Décode les entités HTML : &#128992; (emoji), &#39;, &amp;, &#x27;… */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Décode le buffer selon le charset annoncé dans le <meta>.
 * Salesforce exporte en ISO-8859-1 ; on tolère un export UTF-8.
 */
function decodeBuffer(buffer: Buffer): string {
  const head = buffer.subarray(0, 1024).toString("latin1");
  const charset = head.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (charset && /utf-?8/.test(charset)) return buffer.toString("utf8");
  return buffer.toString("latin1");
}

/** Découpe le tableau HTML en lignes de cellules déjà décodées. */
function parseHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[1])));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

export type ManualSourceInput =
  | { filePath: string }
  | { buffer: Buffer; fileName: string };

/**
 * Trouve l'export Salesforce le plus récent d'un dossier
 * (fichier `.xls` dont le nom commence par « report »).
 */
export async function findLatestExport(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const candidates = entries.filter((name) => /^report.*\.xls$/i.test(name));
  if (candidates.length === 0) return null;

  const withTime = await Promise.all(
    candidates.map(async (name) => {
      const full = path.join(dir, name);
      const info = await stat(full);
      return { full, mtime: info.mtimeMs };
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].full;
}

export class ManualSalesforceSource implements SalesforceSource {
  readonly kind = "manual";

  constructor(private readonly input: ManualSourceInput) {}

  async fetch(): Promise<SalesforceFetchResult> {
    const fileName =
      "filePath" in this.input ? path.basename(this.input.filePath) : this.input.fileName;
    const buffer =
      "filePath" in this.input ? await readFile(this.input.filePath) : this.input.buffer;

    const issues: ParseIssue[] = [];
    const table = parseHtmlTable(decodeBuffer(buffer));

    if (table.length === 0) {
      return {
        sourceKind: this.kind,
        sourceLabel: `Export manuel — ${fileName}`,
        fileName,
        fetchedAt: new Date(),
        detectedFields: [],
        missingFields: [...RAW_FIELDS],
        rawHeaders: [],
        rows: [],
        issues: [
          {
            message:
              "Aucun tableau HTML trouvé dans le fichier. Est-ce bien un export de rapport Salesforce ?",
          },
        ],
      };
    }

    const rawHeaders = table[0];
    const columnOf = new Map<keyof RawOpportunity, number>();
    rawHeaders.forEach((header, index) => {
      const field = ALIAS_INDEX.get(normalizeKey(header));
      // Premier libellé rencontré gagne : un doublon de colonne n'écrase rien.
      if (field && !columnOf.has(field)) columnOf.set(field, index);
    });

    const detectedFields = RAW_FIELDS.filter((f) => columnOf.has(f));
    const missingFields = RAW_FIELDS.filter((f) => !columnOf.has(f));

    for (const [index, header] of rawHeaders.entries()) {
      if (!ALIAS_INDEX.has(normalizeKey(header))) {
        issues.push({
          message: `Colonne non reconnue, ignorée : « ${header} » (position ${index + 1})`,
        });
      }
    }

    const rows: RawOpportunity[] = [];
    for (let i = 1; i < table.length; i++) {
      const cells = table[i];
      // Une ligne de total ou de sous-total n'a pas la bonne largeur : on l'ignore.
      if (cells.length !== rawHeaders.length) {
        issues.push({
          row: i + 1,
          message: `Ligne ignorée : ${cells.length} cellules au lieu de ${rawHeaders.length}`,
        });
        continue;
      }

      const row = Object.fromEntries(
        RAW_FIELDS.map((field) => {
          const index = columnOf.get(field);
          return [field, index === undefined ? null : cleanText(cells[index])];
        }),
      ) as RawOpportunity;

      if (!row.opportunityId && !row.name) {
        issues.push({ row: i + 1, message: "Ligne ignorée : ni ID ni nom d'opportunité" });
        continue;
      }
      rows.push(row);
    }

    return {
      sourceKind: this.kind,
      sourceLabel: `Export manuel — ${fileName}`,
      fileName,
      fetchedAt: new Date(),
      detectedFields,
      missingFields,
      rawHeaders,
      rows,
      issues,
    };
  }
}

import {
  FileText,
  HardDrive,
  Mail,
  MessageSquare,
  NotebookText,
  Sheet,
  SquareKanban,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { NOTION_REMOTE_URL } from "@/lib/schema";

/**
 * What the "Connect MCP" directory offers.
 *
 * Brand marks come from svgl.app and are vendored into `public/logos` rather
 * than hot-linked: a third-party request per render would be a privacy leak and
 * a broken icon the day they move the file. Every mark is drawn on a constant
 * light tile, because several of them (Notion's especially) are near-black and
 * vanish on a dark surface, and recolouring a brand mark is not an option.
 *
 * Adding a real integration is one entry with `available: true` and a URL.
 */
export interface McpCatalogueEntry {
  /** Stable id, also the suggested server key. */
  id: string;
  name: string;
  /** One line on what the agent would be able to reach. */
  description: string;
  /** Vendored svgl.app brand mark, served straight from `public/`. */
  logo?: string;
  /** Category glyph, used when svgl.app has no mark for the service. */
  icon: LucideIcon;
  /** False for entries that only signpost where this is going; they cannot be connected. */
  available: boolean;
  /** The remote MCP endpoint, for entries that are real. */
  url?: string;
}

export const MCP_CATALOGUE: readonly McpCatalogueEntry[] = [
  {
    id: "notion",
    name: "Notion",
    description: "Pages, databases, comments and search",
    logo: "/logos/notion.svg",
    icon: NotebookText,
    available: true,
    url: NOTION_REMOTE_URL,
  },
  {
    // svgl.app has no Airtable mark, so this one keeps a category glyph.
    id: "airtable",
    name: "Airtable",
    description: "Bases, tables and records",
    icon: Table2,
    available: false,
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    description: "Spreadsheets, ranges and formulas",
    logo: "/logos/google-sheets.svg",
    icon: Sheet,
    available: false,
  },
  {
    // svgl.app has no Google Docs mark either.
    id: "google-docs",
    name: "Google Docs",
    description: "Documents and comments",
    icon: FileText,
    available: false,
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Threads, messages and drafts",
    logo: "/logos/gmail.svg",
    icon: Mail,
    available: false,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Files and folders",
    logo: "/logos/google-drive.svg",
    icon: HardDrive,
    available: false,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, threads and messages",
    logo: "/logos/slack.svg",
    icon: MessageSquare,
    available: false,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and cycles",
    logo: "/logos/linear.svg",
    icon: SquareKanban,
    available: false,
  },
];

/** The catalogue entry a connected server came from, so both show one icon. */
export function catalogueEntryFor(server: {
  key: string;
  url: string | null;
}): McpCatalogueEntry | undefined {
  return MCP_CATALOGUE.find(
    (entry) =>
      (entry.url !== undefined && entry.url === server.url) ||
      entry.id === server.key ||
      server.key.startsWith(`${entry.id}-`),
  );
}

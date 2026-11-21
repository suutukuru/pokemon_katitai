import type { PokemonSet } from "@ca/schema";

export type IssueSeverity = "error" | "warning" | "info";

export interface IngestIssue {
  severity: IssueSeverity;
  /** Index of the team member (0-based), if the issue belongs to one. */
  member?: number;
  /** Field path, e.g. "moves.2" or "item". */
  field?: string;
  /** 1-based source line for text input. */
  line?: number;
  message: string;
  /** Name-matching candidates for the confirmation UI. */
  candidates?: { id: string; label: string }[];
}

export interface ExtractionResult {
  extractor: string;
  members: PokemonSet[];
  issues: IngestIssue[];
}

export interface ExtractContext {
  /** Legal species/items/moves from the regulation pack, used to correct name variants. */
  legal?: { species?: readonly string[]; items?: readonly string[] };
}

/**
 * Plug-in extractor (ADR-0004). Implementations: Showdown text (here),
 * Claude Code CLI screenshot reader (phase 5), and future OCR/API extractors.
 */
export interface Extractor<I> {
  readonly id: string;
  extract(input: I, ctx?: ExtractContext): Promise<ExtractionResult>;
}

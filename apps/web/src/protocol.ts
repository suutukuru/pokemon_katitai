import type { DiagnosisReport } from "@ca/engine";
import type { ExplainedFinding } from "@ca/explain";
import type { IngestIssue } from "@ca/ingest";

export interface DiagnoseRequest {
  type: "diagnose";
  id: number;
  text: string;
  regulationId: string;
}

export interface MemberView {
  species: string;
  name: string;
  formeName: string;
  mega: boolean;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  stats: Record<string, number>;
  sp: Record<string, number>;
  assumed: string[];
  lowConfidence: string[];
}

export interface DiagnoseResponse {
  type: "result";
  id: number;
  issues: IngestIssue[];
  members: MemberView[];
  report: Omit<DiagnosisReport, "members"> | null;
  explained: (ExplainedFinding & { ruleId: string })[];
  regulations: { id: string; name: string }[];
  ms: number;
}

export interface ErrorResponse {
  type: "error";
  id: number;
  message: string;
}

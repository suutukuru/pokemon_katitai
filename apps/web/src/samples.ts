// Sample teams for the UI thread (kept separate so the UI bundle does not pull in calc data).
const sampleTexts = import.meta.glob("../../../packages/data/teams/samples/*.txt", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
import sampleIndex from "../../../packages/data/teams/samples/index.json";

export interface SampleTeam {
  id: string;
  name: string;
  text: string;
  sample: boolean;
  source: string;
}
export const SAMPLE_TEAMS: SampleTeam[] = sampleIndex.teams.map((t) => ({
  id: t.id,
  name: t.name.ja,
  sample: t.sample,
  source: t.source,
  text: Object.entries(sampleTexts).find(([p]) => p.endsWith(`/${t.file}`))?.[1] ?? "",
}));

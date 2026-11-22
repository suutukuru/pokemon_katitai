// Team library: my teams and opponents bundled from the repository, the top recorded teams
// (sets estimated from usage: marked as such), and teams saved on this device.
import metaTeams from "./data/meta-teams.json";
import { SAMPLE_TEAMS } from "./samples";
import { loadSaved, type SavedTeam } from "./storage";

export type TeamGroup = "mine" | "saved" | "opponent" | "meta" | "sample";

export interface TeamEntry {
  id: string;
  name: string;
  group: TeamGroup;
  text: string;
  /** estimated sets etc. */
  note?: string;
  estimated?: boolean;
  /** meta team ID (e.g. "M-7:4") for precomputed lookups */
  metaId?: string;
}

const raw = (g: Record<string, string>, group: TeamGroup, prefix: string): TeamEntry[] =>
  Object.entries(g)
    .map(([path, text]) => {
      const name = path.replace(/^.*\//, "").replace(/\.txt$/, "");
      return { id: `${prefix}:${name}`, name, group, text };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

const myFiles = import.meta.glob("../../../my-teams/*.txt", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const oppFiles = import.meta.glob("../../../opponents/*.txt", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export const GROUP_LABEL: Record<TeamGroup, string> = {
  mine: "自分のパーティ（リポジトリ）",
  saved: "この端末に保存",
  opponent: "対策したい構築",
  meta: "上位構築（型は推定）",
  sample: "サンプル",
};

export function allTeams(saved: SavedTeam[] = loadSaved()): TeamEntry[] {
  return [
    ...saved.map((t) => ({
      id: `saved:${t.id}`,
      name: t.name,
      group: "saved" as const,
      text: t.text,
    })),
    ...raw(myFiles, "mine", "mine"),
    ...raw(oppFiles, "opponent", "opp"),
    ...metaTeams.teams.map((t) => ({
      id: `meta:${t.id}`,
      name: t.label,
      group: "meta" as const,
      text: t.text,
      estimated: true,
      metaId: t.id,
      ...(t.note ? { note: t.note } : {}),
    })),
    ...SAMPLE_TEAMS.map((t) => ({
      id: `sample:${t.id}`,
      name: t.name,
      group: "sample" as const,
      text: t.text,
    })),
  ];
}

export const metaDataVersion = metaTeams.dataVersion;

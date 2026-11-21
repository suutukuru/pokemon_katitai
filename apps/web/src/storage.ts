// User team data lives only in this browser (export/delete available). No server storage in the MVP.
export interface SavedTeam {
  id: string;
  name: string;
  text: string;
  regulationId: string;
  savedAt: string;
}
const KEY = "ca.teams.v1";

export function loadSaved(): SavedTeam[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedTeam[]) : [];
  } catch {
    return [];
  }
}
export function saveAll(teams: SavedTeam[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(teams));
  } catch {
    /* storage unavailable (private mode) — the app still works without saving */
  }
}
/** Export as JSON text (copied to the clipboard by the UI; downloads are not available everywhere). */
export function exportText(teams: SavedTeam[]): string {
  return JSON.stringify({ format: "champions-analyzer.teams", version: 1, teams }, null, 2);
}

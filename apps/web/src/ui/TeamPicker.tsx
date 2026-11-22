import { GROUP_LABEL, type TeamEntry, type TeamGroup } from "../teams";

const ORDER: TeamGroup[] = ["saved", "mine", "opponent", "meta", "sample"];

export function TeamPicker({
  label,
  teams,
  value,
  onChange,
  groups = ORDER,
}: {
  label: string;
  teams: TeamEntry[];
  value: string;
  onChange: (id: string) => void;
  groups?: TeamGroup[];
}) {
  return (
    <label className="picker">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {groups.map((g) => {
          const xs = teams.filter((t) => t.group === g);
          return xs.length ? (
            <optgroup key={g} label={GROUP_LABEL[g]}>
              {xs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
    </label>
  );
}

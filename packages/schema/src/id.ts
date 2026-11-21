import { z } from "zod";

/** Showdown-compatible ID: lowercase alphanumerics only. `Charizard-Mega-Y` → `charizardmegay`. */
export function toID(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export const IdSchema = z
  .string()
  .min(1)
  .transform((s) => toID(s))
  .refine((s) => s.length > 0, { message: "ID must contain at least one alphanumeric character" });

export const PackIdSchema = z
  .string()
  .regex(
    /^[A-Z0-9][A-Z0-9-]*$/,
    "Regulation pack ID must be uppercase alphanumerics and '-' (e.g. M-B)",
  );
export type PackId = z.infer<typeof PackIdSchema>;

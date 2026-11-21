import type { Rule } from "../rule.js";
import { legalityRule } from "./legality.js";
import { fakeOutRule, intimidateRule, protectRule, redirectionRule } from "./support.js";
import { speedControlRule } from "./speed-control.js";
import { fieldConflictRule } from "./weather.js";
import { megaSlotsRule } from "./mega.js";
import { coverageRule, sharedWeaknessRule } from "./typing.js";
import { speedTierRule } from "./speed.js";
import { selectionRule } from "./selection.js";
import { trickRoomAnswerRule } from "./matchup.js";
import { threatDefenseRule, threatOffenseRule } from "./threats.js";

/** All built-in rules, in evaluation order. Weights/params come from the regulation's weights.json. */
export const RULES: readonly Rule[] = [
  legalityRule,
  speedControlRule,
  speedTierRule,
  fakeOutRule,
  intimidateRule,
  redirectionRule,
  protectRule,
  sharedWeaknessRule,
  coverageRule,
  megaSlotsRule,
  fieldConflictRule,
  selectionRule,
  trickRoomAnswerRule,
  threatOffenseRule,
  threatDefenseRule,
];

export { speedBenchmarks } from "./speed.js";
export { combinations } from "./selection.js";

import { describe, expect, it } from "vitest";
import { contrastRatio, generateAppearanceTokens, APPEARANCE_TOKEN_KEYS } from "../src/core/appearance-tokens.js";

describe("appearance token utility", () => {
  it("derives complete readable light and dark modes from one seed", () => {
    const result = generateAppearanceTokens({ seed: "#6750A4" });
    expect(Object.keys(result.modes.light)).toEqual([...APPEARANCE_TOKEN_KEYS]);
    expect(Object.keys(result.modes.dark)).toEqual([...APPEARANCE_TOKEN_KEYS]);
    expect(contrastRatio(result.modes.light.controlBackgroundSelected, result.modes.light.controlTextSelected)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.modes.dark.background, result.modes.dark.onBackground)).toBeGreaterThanOrEqual(4.5);
  });
});

import { describe, expect, it } from "vitest";
import { EXPERIENCE_GALLERY_URL, readExperienceAiGuide } from "../src/node/experience-resources.js";

describe("Experience authoring resources", () => {
  it("exposes the gallery and complete AI guide", async () => {
    expect(EXPERIENCE_GALLERY_URL).toBe("https://dreamskin.cc/gallery");
    await expect(readExperienceAiGuide()).resolves.toContain("Experience");
  });
});

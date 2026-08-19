import fs from "node:fs/promises";
import { ExperienceKitError } from "../core/errors.js";

export const EXPERIENCE_GALLERY_URL = "https://dreamskin.cc/gallery";

const AI_GUIDE_URL = new URL("../../docs/ai-experience-generation.zh-CN.md", import.meta.url);

export async function readExperienceAiGuide(): Promise<string> {
  try {
    const guide = await fs.readFile(AI_GUIDE_URL, "utf8");
    if (!guide.trim()) throw new Error("AI generation guide is empty");
    return guide;
  } catch (error) {
    throw new ExperienceKitError("experience-resource/ai-guide", "Unable to read the Experience AI generation guide", { cause: error });
  }
}

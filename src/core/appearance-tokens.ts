import { ExperienceValidationError } from "./errors.js";

export const APPEARANCE_TOKEN_ALGORITHM = "oklch-tonal-v1" as const;

export const APPEARANCE_TONES = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 100] as const;
export type AppearanceTone = (typeof APPEARANCE_TONES)[number];
export type AppearanceTonalScale = Record<AppearanceTone, string>;

export const APPEARANCE_TOKEN_KEYS = [
  "background",
  "surface",
  "surfaceRaised",
  "surfaceHover",
  "surfaceSelected",
  "surfaceDisabled",
  "primary",
  "primaryHover",
  "primaryPressed",
  "primaryContainer",
  "onBackground",
  "onSurface",
  "onSurfaceMuted",
  "onPrimary",
  "onPrimaryContainer",
  "outline",
  "outlineStrong",
  "focusRing",
  "controlBackground",
  "controlBackgroundHover",
  "controlBackgroundSelected",
  "controlBackgroundDisabled",
  "controlText",
  "controlTextSelected",
  "controlTextDisabled",
  "scrim",
] as const;

export type AppearanceTokenKey = (typeof APPEARANCE_TOKEN_KEYS)[number];
export type AppearanceTokenSet = Record<AppearanceTokenKey, string>;
export interface AppearanceTokenModes {
  light: AppearanceTokenSet;
  dark: AppearanceTokenSet;
}

export type AppearanceContrast = "soft" | "standard" | "high";

export interface AppearanceTokenRecipe {
  algorithm: typeof APPEARANCE_TOKEN_ALGORITHM;
  seed: string;
  contrast: AppearanceContrast;
  darkSeed?: string;
}

export interface GeneratedAppearanceTokens {
  recipe: AppearanceTokenRecipe;
  scales: {
    primary: AppearanceTonalScale;
    neutral: AppearanceTonalScale;
    darkPrimary: AppearanceTonalScale;
    darkNeutral: AppearanceTonalScale;
  };
  modes: AppearanceTokenModes;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const HEX = /^#[0-9a-f]{6}$/iu;

function normalizeHex(value: string, label: string): string {
  if (!HEX.test(value)) {
    throw new ExperienceValidationError("token-seed", `${label} must be a six-digit hexadecimal color`);
  }
  return value.toUpperCase();
}

function hexToRgb(value: string): Rgb {
  return {
    r: Number.parseInt(value.slice(1, 3), 16) / 255,
    g: Number.parseInt(value.slice(3, 5), 16) / 255,
    b: Number.parseInt(value.slice(5, 7), 16) / 255,
  };
}

function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function gamma(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function rgbToOklch(rgb: Rgb): Oklch {
  const r = linear(rgb.r);
  const g = linear(rgb.g);
  const b = linear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const yellowBlue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.sqrt(a * a + yellowBlue * yellowBlue);
  const hue = chroma < 0.00001
    ? 260
    : (Math.atan2(yellowBlue, a) * 180 / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

function oklchToLinearRgb(value: Oklch): Rgb {
  const radians = value.h * Math.PI / 180;
  const a = value.c * Math.cos(radians);
  const b = value.c * Math.sin(radians);
  const l = (value.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (value.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (value.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function inGamut(rgb: Rgb): boolean {
  return rgb.r >= -0.000001 && rgb.r <= 1.000001
    && rgb.g >= -0.000001 && rgb.g <= 1.000001
    && rgb.b >= -0.000001 && rgb.b <= 1.000001;
}

function channel(value: number): string {
  return Math.round(Math.min(1, Math.max(0, gamma(value))) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function oklchToHex(lightness: number, chroma: number, hue: number): string {
  let low = 0;
  let high = Math.max(0, chroma);
  for (let index = 0; index < 16; index += 1) {
    const candidate = (low + high) / 2;
    if (inGamut(oklchToLinearRgb({ l: lightness, c: candidate, h: hue }))) low = candidate;
    else high = candidate;
  }
  const rgb = oklchToLinearRgb({ l: lightness, c: low, h: hue });
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

function scale(seed: Oklch, neutral: boolean): AppearanceTonalScale {
  const output = {} as AppearanceTonalScale;
  const chroma = neutral ? Math.min(seed.c * 0.09, 0.022) : Math.min(seed.c, 0.28);
  for (const tone of APPEARANCE_TONES) {
    output[tone] = oklchToHex(tone / 100, chroma, seed.h);
  }
  return output;
}

function luminance(value: string): number {
  const rgb = hexToRgb(value);
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

export function contrastRatio(left: string, right: string): number {
  const first = luminance(normalizeHex(left, "left color"));
  const second = luminance(normalizeHex(right, "right color"));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function contrastingForeground(background: string, dark: string, light: string): string {
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

function lightMode(primary: AppearanceTonalScale, neutral: AppearanceTonalScale, contrast: AppearanceContrast): AppearanceTokenSet {
  const primaryTone = contrast === "soft" ? 50 : contrast === "high" ? 30 : 40;
  const primaryHoverTone = contrast === "soft" ? 40 : contrast === "high" ? 20 : 30;
  const primaryPressedTone = contrast === "soft" ? 30 : contrast === "high" ? 10 : 20;
  const selected = primary[primaryTone];
  const onSelected = contrastingForeground(selected, neutral[0], neutral[100]);
  return {
    background: neutral[98],
    surface: neutral[100],
    surfaceRaised: neutral[100],
    surfaceHover: primary[95],
    surfaceSelected: primary[90],
    surfaceDisabled: neutral[95],
    primary: selected,
    primaryHover: primary[primaryHoverTone],
    primaryPressed: primary[primaryPressedTone],
    primaryContainer: primary[90],
    onBackground: neutral[10],
    onSurface: neutral[10],
    onSurfaceMuted: neutral[40],
    onPrimary: onSelected,
    onPrimaryContainer: primary[20],
    outline: neutral[80],
    outlineStrong: neutral[60],
    focusRing: primary[primaryTone],
    controlBackground: neutral[100],
    controlBackgroundHover: primary[95],
    controlBackgroundSelected: selected,
    controlBackgroundDisabled: neutral[95],
    controlText: primary[primaryTone],
    controlTextSelected: onSelected,
    controlTextDisabled: neutral[60],
    scrim: "rgba(0, 0, 0, 0.36)",
  };
}

function darkMode(primary: AppearanceTonalScale, neutral: AppearanceTonalScale, contrast: AppearanceContrast): AppearanceTokenSet {
  const primaryTone = contrast === "soft" ? 70 : contrast === "high" ? 90 : 80;
  const primaryHoverTone = contrast === "soft" ? 80 : contrast === "high" ? 95 : 90;
  const primaryPressedTone = contrast === "soft" ? 60 : contrast === "high" ? 80 : 70;
  const selected = primary[primaryTone];
  const onSelected = contrastingForeground(selected, neutral[0], neutral[100]);
  return {
    background: neutral[5],
    surface: neutral[10],
    surfaceRaised: neutral[20],
    surfaceHover: primary[20],
    surfaceSelected: primary[30],
    surfaceDisabled: neutral[20],
    primary: selected,
    primaryHover: primary[primaryHoverTone],
    primaryPressed: primary[primaryPressedTone],
    primaryContainer: primary[20],
    onBackground: neutral[95],
    onSurface: neutral[95],
    onSurfaceMuted: neutral[70],
    onPrimary: onSelected,
    onPrimaryContainer: primary[90],
    outline: neutral[30],
    outlineStrong: neutral[50],
    focusRing: primary[primaryTone],
    controlBackground: neutral[10],
    controlBackgroundHover: primary[20],
    controlBackgroundSelected: selected,
    controlBackgroundDisabled: neutral[20],
    controlText: primary[primaryTone],
    controlTextSelected: onSelected,
    controlTextDisabled: neutral[50],
    scrim: "rgba(0, 0, 0, 0.64)",
  };
}

export function generateAppearanceTokens(input: {
  seed: string;
  contrast?: AppearanceContrast;
  darkSeed?: string;
}): GeneratedAppearanceTokens {
  const seed = normalizeHex(input.seed, "seed");
  const darkSeed = input.darkSeed === undefined ? undefined : normalizeHex(input.darkSeed, "darkSeed");
  const contrast = input.contrast ?? "standard";
  if (!new Set<AppearanceContrast>(["soft", "standard", "high"]).has(contrast)) {
    throw new ExperienceValidationError("token-contrast", "contrast is unsupported");
  }
  const primarySource = rgbToOklch(hexToRgb(seed));
  const darkSource = darkSeed === undefined ? primarySource : rgbToOklch(hexToRgb(darkSeed));
  const primary = scale(primarySource, false);
  const neutral = scale(primarySource, true);
  const darkPrimary = scale(darkSource, false);
  const darkNeutral = scale(darkSource, true);
  return {
    recipe: {
      algorithm: APPEARANCE_TOKEN_ALGORITHM,
      seed,
      contrast,
      ...(darkSeed === undefined ? {} : { darkSeed }),
    },
    scales: { primary, neutral, darkPrimary, darkNeutral },
    modes: {
      light: lightMode(primary, neutral, contrast),
      dark: darkMode(darkPrimary, darkNeutral, contrast),
    },
  };
}

export function appearanceTokenCssVariables(tokens: AppearanceTokenSet): Record<string, string> {
  return Object.fromEntries(APPEARANCE_TOKEN_KEYS.map((key) => [
    `--cek-${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
    tokens[key],
  ]));
}

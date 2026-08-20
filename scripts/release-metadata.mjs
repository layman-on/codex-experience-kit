import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function releaseChannel(version) {
  if (/^\d+\.\d+\.\d+$/u.test(version)) return { distTag: "latest", prerelease: false };
  const prerelease = /^\d+\.\d+\.\d+-(beta|next)\.([1-9]\d*)$/u.exec(version);
  if (!prerelease) {
    throw new Error("Release versions must be stable, -beta.N, or -next.N semantic versions");
  }
  return { distTag: prerelease[1], prerelease: true };
}

export function resolveReleaseMetadata({ packageJson, changelog, tag }) {
  if (!packageJson || typeof packageJson !== "object") throw new Error("package.json must contain an object");
  if (typeof packageJson.name !== "string" || !packageJson.name.trim()) throw new Error("package.json name is required");
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) throw new Error("package.json version is required");
  if (typeof tag !== "string" || !tag.trim()) throw new Error("A release tag is required");

  const expectedTag = `v${packageJson.version}`;
  if (tag !== expectedTag) throw new Error(`Release tag ${tag} must exactly match package version ${expectedTag}`);
  const channel = releaseChannel(packageJson.version);
  const changelogHeading = new RegExp(`^## ${escapeRegularExpression(packageJson.version)} - \\d{4}-\\d{2}-\\d{2}$`, "mu");
  if (!changelogHeading.test(changelog)) {
    throw new Error(`CHANGELOG.md must contain a dated section for ${packageJson.version}`);
  }
  return {
    packageName: packageJson.name,
    version: packageJson.version,
    tag,
    ...channel,
  };
}

async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const [packageSource, changelog] = await Promise.all([
    fs.readFile(path.join(root, "package.json"), "utf8"),
    fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"),
  ]);
  const metadata = resolveReleaseMetadata({ packageJson: JSON.parse(packageSource), changelog, tag });
  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `package_name=${metadata.packageName}`,
      `version=${metadata.version}`,
      `tag=${metadata.tag}`,
      `dist_tag=${metadata.distTag}`,
      `prerelease=${String(metadata.prerelease)}`,
    ];
    await fs.appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  console.log(JSON.stringify(metadata));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("..", import.meta.url),
  maxBuffer: 8 * 1024 * 1024,
});
const [report] = JSON.parse(stdout);
if (!report || !Array.isArray(report.files)) throw new Error("npm pack did not return a file inventory");

const files = report.files.map((entry) => entry.path);
const required = [
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
  "docs/open-source-compliance.md",
];
const missing = required.filter((name) => !files.includes(name));
const forbidden = files.filter((name) => (
  name.startsWith("theme-output/")
  || /\.(?:gif|jpe?g|mp3|mp4|png|tgz|webp|zip)$/iu.test(name)
));

if (missing.length || forbidden.length) {
  throw new Error([
    missing.length ? `Missing required notices: ${missing.join(", ")}` : "",
    forbidden.length ? `Unexpected generated/media files: ${forbidden.join(", ")}` : "",
  ].filter(Boolean).join("\n"));
}

console.log(`Compliant npm package inventory: ${report.name}@${report.version}, ${files.length} files`);

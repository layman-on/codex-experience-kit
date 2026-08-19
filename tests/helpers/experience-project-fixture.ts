import fs from "node:fs/promises";
import path from "node:path";

export async function writeProject(directory: string, input: { id?: string; name?: string; extraHtml?: string } = {}): Promise<void> {
  await fs.mkdir(path.join(directory, "assets"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "experience.manifest.json"), JSON.stringify({
      apiVersion: 1,
      id: input.id ?? "fixture.portal",
      name: input.name ?? "Fixture Portal",
      version: "1.0.0",
      entry: "index.html",
      permissions: ["appearance.tokens", "host.actions"],
    })),
    fs.writeFile(path.join(directory, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="assets/experience.css"></head><body>
      <codex-experience-surface target="app-shell" plane="underlay" interaction="passthrough"><img src="assets/pixel.png"><div class="portal">Portal</div></codex-experience-surface>
      <codex-experience-surface target="workspace" plane="overlay" interaction="interactive"><button data-codex-action="hello">Hello</button></codex-experience-surface>
      ${input.extraHtml ?? ""}<script src="assets/experience.js"></script></body></html>`),
    fs.writeFile(path.join(directory, "assets/experience.css"), ".portal{color:var(--cek-primary);background-image:url('./pixel.png')}"),
    fs.writeFile(path.join(directory, "assets/experience.js"), "window.codexExperience?.lifecycle.ready();"),
    fs.writeFile(path.join(directory, "assets/pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")),
  ]);
}

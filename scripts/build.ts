// Build the distributable CLI: two single-file Node bundles (main CLI + queue
// daemon) plus the packaged config.json, preserved into dist/. The bundles run
// on plain Node (>=18.17) and on Bun — no install-time build needed.
import { build } from "bun";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const pkgMeta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; name: string };
writeFileSync(join(outdir, "version.json"), JSON.stringify({ name: pkgMeta.name, version: pkgMeta.version }) + "\n");

async function bundle(entry: string, out: string): Promise<void> {
  const result = await build({
    entrypoints: [join(root, entry)],
    outdir,
    naming: out,
    target: "node",
    sourcemap: "none",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const full = join(outdir, out);
  const text = readFileSync(full, "utf8");
  if (!text.startsWith("#!")) {
    writeFileSync(full, "#!/usr/bin/env node\n" + text, "utf8");
  }
  chmodSync(full, 0o755);
}

await bundle("src/cli.ts", "vibecoder.js");
await bundle("src/daemon.ts", "vibecoder-queue.js");

copyFileSync(join(root, "config.json"), join(outdir, "config.json"));
console.log("dist/vibecoder.js · dist/vibecoder-queue.js · dist/version.json · dist/config.json");
import esbuild from "esbuild";
import { copyFile, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});

const sourceAssets = path.join(packageRoot, "assets/upstream/kenney");
const builtAssets = path.join(packageRoot, "dist/ui/assets/kenney");
await mkdir(builtAssets, { recursive: true });
await cp(sourceAssets, builtAssets, { recursive: true, force: true });

const sourceMonsterAssets = path.join(packageRoot, "assets/upstream/kenney-blocky");
const builtMonsterAssets = path.join(packageRoot, "dist/ui/assets/kenney-blocky");
await mkdir(builtMonsterAssets, { recursive: true });
await cp(sourceMonsterAssets, builtMonsterAssets, { recursive: true, force: true });

const sourceLicense = path.join(packageRoot, "assets/upstream/AGENT_OFFICE_LICENSE.txt");
const builtLicense = path.join(packageRoot, "dist/ui/assets/licenses/Agent-Office-MIT.txt");
await mkdir(path.dirname(builtLicense), { recursive: true });
await copyFile(sourceLicense, builtLicense);

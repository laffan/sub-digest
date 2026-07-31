/**
 * Sets the app version in the three places it lives: package.json,
 * src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
 *
 *   node scripts/set-version.mjs 0.2.0
 *
 * With no argument it prints the current version from tauri.conf.json, which
 * is what the release workflow treats as the source of truth.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  pkg: join(root, "package.json"),
  conf: join(root, "src-tauri", "tauri.conf.json"),
  cargo: join(root, "src-tauri", "Cargo.toml"),
};

const current = JSON.parse(readFileSync(paths.conf, "utf8")).version;

const next = process.argv[2];
if (!next) {
  process.stdout.write(`${current}\n`);
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`Not a version: ${next} (expected e.g. 0.2.0)`);
  process.exit(1);
}

/** Rewrites a JSON file's top-level `version` without disturbing its layout. */
function setJsonVersion(path) {
  const text = readFileSync(path, "utf8");
  const updated = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${next}"`);
  if (updated === text) throw new Error(`No version field in ${path}`);
  writeFileSync(path, updated);
}

setJsonVersion(paths.pkg);
setJsonVersion(paths.conf);

// Cargo.toml: only the version in the [package] table, not a dependency's.
const cargo = readFileSync(paths.cargo, "utf8");
const updatedCargo = cargo.replace(
  /(\[package\][^[]*?\nversion\s*=\s*)"[^"]*"/,
  `$1"${next}"`
);
if (updatedCargo === cargo) throw new Error("No [package] version in Cargo.toml");
writeFileSync(paths.cargo, updatedCargo);

console.log(`Version ${current} -> ${next}`);

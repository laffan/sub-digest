// Prints the path to the most recently built iOS .app bundle, preferring a
// device (iphoneos) build over a simulator one. Used by the `ios:deploy`
// script to hand `ios-deploy --bundle` the right artifact.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src-tauri/gen/apple/build";

if (!existsSync(ROOT)) {
  console.error(`No iOS build output at ${ROOT}. Run "tauri ios build" first.`);
  process.exit(1);
}

/** Collects .app bundle directories without descending into them. */
function findApps(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (name.endsWith(".app")) acc.push({ path: p, mtime: s.mtimeMs });
    else findApps(p, acc);
  }
  return acc;
}

let apps = findApps(ROOT);
// ios-deploy targets a physical device, so drop simulator builds when possible.
const device = apps.filter((a) => !/simulator|iphonesimulator/i.test(a.path));
if (device.length) apps = device;

if (apps.length === 0) {
  console.error(`No .app bundle found under ${ROOT}.`);
  process.exit(1);
}

apps.sort((a, b) => b.mtime - a.mtime);
process.stdout.write(apps[0].path);

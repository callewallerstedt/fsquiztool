import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function hasGoogleDriveEnv(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_FOLDER_ID &&
      (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS),
  );
}

function hasLocalDocs(): boolean {
  return fs.existsSync(path.join(process.cwd(), "data", "files"));
}

function hasBuiltIndex(): boolean {
  return fs.existsSync(path.join(process.cwd(), "data", "index", "bundle.json"));
}

if (hasGoogleDriveEnv()) {
  run("npm", ["run", "docs:sync"]);
  run("npm", ["run", "docs:index"]);
} else if (hasLocalDocs()) {
  run("npm", ["run", "docs:index"]);
} else if (!hasBuiltIndex()) {
  // Allow deploy even without docs; app will show a helpful error until index exists.
  console.log("Skipping docs index (no Google Drive env and no data/files/ present).");
}

run("npm", ["run", "build"]);

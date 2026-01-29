import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import { loadEnv } from "./load-env";

type ManifestFile = {
  id: string;
  name: string;
  path?: string;
  mimeType?: string;
  md5Checksum?: string;
  bytes?: number;
  modifiedTime?: string;
  webViewLink?: string;
};

function rootPath(...parts: string[]) {
  return path.join(process.cwd(), ...parts);
}

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

function sanitizeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

async function getDriveClient() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("Missing GOOGLE_DRIVE_FOLDER_ID");

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let auth;
  if (saJson) {
    const credentials = JSON.parse(saJson);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  } else if (credentialsPath) {
    auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  } else {
    throw new Error(
      "Missing Google auth. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS",
    );
  }

  const drive = google.drive({ version: "v3", auth });
  return { drive, folderId };
}

async function listAllFilesInFolder(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];

  const listChildren = async (parentId: string, basePath: string) => {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${parentId}' in parents and trashed=false`,
        fields:
          "nextPageToken, files(id, name, mimeType, md5Checksum, size, modifiedTime, webViewLink)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = (res.data.files ?? []) as drive_v3.Schema$File[];
      for (const f of files) {
        const name = f.name ? String(f.name) : "";
        const safeSegment = sanitizeFileName(name);
        const relPath = basePath ? `${basePath}/${safeSegment}` : safeSegment;

        const mimeType = f.mimeType ?? undefined;
        const isFolder = mimeType === "application/vnd.google-apps.folder";
        if (isFolder) {
          if (f.id) await listChildren(String(f.id), relPath);
          continue;
        }

        out.push({
          id: String(f.id),
          name,
          path: relPath,
          mimeType,
          md5Checksum: f.md5Checksum ?? undefined,
          bytes: f.size ? Number(f.size) : undefined,
          modifiedTime: f.modifiedTime ?? undefined,
          webViewLink: f.webViewLink ?? undefined,
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  };

  await listChildren(folderId, "");
  return out;
}

async function downloadFile(drive: drive_v3.Drive, fileId: string, destPath: string) {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" as unknown as undefined },
  );

  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    const stream = res.data as unknown as NodeJS.ReadableStream;
    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });
}

async function main() {
  loadEnv();
  const { drive, folderId } = await getDriveClient();
  const outDir = rootPath("data", "files");
  await ensureDir(outDir);

  const files = await listAllFilesInFolder(drive, folderId);
  const allowedExt = new Set([".pdf", ".txt", ".py", ".m"]);
  const filtered = files.filter((f) => allowedExt.has(path.extname(f.path ?? f.name).toLowerCase()));

  const manifestPath = rootPath("data", "drive-manifest.json");
  let prev: { files: ManifestFile[] } | null = null;
  try {
    prev = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch {
    prev = null;
  }
  const prevById = new Map<string, ManifestFile>();
  for (const f of prev?.files ?? []) prevById.set(f.id, f);

  let downloaded = 0;
  for (const f of filtered) {
    const relPath = f.path ? f.path : sanitizeFileName(f.name);
    const dest = path.join(outDir, ...relPath.split("/"));
    await ensureDir(path.dirname(dest));
    const prevFile = prevById.get(f.id);
    const unchanged =
      prevFile &&
      prevFile.md5Checksum &&
      f.md5Checksum &&
      prevFile.md5Checksum === f.md5Checksum &&
      fs.existsSync(dest);

    if (unchanged) continue;

    await downloadFile(drive, f.id, dest);
    downloaded++;
    process.stdout.write(`Downloaded ${relPath}\n`);
  }

  const out = {
    syncedAt: new Date().toISOString(),
    folderId,
    files: filtered.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      mimeType: f.mimeType,
      md5Checksum: f.md5Checksum,
      bytes: f.bytes,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
    })),
  };

  await ensureDir(rootPath("data"));
  await fsp.writeFile(manifestPath, JSON.stringify(out, null, 2), "utf8");

  console.log(`Sync done. Downloaded ${downloaded} files. Wrote data/drive-manifest.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

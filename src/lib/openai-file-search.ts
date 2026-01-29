import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";

export type FileGroup = "handbook" | "rules" | "pdf" | "script";

export type LocalFile = {
  fullPath: string;
  relPath: string; // relative to data/files, with forward slashes
  ext: string;
  bytes: number;
  mtimeMs: number;
  group: FileGroup;
  year?: string;
};

type SyncEntry = {
  relPath: string;
  ext: string;
  bytes: number;
  mtimeMs: number;
  group: FileGroup;
  year?: string;
  openaiFileId: string;
  vectorStoreFileId: string;
};

type SyncState = {
  vectorStoreId?: string;
  files: Record<string, SyncEntry>;
  lastSyncAt?: string;
};

declare global {
  var __fredquiz_openai_sync_lock: Promise<void> | undefined;
}

function dataFilesRoot() {
  return path.join(process.cwd(), "data", "files");
}

function syncStatePath() {
  return path.join(process.cwd(), "data", "openai-sync.json");
}

function normalizeRelPath(p: string) {
  return p.replace(/\\/g, "/");
}

function inferYear(s: string): string | undefined {
  const m = s.match(/(?:19|20)\d{2}/);
  return m?.[0];
}

function isHandbooksRelPath(relPath: string) {
  const parts = normalizeRelPath(relPath)
    .split("/")
    .map((p) => p.toLowerCase());
  return parts.some((p) => p.includes("handbooks") || p.includes("hanbooks") || p.includes("handbook"));
}

function groupForFile(relPath: string, ext: string): FileGroup | null {
  const base = path.basename(relPath).toLowerCase();
  if (ext === "pdf") {
    if (base.includes("handbook")) return "handbook";
    if (base.includes("rules") || base.includes("rulebook")) return "rules";
    return "pdf";
  }

  // Only index scripts outside any handbooks folder.
  if (isHandbooksRelPath(relPath)) return null;
  return "script";
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
      continue;
    }
    if (e.isFile()) out.push(full);
  }
  return out;
}

export async function listLocalEligibleFiles(): Promise<LocalFile[]> {
  const root = dataFilesRoot();
  let filesOnDisk: string[] = [];
  try {
    filesOnDisk = await listFilesRecursive(root);
  } catch {
    return [];
  }

  const allowedExt = new Set(["pdf", "txt", "py", "m"]);
  const locals: LocalFile[] = [];

  for (const fullPath of filesOnDisk) {
    const relPath = normalizeRelPath(path.relative(root, fullPath));
    const ext = path.extname(relPath).toLowerCase().replace(/^\./, "");
    if (!allowedExt.has(ext)) continue;

    const st = await fsPromises.stat(fullPath);
    const group = groupForFile(relPath, ext);
    if (!group) continue;

    locals.push({
      fullPath,
      relPath,
      ext,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      group,
      year: ext === "pdf" ? inferYear(relPath) : undefined,
    });
  }

  locals.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return locals;
}

export async function listAvailablePdfYears(): Promise<string[]> {
  const locals = await listLocalEligibleFiles();
  const years = new Set<string>();
  for (const f of locals) {
    if (f.ext !== "pdf") continue;
    if (f.year) years.add(f.year);
  }
  return Array.from(years).sort((a, b) => b.localeCompare(a));
}

async function readSyncState(): Promise<SyncState> {
  const p = syncStatePath();
  try {
    const raw = await fsPromises.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    return {
      vectorStoreId: parsed.vectorStoreId,
      files: parsed.files ?? {},
      lastSyncAt: parsed.lastSyncAt,
    };
  } catch {
    return { files: {} };
  }
}

async function writeSyncState(state: SyncState) {
  const p = syncStatePath();
  try {
    await fsPromises.mkdir(path.dirname(p), { recursive: true });
    await fsPromises.writeFile(p, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Ignore write failures (e.g. read-only filesystem on serverless).
  }
}

async function ensureVectorStoreId(client: OpenAI): Promise<string> {
  const env = process.env.OPENAI_VECTOR_STORE_ID?.trim();
  if (env) return env;

  const state = await readSyncState();
  if (state.vectorStoreId) return state.vectorStoreId;

  const created = await client.vectorStores.create({
    name: "FS QuizTool (local files)",
    metadata: { app: "fs-quiztool" },
  });
  state.vectorStoreId = created.id;
  state.lastSyncAt = new Date().toISOString();
  await writeSyncState(state);
  return created.id;
}

export async function getVectorStoreId(client: OpenAI): Promise<string> {
  return await ensureVectorStoreId(client);
}

function makeAttributes(f: LocalFile) {
  const attrs: Record<string, string | number | boolean> = {
    relPath: f.relPath,
    ext: f.ext,
    group: f.group,
  };
  if (f.year) attrs.year = f.year;
  return attrs;
}

async function uploadableForLocalFile(local: LocalFile) {
  if (local.ext.toLowerCase() === "m") {
    const buf = await fsPromises.readFile(local.fullPath);
    const base = path.basename(local.relPath, path.extname(local.relPath));
    return await toFile(buf, `${base}.txt`);
  }
  return fs.createReadStream(local.fullPath);
}

export type SyncSelectionParams = {
  year?: string;
  handbookFile?: string;
  rulesFile?: string;
};

function selectDesiredRelPaths(all: LocalFile[], selection: SyncSelectionParams): Set<string> {
  const desired = new Set<string>();

  // Always: scripts outside handbooks folders.
  for (const f of all) {
    if (f.group === "script") desired.add(f.relPath);
  }

  // Preferred: explicit handbook/rules PDFs from setup screen.
  if (selection.handbookFile) desired.add(selection.handbookFile);
  if (selection.rulesFile) desired.add(selection.rulesFile);

  // Fallback: if no explicit PDFs selected, include all PDFs for the year.
  if (!selection.handbookFile && !selection.rulesFile && selection.year) {
    for (const f of all) {
      if (f.ext === "pdf" && f.year === selection.year) desired.add(f.relPath);
    }
  }

  return desired;
}

export async function syncOpenAIFiles(client: OpenAI) {
  const vectorStoreId = await ensureVectorStoreId(client);
  const allLocal = await listLocalEligibleFiles();
  const desiredRelPaths = new Set(allLocal.map((f) => f.relPath));
  const localByRel = new Map(allLocal.map((f) => [f.relPath, f] as const));

  const state = await readSyncState();
  state.files = state.files ?? {};

  const lock = globalThis.__fredquiz_openai_sync_lock;
  if (lock) await lock;

  let lockResolve: (() => void) | null = null;
  globalThis.__fredquiz_openai_sync_lock = new Promise<void>((resolve) => {
    lockResolve = resolve;
  });

  let uploaded = 0;
  let removed = 0;
  let kept = 0;

  try {
    // Remove entries that are missing locally.
    for (const [relPath, entry] of Object.entries(state.files)) {
      const local = localByRel.get(relPath);
      if (!local) {
        try {
          await client.vectorStores.files.delete(entry.vectorStoreFileId, {
            vector_store_id: vectorStoreId,
          });
        } catch {
          // ignore
        }
        try {
          await client.files.delete(entry.openaiFileId);
        } catch {
          // ignore
        }
        delete state.files[relPath];
        removed += 1;
      }
    }

    // Ensure desired files exist and are up to date.
    for (const relPath of desiredRelPaths) {
      const local = localByRel.get(relPath);
      if (!local) continue;

      const prev = state.files[relPath];
      const unchanged =
        prev &&
        prev.bytes === local.bytes &&
        Math.abs(prev.mtimeMs - local.mtimeMs) < 1 &&
        prev.group === local.group;

      if (unchanged) {
        kept += 1;
        continue;
      }

      if (prev) {
        try {
          await client.vectorStores.files.delete(prev.vectorStoreFileId, {
            vector_store_id: vectorStoreId,
          });
        } catch {
          // ignore
        }
        try {
          await client.files.delete(prev.openaiFileId);
        } catch {
          // ignore
        }
        delete state.files[relPath];
      }

      const uploadedFile = await client.files.create({
        file: await uploadableForLocalFile(local),
        purpose: "assistants",
      });

      const vsFile = await client.vectorStores.files.createAndPoll(vectorStoreId, {
        file_id: uploadedFile.id,
        attributes: makeAttributes(local),
      });

      state.files[relPath] = {
        relPath,
        ext: local.ext,
        bytes: local.bytes,
        mtimeMs: local.mtimeMs,
        group: local.group,
        year: local.year,
        openaiFileId: uploadedFile.id,
        vectorStoreFileId: vsFile.id,
      };

      uploaded += 1;
    }

    state.vectorStoreId = vectorStoreId;
    state.lastSyncAt = new Date().toISOString();
    await writeSyncState(state);

    return {
      ok: true as const,
      vectorStoreId,
      desiredCount: desiredRelPaths.size,
      uploaded,
      removed,
      kept,
      lastSyncAt: state.lastSyncAt,
    };
  } finally {
    if (lockResolve) lockResolve();
    globalThis.__fredquiz_openai_sync_lock = undefined;
  }
}

export async function syncOpenAIForSelection(client: OpenAI, selection: SyncSelectionParams) {
  const vectorStoreId = await ensureVectorStoreId(client);
  const allLocal = await listLocalEligibleFiles();
  const desiredRelPaths = selectDesiredRelPaths(allLocal, selection);
  const localByRel = new Map(allLocal.map((f) => [f.relPath, f] as const));

  const state = await readSyncState();
  state.files = state.files ?? {};

  const lock = globalThis.__fredquiz_openai_sync_lock;
  if (lock) await lock;

  let lockResolve: (() => void) | null = null;
  globalThis.__fredquiz_openai_sync_lock = new Promise<void>((resolve) => {
    lockResolve = resolve;
  });

  let uploaded = 0;
  let removed = 0;
  let kept = 0;

  try {
    // Remove entries that are missing locally (keeps OpenAI storage aligned).
    for (const [relPath, entry] of Object.entries(state.files)) {
      const local = localByRel.get(relPath);
      if (!local) {
        try {
          await client.vectorStores.files.delete(entry.vectorStoreFileId, {
            vector_store_id: vectorStoreId,
          });
        } catch {
          // ignore
        }
        try {
          await client.files.delete(entry.openaiFileId);
        } catch {
          // ignore
        }
        delete state.files[relPath];
        removed += 1;
      }
    }

    // Ensure selected files exist and are up to date.
    for (const relPath of desiredRelPaths) {
      const local = localByRel.get(relPath);
      if (!local) continue;

      const prev = state.files[relPath];
      const unchanged =
        prev &&
        prev.bytes === local.bytes &&
        Math.abs(prev.mtimeMs - local.mtimeMs) < 1 &&
        prev.group === local.group;

      if (unchanged) {
        kept += 1;
        continue;
      }

      if (prev) {
        try {
          await client.vectorStores.files.delete(prev.vectorStoreFileId, {
            vector_store_id: vectorStoreId,
          });
        } catch {
          // ignore
        }
        try {
          await client.files.delete(prev.openaiFileId);
        } catch {
          // ignore
        }
        delete state.files[relPath];
      }

      const uploadedFile = await client.files.create({
        file: await uploadableForLocalFile(local),
        purpose: "assistants",
      });

      const vsFile = await client.vectorStores.files.createAndPoll(vectorStoreId, {
        file_id: uploadedFile.id,
        attributes: makeAttributes(local),
      });

      state.files[relPath] = {
        relPath,
        ext: local.ext,
        bytes: local.bytes,
        mtimeMs: local.mtimeMs,
        group: local.group,
        year: local.year,
        openaiFileId: uploadedFile.id,
        vectorStoreFileId: vsFile.id,
      };

      uploaded += 1;
    }

    state.vectorStoreId = vectorStoreId;
    state.lastSyncAt = new Date().toISOString();
    await writeSyncState(state);

    return {
      ok: true as const,
      vectorStoreId,
      desiredCount: desiredRelPaths.size,
      uploaded,
      removed,
      kept,
      lastSyncAt: state.lastSyncAt,
    };
  } finally {
    if (lockResolve) lockResolve();
    globalThis.__fredquiz_openai_sync_lock = undefined;
  }
}

export function buildFileSearchFilters(selection: SyncSelectionParams) {
  const filters: Array<{ type: "eq"; key: string; value: string | number | boolean }> = [
    { type: "eq", key: "group", value: "script" },
    // Always allow non-year PDFs (coursebooks/formula sheets/etc).
    { type: "eq", key: "group", value: "pdf" },
  ];
  if (selection.handbookFile) filters.push({ type: "eq", key: "relPath", value: selection.handbookFile });
  if (selection.rulesFile) filters.push({ type: "eq", key: "relPath", value: selection.rulesFile });
  // If a year is selected, include year-tagged docs (handbooks/rules/etc) without excluding non-year PDFs above.
  if (selection.year) filters.push({ type: "eq", key: "year", value: selection.year });
  return { type: "or" as const, filters };
}

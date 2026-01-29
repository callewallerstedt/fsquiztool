import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

type SyncEntry = {
  vectorStoreFileId: string;
};

type SyncState = {
  files?: Record<string, SyncEntry>;
};

type VectorStoreFileLite = {
  id: string;
  created_at: number;
  status: "in_progress" | "completed" | "cancelled" | "failed";
  attributes?: Record<string, string | number | boolean> | null;
  // Not in the SDK types, but may be present in API responses.
  file_id?: string;
};

function statePath() {
  return path.join(process.cwd(), "data", "openai-sync.json");
}

async function readSyncState(): Promise<SyncState | null> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function pickRelPath(attrs: VectorStoreFileLite["attributes"]) {
  if (!attrs) return null;
  const relPath = attrs.relPath;
  return typeof relPath === "string" && relPath.trim() ? relPath.trim() : null;
}

function bestCandidate(files: VectorStoreFileLite[]) {
  const completed = files.filter((f) => f.status === "completed");
  const pool = completed.length ? completed : files;
  return pool.slice().sort((a, b) => b.created_at - a.created_at)[0]!;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID?.trim();
  const dryRun = process.argv.includes("--dry-run");

  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY.");
    process.exit(1);
  }
  if (!vectorStoreId) {
    console.error("Missing OPENAI_VECTOR_STORE_ID.");
    process.exit(1);
  }

  const state = await readSyncState();
  const preferredByRelPath = state?.files ?? {};

  const client = new OpenAI({ apiKey });

  const byRelPath = new Map<string, VectorStoreFileLite[]>();
  let total = 0;

  for await (const f of client.vectorStores.files.list(vectorStoreId, { limit: 100 })) {
    const file = f as unknown as VectorStoreFileLite;
    total += 1;
    const relPath = pickRelPath(file.attributes);
    if (!relPath) continue;
    const arr = byRelPath.get(relPath) ?? [];
    arr.push(file);
    byRelPath.set(relPath, arr);
  }

  const duplicates = Array.from(byRelPath.entries()).filter(([, files]) => files.length > 1);
  duplicates.sort((a, b) => a[0].localeCompare(b[0]));

  let deleted = 0;
  let groups = 0;

  for (const [relPath, files] of duplicates) {
    const preferredId = preferredByRelPath[relPath]?.vectorStoreFileId;
    const keep =
      (preferredId ? files.find((f) => f.id === preferredId) : null) ?? bestCandidate(files);

    const remove = files.filter((f) => f.id !== keep.id);
    if (!remove.length) continue;

    groups += 1;
    console.log(
      `[dedupe] ${relPath}\n  keep: ${keep.id} (${keep.status}, created_at=${keep.created_at})\n  remove: ${remove
        .map((r) => `${r.id} (${r.status}, created_at=${r.created_at})`)
        .join(", ")}`,
    );

    if (dryRun) continue;

    for (const r of remove) {
      await client.vectorStores.files.delete(r.id, { vector_store_id: vectorStoreId });
      deleted += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        vectorStoreId,
        totalVectorStoreFiles: total,
        duplicateGroups: duplicates.length,
        dedupedGroups: groups,
        deletedVectorStoreFiles: deleted,
        dryRun,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


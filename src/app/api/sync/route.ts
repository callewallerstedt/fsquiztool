import { NextResponse } from "next/server";
import { getOpenAIClient } from "@/lib/openai";
import { listLocalEligibleFiles, syncOpenAIFiles } from "@/lib/openai-file-search";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 300;

function statePath() {
  return path.join(process.cwd(), "data", "openai-sync.json");
}

async function readState(): Promise<{ vectorStoreId?: string; lastSyncAt?: string; syncedCount?: number }> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as { vectorStoreId?: string; lastSyncAt?: string; files?: Record<string, unknown> };
    const syncedCount = parsed.files ? Object.keys(parsed.files).length : 0;
    return { vectorStoreId: parsed.vectorStoreId, lastSyncAt: parsed.lastSyncAt, syncedCount };
  } catch {
    return {};
  }
}

export async function GET() {
  const locals = await listLocalEligibleFiles();
  const state = await readState();
  return NextResponse.json({
    ok: true as const,
    localEligibleCount: locals.length,
    vectorStoreId: process.env.OPENAI_VECTOR_STORE_ID?.trim() || state.vectorStoreId || null,
    lastSyncAt: state.lastSyncAt ?? null,
    syncedCount: typeof state.syncedCount === "number" ? state.syncedCount : null,
  });
}

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        ok: false as const,
        error: "Sync is disabled in production. Run `npm run openai:sync` locally and set OPENAI_VECTOR_STORE_ID on Vercel.",
      },
      { status: 403 },
    );
  }
  const client = getOpenAIClient();
  const res = await syncOpenAIFiles(client);
  return NextResponse.json(res);
}

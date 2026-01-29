import { NextResponse } from "next/server";
import { listAvailablePdfYears, listLocalEligibleFiles } from "@/lib/openai-file-search";
import { getOpenAIClient } from "@/lib/openai";
import { getVectorStoreId } from "@/lib/openai-file-search";

export async function GET() {
  const apiKeyOk = Boolean(process.env.OPENAI_API_KEY);
  const locals = await listLocalEligibleFiles();
  const localYears = await listAvailablePdfYears();
  const localCount = locals.length;

  if (!apiKeyOk) {
    return NextResponse.json({
      generatedAt: null,
      years: localYears.length ? localYears : ["2026", "2025", "2024"],
      fileCount: localCount,
      chunkCount: 0,
      indexReady: false,
      message: "Missing OPENAI_API_KEY. Add it to .env.local to enable OpenAI file search.",
    });
  }

  let years = localYears;
  let fileCount = localCount;

  const hasVectorStoreEnv = Boolean(process.env.OPENAI_VECTOR_STORE_ID?.trim());
  if ((!years.length || fileCount === 0) && hasVectorStoreEnv) {
    try {
      const client = getOpenAIClient();
      const vectorStoreId = await getVectorStoreId(client);
      const remoteYears = new Set<string>();
      let remoteCount = 0;
      for await (const f of client.vectorStores.files.list(vectorStoreId, { limit: 100, filter: "completed" })) {
        const attrs = f.attributes ?? null;
        if (!attrs || typeof attrs !== "object") continue;
        const ext = typeof attrs.ext === "string" ? attrs.ext : null;
        const year = typeof attrs.year === "string" ? attrs.year : null;
        if (ext === "pdf" && year && /^(?:19|20)\d{2}$/.test(year)) remoteYears.add(year);
        remoteCount += 1;
      }
      const remoteYearsList = Array.from(remoteYears).sort((a, b) => b.localeCompare(a));
      if (remoteYearsList.length) years = remoteYearsList;
      if (fileCount === 0 && remoteCount > 0) fileCount = remoteCount;
    } catch {
      // ignore and fall back to local discovery
    }
  }

  return NextResponse.json({
    generatedAt: null,
    years: years.length ? years : ["2026", "2025", "2024"],
    fileCount,
    chunkCount: 0,
    indexReady: true,
    message:
      fileCount === 0
        ? hasVectorStoreEnv
          ? "No synced files found in your vector store yet. Run `npm run openai:sync` locally once."
          : "No local files found in data/files. Add PDFs/scripts there (or set OPENAI_VECTOR_STORE_ID to use a synced store)."
        : hasVectorStoreEnv
          ? "Using OpenAI file storage + file search."
          : "Using local files + OpenAI file search (set OPENAI_VECTOR_STORE_ID to reuse a synced store).",
  });
}

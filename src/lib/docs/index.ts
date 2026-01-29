import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";
import type { AsPlainObject, SearchResult } from "minisearch";
import type { Chunk, IndexBundle, RetrievedChunk } from "./types";

type LoadedIndex = {
  bundle: IndexBundle;
  mini: MiniSearch;
  chunksById: Map<string, Chunk>;
  driveByFileId: Map<string, { fileId: string; webViewLink?: string }>;
  indexPath: string;
  mtimeMs: number;
};

declare global {
  var __fredquiz_index: LoadedIndex | undefined;
}

function dataPath(): string {
  return (
    process.env.DOCS_INDEX_PATH ??
    path.join(process.cwd(), "data", "index", "bundle.json")
  );
}

export class MissingIndexError extends Error {
  public readonly indexPath: string;
  constructor(indexPath: string) {
    super(
      `Missing docs index at ${indexPath}. Put files in data/files and run \`npm run docs:index\`.`,
    );
    this.name = "MissingIndexError";
    this.indexPath = indexPath;
  }
}

export function isIndexReady(): boolean {
  return fsSync.existsSync(dataPath());
}

async function loadIndex(): Promise<LoadedIndex> {
  const indexPath = dataPath();
  let mtimeMs = 0;
  try {
    mtimeMs = fsSync.statSync(indexPath).mtimeMs;
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
      throw new MissingIndexError(indexPath);
    }
    throw e;
  }

  if (
    globalThis.__fredquiz_index &&
    globalThis.__fredquiz_index.indexPath === indexPath &&
    globalThis.__fredquiz_index.mtimeMs === mtimeMs
  ) {
    return globalThis.__fredquiz_index;
  }

  let bundleRaw: string;
  try {
    bundleRaw = await fs.readFile(indexPath, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
      throw new MissingIndexError(indexPath);
    }
    throw e;
  }
  const bundle = JSON.parse(bundleRaw) as IndexBundle;

  const mini = MiniSearch.loadJS(bundle.miniSearch as AsPlainObject, {
    fields: ["text", "fileName"],
    storeFields: ["chunkId"],
    searchOptions: {
      boost: { fileName: 4, text: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });

  const chunksById = new Map<string, Chunk>();
  for (const c of bundle.chunks) chunksById.set(c.chunkId, c);

  const driveByFileId = new Map<string, { fileId: string; webViewLink?: string }>();
  for (const f of bundle.files) {
    if (f.drive) driveByFileId.set(f.id, f.drive);
  }

  const loaded: LoadedIndex = { bundle, mini, chunksById, driveByFileId, indexPath, mtimeMs };
  globalThis.__fredquiz_index = loaded;
  return loaded;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function extractTerms(input: string): string[] {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean);
  const stop = new Set([
    "och",
    "att",
    "det",
    "den",
    "som",
    "vad",
    "hur",
    "är",
    "ska",
    "kan",
    "för",
    "med",
    "till",
    "på",
    "i",
    "av",
    "en",
    "ett",
    "the",
    "a",
    "an",
    "to",
    "of",
    "in",
    "on",
    "and",
    "or",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "for",
    "with",
    "from",
    "by",
    "as",
    "at",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "what",
    "how",
    "can",
    "could",
    "should",
    "would",
    "may",
    "might",
    "shall",
    "must",
  ]);
  return uniq(cleaned.filter((t) => t.length >= 2 && !stop.has(t))).slice(0, 12);
}

function makeExcerpt(text: string, terms: string[], maxLen = 900): string {
  const hay = text.replace(/\s+/g, " ").trim();
  if (!hay) return "";

  const lower = hay.toLowerCase();
  let bestIdx = -1;
  let bestTerm = "";
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestTerm = term;
    }
  }

  if (bestIdx === -1) return hay.length <= maxLen ? hay : `${hay.slice(0, maxLen)}...`;

  const pad = Math.floor((maxLen - bestTerm.length) / 2);
  const start = Math.max(0, bestIdx - pad);
  const end = Math.min(hay.length, bestIdx + bestTerm.length + pad);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < hay.length ? "..." : "";
  return `${prefix}${hay.slice(start, end)}${suffix}`;
}

function isLikelyHeader(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return false;
  if (trimmed.length > 200) return false;

  if (/^(table of contents|contents)\b/i.test(trimmed)) return true;
  if (/\b(chapter|section|appendix|article|clause|rule|rules|definition|definitions|scope)\b/i.test(trimmed)) {
    return true;
  }
  if (/^[A-Z0-9][A-Z0-9 ._-]{6,}$/.test(trimmed) && trimmed.length <= 120) return true;
  if (/^[0-9IVX]+(\.|:)\s+\S+/.test(trimmed)) return true;

  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    const titleCase = words.filter((w) => /^[A-Z][a-z]/.test(w)).length;
    if (titleCase / words.length > 0.7) return true;
  }

  return false;
}

function parseSegmentIndex(chunkId: string): number {
  const m = chunkId.match(/:s(\d+)/);
  return m ? Number(m[1]) : 0;
}

function chunkOrderKey(chunk: Chunk): number {
  if (chunk.kind === "pdf") {
    const page = chunk.page ?? 0;
    return page * 1000 + parseSegmentIndex(chunk.chunkId);
  }
  return chunk.startLine ?? 0;
}

function buildExternalUrl(
  fileMeta: { id: string },
  chunk: Chunk,
  driveByFileId: Map<string, { fileId: string; webViewLink?: string }>,
): string | undefined {
  const drive = driveByFileId.get(fileMeta.id);
  if (!drive?.fileId) return undefined;
  if (chunk.page) return `https://drive.google.com/file/d/${drive.fileId}/view#page=${chunk.page}`;
  return `https://drive.google.com/file/d/${drive.fileId}/view`;
}

export async function getManifest(): Promise<{
  generatedAt: string | null;
  years: string[];
  fileCount: number;
  chunkCount: number;
  indexReady: boolean;
  message?: string;
}> {
  try {
    const { bundle } = await loadIndex();
    const years = uniq(
      bundle.files
        .filter((f) => f.kind === "pdf" && f.year)
        .map((f) => f.year!)
        .filter(Boolean),
    ).sort((a, b) => b.localeCompare(a));

    return {
      generatedAt: bundle.generatedAt,
      years,
      fileCount: bundle.files.length,
      chunkCount: bundle.chunks.length,
      indexReady: true,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Missing docs index.";
    return {
      generatedAt: null,
      years: ["2026", "2025"],
      fileCount: 0,
      chunkCount: 0,
      indexReady: false,
      message,
    };
  }
}

export async function getFileSummaries(): Promise<
  Array<{ fileName: string; kind: string; year?: string; bytes?: number }>
> {
  try {
    const { bundle } = await loadIndex();
    return bundle.files.map((f) => ({
      fileName: f.fileName,
      kind: f.kind,
      year: f.year,
      bytes: f.bytes,
    }));
  } catch {
    return [];
  }
}

export async function searchDocs(params: {
  query: string;
  year?: string;
  limit?: number;
  extraTerms?: string[];
  pdfFileNameAllow?: string[];
  kinds?: Array<"pdf" | "text">;
}): Promise<RetrievedChunk[]> {
  const { bundle, mini, chunksById, driveByFileId } = await loadIndex();
  const query = params.query.trim();
  const year = params.year?.trim();
  const terms = uniq([...(params.extraTerms ?? []), ...extractTerms(query)]);
  const kindAllow = params.kinds ? new Set(params.kinds) : null;
  const pdfFileNameAllow =
    params.pdfFileNameAllow && params.pdfFileNameAllow.length
      ? new Set(params.pdfFileNameAllow.map((v) => v.toLowerCase()))
      : null;

  const scoreByChunkId = new Map<string, number>();

  const addResults = (results: SearchResult[], weight: number) => {
    for (const r of results) {
      const id = String(r.id);
      const prev = scoreByChunkId.get(id) ?? 0;
      scoreByChunkId.set(id, prev + Number(r.score ?? 0) * weight);
    }
  };

  // 1) Main query search
  addResults(
    (mini.search(query, { combineWith: "OR" }) as SearchResult[]).slice(0, 250),
    1,
  );

  // 2) Keyword searches (helps a lot when user question is generic)
  for (const t of terms) {
    const term = t.trim();
    if (term.length < 3) continue;
    if (/^\d+$/.test(term)) continue;
    addResults(
      (mini.search(term, { combineWith: "OR" }) as SearchResult[]).slice(0, 80),
      0.55,
    );
  }

  const results = Array.from(scoreByChunkId.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 250);
  const out: RetrievedChunk[] = [];

  for (const r of results) {
    const chunk = chunksById.get(r.chunkId);
    if (!chunk) continue;

    if (kindAllow && !kindAllow.has(chunk.kind)) continue;
    if (
      chunk.kind === "pdf" &&
      pdfFileNameAllow &&
      !pdfFileNameAllow.has(chunk.fileName.toLowerCase())
    ) {
      continue;
    }
    if (chunk.kind === "pdf" && year && chunk.year && chunk.year !== year) continue;
    if (chunk.kind === "pdf" && year && !chunk.year) continue;

    const fileMeta = bundle.files.find((f) => f.id === chunk.fileId);
    const externalUrl = fileMeta ? buildExternalUrl(fileMeta, chunk, driveByFileId) : undefined;

    out.push({
      ...chunk,
      score: Number(r.score ?? 0),
      excerpt: makeExcerpt(chunk.text, terms),
      externalUrl,
    });
  }

  out.sort((a, b) => b.score - a.score);
  const limit = params.limit ?? 12;
  const perFileCap = 4;

  const picked: RetrievedChunk[] = [];
  const perFile = new Map<string, number>();
  const pickedIds = new Set<string>();

  for (const item of out) {
    const count = perFile.get(item.fileName) ?? 0;
    if (count >= perFileCap) continue;
    picked.push(item);
    pickedIds.add(item.chunkId);
    perFile.set(item.fileName, count + 1);
    if (picked.length >= limit) break;
  }

  if (picked.length < limit) {
    for (const item of out) {
      if (pickedIds.has(item.chunkId)) continue;
      picked.push(item);
      pickedIds.add(item.chunkId);
      if (picked.length >= limit) break;
    }
  }

  return picked;
}

export async function expandHeaderContext(
  retrieved: RetrievedChunk[],
  options?: {
    maxTotal?: number;
    maxPerHeader?: number;
    maxExtraTotal?: number;
    maxExtraChars?: number;
  },
): Promise<RetrievedChunk[]> {
  if (!retrieved.length) return retrieved;

  const maxTotal = options?.maxTotal ?? 28;
  const maxPerHeader = options?.maxPerHeader ?? 3;
  const maxExtraTotal = options?.maxExtraTotal ?? 8;
  const maxExtraChars = options?.maxExtraChars ?? 5000;

  const { bundle, driveByFileId } = await loadIndex();

  const byFileId = new Map<string, Chunk[]>();
  for (const c of bundle.chunks) {
    const list = byFileId.get(c.fileId);
    if (list) list.push(c);
    else byFileId.set(c.fileId, [c]);
  }
  for (const list of byFileId.values()) {
    list.sort((a, b) => chunkOrderKey(a) - chunkOrderKey(b));
  }

  const byFileMeta = new Map(bundle.files.map((f) => [f.id, f] as const));

  const existingIds = new Set(retrieved.map((r) => r.chunkId));
  const pinnedIds = new Set<string>();
  const extras: RetrievedChunk[] = [];

  let extraCount = 0;

  for (const base of retrieved) {
    if (!isLikelyHeader(base.text)) continue;
    if (base.text.trim().length > 260) continue;
    if (extraCount >= maxExtraTotal) break;

    pinnedIds.add(base.chunkId);
    const list = byFileId.get(base.fileId);
    if (!list) continue;
    const idx = list.findIndex((c) => c.chunkId === base.chunkId);
    if (idx < 0) continue;

    const terms = extractTerms(base.text);
    let added = 0;
    let extraChars = 0;

    for (let i = idx + 1; i < list.length; i++) {
      const c = list[i]!;
      if (existingIds.has(c.chunkId)) continue;
      const text = c.text.trim();
      if (!text) continue;
      if (added >= maxPerHeader || extraCount >= maxExtraTotal) break;

      extraChars += text.length;
      const fileMeta = byFileMeta.get(c.fileId);
      const externalUrl = fileMeta ? buildExternalUrl(fileMeta, c, driveByFileId) : undefined;

      extras.push({
        ...c,
        score: Math.max(0.1, base.score * 0.7),
        excerpt: makeExcerpt(text, terms),
        externalUrl,
      });

      existingIds.add(c.chunkId);
      pinnedIds.add(c.chunkId);
      added += 1;
      extraCount += 1;

      if (extraChars >= maxExtraChars) break;
      if (isLikelyHeader(text) && added > 0) break;
    }
  }

  if (!extras.length) return retrieved;

  const merged = [...retrieved, ...extras];
  if (merged.length <= maxTotal) return merged;

  const byId = new Map(merged.map((m) => [m.chunkId, m] as const));
  const dropCandidates = merged
    .filter((m) => !pinnedIds.has(m.chunkId))
    .sort((a, b) => a.score - b.score);

  let toDrop = merged.length - maxTotal;
  for (const c of dropCandidates) {
    if (toDrop <= 0) break;
    byId.delete(c.chunkId);
    toDrop -= 1;
  }

  return Array.from(byId.values());
}

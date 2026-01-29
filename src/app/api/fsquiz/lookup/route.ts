import { NextResponse } from "next/server";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { getOpenAIClient } from "@/lib/openai";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IMAGE_DATA_URL_CHARS = 4_000_000;

const ReqSchema = z
  .object({
    query: z
      .string()
      .optional()
      .default("")
      .transform((s) => s.trim())
      .refine((s) => s.length <= 10_000, "Query is too long."),
    images: z
      .array(
        z
          .string()
          .trim()
          .refine((v) => v.startsWith("data:image/"), "Invalid image data URL"),
      )
      .max(4)
      .optional(),
    limit: z.coerce.number().int().min(1).max(12).optional(),
  })
  .refine((v) => v.query.length > 0 || (v.images?.length ?? 0) > 0, {
    path: ["query"],
    message: "Provide a query or at least one image.",
  });

const OcrSchema = z.object({
  text: z.string().default(""),
});

type FsQuizQuestion = {
  question_id?: number | string;
  text?: string;
  images?: Array<{ img_id?: number; path?: string }>;
};

type IndexedQuestion = {
  id: number;
  text: string;
  normalized: string;
  tokens: Set<string>;
  imageUrls: string[];
};

type FsQuizIndexState = {
  complete: boolean;
  nextId: number;
  notFoundStreak: number;
  items: IndexedQuestion[];
};

declare global {
  var __fredquiz_fsquiz_index: FsQuizIndexState | undefined;
}

function isDebug() {
  return process.env.NODE_ENV !== "production" && process.env.FSQUIZ_LOOKUP_DEBUG === "1";
}

function pickQuestion(payload: unknown): FsQuizQuestion | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0 && questions[0] && typeof questions[0] === "object") {
    return questions[0] as FsQuizQuestion;
  }
  if ("question_id" in record) return payload as FsQuizQuestion;
  return null;
}

function normalizeText(input: string) {
  return input
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTokens(normalized: string) {
  const out = new Set<string>();
  for (const t of normalized.split(" ")) {
    if (!t) continue;
    if (t.length <= 1) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function substringScore(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  if (a.includes(b) || b.includes(a)) return 0.85;
  return 0;
}

function scoreMatch(query: IndexedQuestion, candidate: IndexedQuestion) {
  if (query.normalized.length === 0 || candidate.normalized.length === 0) return 0;
  if (query.normalized === candidate.normalized) return 1;
  const longer = query.normalized.length >= candidate.normalized.length ? query.normalized : candidate.normalized;
  const shorter = longer === query.normalized ? candidate.normalized : query.normalized;
  if (shorter.length >= 20 && longer.includes(shorter)) return 0.95;

  const jac = jaccard(query.tokens, candidate.tokens);
  const overlap =
    Math.min(query.tokens.size, candidate.tokens.size) > 0
      ? (() => {
          let inter = 0;
          for (const t of query.tokens) if (candidate.tokens.has(t)) inter += 1;
          return inter / Math.min(query.tokens.size, candidate.tokens.size);
        })()
      : 0;
  const sub = substringScore(query.normalized, candidate.normalized);
  return Math.max(jac * 0.3 + overlap * 0.7, sub);
}

function getIndexState(): FsQuizIndexState {
  const existing = globalThis.__fredquiz_fsquiz_index;
  if (!existing) {
    // FS-Quiz question IDs appear to start at 1 (id=0 returns 404).
    globalThis.__fredquiz_fsquiz_index = { complete: false, nextId: 1, notFoundStreak: 0, items: [] };
    return globalThis.__fredquiz_fsquiz_index;
  }

  // Migrate older state and recover from previous buggy runs.
  // If we ever marked complete with 0 indexed items, restart from id=1.
  if (existing.complete && existing.items.length === 0) {
    globalThis.__fredquiz_fsquiz_index = { complete: false, nextId: 1, notFoundStreak: 0, items: [] };
    return globalThis.__fredquiz_fsquiz_index;
  }

  if (typeof (existing as Partial<FsQuizIndexState>).notFoundStreak !== "number") existing.notFoundStreak = 0;
  if (typeof existing.nextId !== "number" || !Number.isFinite(existing.nextId) || existing.nextId < 1) {
    existing.nextId = 1;
  }

  return existing;
}

async function fetchQuestionById(baseUrl: string, id: number): Promise<IndexedQuestion | "not_found"> {
  if (isDebug()) console.log(`[fsquiz/lookup] check id=${id}`);
  const res = await fetch(`${baseUrl}/api/fsquiz/question/${id}`, {
    method: "GET",
    cache: "no-store",
  });

  if (res.status === 404) {
    if (isDebug()) console.log(`[fsquiz/lookup] id=${id} -> 404`);
    return "not_found";
  }
  if (!res.ok) throw new Error(`FS-Quiz request failed (${res.status}).`);

  const wrapped = (await res.json()) as unknown;
  const q =
    wrapped && typeof wrapped === "object" && "question" in wrapped
      ? pickQuestion((wrapped as { question?: unknown }).question)
      : pickQuestion(wrapped);
  const text = (q?.text ?? "").toString().trim();
  const normalized = normalizeText(text);
  const tokens = toTokens(normalized);
  const images = Array.isArray(q?.images) ? q!.images : [];
  const imageUrls = images
    .map((img) => String(img?.path ?? "").replace(/^\/+/, ""))
    .filter(Boolean)
    .slice(0, 6)
    .map((p) => `https://img.fs-quiz.eu/${p}`);

  return {
    id,
    text,
    normalized,
    tokens,
    imageUrls,
  };
}

async function ensureIndexedUntilEnd(opts: { timeBudgetMs: number; baseUrl: string }) {
  const state = getIndexState();
  if (state.complete) return { state, newlyIndexed: 0 };

  const startedAt = Date.now();
  let newlyIndexed = 0;
  const maxConsecutiveNotFound = 4;
  const minIndexedBeforeStop = 200;
  const batchSize = 8;

  while (!state.complete) {
    if (Date.now() - startedAt > opts.timeBudgetMs) break;

    const startId = state.nextId;
    const ids = Array.from({ length: batchSize }, (_, i) => startId + i);
    state.nextId += batchSize;

    const results = await Promise.all(ids.map((id) => fetchQuestionById(opts.baseUrl, id)));
    for (let i = 0; i < results.length; i += 1) {
      const id = ids[i]!;
      const res = results[i]!;
      if (res === "not_found") {
        state.notFoundStreak += 1;
        if (
          state.notFoundStreak >= maxConsecutiveNotFound &&
          state.items.length >= minIndexedBeforeStop
        ) {
          if (isDebug()) {
            console.log(
              `[fsquiz/lookup] stop after ${state.notFoundStreak} consecutive 404s (last id=${id})`,
            );
          }
          state.complete = true;
          break;
        }
        continue;
      }

      state.notFoundStreak = 0;
      state.items.push(res);
      newlyIndexed += 1;
    }
    if (state.complete) break;
  }

  return { state, newlyIndexed };
}

async function extractTextFromImages(images: string[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");

  const usableImages = images.filter((img) => img.length <= MAX_IMAGE_DATA_URL_CHARS);
  if (images.length > 0 && usableImages.length === 0) {
    throw new Error("All provided images were too large to process.");
  }

  const client = getOpenAIClient();
  const model = "gpt-4o-mini";

  const parts: ChatCompletionContentPart[] = [
    {
      type: "text",
      text: [
        "Extract the FS-Quiz question text from the image(s).",
        "Return ONLY the question text, preserving line breaks when helpful.",
        "Do not add any explanations, guesses, or extra formatting.",
      ].join("\n"),
    },
  ];
  for (const img of usableImages) {
    parts.push({ type: "image_url", image_url: { url: img, detail: "low" } });
  }

  const res = await client.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: "You are an OCR/transcription assistant. Reply ONLY with the schema." },
      { role: "user", content: parts },
    ],
    response_format: zodResponseFormat(OcrSchema, "ocr"),
  });

  const extracted = res.choices[0]?.message.parsed?.text ?? "";
  return extracted.toString().trim().slice(0, 10_000);
}

export async function POST(req: Request) {
  const parsed = ReqSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false as const, error: "Invalid request." }, { status: 400 });
  }

  const queryText = parsed.data.query;
  const images = parsed.data.images ?? [];
  const limit = 1;

  try {
    const baseUrl = new URL(req.url).origin;
    if (process.env.NODE_ENV !== "production") {
      console.log("[fsquiz/lookup] start", { hasQuery: Boolean(queryText), images: images.length, limit });
    }
    const { state, newlyIndexed } = await ensureIndexedUntilEnd({ timeBudgetMs: 25_000, baseUrl });

    // At most one AI call: only used to OCR image(s) into text (matching stays code-only).
    const extractedText = images.length ? await extractTextFromImages(images) : "";
    const queryUsed = (extractedText || queryText).trim().slice(0, 10_000);

    const queryNormalized = normalizeText(queryUsed);
    const queryTokens = toTokens(queryNormalized);
    const query: IndexedQuestion = {
      id: -1,
      text: queryUsed,
      normalized: queryNormalized,
      tokens: queryTokens,
      imageUrls: [],
    };

    const scoredAll = state.items
      .map((q) => ({ q, score: scoreMatch(query, q) }))
      .filter((x) => x.score >= 0.4)
      .sort((a, b) => b.score - a.score);

    const scored = scoredAll.slice(0, 1);

    if (process.env.NODE_ENV !== "production") {
      console.log("[fsquiz/lookup] matches", scored.map((s) => ({ id: s.q.id, score: s.score.toFixed(3) })));
    }

    return NextResponse.json(
      {
        ok: true as const,
        complete: state.complete,
        indexedCount: state.items.length,
        newlyIndexed,
        queryUsed,
        extractedText,
        debugMatch: scored[0]
          ? { questionId: scored[0].q.id, score: scored[0].score, text: scored[0].q.text }
          : null,
        matches: scored.map(({ q, score }) => ({
          questionId: q.id,
          score,
          text: q.text,
          imageUrls: q.imageUrls,
        })),
      },
      { status: 200 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error.";
    return NextResponse.json({ ok: false as const, error: message }, { status: 502 });
  }
}

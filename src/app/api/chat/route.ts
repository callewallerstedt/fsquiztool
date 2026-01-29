import { NextResponse } from "next/server";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import type { ResponseIncludable } from "openai/resources/responses/responses";
import { getOpenAIClient } from "@/lib/openai";
import {
  buildFileSearchFilters,
  getVectorStoreId,
  type SyncSelectionParams,
} from "@/lib/openai-file-search";

export const runtime = "nodejs";
export const maxDuration = 60;

const ReqSchema = z
  .object({
    previousResponseId: z.string().trim().optional(),
    year: z.string().trim().optional(),
    handbookFile: z.string().trim().optional(),
    rulesFile: z.string().trim().optional(),
    fsQuizContext: z
      .object({
        questionId: z.string().trim().min(1).max(32),
        questionText: z.string().trim().min(1).max(10_000),
        correctAnswers: z.array(z.string().trim().min(1).max(500)).max(12),
        imageUrls: z
          .array(z.string().trim().url().refine((u) => u.startsWith("https://img.fs-quiz.eu/"), "Invalid image URL"))
          .max(4),
      })
      .optional(),
    question: z
      .string()
      .optional()
      .default("")
      .transform((s) => s.trim()),
    images: z
      .array(
        z
          .string()
          .trim()
          .refine((v) => v.startsWith("data:image/"), "Invalid image data URL"),
      )
      .max(4)
      .optional(),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        }),
      )
      .optional(),
  })
  .refine((v) => v.question.length > 0 || (v.images?.length ?? 0) > 0, {
    path: ["question"],
    message: "Provide a question or at least one image.",
  });

const VisionSchema = z.object({
  summary: z.string(),
  keywords: z.array(z.string()).max(12),
});

const VisionStatementsSchema = z.object({
  statements: z.array(z.string()).min(1).max(12),
  keywords: z.array(z.string()).max(18).default([]),
  concepts: z.array(z.string()).max(24).default([]),
  searchQueries: z.array(z.string()).max(12).default([]),
});

type SourceRef = {
  chunkId: string;
  title: string;
  location: string;
  excerpt: string;
  externalUrl?: string;
};

export async function POST(req: Request) {
  let body: z.infer<typeof ReqSchema>;
  try {
    body = ReqSchema.parse(await req.json());
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid request.";
    return NextResponse.json({ ok: false as const, error: message }, { status: 400 });
  }

  const year = body.year?.trim() || undefined;
  const handbookFile = body.handbookFile?.trim() || undefined;
  const rulesFile = body.rulesFile?.trim() || undefined;
  const question = body.question;
  const images = body.images ?? [];
  const fsQuizContext = body.fsQuizContext;
  const previousResponseId = body.previousResponseId?.trim() || undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      const run = async () => {
        const startedAt = Date.now();
        if (process.env.NODE_ENV !== "production") {
          console.log("[/api/chat] start", {
            year,
            handbookFile,
            rulesFile,
            images: images.length,
            fsQuizContext: fsQuizContext?.questionId ?? null,
          });
        }

        const client = getOpenAIClient();
        const answerModel = process.env.OPENAI_ANSWER_MODEL || "gpt-4o-mini";
        const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

        let visionSummary: string | null = null;
        let visionKeywords: string[] = [];
        let visionStatements: string[] = [];
        let visionSearchQueries: string[] = [];

        if (images.length > 0) {
          try {
            const visionParts: ChatCompletionContentPart[] = [
              {
                type: "text",
                text: [
                  "Extract the statements shown (one per line). Return max 12 statements that the user should judge.",
                  "Plan search by also returning:",
                  "- keywords: important words/abbreviations/synonyms (sv/en) that help find the right rule text.",
                  "- concepts: key concepts (e.g. time slot, finals, penalty, scoring range) without fluff.",
                  "- searchQueries: 6-12 concrete search phrases (one per line) covering the statements.",
                ].join("\n"),
              },
            ];
            for (const img of images) {
              if (img.length > 4_000_000) continue;
              visionParts.push({
                type: "image_url",
                image_url: { url: img, detail: "auto" },
              });
            }

            const extracted = await client.chat.completions.parse({
              model: visionModel,
              messages: [
                {
                  role: "system",
                  content:
                    "You read a screenshot from a Formula Student quiz. Extract statements as literally as possible and return search hints. Reply ONLY with the schema.",
                },
                { role: "user", content: visionParts },
              ],
              response_format: zodResponseFormat(VisionStatementsSchema, "vision_statements"),
            });
            const ex = extracted.choices[0]?.message.parsed;
            if (ex) {
              visionStatements = (ex.statements ?? []).map((s) => s.trim()).filter(Boolean);
              visionKeywords = [
                ...(ex.keywords ?? []).map((k) => k.trim()).filter(Boolean),
                ...(ex.concepts ?? []).map((c) => c.trim()).filter(Boolean),
              ];
              visionSearchQueries = (ex.searchQueries ?? []).map((q) => q.trim()).filter(Boolean);
            }
          } catch {
            // ignore
          }
        }

        if (images.length > 0 && question.length === 0) {
          try {
            const visionParts: ChatCompletionContentPart[] = [
              {
                type: "text",
                text: "Describe what the images show and extract keywords/phrases for document search (sv/en).",
              },
            ];
            for (const img of images) {
              if (img.length > 4_000_000) continue;
              visionParts.push({
                type: "image_url",
                image_url: { url: img, detail: "auto" },
              });
            }

            const vision = await client.chat.completions.parse({
              model: visionModel,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a vision assistant for a Formula Student knowledge base. Return a short summary and max 12 keywords for search. Reply ONLY with the schema.",
                },
                { role: "user", content: visionParts },
              ],
              response_format: zodResponseFormat(VisionSchema, "vision"),
            });
            const v = vision.choices[0]?.message.parsed;
            if (v) {
              visionSummary = v.summary?.trim() || null;
              visionKeywords = [
                ...visionKeywords,
                ...(v.keywords ?? []).map((k) => k.trim()).filter(Boolean),
              ];
            }
          } catch {
            // ignore
          }
        }

        const questionForSearch = question.length > 0 ? question : visionSummary || "image";

        const selection: SyncSelectionParams = {
          year,
          handbookFile,
          rulesFile,
        };

        const searchInfo = {
          query: questionForSearch,
          year,
          planner: null,
          plannerKeywords: [],
          fileNameHints: [],
          visionSummary,
          visionKeywords,
          visionStatementsCount: visionStatements.length,
          visionSearchQueriesCount: visionSearchQueries.length,
          scope: "Auto: searches docs when needed",
          kinds: ["pdf", "text"],
          retrievedChunks: 0,
          matchedFiles: [] as string[],
        };

        send({ type: "meta", searchInfo });

        try {
          const vectorStoreId = await getVectorStoreId(client);

          const filters = buildFileSearchFilters(selection);

          let answerText = "";
          const fileSearchResults: Array<{
            attributes?: { [key: string]: string | number | boolean } | null;
            file_id?: string;
            filename?: string;
            score?: number;
            text?: string;
          }> = [];

          const userPrompt = [
            `Question: ${questionForSearch}`,
            year ? `Selected year: ${year}` : null,
            handbookFile ? `Selected handbook: ${handbookFile}` : null,
            rulesFile ? `Selected rules: ${rulesFile}` : null,
            fsQuizContext
              ? [
                  "FS-Quiz context (from API; treat as ground truth):",
                  `Question ID: ${fsQuizContext.questionId}`,
                  `Question text: ${fsQuizContext.questionText}`,
                  fsQuizContext.correctAnswers.length
                    ? `Correct answer(s): ${fsQuizContext.correctAnswers.join(" | ")}`
                    : "Correct answer(s): (not provided)",
                ].join("\n")
              : null,
            visionStatements.length ? `Statements from image:\n- ${visionStatements.join("\n- ")}` : null,
          ]
            .filter(Boolean)
            .join("\n\n");

          const userContent: Array<
            | { type: "input_text"; text: string }
            | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" }
          > = [{ type: "input_text", text: userPrompt }];

          if (fsQuizContext?.imageUrls?.length) {
            for (const url of fsQuizContext.imageUrls.slice(0, 4)) {
              userContent.push({ type: "input_image", image_url: url, detail: "auto" });
            }
          }

          for (const img of images) {
            if (img.length > 4_000_000) continue;
            userContent.push({ type: "input_image", image_url: img, detail: "auto" });
          }

          const baseParams = {
            model: answerModel,
            instructions: [
              "You are a Formula Student quiz/rules assistant.",
              "Always respond in well-formatted Markdown.",
              "- Use headings, bullet lists, and tables where it improves readability.",
              "- For formulas, use LaTeX math (inline $...$ and display $$...$$).",
              "- Keep the final answer clean and structured.",
              "Try hard to find the correct answer first. If the question is about rules/scoring/penalties/procedures, you SHOULD use file search to look up exact wording before answering.",
              "If the question is a standalone calculation (e.g., circuits, physics, math) and the answer can be derived from the text/image, do the calculation and give the final numeric result. Do NOT use file search for that.",
              "If the user is just chatting or asking a follow-up that doesn't require documents, answer WITHOUT file search.",
              "Always attempt to answer the question (not just summarize sources). If you rely on assumptions, state them explicitly. Never invent rule text or values.",
              "If FS-Quiz context is provided (question + images + correct answer), use it to answer follow-up questions about that specific question. Do not contradict the provided correct answer; instead explain it.",
              "If the user provides multiple statements (e.g., in an image), judge each as TRUE/FALSE/UNCLEAR and list the FALSE ones clearly.",
              "Only say UNCLEAR if you cannot support an answer AFTER searching. In that case, say what exact rule section/paragraph you would need to confirm.",
              "Be concise (prefer <200 words) and quote small excerpts when helpful.",
            ].join("\n"),
            // Keep client-side history for display, but Responses API memory should use previous_response_id.
            input: [{ role: "user" as const, content: userContent }],
            previous_response_id: previousResponseId,
            include: ["file_search_call.results"] as ResponseIncludable[],
            max_output_tokens: 650,
            stream: true as const,
            temperature: 0.5,
          };

          const responseStream = await client.responses.create({
            ...baseParams,
            tools: [
              {
                type: "file_search",
                vector_store_ids: [vectorStoreId],
                filters,
                max_num_results: 12,
                ranking_options: { score_threshold: 0.2 },
              },
            ],
            tool_choice: "auto",
          });

          for await (const event of responseStream) {
            if (event.type === "response.created") {
              send({ type: "meta", responseId: event.response.id });
            }
            if (event.type === "response.output_text.delta") {
              answerText += event.delta;
              send({ type: "delta", text: event.delta });
              continue;
            }

            if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
              const item = event.item;
              if (item.type === "file_search_call" && Array.isArray(item.results)) {
                for (const r of item.results) fileSearchResults.push(r);
              }
            }
          }

          const uniq = new Map<string, SourceRef>();
          for (let i = 0; i < fileSearchResults.length; i += 1) {
            const r = fileSearchResults[i]!;
            const fileId = r.file_id || "file_unknown";
            const relPath =
              (r.attributes && typeof r.attributes.relPath === "string" ? r.attributes.relPath : null) ||
              r.filename ||
              "unknown";
            const text = (r.text ?? "").trim();
            if (!text) continue;
            const key = `${fileId}:${text.slice(0, 120)}`;
            if (uniq.has(key)) continue;
            uniq.set(key, {
              chunkId: `${fileId}:${i + 1}`,
              title: String(relPath),
              location: "excerpt",
              excerpt: text,
            });
          }

          const sources = Array.from(uniq.values()).slice(0, 12);
          const matchedFiles = Array.from(new Set(sources.map((s) => s.title))).slice(0, 12);

          if (process.env.NODE_ENV !== "production") {
            console.log("[/api/chat] done", {
              ms: Date.now() - startedAt,
              sources: sources.length,
              matchedFiles: matchedFiles.length,
            });
          }

          send({
            type: "done",
            answerMarkdown: answerText.trim(),
            sources,
            searchInfo: {
              ...searchInfo,
              retrievedChunks: sources.length,
              matchedFiles,
            },
          });
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error.";
          send({ type: "error", error: message });
          controller.close();
        }
      };

      void run();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

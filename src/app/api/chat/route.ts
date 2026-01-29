import { NextResponse } from "next/server";
import { z } from "zod";
import type { ResponseIncludable } from "openai/resources/responses/responses";
import { getOpenAIClient } from "@/lib/openai";
import { getVectorStoreId } from "@/lib/openai-file-search";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IMAGE_DATA_URL_CHARS = 4_000_000;

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

type SourceRef = {
  chunkId: string;
  title: string;
  location: string;
  excerpt: string;
  externalUrl?: string;
};

function buildRestrictedFilters(opts: {
  handbookFile?: string;
  rulesFile?: string;
}) {
  const filters: Array<{ type: "eq"; key: string; value: string | number | boolean }> = [
    { type: "eq", key: "group", value: "script" },
    { type: "eq", key: "group", value: "pdf" },
  ];
  if (opts.handbookFile) filters.push({ type: "eq", key: "relPath", value: opts.handbookFile });
  if (opts.rulesFile) filters.push({ type: "eq", key: "relPath", value: opts.rulesFile });
  return { type: "or" as const, filters };
}

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
        const usableImages = images.filter((img) => img.length <= MAX_IMAGE_DATA_URL_CHARS);
        const skippedImages = images.length - usableImages.length;
        if (images.length > 0 && usableImages.length === 0) {
          send({
            type: "error",
            error:
              "All provided images were too large to process. Please upload smaller screenshots (or paste the text).",
          });
          controller.close();
          return;
        }

        if (process.env.NODE_ENV !== "production") {
          console.log("[/api/chat] start", {
            year,
            handbookFile,
            rulesFile,
            images: images.length,
            skippedImages,
            fsQuizContext: fsQuizContext?.questionId ?? null,
          });
        }

        const client = getOpenAIClient();
        const answerModel = process.env.OPENAI_ANSWER_MODEL || "gpt-4o-mini";
        try {
          const vectorStoreId = await getVectorStoreId(client);

          let answerText = "";
          const fileSearchResults: Array<{
            attributes?: { [key: string]: string | number | boolean } | null;
            file_id?: string;
            filename?: string;
            score?: number;
            text?: string;
          }> = [];

          const questionForModel = question.length > 0 ? question : "(image only)";

          const userPrompt = [
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
            `User message:\n${questionForModel}`,
          ]
            .filter(Boolean)
            .join("\n\n")
            .trim();

          const userContent: Array<
            | { type: "input_text"; text: string }
            | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" }
          > = [{ type: "input_text", text: userPrompt }];

          if (fsQuizContext?.imageUrls?.length) {
            for (const url of fsQuizContext.imageUrls.slice(0, 4)) {
              userContent.push({ type: "input_image", image_url: url, detail: "low" });
            }
          }

          for (const img of usableImages) {
            userContent.push({ type: "input_image", image_url: img, detail: "low" });
          }

          const baseParams = {
            model: answerModel,
            instructions: [
              "You are a Formula Student quiz/rules assistant.",
              "Always respond in well-formatted Markdown.",
              "- Use headings, bullet lists, and tables where it improves readability.",
              "- For formulas, use LaTeX math (inline $...$ and display $$...$$).",
              "- Keep the final answer clean and structured.",
              "Always attempt to answer the question (not just summarize sources). If you rely on assumptions, state them explicitly.",
              "If the question is about rules/scoring/penalties/procedures, use file search to quote exact wording before answering.",
              "If the question is a standalone calculation (e.g., circuits, physics, math) and the answer can be derived from the text/image, do the calculation yourself and give the final numeric result. Do NOT ask the user to calculate anything.",
              "If the user is just chatting or asking a follow-up that doesn't require documents, answer without file search.",
              "Never invent rule text or numeric values.",
              "If FS-Quiz context is provided (question + images + correct answer), use it to answer follow-up questions about that specific question. Do not contradict the provided correct answer; instead explain it.",
              "Be concise (prefer <200 words) and quote small excerpts when helpful.",
            ].join("\n"),
            input: [{ role: "user" as const, content: userContent }],
            previous_response_id: previousResponseId,
            include: ["file_search_call.results"] as ResponseIncludable[],
            max_output_tokens: 1200,
            stream: true as const,
            temperature: 0.5,
          };

          const responseStream = await client.responses.create({
            ...baseParams,
            tools: [
              {
                type: "file_search",
                vector_store_ids: [vectorStoreId],
                filters: buildRestrictedFilters({ handbookFile, rulesFile }),
                max_num_results: 8,
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
            if (event.type === "response.completed") {
              const responseAny = event.response as unknown;
              if (responseAny && typeof responseAny === "object" && "usage" in responseAny) {
                const usage = (responseAny as { usage?: unknown }).usage;
                if (usage) send({ type: "meta", usage });
              }
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

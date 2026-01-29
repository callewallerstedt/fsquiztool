import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 30;

const ParamsSchema = z.object({
  questionId: z.coerce.number().int().min(0).max(1_000_000),
});

function pickQuestion(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0) return questions[0];
  return payload;
}

export async function GET(_: Request, ctx: { params: Promise<{ questionId: string }> }) {
  const parsedParams = ParamsSchema.safeParse(await ctx.params);
  if (!parsedParams.success) {
    return NextResponse.json({ ok: false as const, error: "Invalid question id." }, { status: 400 });
  }

  const questionId = parsedParams.data.questionId;

  try {
    const res = await fetch(`https://api.fs-quiz.eu/2/question/${questionId}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (res.status === 404) {
      return NextResponse.json({ ok: false as const, error: "Question not found." }, { status: 404 });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false as const, error: "Failed to fetch question." }, { status: 502 });
    }

    const questionRaw = (await res.json()) as unknown;
    const question = pickQuestion(questionRaw);
    return NextResponse.json({ ok: true as const, question }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error.";
    return NextResponse.json({ ok: false as const, error: message }, { status: 502 });
  }
}

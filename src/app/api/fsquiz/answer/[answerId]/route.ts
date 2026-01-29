import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  answerId: z.coerce.number().int().min(0).max(1_000_000),
});

type AnswerDtoRaw = {
  answer_id: number;
  question_id: number;
  answer_text: string;
  is_correct: boolean | number;
};

type QuestionDto = {
  question_id: number | string;
  text: string;
  time: number | null;
  type: string;
  quizzes?: Array<{ quiz_id: number; position_index: number }>;
  answers?: Array<{
    answer_id: number;
    question_id: number;
    answer_text: string;
    is_correct: boolean;
  }>;
  images?: Array<{ img_id: number; path: string }>;
  solutions?: Array<{
    solution_id: number;
    question_id: number;
    text: string;
    images: Array<{ img_id: number; path: string }>;
  }>;
  solution?: unknown;
};

type AnswerDto = Omit<AnswerDtoRaw, "is_correct"> & { is_correct: boolean };

function pickQuestion(payload: unknown): QuestionDto | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0 && questions[0] && typeof questions[0] === "object") {
    return questions[0] as QuestionDto;
  }
  if ("question_id" in record) return payload as QuestionDto;
  return null;
}

function toBool(v: unknown) {
  if (v === true) return true;
  if (v === false) return false;
  if (v === 1 || v === "1") return true;
  if (v === 0 || v === "0") return false;
  return Boolean(v);
}

export async function GET(_: Request, ctx: { params: Promise<{ answerId: string }> }) {
  const parsedParams = ParamsSchema.safeParse(await ctx.params);
  if (!parsedParams.success) {
    return NextResponse.json({ ok: false as const, error: "Invalid answer id." }, { status: 400 });
  }

  const answerId = parsedParams.data.answerId;

  try {
    const answerRes = await fetch(`https://api.fs-quiz.eu/2/answer/${answerId}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (answerRes.status === 404) {
      return NextResponse.json({ ok: false as const, error: "Answer not found." }, { status: 404 });
    }
    if (!answerRes.ok) {
      return NextResponse.json({ ok: false as const, error: "Failed to fetch answer." }, { status: 502 });
    }

    const answerRaw = (await answerRes.json()) as AnswerDtoRaw;
    if (!answerRaw || typeof answerRaw.question_id !== "number") {
      return NextResponse.json({ ok: false as const, error: "Unexpected answer payload." }, { status: 502 });
    }
    const answer: AnswerDto = { ...answerRaw, is_correct: toBool(answerRaw.is_correct) };

    const questionRes = await fetch(`https://api.fs-quiz.eu/2/question/${answer.question_id}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (questionRes.status === 404) {
      return NextResponse.json(
        { ok: true as const, answer, question: null },
        { status: 200 },
      );
    }
    if (!questionRes.ok) {
      return NextResponse.json({ ok: false as const, error: "Failed to fetch question." }, { status: 502 });
    }

    const questionPayload = await questionRes.json();
    const question = pickQuestion(questionPayload);

    return NextResponse.json(
      {
        ok: true as const,
        answer,
        question,
      },
      { status: 200 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error.";
    return NextResponse.json({ ok: false as const, error: message }, { status: 502 });
  }
}

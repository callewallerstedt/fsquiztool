import OpenAI from "openai";

declare global {
  var __fredquiz_openai: OpenAI | undefined;
}

export function getOpenAIClient(): OpenAI {
  if (globalThis.__fredquiz_openai) return globalThis.__fredquiz_openai;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY. Add it to .env.local or Vercel env vars.",
    );
  }
  const client = new OpenAI({ apiKey });
  globalThis.__fredquiz_openai = client;
  return client;
}

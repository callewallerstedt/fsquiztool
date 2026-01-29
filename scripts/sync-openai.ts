import OpenAI from "openai";
import { syncOpenAIFiles } from "../src/lib/openai-file-search";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY.");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey });
  const res = await syncOpenAIFiles(client);
  console.log(
    JSON.stringify(
      {
        ok: res.ok,
        vectorStoreId: res.vectorStoreId,
        desiredCount: res.desiredCount,
        uploaded: res.uploaded,
        kept: res.kept,
        removed: res.removed,
        lastSyncAt: res.lastSyncAt,
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

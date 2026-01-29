import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getOpenAIClient } from "@/lib/openai";
import { getVectorStoreId } from "@/lib/openai-file-search";

export const runtime = "nodejs";
export const maxDuration = 30;

type Option = { fileName: string; label: string };

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, "/");
}

function isValidYear(year: string) {
  return /^(?:19|20)\d{2}$/.test(year);
}

function cleanLabel(fileName: string) {
  const base = path.basename(fileName, path.extname(fileName));
  const withoutKeywords = base
    .replace(/\bhandbook\b/gi, " ")
    .replace(/\brulebook\b/gi, " ")
    .replace(/\brules?\b/gi, " ");
  return withoutKeywords
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
      continue;
    }
    if (e.isFile()) out.push(full);
  }
  return out;
}

async function findHandbooksDir(year: string): Promise<string | null> {
  const root = path.join(process.cwd(), "data", "files");
  const entries = await fs.readdir(root, { withFileTypes: true });

  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name.includes(year))
    .map((name) => {
      const lower = name.toLowerCase();
      let score = 0;
      if (new RegExp(`^handbooks\\s*${year}$`, "i").test(name)) score += 100;
      if (new RegExp(`^hanbooks\\s*${year}$`, "i").test(name)) score += 90;
      if (lower.includes("handbook")) score += 50;
      if (lower.includes("hanbooks")) score += 45;
      if (lower.includes("book")) score += 10;
      return { name, score };
    })
    .sort((a, b) => b.score - a.score);

  const pick = candidates[0]?.name;
  if (!pick) return null;
  return path.join(root, pick);
}

async function listFromVectorStore(year: string) {
  const client = getOpenAIClient();
  const vectorStoreId = await getVectorStoreId(client);

  const handbooks: Option[] = [];
  const rules: Option[] = [];

  for await (const f of client.vectorStores.files.list(vectorStoreId, { limit: 100, filter: "completed" })) {
    const attrs = f.attributes ?? null;
    if (!attrs || typeof attrs !== "object") continue;
    const ext = typeof attrs.ext === "string" ? attrs.ext : null;
    const group = typeof attrs.group === "string" ? attrs.group : null;
    const fileYear = typeof attrs.year === "string" ? attrs.year : null;
    const relPath = typeof attrs.relPath === "string" ? attrs.relPath : null;
    if (ext !== "pdf" || fileYear !== year || !relPath) continue;

    if (group === "handbook") {
      handbooks.push({ fileName: relPath, label: cleanLabel(relPath) });
      continue;
    }
    if (group === "rules") {
      rules.push({ fileName: relPath, label: cleanLabel(relPath) });
    }
  }

  handbooks.sort((a, b) => a.label.localeCompare(b.label));
  rules.sort((a, b) => a.label.localeCompare(b.label));
  return { handbooks, rules };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const year = (searchParams.get("year") ?? "").trim();
    if (!isValidYear(year)) {
      return NextResponse.json(
        { ok: false as const, error: "Invalid or missing year." },
        { status: 400 },
      );
    }

    const hasVectorStoreEnv = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_VECTOR_STORE_ID?.trim());
    const hasLocalRoot = await fs
      .access(path.join(process.cwd(), "data", "files"))
      .then(() => true)
      .catch(() => false);

    if (hasVectorStoreEnv && !hasLocalRoot) {
      const remote = await listFromVectorStore(year);
      return NextResponse.json({
        ok: true as const,
        year,
        handbooks: remote.handbooks,
        rules: remote.rules,
      });
    }

    const dir = await findHandbooksDir(year);
    if (!dir) {
      if (hasVectorStoreEnv) {
        const remote = await listFromVectorStore(year);
        return NextResponse.json({
          ok: true as const,
          year,
          handbooks: remote.handbooks,
          rules: remote.rules,
        });
      }
      return NextResponse.json({
        ok: true as const,
        year,
        handbooks: [] as Option[],
        rules: [] as Option[],
      });
    }

    const root = path.join(process.cwd(), "data", "files");
    const files = (await listFilesRecursive(dir))
      .filter((full) => path.extname(full).toLowerCase() === ".pdf")
      .map((full) => normalizeSlashes(path.relative(root, full)));

    const handbooks: Option[] = [];
    const rules: Option[] = [];

    for (const fileName of files) {
      const base = path.basename(fileName).toLowerCase();
      if (base.includes("handbook")) {
        handbooks.push({ fileName, label: cleanLabel(fileName) });
        continue;
      }
      if (base.includes("rules") || base.includes("rulebook")) {
        rules.push({ fileName, label: cleanLabel(fileName) });
      }
    }

    handbooks.sort((a, b) => a.label.localeCompare(b.label));
    rules.sort((a, b) => a.label.localeCompare(b.label));

    return NextResponse.json({
      ok: true as const,
      year,
      handbooks,
      rules,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list handbooks/rules.";
    return NextResponse.json({ ok: false as const, error: message }, { status: 500 });
  }
}

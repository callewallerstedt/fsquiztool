import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MiniSearch from "minisearch";
import { z } from "zod";
import type {
  PDFDocumentProxy,
  TextContent,
  TextItem,
} from "pdfjs-dist/types/src/display/api";

type DriveManifestEntry = {
  id: string;
  name: string;
  path?: string;
  webViewLink?: string;
  bytes?: number;
};

const DriveManifestSchema = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string().optional(),
      webViewLink: z.string().optional(),
      bytes: z.number().optional(),
    }),
  ),
});

type FileMeta = {
  id: string;
  fileName: string;
  kind: "pdf" | "text";
  ext: string;
  year?: string;
  bytes?: number;
  drive?: { fileId: string; webViewLink?: string };
};

type Chunk = {
  chunkId: string;
  fileId: string;
  fileName: string;
  kind: "pdf" | "text";
  year?: string;
  page?: number;
  startLine?: number;
  endLine?: number;
  text: string;
};

function rootPath(...parts: string[]) {
  return path.join(process.cwd(), ...parts);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function inferYear(fileName: string): string | undefined {
  const m = fileName.match(/(?:19|20)\d{2}/);
  return m?.[0];
}

function extOf(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
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

    if (e.isFile()) {
      out.push(full);
      continue;
    }

    // Some Windows/OneDrive entries can show up as "unknown" in Dirent (not file/dir).
    // Fall back to stat() to decide.
    try {
      const st = await fs.stat(full);
      if (st.isDirectory()) out.push(...(await listFilesRecursive(full)));
      else if (st.isFile()) out.push(full);
    } catch {
      // ignore unreadable entries
    }
  }
  return out;
}

async function readDriveManifest(): Promise<Map<string, DriveManifestEntry>> {
  const manifestPath = rootPath("data", "drive-manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = DriveManifestSchema.parse(JSON.parse(raw));
    const byPathOrName = new Map<string, DriveManifestEntry>();
    for (const f of parsed.files) {
      if (f.path) byPathOrName.set(f.path, f);
      byPathOrName.set(f.name, f);
    }
    return byPathOrName;
  } catch {
    return new Map();
  }
}

async function extractPdfPages(pdfPath: string): Promise<Array<{ page: number; text: string }>> {
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
    origWarn(...(args as Parameters<typeof origWarn>));
  };

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const anyPdf = pdfjsLib as unknown as {
    setVerbosityLevel?: (level: number) => void;
    VerbosityLevel?: { ERRORS?: number };
  };
  if (anyPdf.setVerbosityLevel && anyPdf.VerbosityLevel?.ERRORS != null) {
    anyPdf.setVerbosityLevel(anyPdf.VerbosityLevel.ERRORS);
  }
  try {
    const buf = await fs.readFile(pdfPath);
    const getDocument = (pdfjsLib as unknown as {
      getDocument: (src: {
        data: Uint8Array;
        standardFontDataUrl?: string;
        disableFontFace?: boolean;
        useSystemFonts?: boolean;
      }) => {
        promise: Promise<PDFDocumentProxy>;
      };
    }).getDocument;
    const standardFontsDir = path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist",
      "standard_fonts",
    );
    const standardFontDataUrl = pathToFileURL(`${standardFontsDir}${path.sep}`).href;
    const loadingTask = getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl,
      disableFontFace: true,
      useSystemFonts: true,
    });
    const doc = await loadingTask.promise;

    const pages: Array<{ page: number; text: string }> = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = (await page.getTextContent()) as TextContent;
      const isTextItem = (it: TextContent["items"][number]): it is TextItem =>
        typeof (it as TextItem).str === "string";
      const strings = textContent.items.filter(isTextItem).map((it) => it.str);
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      pages.push({ page: pageNum, text });
    }
    return pages;
  } finally {
    console.warn = origWarn;
  }
}

function chunkTextByChars(text: string, target = 3500): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= target) return [cleaned];
  const out: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    out.push(cleaned.slice(i, i + target));
    i += target;
  }
  return out;
}

function chunkLines(lines: string[], linesPerChunk = 120): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const start = i + 1;
    const end = Math.min(lines.length, i + linesPerChunk);
    const text = lines.slice(i, end).join("\n").trim();
    if (text) out.push({ start, end, text });
  }
  return out;
}

async function main() {
  const inputDir = rootPath("data", "files");
  const outDir = rootPath("data", "index");
  await ensureDir(outDir);

  const driveByName = await readDriveManifest();

  let filesOnDisk: string[] = [];
  try {
    filesOnDisk = await listFilesRecursive(inputDir);
  } catch {
    console.error(`Missing ${inputDir}. Create it and put files there, or run docs:sync.`);
    process.exit(1);
  }

  const allowedExt = new Set(["pdf", "txt", "py", "m"]);
  const selected = filesOnDisk
    .filter((p) => allowedExt.has(extOf(p)))
    .sort((a, b) => a.localeCompare(b));

  const files: FileMeta[] = [];
  const chunks: Chunk[] = [];

  for (const fullPath of selected) {
    const fileName = path.relative(inputDir, fullPath).replace(/\\/g, "/");
    const ext = extOf(fileName);
    const stat = await fs.stat(fullPath);
    const bytes = stat.size;
    const id = `file_${files.length + 1}`;
    const kind: "pdf" | "text" = ext === "pdf" ? "pdf" : "text";
    const year = kind === "pdf" ? inferYear(fileName) : undefined;

    const drive = driveByName.get(fileName) ?? driveByName.get(path.basename(fileName));
    files.push({
      id,
      fileName,
      kind,
      ext,
      year,
      bytes,
      drive: drive ? { fileId: drive.id, webViewLink: drive.webViewLink } : undefined,
    });

    if (kind === "pdf") {
      const pages = await extractPdfPages(fullPath);
      for (const p of pages) {
        if (!p.text) continue;
        const segments = chunkTextByChars(p.text, 3500);
        for (let s = 0; s < segments.length; s++) {
          const chunkId = `${id}:p${p.page}:s${s + 1}`;
          chunks.push({
            chunkId,
            fileId: id,
            fileName,
            kind,
            year,
            page: p.page,
            text: segments[s]!,
          });
        }
      }
      continue;
    }

    const raw = await fs.readFile(fullPath, "utf8");
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const lineChunks = chunkLines(lines, 140);
    for (let i = 0; i < lineChunks.length; i++) {
      const lc = lineChunks[i]!;
      const chunkId = `${id}:l${lc.start}-${lc.end}`;
      chunks.push({
        chunkId,
        fileId: id,
        fileName,
        kind,
        startLine: lc.start,
        endLine: lc.end,
        text: lc.text,
      });
    }
  }

  const mini = new MiniSearch({
    fields: ["text", "fileName"],
    storeFields: ["chunkId"],
    idField: "chunkId",
    searchOptions: {
      boost: { fileName: 4, text: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });

  for (const c of chunks) {
    mini.add({ chunkId: c.chunkId, text: c.text, fileName: c.fileName });
  }

  const bundle = {
    generatedAt: new Date().toISOString(),
    files,
    chunks,
    miniSearch: mini.toJSON(),
  };

  const outPath = path.join(outDir, "bundle.json");
  await fs.writeFile(outPath, JSON.stringify(bundle), "utf8");

  console.log(
    `Indexed ${files.length} files -> ${chunks.length} chunks. Wrote ${path.relative(process.cwd(), outPath)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

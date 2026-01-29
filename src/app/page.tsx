"use client";

/* eslint-disable @next/next/no-img-element */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type ChatImage = {
  id: string;
  dataUrl: string;
  mimeType: string;
};

type SourceRef = {
  chunkId: string;
  title: string;
  location: string;
  excerpt: string;
  externalUrl?: string;
};

type BookOption = {
  fileName: string;
  label: string;
};

type SearchInfo = {
  query: string;
  year?: string;
  planner?: null;
  plannerKeywords: string[];
  fileNameHints?: string[];
  visionSummary: string | null;
  visionKeywords: string[];
  visionStatementsCount?: number;
  visionSearchQueriesCount?: number;
  scope?: string;
  kinds?: string[];
  retrievedChunks: number;
  matchedFiles: string[];
};

type ChatMessage =
  | { id: string; role: "user"; content: string; images: ChatImage[] }
  | { id: string; role: "assistant"; content: string; sources: SourceRef[]; searchInfo?: SearchInfo };

type FsQuizQuestion = {
  question_id?: number | string;
  text?: string;
  type?: string;
  answers?: Array<{ answer_id: number; answer_text: string; is_correct: boolean }>;
  images?: Array<{ img_id: number; path: string }>;
  solutions?: Array<{ solution_id: number; text: string }>;
  solution?: Array<{ solution_id: number; text: string }>;
};

type FsQuizQuestionInfo = {
  question_id?: number | string;
  text?: string;
  time?: number | null;
  type?: string;
};

type FsQuizContext = {
  questionId: string;
  questionText: string;
  correctAnswers: string[];
  imageUrls: string[];
};

type AssistantBubbleProps = {
  content: string;
};

type FsQuizLookupMatch = {
  questionId: number;
  score: number;
  text: string;
  imageUrls: string[];
};

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeMarkdownMath(input: string) {
  let out = input;
  out = out.replace(/\\\[((?:.|\n)*?)\\\]/g, (_, inner: string) => `$$\n${inner.trim()}\n$$`);
  out = out.replace(/\\\(((?:.|\n)*?)\\\)/g, (_, inner: string) => `$${inner.trim()}$`);
  out = out.replace(
    /\[(\s*\\(?:frac|text|sum|int|approx|sqrt|begin|left|right)[\s\S]*?)\](?!\()/g,
    (_, inner: string) => `$$\n${inner.trim()}\n$$`,
  );
  return out;
}

const AssistantBubble = memo(function AssistantBubble({ content }: AssistantBubbleProps) {
  return (
    <div className="text-sm leading-6 text-white/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              {...props}
              className="mb-2 mt-4 text-xl font-bold uppercase tracking-[0.08em] text-white"
              style={{ fontFamily: "var(--font-logo), var(--font-geist-sans), ui-sans-serif, system-ui" }}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              {...props}
              className="mb-2 mt-4 text-lg font-bold uppercase tracking-[0.08em] text-white"
              style={{ fontFamily: "var(--font-logo), var(--font-geist-sans), ui-sans-serif, system-ui" }}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              {...props}
              className="mb-2 mt-3 text-base font-bold uppercase tracking-[0.06em] text-white"
              style={{ fontFamily: "var(--font-logo), var(--font-geist-sans), ui-sans-serif, system-ui" }}
            >
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4
              {...props}
              className="mb-1 mt-3 text-sm font-bold uppercase tracking-[0.06em] text-white"
              style={{ fontFamily: "var(--font-logo), var(--font-geist-sans), ui-sans-serif, system-ui" }}
            >
              {children}
            </h4>
          ),
          p: ({ children, ...props }) => (
            <p {...props} className="my-2 text-sm leading-6 text-white/90">
              {children}
            </p>
          ),
          ul: ({ children, ...props }) => (
            <ul {...props} className="my-2 list-disc space-y-1 pl-5 text-sm text-white/90">
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol {...props} className="my-2 list-decimal space-y-1 pl-5 text-sm text-white/90">
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => (
            <li {...props} className="text-sm text-white/90">
              {children}
            </li>
          ),
          a: ({ children, ...props }) => (
            <a {...props} className="text-white/85 underline decoration-white/25 underline-offset-2 hover:text-white">
              {children}
            </a>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              {...props}
              className="my-3 border-l-2 border-white/15 bg-white/5 px-3 py-2 text-sm text-white/85"
            >
              {children}
            </blockquote>
          ),
          hr: (props) => <hr {...props} className="my-4 border-white/10" />,
          code: ({ children, ...props }) => (
            <code {...props} className="rounded bg-black/40 px-1 py-0.5 text-[12px] text-white/90">
              {children}
            </code>
          ),
          pre: ({ children, ...props }) => (
            <pre
              {...props}
              className="my-3 overflow-x-auto rounded border border-white/10 bg-black/40 p-3 text-[12px] leading-5 text-white/90"
            >
              {children}
            </pre>
          ),
          img: (props) => (
            <img
              {...props}
              alt={props.alt ?? ""}
              className="my-3 max-w-full rounded-xl border border-white/10 bg-black/20"
            />
          ),
          table: ({ children, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table {...props} className="w-full table-auto border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead {...props} className="bg-white/5">
              {children}
            </thead>
          ),
          th: ({ children, ...props }) => (
            <th
              {...props}
              className="border border-white/10 px-2 py-1 text-left text-xs font-semibold text-white/90"
            >
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="border border-white/10 px-2 py-1 align-top text-xs text-white/85">
              {children}
            </td>
          ),
        }}
      >
        {normalizeMarkdownMath(content)}
      </ReactMarkdown>
    </div>
  );
});

export default function Home() {
  const [year, setYear] = useState<string>("");
  const [availableYears, setAvailableYears] = useState<string[]>([]);
  const [setupDone, setSetupDone] = useState(false);
  const [booksLoading, setBooksLoading] = useState(false);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [handbookOptions, setHandbookOptions] = useState<BookOption[]>([]);
  const [rulesOptions, setRulesOptions] = useState<BookOption[]>([]);
  const [handbookFile, setHandbookFile] = useState<string>("");
  const [rulesFile, setRulesFile] = useState<string>("");
  const [indexReady, setIndexReady] = useState<boolean>(true);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [indexFileCount, setIndexFileCount] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idMode, setIdMode] = useState<"answer" | "explain" | null>(null);
  const [lookupMode, setLookupMode] = useState(false);
  const [idLookupValue, setIdLookupValue] = useState("");
  const [idLookupBusy, setIdLookupBusy] = useState(false);
  const [fsQuizContext, setFsQuizContext] = useState<FsQuizContext | null>(null);
  const [openSource, setOpenSource] = useState<SourceRef | null>(null);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const answerStartedRef = useRef(false);
  const streamBufferRef = useRef<string>("");
  const flushTimerRef = useRef<number | null>(null);
  const adminHoldTimerRef = useRef<number | null>(null);

  const [adminOpen, setAdminOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{
    localEligibleCount: number;
    syncedCount: number | null;
    lastSyncAt: string | null;
    vectorStoreId: string | null;
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{
    uploaded: number;
    kept: number;
    removed: number;
    desiredCount: number;
    lastSyncAt?: string;
  } | null>(null);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(null);

  const openAdmin = () => {
    setSyncError(null);
    setSyncResult(null);
    setAdminOpen(true);
  };

  const closeAdmin = () => {
    setAdminOpen(false);
    setSyncBusy(false);
  };

  const refreshSyncStatus = async () => {
    try {
      const res = await fetch("/api/sync", { method: "GET" });
      const data = (await res.json()) as
        | {
            ok: true;
            localEligibleCount: number;
            vectorStoreId: string | null;
            lastSyncAt: string | null;
            syncedCount: number | null;
          }
        | { ok: false; error?: string };
      if (!("ok" in data) || data.ok !== true) return;
      setSyncStatus({
        localEligibleCount: data.localEligibleCount ?? 0,
        syncedCount: typeof data.syncedCount === "number" ? data.syncedCount : null,
        lastSyncAt: data.lastSyncAt ?? null,
        vectorStoreId: data.vectorStoreId ?? null,
      });
    } catch {
      // ignore
    }
  };

  const runSync = async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = (await res.json()) as
        | {
            ok: true;
            vectorStoreId: string;
            desiredCount: number;
            uploaded: number;
            removed: number;
            kept: number;
            lastSyncAt?: string;
          }
        | { ok: false; error?: string };
      if (!("ok" in data) || data.ok !== true) {
        setSyncError(("error" in data && data.error) || "Sync failed.");
        return;
      }
      setSyncResult({
        uploaded: data.uploaded,
        kept: data.kept,
        removed: data.removed,
        desiredCount: data.desiredCount,
        lastSyncAt: data.lastSyncAt,
      });
      await refreshSyncStatus();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncBusy(false);
    }
  };

  useEffect(() => {
    if (!adminOpen) return;
    void refreshSyncStatus();
  }, [adminOpen]);

  useEffect(() => {
    // Changing scope should reset the model's conversation state.
    setPreviousResponseId(null);
  }, [setupDone, year, handbookFile, rulesFile]);

  const addPastedImage = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const maxBytes = 3_000_000;
    if (file.size > maxBytes) {
      setError(`Image is too large (${Math.round(file.size / 1024 / 1024)}MB). Max 3MB.`);
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read image."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    setPendingImages((prev) => {
      if (prev.length >= 4) return prev;
      return [
        ...prev,
        {
          id: `img_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          dataUrl,
          mimeType: file.type,
        },
      ];
    });
  };

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch("/api/manifest", { method: "GET" });
        if (!res.ok) throw new Error(`Manifest request failed (${res.status}).`);
        const data = (await res.json()) as {
          years?: string[];
          indexReady?: boolean;
          message?: string;
          fileCount?: number;
        };
        const years = (data.years ?? [])
          .map(String)
          .sort((a, b) => b.localeCompare(a));
        setAvailableYears(years);
        setIndexReady(Boolean(data.indexReady ?? true));
        setIndexMessage(data.message ?? null);
        setIndexFileCount(typeof data.fileCount === "number" ? data.fileCount : null);
      } catch {
        // ignore
      }
    };
    void run();
  }, []);

  useEffect(() => {
    if (!year) return;
    setBooksError(null);
    setBooksLoading(true);
    setHandbookOptions([]);
    setRulesOptions([]);
    setHandbookFile("");
    setRulesFile("");

    const run = async () => {
      try {
        const res = await fetch(`/api/books?year=${encodeURIComponent(year)}`, { method: "GET" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Books request failed (${res.status}): ${text.slice(0, 140)}`);
        }
        const data = (await res.json()) as
          | { ok: true; year: string; handbooks: BookOption[]; rules: BookOption[] }
          | { ok: false; error?: string };
        if (!("ok" in data) || data.ok !== true) {
          setBooksError(("error" in data && data.error) || "Could not load handbooks/rules.");
          return;
        }
        const dedupe = (opts: BookOption[]) => {
          const byFile = new Map<string, BookOption>();
          for (const o of opts) {
            if (!byFile.has(o.fileName)) byFile.set(o.fileName, o);
          }
          return Array.from(byFile.values());
        };
        const handbooks = dedupe(data.handbooks ?? []);
        const rules = dedupe(data.rules ?? []);
        setHandbookOptions(handbooks);
        setRulesOptions(rules);
        setHandbookFile(handbooks[0]?.fileName ?? "");
        setRulesFile(rules[0]?.fileName ?? "");
      } catch (e) {
        setBooksError(e instanceof Error ? e.message : "Could not load handbooks/rules.");
      } finally {
        setBooksLoading(false);
      }
    };

    void run();
  }, [year]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const raf = requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, busy]);

  const canSend = useMemo(() => {
    if (busy) return false;
    if (idMode) return false;
    if (lookupMode) return input.trim().length > 0 || pendingImages.length > 0;
    return input.trim().length > 0 || pendingImages.length > 0;
  }, [input, pendingImages.length, busy, idMode, lookupMode]);

  const renderedMessages = useMemo(() => {
    if (showAllMessages) return messages;
    const max = 12;
    return messages.length > max ? messages.slice(-max) : messages;
  }, [messages, showAllMessages]);

  const yearOptions = useMemo(
    () => (availableYears.length ? availableYears : ["2026", "2025", "2024"]),
    [availableYears],
  );

  const handbookLabel = useMemo(
    () => handbookOptions.find((o) => o.fileName === handbookFile)?.label ?? "",
    [handbookOptions, handbookFile],
  );

  const rulesLabel = useMemo(
    () => rulesOptions.find((o) => o.fileName === rulesFile)?.label ?? "",
    [rulesOptions, rulesFile],
  );

  const canEnterApp =
    Boolean(year) &&
    !booksLoading &&
    (!handbookOptions.length || Boolean(handbookFile)) &&
    (!rulesOptions.length || Boolean(rulesFile));

  const newChat = () => {
    if (busy) return;
    setMessages([]);
    setPreviousResponseId(null);
    setError(null);
    setIdMode(null);
    setLookupMode(false);
    setIdLookupValue("");
    setFsQuizContext(null);
    setOpenSource(null);
    setShowAllMessages(false);
    setInput("");
    setPendingImages([]);
  };

  const escapeMdCell = (value: string) =>
    value
      .replaceAll("\\", "\\\\")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ")
      .trim();

  const formatApiQuestionMarkdown = (question: FsQuizQuestion, info?: FsQuizQuestionInfo | null) => {
    const questionId = (question?.question_id ?? "").toString().trim();
    const questionText = (question?.text ?? info?.text ?? "").trim();

    const allAnswers = Array.isArray(question?.answers) ? question!.answers : [];
    const correctAnswers = allAnswers.filter((a) => a.is_correct);

    const lines: string[] = [];

    const images = Array.isArray(question?.images) ? question!.images : [];
    if (images.length) {
      lines.push(`### Question (ID ${questionId || "?"})`);
      if (questionText) lines.push(questionText);
      lines.push("\n");
      for (let i = 0; i < images.length; i += 1) {
        const img = images[i]!;
        const path = String(img.path || "").replace(/^\/+/, "");
        const url = `https://img.fs-quiz.eu/${path}`;
        lines.push(`![Question image ${i + 1}](${url})`);
      }
    } else {
      lines.push(`### Question (ID ${questionId || "?"})`);
      if (questionText) lines.push(questionText);
    }

    if (info && (info.type || info.time != null)) {
      const infoLines: string[] = [];
      if (info.type) infoLines.push(`- Type: ${info.type}`);
      if (info.time != null) infoLines.push(`- Time: ${info.time}s`);
      if (infoLines.length) {
        lines.push("\n### Info");
        for (const l of infoLines) lines.push(l);
      }
    }

    if (correctAnswers.length) {
      lines.push("\n### Correct answer");
      for (const a of correctAnswers) lines.push(`- ${escapeMdCell(a.answer_text)}`);
    } else {
      lines.push("\n### Correct answer");
      lines.push("_Not provided by API._");
    }

    const solutions = Array.isArray(question?.solutions)
      ? question!.solutions
      : Array.isArray(question?.solution)
        ? question!.solution
        : [];
    const solutionText = solutions.map((s) => (s.text ?? "").trim()).filter(Boolean);
    if (solutionText.length) {
      lines.push("\n### Solution");
      for (const t of solutionText) lines.push(`- ${t}`);
    }

    return lines.join("\n\n").trim();
  };

  const formatLookupResultsMarkdown = (opts: {
    questions: Array<{ question: FsQuizQuestion; info?: FsQuizQuestionInfo | null }>;
    hadMatches: boolean;
  }) => {
    if (!opts.hadMatches) return "_No good matches found._";
    if (!opts.questions.length) return "_Matches found, but could not fetch question details._";
    return opts.questions.map((q) => formatApiQuestionMarkdown(q.question, q.info)).join("\n\n");
  };

  const lookupQuestions = async (query: string, images: ChatImage[]) => {
    const trimmed = query.trim();
    if (!trimmed && images.length === 0) return;
    if (busy || idLookupBusy) return;

    setError(null);
    setBusy(true);

    const assistantId = makeId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: images.length ? "_Extracting text + searching FS-Quiz…_" : "_Searching FS-Quiz…_",
      sources: [],
    };
    const userMsg: ChatMessage = { id: makeId(), role: "user", content: trimmed || "(image)", images };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const updateAssistant = (content: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId && m.role === "assistant" ? { ...m, content } : m)),
      );
    };

    try {
      const res = await fetch("/api/fsquiz/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          images: images.map((i) => i.dataUrl),
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok: true;
            complete: boolean;
            indexedCount: number;
            newlyIndexed: number;
            queryUsed: string;
            extractedText: string;
            matches: FsQuizLookupMatch[];
            debugMatch?: { questionId: number; score: number; text: string } | null;
          }
        | { ok: false; error?: string }
        | null;

      if (!res.ok || !data || !("ok" in data) || data.ok !== true) {
        const msg = (data && "error" in data && data.error) || `Lookup failed (${res.status}).`;
        updateAssistant(`**Lookup error:** ${msg}`);
        return;
      }

      const matches = data.matches ?? [];
      if (!matches.length) {
        const stats = `\n\n_Indexed ${data.indexedCount} question(s), +${data.newlyIndexed} this run._`;
        const debugLine = data.debugMatch
          ? `\n\n_Debug best match: ID ${data.debugMatch.questionId} (score ${data.debugMatch.score.toFixed(3)})_\n${data.debugMatch.text}`
          : "";
        updateAssistant(`${formatLookupResultsMarkdown({ questions: [], hadMatches: false })}${stats}${debugLine}`);
        return;
      }

      const questions: Array<{ question: FsQuizQuestion; info?: FsQuizQuestionInfo | null }> = [];
      for (const m of matches.slice(0, 1)) {
        try {
          const qRes = await fetch(`/api/fsquiz/question/${m.questionId}`, { method: "GET" });
          const qData = (await qRes.json().catch(() => null)) as
            | { ok: true; question: FsQuizQuestion; info?: FsQuizQuestionInfo | null }
            | { ok: false; error?: string }
            | null;
          if (!qRes.ok || !qData || !("ok" in qData) || qData.ok !== true) continue;
          questions.push({ question: qData.question, info: qData.info ?? null });
        } catch {
          // ignore
        }
      }

      const base = formatLookupResultsMarkdown({ questions, hadMatches: true });
      updateAssistant(base);
    } catch (e) {
      updateAssistant(`**Lookup error:** ${e instanceof Error ? e.message : "Lookup failed."}`);
    } finally {
      setBusy(false);
    }
  };

  const sendChatRequest = async (opts: {
    requestQuestion: string;
    uiUserQuestion?: string | null;
    imagesToSend: ChatImage[];
    fsQuizContextOverride?: FsQuizContext | null;
  }) => {
    const requestQuestion = opts.requestQuestion.trim();
    const uiUserQuestion = opts.uiUserQuestion === undefined ? requestQuestion : opts.uiUserQuestion;
    const imagesToSend = opts.imagesToSend;

    if ((!requestQuestion && imagesToSend.length === 0) || busy) return;

    if (process.env.NODE_ENV !== "production") {
      console.log("[ui] send", {
        year,
        handbookFile,
        rulesFile,
        questionChars: requestQuestion.length,
        images: imagesToSend.length,
        fsQuizContext: (opts.fsQuizContextOverride ?? fsQuizContext)?.questionId ?? null,
      });
    }

    setError(null);
    setBusy(true);
    answerStartedRef.current = false;

    const assistantId = makeId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      sources: [],
    };

    const userMsg =
      uiUserQuestion != null
        ? ({
            id: makeId(),
            role: "user",
            content: uiUserQuestion,
            images: imagesToSend,
          } as const)
        : null;

    setMessages((prev) => {
      const next = [...prev];
      if (userMsg) next.push(userMsg);
      next.push(assistantMsg);
      return next;
    });

    const updateAssistant = (update: (prev: Extract<ChatMessage, { role: "assistant" }>) => ChatMessage) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId && m.role === "assistant" ? update(m) : m)),
      );
    };

    const flushBuffered = () => {
      if (!streamBufferRef.current) return;
      const text = streamBufferRef.current;
      streamBufferRef.current = "";
      updateAssistant((prev) =>
        prev.role === "assistant" ? { ...prev, content: `${prev.content}${text}` } : prev,
      );
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        flushBuffered();
      }, 120);
    };

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 120_000);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          previousResponseId: previousResponseId || undefined,
          year: year || undefined,
          handbookFile: handbookFile || undefined,
          rulesFile: rulesFile || undefined,
          question: requestQuestion,
          images: imagesToSend.map((p) => p.dataUrl),
          fsQuizContext: (opts.fsQuizContextOverride ?? fsQuizContext) || undefined,
        }),
      });
      window.clearTimeout(timeout);

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Something went wrong.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const payload = JSON.parse(trimmed) as {
              type: string;
              text?: string;
              answerMarkdown?: string;
              sources?: SourceRef[];
              searchInfo?: SearchInfo;
              error?: string;
              responseId?: string;
            };

            if (payload.type === "meta" && payload.responseId) {
              setPreviousResponseId(payload.responseId);
            }

            if (payload.type === "meta" && payload.searchInfo) {
              updateAssistant((prev) =>
                prev.role === "assistant" ? { ...prev, searchInfo: payload.searchInfo } : prev,
              );
              continue;
            }

            if (payload.type === "delta" && payload.text) {
              if (!answerStartedRef.current) answerStartedRef.current = true;
              streamBufferRef.current += payload.text;
              scheduleFlush();
              continue;
            }

            if (payload.type === "done") {
              if (flushTimerRef.current != null) {
                window.clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushBuffered();
              updateAssistant((prev) =>
                prev.role === "assistant"
                  ? {
                      ...prev,
                      content: payload.answerMarkdown ?? prev.content,
                      sources: payload.sources ?? prev.sources,
                      searchInfo: payload.searchInfo ?? prev.searchInfo,
                    }
                  : prev,
              );
              continue;
            }

            if (payload.type === "error") {
              setError(payload.error ?? "Something went wrong.");
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      streamBufferRef.current = "";
      setBusy(false);
      answerStartedRef.current = false;
    }
  };

  const lookupQuestionById = async (mode: "answer" | "explain") => {
    const trimmed = idLookupValue.trim();
    const id = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(id) || id < 0 || id > 1_000_000) {
      setError("Enter a valid question ID (0–1,000,000).");
      return;
    }
    if (busy || idLookupBusy) return;

    setError(null);
    setIdLookupBusy(true);

    try {
      const res = await fetch(`/api/fsquiz/question/${id}`, { method: "GET" });
      const data = (await res.json()) as
        | { ok: true; question: FsQuizQuestion; info?: FsQuizQuestionInfo | null }
        | { ok: false; error?: string };

      if (!("ok" in data) || data.ok !== true) {
        throw new Error(data.error || "Lookup failed.");
      }

      const qid = String(data.question.question_id ?? id).trim();
      const qtext = (data.question.text ?? "").trim();
      const imgs = Array.isArray(data.question.images) ? data.question.images : [];
      const imageUrls = imgs
        .map((img) => String(img.path || "").replace(/^\/+/, ""))
        .filter(Boolean)
        .slice(0, 4)
        .map((p) => `https://img.fs-quiz.eu/${p}`);

      const allAnswers = Array.isArray(data.question.answers) ? data.question.answers : [];
      const correctAnswers = allAnswers
        .filter((a) => a.is_correct)
        .map((a) => (a.answer_text ?? "").trim())
        .filter(Boolean)
        .slice(0, 8);

      setFsQuizContext({
        questionId: qid,
        questionText: qtext,
        correctAnswers,
        imageUrls,
      });

      const md = formatApiQuestionMarkdown(data.question, data.info ?? null);
      setMessages((prev) => [...prev, { id: makeId(), role: "assistant", content: md, sources: [] }]);
      setIdMode(null);
      setIdLookupValue("");

      if (mode === "explain") {
        const correct = correctAnswers.length ? correctAnswers.join(" | ") : "(not provided)";
        const prompt = [
          `Explain step-by-step how to solve FS-Quiz question ID ${qid}.`,
          "Use the provided image(s) and question text.",
          `The correct answer is: ${correct}.`,
          "Show the full reasoning and calculations (with formulas) so I can understand how to get that answer.",
          "If the question is rules-based, use file search and cite the rule text.",
          "Do not change the final answer; explain why it is correct.",
        ].join("\n");

        await sendChatRequest({
          requestQuestion: prompt,
          uiUserQuestion: null,
          imagesToSend: [],
          fsQuizContextOverride: {
            questionId: qid,
            questionText: qtext,
            correctAnswers,
            imageUrls,
          },
        });
      }

      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lookup failed.";
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: "assistant", content: `**FS-Quiz API error:** ${msg}`, sources: [] },
      ]);
    } finally {
      setIdLookupBusy(false);
    }
  };

  const onSend = async () => {
    const question = input.trim();
    if ((!question && pendingImages.length === 0) || busy) return;
    const imagesToSend = [...pendingImages];

    if (lookupMode) {
      setInput("");
      setPendingImages([]);
      setError(null);
      await lookupQuestions(question, imagesToSend);
      return;
    }

    setInput("");
    setPendingImages([]);
    setError(null);

    await sendChatRequest({
      requestQuestion: question,
      uiUserQuestion: question,
      imagesToSend,
    });
  };

  return (
    <div className="min-h-screen">
      {!setupDone ? (
        <main className="relative mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10">
          <div className="pointer-events-none fixed inset-0 -z-10">
            <video
              className="h-full w-full object-cover opacity-10"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
            >
              <source src="/setup-bg.mp4" type="video/mp4" />
            </video>
          </div>

          <div className="rounded-3xl border border-white/10 bg-black/25 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
            <div className="text-center">
              <div className="text-3xl font-bold tracking-[0.12em] sm:text-4xl">
                <span
                  className="bg-gradient-to-r from-white/90 to-white/60 bg-clip-text text-transparent"
                  style={{ fontFamily: "var(--font-logo), var(--font-geist-sans), ui-sans-serif, system-ui" }}
                >
                  FS QUIZTOOL
                </span>
              </div>
            </div>

            {!indexReady || indexFileCount === 0 ? (
              <div className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 ring-1 ring-white/5">
                <div className="font-semibold">
                  {!indexReady ? "OpenAI not configured" : "No local files found"}
                </div>
                <div className="mt-1 text-amber-100/80">
                  {indexMessage ??
                    (!indexReady
                      ? "Set OPENAI_API_KEY in .env.local to enable OpenAI file search."
                      : "Add files under data/files (PDFs + scripts).")}
                </div>
                {indexReady ? (
                  <div className="mt-2 text-xs text-amber-100/80">
                    Optional: <span className="rounded bg-black/40 px-2 py-0.5">npm run openai:sync</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-6">
              <div className="text-sm font-semibold text-white/80">Select what year:</div>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {yearOptions.map((y) => {
                  const active = y === year;
                  return (
                      <button
                        key={y}
                        type="button"
                        onClick={() => setYear(y)}
                        className={[
                          "h-10 w-20 rounded-xl border px-3 text-sm font-semibold sm:w-24",
                          active
                            ? "border-white/25 bg-white/10 text-white"
                            : "border-white/10 bg-transparent text-white/85 hover:bg-white/5",
                        ].join(" ")}
                      >
                        {y}
                      </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-6 grid gap-4">
              <div className="grid gap-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-white/60" htmlFor="handbook">
                  Handbook
                </label>
                <select
                  id="handbook"
                  className="h-10 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white shadow-sm outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
                  value={handbookFile}
                  onChange={(e) => setHandbookFile(e.target.value)}
                  disabled={!year || booksLoading || handbookOptions.length === 0}
                >
                  {handbookOptions.length === 0 ? (
                    <option value="" className="bg-black text-white">
                      {!year ? "Select year first" : booksLoading ? "Loading..." : "No handbook files found"}
                    </option>
                  ) : null}
                  {handbookOptions.map((o) => (
                    <option key={o.fileName} value={o.fileName} className="bg-black text-white">
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-white/60" htmlFor="rules">
                  Rule book
                </label>
                <select
                  id="rules"
                  className="h-10 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white shadow-sm outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
                  value={rulesFile}
                  onChange={(e) => setRulesFile(e.target.value)}
                  disabled={!year || booksLoading || rulesOptions.length === 0}
                >
                  {rulesOptions.length === 0 ? (
                    <option value="" className="bg-black text-white">
                      {!year ? "Select year first" : booksLoading ? "Loading..." : "No rules files found"}
                    </option>
                  ) : null}
                  {rulesOptions.map((o) => (
                    <option key={o.fileName} value={o.fileName} className="bg-black text-white">
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {booksError ? (
                <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {booksError}
                </div>
              ) : null}

              <button
                type="button"
                className="h-11 rounded-xl border border-white/15 bg-transparent px-4 text-sm font-semibold text-white/90 hover:bg-white/5 disabled:opacity-50"
                onClick={() => setSetupDone(true)}
                disabled={!canEnterApp}
              >
                Continue
              </button>
            </div>
          </div>
        </main>
      ) : (
        <>
          <header className="sticky top-0 z-10 border-b border-white/10 bg-black/35">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
              <div className="flex flex-col">
                <div className="text-sm font-semibold tracking-tight">
                  <button
                    type="button"
                    className="select-none bg-gradient-to-r from-white/90 to-white/60 bg-clip-text text-left text-transparent"
                    onPointerDown={() => {
                      if (adminHoldTimerRef.current != null) window.clearTimeout(adminHoldTimerRef.current);
                      adminHoldTimerRef.current = window.setTimeout(() => {
                        adminHoldTimerRef.current = null;
                        openAdmin();
                      }, 2000);
                    }}
                    onPointerUp={() => {
                      if (adminHoldTimerRef.current != null) window.clearTimeout(adminHoldTimerRef.current);
                      adminHoldTimerRef.current = null;
                    }}
                    onPointerCancel={() => {
                      if (adminHoldTimerRef.current != null) window.clearTimeout(adminHoldTimerRef.current);
                      adminHoldTimerRef.current = null;
                    }}
                    onPointerLeave={() => {
                      if (adminHoldTimerRef.current != null) window.clearTimeout(adminHoldTimerRef.current);
                      adminHoldTimerRef.current = null;
                    }}
                    aria-label="FS QUIZTOOL"
                  >
                    <span
                      className="text-lg font-bold uppercase tracking-[0.12em] sm:text-xl"
                      style={{ fontFamily: "var(--font-logo), var(--font-geist-sans), ui-sans-serif, system-ui" }}
                    >
                      FS QUIZTOOL
                    </span>
                  </button>
                </div>
 
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
                  <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1">Year {year}</span>
                  {handbookLabel ? (
                    <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
                      Handbook: {handbookLabel}
                    </span>
                  ) : null}
                  {rulesLabel ? (
                    <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
                      Rules: {rulesLabel}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="rounded-md border border-white/10 bg-transparent px-2 py-1 text-xs font-semibold text-white/80 hover:bg-white/5 hover:text-white"
                  onClick={() => setSetupDone(false)}
                >
                  Change
                </button>
              </div>
            </div>
          </header>

          <main className="mx-auto flex h-[calc(100vh-56px)] max-w-6xl flex-col px-4 py-4">
            <section className="flex min-h-0 flex-1 flex-col gap-3">
            {!indexReady || indexFileCount === 0 ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 ring-1 ring-white/5">
                <div className="font-semibold">
                  {!indexReady ? "OpenAI not configured" : "No local files found"}
                </div>
                <div className="mt-1 text-amber-100/80">
                  {indexMessage ??
                    (!indexReady
                      ? "Set OPENAI_API_KEY in .env.local to enable OpenAI file search."
                      : "Add files under data/files (PDFs + scripts).")}
                </div>
                {indexReady ? (
                  <div className="mt-2 text-xs text-amber-100/80">
                    Optional: <span className="rounded bg-black/40 px-2 py-0.5">npm run openai:sync</span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="relative min-h-0 flex-1">
              <button
                type="button"
                aria-label="New chat"
                onClick={newChat}
                disabled={busy}
                className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center text-base font-semibold text-white/60 hover:bg-white/5 hover:text-white disabled:opacity-40"
              >
                +
              </button>

              <div
                ref={scrollerRef}
                className="no-scrollbar h-full overflow-auto rounded-2xl border border-white/10 bg-white/5 p-4 pt-12 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
              >
                <div className="space-y-4">
                {messages.length === 0 && !busy ? (
                  <div className="flex justify-center">
                    <div className="max-w-xl text-center text-sm text-white/70">
                      Paste the question as text or an image and I will find the correct answer for you.
                    </div>
                  </div>
                ) : null}
                {!showAllMessages && messages.length > renderedMessages.length ? (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      className="rounded-full border border-white/10 bg-transparent px-3 py-1 text-xs text-white/70 hover:bg-white/5 hover:text-white"
                      onClick={() => setShowAllMessages(true)}
                    >
                      Show earlier messages ({messages.length - renderedMessages.length})
                    </button>
                  </div>
                ) : null}

                {renderedMessages.map((m, idx) => {
                  const isLast = idx === renderedMessages.length - 1;
                  const showSearchingBubble = m.role === "assistant" && !m.content && busy && isLast;
                  if (showSearchingBubble) {
                    return (
                      <div key={m.id} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl bg-black/30 px-4 py-3 text-sm text-white ring-1 ring-white/10">
                          <span>
                            Thinking
                            <span className="loading-dots" aria-hidden="true">
                              <span>.</span>
                              <span>.</span>
                              <span>.</span>
                            </span>
                          </span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                      <div
                        className={[
                          "max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6",
                          m.role === "user"
                            ? "bg-gradient-to-r from-white/10 to-white/5 text-white ring-1 ring-white/10"
                            : "bg-black/30 text-white ring-1 ring-white/10",
                        ].join(" ")}
                      >
                      {m.role === "assistant" ? (
                        <AssistantBubble content={m.content} />
                      ) : (
                        <div className="space-y-2">
                          {m.content ? <div className="whitespace-pre-wrap">{m.content}</div> : null}
                          {m.images.length ? (
                            <div className="grid grid-cols-2 gap-2">
                              {m.images.map((img) => (
                                <img
                                  key={img.id}
                                  src={img.dataUrl}
                                  alt="Pasted"
                                  className="h-auto w-full rounded-xl border border-white/10 object-cover"
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )}

                      {"sources" in m && m.sources.length > 0 ? (
                        <div className="mt-3 border-t border-white/10 pt-2">
                          <details>
                            <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-white/55 hover:text-white/80">
                              <span className="details-arrow" aria-hidden="true">
                                ▸
                              </span>
                              <span className="sr-only">Details</span>
                            </summary>

                            {"searchInfo" in m && m.searchInfo ? (
                              <div className="mt-2 text-xs text-white/65">
                                <div>
                                  <span className="text-white/85">{m.searchInfo.query}</span>
                                  {m.searchInfo.year ? <> (year {m.searchInfo.year})</> : null}
                                </div>
                                {m.searchInfo.scope ? (
                                  <div className="mt-1">
                                    Scope: <span className="text-white/75">{m.searchInfo.scope}</span>
                                  </div>
                                ) : null}
                                {m.searchInfo.kinds?.length ? (
                                  <div className="mt-1">
                                    File types: <span className="text-white/75">{m.searchInfo.kinds.join(", ")}</span>
                                  </div>
                                ) : null}
                                {typeof m.searchInfo.visionStatementsCount === "number" ? (
                                  <div className="mt-1">
                                    Image statements:{" "}
                                    <span className="text-white/75">{m.searchInfo.visionStatementsCount}</span>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="mt-2 flex flex-col gap-1">
                              {m.sources.map((s, i) => (
                                <button
                                  key={s.chunkId}
                                  className="text-left text-xs text-white/80 underline decoration-white/25 underline-offset-2 hover:text-white"
                                  onClick={() => setOpenSource(s)}
                                  type="button"
                                >
                                  {i + 1}. {s.title} - {s.location}
                                </button>
                              ))}
                            </div>
                          </details>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  );
                })}
                </div>
              </div>
            </div>

            <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
              {error ? (
                <div className="mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {error}
                </div>
              ) : null}

              {pendingImages.length ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingImages.map((img) => (
                    <div
                      key={img.id}
                      className="group relative overflow-hidden rounded-xl border border-white/10 bg-black/30"
                    >
                      <img src={img.dataUrl} alt="Preview" className="h-20 w-28 object-cover" />
                      <button
                        type="button"
                        className="absolute right-1 top-1 rounded-md border border-white/10 bg-transparent px-2 py-1 text-xs text-white/85 opacity-0 hover:bg-black/40 hover:text-white group-hover:opacity-100"
                        onClick={() =>
                          setPendingImages((prev) => prev.filter((p) => p.id !== img.id))
                        }
                        aria-label="Remove image"
                        title="Remove image"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={[
                    "h-7 rounded-md border px-1 text-xs font-semibold disabled:opacity-40",
                    idMode === "answer"
                      ? "border-white/25 bg-white/10 text-white"
                      : "border-white/10 bg-transparent text-white/80 hover:bg-white/5 hover:text-white",
                  ].join(" ")}
                  onClick={() => {
                    setLookupMode(false);
                    setIdMode((v) => (v === "answer" ? null : "answer"));
                  }}
                  disabled={busy || idLookupBusy}
                >
                  Get answer
                </button>
                <button
                  type="button"
                  className={[
                    "h-7 rounded-md border px-1 text-xs font-semibold disabled:opacity-40",
                    idMode === "explain"
                      ? "border-white/25 bg-white/10 text-white"
                      : "border-white/10 bg-transparent text-white/80 hover:bg-white/5 hover:text-white",
                  ].join(" ")}
                  onClick={() => {
                    setLookupMode(false);
                    setIdMode((v) => (v === "explain" ? null : "explain"));
                  }}
                  disabled={busy || idLookupBusy}
                >
                  Explain
                </button>
                <button
                  type="button"
                  className={[
                    "h-7 rounded-md border px-1 text-xs font-semibold disabled:opacity-40",
                    lookupMode
                      ? "border-white/25 bg-white/10 text-white"
                      : "border-white/10 bg-transparent text-white/80 hover:bg-white/5 hover:text-white",
                  ].join(" ")}
                  onClick={() => {
                    setIdMode(null);
                    setLookupMode((v) => !v);
                  }}
                  disabled={busy || idLookupBusy}
                >
                  Lookup
                </button>
              </div>

              <div className="flex gap-2">
                {idMode ? (
                  <input
                    className="h-10 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white outline-none placeholder:text-white/40 focus:ring-2 focus:ring-white/20"
                    placeholder="Question ID"
                    inputMode="numeric"
                    autoFocus
                    value={idLookupValue}
                    onChange={(e) => setIdLookupValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setIdMode(null);
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void lookupQuestionById(idMode);
                      }
                    }}
                  />
                ) : (
                  <textarea
                    className="min-h-10 flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:ring-2 focus:ring-white/20"
                    placeholder={
                      lookupMode
                        ? "Lookup: paste question text or a screenshot to find the FS-Quiz ID…"
                        : "Write your question... (Shift+Enter for newline)"
                    }
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onPaste={(e) => {
                      const items = Array.from(e.clipboardData.items);
                      const imageItems = items.filter((it) => it.type.startsWith("image/"));
                      if (imageItems.length) {
                        e.preventDefault();
                        void (async () => {
                          for (const it of imageItems.slice(0, 4)) {
                            const file = it.getAsFile();
                            if (file) await addPastedImage(file);
                          }
                        })();
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void onSend();
                      }
                    }}
                  />
                )}
                {idMode ? (
                  <button
                    type="button"
                    className="h-10 rounded-xl bg-white/90 px-4 text-sm font-semibold text-black hover:bg-white disabled:opacity-50"
                    onClick={() => void lookupQuestionById(idMode)}
                    disabled={idLookupBusy || busy || idLookupValue.trim().length === 0}
                    aria-label={idMode === "answer" ? "Get answer" : "Explain"}
                  >
                    {idLookupBusy ? "Fetching…" : idMode === "answer" ? "Get" : "Explain"}
                  </button>
                ) : (
                  <button
                    className="h-10 rounded-xl bg-white/90 px-4 text-sm font-semibold text-black hover:bg-white disabled:opacity-50"
                    onClick={() => void onSend()}
                    disabled={!canSend}
                    type="button"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </section>
        </main>

          {openSource ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
              <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-black/60 p-4 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">{openSource.title}</div>
                    <div className="text-xs text-white/60">{openSource.location}</div>
                  </div>
                  <button
                    type="button"
                    className="rounded-md border border-white/10 bg-transparent px-2 py-1 text-xs text-white/80 hover:bg-white/5 hover:text-white"
                    onClick={() => setOpenSource(null)}
                  >
                    Close
                  </button>
                </div>
                <pre className="mt-3 max-h-[60vh] overflow-auto rounded-xl bg-black/50 p-3 text-xs leading-5 text-white/90 ring-1 ring-white/10">
                  {openSource.excerpt}
                </pre>
                {openSource.externalUrl ? (
                  <div className="mt-3">
                    <a
                      className="text-xs text-white/80 underline decoration-white/30 underline-offset-2 hover:text-white"
                      href={openSource.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open original (new tab)
                    </a>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {adminOpen ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-black/70 p-4 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Admin</div>
                    <div className="mt-1 text-xs text-white/60">
                      Sync local files to OpenAI once, then chats only search.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-md border border-white/10 bg-transparent px-2 py-1 text-xs text-white/80 hover:bg-white/5 hover:text-white"
                    onClick={closeAdmin}
                  >
                    Close
                  </button>
                </div>

                <div className="mt-4 grid gap-2 text-xs text-white/70">
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    <div className="text-white/60">Local eligible files</div>
                    <div className="font-semibold text-white">{syncStatus?.localEligibleCount ?? "—"}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    <div className="text-white/60">Synced files</div>
                    <div className="font-semibold text-white">{syncStatus?.syncedCount ?? "—"}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    <div className="text-white/60">Last sync</div>
                    <div className="font-semibold text-white">{syncStatus?.lastSyncAt ?? "—"}</div>
                  </div>
                </div>

                {syncError ? (
                  <div className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                    {syncError}
                  </div>
                ) : null}

                {syncResult ? (
                  <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75">
                    Synced {syncResult.desiredCount} files (uploaded {syncResult.uploaded}, kept {syncResult.kept}, removed{" "}
                    {syncResult.removed}).
                  </div>
                ) : null}

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    className="h-10 flex-1 rounded-xl border border-white/15 bg-transparent px-4 text-sm font-semibold text-white/90 hover:bg-white/5 disabled:opacity-50"
                    onClick={() => void runSync()}
                    disabled={syncBusy}
                  >
                    {syncBusy ? "Syncing..." : "Sync files"}
                  </button>
                  <button
                    type="button"
                    className="h-10 rounded-xl border border-white/10 bg-transparent px-4 text-sm font-semibold text-white/80 hover:bg-white/5 hover:text-white"
                    onClick={() => void refreshSyncStatus()}
                    disabled={syncBusy}
                  >
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

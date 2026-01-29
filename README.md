# FS QuizTool

Next.js app for answering Formula Student quiz questions with:

- OpenAI Responses API + `file_search` over your uploaded rules/handbooks/scripts
- FS-Quiz question lookup by ID (and “Explain” flow)
- Markdown + LaTeX rendering

## Local dev

1) Install

```bash
npm install
```

2) Create `.env.local` (see `.env.example`)

```bash
OPENAI_API_KEY=...
# optional: reuse an existing store
OPENAI_VECTOR_STORE_ID=...
```

3) (Recommended) Sync your local docs once to OpenAI

Put PDFs + scripts under `data/files/` (this folder is ignored by git), then run:

```bash
npm run openai:sync
```

Copy the printed `vectorStoreId` into `OPENAI_VECTOR_STORE_ID` so you can reuse it locally + on Vercel.

If your vector store got duplicates (same file uploaded multiple times), you can clean it up with:

```bash
npm run openai:dedupe
```

4) Run

```bash
npm run dev
```

## Deploy to Vercel

1) Make sure you have already run `npm run openai:sync` locally at least once and saved the printed `vectorStoreId`.

2) In Vercel:

- Import the GitHub repo
- Framework: Next.js (auto-detected)
- Environment Variables (Project → Settings → Environment Variables):
  - `OPENAI_API_KEY`
  - `OPENAI_VECTOR_STORE_ID`
  - Optional: `OPENAI_ANSWER_MODEL`, `OPENAI_VISION_MODEL`

3) Deploy.

Notes:
- This repo does **not** commit `data/files/` (PDFs). Vercel uses the vector store for year/handbook/rules selection and file search.
- `/api/sync` is disabled in production; do syncing locally via `npm run openai:sync`.

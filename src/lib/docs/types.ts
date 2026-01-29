export type DocKind = "pdf" | "text";

export type DriveMeta = {
  fileId: string;
  webViewLink?: string;
};

export type FileMeta = {
  id: string;
  fileName: string;
  kind: DocKind;
  ext: string;
  year?: string;
  bytes?: number;
  drive?: DriveMeta;
};

export type Chunk = {
  chunkId: string;
  fileId: string;
  fileName: string;
  kind: DocKind;
  year?: string;
  page?: number;
  startLine?: number;
  endLine?: number;
  text: string;
};

export type IndexBundle = {
  generatedAt: string;
  files: FileMeta[];
  chunks: Chunk[];
  miniSearch: unknown;
};

export type RetrievedChunk = Chunk & {
  score: number;
  excerpt: string;
  externalUrl?: string;
};


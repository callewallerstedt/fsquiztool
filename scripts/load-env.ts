import fs from "node:fs";
import path from "node:path";

function parseEnvFile(contents: string) {
  const out: Record<string, string> = {};
  const lines = contents.replace(/\r\n/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? "";

    // Strip inline comments for unquoted values.
    const firstChar = value.trimStart().charAt(0);
    if (firstChar !== '"' && firstChar !== "'") {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    } else {
      value = value.trim();
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const q = value[0]!;
      value = value.slice(1, -1);
      if (q === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    }

    out[key] = value;
  }
  return out;
}

export function loadEnv() {
  const root = process.cwd();
  const candidates = [".env.local", ".env"];
  for (const file of candidates) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseEnvFile(fs.readFileSync(p, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] == null) process.env[k] = v;
      }
    } catch {
      // ignore
    }
  }
}


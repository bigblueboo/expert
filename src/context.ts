import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { lookup as lookupMime } from "mime-types";
import type { ContextBundle, ContextFile, SkippedContextFile } from "./types.js";

const DEFAULT_EXCLUDES = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".cache/**",
  ".next/**",
  ".turbo/**",
  ".venv/**",
  "__pycache__/**",
  "*.log",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx"
];

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".gql",
  ".csv",
  ".tsv",
  ".rtf",
  ".doc",
  ".docx",
  ".odt",
  ".ppt",
  ".pptx",
  ".pdf",
  ".xls",
  ".xlsx"
]);

export interface ResolveContextOptions {
  cwd: string;
  files?: string[];
  dirs?: string[];
  excludes?: string[];
  maxSingleFileBytes?: number;
  maxTotalBytes?: number;
}

export const DEFAULT_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export async function resolveContext(options: ResolveContextOptions): Promise<ContextBundle> {
  const cwd = path.resolve(options.cwd);
  const maxSingle = options.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const ignored = await buildIgnore(cwd, options.excludes ?? []);
  const candidates = await resolveCandidates(options);
  const files: ContextFile[] = [];
  const skipped: SkippedContextFile[] = [];
  let totalBytes = 0;

  for (const absolutePath of candidates) {
    const relativePath = toPosix(path.relative(cwd, absolutePath));
    if (!relativePath || ignored.ignores(relativePath)) continue;

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (error) {
      skipped.push({ path: relativePath, reason: errorMessage(error) });
      continue;
    }

    if (!stats.isFile()) continue;
    if (stats.size > maxSingle) {
      skipped.push({ path: relativePath, reason: `larger than ${maxSingle} bytes` });
      continue;
    }
    if (totalBytes + stats.size > maxTotal) {
      skipped.push({ path: relativePath, reason: `combined context exceeds ${maxTotal} bytes` });
      continue;
    }
    if (looksBinaryByExtension(absolutePath)) {
      skipped.push({ path: relativePath, reason: "unsupported binary file" });
      continue;
    }

    files.push({
      absolutePath,
      relativePath,
      bytes: stats.size,
      mimeType: String(lookupMime(absolutePath) || "application/octet-stream")
    });
    totalBytes += stats.size;
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  return {
    files,
    skipped,
    totalBytes,
    manifest: buildManifest(files, skipped)
  };
}

export async function readStdinIfRequested(enabled: boolean): Promise<string> {
  if (!enabled) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildManifest(files: ContextFile[], skipped: SkippedContextFile[]): string {
  const lines = ["Attached context manifest:"];
  if (files.length === 0) {
    lines.push("- No files attached.");
  } else {
    for (const file of files) {
      lines.push(`- ${file.relativePath} (${file.bytes} bytes, ${file.mimeType})`);
    }
  }
  if (skipped.length > 0) {
    lines.push("", "Skipped files:");
    for (const file of skipped) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
  }
  return lines.join("\n");
}

async function buildIgnore(cwd: string, excludes: string[]) {
  const ig = ignore().add(DEFAULT_EXCLUDES).add(excludes);
  const gitignorePath = path.join(cwd, ".gitignore");
  try {
    await access(gitignorePath, constants.R_OK);
    ig.add(await readFile(gitignorePath, "utf8"));
  } catch {
    // No .gitignore is fine.
  }
  return ig;
}

async function resolveCandidates(options: ResolveContextOptions): Promise<string[]> {
  const cwd = path.resolve(options.cwd);
  const patterns = [
    ...(options.files ?? []),
    ...(options.dirs ?? []).map((dir) => `${trimTrailingSlash(dir)}/**/*`)
  ];
  if (patterns.length === 0) return [];

  // fg's ignore only prunes traversal; semantic filtering (gitignore + --exclude) happens in resolveContext.
  const matches = await fg(patterns, {
    cwd,
    absolute: true,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    unique: true,
    ignore: DEFAULT_EXCLUDES
  });

  return matches.map((match) => path.resolve(match)).sort();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/[\\/]$/, "");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function looksBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return false;
  if (TEXT_EXTENSIONS.has(ext)) return false;
  const mime = String(lookupMime(filePath) || "");
  return Boolean(mime && !mime.startsWith("text/") && mime !== "application/json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stableContextHash(bundle: ContextBundle): string {
  const hash = createHash("sha256");
  for (const file of bundle.files) {
    hash.update(file.relativePath);
    hash.update(String(file.bytes));
  }
  return hash.digest("hex").slice(0, 16);
}

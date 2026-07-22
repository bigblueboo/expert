import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
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

const DEFAULT_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_STDIN_BYTES = 10 * 1024 * 1024;

interface Candidate {
  absolutePath: string;
  explicit: boolean;
}

export async function resolveContext(options: ResolveContextOptions): Promise<ContextBundle> {
  const cwd = path.resolve(options.cwd);
  const maxSingle = options.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_FILE_BYTES;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  // Hard excludes (safety defaults + --exclude) and .gitignore are evaluated
  // independently so a repository-controlled negation like `!secret.txt`
  // cannot re-include a file the caller explicitly excluded.
  const hardIgnore = ignore().add(DEFAULT_EXCLUDES).add(options.excludes ?? []);
  const gitIgnore = await buildGitIgnore(cwd);
  const skipped: SkippedContextFile[] = [];
  const candidates = await resolveCandidates(options, skipped);
  const files: ContextFile[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    const { absolutePath, explicit } = candidate;
    const relativePath = toPosix(path.relative(cwd, absolutePath));
    if (!relativePath) continue;
    if (hardIgnore.ignores(relativePath) || gitIgnore.ignores(relativePath)) {
      if (explicit) {
        skipped.push({ path: relativePath, reason: "excluded by exclude/ignore rules" });
      }
      continue;
    }

    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      skipped.push({ path: relativePath, reason: errorMessage(error) });
      continue;
    }

    if (stats.isSymbolicLink()) {
      skipped.push({ path: relativePath, reason: "symbolic link (not followed)" });
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

export async function readStdinIfRequested(enabled: boolean, maxBytes = DEFAULT_MAX_STDIN_BYTES): Promise<string> {
  if (!enabled) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`Stdin exceeds ${maxBytes} bytes. Attach large content with --file instead.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildManifest(files: ContextFile[], skipped: SkippedContextFile[]): string {
  const lines = ["Attached context manifest:"];
  if (files.length === 0) {
    lines.push("- No files attached.");
  } else {
    for (const file of files) {
      lines.push(`- ${sanitizeManifestText(file.relativePath)} (${file.bytes} bytes, ${file.mimeType})`);
    }
  }
  if (skipped.length > 0) {
    lines.push("", "Skipped files:");
    for (const file of skipped) {
      lines.push(`- ${sanitizeManifestText(file.path)}: ${sanitizeManifestText(file.reason)}`);
    }
  }
  return lines.join("\n");
}

// Filenames can contain newlines and other control characters that would let
// a crafted path forge extra manifest entries in the prompt.
function sanitizeManifestText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, (char) => JSON.stringify(char).slice(1, -1));
}

async function buildGitIgnore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  const gitignorePath = path.join(cwd, ".gitignore");
  try {
    await access(gitignorePath, constants.R_OK);
    ig.add(await readFile(gitignorePath, "utf8"));
  } catch {
    // No .gitignore is fine.
  }
  return ig;
}

async function resolveCandidates(options: ResolveContextOptions, skipped: SkippedContextFile[]): Promise<Candidate[]> {
  const cwd = path.resolve(options.cwd);
  const explicitPaths = (options.files ?? []).filter((pattern) => !fg.isDynamicPattern(pattern));
  const globPatterns = [
    ...(options.files ?? []).filter((pattern) => fg.isDynamicPattern(pattern)),
    ...(options.dirs ?? []).map((dir) => `${trimTrailingSlash(dir)}/**/*`)
  ];

  const byPath = new Map<string, Candidate>();

  for (const explicitPath of explicitPaths) {
    const absolutePath = path.resolve(cwd, explicitPath);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      throw new Error(`File not found: ${explicitPath}`);
    }
    if (stats.isDirectory()) {
      throw new Error(`${explicitPath} is a directory; attach it with --dir instead.`);
    }
    byPath.set(absolutePath, { absolutePath, explicit: true });
  }

  for (const pattern of globPatterns) {
    // fg's ignore only prunes traversal; semantic filtering (gitignore + --exclude) happens in resolveContext.
    const matches = await fg(pattern, {
      cwd,
      absolute: true,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      unique: true,
      ignore: DEFAULT_EXCLUDES
    });
    if (matches.length === 0) {
      skipped.push({ path: pattern, reason: "no files matched" });
      continue;
    }
    for (const match of matches) {
      const absolutePath = path.resolve(match);
      if (!byPath.has(absolutePath)) {
        byPath.set(absolutePath, { absolutePath, explicit: false });
      }
    }
  }

  return [...byPath.values()].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
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

export async function stableContextHash(bundle: ContextBundle): Promise<string> {
  const hash = createHash("sha256");
  for (const file of bundle.files) {
    hash.update(file.relativePath);
    hash.update(" ");
    hash.update(await readFile(file.absolutePath));
  }
  return hash.digest("hex").slice(0, 16);
}

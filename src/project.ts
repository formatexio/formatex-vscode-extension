import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { FileUpload } from "./types";

const MAX_FILES = 50;
const ALLOWED_EXTENSIONS = new Set([
  ".tex",
  ".bib",
  ".sty",
  ".cls",
  ".bst",
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".svg",
  ".eps"
]);

const includePatterns = [
  /\\(?:input|include)\{([^}]+)\}/g,
  /\\(?:bibliography|addbibresource)\{([^}]+)\}/g,
  /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g
];

async function readUtf8(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeForApi(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  return rel.split(path.sep).join("/");
}

function normalizeRef(input: string): string[] {
  const noQuotes = input.trim().replace(/^\{/, "").replace(/\}$/, "");
  const chunks = noQuotes.split(",").map((x) => x.trim()).filter(Boolean);
  return chunks;
}

// Conventional asset folder names to check when a reference has no directory
// component and doesn't resolve next to the referencing file - e.g.
// \includegraphics{logo.png} where the real file is in ./assets/logo.png.
// Bounded to one level under the referencing file's own directory, not a
// recursive search, so it can't accidentally sweep in unrelated files.
const ASSET_SUBDIRS = ["assets", "img", "images", "figures", "graphics"];
const ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg"];

async function resolveInAssetSubdirs(baseDir: string, clean: string): Promise<string | null> {
  if (clean.includes("/") || clean.includes(path.sep)) {
    return null;
  }

  for (const subdir of ASSET_SUBDIRS) {
    const candidate = path.resolve(baseDir, subdir, clean);
    if (await exists(candidate)) {
      return candidate;
    }

    if (!path.extname(clean)) {
      for (const candidateExt of ASSET_EXTENSIONS) {
        const withExt = `${candidate}${candidateExt}`;
        if (await exists(withExt)) {
          return withExt;
        }
      }
    }
  }

  return null;
}

async function resolveCandidate(baseDir: string, ref: string): Promise<string | null> {
  const clean = ref.replace(/^\.\//, "");
  const explicit = path.resolve(baseDir, clean);
  if (await exists(explicit)) {
    return explicit;
  }

  const ext = path.extname(clean);
  if (!ext) {
    for (const candidateExt of [".tex", ".bib", ".png", ".jpg", ".jpeg", ".pdf", ".sty", ".cls"]) {
      const nextCandidate = `${explicit}${candidateExt}`;
      if (await exists(nextCandidate)) {
        return nextCandidate;
      }
    }
  }

  return resolveInAssetSubdirs(baseDir, clean);
}

function parseReferences(content: string): string[] {
  const refs: string[] = [];
  for (const pattern of includePatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      refs.push(...normalizeRef(match[1]));
    }
  }
  return refs;
}

export async function resolveMainTex(
  workspaceRoot: string,
  activeFile: string,
  configuredMain: string
): Promise<string> {
  if (configuredMain) {
    const configured = path.resolve(workspaceRoot, configuredMain);
    if (await exists(configured)) {
      return configured;
    }
  }

  const content = await readUtf8(activeFile);
  const rootMarker = content.match(/^%\s*!TEX\s+root\s*=\s*(.+)$/m);
  if (rootMarker?.[1]) {
    const markerPath = path.resolve(path.dirname(activeFile), rootMarker[1].trim());
    if (await exists(markerPath)) {
      return markerPath;
    }
  }

  return activeFile;
}

async function walkProjectFiles(mainTexFile: string): Promise<string[]> {
  const visited = new Set<string>();
  const queued = [mainTexFile];
  const collected: string[] = [];

  while (queued.length > 0) {
    const current = queued.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const ext = path.extname(current).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      continue;
    }

    collected.push(current);
    if (collected.length >= MAX_FILES) {
      break;
    }

    if (ext === ".tex") {
      const content = await readUtf8(current);
      const refs = parseReferences(content);
      for (const ref of refs) {
        const resolved = await resolveCandidate(path.dirname(current), ref);
        if (resolved && !visited.has(resolved)) {
          queued.push(resolved);
        }
      }
    }
  }

  return collected;
}

export async function collectProjectFiles(
  mainTexFile: string
): Promise<{ latex: string; files: FileUpload[]; payloadBytes: number }> {
  // Paths sent to the API are unpacked relative to the main file's own
  // location (that's where \input/\include references in its content
  // resolve from), not the VS Code workspace folder — those can differ
  // when the opened workspace is an ancestor of the actual project dir.
  const projectRoot = path.dirname(mainTexFile);
  const filePaths = await walkProjectFiles(mainTexFile);
  const apiFiles: FileUpload[] = [];
  let payloadBytes = 0;

  for (const filePath of filePaths) {
    const raw = await fs.readFile(filePath);
    apiFiles.push({ path: normalizeForApi(projectRoot, filePath), data: raw.toString("base64") });
    payloadBytes += raw.byteLength;
  }

  const latex = await readUtf8(mainTexFile);
  return { latex, files: apiFiles.filter((x) => x.path !== normalizeForApi(projectRoot, mainTexFile)), payloadBytes };
}

function commonAncestorDir(filePaths: string[]): string {
  const dirs = filePaths.map((filePath) => path.dirname(filePath).split(path.sep));
  let common = dirs[0] ?? [];

  for (const segments of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < segments.length && common[i] === segments[i]) {
      i++;
    }
    common = common.slice(0, i);
  }

  return common.join(path.sep) || path.sep;
}

/**
 * Detects the smallest project root for a standalone .tex file by walking its
 * \input/\include/\bibliography/\includegraphics references (same graph as
 * collectProjectFiles) and taking the common ancestor directory of everything
 * found, instead of assuming the whole workspace/repo is the project.
 */
export async function detectStandaloneProject(mainTexFile: string): Promise<{ root: string; files: string[] }> {
  const files = await walkProjectFiles(mainTexFile);
  const root = commonAncestorDir(files.length > 0 ? files : [mainTexFile]);
  return { root, files };
}

export function getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}

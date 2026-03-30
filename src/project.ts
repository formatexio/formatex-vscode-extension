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

  return null;
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

export async function collectProjectFiles(
  workspaceRoot: string,
  mainTexFile: string
): Promise<{ latex: string; files: FileUpload[]; payloadBytes: number }> {
  const visited = new Set<string>();
  const queued = [mainTexFile];
  const apiFiles: FileUpload[] = [];
  let payloadBytes = 0;

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

    const raw = await fs.readFile(current);
    const encoded = raw.toString("base64");
    apiFiles.push({ path: normalizeForApi(workspaceRoot, current), data: encoded });
    payloadBytes += raw.byteLength;

    if (apiFiles.length >= MAX_FILES) {
      break;
    }

    if (ext === ".tex") {
      const content = raw.toString("utf8");
      const refs = parseReferences(content);
      for (const ref of refs) {
        const resolved = await resolveCandidate(path.dirname(current), ref);
        if (resolved && !visited.has(resolved)) {
          queued.push(resolved);
        }
      }
    }
  }

  const latex = await readUtf8(mainTexFile);
  return { latex, files: apiFiles.filter((x) => x.path !== normalizeForApi(workspaceRoot, mainTexFile)), payloadBytes };
}

export function getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}

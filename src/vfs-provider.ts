import * as path from "node:path";
import * as vscode from "vscode";
import { FormatexApiClient } from "./api";
import { getApiKey } from "./auth";
import { ProjectFile } from "./types";

type ProjectFileCache = {
  files: ProjectFile[];
  updatedAt: number;
};

function normalizePath(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, "");
}

function basename(filePath: string): string {
  const segments = filePath.split("/");
  return segments[segments.length - 1] ?? filePath;
}

function isTextExtension(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return new Set([".tex", ".bib", ".sty", ".cls", ".bst", ".txt", ".md", ".json", ".yml", ".yaml", ".svg", ".xml", ".html", ".htm", ".css", ".js", ".ts", ".mjs", ".cjs"]).has(extension);
}

function inferMimeType(filePath: string, existing?: string): string {
  if (existing) {
    return existing;
  }

  if (isTextExtension(filePath)) {
    if (filePath.toLowerCase().endsWith(".svg")) {
      return "image/svg+xml";
    }

    return "text/plain";
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".pdf") {
    return "application/pdf";
  }
  if (extension === ".eps") {
    return "application/postscript";
  }

  return "application/octet-stream";
}

function toFileType(entry: ProjectFile | undefined, filePath: string, hasChildren: boolean): vscode.FileType {
  if (hasChildren) {
    return vscode.FileType.Directory;
  }

  if (entry) {
    return vscode.FileType.File;
  }

  return filePath.length === 0 ? vscode.FileType.Directory : vscode.FileType.Unknown;
}

function isDirectoryPath(filePath: string): boolean {
  return filePath.length === 0 || filePath.endsWith("/");
}

export class FormatexFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  private readonly projectCache = new Map<string, ProjectFileCache>();
  private readonly contentCache = new Map<string, Map<string, Uint8Array>>();
  private readonly mutationTimers = new Map<string, NodeJS.Timeout>();
  private readonly observedProjectIds = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: FormatexApiClient,
    private readonly onProjectChanged: (projectId: string) => void
  ) {}

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const projectId = uri.authority;
    this.trackProject(projectId);
    const filePath = normalizePath(uri);
    const files = await this.getFiles(projectId);
    const entry = files.find((item) => item.path === filePath);
    const hasChildren = files.some((item) => item.path.startsWith(filePath.length === 0 ? "" : `${filePath}/`));

    if (!entry && !hasChildren && filePath.length > 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const size = entry?.size ?? 0;
    const timestamp = entry ? new Date(entry.updatedAt).getTime() : Date.now();
    const type = toFileType(entry, filePath, hasChildren || isDirectoryPath(filePath));

    return {
      type,
      ctime: timestamp,
      mtime: timestamp,
      size
    };
  }

  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const projectId = uri.authority;
    this.trackProject(projectId);
    const filePath = normalizePath(uri);
    const prefix = filePath.length === 0 ? "" : `${filePath}/`;
    const files = await this.getFiles(projectId);
    const entries = new Map<string, vscode.FileType>();

    for (const item of files) {
      if (!item.path.startsWith(prefix)) {
        continue;
      }

      const relativePath = item.path.slice(prefix.length);
      if (!relativePath) {
        continue;
      }

      const separatorIndex = relativePath.indexOf("/");
      if (separatorIndex === -1) {
        entries.set(basename(item.path), vscode.FileType.File);
      } else {
        entries.set(relativePath.slice(0, separatorIndex), vscode.FileType.Directory);
      }
    }

    return Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const projectId = uri.authority;
    this.trackProject(projectId);
    const filePath = normalizePath(uri);
    const cached = this.contentCache.get(projectId)?.get(filePath);
    if (cached) {
      return cached;
    }

    const apiKey = await this.getApiKeyOrThrow();
    const bytes = await this.client.readFile(projectId, filePath, apiKey);
    this.cacheContent(projectId, filePath, bytes);
    return bytes;
  }

  public async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const projectId = uri.authority;
    this.trackProject(projectId);
    const filePath = normalizePath(uri);
    const files = await this.getFiles(projectId);
    const existing = files.find((item) => item.path === filePath);

    if (options.create && existing && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    if (!options.create && !existing) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const apiKey = await this.getApiKeyOrThrow();
    const mimeType = inferMimeType(filePath, existing?.mimeType);
    await this.client.writeFile(projectId, filePath, content, mimeType, apiKey);

    this.cacheContent(projectId, filePath, content);
    this.updateMetadata(projectId, {
      path: filePath,
      size: content.byteLength,
      updatedAt: new Date().toISOString(),
      mimeType
    });

    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    this.scheduleProjectRefresh(projectId);
  }

  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const projectId = uri.authority;
    this.trackProject(projectId);
    const filePath = normalizePath(uri);
    const files = await this.getFiles(projectId);
    const entry = files.find((item) => item.path === filePath);
    const hasChildren = files.some((item) => item.path.startsWith(`${filePath}/`));

    if (!entry && !hasChildren) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    if (hasChildren && !options.recursive) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    if (entry) {
      const apiKey = await this.getApiKeyOrThrow();
      await this.client.deleteFile(projectId, filePath, apiKey);
      this.removeMetadata(projectId, filePath);
      this.removeContent(projectId, filePath);
      this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    this.scheduleProjectRefresh(projectId);
  }

  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (oldUri.authority !== newUri.authority) {
      throw vscode.FileSystemError.NoPermissions(newUri);
    }

    const projectId = oldUri.authority;
    this.trackProject(projectId);
    const oldPath = normalizePath(oldUri);
    const newPath = normalizePath(newUri);
    const files = await this.getFiles(projectId);
    const existing = files.find((item) => item.path === oldPath);
    const target = files.find((item) => item.path === newPath);

    if (!existing) {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }

    if (target && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri);
    }

    const apiKey = await this.getApiKeyOrThrow();
    await this.client.renameFile(projectId, oldPath, newPath, apiKey);

    const content = this.contentCache.get(projectId)?.get(oldPath);
    this.removeMetadata(projectId, oldPath);
    this.removeContent(projectId, oldPath);
    this.updateMetadata(projectId, {
      path: newPath,
      size: existing.size,
      updatedAt: new Date().toISOString(),
      mimeType: existing.mimeType
    });

    if (content) {
      this.cacheContent(projectId, newPath, content);
    }

    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
    this.scheduleProjectRefresh(projectId);
  }

  public async createDirectory(_uri: vscode.Uri): Promise<void> {
    return;
  }

  public watch(_uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  public copy?(): void {
    return;
  }

  public trackProject(projectId: string): void {
    if (!projectId) {
      return;
    }

    this.observedProjectIds.add(projectId);
  }

  public async syncFromRemote(projectIdsHint?: Iterable<string>): Promise<void> {
    const projectIdSet = new Set<string>([
      ...this.projectCache.keys(),
      ...this.observedProjectIds,
      ...(projectIdsHint ? Array.from(projectIdsHint) : [])
    ]);
    const projectIds = Array.from(projectIdSet);

    if (projectIds.length === 0) {
      return;
    }

    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      return;
    }

    for (const projectId of projectIds) {
      try {
        const response = await this.client.listFiles(projectId, apiKey);
        const nextFiles = response.data.files;
        const currentFiles = this.projectCache.get(projectId)?.files ?? [];
        const nextByPath = new Map(nextFiles.map((file) => [file.path, file]));
        const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));

        const changes: vscode.FileChangeEvent[] = [];

        for (const [filePath, nextFile] of nextByPath.entries()) {
          const currentFile = currentByPath.get(filePath);
          const uri = vscode.Uri.from({ scheme: "formatex", authority: projectId, path: `/${filePath}` });

          if (!currentFile) {
            changes.push({ type: vscode.FileChangeType.Created, uri });
            continue;
          }

          if (currentFile.updatedAt !== nextFile.updatedAt || currentFile.size !== nextFile.size) {
            changes.push({ type: vscode.FileChangeType.Changed, uri });
            this.removeContent(projectId, filePath);
          }
        }

        for (const [filePath] of currentByPath.entries()) {
          if (!nextByPath.has(filePath)) {
            const uri = vscode.Uri.from({ scheme: "formatex", authority: projectId, path: `/${filePath}` });
            changes.push({ type: vscode.FileChangeType.Deleted, uri });
            this.removeContent(projectId, filePath);
          }
        }

        this.projectCache.set(projectId, { files: nextFiles, updatedAt: Date.now() });

        if (changes.length > 0) {
          this.onDidChangeFileEmitter.fire(changes);
          this.onProjectChanged(projectId);
        }
      } catch {
        // Best-effort background sync; ignore transient polling failures.
      }
    }
  }

  private async getApiKeyOrThrow(): Promise<string> {
    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      throw vscode.FileSystemError.NoPermissions("FormaTeX API key is missing.");
    }

    return apiKey;
  }

  private async getFiles(projectId: string): Promise<ProjectFile[]> {
    this.trackProject(projectId);

    const cached = this.projectCache.get(projectId);
    if (cached) {
      return cached.files;
    }

    const apiKey = await this.getApiKeyOrThrow();
    const response = await this.client.listFiles(projectId, apiKey);
    this.projectCache.set(projectId, { files: response.data.files, updatedAt: Date.now() });
    return response.data.files;
  }

  private cacheContent(projectId: string, filePath: string, content: Uint8Array): void {
    const projectContent = this.contentCache.get(projectId) ?? new Map<string, Uint8Array>();
    projectContent.set(filePath, content);
    this.contentCache.set(projectId, projectContent);
  }

  private removeContent(projectId: string, filePath: string): void {
    this.contentCache.get(projectId)?.delete(filePath);
  }

  private updateMetadata(projectId: string, file: ProjectFile): void {
    const cache = this.projectCache.get(projectId);
    if (!cache) {
      this.projectCache.set(projectId, { files: [file], updatedAt: Date.now() });
      return;
    }

    const index = cache.files.findIndex((entry) => entry.path === file.path);
    if (index === -1) {
      cache.files.push(file);
      return;
    }

    cache.files[index] = file;
  }

  private removeMetadata(projectId: string, filePath: string): void {
    const cache = this.projectCache.get(projectId);
    if (!cache) {
      return;
    }

    cache.files = cache.files.filter((entry) => entry.path !== filePath && !entry.path.startsWith(`${filePath}/`));
    if (cache.files.length === 0) {
      this.projectCache.delete(projectId);
    }
  }

  private scheduleProjectRefresh(projectId: string): void {
    const existing = this.mutationTimers.get(projectId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.projectCache.delete(projectId);
      this.onProjectChanged(projectId);
      this.mutationTimers.delete(projectId);
    }, 2000);

    this.mutationTimers.set(projectId, timer);
  }
}

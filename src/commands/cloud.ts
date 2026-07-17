import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FormatexApiClient, FormatexApiError } from "../api";
import { getApiKey, setApiKey } from "../auth";
import { publishDiagnostics } from "../diagnostics";
import { FormatexSettings, getSettings } from "../settings";
import { FormatexStatusBar } from "../status-bar";
import { Project, CompileRequest, CompileResponse, FileUpload, DiagnosticPayload } from "../types";
import { FormatexProjectsTree, FileNode, FolderNode, ProjectNode, TreeNode } from "../projects-tree";
import { openPdfBeside } from "../pdf-preview";
import { detectStandaloneProject } from "../project";
import { inferMimeType } from "../vfs-provider";

export type ProjectLike = ProjectNode | FileNode | FolderNode | Project | string | undefined;

function isProjectNode(node: TreeNode | undefined): node is ProjectNode {
  return !!node && node.kind === "project";
}

function isFileNode(node: TreeNode | undefined): node is FileNode {
  return !!node && node.kind === "file";
}

function isFolderNode(node: TreeNode | undefined): node is FolderNode {
  return !!node && node.kind === "folder";
}

function isProject(value: unknown): value is Project {
  return !!value && typeof value === "object" && "id" in value && "name" in value;
}

function normalizeEngine(engine: FormatexSettings["defaultEngine"]): "pdflatex" | "xelatex" | "lualatex" | "latexmk" | undefined {
  return engine === "auto" ? undefined : engine;
}

async function ensureApiKey(context: vscode.ExtensionContext): Promise<string | null> {
  const apiKey = await getApiKey(context);
  if (apiKey) {
    return apiKey;
  }

  const choice = await vscode.window.showWarningMessage("FormaTeX API key is missing.", "Set API Key");
  if (choice === "Set API Key") {
    await setApiKey(context);
    return getApiKey(context);
  }

  return null;
}

async function resolveProject(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  projectLike: ProjectLike
): Promise<Project | null> {
  if (!projectLike) {
    return null;
  }

  if (typeof projectLike === "string") {
    const apiKey = await ensureApiKey(context);
    if (!apiKey) {
      return null;
    }

    return (await client.getProject(projectLike, apiKey)).data;
  }

  if (isProject(projectLike)) {
    return projectLike;
  }

  if (isProjectNode(projectLike as TreeNode)) {
    return (projectLike as ProjectNode).project;
  }

  if (isFileNode(projectLike as TreeNode) || isFolderNode(projectLike as TreeNode)) {
    const apiKey = await ensureApiKey(context);
    if (!apiKey) {
      return null;
    }

    const projectId = (projectLike as FileNode | FolderNode).projectId;
    return (await client.getProject(projectId, apiKey)).data;
  }

  return null;
}

function toCloudUri(projectId: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: "formatex", authority: projectId, path: `/${filePath}` });
}

function toRelativePosix(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || "project";
}

function isLikelyTextFile(filePath: string, mimeType?: string): boolean {
  const loweredMime = (mimeType ?? "").toLowerCase();
  if (loweredMime.startsWith("text/")) {
    return true;
  }

  if (loweredMime.includes("json") || loweredMime.includes("xml") || loweredMime.includes("yaml") || loweredMime.includes("javascript") || loweredMime.includes("latex")) {
    return true;
  }

  const extension = path.extname(filePath).toLowerCase();
  return new Set([".tex", ".bib", ".sty", ".cls", ".bst", ".txt", ".md", ".json", ".yml", ".yaml", ".svg", ".xml", ".html", ".htm", ".css", ".js", ".ts", ".mjs", ".cjs"]).has(extension);
}

async function openBinaryCloudFile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  projectId: string,
  filePath: string
): Promise<void> {
  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    return;
  }

  const bytes = await client.readFile(projectId, filePath, apiKey);
  const targetPath = path.join(context.globalStorageUri.fsPath, "cloud-preview", projectId, filePath.split("/").join(path.sep));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, bytes);
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(targetPath));
}

async function getProjectFiles(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  project: Project
): Promise<{ latex: string; files: FileUpload[]; payloadBytes: number; mainUri: vscode.Uri }> {
  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    throw new Error("FormaTeX API key is missing.");
  }

  const fileResponse = await client.listFiles(project.id, apiKey);
  const mainUri = toCloudUri(project.id, project.mainFile);
  const uploads: FileUpload[] = [];
  let latex = "";
  let payloadBytes = 0;

  for (const file of fileResponse.data.files) {
    const bytes = await client.readFile(project.id, file.path, apiKey);
    payloadBytes += bytes.byteLength;

    if (file.path === project.mainFile) {
      latex = Buffer.from(bytes).toString("utf8");
      continue;
    }

    uploads.push({ path: file.path, data: Buffer.from(bytes).toString("base64") });
  }

  if (!latex) {
    const mainBytes = await client.readFile(project.id, project.mainFile, apiKey);
    latex = Buffer.from(mainBytes).toString("utf8");
    payloadBytes += mainBytes.byteLength;
  }

  return { latex, files: uploads, payloadBytes, mainUri };
}

async function persistPdf(context: vscode.ExtensionContext, project: Project, pdfBytes: Uint8Array): Promise<string> {
  const settings = getSettings();
  const storageRoot = path.join(context.globalStorageUri.fsPath, settings.outputDir);
  await fs.mkdir(storageRoot, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = path.join(storageRoot, `${toSafeFileName(project.name)}-${timestamp}.pdf`);
  await fs.writeFile(targetPath, pdfBytes);
  return targetPath;
}

function getDiagnosticsPayload(response: CompileResponse): DiagnosticPayload[] {
  if ("diagnostics" in response && Array.isArray(response.diagnostics)) {
    return response.diagnostics;
  }

  return [];
}

function isCompileSuccess(response: CompileResponse): response is CompileResponse & { success: true; pdf: string } {
  return response.success === true;
}

async function runAsyncCompile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  apiKey: string,
  request: CompileRequest,
  targetUri: vscode.Uri,
  statusBar: FormatexStatusBar,
  outputChannel: vscode.OutputChannel,
  saveName: string
): Promise<void> {
  const submit = await client.compileAsync(request, apiKey);
  outputChannel.appendLine(`[cloud-async] job submitted id=${submit.data.jobId}`);

  const job = await client.waitForAsyncResult(submit.data.jobId, apiKey);
  if (job.status !== "completed") {
    const err = job.result?.error ?? "Async compilation failed.";
    throw new FormatexApiError(err, 422, job, submit.headers);
  }

  const pdf = await client.getAsyncPdf(submit.data.jobId, apiKey);
  const targetPath = await persistPdf(context, { id: targetUri.authority, name: saveName, mainFile: targetUri.path, fileCount: 0, updatedAt: "", createdAt: "" }, Buffer.from(pdf.bytes));
  outputChannel.appendLine(`[cloud-async] compile success saved=${targetPath}`);
  statusBar.showReady();

  const settings = getSettings();
  if (settings.autoOpenPdf) {
    await openPdfBeside(targetPath);
  }

  const notificationActions = [...(settings.autoOpenPdf ? [] : ["Open PDF"]), "Show Logs"];
  const action = await vscode.window.showInformationMessage("FormaTeX cloud compile succeeded.", ...notificationActions);
  if (action === "Open PDF") {
    await openPdfBeside(targetPath);
  }

  if (action === "Show Logs") {
    outputChannel.show(true);
  }
}

async function runCloudCompile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  project: Project,
  statusBar: FormatexStatusBar,
  outputChannel: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
  saveName: string
): Promise<void> {
  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const { latex, files, payloadBytes, mainUri } = await getProjectFiles(context, client, project);
  const request: CompileRequest = {
    latex,
    files,
    engine: normalizeEngine(settings.defaultEngine)
  };

  statusBar.showBusy(settings.defaultEngine);
  outputChannel.appendLine(`[cloud] project=${project.name} files=${files.length} payloadBytes=${payloadBytes}`);

  try {
    const fallbackToAsync = settings.enableAsyncFallback && payloadBytes > settings.asyncFallbackBytes;
    if (fallbackToAsync) {
      await runAsyncCompile(context, client, apiKey, request, mainUri, statusBar, outputChannel, saveName);
    } else {
      // compile/smart ignores an explicit `engine`; forced engines must use the plain compile endpoint.
      const response = request.engine
        ? await client.compileSync(request, apiKey)
        : await client.compileSmart(request, apiKey);
      const diagnosticsPayload = getDiagnosticsPayload(response.data);
      publishDiagnostics(diagnostics, mainUri, diagnosticsPayload);

      if (!isCompileSuccess(response.data)) {
        throw new FormatexApiError("Compilation failed", 422, response.data, response.headers);
      }

      if (!response.data.pdf) {
        throw new FormatexApiError("Compile succeeded but PDF is missing in response.", 500, response.data, response.headers);
      }

      const pdfBytes = Buffer.from(response.data.pdf, "base64");
      const targetPath = await persistPdf(context, project, pdfBytes);
      outputChannel.appendLine(`[cloud] compile success saved=${targetPath}`);
      statusBar.showProject(project);

      if (settings.autoOpenPdf) {
        await openPdfBeside(targetPath);
      }

      const notificationActions = [...(settings.autoOpenPdf ? [] : ["Open PDF"]), "Show Logs"];
      const action = await vscode.window.showInformationMessage("FormaTeX cloud compile succeeded.", ...notificationActions);
      if (action === "Open PDF") {
        await openPdfBeside(targetPath);
      }

      if (action === "Show Logs") {
        outputChannel.show(true);
      }
    }
  } finally {
    if (settings.showProjectsPanel) {
      statusBar.showProject(project);
    } else {
      statusBar.showReady();
    }
  }
}

export async function openProject(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  statusBar: FormatexStatusBar,
  projectLike: ProjectLike,
  filePath?: string,
  mode?: "vfs" | "local"
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  const settings = getSettings();
  if ((mode ?? settings.openMode) === "local") {
    await openProjectLocally(context, client, statusBar, project);
    return;
  }

  const targetFile = filePath ?? project.mainFile;
  const targetUri = toCloudUri(project.id, targetFile);
  const document = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(document, { preview: false });
  statusBar.showProject(project);
}

export async function openProjectLocally(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  statusBar: FormatexStatusBar,
  projectLike: ProjectLike
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const baseDirectory = settings.localWorkspaceDir ? path.resolve(settings.localWorkspaceDir) : os.tmpdir();
  await fs.mkdir(baseDirectory, { recursive: true });

  const projectDirectory = await fs.mkdtemp(path.join(baseDirectory, `formatex-${toSafeFileName(project.name)}-`));
  const files = await client.listFiles(project.id, apiKey);

  for (const file of files.data.files) {
    const bytes = await client.readFile(project.id, file.path, apiKey);
    const targetPath = path.join(projectDirectory, file.path.split("/").join(path.sep));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, bytes);
  }

  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(projectDirectory), true);
  statusBar.showProject(project);
}

export async function openProjectInBrowser(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  projectLike: ProjectLike
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(`https://formatex.io/projects/${encodeURIComponent(project.id)}`));
}

export async function compileCloudProject(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  statusBar: FormatexStatusBar,
  outputChannel: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
  projectLike: ProjectLike
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  await runCloudCompile(context, client, project, statusBar, outputChannel, diagnostics, project.name);
}

export async function showProjectActions(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  statusBar: FormatexStatusBar,
  outputChannel: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
  tree: FormatexProjectsTree,
  projectLike: ProjectLike
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: "Open in VS Code", value: "open" },
      { label: "Open Locally (Download)", value: "local" },
      { label: "Compile", value: "compile" },
      { label: "Open in Browser", value: "browser" },
      { label: "Refresh", value: "refresh" },
      { label: "Copy Project ID", value: "copy" }
    ],
    { title: project.name }
  );

  if (!choice) {
    return;
  }

  if (choice.value === "open") {
    await openProject(context, client, statusBar, project);
    return;
  }

  if (choice.value === "local") {
    await openProjectLocally(context, client, statusBar, project);
    return;
  }

  if (choice.value === "compile") {
    await compileCloudProject(context, client, statusBar, outputChannel, diagnostics, project);
    return;
  }

  if (choice.value === "browser") {
    await openProjectInBrowser(context, client, project);
    return;
  }

  if (choice.value === "refresh") {
    tree.refresh(project.id);
    return;
  }

  if (choice.value === "copy") {
    await vscode.env.clipboard.writeText(project.id);
    vscode.window.showInformationMessage("FormaTeX project ID copied.");
  }
}

export async function openFile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  projectLike: ProjectLike
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  const fileNode = isFileNode(projectLike as TreeNode) ? (projectLike as FileNode) : null;
  const filePath = fileNode ? fileNode.file.path : project.mainFile;
  const mimeType = fileNode?.file.mimeType;

  if (!isLikelyTextFile(filePath, mimeType)) {
    await openBinaryCloudFile(context, client, project.id, filePath);
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(toCloudUri(project.id, filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    await openBinaryCloudFile(context, client, project.id, filePath);
  }
}

export async function renameFile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  tree: FormatexProjectsTree,
  projectLike: ProjectLike,
  filePath?: string,
  newPath?: string
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project) {
    return;
  }

  const sourcePath = filePath ?? (isFileNode(projectLike as TreeNode) ? (projectLike as FileNode).file.path : undefined);
  if (!sourcePath) {
    return;
  }

  const targetPath = newPath ?? (await vscode.window.showInputBox({
    title: "Rename FormaTeX File",
    prompt: "New relative file path",
    value: sourcePath,
    ignoreFocusOut: true
  }));

  if (!targetPath || targetPath === sourcePath) {
    return;
  }

  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    return;
  }

  await client.renameFile(project.id, sourcePath, targetPath, apiKey);
  tree.refresh(project.id);
  vscode.window.showInformationMessage("FormaTeX file renamed.");
}

export async function deleteFile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  tree: FormatexProjectsTree,
  projectLike: ProjectLike
): Promise<void> {
  const project = await resolveProject(context, client, projectLike);
  if (!project || !isFileNode(projectLike as TreeNode)) {
    return;
  }

  const filePath = (projectLike as FileNode).file.path;
  const choice = await vscode.window.showWarningMessage(`Delete FormaTeX file ${filePath}?`, { modal: true }, "Delete");
  if (choice !== "Delete") {
    return;
  }

  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    return;
  }

  await client.deleteFile(project.id, filePath, apiKey);
  tree.refresh(project.id);
  vscode.window.showInformationMessage("FormaTeX file deleted.");
}

export async function refreshProjectFiles(
  tree: FormatexProjectsTree,
  projectLike: ProjectLike
): Promise<void> {
  if (isProject(projectLike)) {
    tree.refresh(projectLike.id);
    return;
  }

  if (isProjectNode(projectLike as TreeNode)) {
    tree.refresh((projectLike as ProjectNode).project.id);
  }
}

/**
 * Turns a local .tex file into a new FormaTeX cloud project without requiring
 * the user to zip/upload it manually. The upload set is limited to the main
 * file's \input/\include/\bibliography/\includegraphics dependency graph, and
 * the project root is the common ancestor directory of those files - so
 * picking a .tex nested inside a larger repo (e.g. "repo/rapport/main.tex")
 * only uploads the "rapport" subtree, not the whole repo.
 */
export async function createProjectFromFolder(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  statusBar: FormatexStatusBar,
  tree: FormatexProjectsTree,
  uri?: vscode.Uri
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri || targetUri.scheme !== "file" || path.extname(targetUri.fsPath).toLowerCase() !== ".tex") {
    vscode.window.showErrorMessage("Select or open a local .tex file to create a FormaTeX project from it.");
    return;
  }

  const apiKey = await ensureApiKey(context);
  if (!apiKey) {
    return;
  }

  const { root, files: detected } = await detectStandaloneProject(targetUri.fsPath);
  const files = detected.includes(targetUri.fsPath) ? detected : [targetUri.fsPath, ...detected];

  const defaultName = path.basename(root) || path.basename(targetUri.fsPath, ".tex");
  const name = await vscode.window.showInputBox({
    title: "FormaTeX: New Cloud Project",
    prompt: `Create a project from ${files.length} file(s) detected under "${root}"`,
    value: defaultName,
    ignoreFocusOut: true
  });

  if (!name) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Create FormaTeX project "${name}" from ${files.length} file(s) under "${root}"? Only files reachable from ${path.basename(targetUri.fsPath)} are uploaded, not the whole workspace.`,
    { modal: true },
    "Create Project"
  );

  if (confirm !== "Create Project") {
    return;
  }

  const mainFileRelative = toRelativePosix(root, targetUri.fsPath);

  const project = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating FormaTeX project "${name}"` },
    async (progress): Promise<Project> => {
      const created = (await client.createProject(name, mainFileRelative, apiKey)).data;

      for (let i = 0; i < files.length; i++) {
        const relative = toRelativePosix(root, files[i]);
        const bytes = await fs.readFile(files[i]);
        await client.writeFile(created.id, relative, bytes, inferMimeType(relative), apiKey);
        progress.report({ message: `${i + 1}/${files.length} files`, increment: 100 / files.length });
      }

      return created;
    }
  );

  tree.refresh();
  const action = await vscode.window.showInformationMessage(
    `FormaTeX project "${name}" created with ${files.length} file(s).`,
    "Open Project",
    "Open in Browser"
  );

  if (action === "Open Project") {
    await openProject(context, client, statusBar, project);
  }
  if (action === "Open in Browser") {
    await openProjectInBrowser(context, client, project);
  }
}

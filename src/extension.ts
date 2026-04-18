import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { FormatexApiClient, FormatexApiError } from "./api";
import { clearCachedUser, getCachedUser } from "./auth";
import { publishDiagnostics } from "./diagnostics";
import {
  compileCloudProject,
  deleteFile,
  openFile,
  openProject,
  openProjectInBrowser,
  openProjectLocally,
  refreshProjectFiles,
  renameFile,
  showProjectActions,
  type ProjectLike
} from "./commands/cloud";
import { collectProjectFiles, getWorkspaceFolderForUri, resolveMainTex } from "./project";
import { FormatexProjectsTree } from "./projects-tree";
import { getSettings } from "./settings";
import { FormatexStatusBar } from "./status-bar";
import { FormatexFileSystemProvider } from "./vfs-provider";
import { FormatexUriHandler } from "./uri-handler";
import { CompileRequest, CompileResponse, DiagnosticPayload, Engine, FormatexHeaders } from "./types";

const LAST_PDF_PATH_KEY = "formatex.lastPdfPath";
const LAST_REMOTE_URL_KEY = "formatex.lastRemoteUrl";

let outputChannel: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let statusBar: FormatexStatusBar;
let apiClient: FormatexApiClient;
let projectsTree: FormatexProjectsTree;
let vfsProvider: FormatexFileSystemProvider;
const CLOUD_AUTOSAVE_DELAY_MS = 1200;
const CLOUD_SAVED_STATE_MS = 1400;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("FormaTeX");
  diagnostics = vscode.languages.createDiagnosticCollection("formatex");
  statusBar = new FormatexStatusBar(context);
  apiClient = new FormatexApiClient(getSettings());
  projectsTree = new FormatexProjectsTree(context, apiClient);
  vfsProvider = new FormatexFileSystemProvider(context, apiClient, (projectId) => projectsTree.refresh(projectId));

  context.subscriptions.push(outputChannel, diagnostics);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider("formatex", vfsProvider, { isCaseSensitive: true }));
  context.subscriptions.push(vscode.window.registerTreeDataProvider("formatex-projects-view", projectsTree));
  context.subscriptions.push(vscode.window.registerUriHandler(new FormatexUriHandler(async (projectId, filePath, mode) => {
    await openProject(context, apiClient, statusBar, projectId, filePath, mode);
  })));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document.uri.scheme === "formatex") {
      vfsProvider.trackProject(editor.document.uri.authority);
    }
    void refreshStatusBar(context, editor?.document.uri);
  }));

  const pendingCloudAutosaves = new Map<string, NodeJS.Timeout>();
  let cloudSavedStateTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.scheme !== "formatex") {
      return;
    }

    if (event.contentChanges.length === 0) {
      return;
    }

    const settings = getSettings();
    if (!settings.autoSyncOnSave) {
      return;
    }

    vfsProvider.trackProject(event.document.uri.authority);

    const documentKey = event.document.uri.toString();
    const existing = pendingCloudAutosaves.get(documentKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      pendingCloudAutosaves.delete(documentKey);

      const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === documentKey);
      if (!document || document.isClosed || !document.isDirty) {
        return;
      }

      statusBar.showSaving();

      void (async () => {
        try {
          const encoded = new TextEncoder().encode(document.getText());
          await vscode.workspace.fs.writeFile(document.uri, encoded);

          const saved = document.isDirty ? await document.save() : true;
          if (!saved) {
            outputChannel.appendLine(`[cloud] autosave skipped ${document.uri.toString()}`);
            void refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
            return;
          }

          statusBar.showSaved();
          if (cloudSavedStateTimer) {
            clearTimeout(cloudSavedStateTimer);
          }
          cloudSavedStateTimer = setTimeout(() => {
            cloudSavedStateTimer = undefined;
            void refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
          }, CLOUD_SAVED_STATE_MS);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown autosave error";
          outputChannel.appendLine(`[cloud] autosave failed ${document.uri.toString()} ${message}`);
          statusBar.showError();
          void refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
        }
      })();
    }, CLOUD_AUTOSAVE_DELAY_MS);

    pendingCloudAutosaves.set(documentKey, timer);
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    const documentKey = document.uri.toString();
    const existing = pendingCloudAutosaves.get(documentKey);
    if (!existing) {
      return;
    }

    clearTimeout(existing);
    pendingCloudAutosaves.delete(documentKey);
  }));

  context.subscriptions.push(new vscode.Disposable(() => {
    for (const timer of pendingCloudAutosaves.values()) {
      clearTimeout(timer);
    }
    pendingCloudAutosaves.clear();

    if (cloudSavedStateTimer) {
      clearTimeout(cloudSavedStateTimer);
      cloudSavedStateTimer = undefined;
    }
  }));

  const autoSyncTimer = setInterval(() => {
    const openProjectIds = new Set(
      vscode.workspace.textDocuments
        .filter((document) => document.uri.scheme === "formatex")
        .map((document) => document.uri.authority)
    );

    void vfsProvider.syncFromRemote(openProjectIds);
  }, 10000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(autoSyncTimer)));

  register(context, "formatex.setApiKey", async () => {
    await setApiKey(context);
    clearCachedUser();
    projectsTree.refresh();
    await refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
  });
  register(context, "formatex.clearApiKey", async () => {
    await clearApiKey(context);
    clearCachedUser();
    projectsTree.refresh();
    await refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
  });
  register(context, "formatex.showOutput", async () => outputChannel.show(true));
  register(context, "formatex.openLastPdf", async () => openLastPdf(context));
  register(context, "formatex.showUsage", async () => showUsage(context));
    register(context, "formatex.showProjectActions", async (...args) => showProjectActions(context, apiClient, statusBar, outputChannel, diagnostics, projectsTree, args[0] as ProjectLike));
    register(context, "formatex.openProject", async (...args) => openProject(context, apiClient, statusBar, args[0] as ProjectLike));
    register(context, "formatex.openProjectLocally", async (...args) => openProjectLocally(context, apiClient, statusBar, args[0] as ProjectLike));
    register(context, "formatex.compileCloudProject", async (...args) => compileCloudProject(context, apiClient, statusBar, outputChannel, diagnostics, args[0] as ProjectLike));
    register(context, "formatex.openProjectInBrowser", async (...args) => openProjectInBrowser(context, apiClient, args[0] as ProjectLike));
    register(context, "formatex.refreshProjectFiles", async (...args) => refreshProjectFiles(projectsTree, args[0] as ProjectLike));
    register(context, "formatex.copyProjectId", async (...args) => copyProjectId(args[0] as ProjectLike));
    register(context, "formatex.openFile", async (...args) => openFile(context, apiClient, args[0] as ProjectLike));
    register(context, "formatex.renameFile", async (...args) => renameFile(context, apiClient, projectsTree, args[0] as ProjectLike));
    register(context, "formatex.deleteFile", async (...args) => deleteFile(context, apiClient, projectsTree, args[0] as ProjectLike));
  register(context, "formatex.compileCurrent", async (...args) => compileCurrent(context, args[0] as vscode.Uri | undefined));
  register(context, "formatex.compileResource", async (...args) => compileResource(context, args[0] as vscode.Uri | undefined));
  register(context, "formatex.compileProject", async (...args) => compileProject(context, args[0] as vscode.Uri | undefined));
  register(context, "formatex.checkSyntax", async (...args) => checkSyntax(context, args[0] as vscode.Uri | undefined));

  void refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
}

export function deactivate(): void {
  diagnostics?.dispose();
  statusBar?.dispose();
  outputChannel?.dispose();
}

function register(
  context: vscode.ExtensionContext,
  command: string,
  handler: (...args: unknown[]) => Promise<void>
): void {
  context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      if (error instanceof FormatexApiError) {
        if (error.status === 404) {
          vscode.window.showWarningMessage("Cloud project APIs are not available on this server yet.");
          outputChannel.appendLine("[cloud] API endpoint not found (404). Check server version and /api/v1/projects support.");
          return;
        }

        vscode.window.showErrorMessage(`FormaTeX request failed: ${error.message}`);
        outputChannel.appendLine(`[error] status=${error.status} message=${error.message}`);
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      vscode.window.showErrorMessage(`FormaTeX command failed: ${message}`);
      outputChannel.appendLine(`[error] ${message}`);
    }
  }));
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    title: "FormaTeX API Key",
    prompt: "Enter your FormaTeX API key",
    ignoreFocusOut: true,
    password: true
  });

  if (!apiKey) {
    return;
  }

  await context.secrets.store("formatex.apiKey", apiKey.trim());
  vscode.window.showInformationMessage("FormaTeX API key saved.");
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete("formatex.apiKey");
  vscode.window.showInformationMessage("FormaTeX API key cleared.");
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | null> {
  const apiKey = await context.secrets.get("formatex.apiKey");
  if (apiKey) {
    return apiKey;
  }

  const choice = await vscode.window.showWarningMessage(
    "FormaTeX API key is missing.",
    "Set API Key"
  );

  if (choice === "Set API Key") {
    await setApiKey(context);
    const refreshed = await context.secrets.get("formatex.apiKey");
    return refreshed ?? null;
  }

  return null;
}

async function refreshStatusBar(context: vscode.ExtensionContext, activeUri?: vscode.Uri): Promise<void> {
  const apiKey = await context.secrets.get("formatex.apiKey");
  if (!apiKey) {
    statusBar.showDisconnected();
    return;
  }

  const client = apiClient ?? new FormatexApiClient(getSettings());
  const user = await getCachedUser(context, client);

  if (activeUri?.scheme === "formatex") {
    try {
      const project = await client.getProject(activeUri.authority, apiKey);
      statusBar.showProject(project.data);
      return;
    } catch {
      // Fall back to ready state when the project cannot be fetched.
    }
  }

  statusBar.showReady(user?.plan);
}

async function copyProjectId(node: unknown): Promise<void> {
  const candidate = node as { project?: { id: string } } | { id: string } | undefined;
  const projectId = candidate && "project" in candidate ? candidate.project?.id : candidate && "id" in candidate ? candidate.id : undefined;

  if (!projectId) {
    return;
  }

  await vscode.env.clipboard.writeText(projectId);
  vscode.window.showInformationMessage("FormaTeX project ID copied.");
}

function logHeaders(headers: FormatexHeaders): void {
  const pairs = Object.entries(headers)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  if (pairs) {
    outputChannel.appendLine(`[headers] ${pairs}`);
  }
}

function normalizeEngine(engine: Engine): "pdflatex" | "xelatex" | "lualatex" | undefined {
  if (engine === "auto") {
    return undefined;
  }
  return engine;
}

async function compileCurrent(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri || path.extname(targetUri.path).toLowerCase() !== ".tex") {
    vscode.window.showErrorMessage("Open a .tex file first.");
    return;
  }

  if (targetUri.scheme === "formatex") {
    await compileCloudProject(context, apiClient, statusBar, outputChannel, diagnostics, targetUri.authority);
    return;
  }

  await runCompileForUri(context, targetUri, false);
}

async function compileResource(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    vscode.window.showErrorMessage("Select a .tex file from Explorer.");
    return;
  }

  if (uri.scheme === "formatex") {
    await compileCloudProject(context, apiClient, statusBar, outputChannel, diagnostics, uri.authority);
    return;
  }

  await runCompileForUri(context, uri, false);
}

async function compileProject(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    vscode.window.showErrorMessage("Open or select a .tex file to compile project.");
    return;
  }

  if (targetUri.scheme === "formatex") {
    await compileCloudProject(context, apiClient, statusBar, outputChannel, diagnostics, targetUri.authority);
    return;
  }

  await runCompileForUri(context, targetUri, true);
}

async function checkSyntax(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri || path.extname(targetUri.path).toLowerCase() !== ".tex") {
    vscode.window.showErrorMessage("Open a .tex file first.");
    return;
  }

  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const client = apiClient ?? new FormatexApiClient(settings);
  const latex = targetUri.scheme === "formatex" ? (await vscode.workspace.openTextDocument(targetUri)).getText() : await fs.readFile(targetUri.fsPath, "utf8");

  const request: CompileRequest = {
    latex,
    engine: normalizeEngine(settings.defaultEngine)
  };

  try {
    const result = await client.checkSyntax(request, apiKey);
    outputChannel.appendLine("[syntax] Check completed");
    logHeaders(result.headers);

    const diagnosticsPayload = getDiagnosticsPayload(result.data);
    publishDiagnostics(diagnostics, targetUri, diagnosticsPayload);
    if (diagnosticsPayload.length === 0) {
      vscode.window.showInformationMessage("FormaTeX syntax check passed.");
    } else {
      vscode.window.showWarningMessage(`FormaTeX found ${diagnosticsPayload.length} syntax issues.`);
      outputChannel.show(true);
    }
  } catch (error) {
    await handleApiError(error, context);
  }
}

async function runCompileForUri(context: vscode.ExtensionContext, targetUri: vscode.Uri, asProject: boolean): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const client = apiClient ?? new FormatexApiClient(settings);

  if (targetUri.scheme === "formatex") {
    await compileCloudProject(context, client, statusBar, outputChannel, diagnostics, targetUri.authority);
    return;
  }

  let compileRequest: CompileRequest;
  let payloadBytes = 0;
  let mainFilePath = targetUri.fsPath;

  if (asProject) {
    const folder = getWorkspaceFolderForUri(targetUri);
    if (!folder) {
      vscode.window.showErrorMessage("Project compile requires an open workspace folder.");
      return;
    }

    const mainTex = await resolveMainTex(folder.uri.fsPath, targetUri.fsPath, settings.mainFile);
    mainFilePath = mainTex;
    const projectData = await collectProjectFiles(folder.uri.fsPath, mainTex);

    compileRequest = {
      latex: projectData.latex,
      files: projectData.files,
      engine: normalizeEngine(settings.defaultEngine)
    };

    payloadBytes = projectData.payloadBytes;
    outputChannel.appendLine(`[project] main=${path.relative(folder.uri.fsPath, mainTex)} files=${projectData.files.length}`);
  } else {
    const latex = await fs.readFile(targetUri.fsPath, "utf8");
    payloadBytes = Buffer.byteLength(latex, "utf8");
    compileRequest = {
      latex,
      engine: normalizeEngine(settings.defaultEngine)
    };
  }

  statusBar.showBusy();
  outputChannel.appendLine(`[compile] started file=${mainFilePath}`);

  try {
    const fallbackToAsync = settings.enableAsyncFallback && payloadBytes > settings.asyncFallbackBytes;
    if (fallbackToAsync) {
      outputChannel.appendLine(`[compile] async fallback triggered payloadBytes=${payloadBytes}`);
      await runAsyncCompile(context, client, apiKey, compileRequest, mainFilePath);
    } else {
      await runSyncCompile(context, client, apiKey, compileRequest, mainFilePath);
    }
  } catch (error) {
    await handleApiError(error, context);
  } finally {
    void refreshStatusBar(context, vscode.window.activeTextEditor?.document.uri);
  }
}

async function runSyncCompile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  apiKey: string,
  request: CompileRequest,
  mainFilePath: string
): Promise<void> {
  const response = await client.compileSmart(request, apiKey);
  logHeaders(response.headers);

  const diagnosticsPayload = getDiagnosticsPayload(response.data);
  publishDiagnostics(diagnostics, vscode.Uri.file(mainFilePath), diagnosticsPayload);

  if (!isCompileSuccess(response.data)) {
    throw new FormatexApiError("Compilation failed", 422, response.data, response.headers);
  }

  if (!response.data.pdf) {
    throw new FormatexApiError("Compile succeeded but PDF is missing in response.", 500, response.data, response.headers);
  }

  const pdfBytes = Buffer.from(response.data.pdf, "base64");
  await persistAndOpenResult(context, mainFilePath, pdfBytes, response.data.remoteUrl);
  outputChannel.appendLine(`[compile] success durationMs=${response.data.duration ?? "n/a"}`);
}

async function runAsyncCompile(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  apiKey: string,
  request: CompileRequest,
  mainFilePath: string
): Promise<void> {
  const submit = await client.compileAsync(request, apiKey);
  outputChannel.appendLine(`[async] job submitted id=${submit.data.jobId}`);

  const job = await client.waitForAsyncResult(submit.data.jobId, apiKey);
  outputChannel.appendLine(`[async] status=${job.status}`);

  if (job.status !== "completed") {
    const err = job.result?.error ?? "Async compilation failed.";
    const log = job.result?.log;
    if (log) {
      outputChannel.appendLine(log);
    }
    throw new FormatexApiError(err, 422, job, submit.headers);
  }

  const pdf = await client.getAsyncPdf(submit.data.jobId, apiKey);
  await persistAndOpenResult(context, mainFilePath, Buffer.from(pdf.bytes), job.result?.remoteUrl);
}

async function persistAndOpenResult(
  context: vscode.ExtensionContext,
  sourceTexPath: string,
  pdfBytes: Uint8Array,
  remoteUrl?: string
): Promise<void> {
  const settings = getSettings();
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourceTexPath));
  if (!folder) {
    throw new Error("Cannot resolve workspace folder for output storage.");
  }

  const outputRoot = path.join(folder.uri.fsPath, settings.outputDir);
  await fs.mkdir(outputRoot, { recursive: true });

  const baseName = path.basename(sourceTexPath, ".tex");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = path.join(outputRoot, `${baseName}-${timestamp}.pdf`);

  await fs.writeFile(targetPath, pdfBytes);
  await context.globalState.update(LAST_PDF_PATH_KEY, targetPath);

  if (remoteUrl) {
    await context.globalState.update(LAST_REMOTE_URL_KEY, remoteUrl);
  }

  vscode.window.showInformationMessage("FormaTeX compile succeeded.", "Open PDF", "Show Logs", "Open Remote").then(
    async (action) => {
      if (action === "Open PDF") {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(targetPath));
      }
      if (action === "Show Logs") {
        outputChannel.show(true);
      }
      if (action === "Open Remote") {
        const url = remoteUrl ?? context.globalState.get<string>(LAST_REMOTE_URL_KEY);
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    }
  );

  if (settings.autoOpenPdf) {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(targetPath));
  }

  if (settings.openRemoteResult && remoteUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(remoteUrl));
  }
}

async function openLastPdf(context: vscode.ExtensionContext): Promise<void> {
  const localPath = context.globalState.get<string>(LAST_PDF_PATH_KEY);
  if (!localPath) {
    vscode.window.showWarningMessage("No previous compile output found.");
    return;
  }

  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(localPath));
}

async function showUsage(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const client = apiClient ?? new FormatexApiClient(settings);

  try {
    const usage = await client.getUsage(apiKey);
    const used = usage.data.used ?? usage.headers.used ?? "n/a";
    const limit = usage.data.limit ?? usage.headers.limit ?? "n/a";
    const plan = usage.data.plan ?? usage.headers.plan ?? "unknown";

    vscode.window.showInformationMessage(`FormaTeX usage: ${used}/${limit} on ${plan} plan.`);
  } catch (error) {
    await handleApiError(error, context);
  }
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

async function handleApiError(error: unknown, context: vscode.ExtensionContext): Promise<void> {
  if (error instanceof FormatexApiError) {
    const retryAfter = error.headers.retryAfter;
    statusBar.showError();

    if (error.status === 401) {
      const choice = await vscode.window.showErrorMessage("FormaTeX authentication failed.", "Set API Key", "Show Logs");
      if (choice === "Set API Key") {
        await setApiKey(context);
      }
    } else if (error.status === 403) {
      vscode.window.showErrorMessage("FormaTeX plan limit or permission restriction reached.");
    } else if (error.status === 422) {
      vscode.window.showErrorMessage("LaTeX compilation failed. See FormaTeX output for details.", "Show Logs").then((action) => {
        if (action === "Show Logs") {
          outputChannel.show(true);
        }
      });
    } else if (error.status === 429) {
      vscode.window.showWarningMessage(`FormaTeX rate limit hit. Retry after ${retryAfter ?? "a moment"}s.`);
    } else {
      vscode.window.showErrorMessage(`FormaTeX request failed: ${error.message}`);
    }

    outputChannel.appendLine(`[error] status=${error.status} message=${error.message}`);
    const detailText = stringifyErrorDetails(error.details);
    if (detailText) {
      outputChannel.appendLine(detailText);
    }
    outputChannel.show(true);
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  vscode.window.showErrorMessage(`FormaTeX error: ${message}`);
  outputChannel.appendLine(`[error] ${message}`);
  statusBar.showError();
}

function stringifyErrorDetails(details: unknown): string {
  if (!details) {
    return "";
  }

  if (typeof details === "string") {
    return details;
  }

  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return "";
  }
}

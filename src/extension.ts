import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { FormatexApiClient, FormatexApiError } from "./api";
import { publishDiagnostics } from "./diagnostics";
import { collectProjectFiles, getWorkspaceFolderForUri, resolveMainTex } from "./project";
import { getSettings } from "./settings";
import { CompileRequest, CompileResponse, DiagnosticPayload, Engine, FormatexHeaders } from "./types";

const SECRET_API_KEY = "formatex.apiKey";
const LAST_PDF_PATH_KEY = "formatex.lastPdfPath";
const LAST_REMOTE_URL_KEY = "formatex.lastRemoteUrl";

let outputChannel: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("FormaTeX");
  diagnostics = vscode.languages.createDiagnosticCollection("formatex");
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "formatex.showOutput";
  statusBarItem.text = "FormaTeX: Ready";
  statusBarItem.show();

  context.subscriptions.push(outputChannel, diagnostics, statusBarItem);

  register(context, "formatex.setApiKey", async () => setApiKey(context));
  register(context, "formatex.clearApiKey", async () => clearApiKey(context));
  register(context, "formatex.showOutput", async () => outputChannel.show(true));
  register(context, "formatex.openLastPdf", async () => openLastPdf(context));
  register(context, "formatex.showUsage", async () => showUsage(context));
  register(context, "formatex.compileCurrent", async (...args) => compileCurrent(context, args[0] as vscode.Uri | undefined));
  register(context, "formatex.compileResource", async (...args) => compileResource(context, args[0] as vscode.Uri | undefined));
  register(context, "formatex.compileProject", async (...args) => compileProject(context, args[0] as vscode.Uri | undefined));
  register(context, "formatex.checkSyntax", async (...args) => checkSyntax(context, args[0] as vscode.Uri | undefined));
}

export function deactivate(): void {
  diagnostics?.dispose();
  statusBarItem?.dispose();
  outputChannel?.dispose();
}

function register(
  context: vscode.ExtensionContext,
  command: string,
  handler: (...args: unknown[]) => Promise<void>
): void {
  context.subscriptions.push(vscode.commands.registerCommand(command, (...args) => handler(...args)));
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

  await context.secrets.store(SECRET_API_KEY, apiKey.trim());
  vscode.window.showInformationMessage("FormaTeX API key saved.");
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_API_KEY);
  vscode.window.showInformationMessage("FormaTeX API key cleared.");
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | null> {
  const apiKey = await context.secrets.get(SECRET_API_KEY);
  if (apiKey) {
    return apiKey;
  }

  const choice = await vscode.window.showWarningMessage(
    "FormaTeX API key is missing.",
    "Set API Key"
  );

  if (choice === "Set API Key") {
    await setApiKey(context);
    const refreshed = await context.secrets.get(SECRET_API_KEY);
    return refreshed ?? null;
  }

  return null;
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
  if (!targetUri || path.extname(targetUri.fsPath).toLowerCase() !== ".tex") {
    vscode.window.showErrorMessage("Open a .tex file first.");
    return;
  }

  await runCompileForUri(context, targetUri, false);
}

async function compileResource(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    vscode.window.showErrorMessage("Select a .tex file from Explorer.");
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

  await runCompileForUri(context, targetUri, true);
}

async function checkSyntax(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri || path.extname(targetUri.fsPath).toLowerCase() !== ".tex") {
    vscode.window.showErrorMessage("Open a .tex file first.");
    return;
  }

  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const client = new FormatexApiClient(settings);
  const latex = await fs.readFile(targetUri.fsPath, "utf8");

  const request: CompileRequest = {
    latex,
    engine: normalizeEngine(settings.defaultEngine)
  };

  setStatus("Checking", "$(search-view-icon) FormaTeX: Checking");

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
  } finally {
    setStatus("Ready", "FormaTeX: Ready");
  }
}

async function runCompileForUri(context: vscode.ExtensionContext, targetUri: vscode.Uri, asProject: boolean): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }

  const settings = getSettings();
  const client = new FormatexApiClient(settings);

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

  setStatus("Compiling", "$(sync~spin) FormaTeX: Compiling");
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
    setStatus("Ready", "FormaTeX: Ready");
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
  const client = new FormatexApiClient(settings);

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

function setStatus(label: string, text: string): void {
  statusBarItem.tooltip = `FormaTeX: ${label}`;
  statusBarItem.text = text;
}

async function handleApiError(error: unknown, context: vscode.ExtensionContext): Promise<void> {
  if (error instanceof FormatexApiError) {
    const retryAfter = error.headers.retryAfter;

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

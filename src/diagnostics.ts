import * as vscode from "vscode";
import { DiagnosticPayload } from "./types";

function mapSeverity(input?: string): vscode.DiagnosticSeverity {
  if (input === "warning") {
    return vscode.DiagnosticSeverity.Warning;
  }
  if (input === "info") {
    return vscode.DiagnosticSeverity.Information;
  }
  return vscode.DiagnosticSeverity.Error;
}

export function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  targetUri: vscode.Uri,
  payloads: DiagnosticPayload[]
): void {
  if (payloads.length === 0) {
    collection.delete(targetUri);
    return;
  }

  const diagnostics = payloads.map((item) => {
    const line = Math.max((item.line ?? 1) - 1, 0);
    const col = Math.max((item.column ?? 1) - 1, 0);
    const range = new vscode.Range(new vscode.Position(line, col), new vscode.Position(line, col + 1));
    const diagnostic = new vscode.Diagnostic(range, item.message, mapSeverity(item.severity));
    diagnostic.source = "FormaTeX";
    return diagnostic;
  });

  collection.set(targetUri, diagnostics);
}

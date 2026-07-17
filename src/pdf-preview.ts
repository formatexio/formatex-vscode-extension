import * as vscode from "vscode";

export async function openPdfBeside(targetPath: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(targetPath), {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: true
  } as vscode.TextDocumentShowOptions);
}

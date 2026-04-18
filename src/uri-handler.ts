import * as vscode from "vscode";

export class FormatexUriHandler implements vscode.UriHandler {
  constructor(
    private readonly openProject: (projectId: string, filePath?: string, mode?: "vfs" | "local") => Promise<void>
  ) {}

  public async handleUri(uri: vscode.Uri): Promise<void> {
    const params = new URLSearchParams(uri.query);
    const projectId = params.get("projectId") ?? uri.path.split("/").filter(Boolean)[1] ?? uri.fragment;
    const filePath = params.get("filePath") ?? undefined;
    const mode = params.get("mode") === "local" ? "local" : "vfs";

    if (!projectId) {
      vscode.window.showErrorMessage("FormaTeX URI missing project ID.");
      return;
    }

    await this.openProject(projectId, filePath, mode);
  }
}

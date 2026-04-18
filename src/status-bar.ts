import * as vscode from "vscode";
import { Project } from "./types";

export class FormatexStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.text = "FormaTeX: Not connected";
    this.item.tooltip = "FormaTeX is not connected";
    this.item.command = "formatex.setApiKey";
    this.item.show();

    context.subscriptions.push(this.item);
  }

  public showDisconnected(): void {
    this.item.text = "$(warning) FormaTeX: Not connected";
    this.item.tooltip = "Set your FormaTeX API key";
    this.item.command = "formatex.setApiKey";
    this.item.show();
  }

  public showReady(plan?: string): void {
    this.item.text = plan ? `FormaTeX: Ready [${plan}]` : "FormaTeX: Ready";
    this.item.tooltip = "Show FormaTeX output";
    this.item.command = "formatex.showOutput";
    this.item.show();
  }

  public showProject(project: Project): void {
    this.item.text = `FormaTeX: ${project.name}`;
    this.item.tooltip = `${project.name} (${project.fileCount} files)`;
    this.item.command = {
      command: "formatex.showProjectActions",
      title: "FormaTeX Project Actions",
      arguments: [project]
    };
    this.item.show();
  }

  public showBusy(): void {
    this.item.text = "$(sync~spin) FormaTeX: Compiling...";
    this.item.tooltip = "FormaTeX is compiling";
    this.item.command = "formatex.showOutput";
    this.item.show();
  }

  public showSaving(): void {
    this.item.text = "$(sync~spin) FormaTeX: Saving...";
    this.item.tooltip = "Syncing cloud changes";
    this.item.command = "formatex.showOutput";
    this.item.show();
  }

  public showSaved(): void {
    this.item.text = "$(check) FormaTeX: Saved";
    this.item.tooltip = "Cloud changes synced";
    this.item.command = "formatex.showOutput";
    this.item.show();
  }

  public showError(): void {
    this.item.text = "$(error) FormaTeX: Failed";
    this.item.tooltip = "Show FormaTeX output";
    this.item.command = "formatex.showOutput";
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}
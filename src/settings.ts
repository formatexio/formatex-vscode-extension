import * as vscode from "vscode";
import { Engine } from "./types";

export interface FormatexSettings {
  apiBaseUrl: string;
  defaultEngine: Engine;
  outputDir: string;
  mainFile: string;
  autoOpenPdf: boolean;
  openRemoteResult: boolean;
  enableAsyncFallback: boolean;
  asyncFallbackBytes: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export function getSettings(): FormatexSettings {
  const config = vscode.workspace.getConfiguration("formatex");

  return {
    apiBaseUrl: config.get<string>("apiBaseUrl", "https://api.formatex.io").replace(/\/$/, ""),
    defaultEngine: config.get<Engine>("defaultEngine", "auto"),
    outputDir: config.get<string>("outputDir", ".formatex/output"),
    mainFile: config.get<string>("mainFile", ""),
    autoOpenPdf: config.get<boolean>("autoOpenPdf", true),
    openRemoteResult: config.get<boolean>("openRemoteResult", false),
    enableAsyncFallback: config.get<boolean>("enableAsyncFallback", true),
    asyncFallbackBytes: config.get<number>("asyncFallbackBytes", 2 * 1024 * 1024),
    requestTimeoutMs: config.get<number>("requestTimeoutMs", 90000),
    pollIntervalMs: config.get<number>("pollIntervalMs", 1000),
    pollTimeoutMs: config.get<number>("pollTimeoutMs", 300000)
  };
}

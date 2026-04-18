import * as vscode from "vscode";
import { FormatexApiClient } from "./api";
import { UserInfo } from "./types";

const SECRET_API_KEY = "formatex.apiKey";

let cachedApiKey: string | null = null;
let cachedUser: UserInfo | null = null;

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | null> {
  return (await context.secrets.get(SECRET_API_KEY)) ?? null;
}

export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
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
  clearCachedUser();
  cachedApiKey = null;
  vscode.window.showInformationMessage("FormaTeX API key saved.");
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_API_KEY);
  clearCachedUser();
  cachedApiKey = null;
  vscode.window.showInformationMessage("FormaTeX API key cleared.");
}

export async function getCachedUser(
  context: vscode.ExtensionContext,
  client: FormatexApiClient
): Promise<UserInfo | null> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    cachedApiKey = null;
    cachedUser = null;
    return null;
  }

  if (cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedUser = null;
  }

  if (cachedUser) {
    return cachedUser;
  }

  try {
    const response = await client.getMe(apiKey);
    cachedUser = response.data;
    return cachedUser;
  } catch {
    cachedUser = null;
    return null;
  }
}

export function clearCachedUser(): void {
  cachedUser = null;
}

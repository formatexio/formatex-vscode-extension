import { setTimeout as delay } from "node:timers/promises";
import {
  AsyncJobResponse,
  AsyncSubmitResponse,
  CompileRequest,
  CompileResponse,
  FormatexHeaders,
  Project,
  ProjectFile,
  UsageResponse,
  UserInfo
} from "./types";
import { FormatexSettings } from "./settings";

interface RequestOptions {
  method?: string;
  body?: string | Uint8Array | ArrayBuffer | null;
  headers?: Record<string, string>;
  timeoutMs: number;
  apiKey: string;
}

export interface ApiResponse<T> {
  data: T;
  headers: FormatexHeaders;
  rawHeaders: Headers;
  contentType: string;
}

function mapHeaders(headers: Headers): FormatexHeaders {
  return {
    plan: headers.get("x-plan") ?? undefined,
    used: headers.get("x-compilations-used") ?? undefined,
    limit: headers.get("x-compilations-limit") ?? undefined,
    engine: headers.get("x-engine-used") ?? undefined,
    retryAfter: headers.get("retry-after") ?? undefined,
    cache: headers.get("x-cache") ?? undefined
  };
}

export class FormatexApiError extends Error {
  public readonly status: number;
  public readonly details: unknown;
  public readonly headers: FormatexHeaders;

  constructor(message: string, status: number, details: unknown, headers: FormatexHeaders) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

export class FormatexApiClient {
  constructor(private readonly settings: FormatexSettings) {}

  private buildUrl(path: string): string {
    return `${this.settings.apiBaseUrl}${path}`;
  }

  private encodePath(filePath: string): string {
    return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  }

  private projectUrl(projectId: string): string {
    return `/api/v1/projects/${encodeURIComponent(projectId)}`;
  }

  private fileUrl(projectId: string, filePath: string, suffix = ""): string {
    return `${this.projectUrl(projectId)}/files/${this.encodePath(filePath)}${suffix}`;
  }

  private async request<T>(path: string, options: RequestOptions): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(this.buildUrl(path), {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          "X-API-Key": options.apiKey,
          ...(options.headers ?? {})
        },
        body: options.body,
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") ?? "";
      const headers = mapHeaders(response.headers);

      let parsed: unknown = null;
      if (contentType.includes("application/json")) {
        parsed = await response.json();
      } else {
        parsed = await response.text();
      }

      if (!response.ok) {
        const errorMessage =
          typeof parsed === "object" && parsed !== null && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `Request failed with status ${response.status}`;
        throw new FormatexApiError(errorMessage, response.status, parsed, headers);
      }

      return { data: parsed as T, headers, rawHeaders: response.headers, contentType };
    } catch (error) {
      if (error instanceof FormatexApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new FormatexApiError("Request timed out", 408, null, {});
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async compileSmart(request: CompileRequest, apiKey: string): Promise<ApiResponse<CompileResponse>> {
    return this.request<CompileResponse>("/api/v1/compile/smart", {
      method: "POST",
      body: JSON.stringify(request),
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async compileSync(request: CompileRequest, apiKey: string): Promise<ApiResponse<CompileResponse>> {
    return this.request<CompileResponse>("/api/v1/compile", {
      method: "POST",
      body: JSON.stringify(request),
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async compileAsync(request: CompileRequest, apiKey: string): Promise<ApiResponse<AsyncSubmitResponse>> {
    return this.request<AsyncSubmitResponse>("/api/v1/compile/async", {
      method: "POST",
      body: JSON.stringify(request),
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async getAsyncJob(jobId: string, apiKey: string): Promise<ApiResponse<AsyncJobResponse>> {
    return this.request<AsyncJobResponse>(`/api/v1/jobs/${jobId}`, {
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async getAsyncPdf(jobId: string, apiKey: string): Promise<{ bytes: Uint8Array; headers: FormatexHeaders }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);

    try {
      const response = await fetch(this.buildUrl(`/api/v1/jobs/${jobId}/pdf`), {
        headers: {
          "X-API-Key": apiKey
        },
        signal: controller.signal
      });

      const headers = mapHeaders(response.headers);
      if (!response.ok) {
        const maybeJson = await response.text();
        throw new FormatexApiError(`PDF download failed: ${maybeJson}`, response.status, maybeJson, headers);
      }

      const buffer = await response.arrayBuffer();
      return { bytes: new Uint8Array(buffer), headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  public async checkSyntax(request: CompileRequest, apiKey: string): Promise<ApiResponse<CompileResponse>> {
    return this.request<CompileResponse>("/api/v1/compile/check", {
      method: "POST",
      body: JSON.stringify(request),
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async getUsage(apiKey: string): Promise<ApiResponse<UsageResponse>> {
    return this.request<UsageResponse>("/api/v1/usage", {
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async waitForAsyncResult(jobId: string, apiKey: string): Promise<AsyncJobResponse> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.settings.pollTimeoutMs) {
      const { data } = await this.getAsyncJob(jobId, apiKey);
      if (data.status === "completed" || data.status === "failed") {
        return data;
      }

      await delay(this.settings.pollIntervalMs);
    }

    throw new FormatexApiError("Async compilation timed out", 408, null, {});
  }

  public async getMe(apiKey: string): Promise<ApiResponse<UserInfo>> {
    return this.request<UserInfo>("/api/v1/me", {
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async listProjects(apiKey: string): Promise<ApiResponse<{ projects: Project[] }>> {
    return this.request<{ projects: Project[] }>("/api/v1/projects", {
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async getProject(projectId: string, apiKey: string): Promise<ApiResponse<Project>> {
    return this.request<Project>(this.projectUrl(projectId), {
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async listFiles(projectId: string, apiKey: string): Promise<ApiResponse<{ files: ProjectFile[] }>> {
    return this.request<{ files: ProjectFile[] }>(`${this.projectUrl(projectId)}/files`, {
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async readFile(projectId: string, filePath: string, apiKey: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);

    try {
      const response = await fetch(this.buildUrl(this.fileUrl(projectId, filePath)), {
        headers: {
          "X-API-Key": apiKey
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const details = await response.text();
        throw new FormatexApiError(`File read failed with status ${response.status}`, response.status, details, mapHeaders(response.headers));
      }

      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof FormatexApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new FormatexApiError("Request timed out", 408, null, {});
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async writeFile(
    projectId: string,
    filePath: string,
    content: Uint8Array,
    mimeType: string,
    apiKey: string
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);

    try {
      const response = await fetch(this.buildUrl(this.fileUrl(projectId, filePath)), {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
          "X-API-Key": apiKey
        },
        body: content,
        signal: controller.signal
      });

      if (!response.ok) {
        const details = await response.text();
        throw new FormatexApiError(`File write failed with status ${response.status}`, response.status, details, mapHeaders(response.headers));
      }
    } catch (error) {
      if (error instanceof FormatexApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new FormatexApiError("Request timed out", 408, null, {});
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async deleteFile(projectId: string, filePath: string, apiKey: string): Promise<void> {
    await this.request<void>(this.fileUrl(projectId, filePath), {
      method: "DELETE",
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey
    });
  }

  public async renameFile(projectId: string, oldPath: string, newPath: string, apiKey: string): Promise<void> {
    await this.request<void>(`${this.projectUrl(projectId)}/files/rename`, {
      method: "POST",
      body: JSON.stringify({ oldPath, newPath }),
      timeoutMs: this.settings.requestTimeoutMs,
      apiKey,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  public async exportProject(projectId: string, apiKey: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);

    try {
      const response = await fetch(this.buildUrl(`${this.projectUrl(projectId)}/export`), {
        headers: {
          "X-API-Key": apiKey
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const details = await response.text();
        throw new FormatexApiError(`Project export failed with status ${response.status}`, response.status, details, mapHeaders(response.headers));
      }

      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof FormatexApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new FormatexApiError("Request timed out", 408, null, {});
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}


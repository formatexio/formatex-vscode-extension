import { setTimeout as delay } from "node:timers/promises";
import {
  AsyncJobResponse,
  AsyncSubmitResponse,
  CompileRequest,
  CompileResponse,
  FormatexHeaders,
  UsageResponse
} from "./types";
import { FormatexSettings } from "./settings";

interface RequestOptions {
  method?: string;
  body?: string;
  timeoutMs: number;
  apiKey: string;
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

interface ApiResponse<T> {
  data: T;
  headers: FormatexHeaders;
  rawHeaders: Headers;
  contentType: string;
}

export class FormatexApiClient {
  constructor(private readonly settings: FormatexSettings) {}

  private async request<T>(path: string, options: RequestOptions): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(`${this.settings.apiBaseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-Key": options.apiKey
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
      const response = await fetch(`${this.settings.apiBaseUrl}/api/v1/jobs/${jobId}/pdf`, {
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
}

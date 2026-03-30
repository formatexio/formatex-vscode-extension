export type Engine = "auto" | "pdflatex" | "xelatex" | "lualatex";

export interface FileUpload {
  path: string;
  data: string;
}

export interface CompileRequest {
  latex: string;
  engine?: Engine | "pdflatex" | "xelatex" | "lualatex";
  timeout?: number;
  files?: FileUpload[];
}

export interface CompileSuccessResponse {
  success: true;
  pdf?: string;
  duration?: number;
  engine?: string;
  cached?: boolean;
  diagnostics?: DiagnosticPayload[];
  remoteUrl?: string;
}

export interface CompileErrorResponse {
  success: false;
  error: string;
  log?: string;
  diagnostics?: DiagnosticPayload[];
  suggestions?: string[];
}

export type CompileResponse = CompileSuccessResponse | CompileErrorResponse;

export interface AsyncSubmitResponse {
  jobId: string;
  status: "pending" | "processing";
}

export interface AsyncJobResponse {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  result?: {
    success?: boolean;
    error?: string;
    log?: string;
    remoteUrl?: string;
  };
}

export interface DiagnosticPayload {
  line?: number;
  column?: number;
  severity?: "error" | "warning" | "info";
  message: string;
}

export interface UsageResponse {
  used?: number;
  limit?: number;
  plan?: string;
}

export interface FormatexHeaders {
  plan?: string;
  used?: string;
  limit?: string;
  engine?: string;
  retryAfter?: string;
  cache?: string;
}

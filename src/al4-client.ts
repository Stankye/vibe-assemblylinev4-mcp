import { existsSync, createReadStream, promises as fs } from "fs";
import { basename } from "path";
import { Readable } from "stream";
import { randomUUID } from "crypto";

// Files larger than this are streamed directly into the request body instead
// of being buffered in memory first.  Blob uploads triple-buffer the file
// (readFile → Buffer → Blob → FormData serialization), so a 50 MB sample
// consumes ~2 GB of heap.  Streaming keeps memory usage proportional to the
// chunk size (~64 KB at a time).
const STREAM_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MB

// Defaults — all overridable via AL4Config.
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 300;
const DEFAULT_RETRY_MAX_MS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** RFC 7578: strip CR/LF and escape quote/backslash from filenames. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n]/g, "_").replace(/["\\]/g, "_");
}

/** Encode a single URL path segment. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

const SHA256_RE = /^[a-fA-F0-9]{64}$/;

async function* multipartGenerator(
  jsonPart: string | null,
  filePath: string,
  filename: string,
  boundary: string,
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  if (jsonPart !== null) {
    yield enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n` +
        `Content-Type: application/json\r\n\r\n${jsonPart}\r\n`,
    );
  }
  yield enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="bin"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  for await (const chunk of createReadStream(filePath)) {
    yield chunk as Uint8Array;
  }
  yield enc.encode(`\r\n--${boundary}--\r\n`);
}

export interface AL4Config {
  url: string;
  username: string;
  apikey: string;
  /**
   * NOTE: per-instance TLS toggling is not supported here; the caller sets
   * process.env.NODE_TLS_REJECT_UNAUTHORIZED when disabling. Field kept for
   * informational use.
   */
  tlsVerify?: boolean;
  /** Per-request timeout in ms. Default 60_000. Set 0 to disable. */
  timeoutMs?: number;
  /** Max retry attempts for transient failures (network / 429 / 5xx). Default 3. */
  maxRetries?: number;
  /** Base backoff in ms (exponential w/ jitter). Default 300. */
  retryBaseMs?: number;
  /** Cap for backoff in ms. Default 5_000. */
  retryMaxMs?: number;
  /** Refuse to upload files larger than this. Default 2 GiB. */
  maxFileBytes?: number;
  /** Optional User-Agent header. */
  userAgent?: string;
}

export interface RequestOptions {
  /** Caller abort signal; combined with the per-request timeout. */
  signal?: AbortSignal;
}

export interface SubmissionParams {
  classification?: string;
  description?: string;
  priority?: number;
  ttl?: number;
  services?: {
    selected?: string[];
    excluded?: string[];
    resubmit?: string[];
  };
  service_spec?: Record<string, Record<string, unknown>>;
}

export interface IngestOptions {
  notification_queue?: string;
  notification_threshold?: number;
  alert?: boolean;
  params?: SubmissionParams;
  metadata?: Record<string, string>;
  name?: string;
}

export interface SubmitOptions {
  params?: SubmissionParams;
  metadata?: Record<string, string>;
  name?: string;
}

export interface SearchOptions {
  query: string;
  fl?: string;
  rows?: number;
  offset?: number;
  sort?: string;
  filters?: string[];
}

export interface IngestOptions extends RequestOptions {
  notification_queue?: string;
  notification_threshold?: number;
  alert?: boolean;
  params?: SubmissionParams;
  metadata?: Record<string, string>;
  name?: string;
}

export interface SubmitOptions extends RequestOptions {
  params?: SubmissionParams;
  metadata?: Record<string, string>;
  name?: string;
}

export interface SearchOptions extends RequestOptions {
  query: string;
  fl?: string;
  rows?: number;
  offset?: number;
  sort?: string;
  filters?: string[];
}

export class AL4ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly apiStatusCode: number | undefined,
    public readonly method: string,
    public readonly path: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "AL4ApiError";
  }
}

export class AL4Client {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxFileBytes: number;

  constructor(config: AL4Config) {
    if (!config?.url || typeof config.url !== "string") {
      throw new Error("AL4Config.url is required");
    }
    if (!config.username) throw new Error("AL4Config.username is required");
    if (!config.apikey) throw new Error("AL4Config.apikey is required");
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      throw new Error(`AL4Config.url is not a valid URL: ${config.url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`AL4Config.url must use http(s): ${config.url}`);
    }

    this.baseUrl = config.url.replace(/\/$/, "");
    this.headers = {
      "X-USER": config.username,
      "X-APIKEY": config.apikey,
      Accept: "application/json",
    };
    if (config.userAgent) this.headers["User-Agent"] = config.userAgent;

    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = config.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** Combine a caller signal with a per-request timeout. */
  private buildSignal(caller?: AbortSignal): {
    signal: AbortSignal;
    cancel: () => void;
  } {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? setTimeout(
            () =>
              controller.abort(
                new Error(`Request timed out after ${this.timeoutMs}ms`),
              ),
            this.timeoutMs,
          )
        : null;
    if (caller) {
      if (caller.aborted) controller.abort(caller.reason);
      else
        caller.addEventListener(
          "abort",
          () => controller.abort(caller.reason),
          { once: true },
        );
    }
    return {
      signal: controller.signal,
      cancel: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }

  private async parseResponse<T>(
    res: Response,
    method: string,
    path: string,
  ): Promise<T> {
    const text = await res.text();
    let json:
      | {
          api_status_code?: number;
          api_error_message?: string;
          api_response?: T;
        }
      | undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body; handled below */
      }
    }
    const apiStatus = json?.api_status_code;
    if (!res.ok || (apiStatus !== undefined && apiStatus >= 400)) {
      const detail =
        json?.api_error_message ?? (text ? text.slice(0, 500) : res.statusText);
      throw new AL4ApiError(
        `AL4 ${method} ${path} failed (HTTP ${res.status}${apiStatus ? `, api ${apiStatus}` : ""}): ${detail}`,
        res.status,
        apiStatus,
        method,
        path,
        json ?? text,
      );
    }
    if (!json) {
      throw new AL4ApiError(
        `AL4 ${method} ${path} returned non-JSON body`,
        res.status,
        undefined,
        method,
        path,
        text.slice(0, 500),
      );
    }
    return json.api_response as T;
  }

  private async backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const exp = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
    const delay = Math.floor(exp / 2 + Math.random() * (exp / 2));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Core request helper. `bodyFactory` is called per attempt so streaming /
   * multipart bodies (which can only be consumed once) can be rebuilt on
   * retry.
   */
  private async send<T>(
    method: string,
    path: string,
    bodyFactory: () => BodyInit | undefined,
    extraHeaders: Record<string, string>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const { signal, cancel } = this.buildSignal(callerSignal);
      try {
        const body = bodyFactory();
        const init: RequestInit & { duplex?: "half" } = {
          method,
          headers: { ...this.headers, ...extraHeaders },
          body,
          signal,
        };
        // Node fetch requires duplex:'half' for streaming request bodies.
        if (body && typeof (body as ReadableStream).getReader === "function") {
          init.duplex = "half";
        }
        const res = await fetch(`${this.baseUrl}${path}`, init);

        if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          await res.arrayBuffer().catch(() => undefined); // drain for keep-alive
          lastErr = new Error(`HTTP ${res.status}`);
          await this.backoff(attempt, signal);
          continue;
        }
        return await this.parseResponse<T>(res, method, path);
      } catch (err) {
        lastErr = err;
        if (err instanceof AL4ApiError) throw err;
        if (callerSignal?.aborted) throw err;
        if (attempt >= this.maxRetries) throw err;
        await this.backoff(attempt, signal);
      } finally {
        cancel();
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const hasBody = body !== undefined;
    return this.send<T>(
      method,
      path,
      () => (hasBody ? JSON.stringify(body) : undefined),
      hasBody ? { "Content-Type": "application/json" } : {},
      opts?.signal,
    );
  }

  private async multipartUpload<T>(
    apiPath: string,
    filePath: string,
    jsonPart: Record<string, unknown>,
    filename: string,
    opts?: RequestOptions,
  ): Promise<T> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (stat.size > this.maxFileBytes) {
      throw new Error(
        `File exceeds maxFileBytes (${stat.size} > ${this.maxFileBytes}): ${filePath}`,
      );
    }
    const cleanName = sanitizeFilename(filename);
    const jsonStr = Object.keys(jsonPart).length
      ? JSON.stringify(jsonPart)
      : null;

    if (stat.size >= STREAM_THRESHOLD_BYTES) {
      const boundary = `al4b-${randomUUID()}`;
      return this.send<T>(
        "POST",
        apiPath,
        () =>
          Readable.toWeb(
            Readable.from(
              multipartGenerator(jsonStr, filePath, cleanName, boundary),
            ),
          ) as unknown as ReadableStream<Uint8Array>,
        { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        opts?.signal,
      );
    }

    // Small file: read once, rebuild FormData per attempt (cheap).
    const buf = await fs.readFile(filePath);
    return this.send<T>(
      "POST",
      apiPath,
      () => {
        const form = new globalThis.FormData();
        if (jsonStr) form.append("json", jsonStr);
        form.append("bin", new Blob([buf]), cleanName);
        return form;
      },
      {},
      opts?.signal,
    );
  }

  // ── User ────────────────────────────────────────────────────────────────

  whoami(opts?: RequestOptions): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/api/v4/user/whoami/", undefined, opts);
  }

  // ── Submit (synchronous) ────────────────────────────────────────────────

  async submitFile(
    filePath: string,
    options: SubmitOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const jsonPart: Record<string, unknown> = {};
    if (options.name) jsonPart.name = options.name;
    if (options.params) jsonPart.params = options.params;
    if (options.metadata) jsonPart.metadata = options.metadata;
    return this.multipartUpload(
      "/api/v4/submit/",
      filePath,
      jsonPart,
      options.name ?? basename(filePath),
      options,
    );
  }

  submitUrl(
    url: string,
    options: SubmitOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!url) throw new Error("url is required");
    const body: Record<string, unknown> = { url };
    if (options.name) body.name = options.name;
    if (options.params) body.params = options.params;
    if (options.metadata) body.metadata = options.metadata;
    return this.requestJson("POST", "/api/v4/submit/", body, options);
  }

  submitSha256(
    sha256: string,
    options: SubmitOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!SHA256_RE.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
    const body: Record<string, unknown> = { sha256 };
    if (options.params) body.params = options.params;
    if (options.metadata) body.metadata = options.metadata;
    return this.requestJson("POST", "/api/v4/submit/", body, options);
  }

  // ── Ingest (asynchronous) ───────────────────────────────────────────────

  async ingestFile(
    filePath: string,
    options: IngestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const jsonPart: Record<string, unknown> = {};
    if (options.name) jsonPart.name = options.name;
    if (options.params) jsonPart.params = options.params;
    if (options.metadata) jsonPart.metadata = options.metadata;
    if (options.notification_queue)
      jsonPart.notification_queue = options.notification_queue;
    if (options.notification_threshold !== undefined)
      jsonPart.notification_threshold = options.notification_threshold;
    if (options.alert !== undefined) jsonPart.generate_alert = options.alert;
    return this.multipartUpload(
      "/api/v4/ingest/",
      filePath,
      jsonPart,
      options.name ?? basename(filePath),
      options,
    );
  }

  ingestUrl(
    url: string,
    options: IngestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!url) throw new Error("url is required");
    const body: Record<string, unknown> = { url };
    if (options.name) body.name = options.name;
    if (options.params) body.params = options.params;
    if (options.metadata) body.metadata = options.metadata;
    if (options.notification_queue)
      body.notification_queue = options.notification_queue;
    if (options.notification_threshold !== undefined)
      body.notification_threshold = options.notification_threshold;
    if (options.alert !== undefined) body.generate_alert = options.alert;
    return this.requestJson("POST", "/api/v4/ingest/", body, options);
  }

  ingestSha256(
    sha256: string,
    options: IngestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!SHA256_RE.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
    const body: Record<string, unknown> = { sha256 };
    if (options.params) body.params = options.params;
    if (options.metadata) body.metadata = options.metadata;
    if (options.notification_queue)
      body.notification_queue = options.notification_queue;
    if (options.notification_threshold !== undefined)
      body.notification_threshold = options.notification_threshold;
    if (options.alert !== undefined) body.generate_alert = options.alert;
    return this.requestJson("POST", "/api/v4/ingest/", body, options);
  }

  // ── Submission results ──────────────────────────────────────────────────

  isSubmissionComplete(sid: string, opts?: RequestOptions): Promise<boolean> {
    if (!sid) throw new Error("sid is required");
    return this.requestJson<boolean>(
      "GET",
      `/api/v4/submission/is_completed/${seg(sid)}/`,
      undefined,
      opts,
    );
  }

  getSubmission(
    sid: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!sid) throw new Error("sid is required");
    return this.requestJson(
      "GET",
      `/api/v4/submission/${seg(sid)}/`,
      undefined,
      opts,
    );
  }

  getSubmissionFull(
    sid: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!sid) throw new Error("sid is required");
    return this.requestJson(
      "GET",
      `/api/v4/submission/full/${seg(sid)}/`,
      undefined,
      opts,
    );
  }

  getSubmissionSummary(
    sid: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!sid) throw new Error("sid is required");
    return this.requestJson(
      "GET",
      `/api/v4/submission/summary/${seg(sid)}/`,
      undefined,
      opts,
    );
  }

  // ── Ingest notification queue ───────────────────────────────────────────

  getIngestMessages(
    notificationQueue: string,
    count = 100,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>[]> {
    if (!notificationQueue) throw new Error("notificationQueue is required");
    const n = Math.max(1, Math.min(1000, Math.floor(count)));
    return this.requestJson(
      "GET",
      `/api/v4/ingest/get_message_list/${seg(notificationQueue)}/?count=${n}`,
      undefined,
      opts,
    );
  }

  // ── Search ──────────────────────────────────────────────────────────────

  private buildSearchParams(opts: SearchOptions): string {
    if (!opts.query) throw new Error("SearchOptions.query is required");
    const p = new URLSearchParams({ query: opts.query });
    if (opts.fl) p.set("fl", opts.fl);
    if (opts.rows !== undefined)
      p.set("rows", String(Math.max(0, Math.floor(opts.rows))));
    if (opts.offset !== undefined)
      p.set("offset", String(Math.max(0, Math.floor(opts.offset))));
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.filters) opts.filters.forEach((f) => p.append("filters", f));
    return p.toString();
  }

  searchSubmissions(opts: SearchOptions): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/api/v4/search/submission/?${this.buildSearchParams(opts)}`,
      undefined,
      opts,
    );
  }

  searchAlerts(opts: SearchOptions): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/api/v4/search/alert/?${this.buildSearchParams(opts)}`,
      undefined,
      opts,
    );
  }

  searchFiles(opts: SearchOptions): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/api/v4/search/file/?${this.buildSearchParams(opts)}`,
      undefined,
      opts,
    );
  }

  searchResults(opts: SearchOptions): Promise<Record<string, unknown>> {
    return this.requestJson(
      "GET",
      `/api/v4/search/result/?${this.buildSearchParams(opts)}`,
      undefined,
      opts,
    );
  }

  // ── Alerts ──────────────────────────────────────────────────────────────

  getAlert(
    alertId: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!alertId) throw new Error("alertId is required");
    return this.requestJson(
      "GET",
      `/api/v4/alert/${seg(alertId)}/`,
      undefined,
      opts,
    );
  }

  setAlertStatus(
    alertId: string,
    status: "ASSESS" | "MALICIOUS" | "NON-MALICIOUS" | "TRIAGE",
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!alertId) throw new Error("alertId is required");
    return this.requestJson(
      "POST",
      `/api/v4/alert/verdict/${seg(alertId)}/malicious/`,
      { status },
      opts,
    );
  }

  // ── File / hash info ────────────────────────────────────────────────────

  getFileInfo(
    sha256: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!SHA256_RE.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
    return this.requestJson(
      "GET",
      `/api/v4/file/info/${seg(sha256)}/`,
      undefined,
      opts,
    );
  }

  getFileResults(
    sha256: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!SHA256_RE.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
    return this.requestJson(
      "GET",
      `/api/v4/file/result/${seg(sha256)}/`,
      undefined,
      opts,
    );
  }

  getFileScore(
    sha256: string,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    if (!SHA256_RE.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
    return this.requestJson(
      "GET",
      `/api/v4/file/score/${seg(sha256)}/`,
      undefined,
      opts,
    );
  }
}

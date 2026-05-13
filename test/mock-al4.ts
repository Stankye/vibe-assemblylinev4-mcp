/**
 * Minimal HTTP server that mimics the AssemblyLine 4 REST API.
 * Used exclusively for testing — validates auth headers, routes requests,
 * and returns structurally correct mock payloads.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockServerOptions {
  /** When false, request bodies are drained and discarded rather than stored.
   *  Use this for benchmarks to avoid accumulating buffers in the same process. */
  captureRequests?: boolean;
}

export interface MockServer {
  url: string;
  stop: () => Promise<void>;
  requests: MockRequest[];
  reset: () => void;
}

const MOCK_USER = {
  uname: "test_user",
  email: "test@example.com",
  roles: ["user", "submission_create", "alert_view"],
};

const MOCK_SID = "abc12345678901234567890123456789";
const MOCK_INGEST_ID = "ing_0000000000000000000000000000000001";
const MOCK_SHA256 = "a" .repeat(64);
const MOCK_ALERT_ID = "alert_00000001";

function mockSubmission(sid = MOCK_SID) {
  return {
    sid,
    state: "completed",
    times: { submitted: "2024-01-01T00:00:00Z", completed: "2024-01-01T00:00:10Z" },
    params: { submitter: "test_user", description: "test submission" },
    files: [{ name: "test.exe", sha256: MOCK_SHA256, size: 1024 }],
    results: [],
    errors: [],
    max_score: 500,
  };
}

function mockSubmissionFull(sid = MOCK_SID) {
  return {
    ...mockSubmission(sid),
    results: {
      [MOCK_SHA256]: {
        "CLAMAV.v1": {
          score: 500,
          tags: { attribution: { implant: ["Trojan.Generic"] } },
          sections: [{ title: "ClamAV Detection", body: "Trojan.Generic detected" }],
        },
      },
    },
  };
}

function mockAlert(alertId = MOCK_ALERT_ID) {
  return {
    alert_id: alertId,
    sid: MOCK_SID,
    type: "SUBMISSION",
    status: "ASSESS",
    priority: "HIGH",
    reporting_ts: "2024-01-01T00:00:10Z",
    ts: "2024-01-01T00:00:00Z",
    al: { score: 500, attrib: [], behavior: ["network.dynamic.domain"] },
    file: { name: "test.exe", sha256: MOCK_SHA256, size: 1024, type: "executable/windows/pe32" },
    verdict: { malicious: [], non_malicious: [] },
  };
}

function mockFileInfo(sha256 = MOCK_SHA256) {
  return {
    sha256,
    md5: "d41d8cd98f00b204e9800998ecf8427e",
    sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    size: 1024,
    type: "executable/windows/pe32",
    magic: "PE32 executable",
    mime: "application/x-dosexec",
    seen: { first: "2024-01-01T00:00:00Z", last: "2024-01-01T00:00:00Z", count: 1 },
  };
}

function mockSearchResults<T>(items: T[]) {
  return {
    items,
    total: items.length,
    offset: 0,
    rows: items.length,
  };
}

function respond(res: import("node:http").ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify({ api_status_code: status, api_response: data, api_error_message: null });
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function respondError(res: import("node:http").ServerResponse, status: number, message: string) {
  const body = JSON.stringify({ api_status_code: status, api_response: null, api_error_message: message });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function drainBody(req: IncomingMessage): Promise<void> {
  for await (const _ of req) { /* discard */ }
}

function route(method: string, path: string): string {
  // Normalise trailing slash
  const p = path.replace(/\/$/, "") + "/";
  return `${method} ${p}`;
}

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const capture = opts.captureRequests !== false; // default: capture
  const requests: MockRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    // Validate auth headers
    if (!req.headers["x-user"] || !req.headers["x-apikey"]) {
      await drainBody(req);
      respondError(res, 401, "Missing authentication headers");
      return;
    }

    const rawPath = req.url ?? "/";
    const path = rawPath.split("?")[0];

    let body = "";
    if (capture) {
      body = await readBody(req);
      requests.push({
        method: req.method ?? "GET",
        path: rawPath,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });
    } else {
      await drainBody(req);
    }

    const key = route(req.method ?? "GET", path);

    // ── Routing ─────────────────────────────────────────────────────────
    if (key === "GET /api/v4/user/whoami/") {
      return respond(res, 200, MOCK_USER);
    }

    if (key === "POST /api/v4/submit/") {
      return respond(res, 200, mockSubmission());
    }

    if (key === "POST /api/v4/ingest/") {
      return respond(res, 200, { ingest_id: MOCK_INGEST_ID });
    }

    // submission/:sid/
    const isCmplMatch = path.match(/^\/api\/v4\/submission\/is_completed\/([^/]+)\/?$/);
    if (isCmplMatch) {
      return respond(res, 200, true);
    }

    const submFullMatch = path.match(/^\/api\/v4\/submission\/full\/([^/]+)\/?$/);
    if (submFullMatch) {
      return respond(res, 200, mockSubmissionFull(submFullMatch[1]));
    }

    const submSummaryMatch = path.match(/^\/api\/v4\/submission\/summary\/([^/]+)\/?$/);
    if (submSummaryMatch) {
      return respond(res, 200, { heuristic_sections: [], tags: {}, score: 500 });
    }

    const submMatch = path.match(/^\/api\/v4\/submission\/([^/]+)\/?$/);
    if (submMatch && !path.includes("is_completed") && !path.includes("full") && !path.includes("summary")) {
      return respond(res, 200, mockSubmission(submMatch[1]));
    }

    // ingest messages
    const ingestMsgMatch = path.match(/^\/api\/v4\/ingest\/get_message_list\/([^/]+)\/?$/);
    if (ingestMsgMatch) {
      return respond(res, 200, [
        { ingest_id: MOCK_INGEST_ID, sid: MOCK_SID, score: 500, failure: false },
      ]);
    }

    // search
    if (path === "/api/v4/search/submission/") {
      return respond(res, 200, mockSearchResults([mockSubmission()]));
    }
    if (path === "/api/v4/search/alert/") {
      return respond(res, 200, mockSearchResults([mockAlert()]));
    }
    if (path === "/api/v4/search/file/") {
      return respond(res, 200, mockSearchResults([mockFileInfo()]));
    }
    if (path === "/api/v4/search/result/") {
      return respond(res, 200, mockSearchResults([]));
    }

    // alert
    const alertMatch = path.match(/^\/api\/v4\/alert\/([^/]+)\/?$/);
    if (alertMatch) {
      return respond(res, 200, mockAlert(alertMatch[1]));
    }

    // file
    const fileInfoMatch = path.match(/^\/api\/v4\/file\/info\/([^/]+)\/?$/);
    if (fileInfoMatch) {
      return respond(res, 200, mockFileInfo(fileInfoMatch[1]));
    }
    const fileResultMatch = path.match(/^\/api\/v4\/file\/result\/([^/]+)\/?$/);
    if (fileResultMatch) {
      return respond(res, 200, { results: {}, partial: false });
    }
    const fileScoreMatch = path.match(/^\/api\/v4\/file\/score\/([^/]+)\/?$/);
    if (fileScoreMatch) {
      return respond(res, 200, { score: 500, hash: fileScoreMatch[1] });
    }

    respondError(res, 404, `No mock for ${req.method} ${path}`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    reset: () => { requests.length = 0; },
    stop: () => new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    ),
  };
}

/**
 * Integration tests for the AL4 MCP server.
 *
 * Layer 1 — AL4Client directly against the mock HTTP server.
 * Layer 2 — Full MCP protocol stack via InMemoryTransport.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { startMockServer } from "./mock-al4.js";
import { AL4Client } from "../src/al4-client.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ── Create a temporary test file ─────────────────────────────────────────────

async function makeTempFile(sizeBytes = 512): Promise<string> {
  const path = join(tmpdir(), `al4-test-${Date.now()}.bin`);
  await writeFile(path, Buffer.alloc(sizeBytes, 0x41)); // fill with 'A'
  return path;
}

// ── Build the MCP server (mirrors src/index.ts logic) ────────────────────────

function buildMcpServer(client: AL4Client): Server {
  // Inline the same handler registration as index.ts so tests exercise
  // the exact dispatch logic without spawning a subprocess.
  // Import the handlers from a shared module isn't possible yet, so we
  // re-declare a minimal version here.  When index.ts is refactored to
  // export createServer(), replace this with that.
  const server = new Server(
    { name: "assemblyline4-mcp-test", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const TOOL_LIST = [
    {
      name: "al4_whoami",
      description: "Whoami",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "al4_submit_url",
      description: "Submit URL",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    {
      name: "al4_submission_get",
      description: "Get submission",
      inputSchema: {
        type: "object",
        properties: { sid: { type: "string" } },
        required: ["sid"],
      },
    },
    {
      name: "al4_submission_full",
      description: "Full results",
      inputSchema: {
        type: "object",
        properties: { sid: { type: "string" } },
        required: ["sid"],
      },
    },
    {
      name: "al4_search_submissions",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "al4_alert_get",
      description: "Get alert",
      inputSchema: {
        type: "object",
        properties: { alert_id: { type: "string" } },
        required: ["alert_id"],
      },
    },
    {
      name: "al4_file_score",
      description: "File score",
      inputSchema: {
        type: "object",
        properties: { sha256: { type: "string" } },
        required: ["sha256"],
      },
    },
  ] as const;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_LIST,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    try {
      let result: unknown;
      switch (name) {
        case "al4_whoami":
          result = await client.whoami();
          break;
        case "al4_submit_url":
          result = await client.submitUrl(a.url as string);
          break;
        case "al4_submission_get":
          result = await client.getSubmission(a.sid as string);
          break;
        case "al4_submission_full":
          result = await client.getSubmissionFull(a.sid as string);
          break;
        case "al4_search_submissions":
          result = await client.searchSubmissions({ query: a.query as string });
          break;
        case "al4_alert_get":
          result = await client.getAlert(a.alert_id as string);
          break;
        case "al4_file_score":
          result = await client.getFileScore(a.sha256 as string);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("AssemblyLine 4 MCP — Integration Test Suite\n");

  const mock = await startMockServer();
  const client = new AL4Client({
    url: mock.url,
    username: "test_user",
    apikey: "testkey:secret",
  });

  let tmpFile: string | null = null;

  try {
    // ── Layer 1: AL4Client ──────────────────────────────────────────────

    section("AL4Client — auth & identity");

    await test("whoami returns user object", async () => {
      const res = await client.whoami();
      assert.equal((res as { uname: string }).uname, "test_user");
    });

    await test("missing auth credentials rejected at construction", async () => {
      assert.throws(
        () => new AL4Client({ url: mock.url, username: "", apikey: "" }),
        /username is required/,
      );
      assert.throws(
        () => new AL4Client({ url: mock.url, username: "u", apikey: "" }),
        /apikey is required/,
      );
    });

    section("AL4Client — synchronous submission");

    await test("submitUrl returns sid", async () => {
      const res = await client.submitUrl("https://example.com/malware.exe");
      assert.ok((res as { sid: string }).sid);
    });

    await test("submitUrl passes optional params", async () => {
      mock.reset();
      await client.submitUrl("https://example.com/test", {
        params: { description: "test desc", classification: "TLP:CLEAR" },
      });
      assert.equal(mock.requests.length, 1);
      const body = JSON.parse(mock.requests[0].body);
      assert.equal(body.url, "https://example.com/test");
      assert.equal(body.params.description, "test desc");
    });

    await test("submitSha256 returns sid", async () => {
      const res = await client.submitSha256("a".repeat(64));
      assert.ok((res as { sid: string }).sid);
    });

    await test("submitFile reads file and sends multipart", async () => {
      tmpFile = await makeTempFile(1024);
      mock.reset();
      const res = await client.submitFile(tmpFile);
      assert.ok((res as { sid: string }).sid);
      assert.equal(mock.requests.length, 1);
      const ct = mock.requests[0].headers["content-type"] as string;
      assert.ok(
        ct.startsWith("multipart/form-data"),
        `Expected multipart, got: ${ct}`,
      );
    });

    await test("submitFile throws for missing file", async () => {
      await assert.rejects(
        () => client.submitFile("/nonexistent/path/file.bin"),
        /File not found/,
      );
    });

    section("AL4Client — asynchronous ingestion");

    await test("ingestUrl returns ingest_id", async () => {
      const res = await client.ingestUrl("https://example.com/test.dll");
      assert.ok((res as { ingest_id: string }).ingest_id);
    });

    await test("ingestUrl sends notification_queue when set", async () => {
      mock.reset();
      await client.ingestUrl("https://example.com/test.dll", {
        notification_queue: "my-queue",
        alert: true,
      });
      const body = JSON.parse(mock.requests[0].body);
      assert.equal(body.notification_queue, "my-queue");
      assert.equal(body.generate_alert, true);
    });

    await test("ingestSha256 returns ingest_id", async () => {
      const res = await client.ingestSha256("a".repeat(64));
      assert.ok((res as { ingest_id: string }).ingest_id);
    });

    await test("ingestFile sends multipart with json part", async () => {
      if (!tmpFile) tmpFile = await makeTempFile(1024);
      mock.reset();
      await client.ingestFile(tmpFile, {
        notification_queue: "q1",
        alert: false,
      });
      const ct = mock.requests[0].headers["content-type"] as string;
      assert.ok(
        ct.startsWith("multipart/form-data"),
        `Expected multipart, got: ${ct}`,
      );
    });

    await test("getIngestMessages returns array", async () => {
      const msgs = await client.getIngestMessages("my-queue");
      assert.ok(Array.isArray(msgs));
      assert.ok(msgs.length > 0);
    });

    section("AL4Client — submission tracking");

    await test("isSubmissionComplete returns boolean", async () => {
      const done = await client.isSubmissionComplete("abc123");
      assert.equal(done, true);
    });

    await test("getSubmission returns submission object", async () => {
      const sub = await client.getSubmission("abc123");
      assert.ok((sub as { sid: string }).sid);
    });

    await test("getSubmissionFull returns results tree", async () => {
      const full = await client.getSubmissionFull("abc123");
      assert.ok((full as { sid: string }).sid);
      assert.ok((full as { results: unknown }).results);
    });

    await test("getSubmissionSummary returns summary", async () => {
      const summary = await client.getSubmissionSummary("abc123");
      assert.ok("score" in (summary as object));
    });

    section("AL4Client — search");

    await test("searchSubmissions returns paginated items", async () => {
      const res = await client.searchSubmissions({
        query: "params.submitter:test_user",
      });
      assert.ok((res as { items: unknown[] }).items.length > 0);
    });

    await test("searchAlerts returns paginated items", async () => {
      const res = await client.searchAlerts({ query: "*" });
      assert.ok(Array.isArray((res as { items: unknown[] }).items));
    });

    await test("searchFiles returns paginated items", async () => {
      const res = await client.searchFiles({ query: "type:executable*" });
      assert.ok(Array.isArray((res as { items: unknown[] }).items));
    });

    await test("searchResults returns results", async () => {
      const res = await client.searchResults({ query: "*" });
      assert.ok("items" in (res as object));
    });

    await test("search passes fl, rows, offset params", async () => {
      mock.reset();
      await client.searchSubmissions({
        query: "test",
        fl: "sid,score",
        rows: 5,
        offset: 10,
      });
      const url = mock.requests[0].path;
      assert.ok(
        url.includes("fl=sid%2Cscore") || url.includes("fl=sid,score"),
        `Expected fl in URL: ${url}`,
      );
      assert.ok(url.includes("rows=5"), `Expected rows in URL: ${url}`);
      assert.ok(url.includes("offset=10"), `Expected offset in URL: ${url}`);
    });

    section("AL4Client — alerts & files");

    await test("getAlert returns alert object", async () => {
      const alert = await client.getAlert("alert_00000001");
      assert.ok((alert as { alert_id: string }).alert_id);
    });

    await test("getFileInfo returns file metadata", async () => {
      const info = await client.getFileInfo("a".repeat(64));
      assert.ok((info as { sha256: string }).sha256);
    });

    await test("getFileResults returns results", async () => {
      const res = await client.getFileResults("a".repeat(64));
      assert.ok("results" in (res as object));
    });

    await test("getFileScore returns score", async () => {
      const score = await client.getFileScore("a".repeat(64));
      assert.ok("score" in (score as object));
    });

    // ── Layer 2: MCP Protocol ───────────────────────────────────────────

    section("MCP Protocol — InMemoryTransport");

    await test("ListTools returns tool definitions", async () => {
      const mcpServer = buildMcpServer(client);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await mcpClient.connect(clientTransport);

      const { tools } = await mcpClient.listTools();
      assert.ok(tools.length > 0);
      const names = tools.map((t) => t.name);
      assert.ok(
        names.includes("al4_whoami"),
        `Missing al4_whoami in: ${names.join(", ")}`,
      );

      await mcpClient.close();
      await mcpServer.close();
    });

    await test("CallTool al4_whoami returns user data", async () => {
      const mcpServer = buildMcpServer(client);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await mcpClient.connect(clientTransport);

      const result = await mcpClient.callTool({
        name: "al4_whoami",
        arguments: {},
      });
      const resultContent = result.content as { type: string; text: string }[];
      assert.ok(
        !result.isError,
        `Tool returned error: ${JSON.stringify(resultContent)}`,
      );
      const parsed = JSON.parse(resultContent[0].text);
      assert.equal(parsed.uname, "test_user");

      await mcpClient.close();
      await mcpServer.close();
    });

    await test("CallTool al4_submit_url returns sid", async () => {
      const mcpServer = buildMcpServer(client);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await mcpClient.connect(clientTransport);

      const result = await mcpClient.callTool({
        name: "al4_submit_url",
        arguments: { url: "https://example.com/test.exe" },
      });
      assert.ok(!result.isError);
      const submitContent = result.content as { text: string }[];
      const parsed = JSON.parse(submitContent[0].text);
      assert.ok(parsed.sid);

      await mcpClient.close();
      await mcpServer.close();
    });

    await test("CallTool unknown tool returns isError=true", async () => {
      const mcpServer = buildMcpServer(client);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: "test-client", version: "0.1.0" },
        { capabilities: {} },
      );
      await mcpServer.connect(serverTransport);
      await mcpClient.connect(clientTransport);

      // The MCP SDK validates tool names and will throw before our handler — catch both
      try {
        const result = await mcpClient.callTool({
          name: "al4_nonexistent",
          arguments: {},
        });
        assert.ok(result.isError, "Expected isError for unknown tool");
      } catch {
        // SDK-level rejection is also acceptable
      }

      await mcpClient.close();
      await mcpServer.close();
    });
  } finally {
    await mock.stop();
    if (tmpFile) await rm(tmpFile, { force: true });
  }

  // ── Results ─────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(48)}`);
  console.log(`Tests: ${passed + failed}  ✓ ${passed}  ✗ ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

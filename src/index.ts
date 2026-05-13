#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AL4Client, type AL4Config } from "./al4-client.js";

function getConfig(): AL4Config {
  const url = process.env.AL4_URL;
  const username = process.env.AL4_USERNAME;
  const apikey = process.env.AL4_APIKEY;
  if (!url) throw new Error("AL4_URL environment variable is required");
  if (!username) throw new Error("AL4_USERNAME environment variable is required");
  if (!apikey) throw new Error("AL4_APIKEY environment variable is required");
  return {
    url,
    username,
    apikey,
    tlsVerify: process.env.AL4_TLS_VERIFY !== "false",
  };
}

const TOOLS = [
  {
    name: "al4_whoami",
    description: "Return details about the currently authenticated AssemblyLine user.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // ── Submit (synchronous, quota-limited) ────────────────────────────────
  {
    name: "al4_submit_file",
    description:
      "Submit a local file to AssemblyLine for immediate synchronous analysis. Returns a submission ID. Limited to 5 concurrent submissions.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to analyse" },
        name: { type: "string", description: "Override display name for the file" },
        description: { type: "string", description: "Human-readable description of the submission" },
        classification: { type: "string", description: "Classification label (e.g. TLP:CLEAR)" },
        services: {
          type: "array",
          items: { type: "string" },
          description: "Specific services to run (empty = all defaults)",
        },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Key/value metadata attached to the submission",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "al4_submit_url",
    description:
      "Submit a URL to AssemblyLine for immediate synchronous analysis.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to analyse" },
        description: { type: "string" },
        classification: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["url"],
    },
  },
  {
    name: "al4_submit_sha256",
    description:
      "Submit a file by its SHA256 hash to AssemblyLine for immediate synchronous analysis. The file must already exist in the AL4 file store.",
    inputSchema: {
      type: "object",
      properties: {
        sha256: { type: "string", description: "SHA256 hash of the file" },
        description: { type: "string" },
        classification: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["sha256"],
    },
  },
  // ── Ingest (asynchronous, high-volume) ─────────────────────────────────
  {
    name: "al4_ingest_file",
    description:
      "Asynchronously ingest a local file into AssemblyLine. Preferred for high-volume workflows. Returns an ingest ID. Results arrive on a notification queue.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        notification_queue: { type: "string", description: "Queue name for completion notifications" },
        alert: { type: "boolean", description: "Generate an alert if score exceeds threshold" },
        name: { type: "string" },
        description: { type: "string" },
        classification: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["file_path"],
    },
  },
  {
    name: "al4_ingest_url",
    description: "Asynchronously ingest a URL into AssemblyLine.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        notification_queue: { type: "string" },
        alert: { type: "boolean" },
        description: { type: "string" },
        classification: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["url"],
    },
  },
  {
    name: "al4_ingest_sha256",
    description:
      "Asynchronously ingest a file by SHA256 hash into AssemblyLine. The file must already exist in the AL4 file store.",
    inputSchema: {
      type: "object",
      properties: {
        sha256: { type: "string" },
        notification_queue: { type: "string" },
        alert: { type: "boolean" },
        description: { type: "string" },
        classification: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["sha256"],
    },
  },
  // ── Submission tracking ─────────────────────────────────────────────────
  {
    name: "al4_submission_is_complete",
    description: "Check whether a submission has finished processing.",
    inputSchema: {
      type: "object",
      properties: {
        sid: { type: "string", description: "Submission ID" },
      },
      required: ["sid"],
    },
  },
  {
    name: "al4_submission_get",
    description: "Get metadata and status for a submission.",
    inputSchema: {
      type: "object",
      properties: {
        sid: { type: "string" },
      },
      required: ["sid"],
    },
  },
  {
    name: "al4_submission_full",
    description:
      "Get the complete results tree for a finished submission, including all service results and scores.",
    inputSchema: {
      type: "object",
      properties: {
        sid: { type: "string" },
      },
      required: ["sid"],
    },
  },
  {
    name: "al4_submission_summary",
    description: "Get a summarised view of a submission's results.",
    inputSchema: {
      type: "object",
      properties: {
        sid: { type: "string" },
      },
      required: ["sid"],
    },
  },
  {
    name: "al4_ingest_get_messages",
    description:
      "Retrieve completion notifications from an ingest notification queue.",
    inputSchema: {
      type: "object",
      properties: {
        notification_queue: {
          type: "string",
          description: "Queue name passed when ingesting",
        },
        count: {
          type: "number",
          description: "Max messages to retrieve (default 100)",
        },
      },
      required: ["notification_queue"],
    },
  },
  // ── Search ──────────────────────────────────────────────────────────────
  {
    name: "al4_search_submissions",
    description:
      "Search AssemblyLine submissions using Lucene query syntax (e.g. 'params.submitter:admin AND al_score:[500 TO *]').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Lucene query string" },
        fields: { type: "string", description: "Comma-separated fields to return" },
        rows: { type: "number", description: "Number of results (default 25)" },
        offset: { type: "number", description: "Pagination offset" },
        sort: { type: "string", description: "Sort field and direction, e.g. 'times.submitted desc'" },
      },
      required: ["query"],
    },
  },
  {
    name: "al4_search_alerts",
    description: "Search AssemblyLine alerts using Lucene query syntax.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        fields: { type: "string" },
        rows: { type: "number" },
        offset: { type: "number" },
        sort: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "al4_search_files",
    description:
      "Search the AssemblyLine file store using Lucene query syntax (e.g. 'type:executable/windows AND seen.last:[now-7d TO now]').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        fields: { type: "string" },
        rows: { type: "number" },
        offset: { type: "number" },
        sort: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "al4_search_results",
    description: "Search AssemblyLine service results using Lucene query syntax.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        fields: { type: "string" },
        rows: { type: "number" },
        offset: { type: "number" },
        sort: { type: "string" },
      },
      required: ["query"],
    },
  },
  // ── Alerts ──────────────────────────────────────────────────────────────
  {
    name: "al4_alert_get",
    description: "Get a specific alert by its alert ID.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string" },
      },
      required: ["alert_id"],
    },
  },
  // ── File / hash lookups ─────────────────────────────────────────────────
  {
    name: "al4_file_info",
    description: "Get metadata for a file by its SHA256 hash.",
    inputSchema: {
      type: "object",
      properties: {
        sha256: { type: "string" },
      },
      required: ["sha256"],
    },
  },
  {
    name: "al4_file_results",
    description: "Get all service analysis results for a file by SHA256.",
    inputSchema: {
      type: "object",
      properties: {
        sha256: { type: "string" },
      },
      required: ["sha256"],
    },
  },
  {
    name: "al4_file_score",
    description: "Get the highest score assigned to a file across all submissions.",
    inputSchema: {
      type: "object",
      properties: {
        sha256: { type: "string" },
      },
      required: ["sha256"],
    },
  },
] as const;

// ── Input helpers ───────────────────────────────────────────────────────────

function buildSubmitOptions(args: Record<string, unknown>) {
  return {
    name: args.name as string | undefined,
    params: {
      ...(args.description ? { description: args.description as string } : {}),
      ...(args.classification ? { classification: args.classification as string } : {}),
      ...(args.services
        ? { services: { selected: args.services as string[] } }
        : {}),
    },
    metadata: args.metadata as Record<string, string> | undefined,
  };
}

function buildIngestOptions(args: Record<string, unknown>) {
  return {
    ...buildSubmitOptions(args),
    notification_queue: args.notification_queue as string | undefined,
    alert: args.alert as boolean | undefined,
  };
}

function buildSearchOptions(args: Record<string, unknown>) {
  return {
    query: args.query as string,
    fl: args.fields as string | undefined,
    rows: args.rows as number | undefined,
    offset: args.offset as number | undefined,
    sort: args.sort as string | undefined,
  };
}

// ── Server bootstrap ────────────────────────────────────────────────────────

async function main() {
  const config = getConfig();

  // Disable TLS verification at the process level when configured
  if (config.tlsVerify === false) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const client = new AL4Client(config);

  const server = new Server(
    { name: "assemblyline4-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case "al4_whoami":
          result = await client.whoami();
          break;

        case "al4_submit_file":
          result = await client.submitFile(a.file_path as string, buildSubmitOptions(a));
          break;
        case "al4_submit_url":
          result = await client.submitUrl(a.url as string, buildSubmitOptions(a));
          break;
        case "al4_submit_sha256":
          result = await client.submitSha256(a.sha256 as string, buildSubmitOptions(a));
          break;

        case "al4_ingest_file":
          result = await client.ingestFile(a.file_path as string, buildIngestOptions(a));
          break;
        case "al4_ingest_url":
          result = await client.ingestUrl(a.url as string, buildIngestOptions(a));
          break;
        case "al4_ingest_sha256":
          result = await client.ingestSha256(a.sha256 as string, buildIngestOptions(a));
          break;

        case "al4_submission_is_complete":
          result = await client.isSubmissionComplete(a.sid as string);
          break;
        case "al4_submission_get":
          result = await client.getSubmission(a.sid as string);
          break;
        case "al4_submission_full":
          result = await client.getSubmissionFull(a.sid as string);
          break;
        case "al4_submission_summary":
          result = await client.getSubmissionSummary(a.sid as string);
          break;

        case "al4_ingest_get_messages":
          result = await client.getIngestMessages(
            a.notification_queue as string,
            (a.count as number) ?? 100
          );
          break;

        case "al4_search_submissions":
          result = await client.searchSubmissions(buildSearchOptions(a));
          break;
        case "al4_search_alerts":
          result = await client.searchAlerts(buildSearchOptions(a));
          break;
        case "al4_search_files":
          result = await client.searchFiles(buildSearchOptions(a));
          break;
        case "al4_search_results":
          result = await client.searchResults(buildSearchOptions(a));
          break;

        case "al4_alert_get":
          result = await client.getAlert(a.alert_id as string);
          break;

        case "al4_file_info":
          result = await client.getFileInfo(a.sha256 as string);
          break;
        case "al4_file_results":
          result = await client.getFileResults(a.sha256 as string);
          break;
        case "al4_file_score":
          result = await client.getFileScore(a.sha256 as string);
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

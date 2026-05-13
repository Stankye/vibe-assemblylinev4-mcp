/**
 * End-to-end test: drives AL4Client against a real Assemblyline 4 backend.
 *
 * Expected env vars (set by .github/workflows/e2e.yml):
 *   AL4_URL        e.g. https://localhost
 *   AL4_USERNAME   e.g. admin
 *   AL4_APIKEY     e.g. cikey:randomsecret
 *   AL4_TLS_VERIFY optional, "false" to skip TLS verification
 *
 * The CI appliance is started without registering any services, so submissions
 * complete almost immediately with an empty result tree.  That is enough to
 * validate the request/response plumbing for every API the MCP server exposes.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { AL4Client } from "../src/al4-client.js";

const URL_ = process.env.AL4_URL;
const USER = process.env.AL4_USERNAME;
const KEY = process.env.AL4_APIKEY;

if (!URL_ || !USER || !KEY) {
  console.error(
    "AL4_URL, AL4_USERNAME and AL4_APIKEY must be set in the environment",
  );
  process.exit(2);
}
if (process.env.AL4_TLS_VERIFY === "false") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const client = new AL4Client({
  url: URL_,
  username: USER,
  apikey: KEY,
  timeoutMs: 60_000,
  maxRetries: 5,
  retryBaseMs: 500,
  retryMaxMs: 8_000,
});

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  • ${name} … `);
  try {
    await fn();
    console.log("ok");
    passed++;
  } catch (err) {
    console.log("FAIL");
    console.error(`    ${(err as Error).stack ?? (err as Error).message}`);
    failed++;
  }
}

function section(label: string) {
  console.log(`\n── ${label} ──`);
}

async function main() {
  console.log(`AssemblyLine 4 MCP — E2E suite against ${URL_}`);

  section("Identity");
  await step("whoami returns the configured user", async () => {
    const who = (await client.whoami()) as {
      username?: string;
      uname?: string;
      type?: string[];
    };
    // AL4 v4 returns `username`; older docs sometimes show `uname` — accept either.
    assert.equal(who.username ?? who.uname, USER);
    if (who.type) assert.ok(who.type.length > 0, "user has at least one type");
  });

  section("Submission lifecycle (file)");
  const tmpPath = join(tmpdir(), `al4-e2e-${Date.now()}.txt`);
  await writeFile(
    tmpPath,
    `assemblyline4-mcp CI smoke @ ${new Date().toISOString()}\n`,
  );
  let sid: string | undefined;

  try {
    await step("submitFile returns a sid", async () => {
      const res = (await client.submitFile(tmpPath, {
        params: { description: "CI smoke test", classification: "TLP:CLEAR" },
      })) as { sid: string };
      assert.ok(res.sid, "response must contain sid");
      sid = res.sid;
    });

    await step("getSubmission echoes the sid", async () => {
      assert.ok(sid);
      const sub = (await client.getSubmission(sid)) as { sid: string };
      assert.equal(sub.sid, sid);
    });

    await step(
      "isSubmissionComplete eventually returns true (≤ 5 min)",
      async () => {
        assert.ok(sid);
        const deadline = Date.now() + 5 * 60_000;
        let done = false;
        while (Date.now() < deadline) {
          done = await client.isSubmissionComplete(sid);
          if (done) break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
        assert.equal(
          done,
          true,
          "submission did not complete within the timeout",
        );
      },
    );

    await step("getSubmissionSummary returns an object", async () => {
      assert.ok(sid);
      const summary = await client.getSubmissionSummary(sid);
      assert.equal(typeof summary, "object");
      assert.notEqual(summary, null);
    });

    await step("getSubmissionFull returns an object", async () => {
      assert.ok(sid);
      const full = await client.getSubmissionFull(sid);
      assert.equal(typeof full, "object");
      assert.notEqual(full, null);
    });
  } finally {
    await rm(tmpPath, { force: true });
  }

  section("Submission lifecycle (sha256 / URL)");
  await step("submitUrl returns a sid", async () => {
    const res = (await client.submitUrl("https://example.com/", {
      params: { description: "CI smoke (URL)" },
    })) as { sid: string };
    assert.ok(res.sid);
  });

  await step("submitSha256 rejects invalid hash", async () => {
    // Client validates synchronously, so wrap the call so assert.rejects sees
    // the synchronous throw as a rejection.
    await assert.rejects(
      async () => client.submitSha256("not-a-hash"),
      /Invalid sha256/,
    );
  });

  section("Search");
  await step("searchSubmissions returns an items array", async () => {
    const r = (await client.searchSubmissions({
      query: "*:*",
      rows: 5,
    })) as { items?: unknown[] };
    assert.ok(Array.isArray(r.items), "search response must contain items[]");
  });

  await step("searchAlerts returns an items array", async () => {
    const r = (await client.searchAlerts({
      query: "*:*",
      rows: 5,
    })) as { items?: unknown[] };
    assert.ok(Array.isArray(r.items));
  });

  await step("searchFiles returns an items array", async () => {
    const r = (await client.searchFiles({
      query: "*:*",
      rows: 5,
    })) as { items?: unknown[] };
    assert.ok(Array.isArray(r.items));
  });

  section("Negative / auth");
  await step("bad apikey is rejected", async () => {
    const bad = new AL4Client({
      url: URL_!,
      username: USER!,
      apikey: "wrong:wrong",
      timeoutMs: 15_000,
      maxRetries: 0,
    });
    await assert.rejects(() => bad.whoami(), /401|403|failed|Invalid/i);
  });

  console.log(`\nE2E: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

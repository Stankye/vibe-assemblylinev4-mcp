/**
 * Performance benchmarks for the AL4 MCP server.
 *
 * Measures: latency per operation, file-upload throughput (small/large),
 * concurrent submission throughput, and memory usage for large uploads.
 *
 * Run: npm run bench
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMockServer } from "./mock-al4.js";
import { AL4Client } from "../src/al4-client.js";
// ── Stats helper ─────────────────────────────────────────────────────────────
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}
function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    return {
        mean: mean.toFixed(2),
        p50: percentile(sorted, 50).toFixed(2),
        p95: percentile(sorted, 95).toFixed(2),
        p99: percentile(sorted, 99).toFixed(2),
        min: sorted[0].toFixed(2),
        max: sorted[sorted.length - 1].toFixed(2),
    };
}
async function measure(fn, n) {
    // Warm up
    await fn();
    await fn();
    const samples = [];
    for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        await fn();
        samples.push(performance.now() - t0);
    }
    return samples;
}
function printStats(label, samples, unit = "ms") {
    const s = stats(samples);
    console.log(`  ${label.padEnd(36)} mean=${s.mean}${unit}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  min=${s.min}  max=${s.max}`);
}
function memMB() {
    return process.memoryUsage().heapUsed / 1024 / 1024;
}
// ── Temp files ───────────────────────────────────────────────────────────────
async function makeTempFile(sizeBytes) {
    const path = join(tmpdir(), `al4-bench-${sizeBytes}-${Date.now()}.bin`);
    // Write in chunks to avoid OOM on large allocations
    const CHUNK = 1024 * 1024; // 1 MB
    const fd = await import("node:fs/promises").then((m) => m.open(path, "w"));
    const chunk = Buffer.alloc(Math.min(CHUNK, sizeBytes), 0xAA);
    let written = 0;
    while (written < sizeBytes) {
        const toWrite = Math.min(CHUNK, sizeBytes - written);
        await fd.write(chunk.subarray(0, toWrite));
        written += toWrite;
    }
    await fd.close();
    return path;
}
// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("AssemblyLine 4 MCP — Performance Benchmarks\n");
    const mock = await startMockServer();
    const client = new AL4Client({
        url: mock.url,
        username: "bench_user",
        apikey: "benchkey:secret",
    });
    // Create test files
    const file1KB = await makeTempFile(1 * 1024);
    const file1MB = await makeTempFile(1 * 1024 * 1024);
    const file10MB = await makeTempFile(10 * 1024 * 1024);
    const file50MB = await makeTempFile(50 * 1024 * 1024);
    const N_FAST = 200; // for lightweight ops
    const N_FILE = 20; // for file uploads (IO-bound)
    try {
        // ── 1. Lightweight API calls ────────────────────────────────────────
        console.log("── Lightweight API operations (n=%d) ──────────────────", N_FAST);
        printStats("whoami", await measure(() => client.whoami(), N_FAST));
        printStats("submitUrl", await measure(() => client.submitUrl("https://example.com/test.exe"), N_FAST));
        printStats("getSubmission", await measure(() => client.getSubmission("abc123"), N_FAST));
        printStats("getSubmissionFull", await measure(() => client.getSubmissionFull("abc123"), N_FAST));
        printStats("isSubmissionComplete", await measure(() => client.isSubmissionComplete("abc123"), N_FAST));
        printStats("searchSubmissions", await measure(() => client.searchSubmissions({ query: "*", rows: 25 }), N_FAST));
        printStats("searchAlerts", await measure(() => client.searchAlerts({ query: "*" }), N_FAST));
        printStats("getAlert", await measure(() => client.getAlert("alert_00000001"), N_FAST));
        printStats("getFileScore", await measure(() => client.getFileScore("a".repeat(64)), N_FAST));
        // ── 2. File upload latency & memory impact ──────────────────────────
        console.log("\n── File upload — submitFile (Blob, n=%d) ──────────────", N_FILE);
        for (const [label, path] of [
            ["1 KB", file1KB],
            ["1 MB", file1MB],
            ["10 MB", file10MB],
            ["50 MB", file50MB],
        ]) {
            const fileSize = (await stat(path)).size;
            const heapBefore = memMB();
            const samples = await measure(() => client.submitFile(path), N_FILE);
            const heapPeak = memMB();
            const heapDelta = (heapPeak - heapBefore).toFixed(1);
            const throughput = (fileSize / 1024 / 1024 / (parseFloat(stats(samples).p50) / 1000)).toFixed(0);
            printStats(`submitFile ${label.padEnd(6)} Δheap=${heapDelta}MB ${throughput}MB/s`, samples);
        }
        // ── 3. Ingest (async) upload ────────────────────────────────────────
        console.log("\n── File upload — ingestFile (Blob, n=%d) ──────────────", N_FILE);
        for (const [label, path] of [
            ["1 KB", file1KB],
            ["1 MB", file1MB],
            ["10 MB", file10MB],
        ]) {
            const samples = await measure(() => client.ingestFile(path, { notification_queue: "bench-q" }), N_FILE);
            printStats(`ingestFile ${label}`, samples);
        }
        // ── 4. Concurrent submission throughput ─────────────────────────────
        console.log("\n── Concurrency — parallel submits ──────────────────────");
        for (const concurrency of [1, 5, 10, 20]) {
            const TOTAL = 100;
            const t0 = performance.now();
            for (let i = 0; i < TOTAL; i += concurrency) {
                const batch = Array.from({ length: Math.min(concurrency, TOTAL - i) }, () => client.submitUrl("https://example.com/test.exe"));
                await Promise.all(batch);
            }
            const elapsed = performance.now() - t0;
            const rps = (TOTAL / (elapsed / 1000)).toFixed(0);
            console.log(`  concurrency=${String(concurrency).padStart(2)}  ${TOTAL} requests in ${elapsed.toFixed(0)}ms  →  ${rps} req/s`);
        }
        // ── 5. MCP protocol overhead ────────────────────────────────────────
        console.log("\n── MCP protocol overhead ───────────────────────────────");
        const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
        const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
        const { CallToolRequestSchema, ListToolsRequestSchema, } = await import("@modelcontextprotocol/sdk/types.js");
        const mcpServer = new Server({ name: "al4-bench", version: "0.1.0" }, { capabilities: { tools: {} } });
        const TOOL = [{ name: "al4_whoami", description: "Whoami", inputSchema: { type: "object", properties: {} } }];
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL }));
        mcpServer.setRequestHandler(CallToolRequestSchema, async () => {
            const res = await client.whoami();
            return { content: [{ type: "text", text: JSON.stringify(res) }] };
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const mcpClient = new McpClient({ name: "bench-client", version: "0.1.0" }, { capabilities: {} });
        await mcpServer.connect(st);
        await mcpClient.connect(ct);
        // Direct AL4 call vs through MCP protocol
        const directSamples = await measure(() => client.whoami(), N_FAST);
        const mcpSamples = await measure(() => mcpClient.callTool({ name: "al4_whoami", arguments: {} }), N_FAST);
        printStats("whoami  direct AL4Client", directSamples);
        printStats("whoami  via MCP protocol", mcpSamples);
        const overhead = (parseFloat(stats(mcpSamples).mean) - parseFloat(stats(directSamples).mean)).toFixed(2);
        console.log(`  MCP serialization overhead: ~${overhead}ms`);
        await mcpClient.close();
        await mcpServer.close();
    }
    finally {
        await mock.stop();
        for (const f of [file1KB, file1MB, file10MB, file50MB]) {
            await rm(f, { force: true });
        }
    }
    console.log("\nBenchmarks complete.");
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=bench.js.map
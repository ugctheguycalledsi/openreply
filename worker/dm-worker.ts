import { createDMWorker } from "@/lib/queue/dm-worker";
import {
  getWorkerHealth,
  recordWorkerHeartbeat,
  type WorkerHealth,
} from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import http from "node:http";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEALTH_READ_TIMEOUT_MS = 1_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

// Render's free plan only runs web services, which must bind to PORT.
// Unset PORT (local `npm run worker`, Railway, a VM) leaves this off.
const healthServer = process.env.PORT
  ? startHealthServer(process.env.PORT)
  : null;

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  if (healthServer) {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  }
  await worker.close();
  process.exit(0);
}

function startHealthServer(port: string) {
  const server = http.createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    if (req.method !== "GET" || (path !== "/" && path !== "/healthz")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    void respondWithHealth(res);
  });

  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Health server failed:", message);
    process.exit(1);
  });

  server.listen(Number(port), "0.0.0.0", () => {
    console.log(`[DM Worker] Health server listening on :${port}`);
  });

  return server;
}

async function respondWithHealth(res: http.ServerResponse) {
  const workerHealth = await readWorkerHealth();
  if (res.writableEnded) return;

  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, worker: workerHealth }));
}

async function readWorkerHealth(): Promise<WorkerHealth> {
  try {
    return await withTimeout(getWorkerHealth(), HEALTH_READ_TIMEOUT_MS);
  } catch {
    return { healthy: false, heartbeat: null, ageMs: null };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

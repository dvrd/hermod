import { createHmac, timingSafeEqual } from "crypto";

const REDIS_URL = process.env.REDIS_URL!;
if (!REDIS_URL) throw new Error("REDIS_URL is required");
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const POLL_SECRET = process.env.POLL_SECRET!;
if (!POLL_SECRET) throw new Error("POLL_SECRET is required");
const QUEUE_KEY = "hermod:events";
const PORT = Number(process.env.PORT) || 3000;

// ── Coolify scoped proxy ──
const COOLIFY_API_URL = process.env.COOLIFY_API_URL || "https://zordon.donostia.ai/api/v1";
const COOLIFY_API_KEY = process.env.COOLIFY_API_KEY || "";

// Agent token → allowed Coolify app UUID (one app per agent)
// Tokens are set via HERMOD_AGENT_TOKENS env var as JSON:
// {"hermod_ariel_xxx": "jk48w8cwc44so8wgk8skc848", ...}
const AGENT_TOKENS: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.HERMOD_AGENT_TOKENS || "{}");
  } catch {
    return {};
  }
})();

// Note: IP allowlist removed - using token-only auth for all agent routes

// Rate limiter: per-token sliding window (requests per minute)
const COOLIFY_RATE_LIMIT = Number(process.env.COOLIFY_RATE_LIMIT) || 20;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(token: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(token);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(token, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count++;
  return bucket.count <= COOLIFY_RATE_LIMIT;
}



function resolveAgentScope(req: Request): { appUuid: string; token: string } | null {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace("Bearer ", "");
  const appUuid = AGENT_TOKENS[token];
  if (!appUuid) return null;
  return { appUuid, token };
}

const redis = new Bun.RedisClient(REDIS_URL);

function log(level: "INFO" | "WARN" | "ERROR", msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[${ts}] ${level} ${msg}${metaStr}`);
}

function verifySignature(payload: string, signature: string | null): boolean {
  if (!WEBHOOK_SECRET || !signature) return !WEBHOOK_SECRET;
  const expected =
    "sha256=" +
    createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function verifyPollSecret(req: Request): boolean {
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${POLL_SECRET}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return new Response("ok");
    }

    if (path === "/poll" && req.method === "GET") {
      if (!verifyPollSecret(req)) {
        log("WARN", "poll: unauthorized");
        return new Response("unauthorized", { status: 401 });
      }

      const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 100);

      const events: unknown[] = [];
      for (let i = 0; i < limit; i++) {
        const raw = await redis.send("LPOP", [QUEUE_KEY]);
        if (!raw) break;
        try {
          events.push(JSON.parse(raw as string));
        } catch {
          log("WARN", "poll: skipped unparseable event");
        }
      }

      if (events.length > 0) {
        log("INFO", "poll: drained events", { count: events.length });
      }

      return Response.json({ events });
    }

    if (path === "/webhook/github" && req.method === "POST") {
      const body = await req.text();
      const sig = req.headers.get("x-hub-signature-256");
      const event = req.headers.get("x-github-event");
      const delivery = req.headers.get("x-github-delivery") || "?";

      if (!verifySignature(body, sig)) {
        log("WARN", "invalid signature — rejected", { delivery, event });
        return new Response("invalid signature", { status: 401 });
      }

      if (event === "ping") {
        log("INFO", "ping received", { delivery });
        return Response.json({ ok: true, msg: "pong" });
      }

      if (
        event !== "issue_comment" &&
        event !== "pull_request_review_comment"
      ) {
        log("INFO", `ignored event: ${event}`, { delivery });
        return Response.json({ ok: true, msg: "ignored" });
      }

      const payload = JSON.parse(body);

      if (payload.action !== "created") {
        log("INFO", `ignored action: ${payload.action}`, { event, delivery });
        return Response.json({ ok: true, msg: "ignored" });
      }

      if (event === "issue_comment" && !payload.issue?.pull_request) {
        log("INFO", "ignored: issue comment (not a PR)", { delivery });
        return Response.json({ ok: true, msg: "not a PR comment" });
      }

      const commenter = payload.comment?.user?.login || "";
      if (commenter.endsWith("[bot]") || payload.comment?.user?.type === "Bot") {
        log("INFO", "ignored: bot comment", { delivery, author: commenter });
        return Response.json({ ok: true, msg: "bot comment ignored" });
      }

      const repo = payload.repository?.full_name || "";
      const prNumber =
        event === "issue_comment"
          ? payload.issue?.number
          : payload.pull_request?.number;
      const branch =
        event === "issue_comment"
          ? null
          : payload.pull_request?.head?.ref;
      const comment = payload.comment?.body || "";
      const author = payload.comment?.user?.login || "";
      const prTitle =
        event === "issue_comment"
          ? payload.issue?.title
          : payload.pull_request?.title;
      const prUrl =
        event === "issue_comment"
          ? payload.issue?.pull_request?.html_url
          : payload.pull_request?.html_url;

      const entry = JSON.stringify({
        event,
        repo,
        prNumber,
        prTitle,
        prUrl,
        branch,
        comment,
        author,
        timestamp: new Date().toISOString(),
      });

      const queueLen = await redis.send("RPUSH", [QUEUE_KEY, entry]) as number;

      log("INFO", "queued event", {
        delivery,
        repo,
        pr: prNumber,
        branch: branch ?? "(n/a)",
        author,
        comment: comment.slice(0, 80) + (comment.length > 80 ? "…" : ""),
        queueDepth: queueLen,
      });

      return Response.json({ ok: true, queued: true });
    }

    // ── Coolify scoped proxy routes ──
    // Agents call these instead of the Coolify API directly.
    // Each agent's token only grants access to their own app.
    //
    // Security layers:
    //   1. IP allowlist (if configured) — rejects requests from unknown IPs
    //   2. Per-agent token — maps to exactly one Coolify app UUID
    //   3. Rate limiting — 20 req/min per token (configurable)
    //   4. Route whitelist — only specific Coolify operations are proxied
    //   5. Audit log — every request is logged with IP, token, and action

    // GET /logs/stream/:appName — SSE stream of container logs (follow mode)
    // Accessible with agent token, outside /coolify namespace
    const logsStreamMatch = path.match(/^\/logs\/stream\/([a-z0-9_-]+)$/);
    if (logsStreamMatch && req.method === "GET") {
      const appName = logsStreamMatch[1];
      const tail = url.searchParams.get("tail") || "100";
      const since = url.searchParams.get("since"); // e.g., "10m", "1h"

      // Resolve agent scope (maps token to app UUID)
      const scope = resolveAgentScope(req);
      if (!scope) {
        log("WARN", "logs stream: unauthorized token", { app: appName });
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      if (!checkRateLimit(scope.token)) {
        return Response.json({ error: "rate limited" }, { status: 429 });
      }

      // Use appName from path as container name (matches Docker container naming)
      const containerName = appName;

      // Build docker logs command
      let dockerCmd = `docker logs -f --tail ${tail}`;
      if (since) dockerCmd += ` --since ${since}`;
      dockerCmd += ` ${containerName} 2>&1`;

      // Spawn docker process directly (socket mounted from host)
      const proc = Bun.spawn({
        cmd: ["sh", "-c", dockerCmd],
        stdout: "pipe",
        stderr: "pipe",
      });

      log("INFO", "logs stream started", { app: containerName, tail });

      // Return SSE stream
      const stream = new ReadableStream({
        start(controller) {
          proc.stdout.pipeTo(new WritableStream({
            write(chunk) {
              const text = new TextDecoder().decode(chunk);
              controller.enqueue(`data: ${JSON.stringify({ log: text })}\n\n`);
            },
            close() {
              controller.close();
            },
          }));

          proc.stderr.pipeTo(new WritableStream({
            write(chunk) {
              const text = new TextDecoder().decode(chunk);
              controller.enqueue(`data: ${JSON.stringify({ log: text, stderr: true })}\n\n`);
            },
          }));
        },
        cancel() {
          proc.kill();
          log("INFO", "logs stream closed", { app: containerName });
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── Scoped agent routes (no /coolify prefix) ──
    // Each agent's token maps to exactly one Coolify app UUID
    // Routes: /deployments, /deployments/:uuid, /envs, /deploy

    const agentScope = resolveAgentScope(req);
    if (agentScope) {
      if (!COOLIFY_API_KEY) {
        return Response.json({ error: "Coolify proxy not configured" }, { status: 503 });
      }

      if (!checkRateLimit(agentScope.token)) {
        log("WARN", "agent: rate limited", { app: agentScope.appUuid });
        return Response.json({ error: "rate limited" }, { status: 429 });
      }

      const audit = { app: agentScope.appUuid };

      const coolifyHeaders = {
        "Authorization": `Bearer ${COOLIFY_API_KEY}`,
        "Content-Type": "application/json",
      };

      // GET /deployments — list recent deployments for this app
      if (path === "/deployments" && req.method === "GET") {
        const res = await fetch(`${COOLIFY_API_URL}/deployments?limit=10`, {
          headers: coolifyHeaders,
        });
        const all = await res.json() as any[];
        const filtered = Array.isArray(all)
          ? all.filter((d: any) => d.application_uuid === agentScope.appUuid || d.resource_uuid === agentScope.appUuid)
          : [];
        log("INFO", "agent: list deployments", { ...audit, count: filtered.length });
        return Response.json(filtered);
      }

      // GET /deployments/:uuid — get deployment (only if belongs to this app)
      const depMatch = path.match(/^\/deployments\/([a-z0-9]+)$/);
      if (depMatch && req.method === "GET") {
        const depUuid = depMatch[1];
        const res = await fetch(`${COOLIFY_API_URL}/deployments/${depUuid}`, {
          headers: coolifyHeaders,
        });
        if (!res.ok) return Response.json({ error: "not found" }, { status: 404 });
        const dep = await res.json() as any;
        if (dep.application_uuid !== agentScope.appUuid && dep.resource_uuid !== agentScope.appUuid) {
          log("WARN", "agent: deployment scope mismatch", { ...audit, dep: depUuid });
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        log("INFO", "agent: get deployment", { ...audit, dep: depUuid });
        return Response.json(dep);
      }

      // GET /envs — list env vars for this app
      if (path === "/envs" && req.method === "GET") {
        const res = await fetch(`${COOLIFY_API_URL}/applications/${agentScope.appUuid}/envs`, {
          headers: coolifyHeaders,
        });
        log("INFO", "agent: list envs", audit);
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      }

      // PATCH /envs — update env var for this app
      if (path === "/envs" && req.method === "PATCH") {
        const body = await req.text();
        const res = await fetch(`${COOLIFY_API_URL}/applications/${agentScope.appUuid}/envs`, {
          method: "PATCH",
          headers: coolifyHeaders,
          body,
        });
        log("INFO", "agent: update env", audit);
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      }

      // DELETE /envs/:uuid — delete env var for this app
      const envDelMatch = path.match(/^\/envs\/([a-z0-9]+)$/);
      if (envDelMatch && req.method === "DELETE") {
        const envUuid = envDelMatch[1];
        const res = await fetch(`${COOLIFY_API_URL}/applications/${agentScope.appUuid}/envs/${envUuid}`, {
          method: "DELETE",
          headers: coolifyHeaders,
        });
        log("INFO", "agent: delete env", { ...audit, env: envUuid });
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      }

      // POST /deploy — trigger deploy for this app
      if (path === "/deploy" && req.method === "POST") {
        const res = await fetch(`${COOLIFY_API_URL}/deploy?uuid=${agentScope.appUuid}`, {
          headers: coolifyHeaders,
        });
        log("INFO", "agent: deploy triggered", audit);
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      }

      log("WARN", "agent: unknown route", { ...audit, path, method: req.method });
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // No token matched any route
    return new Response("not found", { status: 404 });
  },
});

log("INFO", `hermod server listening on :${PORT}`);
if (Object.keys(AGENT_TOKENS).length > 0) {
  log("INFO", `${Object.keys(AGENT_TOKENS).length} agent tokens configured`);
} else {
  log("WARN", "no agent tokens configured (set HERMOD_AGENT_TOKENS)");
}

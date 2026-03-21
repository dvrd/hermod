import { createHmac, timingSafeEqual } from "crypto";

const REDIS_URL = process.env.REDIS_URL!;
if (!REDIS_URL) throw new Error("REDIS_URL is required");
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const QUEUE_KEY = "hermod:events";
const PORT = Number(process.env.PORT) || 3000;

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

Bun.serve({
  port: PORT,
  routes: {
    "/health": new Response("ok"),

    "/webhook/github": {
      POST: async (req) => {
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
      },
    },
  },

  fetch() {
    return new Response("not found", { status: 404 });
  },
});

log("INFO", `hermod server listening on :${PORT}`);

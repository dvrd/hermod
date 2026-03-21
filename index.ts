import { createHmac, timingSafeEqual } from "crypto";

const REDIS_URL = process.env.REDIS_URL!;
if (!REDIS_URL) throw new Error("REDIS_URL is required");
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const QUEUE_KEY = "hermod:events";
const PORT = Number(process.env.PORT) || 3000;

const redis = new Bun.RedisClient(REDIS_URL);

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

        if (!verifySignature(body, sig)) {
          return new Response("invalid signature", { status: 401 });
        }

        const event = req.headers.get("x-github-event");
        if (event === "ping") {
          return Response.json({ ok: true, msg: "pong" });
        }

        if (
          event !== "issue_comment" &&
          event !== "pull_request_review_comment"
        ) {
          return Response.json({ ok: true, msg: "ignored" });
        }

        const payload = JSON.parse(body);

        if (payload.action !== "created") {
          return Response.json({ ok: true, msg: "ignored" });
        }

        // For issue_comment, only process if it's on a PR
        if (event === "issue_comment" && !payload.issue?.pull_request) {
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

        await redis.send("RPUSH", [QUEUE_KEY, entry]);
        console.log(`queued: ${repo}#${prNumber} by ${author}`);

        return Response.json({ ok: true, queued: true });
      },
    },
  },

  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`hermod listening on :${PORT}`);

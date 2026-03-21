/**
 * Hermod Poller — runs locally, consumes Redis queue, triggers Paperclip heartbeats.
 *
 * Usage: bun run poller.ts
 * Env: REDIS_URL, PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID
 */

const REDIS_URL = process.env.REDIS_URL!;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL!;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID!;
const CEO_AGENT_ID = process.env.PAPERCLIP_CEO_AGENT_ID!;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 30_000;
const QUEUE_KEY = "hermod:events";

for (const v of ["REDIS_URL", "PAPERCLIP_API_URL", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_CEO_AGENT_ID"]) {
  if (!process.env[v]) throw new Error(`${v} is required`);
}

// Repo → Paperclip agent ID mapping
// Format: REPO_AGENT_MAP=dvrd/onlead:agent-id-1,dvrd/ariel:agent-id-2,...
const REPO_AGENT_MAP: Record<string, string> = Object.fromEntries(
  (process.env.REPO_AGENT_MAP || "").split(",").filter(Boolean).map((s) => {
    const [repo, id] = s.split(":");
    return [repo.trim(), id.trim()];
  })
);

interface QueueEvent {
  event: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  branch: string | null;
  comment: string;
  author: string;
  timestamp: string;
}

async function getPaperclipApiKey(agentId: string): Promise<string | null> {
  // Use the CEO key to create a comment on the issue, then trigger heartbeat
  // For triggering heartbeats we need agent-specific keys
  // We'll use the CLI to get them
  const proc = Bun.spawn(
    [
      "npx",
      "paperclipai",
      "agent",
      "local-cli",
      agentId,
      "--company-id",
      COMPANY_ID,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(proc.stdout).text();
  const match = output.match(/PAPERCLIP_API_KEY='([^']+)'/);
  return match ? match[1] : null;
}

function extractDonIdentifier(branch: string | null, title: string): string | null {
  // Try branch first: feat/DON-64, fix/onlead-61, etc.
  if (branch) {
    const donMatch = branch.match(/DON-(\d+)/i);
    if (donMatch) return `DON-${donMatch[1]}`;
  }
  // Try title
  const titleMatch = title?.match(/DON-(\d+)/i);
  if (titleMatch) return `DON-${titleMatch[1]}`;
  return null;
}

async function findIssueByIdentifier(
  identifier: string,
  ceoKey: string
): Promise<{ id: string; assigneeAgentId: string | null } | null> {
  const res = await fetch(
    `${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/issues?q=${identifier}`,
    { headers: { Authorization: `Bearer ${ceoKey}` } }
  );
  const issues = (await res.json()) as any[];
  const match = issues.find((i: any) => i.identifier === identifier);
  return match
    ? { id: match.id, assigneeAgentId: match.assigneeAgentId }
    : null;
}

async function postComment(
  issueId: string,
  body: string,
  ceoKey: string
): Promise<void> {
  await fetch(`${PAPERCLIP_API_URL}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ceoKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

async function triggerHeartbeat(agentId: string): Promise<void> {
  const apiKey = await getPaperclipApiKey(agentId);
  if (!apiKey) {
    console.error(`  could not get API key for agent ${agentId}`);
    return;
  }
  const proc = Bun.spawn(
    ["npx", "paperclipai", "heartbeat", "run", "--agent-id", agentId],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PAPERCLIP_API_URL,
        PAPERCLIP_COMPANY_ID: COMPANY_ID,
        PAPERCLIP_AGENT_ID: agentId,
        PAPERCLIP_API_KEY: apiKey,
      },
    }
  );
  // Don't await — let heartbeat run in background
  proc.exited.then((code) => {
    console.log(`  heartbeat for ${agentId} exited: ${code}`);
  });
}

async function processEvent(
  event: QueueEvent,
  ceoKey: string
): Promise<void> {
  console.log(
    `processing: ${event.repo}#${event.prNumber} by ${event.author}`
  );

  const agentId = REPO_AGENT_MAP[event.repo];
  if (!agentId) {
    console.log(`  no agent mapped for repo ${event.repo}, skipping`);
    return;
  }

  // Try to find the DON issue
  const identifier = extractDonIdentifier(event.branch, event.prTitle);

  if (identifier) {
    const issue = await findIssueByIdentifier(identifier, ceoKey);
    if (issue) {
      const commentBody = `## PR Comment from @${event.author}\n\n> ${event.comment.split("\n").join("\n> ")}\n\n**PR:** [${event.prTitle}](${event.prUrl}) (#${event.prNumber})`;
      await postComment(issue.id, commentBody, ceoKey);
      console.log(`  posted comment to ${identifier}`);
    } else {
      console.log(`  issue ${identifier} not found in Paperclip`);
    }
  } else {
    console.log(`  no DON identifier found in branch/title`);
  }

  // Trigger heartbeat for the lead
  console.log(`  triggering heartbeat for ${event.repo} lead`);
  await triggerHeartbeat(agentId);
}

async function poll(redis: any, ceoKey: string): Promise<void> {
  while (true) {
    const raw = await redis.send("LPOP", [QUEUE_KEY]);
    if (!raw) break;

    try {
      const event: QueueEvent = JSON.parse(raw as string);
      await processEvent(event, ceoKey);
    } catch (e) {
      console.error("failed to process event:", e);
    }
  }
}

async function main() {
  console.log("hermod poller starting...");
  console.log(`redis: ${REDIS_URL.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`paperclip: ${PAPERCLIP_API_URL}`);
  console.log(`poll interval: ${POLL_INTERVAL}ms`);

  const redis = new Bun.RedisClient(REDIS_URL);

  // Get CEO API key for posting comments
  const ceoKey = await getPaperclipApiKey(CEO_AGENT_ID);
  if (!ceoKey) {
    console.error("could not get CEO API key");
    process.exit(1);
  }
  console.log("authenticated as CEO");

  // Initial drain
  await poll(redis, ceoKey);

  // Poll loop
  setInterval(() => poll(redis, ceoKey), POLL_INTERVAL);
  console.log("polling...");
}

main();

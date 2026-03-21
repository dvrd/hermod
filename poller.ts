/**
 * Hermod Poller — runs locally, polls Hermod server, triggers Paperclip heartbeats.
 *
 * Usage: bun run poller.ts
 * Env: HERMOD_URL, POLL_SECRET, PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_CEO_AGENT_ID
 */

const HERMOD_URL = process.env.HERMOD_URL!;
const POLL_SECRET = process.env.POLL_SECRET!;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL!;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID!;
const CEO_AGENT_ID = process.env.PAPERCLIP_CEO_AGENT_ID!;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 30_000;

for (const v of ["HERMOD_URL", "POLL_SECRET", "PAPERCLIP_API_URL", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_CEO_AGENT_ID"]) {
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

function log(level: "INFO" | "WARN" | "ERROR", msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[${ts}] ${level} ${msg}${metaStr}`);
}

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
  const proc = Bun.spawn(
    ["npx", "paperclipai", "agent", "local-cli", agentId, "--company-id", COMPANY_ID],
    { stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(proc.stdout).text();
  const match = output.match(/PAPERCLIP_API_KEY='([^']+)'/);
  return match ? match[1] : null;
}

function extractDonIdentifier(branch: string | null, title: string): string | null {
  if (branch) {
    const donMatch = branch.match(/DON-(\d+)/i);
    if (donMatch) return `DON-${donMatch[1]}`;
  }
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
  return match ? { id: match.id, assigneeAgentId: match.assigneeAgentId } : null;
}

async function postComment(issueId: string, body: string, ceoKey: string): Promise<void> {
  await fetch(`${PAPERCLIP_API_URL}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ceoKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function triggerHeartbeat(agentId: string, repo: string): Promise<void> {
  log("INFO", `getting API key for agent`, { agentId: agentId.slice(0, 8) });
  const apiKey = await getPaperclipApiKey(agentId);
  if (!apiKey) {
    log("ERROR", `could not get API key for agent`, { agentId: agentId.slice(0, 8), repo });
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

  log("INFO", `heartbeat triggered`, { agentId: agentId.slice(0, 8), repo });

  proc.exited.then((code) => {
    if (code === 0) {
      log("INFO", `heartbeat completed`, { agentId: agentId.slice(0, 8), repo, exitCode: code });
    } else {
      log("WARN", `heartbeat exited with non-zero code`, { agentId: agentId.slice(0, 8), repo, exitCode: code });
    }
  });
}

async function processEvent(event: QueueEvent, ceoKey: string): Promise<void> {
  log("INFO", `processing event`, {
    repo: event.repo,
    pr: event.prNumber,
    author: event.author,
    branch: event.branch ?? "(none)",
    comment: event.comment.slice(0, 80) + (event.comment.length > 80 ? "…" : ""),
    enqueuedAt: event.timestamp,
  });

  const agentId = REPO_AGENT_MAP[event.repo];
  if (!agentId) {
    log("WARN", `no agent mapped for repo — skipping`, { repo: event.repo });
    return;
  }

  const identifier = extractDonIdentifier(event.branch, event.prTitle);

  if (identifier) {
    log("INFO", `resolved Paperclip issue`, { identifier, branch: event.branch });
    const issue = await findIssueByIdentifier(identifier, ceoKey);
    if (issue) {
      const commentBody = `## PR Comment from @${event.author}\n\n> ${event.comment.split("\n").join("\n> ")}\n\n**PR:** [${event.prTitle}](${event.prUrl}) (#${event.prNumber})`;
      await postComment(issue.id, commentBody, ceoKey);
      log("INFO", `posted comment to Paperclip issue`, { identifier, issueId: issue.id.slice(0, 8) });
    } else {
      log("WARN", `issue not found in Paperclip`, { identifier });
    }
  } else {
    log("WARN", `no DON identifier found`, { branch: event.branch, title: event.prTitle });
  }

  await triggerHeartbeat(agentId, event.repo);
}

async function poll(ceoKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${HERMOD_URL}/poll`, {
      headers: { Authorization: `Bearer ${POLL_SECRET}` },
    });
  } catch (e) {
    log("ERROR", "could not reach Hermod server", { error: String(e) });
    return;
  }

  if (!res.ok) {
    log("ERROR", "poll request failed", { status: res.status });
    return;
  }

  const { events } = (await res.json()) as { events: QueueEvent[] };
  for (const event of events) {
    try {
      await processEvent(event, ceoKey);
    } catch (e) {
      log("ERROR", `failed to process event`, { error: String(e) });
    }
  }
  if (events.length > 0) {
    log("INFO", `poll cycle complete`, { processed: events.length });
  }
}

async function main() {
  log("INFO", "hermod poller starting", {
    hermod: HERMOD_URL,
    paperclip: PAPERCLIP_API_URL,
    pollIntervalMs: POLL_INTERVAL,
    mappedRepos: Object.keys(REPO_AGENT_MAP),
  });

  // Verify Hermod is reachable
  try {
    const res = await fetch(`${HERMOD_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    log("INFO", "Hermod connection OK");
  } catch (e) {
    log("ERROR", "Hermod connection failed", { error: String(e) });
    process.exit(1);
  }

  const ceoKey = await getPaperclipApiKey(CEO_AGENT_ID);
  if (!ceoKey) {
    log("ERROR", "could not get CEO API key");
    process.exit(1);
  }
  log("INFO", "authenticated as CEO");

  // Initial drain
  await poll(ceoKey);

  log("INFO", `polling every ${POLL_INTERVAL}ms`);
  setInterval(() => poll(ceoKey), POLL_INTERVAL);
}

main();

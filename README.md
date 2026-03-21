# Hermod

> In Norse mythology, Hermóðr was the messenger of the gods — riding between worlds to carry word from one realm to another.

Hermod bridges GitHub PR comments to [Paperclip](https://paperclip.ing) agent heartbeats. When you leave a comment on a PR, the lead agent responsible for that repo wakes up and sees it in their Paperclip issue thread.

## How it works

```
GitHub PR comment
      │
      ▼
GitHub Webhook (issue_comment / pull_request_review_comment)
      │
      ▼
hermod server (deployed on VPS via Coolify)
      │  verifies HMAC signature
      │  extracts: repo, PR#, branch, comment, author
      ▼
Redis queue  ──────────────────────────────────────────────────
                                                               │
                              (laptop wakes up, polls queue)   │
                                                               ▼
                                                      hermod poller (local)
                                                               │
                                                      finds DON-XX in branch name
                                                               │
                                                      posts comment to Paperclip issue
                                                               │
                                                      triggers agent heartbeat
```

### Two components

**`index.ts` — server (runs on VPS)**
- Receives GitHub webhooks at `POST /webhook/github`
- Verifies the HMAC-SHA256 signature
- Filters for PR comments only (`issue_comment` and `pull_request_review_comment` events, `created` action)
- Pushes a JSON event to the Redis queue (`RPUSH hermod:events`)

**`poller.ts` — poller (runs locally)**
- Polls Redis every 30s (`LPOP hermod:events`)
- Extracts the `DON-XX` identifier from the PR branch name or title
- Posts the GitHub comment body into the matching Paperclip issue thread
- Triggers a Paperclip heartbeat for the lead agent mapped to that repo

### Branch naming convention

The poller resolves the Paperclip issue from the PR branch name. Branches must follow:

```
<type>/<repo>-<issue-number>
```

Examples: `feat/some-42`, `fix/this-64`, `chore/that-29`

## Setup

### 1. Configure environment

```bash
cp .env.example .env
# fill in values
```

See `.env.example` for all required variables.

### 2. Deploy the server on Coolify

- Point Coolify to this repo, build with the `Dockerfile`
- Set env vars: `REDIS_URL` (internal Docker network), `GITHUB_WEBHOOK_SECRET`, `PORT`
- Expose on your domain (e.g. `hermod.{yourdomain}.{gTLD}`)

### 3. Configure GitHub webhooks

In each repo → Settings → Webhooks → Add webhook:
- **Payload URL:** `https://hermod.yourdomain.com/webhook/github`
- **Content type:** `application/json`
- **Secret:** same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** select `Issue comments` and `Pull request review comments`

### 4. Run the poller locally

```bash
bun install
bun run poller.ts
```

The poller needs your local Paperclip instance running (`PAPERCLIP_API_URL=http://127.0.0.1:3100`).

## Development

```bash
bun install
bun --hot run index.ts   # server with hot reload
bun run poller.ts        # poller
```

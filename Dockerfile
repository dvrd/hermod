FROM oven/bun:1-alpine
WORKDIR /app

# Install Docker CLI for accessing host Docker socket
RUN apk add --no-cache docker-cli

COPY package.json bun.lock* ./
RUN bun install --production
COPY index.ts .
EXPOSE 3000
CMD ["bun", "run", "index.ts"]

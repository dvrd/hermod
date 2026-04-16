FROM oven/bun:1-alpine
WORKDIR /app

# Install OpenSSH client for remote Docker log streaming
RUN apk add --no-cache openssh-client

COPY package.json bun.lock* ./
RUN bun install --production
COPY index.ts .
EXPOSE 3000
CMD ["bun", "run", "index.ts"]

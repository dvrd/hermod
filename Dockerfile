FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY index.ts .
EXPOSE 3000
CMD ["bun", "run", "index.ts"]

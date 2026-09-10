# syntax=docker/dockerfile:1

# ─── builder ───────────────────────────────────────────────────────────────
# Full dependency set (including devDependencies) so `npm run build` has
# vite, typescript, drizzle-kit's type deps, etc. Nothing from this stage
# ships except the compiled output copied out below.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Baked into the client bundle at build time (Vite inlines import.meta.env.VITE_*).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_APP_NAME="Xmail"

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_APP_NAME=$VITE_APP_NAME

# Builds dist/client (Vite/SPA) and dist/server + dist/db (tsc, tsconfig.server.json),
# plus dist/package.json ({"type":"commonjs"}) so Node loads the tsc-compiled CJS output
# correctly even though the repo root package.json is "type": "module".
RUN npm run build

# ─── runtime ────────────────────────────────────────────────────────────────
# Only production dependencies + the compiled dist/ tree. No src/, no test files,
# no build tooling (vite, typescript, drizzle-kit, tsx, vitest — all devDependencies).
#
# What the running server reads from disk at startup, checked against src/server:
#   - dist/server/**, dist/db/** (compiled entry point + imports)
#   - dist/client/** (express.static + SPA fallback, src/server/index.ts ~line 356)
#   - dist/package.json (type:commonjs marker written by build:server)
#   - MAIL_TLS_CERT_PATH / MAIL_TLS_KEY_PATH (src/server/lib/mail-tls.ts) — these are
#     absolute host paths under /etc/letsencrypt, bind-mounted by `docker run -v
#     /etc/letsencrypt:/etc/letsencrypt:ro`, NOT baked into the image.
#   - sql/, supabase/migrations/, scripts/ are NOT read by the app process itself.
#     The active deploy path (.github/workflows/build-deploy.yml) never execs into this
#     container to run migrations; only the LEGACY deploy-hetzner.yml applies migrations,
#     and it does so via a separate `postgres:16-alpine` container that bind-mounts the
#     checked-out repo directory on the HOST — not this image. So none of those three
#     directories need to be copied into the runtime stage.
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=9001

COPY package*.json ./
# --omit=dev drops devDependencies (vite, typescript, drizzle-kit, tsx, vitest, testing
# libs, etc). Checked against every import under src/server/** and src/db/**: everything
# actually required at runtime (dotenv, @supabase/supabase-js, drizzle-orm, drizzle-zod,
# express, cors, helmet, express-rate-limit, bcrypt, imap, imapflow, smtp-server,
# nodemailer, mailauth, mailparser, node-cron, pino, postgres, uuid, zod, @aws-sdk/*,
# html-to-text) already lives under "dependencies" in package.json — none of it is a
# devDependency. `tsx` (the dev watch runner) and `pino-pretty` (dev-only pretty-print
# transport, gated behind NODE_ENV in src/server/lib/logger.ts) are devDependencies and
# are correctly never imported by the production code path, so removing them here does
# not break `node dist/server/index.js`.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 9001 25 587 993

# Liveness only (process is up and Express is answering) — mirrors the quick check the
# deploy workflow's wait_for_container_health() also does before the deeper
# /health/ready (DB + Supabase Auth) probe. Docker's own HEALTHCHECK intentionally stays
# on the shallow /health: a slow/unreachable database should surface as a 503 from
# /health/ready during a deploy's readiness gate, not flip Docker's health status (and
# `docker restart unless-stopped`) on every transient DB hiccup.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Deliberately still root. Two things break as the non-root 'node' user and both fail
# SILENTLY rather than loudly: (1) MAIL_TLS_CERT_PATH/KEY_PATH point at a bind-mounted
# /etc/letsencrypt whose archive dir is 0700 root:root, so the private key is unreadable and
# src/server/lib/mail-tls.ts falls through to plaintext mail ports; (2) binding 25/587/993
# below 1024 depends on the host Docker's ip_unprivileged_port_start default. Until the host
# exposes the certs to a dedicated group and a setcap step is verified there, a root process
# with working TLS beats a non-root one serving IMAP/SMTP in the clear. Revisit with the
# host, not in this file alone.

CMD ["node", "dist/server/index.js"]

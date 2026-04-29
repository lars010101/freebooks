# Stage 1: build — Node 22 LTS has pre-built duckdb binaries, no compilation needed
FROM node:22-alpine AS build
RUN apk add --no-cache git
RUN git clone https://github.com/lars010101/freebooks /build/freebooks && \
    cd /build/freebooks/api && npm install --legacy-peer-deps && \
    cd /build/freebooks/reports && npm install --legacy-peer-deps

# Stage 2: runtime — lean image, no build tools
FROM cgr.dev/chainguard/wolfi-base:latest
RUN apk update && apk add --no-cache nodejs npm duckdb git gh shadow sudo

RUN useradd -m -u 1000 user && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# Copy compiled repo from build stage
COPY --from=build --chown=user:user /build/freebooks /home/user/freebooks

USER user

# Set default env
RUN printf 'DB_PATH=%s/.freebooks/freebooks.duckdb\nPORT=3000\n' "$HOME" > /home/user/freebooks/api/.env

# Auto-init DB on shell entry with status messages (system-wide, any user)
RUN chmod +x /home/user/freebooks/db/start.sh && \
    echo 'bash /home/user/freebooks/db/start.sh' >> /etc/profile.d/freebooks.sh

WORKDIR /home/user/freebooks
CMD ["/bin/bash"]

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

# Copy compiled repo to system-wide location (distrobox enters as host user, not 'user')
COPY --from=build /build/freebooks /opt/freebooks
RUN chmod -R a+rX /opt/freebooks

# Default env — DB in the entering user's home
RUN printf 'DB_PATH=${HOME}/.freebooks/freebooks.duckdb\nPORT=3000\n' > /opt/freebooks/api/.env

# Startup script — runs for any user on shell entry
RUN chmod +x /opt/freebooks/db/start.sh && \
    sed -i 's|/home/user/freebooks|/opt/freebooks|g' /opt/freebooks/db/start.sh && \
    echo 'bash /opt/freebooks/db/start.sh' > /etc/profile.d/freebooks.sh && \
    chmod +x /etc/profile.d/freebooks.sh

USER user
WORKDIR /opt/freebooks
CMD ["/bin/bash"]

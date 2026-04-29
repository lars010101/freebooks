FROM debian:bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git sudo \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Create user for distrobox
RUN useradd -m -u 1000 user && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# Clone repo and install dependencies natively (glibc — pre-built duckdb binaries)
RUN git clone https://github.com/lars010101/freebooks /opt/freebooks && \
    cd /opt/freebooks/api && npm install --legacy-peer-deps && \
    cd /opt/freebooks/reports && npm install --legacy-peer-deps && \
    chmod -R a+rX /opt/freebooks

# Default env
RUN printf 'DB_PATH=${HOME}/.freebooks/freebooks.duckdb\nPORT=3000\n' > /opt/freebooks/api/.env

# Startup script
RUN chmod +x /opt/freebooks/db/start.sh && \
    echo 'bash /opt/freebooks/db/start.sh' > /etc/profile.d/freebooks.sh && \
    chmod +x /etc/profile.d/freebooks.sh

USER user
WORKDIR /opt/freebooks
CMD ["/bin/bash"]

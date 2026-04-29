FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk update && apk add --no-cache nodejs-22 npm duckdb git gh shadow sudo

# Create user for distrobox
RUN useradd -m -u 1000 user && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# Clone repo and install API dependencies only (no Evidence)
RUN git clone https://github.com/lars010101/freebooks /opt/freebooks && \
    cd /opt/freebooks/api && npm install --legacy-peer-deps && \
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

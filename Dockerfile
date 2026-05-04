FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk update && apk add --no-cache nodejs-24 npm git gh shadow sudo

# Create user for distrobox
RUN useradd -m -u 1000 user && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# Startup hook (must write to /etc/profile.d as root)
RUN printf '#!/bin/bash\n[ -f "${HOME}/freebooks/db/start.sh" ] && bash "${HOME}/freebooks/db/start.sh"\n' \
    > /etc/profile.d/freebooks.sh && chmod +x /etc/profile.d/freebooks.sh

USER user
WORKDIR /home/user

# Clone and install as user — ~/freebooks is user-owned, no sudo needed for git pull
RUN git clone https://github.com/lars010101/freebooks ~/freebooks && \
    cd ~/freebooks/api && npm install

# Default env — DB_PATH not needed (code falls back to ~/.freebooks/freebooks.duckdb)
RUN echo 'PORT=3000' > ~/freebooks/api/.env

CMD ["/bin/bash"]

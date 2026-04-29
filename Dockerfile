FROM cgr.dev/chainguard/wolfi-base:latest
RUN apk update && apk add --no-cache nodejs npm duckdb git gh shadow sudo
RUN useradd -m -u 1000 user && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user
USER user
WORKDIR /home/user

# Clone repo, install dependencies, set default env
RUN git clone https://github.com/lars010101/freebooks /home/user/freebooks && \
    cd /home/user/freebooks/api && npm install && \
    cd /home/user/freebooks/reports && npm install && \
    printf 'DB_PATH=%s/.freebooks/freebooks.duckdb\nPORT=3000\n' "$HOME" > /home/user/freebooks/api/.env

WORKDIR /home/user/freebooks
CMD ["/bin/bash"]

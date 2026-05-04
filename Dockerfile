FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk update && apk add --no-cache nodejs-24 npm git gh shadow sudo

# Create user for distrobox
RUN useradd -m -u 1000 user && echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user

# First-run + startup profile script (written as root so it lands in /etc/profile.d)
RUN printf '#!/bin/bash\n\
# Clone and install on first distrobox entry\n\
if [ ! -d "${HOME}/freebooks" ]; then\n\
  echo "📦 First run: cloning freeBooks to ~/freebooks..."\n\
  git clone https://github.com/lars010101/freebooks "${HOME}/freebooks"\n\
  cd "${HOME}/freebooks/api" && npm install\n\
  echo "PORT=3000" > "${HOME}/freebooks/api/.env"\n\
  echo "✓ freeBooks installed"\n\
fi\n\
# Run DB init/verify\n\
if [ -f "${HOME}/freebooks/db/start.sh" ]; then\n\
  bash "${HOME}/freebooks/db/start.sh"\n\
fi\n\
' > /etc/profile.d/freebooks.sh && chmod +x /etc/profile.d/freebooks.sh

USER user
WORKDIR /home/user
CMD ["/bin/bash"]

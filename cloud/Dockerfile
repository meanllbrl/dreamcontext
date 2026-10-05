# dreamcontext hands-free cloud. Copied verbatim into <owner>/dreamcontext-handsfree/.devcontainer/.
# The container is never rebuilt on purpose: the dreamcontext build is installed at runtime
# into /opt/dreamcontext by the root supervisor, always from npm at the laptop's EXACT version
# (the repo's .devcontainer/bootstrap/version.json pin, or a go's {version, integrity}), its
# sha512 checked against npm's integrity before anything is installed (D25).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git sudo util-linux procps psmisc gnupg bash less jq python3 tar gzip \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g @anthropic-ai/claude-code && corepack enable

# Users: codespace (the remote user; sudo ONLY for the entrypoint), dcserver (the server, only
# CAP_SETUID/SETGID/KILL at runtime), dcuser (agents, installs, every git and pack op), group dcwork.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && groupadd -g 1000 codespace && useradd -m -u 1000 -g 1000 -s /bin/bash codespace \
 && groupadd -g 2000 dcwork && groupadd -g 2001 dcserver \
 && useradd -M -u 2001 -g dcserver -G dcwork -d /workspaces/dc-server -s /usr/sbin/nologin dcserver \
 && useradd -M -u 2002 -g dcwork -d /workspaces/dc-home -s /bin/bash dcuser \
 && echo 'codespace ALL=(root) NOPASSWD: /opt/dc-hf/entrypoint.sh' > /etc/sudoers.d/codespace \
 && chmod 0440 /etc/sudoers.d/codespace

COPY entrypoint.sh poststart.sh stop-helper.sh supervisor.mjs /opt/dc-hf/
RUN chown -R root:root /opt/dc-hf \
 && chmod 0755 /opt/dc-hf /opt/dc-hf/entrypoint.sh /opt/dc-hf/poststart.sh /opt/dc-hf/stop-helper.sh \
 && chmod 0644 /opt/dc-hf/supervisor.mjs

FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

ENV PATH="/home/vscode/Android/Sdk/platform-tools:/home/vscode/Android/Sdk/cmdline-tools/latest/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

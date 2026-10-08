# Runs hidden browser tests: Playwright's image (Chromium and its system libraries) plus
# playwright-core at the same version. The harness builds it (tagged hbe-browser-tester:<version>)
# the first time a suite has a browser stage; keep the two versions and the tag in step.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN mkdir -p /opt/hbe && cd /opt/hbe && npm init -y > /dev/null \
  && npm install --no-audit --no-fund --omit=dev playwright-core@1.56.1
ENV HBE_PLAYWRIGHT=/opt/hbe/node_modules/playwright-core/index.mjs PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

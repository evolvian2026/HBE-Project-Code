# Runs Lighthouse against the student's front end: Playwright's image (for its Chromium and
# system libraries, shared with the browser tester) plus the Lighthouse CLI. The harness
# builds it (tagged hbe-lighthouse:<version>) the first time an assignment turns Lighthouse on;
# keep the version here and the tag in run.mjs in step. A new Lighthouse version can score
# differently, which changes grades: upgrade between terms.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN npm install -g --no-audit --no-fund lighthouse@13.5.0 \
  && ln -s "$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -n 1)" /usr/local/bin/hbe-chrome \
  && test -x /usr/local/bin/hbe-chrome
ENV CHROME_PATH=/usr/local/bin/hbe-chrome

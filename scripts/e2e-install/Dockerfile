# Fresh-install test image: a clean user, OpenClaw installed the documented way
# (install-cli.sh, user-space Node), no prior ClawChats state.
ARG BASE=debian:bookworm-slim
FROM ${BASE}
RUN if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq curl ca-certificates git xz-utils procps >/dev/null; \
    else apk add --no-cache curl ca-certificates git bash xz procps libstdc++ >/dev/null; fi
RUN if command -v adduser >/dev/null && adduser --help 2>&1 | grep -q disabled-password; then adduser --disabled-password --gecos "" tester; else adduser -D tester; fi
USER tester
WORKDIR /home/tester
ENV PATH=/home/tester/.openclaw/bin:$PATH
RUN curl -fsSL https://openclaw.ai/install-cli.sh | bash
RUN openclaw onboard --non-interactive --accept-risk --skip-health \
      --auth-choice custom-api-key --custom-base-url http://127.0.0.1:9/v1 \
      --custom-model-id test-model --custom-api-key dummy \
      --secret-input-mode plaintext --custom-compatibility openai 2>&1 | tail -15
COPY --chown=tester:tester run-test.sh /home/tester/run-test.sh
ENTRYPOINT ["bash", "/home/tester/run-test.sh"]

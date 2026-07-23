#!/bin/sh
# Bootstrap the OKX A2A communication runtime, then start the bot.
#
# The marketplace poller's gate-check requires `communication.ok`, which the
# okx-a2a CLI owns (daemon, runtime binding, agent refresh). Its state lives
# outside the persistent volume, so it is re-bootstrapped on every boot —
# `doctor --fix` is idempotent and repairs whatever is missing.
#
# This is deliberately NON-FATAL: if communication cannot be brought up, the
# poller stays off but Telegram sign-in, hunts, scoring and drafts all still
# work. A dead container would take those down too, for no gain.
set -u

# okx-a2a refreshes the agent against the signed-in wallet session, so point it
# at the SERVICE home (the same one src/okx/marketplace.ts uses) rather than the
# container default, which has no session.
if [ -n "${OKX_ONCHAINOS_HOME:-}" ]; then
  export ONCHAINOS_HOME="$OKX_ONCHAINOS_HOME"
fi

if command -v okx-a2a >/dev/null 2>&1; then
  echo "[a2a] bootstrapping communication runtime…"

  # Bind a default AI provider BEFORE the doctor runs.
  #
  # The doctor treats an unbound provider as a BLOCKING failure, so `ready`
  # comes back false, `onchainos agent gate-check` reports communication as not
  # ready, and the poller starts degraded — skipping buyer greetings and
  # cold-start discovery — over a check about a local AI CLI this deployment
  # never uses. Inbound A2A arrives at our own /okx/a2a endpoint and the poller
  # drives the task lifecycle; nothing here dispatches to an AI adapter, so the
  # binding is metadata the gate wants rather than a runtime we invoke.
  #
  # `doctor --fix` cannot repair it: its auto-fix performs a runtime SWITCH,
  # which needs a detectable runtime (CLAUDECODE / CODEX_* / HERMES_* /
  # OPENCLAW_* markers). A container has none, so the check downgrades its own
  # remediation to "bind one manually". With no runtime detectable the checker
  # accepts any bound provider — it only requires that one is set.
  #
  # Idempotent, and the okx-a2a store lives outside the persistent volume, so
  # this must run on every boot rather than once at build time.
  # `config provider` is the current spelling; `ai-provider set` is the one the
  # doctor's own remediation still prints and is marked legacy. Try the modern
  # form first so this keeps working if the legacy alias is ever dropped.
  a2a_provider="${OKX_A2A_PROVIDER:-claude}"
  if okx-a2a config provider --provider "$a2a_provider" >/dev/null 2>&1 ||
     okx-a2a ai-provider set --provider "$a2a_provider" >/dev/null 2>&1; then
    echo "[a2a] default AI provider bound: $a2a_provider"
  else
    echo "[a2a] could not bind AI provider '$a2a_provider' — the doctor will report it below" >&2
  fi

  # `doctor --fix` owns the rest (package version, daemon, runtime binding,
  # agent refresh). Trust its `ready` field, not its exit code: it can exit 0
  # while still reporting ready:false with an action the operator must take.
  a2a_out="$(okx-a2a doctor --fix --json 2>&1)"
  if echo "$a2a_out" | grep -q '"ready"[[:space:]]*:[[:space:]]*true'; then
    echo "[a2a] communication ready"
  else
    echo "[a2a] communication NOT ready — marketplace polling will stay disabled; everything else works" >&2
    # Surface the CLI's own diagnosis so the reason is visible in deploy logs.
    echo "$a2a_out" | tail -20 >&2
  fi
else
  echo "[a2a] okx-a2a not installed — marketplace polling will stay disabled; everything else works" >&2
fi

exec "$@"

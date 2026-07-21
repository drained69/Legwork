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
  # `doctor --fix` owns everything (package version, daemon, runtime binding,
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

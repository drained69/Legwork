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

  # NOTE ON `provider_binding: fail`
  #
  # The doctor reports an unbound default AI provider as a blocking failure, so
  # `ready` is false here and `gate-check` calls communication not-ready. That
  # is EXPECTED in this deployment and is deliberately left alone.
  #
  # Binding one does not help, because every available value trades the failure
  # for a different one — `resolveDoctorTarget` reads the stored provider:
  #   claude / codex   → target stays "node", but the `provider_cli` check then
  #                      applies and fails (no such CLI here), and its auto-fix
  #                      tries to npm-install the CLI and launch an OAuth login
  #   hermes / openclaw → target becomes that gateway, so `gateway_plugin`
  #                      applies and fails (no gateway plugin here)
  # Only installing and logging into a real AI CLI clears it, and nothing in
  # this deployment dispatches prompts through one: inbound A2A arrives at our
  # own /okx/a2a endpoint and the poller drives the task lifecycle.
  #
  # It also does not matter. The poller no longer trusts this flag for its
  # comms decision — it re-samples the XMTP daemon directly (see
  # marketplace.ts::a2aDaemonUp), which is the signal that actually determines
  # whether a message can be delivered.

  # `doctor --fix` owns the rest (package version, daemon, runtime binding,
  # agent refresh). Trust its `ready` field, not its exit code: it can exit 0
  # while still reporting ready:false with an action the operator must take.
  #
  # `--non-interactive` is NOT optional here. Once a codex/claude provider is
  # bound, the doctor gains a `provider_cli` check whose auto-fix LAUNCHES AN
  # INTERACTIVE OAUTH LOGIN and blocks ~180s on a prompt no one can answer in a
  # container. Because this runs before `exec "$@"`, that delay pushed the app
  # past Railway's 2-minute healthcheck window and took the whole service down.
  # The flag makes the check degrade to a manual instruction instead.
  #
  # The hard timeout is the belt to that suspenders: a bootstrap diagnostic must
  # never be able to stop the app from starting, whatever a future check decides
  # to do. If it trips, we boot anyway and the poller's own heartbeat re-checks
  # the channel within five minutes.
  if command -v timeout >/dev/null 2>&1; then
    a2a_out="$(timeout 100 okx-a2a doctor --fix --non-interactive --json 2>&1)" || \
      a2a_out="${a2a_out}
[a2a] doctor exceeded its 100s budget and was stopped so the app could start."
  else
    a2a_out="$(okx-a2a doctor --fix --non-interactive --json 2>&1)"
  fi
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

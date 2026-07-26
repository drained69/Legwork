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

  # Clear stale RUNTIME state before the doctor looks at it.
  #
  # OKX_AGENT_TASK_HOME lives on the persistent volume so the XMTP identity and
  # session history survive a redeploy — but `run/` holds a pidfile, a lock dir
  # and a unix socket, and those describe a PROCESS, which never survives one.
  # A fresh container therefore starts with a pidfile naming a process that does
  # not exist; `okx-a2a status` reports "running pid=NNN", the doctor's
  # daemon_running check passes, and the daemon is never actually started. The
  # result is silent and total: nothing listens on the RPC port, so every
  # session create and every outbound message fails — while the boot log says
  # communication is healthy. In a fresh container any pidfile is stale by
  # definition, so remove them and let the doctor start a real daemon.
  a2a_home="${OKX_AGENT_TASK_HOME:-$HOME/.okx-agent-task}"
  if [ -d "$a2a_home/run" ]; then
    rm -rf "$a2a_home/run/listener.pid" "$a2a_home/run/daemon.lock" "$a2a_home"/run/*.sock 2>/dev/null || true
    echo "[a2a] cleared stale daemon runtime state from a previous container"
  fi

  # Keep the daemon's command queue from filling the volume.
  #
  # It is an append-only queue of outbound commands. A delivery bug once
  # enqueued ~25k copies of a 7KB payload and it reached 391MB, filling the
  # 434MB volume — at which point the CLI could not write its keyring temp
  # file, agent resolution returned zero agents, and the poller went blind to
  # every task while reporting itself healthy. The queue is disposable
  # (recreated empty on start), the session store next to it is NOT.
  a2a_queue="$a2a_home/sqlite/command-store.sqlite"
  if [ -f "$a2a_queue" ]; then
    queue_mb=$(du -m "$a2a_queue" 2>/dev/null | cut -f1)
    if [ "${queue_mb:-0}" -gt 100 ]; then
      rm -f "$a2a_queue" "$a2a_queue-wal" "$a2a_queue-shm"
      echo "[a2a] dropped an oversized command queue (${queue_mb}MB) — it is disposable and was starving the volume"
    fi
  fi

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
  # Run it in the BACKGROUND and wait on the daemon, not on the process.
  #
  # The doctor does all of its real work in about six seconds — starts the
  # daemon, refreshes agents — and then simply never exits. Waiting on the
  # process therefore burned the entire timeout (~94 wasted seconds) on every
  # single boot, for work that had already finished, and consumed most of the
  # platform's two-minute healthcheck window while doing nothing.
  #
  # Killing the doctor is safe: the daemon it starts is a separate process that
  # outlives it (confirmed in production — the poller found the daemon up after
  # the doctor was stopped). The outer timeout is a backstop so the orphan
  # cannot linger indefinitely.
  doctor_log=/tmp/a2a-doctor.log
  if command -v timeout >/dev/null 2>&1; then
    timeout 170 okx-a2a doctor --fix --non-interactive --json >"$doctor_log" 2>&1 &
  else
    okx-a2a doctor --fix --non-interactive --json >"$doctor_log" 2>&1 &
  fi

  # Block only until the thing we actually need is up: the XMTP daemon that
  # carries deliverables. Typically ready in well under ten seconds.
  waited=0
  while [ "$waited" -lt 60 ]; do
    if okx-a2a status 2>/dev/null | grep -qi running; then
      echo "[a2a] XMTP daemon ready after ${waited}s"
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  if [ "$waited" -ge 60 ]; then
    echo "[a2a] XMTP daemon did not come up within 60s — starting anyway; the poller re-checks it every 5 minutes and restarts it before any delivery." >&2
    tail -20 "$doctor_log" >&2 2>/dev/null || true
  fi
else
  echo "[a2a] okx-a2a not installed — marketplace polling will stay disabled; everything else works" >&2
fi

exec "$@"

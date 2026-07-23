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
  # accepts any bound provider — it only requires that one is set:
  #   if (bound && (!expected || bound === expected)) → pass
  #
  # `okx-a2a config provider`/`ai-provider set` refuse to bind a provider whose
  # CLI isn't actually on PATH (`assertInstalled`) — reasonably, for a human
  # picking their own coding assistant. This container has no `claude`/`codex`
  # binary and never will, since nothing here dispatches prompts through one.
  # There is no supported flag to bind an "unavailable" provider (only an
  # internal-only path used by `daemon restart` under autostart takes it), so
  # when the CLI command refuses, we write the identical row the command would
  # have written — same table, same key, same value — directly. This is the
  # ONLY thing the check reads (confirmed by reading the doctor's own
  # `provider_binding` implementation); it does not touch the daemon, XMTP, or
  # any AI-dispatch path, and Legwork has run this exact unbound state for
  # hours without incident, so flipping it to bound cannot regress anything
  # this deployment actually exercises. If store internals change in a future
  # okx-a2a version, this degrades to a no-op and the boot log shows the
  # ordinary "communication NOT ready" path below — never a hard failure.
  #
  # Idempotent, and the okx-a2a store lives outside the persistent volume, so
  # this must run on every boot rather than once at build time.
  a2a_provider="${OKX_A2A_PROVIDER:-claude}"
  if okx-a2a config provider --provider "$a2a_provider" >/dev/null 2>&1 ||
     okx-a2a ai-provider set --provider "$a2a_provider" >/dev/null 2>&1; then
    echo "[a2a] default AI provider bound: $a2a_provider"
  else
    # Ensure the store's schema exists (its constructor creates it) before
    # writing to it directly.
    okx-a2a ai-provider status >/dev/null 2>&1 || true
    a2a_task_home="${OKX_AGENT_TASK_HOME:-${HOME:-/root}/.okx-agent-task}"
    a2a_db="$a2a_task_home/sqlite/session-store.sqlite"
    if [ -f "$a2a_db" ] && node -e '
        const Database = require("better-sqlite3");
        const db = new Database(process.argv[1]);
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run("default_ai_provider", process.argv[2], new Date().toISOString());
        db.close();
      ' "$a2a_db" "$a2a_provider" 2>/tmp/a2a-provider-bind.err; then
      echo "[a2a] default AI provider bound directly: $a2a_provider (CLI install-check refused — no claude/codex/hermes/openclaw binary here, which is expected)"
    else
      echo "[a2a] could not bind AI provider '$a2a_provider' — the doctor will report it below" >&2
      [ -s /tmp/a2a-provider-bind.err ] && cat /tmp/a2a-provider-bind.err >&2
    fi
  fi

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

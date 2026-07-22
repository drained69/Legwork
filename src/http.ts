/**
 * Outbound HTTP with a mandatory deadline.
 *
 * Node's global fetch has no overall timeout — only undici's per-stage
 * headers/body timeouts (~300s each), and a server that trickles bytes can
 * hold a connection well past even those. That matters here more than in a
 * typical service because the marketplace poller is single-flight: one hung
 * request inside a tick blocks every later tick, and marketplace tasks expire
 * on the backend's clock while the loop is wedged. A slow source has to lose
 * to the clock, not take the poller down with it.
 *
 * Every outbound call in this codebase goes through here.
 */

/** Default ceiling for a single outbound request. */
export const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  // AbortSignal.timeout fires on total elapsed time, which is the property we
  // actually want — per-stage timeouts can each reset on a trickle.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    // A timeout arrives as an opaque AbortError/TimeoutError; name it so the
    // caller's error string says what happened rather than "This operation
    // was aborted".
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

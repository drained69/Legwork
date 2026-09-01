import 'dotenv/config';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  telegram: {
    token: env('TELEGRAM_BOT_TOKEN'),
    username: env('TELEGRAM_BOT_USERNAME', 'LegworkBot'),
  },
  server: {
    endpointPort: Number(env('PORT') || env('SERVICE_PORT', '8402')),
    publicUrl: env('PUBLIC_URL', ''),
  },
  adzuna: {
    appId: env('ADZUNA_APP_ID'),
    appKey: env('ADZUNA_APP_KEY'),
    country: env('ADZUNA_COUNTRY', 'us'),
    get enabled() {
      return Boolean(this.appId && this.appKey);
    },
  },
  // Keyless remote-jobs board. No API key exists to expire, so it is the
  // floor under every search: if Adzuna and USAJOBS credentials both lapse,
  // a hunt still returns real live postings instead of an empty shortlist.
  remotive: {
    get enabled(): boolean {
      return process.env.REMOTIVE_ENABLED !== 'false';
    },
  },
  usajobs: {
    apiKey: env('USAJOBS_API_KEY'),
    userAgent: env('USAJOBS_USER_AGENT', 'legwork@example.com'),
    get enabled() {
      return Boolean(this.apiKey);
    },
  },
  /**
   * Google Gemini. Checked FIRST because setting a Gemini key is an explicit
   * choice of provider — it should win over a stale Anthropic key left in the
   * environment rather than silently losing to it.
   *
   * Gemini is NOT Anthropic-compatible: different path, different request and
   * response shapes, different auth header. It is a separate branch in llm.ts,
   * not a base-URL swap.
   */
  gemini: {
    apiKey: env('GEMINI_API_KEY') || env('GOOGLE_API_KEY'),
    baseUrl: env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
    // gemini-3.5-flash-lite by default, chosen by measurement rather than
    // by version number. Newer Gemini models spend the OUTPUT budget on
    // internal "thinking" tokens: gemini-3.6-flash returned finishReason
    // MAX_TOKENS after 6.2s on a 400-token scoring call — a truncated,
    // unparseable answer. Flash-lite finished (STOP) in 814ms with complete
    // JSON. Scoring runs once per posting, so latency here is multiplied by
    // ~20 on every hunt. `thinkingBudget: 0` is rejected (INVALID_ARGUMENT),
    // so raising maxOutputTokens is the only lever for the bigger models —
    // at a latency cost this workload cannot absorb.
    model: env('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
    get enabled(): boolean {
      return Boolean(this.apiKey);
    },
  },
  llm: {
    // Anthropic-compatible endpoint. Defaults to Anthropic direct, but any
    // compatible gateway works by pointing ANTHROPIC_BASE_URL at it (e.g.
    // https://agentrouter.org). A trailing slash is tolerated — it is
    // stripped before the /v1/messages path is appended, because
    // `https://host//v1/messages` 404s on most gateways.
    baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''),
    // Two credential styles, matching the Anthropic SDK / Claude Code
    // convention. A gateway generally issues a bearer token; Anthropic direct
    // issues an x-api-key. Whichever is set decides the header (see llm.ts).
    apiKey: env('ANTHROPIC_API_KEY'),
    authToken: env('ANTHROPIC_AUTH_TOKEN'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    get enabled(): boolean {
      return Boolean(this.apiKey || this.authToken);
    },
    /** Which credential is in play — surfaced by /health for debugging. */
    get authStyle(): 'bearer' | 'api-key' | 'none' {
      if (this.authToken) return 'bearer';
      if (this.apiKey) return 'api-key';
      return 'none';
    },
  },
  payments: {
    network: env('PAYMENT_NETWORK', 'base-sepolia'),
    chainId: Number(env('PAYMENT_CHAIN_ID', '84532')),
    rpcUrl: env('BASE_SEPOLIA_RPC_URL', 'https://sepolia.base.org'),
    asset: env('PAYMENT_ASSET_ADDRESS', ''),
    assetSymbol: env('PAYMENT_ASSET_SYMBOL', 'USDC'),
    assetDecimals: Number(env('PAYMENT_ASSET_DECIMALS', '6')),
    payTo: env('PAYMENT_PAY_TO', ''),
    confirmations: Number(env('PAYMENT_CONFIRMATIONS', '1')),
    vaultKey: env('WALLET_ENCRYPTION_KEY', ''),
  },
  telegraph: {
    // The node whose engine we both register with (miner surface) and now
    // CONSUME (Redflag buys answers from other miners through it).
    nodeUrl: env('TELEGRAPH_NODE_URL', 'https://devnode.telegraphprotocol.com'),
    // Dedicated Base Sepolia wallet that pays miner calls via x402. Needs
    // testnet USDC; x402 signatures are gasless (EIP-3009), so no ETH burn.
    privateKey: env('TELEGRAPH_PRIVATE_KEY'),
    chainId: Number(env('TELEGRAPH_CHAIN_ID', '84532')),
    // Per-report ceiling on miner spend. Each check that would exceed the
    // remaining budget is skipped BEFORE payment — never mid-flight.
    maxSpendUsd: Number(env('REDFLAG_MAX_SPEND_USD', '0.08')),
    // Repeated checks on the same subject reuse the cached signal instead of
    // paying twice; job news does not go stale in minutes.
    cacheTtlSec: Number(env('TELEGRAPH_CACHE_TTL_SEC', '300')),
    // ── standing watches ────────────────────────────────────────────────────
    // A watch re-checks a company's news on this cadence (hours). One news
    // check per tick per company.
    watchIntervalHours: Number(env('REDFLAG_WATCH_INTERVAL_HOURS', '6')),
    // Most one company's tick may cost (the probed price must fit).
    watchCheckBudgetUsd: Number(env('REDFLAG_WATCH_CHECK_BUDGET_USD', '0.02')),
    // Ceiling on TOTAL miner spend per poller tick across all watches — a
    // hundred subscribers must not drain the wallet in one sweep.
    watchTickBudgetUsd: Number(env('REDFLAG_WATCH_TICK_BUDGET_USD', '0.20')),
    // How often the poller wakes to look for due watches.
    watchPollMinutes: Number(env('REDFLAG_WATCH_POLL_MINUTES', '15')),
    get enabled() {
      return Boolean(this.nodeUrl && this.privateKey);
    },
  },
  gmail: {
    clientId: env('GMAIL_CLIENT_ID'),
    clientSecret: env('GMAIL_CLIENT_SECRET'),
    refreshToken: env('GMAIL_REFRESH_TOKEN'),
    get enabled() {
      return Boolean(this.clientId && this.clientSecret && this.refreshToken);
    },
  },
  dbPath: env('DATABASE_PATH', 'legwork.db'),
  // Durable working directory. Deliverable artifacts live here rather than in
  // the OS temp dir — they are dispute evidence and must outlive a reboot.
  dataDir: env('DATA_DIR', '.'),
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
};

/** Which LLM backend is actually in play. Gemini wins when its key is set. */
export type LlmProvider = 'gemini' | 'anthropic' | 'none';

export function llmProvider(): LlmProvider {
  if (config.gemini.enabled) return 'gemini';
  if (config.llm.enabled) return 'anthropic';
  return 'none';
}

/** The model that will actually be requested, whichever provider is active. */
export function activeLlmModel(): string {
  return llmProvider() === 'gemini' ? config.gemini.model : config.llm.model;
}

/** Human-readable endpoint for /health — never includes the credential. */
export function activeLlmEndpoint(): string {
  return llmProvider() === 'gemini' ? config.gemini.baseUrl : config.llm.baseUrl;
}

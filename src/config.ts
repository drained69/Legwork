import 'dotenv/config';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  telegram: {
    token: env('TELEGRAM_BOT_TOKEN'),
    username: env('TELEGRAM_BOT_USERNAME', 'LegworkBot'),
  },
  okx: {
    agentId: env('OKX_AGENT_ID', 'legwork-dev'),
    // Railway/Render/Heroku inject PORT and route public traffic to it; prefer
    // it, then fall back to an explicit OKX_ENDPOINT_PORT, then the default.
    endpointPort: Number(env('PORT') || env('OKX_ENDPOINT_PORT', '8402')),
    inboundSecret: env('OKX_INBOUND_SECRET'),
    // Public base URL of this deployment (used as the x402 `resource` field).
    publicUrl: env('PUBLIC_URL', ''),

    // ── marketplace polling (the seller side of the task protocol) ─────────
    // Numeric ERC-8004 agent id of the ASP identity, e.g. "6658". Tasks are
    // routed to this id; without it the poller cannot act and stays off.
    aspAgentId: env('OKX_ASP_AGENT_ID', ''),
    // onchainos home holding the SERVICE's wallet session (not a user's).
    home: env('OKX_ONCHAINOS_HOME', ''),
    // How often to pull the task list. Tasks expire on the backend's clock,
    // so this is the single most important number in this file.
    pollIntervalMs: Number(env('OKX_POLL_INTERVAL_MS', '30000')),
    // Apply on-chain to tasks that already designate this agent as provider.
    // Off → the poller only opens the chat and waits for a human.
    autoApply: env('OKX_AUTO_APPLY', 'true') !== 'false',
    // Never auto-apply above this budget — a large task deserves a human look.
    maxAutoApplyBudget: Number(env('OKX_MAX_AUTO_APPLY_BUDGET', '10')),
    // Auto-run the hunt and submit the deliverable once escrow is funded.
    autoDeliver: env('OKX_AUTO_DELIVER', 'true') !== 'false',
    // Log what the poller WOULD claim without touching the chain. Use this to
    // verify wiring on a live account before letting it act.
    dryRun: env('OKX_POLL_DRY_RUN') === 'true',
    // X Layer. Used for the online-status heartbeat.
    chainIndex: Number(env('OKX_CHAIN_INDEX', '196')),
    // Is a proxy we control terminating connections in front of this process?
    // Only then may X-Forwarded-For contribute to the rate-limit identity —
    // otherwise any caller can set the header and mint unlimited free calls.
    // Railway/Fly/Render all front the container, so this defaults on there.
    trustProxy: env('TRUST_PROXY', 'false') === 'true',
  },
  adzuna: {
    appId: env('ADZUNA_APP_ID'),
    appKey: env('ADZUNA_APP_KEY'),
    country: env('ADZUNA_COUNTRY', 'us'),
    get enabled() {
      return Boolean(this.appId && this.appKey);
    },
  },
  usajobs: {
    apiKey: env('USAJOBS_API_KEY'),
    userAgent: env('USAJOBS_USER_AGENT', 'legwork@example.com'),
    get enabled() {
      return Boolean(this.apiKey);
    },
  },
  llm: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    get enabled() {
      return Boolean(this.apiKey);
    },
  },
  x402: {
    // Chain the agent accepts payment on (CAIP-2). X Layer mainnet by default.
    network: env('X402_NETWORK', 'eip155:196'),
    // ERC-20 the agent accepts (set the real USDC/USDT contract before listing).
    asset: env('X402_ASSET_ADDRESS', '0x0000000000000000000000000000000000000000'),
    assetSymbol: env('X402_ASSET_SYMBOL', 'USDC'),
    assetDecimals: Number(env('X402_ASSET_DECIMALS', '6')),
    // EIP-712 domain of the payment token — buyer CLIs need `name` to sign
    // `exact` + EIP-3009. Must match the token contract's EIP712Domain exactly.
    assetName: env('X402_ASSET_NAME', 'USD₮0'),
    assetVersion: env('X402_ASSET_VERSION', '2'),
    // The agent wallet address payments settle to.
    payTo: env('X402_PAY_TO', '0x0000000000000000000000000000000000000000'),
    // x402 facilitator for signature verification + on-chain settlement.
    facilitatorUrl: env('X402_FACILITATOR_URL', ''),
    // Dev/test ONLY: accept structurally-valid payments without settlement.
    devAcceptUnverified: env('X402_DEV_ACCEPT_UNVERIFIED') === 'true',
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
};

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
  gmail: {
    clientId: env('GMAIL_CLIENT_ID'),
    clientSecret: env('GMAIL_CLIENT_SECRET'),
    refreshToken: env('GMAIL_REFRESH_TOKEN'),
    get enabled() {
      return Boolean(this.clientId && this.clientSecret && this.refreshToken);
    },
  },
  dbPath: env('DATABASE_PATH', 'legwork.db'),
};

// ── Core domain types ──────────────────────────────────────────────────────

export interface Profile {
  userId: string; // telegram user id
  name: string;
  targetRoles: string[];
  seniority: string; // e.g. "junior" | "mid" | "senior" | "staff"
  locations: string[]; // includes "remote" if acceptable
  remoteOk: boolean;
  compFloor: number; // annual, USD
  skills: string[];
  resumeText: string; // pasted resume / structured summary ('' for hunt-only)
  dealbreakers: string[];
  factors?: string[]; // user-stated priorities ("4-day week", "equity", "healthcare") — scored on the culture axis
  threshold: number; // 0-100 score gate, default 70
  dailyCap: number; // max match cards per day
  email?: string; // address applications are sent from/for
  wallet?: string; // linked X Layer (EVM) address — settlement + identity
  updatedAt?: string;
}

export interface Posting {
  id: string; // stable hash
  source: string; // adzuna | usajobs | mock
  externalId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  compMin?: number;
  compMax?: number;
  description: string;
  url: string;
  atsHint?: string; // workday | greenhouse | lever | email | unknown
  fetchedAt: string;
}

export interface ScoreBreakdown {
  skills: { score: number; max: 40; reason: string };
  comp: { score: number; max: 20; reason: string };
  location: { score: number; max: 15; reason: string };
  seniority: { score: number; max: 15; reason: string };
  culture: { score: number; max: 10; reason: string };
  total: number; // 0-100
}

export interface Draft {
  id: string;
  postingId: string;
  userId: string;
  version: number;
  resumeText: string;
  coverLetter: string;
  emailSubject: string;
  emailBody: string;
  createdAt: string;
  immutable: boolean; // set true once approved (dispute evidence)
}

export type ApplicationStatus =
  | 'pending_approval'
  | 'approved'
  | 'submitted'
  | 'skipped'
  | 'failed'
  | 'interview'
  | 'rejected';

export interface Application {
  id: string;
  userId: string;
  engagementId: string;
  postingId: string;
  draftId?: string;
  status: ApplicationStatus;
  score: number;
  breakdown: ScoreBreakdown;
  approvalAt?: string;
  submittedAt?: string;
  receipt?: string; // what/where/when evidence
  skipReason?: string;
  createdAt: string;
}

// ── OKX marketplace types ──────────────────────────────────────────────────

export type EngagementStatus =
  | 'awaiting_link' // OKX task assigned, waiting for /start <taskcode>
  | 'onboarding'
  | 'active'
  | 'paused'
  | 'delivering'
  | 'settled'
  | 'disputed';

export interface Engagement {
  id: string;
  okxJobId: string; // the OKX task marketplace job id
  okxBuyerAgentId?: string;
  taskCode: string; // one-time deep-link code
  userId?: string; // bound telegram user (after /start)
  listing: string; // e.g. "job-hunt" | "job-search-sprint-7d"
  status: EngagementStatus;
  startedAt: string;
  endsAt?: string;
  shortlist?: string; // last hunt shortlist (full breakdowns) — the OKX deliverable for hunt listings
}

export interface OkxEnvelope {
  agentId?: string;
  msgType?: string; // "a2a-agent-chat"
  jobId?: string;
  sender?: { role?: string; agentId?: string };
  message?: {
    source?: string; // "system"
    event?: string; // task_assigned | task_accepted | delivery_accepted | dispute_opened ...
    jobId?: string;
    [k: string]: unknown;
  };
  parts?: Array<{ kind: string; text?: string }>;
  [k: string]: unknown;
}

export interface PaymentEvent {
  id: string;
  engagementId?: string;
  okxJobId?: string;
  kind: string; // escrow | settle | refund | x402_charge
  amount?: string;
  currency?: string;
  raw: string;
  at: string;
}

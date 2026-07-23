// ── Core domain types ──────────────────────────────────────────────────────

export interface Profile {
  userId: string; // telegram user id

  // ── identity & contact ───────────────────────────────────────────────────
  name: string;
  email?: string; // address applications are sent from/for
  phone?: string;
  currentLocation?: string;
  wallet?: string; // X Layer address, proven via OKX email login — settlement + identity
  walletEmail?: string; // OKX account email the wallet was verified with

  // ── professional standing ────────────────────────────────────────────────
  currentTitle?: string;
  yearsExperience?: number;
  seniority: string; // "junior" | "mid" | "senior" | "staff" | "principal"
  skills: string[];
  resumeText: string; // pasted resume / structured summary ('' for hunt-only)
  education?: string; // highest degree + field
  certifications?: string[];
  languages?: string[];

  // ── links ────────────────────────────────────────────────────────────────
  linkedin?: string;
  github?: string;
  portfolio?: string;

  // ── what they want ───────────────────────────────────────────────────────
  targetRoles: string[];
  locations: string[]; // includes "remote" if acceptable
  remoteOk: boolean;
  compFloor: number; // annual, USD — the hard floor used in scoring
  compTarget?: number; // aspirational, shown in tailoring
  employmentTypes?: string[]; // full-time | contract | part-time | internship
  industries?: string[];
  companySizes?: string[]; // startup | scaleup | enterprise
  factors?: string[]; // priorities ("4-day week", "equity") — scored on the culture axis
  dealbreakers: string[];

  // ── eligibility & availability ───────────────────────────────────────────
  workAuthorization?: string; // e.g. "US citizen", "EU work permit"
  needsSponsorship?: boolean;
  willingToRelocate?: boolean;
  noticePeriod?: string; // e.g. "2 weeks", "immediate"
  availableFrom?: string; // ISO date or free text

  // ── engine settings ──────────────────────────────────────────────────────
  threshold: number; // 0-100 score gate
  dailyCap: number; // max match cards per day
  updatedAt?: string;
}

/** One billable/served API call made on a user's behalf. */
export interface UsageRecord {
  id: string;
  userId: string;
  engagementId?: string;
  wallet?: string;
  service: string; // job-hunt | score-posting | tailor-application | preview
  endpoint: string;
  priceUsd: string;
  paid: boolean; // false = covered by a prepaid engagement
  status: number;
  at: string;
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
  | 'disputed'
  | 'closed'; // terminal on the marketplace: expired / closed / refunded

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

  // ── marketplace mirror (written by the poller) ───────────────────────────
  title?: string; // buyer's task title
  brief?: string; // buyer's task description — the hunt criteria source
  budget?: string; // task budget, e.g. "0.25"
  currency?: string; // USDT | USDG
  okxStatusCode?: number; // last seen on-chain status (see TaskStatus)
  claimedAt?: string; // contact-user succeeded
  appliedAt?: string; // apply went on-chain
  deliveredAt?: string; // submit tx confirmed on-chain — says NOTHING about the payload
  /**
   * The buyer can actually retrieve the deliverable: it is persisted locally
   * and the `[intent:deliver]` message reached their agent. Tracked separately
   * from `deliveredAt` because the two legs fail independently — an on-chain
   * submit with no payload is the "empty submission" the buyer rejects.
   */
  deliverableSentAt?: string;
  deliverableFile?: string; // local .md artifact submitted as the deliverable
  /**
   * We asked the buyer for criteria the marketplace never supplied. Recorded so
   * the ask happens once — the task list is polled every 30s, and repeating the
   * question on every tick would read as a malfunctioning bot.
   */
  criteriaRequestedAt?: string;
  /** We told the buyer a hunt matched nothing. Same once-only reasoning. */
  noMatchNoticeAt?: string;
  /**
   * First tick on which the task was seen escrow-funded (`accepted`). Anchors
   * the criteria-wait watchdog: a funded task must never idle unbounded on a
   * question the buyer's agent may not surface — the buyer's poller aborts
   * near its deadline and the escrow comes back locked, rated as silence.
   */
  acceptedSeenAt?: string;
  /** Mid-wait reminder sent (once) before falling back to provisional delivery. */
  criteriaNudgeAt?: string;
  /** Last time the buyer's chat added to the brief — drives post-delivery refresh. */
  briefUpdatedAt?: string;
  /** A refreshed shortlist was chatted after a post-delivery brief reply. Once only. */
  refreshSentAt?: string;
  /** sentAt of the newest XMTP chat message already merged into the brief. */
  chatIngestedThrough?: string;
}

export interface OkxEnvelope {
  agentId?: string;
  msgType?: string; // "a2a-agent-chat"
  jobId?: string;
  sender?: { role?: string; agentId?: string };
  message?: {
    source?: string; // "system"
    // OKX task events: job_created | job_asp_selected | job_accepted |
    // job_submitted | job_completed | job_rejected | job_expired | …
    event?: string;
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

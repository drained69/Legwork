// ── Core domain types ──────────────────────────────────────────────────────

export interface Profile {
  userId: string; // telegram user id

  // ── identity & contact ───────────────────────────────────────────────────
  name: string;
  email?: string; // address applications are sent from/for
  phone?: string;
  currentLocation?: string;
  wallet?: string; // Base Sepolia address managed through the Telegram wallet flow

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
  wallet?: string;
  service: string; // job-hunt | score-posting | tailor-application | preview
  endpoint: string;
  priceUsd: string;
  paid: boolean;
  transactionHash?: string;
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

export interface PaymentEvent {
  id: string;
  kind: string; // service_charge | settle | refund
  amount?: string;
  currency?: string;
  raw: string;
  at: string;
}

export interface WalletRecord {
  userId: string;
  address: string;
  encryptedPrivateKey: string;
  createdAt: string;
  imported: boolean;
}

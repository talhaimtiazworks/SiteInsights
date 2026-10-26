import type { ApplyBillingResult, NormalizedBillingEvent } from "../billing/types";
import type { ProfessionalData, ProfessionalDataInput } from "../professional/types";

/**
 * Account data (Supabase Auth users). Implemented by the PostgreSQL repository
 * only — accounts require a durable database.
 */
export interface Profile {
  id: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ThemePreference = "system" | "light" | "dark";

export interface UserSettings {
  theme: ThemePreference;
  defaultBrowser: boolean;
  defaultPerformance: boolean;
  updatedAt: string | null;
}

export interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  limits: Record<string, unknown>;
}

export interface SubscriptionInfo {
  id: string;
  planId: string;
  status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  provider: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export type OrgRole = "owner" | "admin" | "member";
export const MAX_ORGANIZATION_MEMBERS = 50;
export const MAX_OWNED_ORGANIZATIONS_PER_USER = 10;

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface OrganizationSummary extends Organization {
  role: OrgRole;
  memberCount: number;
}

export interface OrganizationMember {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: OrgRole;
  joinedAt: string;
}

export interface OrganizationMemberWithOrganization extends OrganizationMember {
  organizationId: string;
}

export type OrganizationInvitationStatus = "pending" | "accepted" | "rejected" | "revoked" | "expired";
export type OrganizationInvitationEmailStatus = "not_attempted" | "accepted" | "failed" | "unknown" | "not_configured";
export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: "admin" | "member";
  status: OrganizationInvitationStatus;
  createdAt: string;
  expiresAt: string;
  invitedByUserId: string | null;
  acceptedAt: string | null;
  emailDeliveryStatus: OrganizationInvitationEmailStatus;
  emailLastAttemptAt: string | null;
  emailErrorCode: string | null;
}

/** Minimal recipient view; returned only for the caller's server-confirmed email. */
export interface RecipientOrganizationInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: "admin" | "member";
  status: OrganizationInvitationStatus;
  createdAt: string;
  expiresAt: string;
  invitedByName: string | null;
  invitedByEmail: string | null;
}

/** Link-holder preview. The token itself and its hash are never returned. */
export interface OrganizationInvitationPreview extends RecipientOrganizationInvitation {
  emailDeliveryStatus: OrganizationInvitationEmailStatus;
}
export interface OrganizationActivity {
  id: string;
  event: string;
  actorName: string | null;
  actorEmail: string | null;
  subjectName: string | null;
  subjectEmail: string | null;
  prospectHostname: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AccountRepository {
  /** Creates/refreshes the profile and the `user:<id>` principal. Never overwrites a user-edited display name. */
  ensureProfile(u: { id: string; email: string | null; displayName: string | null }): Promise<Profile>;
  getProfile(userId: string): Promise<Profile | null>;
  updateProfile(userId: string, patch: { displayName?: string | null }): Promise<Profile | null>;

  /** Owner-only professional profile, services and portfolio. These methods require durable PostgreSQL storage. */
  getProfessionalData(userId: string): Promise<ProfessionalData>;
  saveProfessionalData(userId: string, data: ProfessionalDataInput): Promise<ProfessionalData>;
  getUserSettings(principalId: string): Promise<UserSettings>;
  updateUserSettings(principalId: string, patch: Partial<Omit<UserSettings, "updatedAt">>): Promise<UserSettings>;

  /** The subscription that currently grants a paid plan (live status AND a period end in the future), else null. */
  getActiveSubscription(userId: string): Promise<SubscriptionInfo | null>;
  /** Most recent paid subscription whose access ended after `since` (downgrade grace for history retention). */
  getRecentlyEndedSubscription(userId: string, since: Date): Promise<SubscriptionInfo | null>;
  /**
   * Applies one VERIFIED billing event atomically and idempotently: the
   * (provider, eventId) pair is recorded once; replays return "duplicate".
   */
  applyBillingEvent(ev: NormalizedBillingEvent): Promise<ApplyBillingResult>;
  getPlan(planId: string): Promise<PlanRow | null>;

  createOrganization(userId: string, name: string): Promise<Organization | null>;
  listOrganizations(userId: string): Promise<OrganizationSummary[]>;
  getMembership(orgId: string, userId: string): Promise<OrgRole | null>;
  memberOrganizationIds(userId: string): Promise<string[]>;
  listMembers(orgId: string): Promise<OrganizationMember[]>;
  /** One bounded query for member choices across only the caller's current organizations. */
  listMembersForUserOrganizations(userId: string): Promise<OrganizationMemberWithOrganization[]>;
  updateMemberRole(orgId: string, userId: string, role: "admin" | "member", actorUserId: string): Promise<"updated" | "not_found" | "owner" | "forbidden">;
  transferOwnership(orgId: string, fromUserId: string, toUserId: string, previousOwnerRole: "admin" | "member"): Promise<"transferred" | "not_owner" | "member_not_found">;
  /** Atomically prevents removal of the final owner and detaches their shared audits/prospects. */
  removeMember(orgId: string, userId: string, actorUserId: string): Promise<"removed" | "last_owner" | "not_found" | "forbidden">;
  countOwners(orgId: string): Promise<number>;
  renameOrganization(orgId: string, name: string, actorUserId: string): Promise<boolean>;
  deleteOrganization(orgId: string, actorUserId: string): Promise<boolean>;
  createInvitation(input: { id: string; organizationId: string; email: string; role: "admin" | "member"; tokenHash: string; invitedByUserId: string; expiresAt: Date; emailDeliveryStatus: OrganizationInvitationEmailStatus; emailErrorCode: string | null }): Promise<{ invitation: OrganizationInvitation | null; outcome: "created" | "updated" | "member_limit" | "member_exists" | "not_found" | "forbidden" }>;
  /** Reissues a fresh token/expiry for a current or expired invitation, never adds a member. */
  resendInvitation(input: { organizationId: string; invitationId: string; tokenHash: string; invitedByUserId: string; expiresAt: Date }): Promise<{ invitation: OrganizationInvitation | null; outcome: "resent" | "not_found" | "not_pending" | "member_exists" | "member_limit" | "pending_exists" | "forbidden" }>;
  /** Persist safe provider outcome codes; no provider response/message is stored. */
  updateInvitationEmailStatus(input: { organizationId: string; invitationId: string; actorUserId: string; status: OrganizationInvitationEmailStatus; errorCode: string | null }): Promise<OrganizationInvitation | null>;
  listInvitations(orgId: string): Promise<OrganizationInvitation[]>;
  listRecipientInvitations(email: string): Promise<RecipientOrganizationInvitation[]>;
  getInvitationPreview(tokenHash: string): Promise<OrganizationInvitationPreview | null>;
  acceptInvitation(tokenHash: string, userId: string, email: string): Promise<"accepted" | "not_found" | "email_mismatch" | "expired" | "not_pending" | "member_limit">;
  rejectInvitation(tokenHash: string, userId: string, email: string): Promise<"rejected" | "not_found" | "email_mismatch" | "expired" | "not_pending">;
  acceptInvitationById(invitationId: string, userId: string, email: string): Promise<"accepted" | "not_found" | "email_mismatch" | "expired" | "not_pending" | "member_limit">;
  rejectInvitationById(invitationId: string, userId: string, email: string): Promise<"rejected" | "not_found" | "email_mismatch" | "expired" | "not_pending">;
  revokeInvitation(orgId: string, invitationId: string, actorUserId: string): Promise<"revoked" | "not_found" | "forbidden">;
  listOrganizationActivity(orgId: string, limit: number): Promise<OrganizationActivity[]>;
  logOrganizationActivity(input: { organizationId: string; actorUserId: string | null; event: string; subjectUserId?: string | null; prospectId?: string | null; details?: Record<string, unknown> }): Promise<void>;
  /** Removes the account's profile, principal and everything owned by it (audits cascade). */
  deleteAccountData(userId: string): Promise<void>;

  /* ── Account feedback (012) ───────────────────────────────────────────── */

  /** Successful terminal audits only: completed | completed_with_warnings. Failed/cancelled/queued/running never count. */
  countCompletedAuditsForUser(userId: string): Promise<number>;
  /** Any recorded feedback submission, whatever its delivery outcome. */
  hasFeedbackSubmission(userId: string): Promise<boolean>;
  getFeedbackPrompt(userId: string): Promise<FeedbackPromptRow | null>;
  /**
   * Idempotent + race-safe: INSERT ... ON CONFLICT DO NOTHING. Two overlapping
   * audit completions in the same account can only ever create one invitation row.
   */
  ensureFeedbackPromptOffered(userId: string): Promise<FeedbackPromptRow>;
  /** Updates an existing invitation row (remind-later / dismiss). Never creates one. */
  setFeedbackPromptResponse(userId: string, input: { state: "remind_later" | "dismissed"; remindAfter: Date | null }): Promise<FeedbackPromptRow | null>;
  /**
   * Idempotent on (userId, idempotencyKey): a retried submit returns the existing
   * row with created=false, so the same logical feedback can never be stored — or
   * emailed — twice.
   */
  insertFeedbackSubmission(input: NewFeedbackSubmission): Promise<{ submission: FeedbackSubmissionRow; created: boolean }>;
  updateFeedbackDelivery(userId: string, submissionId: string, patch: { deliveryStatus: FeedbackDeliveryStatus; deliveryErrorCode: string | null; providerMessageId?: string | null; outcomeUncertain?: boolean }): Promise<void>;
  /** Failed deliveries that are safe to retry: excludes accepted rows AND rows whose provider outcome was uncertain (those may already have been delivered and are never blindly re-sent). Oldest first, bounded. */
  listUndeliveredFeedback(userId: string, limit: number): Promise<FeedbackSubmissionRow[]>;
}

export type FeedbackCategory = "general" | "bug" | "feature" | "other";
export type FeedbackDeliveryStatus = "pending" | "accepted" | "failed";

export interface FeedbackSubmissionRow {
  id: string;
  userId: string;
  principalId: string;
  accountEmail: string | null;
  category: FeedbackCategory;
  rating: number | null;
  message: string;
  goal: string | null;
  pageUrl: string | null;
  deliveryStatus: FeedbackDeliveryStatus;
  deliveryErrorCode: string | null;
  providerMessageId: string | null;
  /** Provider outcome could not be confirmed (e.g. timeout after DATA) — the row is NEVER re-sent. */
  outcomeUncertain: boolean;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewFeedbackSubmission {
  id: string;
  userId: string;
  principalId: string;
  accountEmail: string | null;
  category: FeedbackCategory;
  rating: number | null;
  message: string;
  goal: string | null;
  pageUrl: string | null;
  idempotencyKey: string;
}

export interface FeedbackPromptRow {
  userId: string;
  state: "offered" | "remind_later" | "dismissed";
  firstOfferedAt: string;
  remindAfter: string | null;
  updatedAt: string;
}

export const userPrincipalId = (userId: string) => `user:${userId}`;
export const isUserPrincipal = (principalId: string) => principalId.startsWith("user:");

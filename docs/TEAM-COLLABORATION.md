# Team collaboration

Team collaboration uses the existing organization/account model. The application server performs membership, role, tenant, and ownership checks in the repository transactions; no client-supplied organization or role is treated as authority. Migrations `008_team_collaboration.sql` and `009_invitation_email_delivery.sql` are source changes only: neither has been applied to any database. Review them and use the repository's approved migration process before deploying the matching server code.

## Roles and limits

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Read team details, current members, activity, and shared audits | Yes | Yes | Yes |
| Rename team | Yes | Yes | No |
| Create a pending member invitation | Yes | Yes | No |
| Accept or decline an invitation addressed to the signed-in verified email | Recipient | Recipient | Recipient |
| Create an admin invitation | Yes | No | No |
| Change a member's role | Yes | No | No |
| Remove a member | Yes | Yes, except owners/admins | No |
| Transfer ownership or delete the team | Yes | No | No |
| Leave the team | Yes, if another owner remains | Yes | Yes |

A team is limited to 50 current members plus pending invitations. One account may own up to 10 teams. The final owner cannot leave or be removed; transfer ownership or delete the team first. Ownership changes and membership mutations re-check the actor and target under a transaction lock. The prospect editor requests `/api/organizations?includeMembers=true`; the server scopes member rows to organizations the caller currently belongs to and loads them with one grouped repository query instead of one route/database lookup per team.

## Audit sharing

Audit sharing is opt-in and private by default. The `/teams` route reuses the existing organization system and invitation/member APIs; it does not create a second team store. Owners can choose a team from an audit's row menu or report/progress controls, or explicitly choose **Private — only you** to unshare it. `/dashboard/audits?scope=all` includes only audits owned by the caller or shared with organizations where the caller is a current member.

Sharing never transfers audit ownership. The audit owner alone can rename, re-run, triage, cancel, or delete it. Current team members can read the shared report, findings (including the findings-list/detail endpoints), page and link records, and other read-only evidence. Unrelated users get the same not-found response as for missing audits. PDF access still follows the existing viewer plan/credit rules; client share-link snapshots, expiry, revocation, and private-link behavior are separate and unchanged.

The server requires a validated signed-in account, checks stored audit ownership, verifies destination membership, and performs the share write with an owner predicate, a same-statement current-membership check, and an expected-current-organization compare-and-set. A stale share/unshare request returns `409` rather than silently overwriting a newer choice. The existing `audits.organization_id` foreign key uses `ON DELETE SET NULL`, so team deletion makes its audits private. Membership reads are checked live; member removal is transactional and detaches the removed owner's own audit shares. RLS's existing `can_read_audit` policy and child-table policies independently restrict direct Supabase reads of audits and evidence to the owner or a current member of the shared organization. No new migration was required for this UI/API follow-up.

Coverage includes private-by-default, explicit share/unshare, stale and competing share updates, read-only member access, member removal, team deletion, evidence reads, outsider denial, and persistence filtering. The memory/API tests run locally; the real Supabase/Postgres and RLS suites are opt-in and require a disposable test project/database. These external suites were not run in the local Phase 4 verification.

## Invitations and email configuration

Creating an invitation creates a pending record; it never inserts a team membership. This applies equally to existing SiteInsights accounts and new addresses. A recipient can see invitations in **Teams → Invitation inbox**, and can accept or decline only while signed in with the same server-confirmed, verified email address the invitation targets. Acceptance checks the email and current invitation state inside an organization-locked database transaction; a rejected, expired, revoked, or already-answered invitation does not grant access. The legacy direct-add members POST is retained only as an authorization-checked `410 invitation_required` response.

Invitation bearer tokens are 32 random bytes, stored as SHA-256 hashes, and have a seven-day expiry. The token-link preparation/preview endpoints keep the raw token in the URL fragment and exchange it for a short-lived HttpOnly, API-scoped hash cookie. The public review page shows the team, role, invited address, inviter, and expiry, then requires an explicit accept or decline. Authentication continuation is restricted to the fixed `/teams/invitation` path. Normal new registrations continue through professional-profile setup; existing sign-ins are not forced through onboarding.

**Outbound team email is intentionally not configured.** The existing Mailjet/Nodemailer code is reserved for operator diagnostics and is not imported by the app runtime. Creating an invitation therefore returns `emailDelivery.status = not_configured`; no notification is sent and no email delivery is claimed. Recipients can still respond through their authenticated in-app inbox. Owner/admin resend attempts return `503 email_not_configured` without changing the invitation; the settings UI states that resend is unavailable. Revoke and status management remain available. No email link is currently delivered; enable a separate, reviewed transactional-mail path before claiming email delivery or exposing a resend control.

Unit tests cover token entropy/hash format, expiry, cookie scope and fragment handling, dynamic preview, confirmed-email lookup, invitation creation/role authorization, explicit responses, decline/replay/error mapping, direct-add rejection, delivery-status fallback, and SQL transaction invariants. Audit API tests continue to cover private-by-default isolation and current-member read-only access. The optional real Supabase/Postgres and RLS suites require a disposable test project/database and were not run in the local verification. No migration was applied, and no external email, production service, or production database was contacted.

## Prospect collaboration and privacy

Prospects remain owned by the user who created/imported them and count against that owner's existing plan limit. New prospects are private by default. Only the owner can explicitly share or unshare a prospect with a team or delete it. Sharing exposes the complete prospect record—including notes, contact details and attached audit evidence—to current team members. The owner of a prospect can assign it to a current member; team owners and admins can also change assignments. Team members can update shared prospect details/status when their own plan permits prospect editing, but cannot change sharing, reassign, or delete another owner's record.

No contact data is discovered, scraped, inferred, or sent automatically. Team members lose visibility when membership ends. A departing owner's shared prospects become private; other members' shared prospects stay shared but are unassigned if assigned to the departing member. Deleting a team returns all its prospects to their owners' private lists. Team activity records collaboration events but does not record free-text notes or contact values.

The Data API receives no direct access to invitation/activity tables. The app uses the server database connection and checks current membership for reads and transactional writes. Prospect writes, billing/plan limits, credits, and audit ownership remain governed by their existing services and policies.

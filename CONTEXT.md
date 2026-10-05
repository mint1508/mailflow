# Mailflow Internal cPanel

This context describes the people, mailboxes, and administrative concepts in the
internal mail application. It keeps product language separate from Mailflow's
existing implementation names.

## Language

**App User**:
A person who can sign in to the application and is assigned one application role.
_Avoid_: Account, email account

**Mailbox**:
An email address hosted by cPanel with its own login, quota, and lifecycle state.
_Avoid_: User, app account

**Mailbox Connection**:
The application's authenticated access to a Mailbox for reading and sending mail.
_Avoid_: Mailbox, user

**Mailbox Membership**:
A grant that allows an App User to access a Mailbox with either Read or Read & Send permission.
_Avoid_: Ownership, role

**Personal Mailbox**:
A Mailbox whose membership is intended for one App User.

**Shared Mailbox**:
A Mailbox with memberships for multiple App Users.

**System Mailbox**:
The reserved Mailbox used by the application for activation and operational messages.

**Owner**:
The single highest privilege role that controls connector settings, roles, permissions, and permanent deletion.
_Avoid_: Super admin, emergency admin

**Mod**:
An operational role whose permissions are granted individually by the Owner.
_Avoid_: Admin

**Member**:
The standard role for an App User who accesses personal and assigned Shared Mailboxes.

**Activation Link**:
A single use link that lets a newly provisioned App User establish access without exposing a plaintext password to a Mod.

**Pending Deletion**:
The 30 day period after suspension and before an Owner may permanently delete a Mailbox.

**Branding Profile**:
The organization controlled app name, short name, logo, and primary color shown by the web app and PWA.

**Storage Lite**:
The retention policy that keeps mail metadata on the VPS while limiting cached message bodies by age and total size.

## File storage context

**File User**:
An App User who is entitled to use the file-management PWA. File access follows the App User's active Mailflow/cPanel lifecycle; it is not a second identity.
_Avoid_: Storage account, Google account

**File Home**:
The private logical root of one File User's files. It is represented by a dedicated folder in the configured Google Drive storage account, but users access it only through the PWA.
_Avoid_: Drive account, shared folder

**Storage Account**:
The dedicated Google account whose Drive holds the organization's pilot file bytes. It is an infrastructure credential, never an end-user identity.
_Avoid_: User account, File User

**Storage Adapter**:
The backend boundary that translates file operations into the configured storage provider's API while enforcing authorization, quota, idempotency and audit rules.
_Avoid_: Drive client in the browser

**File Usage**:
The committed logical bytes owned by a File User, including items in Trash until purge. In-flight upload reservations are tracked separately and count against available quota.
_Avoid_: Google Drive total, disk usage

**File Quota**:
The storage allowance assigned by a File administrator to a File User. It is separate from the cPanel Mailbox quota, even though mailbox lifecycle status gates file access.
_Avoid_: Mailbox quota, Google quota

**File Reservation**:
Temporary quota held for an upload or restore that has not yet been committed by the storage provider. Reservations prevent concurrent operations from crossing a user's hard quota.
_Avoid_: Upload progress

**File Lifecycle**:
The file state sequence `active -> trashed -> purged`, with restore allowed from `trashed` during retention. It is independent from the cPanel mailbox lifecycle, although access is gated by that lifecycle.
_Avoid_: Google Drive lifecycle

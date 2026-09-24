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


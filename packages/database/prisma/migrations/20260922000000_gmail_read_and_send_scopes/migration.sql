-- Migration 40: the Gmail capability's scopes (GM-1).
--
-- Architecture: docs/architecture/daily-loop-employee-intelligence.md 8.x and
-- docs/architecture/google-workspace-connection.md 11. Additive and reversible: it widens one
-- CHECK constraint and adds no table, column or index.
--
-- WHAT CHANGED AND WHY. Gmail's capability was `gmail.metadata`, which Google's scope reference
-- defines as "labels and headers, but not the email body". An employee reading and answering
-- correspondence inside Loop needs the body, and sending the reply is a separate grant again:
--
--   gmail.readonly  RESTRICTED. The narrowest scope that returns a body. `gmail.modify` and
--                   `mail.google.com/` also return one and additionally grant writing and
--                   deleting somebody's mailbox, which Loop must never hold.
--   gmail.send      SENSITIVE. Sends as the connected person and can do nothing else -- it
--                   cannot read, label, delete or draft. `gmail.compose` would also cover
--                   drafts and is RESTRICTED, so Loop keeps drafts in its own store instead.
--
-- `gmail.metadata` STAYS PERMITTED, for rows written before this migration. It no longer covers
-- the Gmail capability, so such a connection reports INSUFFICIENT_SCOPE until the person
-- reconnects -- an honest prompt rather than a row the database would now refuse. Nothing
-- rewrites an existing grant: Loop stores what Google granted, and only Google can change that.
--
-- STILL ABSENT, DELIBERATELY: gmail.modify, gmail.labels, gmail.insert, gmail.settings.*,
-- mail.google.com/. Loop keeps its own work state and never writes to a mailbox.

ALTER TABLE "google_connections" DROP CONSTRAINT "google_connections_scopes_check";

ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_scopes_check"
  CHECK (
    "grantedScopes" IS NOT NULL
    AND "requestedScopes" IS NOT NULL
    AND "grantedScopes" <@ ARRAY[
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]::TEXT[]
    AND "requestedScopes" <@ ARRAY[
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]::TEXT[]
  );

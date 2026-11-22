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
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]::TEXT[]
    AND "requestedScopes" <@ ARRAY[
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]::TEXT[]
  );

ALTER TABLE "google_oauth_states" DROP CONSTRAINT "google_oauth_states_capabilities_check";
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_capabilities_check"
  CHECK (
    "capabilities" IS NOT NULL
    AND cardinality("capabilities") BETWEEN 1 AND 4
    AND "capabilities" <@ ARRAY['gmail', 'calendar', 'drive', 'booking']::TEXT[]
    AND cardinality(array_positions("capabilities", 'gmail')) <= 1
    AND cardinality(array_positions("capabilities", 'calendar')) <= 1
    AND cardinality(array_positions("capabilities", 'drive')) <= 1
    AND cardinality(array_positions("capabilities", 'booking')) <= 1
  );

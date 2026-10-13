CREATE TABLE "user" (
  id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, image text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE session (
  id uuid PRIMARY KEY, token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  ip_address text, user_agent text, user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX session_user_index ON session(user_id);
--> statement-breakpoint
CREATE TABLE account (
  id uuid PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz, scope text, password text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id, account_id)
);
--> statement-breakpoint
CREATE INDEX account_user_index ON account(user_id);
--> statement-breakpoint
CREATE TABLE verification (
  id uuid PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

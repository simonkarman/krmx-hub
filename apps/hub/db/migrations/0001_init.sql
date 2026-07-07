-- Schema per docs/ARCHITECTURE.md §5.
-- Auth.js adapter tables (users, accounts, sessions, verification_token)
-- are managed by @auth/pg-adapter and arrive with M1.

CREATE TABLE participant (
  email        TEXT PRIMARY KEY,
  username     TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','blocked')),
  roles        TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {host,admin}
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT
);

CREATE TABLE game (
  id             TEXT PRIMARY KEY,             -- slug, e.g. 'tictactoe'
  host_email     TEXT NOT NULL REFERENCES participant(email),
  name           TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','published','suspended')),
  webhook_secret TEXT NOT NULL,                -- HMAC key for provision calls
  entry_fee      INTEGER NOT NULL DEFAULT 0,   -- credits
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE game_version (
  id            SERIAL PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES game(id),
  semver        TEXT NOT NULL,
  frontend_url  TEXT NOT NULL,   -- REGISTERED ahead of time; immutable
  provision_url TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','deprecated','revoked')),
  UNIQUE (game_id, semver)
);

CREATE TABLE instance (
  id                 TEXT PRIMARY KEY,          -- e.g. nanoid
  game_version_id    INTEGER NOT NULL REFERENCES game_version(id),
  created_by         TEXT NOT NULL REFERENCES participant(email),
  visibility         TEXT NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('private','public')),
  invite_code        TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'provisioning'
                       CHECK (status IN
                         ('provisioning','lobby','running','finished','cancelled')),
  server_url         TEXT,                      -- opaque; from provision response
  service_token_hash TEXT NOT NULL,
  last_heartbeat_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);

CREATE TABLE instance_player (
  instance_id TEXT NOT NULL REFERENCES instance(id),
  email       TEXT NOT NULL REFERENCES participant(email),
  seat        INTEGER,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, email)
);

-- Append-only. Balance = SUM(amount). Only the hub writes rows.
CREATE TABLE ledger (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL REFERENCES participant(email),
  instance_id TEXT REFERENCES instance(id),
  type        TEXT NOT NULL CHECK (type IN
                ('grant','entry_hold','hold_release','payout')),
  amount      INTEGER NOT NULL,   -- entry_hold is negative
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

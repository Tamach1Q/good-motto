CREATE TABLE people (
  id TEXT PRIMARY KEY NOT NULL,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  terms_accepted_at INTEGER,
  feedback_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (feedback_opt_in IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (slack_team_id, slack_user_id)
);

CREATE TABLE places (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);
INSERT INTO places (id, name) VALUES ('kitchen', '共用キッチン'), ('laundry', '洗濯室');

-- created_at is always UTC ISO 8601 with milliseconds (Date.toISOString()).
CREATE TABLE posts (
  id TEXT PRIMARY KEY NOT NULL,
  author_person_id TEXT NOT NULL REFERENCES people(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('person', 'place')),
  target_id TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('good', 'motto')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX posts_place_counts ON posts (target_type, target_id, created_at, sentiment);
CREATE INDEX posts_weekly_period ON posts (target_type, created_at);
CREATE INDEX people_search ON people (slack_team_id, feedback_opt_in);

CREATE TABLE slack_digest_deliveries (
  person_id TEXT NOT NULL REFERENCES people(id),
  week_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  slack_ts TEXT,
  slack_channel TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, week_key)
);

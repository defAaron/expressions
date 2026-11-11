create table if not exists faces (
  id text primary key,
  status text check (status in ('drafting', 'ready', 'accepted', 'failed')),
  source_path text,
  manifest_path text,
  likeness_at timestamptz not null,
  worker_token text,
  created_at timestamptz not null default now()
);

create table if not exists face_plates (
  face_id text references faces (id) on delete cascade,
  plate text check (plate in ('curious', 'pain', 'nausea', 'gaze', 'blink')),
  status text,
  attempts int not null default 0,
  error text,
  primary key (face_id, plate)
);

-- Mimis Lux · esquema base v1
-- El corazón del negocio: personas, identidades (por canal), conversaciones,
-- mensajes, intereses y pedidos. Postgres + RLS.

-- extensiones
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- personas: la entidad central. Una fila = una persona real (no un canal).
--   telefono es el ancla canónica: 54 + área + abonado, sin el 9 de móvil
--   ni el 15 interno. Un teléfono => UNA persona.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.personas (
  id          uuid primary key default gen_random_uuid(),
  telefono    text unique,                -- ancla (nullable: puede entrar por email primero)
  nombre      text,
  email       text,
  notas       text,
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- identidades: "un canal más es una FILA, nunca una columna".
--   Cada canal (whatsapp, instagram, email) que apunta a la MISMA persona es una fila.
--   verificado = la persona demostró controlar ese canal (código OTP).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.identidades (
  id            uuid primary key default gen_random_uuid(),
  persona_id    uuid not null references public.personas(id) on delete cascade,
  canal         text not null check (canal in ('whatsapp','instagram','email','facebook')),
  external_id   text not null,            -- wa_id, ig_id, email
  verificado    boolean not null default false,
  verificado_en timestamptz,
  creado        timestamptz not null default now(),
  unique (canal, external_id)             -- una identidad por canal
);

-- ─────────────────────────────────────────────────────────────────────────────
-- conversaciones: una por persona+canal. Es el hilo que ve el humano.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.conversaciones (
  id         uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  canal      text not null,
  inicio     timestamptz not null default now(),
  ultimo     timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- mensajes: el historial inmutable. wamid = id externo para deduplicar.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.mensajes (
  id               uuid primary key default gen_random_uuid(),
  conversacion_id  uuid not null references public.conversaciones(id) on delete cascade,
  rol              text not null check (rol in ('cliente','agente','humano')),
  texto            text not null,
  wamid            text,
  creado           timestamptz not null default now()
);
create index if not exists idx_mensajes_conversacion on public.mensajes (conversacion_id, creado);

-- ─────────────────────────────────────────────────────────────────────────────
-- intereses: qué busca cada persona (CRM). Un interés = una fila (pueden ser varios).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.intereses (
  id         uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  ocasion    text,
  familia    text,                        -- dulce, cítrico, floral, amaderado…
  para_quien text,
  creado     timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- pedidos: la venta. items = jsonb (catálogo cambia, el pedido queda).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.pedidos (
  id          uuid primary key default gen_random_uuid(),
  persona_id  uuid not null references public.personas(id),
  estado      text not null default 'nuevo'
              check (estado in ('nuevo','confirmado','pagado','enviado','entregado','cancelado')),
  items       jsonb not null default '[]',
  total       numeric(12,2),
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create index if not exists idx_pedidos_persona on public.pedidos (persona_id, estado);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security: el agente y el backend entran con service_role (saltea RLS).
-- Para anon/authenticated NO hay políticas todavía => nadie sin sesión lee nada.
-- Cuando exista un portal con login, se suman políticas por persona_id.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.personas        enable row level security;
alter table public.identidades     enable row level security;
alter table public.conversaciones  enable row level security;
alter table public.mensajes        enable row level security;
alter table public.intereses       enable row level security;
alter table public.pedidos         enable row level security;

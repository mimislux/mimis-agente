# Mimis Lux · Agente de WhatsApp (Cloudflare Workers + Durable Objects)

El sistema de atención y análisis de **Mimis Lux**, una casa de perfumes de autor.

Tres agentes viven en un mismo Worker, enrutados por el **número que recibe** el mensaje
y **quién lo escribe**. Cada uno tiene su personalidad, su memoria propia y sus herramientas.

## Arquitectura

```
persona escribe a un número de WhatsApp
        │
        ▼
Meta ──webhook──▶ Worker (mimis-webhooks)  ·  verifica firma (HMAC-SHA256)
        │            ·  deduplica por wamid
        │            ·  decide QUÉ agente (según número + remitente)
        ▼
Durable Object del agente  (una instancia por persona + rol)
        │            ·  memoria en SQLite (historial de la conversación)
        │            ·  Workers AI (modelo) + herramientas
        ▼
respuesta ──▶ Meta ──▶ WhatsApp (por el MISMO número que recibió)
```

## Los tres agentes

| Agente | Número que lo activa | Quién | Personalidad |
|---|---|---|---|
| **CTO** | número de prueba | Ezequiel (…4108) | par técnico: negocio + arquitectura de eventos |
| **CEO** | número de prueba | Mia (…9410) | acompaña a la Founder en decisiones y métricas |
| **Secretaria (Lía)** | número de prueba (para testear) o el real | clientes | atención cálida, guía la compra por catálogo |

### Regla de enrutado (el corazón)

```
número de PRUEBA (gratis, laboratorio):
   Ezequiel  → CTO
   Mia       → CEO
   Mimis     → Secretaria (testeo gratis)
   otros     → no llegan (la allowlist de Meta los frena antes)

número REAL (producción, consume cuota de servicio):
   cualquiera → Secretaria
   número de prueba → NO responde (anti-bucle)
```

**Anti-bucle asimétrico:** el número real no le responde a otro número de negocio
(eso corta el loop); el número de prueba responde a todo (es el laboratorio gratis).

## Estructura

```
src/index.js     → el Worker: webhook, enrutado, envío por WhatsApp
src/agente.js    → el Durable Object: memoria SQL, prompts, herramientas
wrangler.jsonc   → bindings (AI, KV, Durable Object) + ruta
supabase/        → migraciones del esquema de la base de datos
```

## Seguridad

- **Ninguna clave en el código.** Todo va por secretos del Worker (en Cloudflare,
  de sólo escritura) o del Secrets Store (bound al Worker).
- Las rutas de diagnóstico (`/salud`, `/consumo`, `/conversaciones`) exigen
  `X-Admin-Token`.
- La base de datos usa **RLS**: cada persona ve lo suyo; el admin ve todo.

## Deploy

```bash
# empaquetar (wrangler no puede deployar directo: la cuenta usa ruta propia)
wrangler deploy --dry-run --outdir dist
# subir por API (bindings en metadata)
python ../scripts/subir.py   # (patrón de la operación)
```

## Notas

- Modelo: `@cf/openai/gpt-oss-120b` (Workers AI). El código es agnóstico de proveedor:
  se puede cambiar a otro (Venice, Gemini, etc.) tocando sólo `agente.js`.
- Costo: Workers AI gratis = 10.000 neuronas/día. El pico histórico fue un bucle
  entre dos agentes (ya corregido): no confundirlo con uso normal.

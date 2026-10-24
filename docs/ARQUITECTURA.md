# La arquitectura de eventos de Mimis Lux — el mapa de verbos

> Programar es tener claridad sobre los **verbos**: qué evento *entra*, qué acción *sale*.
> Este documento es el mapa. La regla de oro: **un webhook entra → un Worker decide → una
> petición API sale.** Eso es toda la arquitectura.

## Los dos sentidos de la comunicación

```
WEBHOOK  (lo que NOS LLEGA)      →  un evento que dispara nuestra lógica
PETICIÓN (lo que NOSOTROS ENVIAMOS) →  una acción que ejecutamos en el otro sistema
```

Cada servicio que integramos tiene **verbos de entrada** (eventos que nos manda) y
**verbos de salida** (acciones que acepta).

---

## 1 · Meta (WhatsApp Cloud API) — el canal

**Webhooks → nosotros** (todo entra por `mimis-webhooks`):

| Evento | Campo | Qué significa |
|---|---|---|
| mensaje de texto | `m.type: "text"` | la persona escribió |
| respuesta a botón | `m.interactive.button_reply` | tocó un botón |
| **pedido de catálogo** | `m.type: "order"` | armó el carrito y lo envió |
| **flow completado** | `m.interactive.type: "nfm_reply"` | terminó un Flow |
| vino de un anuncio | `m.referral` | entró por Click-to-WhatsApp → abre el **FEP** gratis |
| acuse de estado | `statuses` | sent / delivered / read |

**Acciones → nosotros enviamos:**

| Acción | Endpoint | Para qué |
|---|---|---|
| enviar mensaje | `POST /{phone}/messages` | responder, avisar |
| enviar catálogo | `interactive.type: "product_list"` | mostrar la vidriera |
| enviar un producto | `interactive.type: "product"` | mostrar un perfume |
| enviar plantilla | `type: "template"` | fuera de la ventana de 24 h |

---

## 2 · Mercado Pago / Mercado Libre — el cobro

**Webhooks → nosotros** (a `/ml/notificaciones`, en `mimis-webhooks`):

| Evento | Qué significa |
|---|---|
| `payment` | un pago cambió de estado (approved / pending / rejected) |

**Acciones → nosotros enviamos** (por `mimis-pagos`):

| Acción | Endpoint | Para qué |
|---|---|---|
| crear link de pago | `POST /checkout/preferences` | cobrar un pedido |
| leer un pago | `GET /v1/payments/{id}` | confirmar que se acreditó |
| listar pagos | `GET /v1/payments/search` | la conciliación del mes |
| reembolsar | `POST /v1/payments/{id}/refunds` | devolver plata |
| quién soy | `GET /users/me` | verificar el entorno (prod/test) |

---

## 3 · Whop — cobro internacional y comunidad

**Webhooks → nosotros** (a `mimis-whop`, con firma HMAC `{id}.{ts}.{cuerpo}`):

| Evento | Qué significa |
|---|---|
| `payment.succeeded` | el comprador pagó |
| `payment.failed` / `payment.pending` | falló / quedó pendiente |
| `membership.activated` | el acceso/membresía se activó |
| `membership.deactivated` | se desactivó |

**Acciones → nosotros enviamos** (por `mimis-whop`):

| Acción | Endpoint | Para qué |
|---|---|---|
| crear checkout | `POST /checkout_sessions` | cobrar (carrito, plan o link) |
| crear producto/plan | `POST /products`, `POST /plans` | armar la oferta |
| leer pagos/membresías | `GET /payments`, `GET /memberships` | la fuente de verdad |

---

## 4 · Cloudflare — nuestro entorno (los Workers)

| Pieza | Verbo | Para qué |
|---|---|---|
| **Worker** | `fetch` | ejecutar lógica (el "decide") |
| **Service binding** | `env.OTRO.fetch` | Worker llama a Worker, dentro de la red |
| **KV** | `get` / `put` | estado rápido (config, logs, dedup) |
| **Secrets Store** | `binding.get()` | el Worker lee la clave (write-only) |
| **Durable Object** | `storage.sql` | memoria por persona |

---

## 5 · Supabase — la base de datos (la memoria)

**Acciones** (desde un Worker): `insert` / `select` / `update` sobre `personas`,
`identidades`, `pedidos`, `intereses`. Es la **fuente de verdad del stock** y del cliente.

---

## 6 · Resend / Brevo — el correo

**Acción:** enviar email (confirmación de compra, secuencia post-venta). No tiene webhook
que nos importe acá; el "evento" es el pago aprobado que dispara el envío.

---

## 7 · Andreani / Mercado Envíos — la logística

**Acciones:** cotizar envío, crear orden, leer tracking. **Webhook:** aviso de estado del
paquete (cuando lo activemos).

---

## La cadena completa de una venta

```
anuncio (Meta) ──clic──▶ WhatsApp ──pedido del catálogo──▶ mimis-webhooks
                                                              │ (webhook m.type=order)
                                                              ▼
                                                    mimis-pagos (service binding)
                                                              │ crea preferencia
                                                              ▼
                                                    link de pago ──▶ WhatsApp
                                                              │ la persona paga
                                                              ▼
Mercado Pago ──webhook payment──▶ /ml/notificaciones ──▶ confirmación por WhatsApp
                                                              │
                                                    Supabase (stock, pedido)
                                                              │
                                                    logística (envío) ──▶ tracking
```

# ESPECIFICACIONES — Mimis Lux

> Negocio de perfumes de autor, 100% automatizado dentro de WhatsApp.
> Este documento es la fuente de verdad del plan: qué está, qué falta, y cómo se mide.

## 1 · El objetivo

Una casa de perfumes donde **todo el ciclo** —anuncio → conversación → catálogo → pedido →
cobro → envío— ocurre **dentro de WhatsApp**, con el menor costo posible:

- **El mensaje sale gratis** cuando la persona entra por anuncio (ventana FEP, 72h-7d).
- **El modelo es el único costo real**, y es centavos (Gemini gratis hoy, Venice $0.13/1M luego).
- **La infraestructura** (Workers, KV) tiene capa gratuita generosa.

## 2 · El stack (decidido)

| Capa | Pieza | Rol |
|---|---|---|
| Tráfico | **Meta** (anuncios Click-to-WhatsApp) | traer personas → abrir el FEP |
| Canal | **WhatsApp Cloud API** | conversar + catálogo + Flows |
| Vidriera | **Catálogo de Meta** (5 perfumes) | mostrar + carrito |
| Lógica | **Cloudflare Workers** (+ Pi Harness + Workflows) | unir todo (nuestro único código) |
| Estado | **KV + Durable Objects + Supabase** | memoria + datos + stock |
| Cobro Argentina | **Mercado Pago** | link de pago + conciliación |
| Cobro internacional | **Whop** | checkout + membresías + KYC |
| Identidad | **Google OAuth + Whop** | login + verificación |
| Logística | **Andreani / Mercado Envíos** | envío + tracking |
| Modelo | **Gemini (sandbox) / Venice (prod)** | el cerebro de Lía |
| Email | **Resend / Brevo** | confirmaciones |
| Secretos | **Bitwarden + Secrets Store** | llaves (legible / write-only) |

## 3 · La arquitectura (eventos + Workers)

```
Regla de oro: un webhook ENTRA → un Worker DECIDE → una petición API SALE.

                    ┌── mimis-webhooks (recibe Meta: WhatsApp/IG)
 anuncio ──clic──▶  │      │  delega por service binding
                    │      ├──▶ mimis-pagos   (Mercado Pago)
                    │      ├──▶ mimis-whop    (Whop)
                    │      └──▶ mimis-envios  (logística, por venir)
                    │
 WhatsApp ──pedido──▶ Worker ──▶ pago ──▶ webhook de pago ──▶ confirmación
                                    │
                              Supabase (stock + cliente + pedido)
```

Cada Worker es un **agente** con una responsabilidad, sus secretos y su Agent Card (README).

## 4 · Lo que ya está funcionando (medido)

- [x] Número real `1165870271` en `CLOUD_API` + `CONNECTED` (coexistencia celular+API).
- [x] Catálogo con 5 perfumes (`A1`-`E5`), todos `WHATSAPP: APPROVED`.
- [x] Agente **Lía** (Durable Object + AI), 3 modos: secretaria / CEO / CTO.
- [x] Pedido del catálogo (`m.type: "order"`) → `mimis-pagos` crea preferencia → link.
- [x] Multi-worker: `mimis-agente` + `mimis-pagos` + `mimis-whop` (service bindings).
- [x] Switch sandbox/producción por clave KV `mp:modo`.
- [x] Confirmación de pago por webhook (`/ml/notificaciones`, prueba ambos tokens).
- [x] Ventana `/payloads` para ver el JSON crudo de cada webhook.
- [x] Mensajes gratis medidos (`billable: false`, `free_tier`).
- [x] 3 repos en GitHub con Agent Cards + mapa de verbos (`docs/ARQUITECTURA.md`).

## 5 · Lo que falta (especificaciones por pieza)

### 5.1 · FEP / referral (anuncios)
- **Objetivo:** que el agente sepa cuándo una persona vino de un anuncio y aproveche la ventana gratis.
- **Cómo:** leer `m.referral.source_type === "ad"` en el primer mensaje de la conversación.
- **Medición:** capturar el primer mensaje de un clic en anuncio real → verificar que llega `referral`.

### 5.2 · Pago sandbox de punta a punta
- **Objetivo:** cerrar carrito → link → pago → webhook → confirmación, todo medido.
- **Medición:** pedido del catálogo en `mp:modo=sandbox` → abrir `sandbox.mercadopago.com.ar` →
  comprador `TESTUSER…` → tarjeta de prueba + nombre `APRO` → ver confirmación por WhatsApp.

### 5.3 · Rechazo y estados de pago
- **Medición:** misma tarjeta con nombre `OTHE` (rechazado), `CONT` (pendiente), `FUND` (sin fondos)
  → verificar que el Worker maneja cada caso (no manda "pago acreditado" si no es `approved`).

### 5.4 · Whop (checkout + webhook)
- **Objetivo:** riel internacional + membresías.
- **Medición:** `POST /checkout_sessions` en sandbox (credencial de prueba) → 201 con URL;
  webhook `POST /webhooks/{id}/test` → verificar firma HMAC válida/inválida.

### 5.5 · Supabase (la base)
- **Objetivo:** persistir cliente + pedido + stock (fuente de verdad).
- **Medición:** al recibir un pedido, escribir `persona` + `pedido`; leer de vuelta.

### 5.6 · Identidad (Google + Whop KYC)
- **Objetivo:** vincular WhatsApp ↔ Google ↔ comprador (OTP por canal).
- **Medición:** login de Google en la app → guardar `refresh_token` → vincular identidad.

### 5.7 · Pi Harness (agente durable)
- **Objetivo:** migrar Lía al Agents SDK + PiHarness (durabilidad, hibernación, recuperación).
- **Medición:** desplegar, interrumpir a mitad de tarea, verificar que retoma.

### 5.8 · Workflows (orquestación)
- **Objetivo:** encadenar pedido → cobro → confirmación → envío con reintentos.
- **Medición:** un flujo completo ejecutado y verificado de punta a punta.

### 5.9 · Logística (envío)
- **Objetivo:** cotizar + crear envío + tracking (Andreani / Mercado Envíos).
- **Medición:** cotización de un envío de prueba; tracking de un paquete.

### 5.10 · Flows (experiencia de compra)
- **Objetivo:** pedir dirección + confirmar pedido dentro de WhatsApp (sin salir).
- **Medición:** Flow completado → webhook `nfm_reply` → capturar la respuesta.

## 6 · El orden de trabajo (priorizado)

1. **FEP/referral** (medir el anuncio real) — desbloquea la venta gratis.
2. **Pago sandbox de punta a punta** (APRO + OTHE) — cierra el cobro.
3. **Supabase** (persistir pedido + cliente + stock) — la memoria.
4. **Pi Harness** (Lía durable) — el agente evolucionado.
5. **Whop** (checkout + webhook) — el riel internacional.
6. **Workflows** (orquestación) — el flujo completo.
7. **Logística + Flows** — el cierre del embudo.

## 7 · La regla de conducta (no se negocia)

- **Causa medida o no se dice.** Cada paso se verifica contra la API real, en sandbox primero.
- **Una variable por vez.** No cambiar dos cosas a la vez.
- **El error se escribe donde el próximo lo lea** (skill + vault + este doc).
- **Capacidad como servicio, nunca cuenta compartida.** Cada unidad con su infraestructura.

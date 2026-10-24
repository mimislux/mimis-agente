/**
 * mimis-webhooks — la puerta de entrada de Meta y el despachador hacia el agente.
 *
 *   Meta  --POST-->  este Worker  --fetch-->  Durable Object del agente  --LLM-->  respuesta
 *                          |                          |
 *                          |                          +-- memoria SQL por persona
 *                          +-- envía la respuesta por WhatsApp Cloud API
 *
 * El agente NO vive acá: vive en el Durable Object (src/agente.js). Acá sólo se
 * verifica la firma, se deduplica y se despacha — una responsabilidad por pieza.
 */
export { Agente } from "./agente.js";

const API = "https://graph.facebook.com/v21.0";

async function hmacHex(secreto, cuerpo) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secreto),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(cuerpo));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function igualSeguro(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Verifica la firma de los webhooks de Whop (Standard Webhooks). El string firmado es
// "{webhook-id}.{webhook-timestamp}.{cuerpo crudo}" con HMAC-SHA256, y el secreto es ws_<base64>.
// La clave se deriva de tres formas (base64-decode, UTF-8, o el secreto completo): se acepta
// la que matchee, así el verificador queda robusto sin abrir nada.
async function verificarWhop(req, env) {
  const id = req.headers.get("webhook-id");
  const ts = req.headers.get("webhook-timestamp");
  const sig = req.headers.get("webhook-signature");
  if (!id || !ts || !sig) return { ok: false, motivo: "faltan headers" };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { ok: false, motivo: "fuera de ventana" };
  const secreto = env.WHOP_WEBHOOK_SECRET;
  if (!secreto) return { ok: false, motivo: "sin secreto" };
  const enc = new TextEncoder();
  const cuerpo = await req.clone().text();
  const firmado = `${id}.${ts}.${cuerpo}`;
  const variantes = [];
  if (secreto.startsWith("ws_")) {
    const base = secreto.slice(3);
    try { variantes.push(Uint8Array.from(atob(base), c => c.charCodeAt(0))); } catch (e) {}
    variantes.push(enc.encode(base));
  }
  variantes.push(enc.encode(secreto));
  const firmas = sig.split(" ").map(s => (s.startsWith("v1,") ? s.slice(3) : s));
  for (const clave of variantes) {
    const key = await crypto.subtle.importKey("raw", clave, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(firmado));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    if (firmas.some(f => igualSeguro(b64, f))) return { ok: true };
  }
  return { ok: false, motivo: "firma inválida" };
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// Rutas de diagnóstico y datos: SOLO con el token de admin (nunca públicas).
// Un endpoint abierto que devuelve conversaciones es una puerta para cualquiera.
const ADMIN_PATHS = ["/salud", "/conversaciones", "/consumo", "/threads/estado", "/mp/whoami", "/mp/payments", "/mp/token", "/payloads"];

// Números de negocio propios (forma canónica). Un número de negocio NUNCA le responde
// a otro número de negocio: si no, los dos agentes se contestan en bucle infinito.
const NUMEROS_PROPIOS = new Set(["15556726293", "541165870271"]);

// Tres identidades de agente, según QUIÉN escribe (el 'from'):
const QUIEN_ES = {
  "541137684108": "arquitecto",   // Ezequiel (personal)
  "541135169410": "ceo",          // Mia
};

const soloDigitos = (s) => String(s || "").replace(/\D/g, "");

// Forma canónica: 54 + área + abonado, sin el 9 de móvil ni el 15 interno.
// Así 5491137684108, 541137684108 y 54111537684108 caen en la MISMA memoria.
function canonico(wa) {
  let d = soloDigitos(wa);
  if (d.startsWith("54")) {
    let cuerpo = d.slice(2);
    if (cuerpo.startsWith("9")) cuerpo = cuerpo.slice(1);
    return "54" + cuerpo;
  }
  return d;
}

// Para el envío saliente: la lista de autorizados del número de prueba puede guardar
// el número con el 15 (54 11 15 …). Se prueban las formas hasta que una devuelva 200.
function candidatos(wa) {
  const d = soloDigitos(wa);
  const set = [d];
  if (d.startsWith("54")) {
    let cuerpo = d.slice(2);
    if (cuerpo.startsWith("9")) cuerpo = cuerpo.slice(1);
    const canon = "54" + cuerpo;
    if (!set.includes(canon)) set.push(canon);
    if (cuerpo.length >= 4) {
      const con15 = "54" + cuerpo.slice(0, 2) + "15" + cuerpo.slice(2);
      if (!set.includes(con15)) set.push(con15);
    }
  }
  return set;
}

async function enviarWhatsApp(env, para, texto, pnid) {
  let ultimoError = null;
  for (const destino of candidatos(para)) {
    const r = await fetch(`${API}/${pnid || env.WHATSAPP_PNID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual",
        to: destino, type: "text", text: { preview_url: true, body: texto },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, id: d?.messages?.[0]?.id || null, destino, error: null };
    ultimoError = d?.error || null;
  }
  return { ok: false, id: null, destino: null, error: ultimoError };
}

async function atenderWhatsApp(entry, env) {
  const out = [];
  for (const cambio of (entry.changes || [])) {
    const v = cambio.value || {};
    for (const m of (v.messages || [])) {
      const de = m.from;
      const pnid = v.metadata?.phone_number_id || env.WHATSAPP_PNID;
      const clave = canonico(de);
      const esTest = pnid === "1369968432871135";
      // Anti-bucle ASIMÉTRICO:
      //   · el número REAL (producción) NO responde a mensajes de otros números de negocio.
      //   · el número de PRUEBA (laboratorio) SÍ responde a todo, para testear gratis.
      if (!esTest && NUMEROS_PROPIOS.has(clave)) {
        out.push({ de: clave, salteado: "numero-propio" });
        continue;
      }
      // El agente depende del número que RECIBE:
      //   · prueba = laboratorio (CTO para Ezequiel, CEO para Mia, secretaria para el resto)
      //   · real   = SIEMPRE la secretaria (clientes), lo mande quien lo mande
      const modo = esTest ? (QUIEN_ES[clave] || "publico") : "publico";
      const wamid = m.id;
      const nombre = v.contacts?.[0]?.profile?.name || null;
      let texto = m.text?.body || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || m.button?.text || "";
      let pedido = null;
      if (m.type === "order" && m.order) {
        const items = m.order.product_items || [];
        const detalle = items.map(it => `${it.quantity || 1}x ${it.product_retailer_id} ($${it.item_price} ${it.currency})`).join(", ");
        const total = items.reduce((acc, it) => acc + (Number(it.item_price || 0) * Number(it.quantity || 1)), 0);
        const moneda = items[0]?.currency || "ARS";
        pedido = { catalog_id: m.order.catalog_id, items, total, moneda, text: m.order.text || null };
        texto = `[PEDIDO DE CATÁLOGO: ${detalle} | Total: $${total} ${moneda}${m.order.text ? ` | Nota: ${m.order.text}` : ""}]`;
      } else if (m.interactive?.type === "nfm_reply" && m.interactive?.nfm_reply) {
        texto = `[FLOW COMPLETADO: ${m.interactive.nfm_reply.response_json || m.interactive.nfm_reply.body || ""}]`;
      }
      if (!de || !texto) continue;

      // ORIGEN del mensaje: si viene de un anuncio "clic para chatear", Meta lo manda
      // en m.referral. Eso abre la ventana FEP (72 h a 7 días gratis) y dice QUÉ le interesa.
      const ref = m.referral;
      const origen = ref
        ? `anuncio (${ref.source_type || "ad"}): ${ref.headline || ref.body || ref.source_url || "sin detalle"}`
        : "orgánico";

      // Meta reintenta el webhook si tarda: sin dedup, la persona recibe la respuesta dos veces.
      if (env.MIMIS_EVENTS) {
        if (await env.MIMIS_EVENTS.get(`wa:visto:${wamid}`)) {
          out.push({ wamid, salteado: "duplicado" });
          continue;
        }
        await env.MIMIS_EVENTS.put(`wa:visto:${wamid}`, "1", { expirationTtl: 86400 });
      }

      // Si el mensaje es un pedido del catálogo (m.type === "order"), le pedimos al
      // Worker "mimis-pagos" (por service binding) que genere el link de pago.
      // Este Worker NO toca el token de Mercado Pago: delega. El entorno se elige
      // por la clave KV "mp:modo" (produccion/sandbox).
      let linkPago = null;
      const mpModo = (env.MIMIS_EVENTS ? await env.MIMIS_EVENTS.get("mp:modo") : null) || "produccion";
      if (pedido && env.PAGOS) {
        try {
          const rPref = await env.PAGOS.fetch("https://pagos/preferencia", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-token": env.INTERNAL_TOKEN,
              "x-mp-modo": mpModo,
            },
            body: JSON.stringify({
              items: pedido.items.map(it => ({
                id: it.product_retailer_id,
                title: `Mimis Lux · Perfume (${it.product_retailer_id})`,
                quantity: Number(it.quantity || 1),
                unit_price: Number(it.item_price || 35000),
                currency_id: "ARS",
              })),
              external_reference: `wa:${clave}:${wamid}`,
            }),
          });
          const dPref = await rPref.json();
          if (dPref.ok && dPref.link) {
            linkPago = dPref.link;
            texto += ` [LINK_DE_PAGO_GENERADO: ${linkPago}]`;
          }
          if (env.MIMIS_EVENTS) {
            await env.MIMIS_EVENTS.put(`wa:order:${wamid}`, JSON.stringify({
              de: clave, from_raw: de, nombre, pedido, link_pago: linkPago,
              preference_id: dPref.id || null, cuando: new Date().toISOString(),
            }), { expirationTtl: 2592000 });
          }
        } catch (e) { /* continúa al agente aunque falle el pago */ }
      }

      // Un Durable Object por persona + modo: la memoria del CEO no se mezcla con la de un cliente.
      const id = env.AGENTE.idFromName(clave + ":" + modo);
      const stub = env.AGENTE.get(id);

      let respuesta, herramientas = [], memoria = 0, modelo = null, errorAgente = null, tokens = null;
      try {
        const r = await stub.fetch("https://agente/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ texto, de: clave, nombre, ventana: "abierta", modo, origen, pnid }),
        });
        const d = await r.json();
        respuesta = d.respuesta;
        herramientas = d.herramientas || [];
        memoria = d.memoria || 0;
        modelo = d.modelo || null;
        errorAgente = d.error || null;
        tokens = d.tokens || null;
      } catch (e) {
        errorAgente = String(e).slice(0, 200);
        respuesta = "Perdón, se me trabó la respuesta. Ya aviso a alguien del equipo 🙏";
      }

      const envio = await enviarWhatsApp(env, de, respuesta, pnid);

      if (env.MIMIS_EVENTS) {
        await env.MIMIS_EVENTS.put(`wa:conv:${clave}`, JSON.stringify({
          de: clave, from_raw: de, nombre, ultimo_texto: texto, cuando: new Date().toISOString(),
          memoria, modelo, herramientas,
        }), { expirationTtl: 2592000 });
        await env.MIMIS_EVENTS.put(`wa:log:${wamid}`, JSON.stringify({
          de: clave, from_raw: de, entro: texto, respondio: respuesta, herramientas, modelo, tokens,
          enviado: envio.ok, destino_envio: envio.destino, error_envio: envio.error,
          error_agente: errorAgente, cuando: new Date().toISOString(),
        }), { expirationTtl: 604800 });
      }
      out.push({ de: clave, from_raw: de, memoria, herramientas, modelo, enviado: envio.ok,
                 destino: envio.destino, id: envio.id, error: envio.error || errorAgente });
    }

    for (const st of (v.statuses || [])) {
      if (env.MIMIS_EVENTS) {
        await env.MIMIS_EVENTS.put(`wa:estado:${st.id}`, JSON.stringify({
          estado: st.status, para: st.recipient_id, cuando: new Date().toISOString(),
        }), { expirationTtl: 604800 });
      }
      out.push({ acuse: st.status, id: st.id });
    }
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Puerta de admin: las rutas de diagnóstico exigen el token. Si no está configurado
    // el token (ADMIN_TOKEN ausente), se niega TODO en esas rutas — nunca se deja abierto.
    if (ADMIN_PATHS.includes(url.pathname)
        && request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
      return json({ error: "no autorizado" }, 401);
    }

    if (url.pathname === "/salud") {
      // Sin inferencia: reporta el estado sin gastar neuronas.
      return json({
        ok: true, kv: !!env.MIMIS_EVENTS, ai: !!env.AI,
        comunidad: !!env.COMUNIDAD_LINK, canal: !!env.CANAL_LINK, avisos: !!env.AVISOS_A,
      });
    }

    if (url.pathname === "/conversaciones") {
      if (!env.MIMIS_EVENTS) return json({ error: "sin KV" }, 500);
      const l = await env.MIMIS_EVENTS.list({ prefix: "wa:conv:", limit: 30 });
      const out = [];
      for (const k of l.keys) {
        try { out.push(JSON.parse(await env.MIMIS_EVENTS.get(k.name))); } catch (e) {}
      }
      out.sort((a, b) => String(b.cuando).localeCompare(String(a.cuando)));
      return json({ total: out.length, conversaciones: out.slice(0, 10) });
    }

    if (url.pathname === "/consumo") {
      if (!env.MIMIS_EVENTS) return json({ error: "sin KV" }, 500);
      const l = await env.MIMIS_EVENTS.list({ prefix: "wa:log:", limit: 500 });
      let msgs = 0, ent = 0, sal = 0;
      for (const k of l.keys) {
        try {
          const v = JSON.parse(await env.MIMIS_EVENTS.get(k.name));
          if (!v) continue;
          msgs++;
          ent += v.tokens?.entrada || 0;
          sal += v.tokens?.salida || 0;
        } catch (e) {}
      }
      return json({ mensajes: msgs, tokens_entrada: ent, tokens_salida: sal,
                    nota: "Workers AI gratis = 10.000 neuronas/día; acá se reportan tokens, no neuronas" });
    }

    if (url.pathname === "/threads/estado") {
      const g = env.MIMIS_EVENTS ? await env.MIMIS_EVENTS.get("threads:token") : null;
      return json({ hay_token: !!g });
    }

    // /payloads: muestra el JSON CRUDO que llegó por cada webhook, para VER y entender
    // qué información manda cada servicio (Meta, Mercado Pago, Whop). Es la "ventana"
    // a los eventos — como ver el payload de un nodo en N8N.
    if (url.pathname === "/payloads") {
      if (!env.MIMIS_EVENTS) return json({ error: "sin KV" }, 500);
      const tipo = url.searchParams.get("tipo") || "meta";
      const prefijo = tipo === "ml" ? "ml:notif:" : tipo === "whop" ? "whop:" : "meta:raw:";
      const l = await env.MIMIS_EVENTS.list({ prefix: prefijo, limit: 8 });
      const out = [];
      for (const k of l.keys) {
        out.push({ clave: k.name, cuerpo: await env.MIMIS_EVENTS.get(k.name) });
      }
      return json({ tipo, total: out.length, payloads: out });
    }

    // Mercado Pago / Mercado Libre — PUERTA DE SERVICIO.
    // El token vive en el Secrets Store de Cloudflare (write-only): el Worker lo lee con
    // el binding y hace la llamada. Yo nunca veo la clave — sólo pido por esta puerta.
    if (url.pathname === "/mp/whoami") {
      const cual = url.searchParams.get("env") === "test" ? "MELI_TOKEN_TEST" : "MELI_TOKEN";
      const b = env[cual];
      if (!b) return json({ error: "sin binding " + cual }, 500);
      try {
        const token = await b.get();
        const r = await fetch("https://api.mercadolibre.com/users/me",
          { headers: { Authorization: "Bearer " + token } });
        const d = await r.json();
        return json({ ok: r.ok, status: r.status, id: d.id, nickname: d.nickname,
                      country: d.country_id, site: d.site_id, error: d.message || null });
      } catch (e) {
        return json({ error: String(e).slice(0, 150) }, 500);
      }
    }
    if (url.pathname === "/mp/token") {
      // Entrega el access token para el CLI local (mpcli). Protegido con X-Admin-Token:
      // es la MISMA frontera de confianza que /conversaciones. El token va a un archivo
      // local (600) para que mpcli corra sin que la clave pase por el chat.
      const cual = url.searchParams.get("env") === "test" ? "MELI_TOKEN_TEST" : "MELI_TOKEN";
      const b = env[cual];
      if (!b) return json({ error: "sin binding " + cual }, 500);
      try {
        const token = await b.get();
        return new Response(token, { status: 200 });
      } catch (e) {
        return json({ error: String(e).slice(0, 150) }, 500);
      }
    }
    if (url.pathname === "/mp/payments") {
      // Lectura de cobros (Mercado Pago): la conciliación. Devuelve el total y cuántos
      // trae, nunca los datos sensibles del comprador en bruto — se resume acá.
      const b = env.MELI_TOKEN;
      if (!b) return json({ error: "sin binding MELI_TOKEN" }, 500);
      try {
        const token = await b.get();
        const r = await fetch("https://api.mercadopago.com/v1/payments/search?limit=5&sort=date_created&criteria=desc",
          { headers: { Authorization: "Bearer " + token } });
        const d = await r.json();
        return json({ ok: r.ok, status: r.status, total: d.paging?.total ?? null,
                      traidos: (d.results || []).length,
                      error: d.error || d.message || d.cause?.map(c => c.code).join(",") || null });
      } catch (e) {
        return json({ error: String(e).slice(0, 150) }, 500);
      }
    }

    // Mercado Libre: redirect URI del OAuth (GET) y notificaciones (POST), sobre el mismo Worker.
    // El callback recibe ?code=... cuando un vendedor autoriza la app; acá se guarda para
    // canjearlo por el access_token. Las notificaciones son webhooks de órdenes/pagos.
    if (url.pathname === "/ml/callback") {
      const code = url.searchParams.get("code") || null;
      if (code && env.MIMIS_EVENTS) {
        await env.MIMIS_EVENTS.put("ml:oauth:code", JSON.stringify({
          code, cuando: new Date().toISOString(),
        }), { expirationTtl: 600 });
      }
      return json({ ok: true, code: code ? "recibido" : "sin code" });
    }
    if (url.pathname === "/ml/notificaciones") {
      if (request.method === "POST") {
        const cuerpo = await request.text().catch(() => "");
        if (env.MIMIS_EVENTS) {
          await env.MIMIS_EVENTS.put("ml:notif:" + Date.now(), cuerpo.slice(0, 4000),
            { expirationTtl: 86400 });
        }
        try {
          const notif = JSON.parse(cuerpo || "{}");
          const payId = notif?.data?.id || (notif.topic === "payment" && notif.resource ? String(notif.resource).split("/").pop() : null);
          if (payId && env.WHATSAPP_TOKEN) {
            // El pago puede venir del sandbox o de producción: probamos los DOS tokens
            // hasta que uno lo lea. Así la confirmación funciona en ambos entornos.
            let dPay = null;
            let rPay = null;
            for (const b of [env.MELI_TOKEN, env.MELI_TOKEN_TEST]) {
              if (!b) continue;
              try {
                const t = await b.get();
                const rr = await fetch(`https://api.mercadopago.com/v1/payments/${payId}`, {
                  headers: { Authorization: "Bearer " + t },
                });
                if (rr.ok) { rPay = rr; dPay = await rr.json(); break; }
              } catch (e) { /* probar el otro token */ }
            }
            if (!dPay) return json({ ok: true, aviso: "pago no leído con ningún token" });
            const ref = dPay.external_reference || "";
            if (rPay.ok && dPay.status === "approved" && ref.startsWith("wa:")) {
              const partes = ref.split(":");
              const waDestino = partes[1];
              const dedupKey = `mp:pagado:${payId}`;
              const yaAvisado = env.MIMIS_EVENTS ? await env.MIMIS_EVENTS.get(dedupKey) : null;
              if (!yaAvisado && waDestino) {
                if (env.MIMIS_EVENTS) await env.MIMIS_EVENTS.put(dedupKey, "1", { expirationTtl: 604800 });
                await enviarWhatsApp(
                  env,
                  waDestino,
                  `✅ ¡Pago acreditado! ($${dPay.transaction_amount} ${dPay.currency_id || "ARS"})\n\nYa estamos preparando tu pedido de Mimis Lux ✨. Pasame por acá tu dirección y código postal así coordinamos el envío al toque. 🌸`,
                  "1305193802687055"
                );
              }
            }
          }
        } catch (e) { /* no bloquear el 200 a Mercado Pago */ }
      }
      return json({ ok: true });
    }

    // Whop — PUERTA DE SERVICIO en el Worker (no en Gray Fox). Recibe los webhooks de Whop
    // (payment.succeeded, membership.activated, …), verifica la firma y guarda el evento.
    if (url.pathname === "/whop/webhook") {
      if (request.method !== "POST") return json({ error: "solo POST" }, 405);
      const v = await verificarWhop(request, env);
      const cuerpo = await request.text().catch(() => "");
      if (env.MIMIS_EVENTS) {
        await env.MIMIS_EVENTS.put("whop:" + Date.now(), JSON.stringify({
          ok: v.ok, motivo: v.motivo || null, cuerpo: cuerpo.slice(0, 2000),
          cuando: new Date().toISOString(),
        }), { expirationTtl: 86400 });
      }
      if (!v.ok) return json({ error: v.motivo }, 401);
      return json({ ok: true });
    }

    if (request.method === "GET") {
      const modo = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (modo === "subscribe" && token && token === env.META_VERIFY_TOKEN) {
        return new Response(challenge || "", { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const crudo = await request.text();
    const firma = request.headers.get("x-hub-signature-256") || "";
    if (!env.META_APP_SECRET) return json({ error: "sin app secret" }, 500);
    const esperado = "sha256=" + await hmacHex(env.META_APP_SECRET, crudo);
    if (!igualSeguro(firma, esperado)) return json({ error: "firma inválida" }, 401);

    let payload;
    try { payload = JSON.parse(crudo); } catch { return json({ error: "json inválido" }, 400); }
    const objeto = payload.object || "desconocido";

    // Guardamos el JSON CRUDO tal cual llegó, para poder VERLO y entenderlo
    // (es el "payload" que dispara nuestra lógica, como los nodos de N8N).
    if (env.MIMIS_EVENTS) {
      await env.MIMIS_EVENTS.put(`meta:raw:${Date.now()}`, crudo.slice(0, 8000),
        { expirationTtl: 86400 });
    }

    let resultados = [];
    if (objeto === "whatsapp_business_account") {
      for (const entry of (payload.entry || [])) {
        resultados = resultados.concat(await atenderWhatsApp(entry, env));
      }
    } else if (env.MIMIS_EVENTS) {
      await env.MIMIS_EVENTS.put(`ultimo:${objeto}`, JSON.stringify({
        recibido: new Date().toISOString(), bytes: crudo.length,
      }));
    }
    return json({ ok: true, objeto, resultados });
  },
};

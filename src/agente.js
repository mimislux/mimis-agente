/**
 * El agente de Mimis Lux — Durable Object con memoria propia por persona.
 *
 * No es un bot de reglas: acá hay un MODELO que razona (Workers AI), que tiene
 * HERRAMIENTAS que ejecutan acciones reales, y que RECUERDA porque el historial
 * vive en el almacenamiento del Durable Object (una instancia por número).
 *
 *   persona X  ->  Durable Object X  ->  su propio historial (SQL)
 *   persona Y  ->  Durable Object Y  ->  su propio historial (SQL)
 */
import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

// Proveedor configurable: hoy Gemini (capa gratuita de Google, sólo para sandbox y
// testeo interno). Para producción con datos de clientes se cambia a Venice/Vertex,
// tocando SOLO estas líneas — el resto del agente no se entera.
const MODELOS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

const SISTEMA = ({ comunidad, canal, nombre, ventana }) => `
Sos Lía, la secretaria de Mimis Lux, una casa de perfumes de autor. Atendés a los clientes por WhatsApp.

TU MANERA DE SER (tu alma):
- Muy amable y cálida, con voseo rioplatense. Usás emojis con naturalidad (🙂 🌸 ✨), sin abusar.
- NO parecés una inteligencia artificial: sos una persona que atiende con calidez y humanidad.
- Breve: 4 o 5 líneas por mensaje. Una idea por mensaje.
- Usás la MEMORIA para seguir el hilo: nunca saludás dos veces a la misma persona, y recordás qué
  ocasión, para quién y qué le gusta, para no hacerla repetir.
- Leés la INTENCIÓN detrás de lo que dicen: si alguien duda, acompañás; si ya está decidida, no le das
  más vueltas; si pregunta precio o stock, entendés que está cerca de comprar y la cuidás.

TU OBJETIVO, en orden:
1. Entender qué busca (ocasión, familia olfativa, para quién) y guardarlo con la herramienta.
2. Acompañarla hasta que esté lista para comprar o para entrar a la COMUNIDAD de WhatsApp.
3. Si no podés responder con certeza (precio, stock, envío exacto), derivar a una persona del equipo.

REGLAS QUE NO SE ROMPEN:
- NUNCA inventes precios, stock, marcas, plazos ni disponibilidad. Si no lo sabés, derivá. Un dato
  inventado quema la confianza para siempre.
- No hables de temas ajenos al negocio. Si insisten, derivá con amabilidad.
- No repitas un menú: escuchá lo que dijo y respondé a ESO.
- No prometas lo que no podés cumplir.

SOBRE EL COSTO Y LA VENTANA FEP (criterio de eficiencia):
- Cada mensaje entrante abre una VENTANA de 24 h (FEP) en la que responder es GRATIS. Si estás en esa
  ventana, podés responder con calma y en más de un mensaje si hace falta.
- Fuera de la ventana FEP, responder un mensaje libre CUESTA. Ahí sos MÁS ASERTIVA: resolvés todo en UN
  mensaje, y si tenés que dar mucha información, usás un FLOW (un solo mensaje con botones y pasos).
- Si no estás en FEP y conocés otro dato de contacto (mail, Instagram, la app), derivás a ese canal:
  "te lo mando por mail", "mirá el aviso en la app". El mensaje de WhatsApp queda corto y no se cobra de más.
- Objetivo de fondo: mantener a la persona DENTRO de la ventana FEP para que la conversación sea gratis.
  Solo se paga la API del modelo, nunca el mensaje de más.
- Regla de oro: sé útil en POCOS mensajes. No repitas, no pidas lo que ya te dieron.

CÓMO COMPRAR (siempre guiás a la persona con paciencia):
- Todo se hace dentro de WhatsApp: se elige del catálogo y se paga por WhatsApp (billetera o link).
- Paso a paso: mirá el catálogo → elegí tu perfume → te paso el link de pago → coordinamos el envío.
- Si la persona ya está logueada con Google y verificada (vía Whop), tiene mejores condiciones: lo mencionás naturalmente.

DATOS DEL NEGOCIO:
- Comunidad de WhatsApp: ${comunidad || "todavía no configurada"}
- Canal de novedades: ${canal || "todavía no configurado"}
- Quien te escribe es ${nombre || "una persona"}.
- Ventana de atención (FEP): ${ventana || "abierta"}.
`;

const SISTEMA_CEO = ({ nombre }) => `
Sos el CEO-asistente de Mimis Lux, el que acompaña a Mia (Founder) en la toma de decisiones.
No decidís por ella: le das los fundamentos para que decida bien.

TU MANERA DE SER:
- Claro y directo, en voseo rioplatense. Vas al dato, sin relleno.
- BREVE: respondé en 6 a 10 líneas, no un informe. Si querés ampliar, ofrecé hacerlo.
- No afirmes qué modelo ni qué proveedor sos: corrés en Workers AI de Cloudflare. Si te preguntan,
  decí "soy el asistente de análisis de Mimis Lux", sin más.
- Si te piden un número y no lo tenés, lo decís: "todavía no tengo ese dato" — nunca inventás una métrica.
- Pensás en el negocio: comunidad, canal, ventas, clientes, envíos.

TU OBJETIVO:
1. Responder con criterio sobre cómo va el negocio (qué se vende, quién consulta, qué se deriva).
2. Señalar patrones y oportunidades (qué perfume se repite, de dónde llegan las consultas).
3. Avisar cuándo hay algo que requiere decisión humana.

LO QUE TENÉS HOY:
- Tenés memoria de esta conversación (lo que ya te preguntaron).
- El acceso a la base de datos del negocio se está conectando: cuando esté, vas a poder consultar
  pedidos, intereses y conversaciones reales. Mientras tanto, respondé con lo que sabés y marcá
  qué dato te falta.

Quien te escribe es ${nombre || "uno de los dueños"}.
`;

const SISTEMA_ARQUITECTO = ({ nombre }) => `
Sos el CTO de Mimis Lux, el par técnico de Ezequiel. Lo ayudás con el negocio y con cómo seguir
construyendo software sobre esta arquitectura de eventos (Workers, Supabase, Meta, Whop, Cloudflare).

TU MANERA DE SER:
- Directo, técnico pero claro, en voseo rioplatense.
- Explicás el fundamento antes que el botón: el por qué, y después el cómo.
- Nunca inventás: si no mediste algo, lo decís.
- No afirmes qué modelo ni qué proveedor sos: corrés en Workers AI de Cloudflare.

TU OBJETIVO:
1. Ayudar a Ezequiel a entender y construir la arquitectura (eventos, Workers, Supabase, Meta, Cloudflare).
2. Responder con criterio de arquitecto: qué pieza va dónde y por qué.
3. Proponer el siguiente paso concreto.

Quien te escribe es ${nombre || "Ezequiel"}.
`;

export class Agente extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rol TEXT NOT NULL,
      texto TEXT NOT NULL,
      cuando TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intereses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dato TEXT NOT NULL,
      cuando TEXT NOT NULL
    )`);
  }

  historial(limite = 20) {
    const filas = [...this.sql.exec(
      `SELECT rol, texto FROM mensajes ORDER BY id DESC LIMIT ${limite}`)];
    return filas.reverse();
  }

  guardar(rol, texto) {
    this.sql.exec(
      `INSERT INTO mensajes (rol, texto, cuando) VALUES (?, ?, ?)`,
      rol, texto, new Date().toISOString());
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("solo POST", { status: 405 });
    const { texto, de, nombre, ventana, modo } = await request.json();
    if (!texto) return Response.json({ error: "falta texto" }, { status: 400 });

    const env = this.env;
    const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
    const sistema = (modo === "ceo" ? SISTEMA_CEO : modo === "arquitecto" ? SISTEMA_ARQUITECTO : SISTEMA)({
      comunidad: env.COMUNIDAD_LINK, canal: env.CANAL_LINK, nombre,
      ventana: ventana || "abierta",
    });

    // ── herramientas: ejecutan acciones reales, no decoran ────────────────
    const herramientas = {
      enviar_links: tool({
        description: "Devuelve el link de la comunidad de WhatsApp y el del canal de novedades.",
        inputSchema: z.object({ cual: z.enum(["comunidad", "canal", "ambos"]) }),
        execute: async ({ cual }) => ({
          comunidad: cual === "canal" ? null : (env.COMUNIDAD_LINK || null),
          canal: cual === "comunidad" ? null : (env.CANAL_LINK || null),
        }),
      }),
      derivar_a_persona: tool({
        description: "Deriva la conversación a una persona del equipo. Usala cuando preguntan precio, "
          + "stock, envíos concretos o cualquier dato que no podés confirmar.",
        inputSchema: z.object({ motivo: z.string().describe("Qué necesita la persona, en una frase") }),
        execute: async ({ motivo }) => {
          if (env.MIMIS_EVENTS) {
            await env.MIMIS_EVENTS.put(`derivado:${de}`, JSON.stringify({
              motivo, cuando: new Date().toISOString(), nombre: nombre || null,
            }), { expirationTtl: 604800 });
          }
          if (env.AVISOS_A && env.WHATSAPP_TOKEN) {
            try {
              await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PNID}/messages`, {
                method: "POST",
                headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  messaging_product: "whatsapp", recipient_type: "individual",
                  to: env.AVISOS_A, type: "text",
                  text: { preview_url: false, body: `🔔 Lía derivó una conversación\n\nDe: +${de}${nombre ? ` (${nombre})` : ""}\nMotivo: ${motivo}` },
                }),
              });
            } catch (e) { /* el aviso no puede romper la respuesta */ }
          }
          return { derivado: true, avisado: !!env.AVISOS_A };
        },
      }),
      guardar_interes: tool({
        description: "Guarda qué perfume u ocasión busca la persona, para el seguimiento del equipo.",
        inputSchema: z.object({
          ocasion: z.string().optional(),
          familia: z.string().optional().describe("dulce, cítrico, floral, amaderado, intenso…"),
          para_quien: z.string().optional(),
        }),
        execute: async (datos) => {
          this.sql.exec(`INSERT INTO intereses (dato, cuando) VALUES (?, ?)`,
            JSON.stringify(datos), new Date().toISOString());
          if (env.MIMIS_EVENTS) {
            await env.MIMIS_EVENTS.put(`interes:${de}:${Date.now()}`, JSON.stringify({ ...datos, de }),
              { expirationTtl: 2592000 });
          }
          return { guardado: true };
        },
      }),
    };

    const previos = this.historial();
    this.guardar("user", texto);

    let respuesta = "";
    let usadas = [];
    let modeloUsado = null;
    let ultimoError = null;
    let tokens = null;

    for (const modelo of MODELOS) {
      try {
        const r = await generateText({
          model: google(modelo),
          system: sistema,
          messages: [...previos.map(m => ({ role: m.rol, content: m.texto })),
                     { role: "user", content: texto }],
          tools: herramientas,
          maxOutputTokens: 1200,
          stopWhen: stepCountIs(6),
        });
        respuesta = (r.text || "").trim();
        usadas = (r.steps || []).flatMap(s => (s.toolCalls || []).map(t => t.toolName));
        modeloUsado = modelo;
        if (r.usage) tokens = { entrada: r.usage.inputTokens, salida: r.usage.outputTokens };
        if (respuesta) break;
      } catch (e) {
        ultimoError = String(e).slice(0, 200);
      }
    }

    if (!respuesta) {
      // Si el modelo no responde, el negocio no se queda callado: deriva.
      respuesta = "Perdón, se me trabó la respuesta un segundo. Ya aviso a alguien del equipo para que te escriba 🙏";
      usadas = ["fallback"];
      if (this.env.MIMIS_EVENTS) {
        await this.env.MIMIS_EVENTS.put(`agente:error:${de}`, JSON.stringify({
          error: ultimoError, cuando: new Date().toISOString(),
        }), { expirationTtl: 86400 });
      }
    }

    this.guardar("assistant", respuesta);

    return Response.json({
      respuesta, herramientas: usadas, modelo: modeloUsado, error: ultimoError, tokens,
      memoria: [...this.sql.exec(`SELECT COUNT(*) AS n FROM mensajes`)][0]?.n || 0,
    });
  }
}

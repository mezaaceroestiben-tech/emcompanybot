const http = require("http");
const fs = require("fs");
const path = require("path");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const PORT = process.env.PORT || 10000;
const API_SECRET = (process.env.API_SECRET || "").trim();
const GH_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const GH_OWNER = (process.env.GITHUB_OWNER || "").trim();
const GH_REPO = (process.env.GITHUB_REPO || "").trim();
const GH_BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PAYPAL_ENV = (process.env.PAYPAL_URL || "").trim();

const RUTA_CANALES = path.join(__dirname, "canales.json");
const API_TG = "https://api.telegram.org/bot" + TOKEN;

function normalizarPaypal(t) {
  t = String(t || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
    return "https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=" + encodeURIComponent(t) + "&currency_code=USD";
  }
  if (/^(www\.)?paypal\.(me|com)\//i.test(t)) return "https://" + t;
  return "https://www.paypal.me/" + t.replace(/^@/, "");
}

function opcionesPorDefecto() {
  return {
    nueva_nombre: true,
    nueva_descripcion: true,
    nueva_cambios: true,
    act_nombre: false,
    act_descripcion: false,
    act_cambios: true,
    reacciones: true,
    boton_paypal: true,
    fijar: true,
    publicador: false
  };
}

function normalizarOpciones(op) {
  const base = opcionesPorDefecto();
  if (!op || typeof op !== "object") return base;
  for (const k of Object.keys(base)) {
    if (typeof op[k] === "boolean") base[k] = op[k];
  }
  return base;
}

function datosPorDefecto() {
  return {
    propietario_id: null,
    admins: [],
    paypal_url: normalizarPaypal(PAYPAL_ENV),
    texto_boton_donar: "Donar vía PayPal",
    fijar_mensajes: true,
    reacciones_activas: true,
    opciones_publicacion: opcionesPorDefecto(),
    canales: [],
    votos: {},
    historial_publicaciones: []
  };
}

let datos = datosPorDefecto();
let estadosChat = {};
let infoBot = { username: "", first_name: "E m company" };
let sincronizandoGH = false;
let pendienteGH = false;

function cargarLocal() {
  try {
    if (fs.existsSync(RUTA_CANALES)) {
      const leido = JSON.parse(fs.readFileSync(RUTA_CANALES, "utf8"));
      if (leido && typeof leido === "object") {
        datos = Object.assign(datosPorDefecto(), leido);
        if (!Array.isArray(datos.canales)) datos.canales = [];
        if (!datos.votos || typeof datos.votos !== "object") datos.votos = {};
        datos.opciones_publicacion = normalizarOpciones(leido.opciones_publicacion);
        if (!datos.paypal_url && PAYPAL_ENV) datos.paypal_url = normalizarPaypal(PAYPAL_ENV);
      }
    }
  } catch (e) {
    console.log("Error leyendo canales.json local:", e.message);
  }
}

function guardarLocal() {
  try {
    fs.writeFileSync(RUTA_CANALES, JSON.stringify(datos, null, 2), "utf8");
  } catch (e) {
    console.log("Error guardando canales.json local:", e.message);
  }
}

async function sincronizarDesdeGitHub() {
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) return;
  try {
    const url = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/canales.json?ref=" + encodeURIComponent(GH_BRANCH);
    const r = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + GH_TOKEN,
        "Accept": "application/vnd.github+json",
        "User-Agent": "EmMasterManagerBot"
      }
    });
    if (r.status === 200) {
      const js = await r.json();
      if (js && js.content) {
        const texto = Buffer.from(js.content.replace(/\s+/g, ""), "base64").toString("utf8");
        const remoto = JSON.parse(texto);
        if (remoto && typeof remoto === "object") {
          if (Array.isArray(remoto.canales)) {
            const mapa = new Map();
            for (const c of datos.canales) mapa.set(String(c.id), c);
            for (const c of remoto.canales) mapa.set(String(c.id), c);
            datos.canales = Array.from(mapa.values());
          }
          if (remoto.propietario_id && !datos.propietario_id) datos.propietario_id = remoto.propietario_id;
          if (remoto.paypal_url) datos.paypal_url = normalizarPaypal(remoto.paypal_url);
          if (remoto.texto_boton_donar) datos.texto_boton_donar = remoto.texto_boton_donar;
          if (typeof remoto.fijar_mensajes === "boolean") datos.fijar_mensajes = remoto.fijar_mensajes;
          if (typeof remoto.reacciones_activas === "boolean") datos.reacciones_activas = remoto.reacciones_activas;
          if (remoto.opciones_publicacion) datos.opciones_publicacion = normalizarOpciones(remoto.opciones_publicacion);
          if (remoto.votos && typeof remoto.votos === "object") {
            datos.votos = Object.assign({}, remoto.votos, datos.votos);
          }
          guardarLocal();
        }
      }
    }
  } catch (e) {
    console.log("Aviso sincronizando desde GitHub:", e.message);
  }
}

async function subirCanalesAGitHub() {
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) return;
  if (sincronizandoGH) {
    pendienteGH = true;
    return;
  }
  sincronizandoGH = true;
  try {
    const url = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/canales.json";
    let sha = null;
    const rGet = await fetch(url + "?ref=" + encodeURIComponent(GH_BRANCH), {
      headers: {
        "Authorization": "Bearer " + GH_TOKEN,
        "Accept": "application/vnd.github+json",
        "User-Agent": "EmMasterManagerBot"
      }
    });
    if (rGet.status === 200) {
      const jsGet = await rGet.json();
      sha = jsGet.sha;
    }
    const copia = Object.assign({}, datos);
    const contenidoB64 = Buffer.from(JSON.stringify(copia, null, 2), "utf8").toString("base64");
    const cuerpo = {
      message: "Actualizar canales.json del bot [skip ci]",
      content: contenidoB64,
      branch: GH_BRANCH
    };
    if (sha) cuerpo.sha = sha;
    await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + GH_TOKEN,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "EmMasterManagerBot"
      },
      body: JSON.stringify(cuerpo)
    });
  } catch (e) {
    console.log("Aviso guardando canales.json en GitHub:", e.message);
  } finally {
    sincronizandoGH = false;
    if (pendienteGH) {
      pendienteGH = false;
      subirCanalesAGitHub();
    }
  }
}

function guardarTodo() {
  guardarLocal();
  subirCanalesAGitHub();
}

function escaparHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function llamar(metodo, params) {
  if (!TOKEN) return { ok: false, description: "Sin token" };
  const r = await fetch(API_TG + "/" + metodo, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {})
  });
  return r.json();
}

async function enviarDocumentoMultipart(chatId, nombreArchivo, bufferArchivo, caption, replyMarkup) {
  const boundary = "----EmBotBoundary" + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const partes = [];
  function campoTexto(nombre, valor) {
    if (valor === undefined || valor === null || valor === "") return;
    partes.push(Buffer.from(
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="' + nombre + '"\r\n\r\n' +
      String(valor) + "\r\n",
      "utf8"
    ));
  }
  campoTexto("chat_id", String(chatId));
  if (caption) {
    campoTexto("caption", String(caption).slice(0, 1024));
    campoTexto("parse_mode", "HTML");
  }
  if (replyMarkup && Array.isArray(replyMarkup.inline_keyboard) && replyMarkup.inline_keyboard.length > 0) {
    campoTexto("reply_markup", JSON.stringify(replyMarkup));
  }
  const nombreLimpio = String(nombreArchivo || "aplicacion.apk").replace(/["\r\n]/g, "_");
  partes.push(Buffer.from(
    "--" + boundary + "\r\n" +
    'Content-Disposition: form-data; name="document"; filename="' + nombreLimpio + '"\r\n' +
    "Content-Type: application/vnd.android.package-archive\r\n\r\n",
    "utf8"
  ));
  partes.push(bufferArchivo);
  partes.push(Buffer.from("\r\n--" + boundary + "--\r\n", "utf8"));
  const cuerpoTotal = Buffer.concat(partes);
  const r = await fetch(API_TG + "/sendDocument", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=" + boundary,
      "Content-Length": String(cuerpoTotal.length)
    },
    body: cuerpoTotal
  });
  return r.json();
}

const DERECHOS_USUARIO_CANAL = {
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_messages: true,
  can_edit_messages: false,
  can_pin_messages: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false
};

const DERECHOS_BOT_CANAL = {
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_messages: true,
  can_edit_messages: true,
  can_pin_messages: true,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false
};

function tecladoPrincipal() {
  return {
    keyboard: [
      [
        {
          text: "➕ Añadir nuevo canal",
          request_chat: {
            request_id: 1,
            chat_is_channel: true,
            user_admin_rights: DERECHOS_USUARIO_CANAL,
            bot_admin_rights: DERECHOS_BOT_CANAL,
            request_title: true,
            request_username: true
          }
        },
        {
          text: "📢 Canales donde está el bot",
          request_chat: {
            request_id: 2,
            chat_is_channel: true,
            bot_is_member: true,
            user_admin_rights: DERECHOS_USUARIO_CANAL,
            request_title: true,
            request_username: true
          }
        }
      ],
      [
        { text: "📋 Mis canales" },
        { text: "💳 Configurar PayPal" }
      ],
      [
        { text: "📤 Publicar APK" },
        { text: "⚙️ Estado del bot" }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function registrarCanal(canalObj) {
  const idStr = String(canalObj.id);
  let existente = datos.canales.find((c) => String(c.id) === idStr);
  const nuevo = {
    id: canalObj.id,
    titulo: canalObj.titulo || (existente && existente.titulo) || ("Canal " + idStr),
    username: canalObj.username !== undefined ? (canalObj.username || "") : ((existente && existente.username) || ""),
    privado: !(canalObj.username || (existente && existente.username)),
    agregado: (existente && existente.agregado) || new Date().toISOString()
  };
  if (existente) {
    Object.assign(existente, nuevo);
  } else {
    datos.canales.push(nuevo);
  }
  guardarTodo();
  return nuevo;
}

function quitarCanalPorId(id) {
  const antes = datos.canales.length;
  datos.canales = datos.canales.filter((c) => String(c.id) !== String(id));
  if (datos.canales.length !== antes) {
    guardarTodo();
    return true;
  }
  return false;
}

function armarTecladoPublicacion(upCount, downCount, paypalUrl, textoDonar, urlExtra, opPub) {
  const op = normalizarOpciones(opPub || datos.opciones_publicacion);
  const filas = [];
  if (op.reacciones !== false) {
    filas.push([
      { text: "👍 " + String(upCount || 0), callback_data: "v_up" },
      { text: "👎 " + String(downCount || 0), callback_data: "v_down" }
    ]);
  }
  if (urlExtra && /^https?:\/\//i.test(urlExtra)) {
    filas.push([{ text: "📥 Descargar APK", url: urlExtra }]);
  }
  if (op.boton_paypal !== false) {
    const urlDonar = normalizarPaypal(paypalUrl || datos.paypal_url);
    if (urlDonar && /^https?:\/\//i.test(urlDonar)) {
      filas.push([{ text: "💝 " + (textoDonar || datos.texto_boton_donar || "Donar vía PayPal"), url: urlDonar }]);
    }
  }
  return { inline_keyboard: filas };
}

function armarTextoPublicacion(info, opPub) {
  const op = normalizarOpciones(opPub || info.opciones_publicacion || datos.opciones_publicacion);
  const esAct = Boolean(info.es_actualizacion);
  const incNombre = esAct ? Boolean(op.act_nombre) : (op.nueva_nombre !== false);
  const incDesc = esAct ? Boolean(op.act_descripcion) : (op.nueva_descripcion !== false);
  const incCambios = esAct ? (op.act_cambios !== false) : (op.nueva_cambios !== false);
  const incPub = Boolean(op.publicador);

  const nombre = escaparHtml(info.app_name || info.repo || "Aplicación");
  const ver = escaparHtml(info.version_name || "");
  const desc = escaparHtml(info.descripcion || "").trim();
  const nov = escaparHtml(info.novedades || "").trim();
  const pub = escaparHtml(info.publicador || "").trim();

  const lineas = [];
  if (incNombre) {
    lineas.push("📲 <b>" + nombre + "</b>" + (ver ? " — <b>v" + ver + "</b>" : ""));
  }
  if (incDesc && desc) {
    if (lineas.length > 0) lineas.push("");
    lineas.push("📝 <b>Descripción:</b>");
    lineas.push(desc);
  }
  if (incCambios && nov) {
    if (lineas.length > 0) lineas.push("");
    lineas.push("🆕 <b>Cambios en esta actualización:</b>");
    lineas.push(nov);
  }
  if (incPub && pub) {
    if (lineas.length > 0) lineas.push("");
    lineas.push("👤 <b>Publicado por:</b> " + pub);
  }
  return lineas.join("\n").slice(0, 1020);
}

async function descargarBufferDeUrl(url, tokenAuth, esApiAsset) {
  const headers = { "User-Agent": "EmMasterManagerBot" };
  if (tokenAuth) headers["Authorization"] = "Bearer " + tokenAuth;
  if (esApiAsset) headers["Accept"] = "application/octet-stream";
  const r = await fetch(url, { headers, redirect: "follow" });
  if (!r.ok) throw new Error("Descarga falló con código " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function obtenerApksParaPublicar(info) {
  const lista = [];
  if (info.apk_base64) {
    lista.push({
      nombre: info.apk_nombre || ((info.app_name || "app") + ".apk"),
      buffer: Buffer.from(info.apk_base64, "base64"),
      urlDescarga: info.apk_url || ""
    });
    return lista;
  }
  if (info.file_id) {
    lista.push({
      nombre: info.apk_nombre || ((info.app_name || "app") + ".apk"),
      file_id: info.file_id,
      urlDescarga: ""
    });
    return lista;
  }
  const ghTok = (info.github_token || GH_TOKEN || "").trim();
  if (Array.isArray(info.apks) && info.apks.length > 0) {
    for (const a of info.apks) {
      const u = a.api_url || a.url;
      if (u) {
        const buf = await descargarBufferDeUrl(u, ghTok, Boolean(a.api_url));
        lista.push({ nombre: a.nombre || "app.apk", buffer: buf, urlDescarga: a.url || "" });
      }
    }
    if (lista.length > 0) return lista;
  }
  if (info.apk_api_url || info.apk_url) {
    const u = info.apk_api_url || info.apk_url;
    const buf = await descargarBufferDeUrl(u, ghTok, Boolean(info.apk_api_url));
    lista.push({
      nombre: info.apk_nombre || ((info.app_name || "app") + (info.version_name ? "-" + info.version_name : "") + ".apk"),
      buffer: buf,
      urlDescarga: info.apk_url || ""
    });
    return lista;
  }
  if (info.owner && info.repo) {
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "EmMasterManagerBot"
    };
    if (ghTok) headers["Authorization"] = "Bearer " + ghTok;
    const rRel = await fetch("https://api.github.com/repos/" + info.owner + "/" + info.repo + "/releases/latest", { headers });
    if (rRel.status === 200) {
      const rel = await rRel.json();
      if (Array.isArray(rel.assets)) {
        for (const as of rel.assets) {
          if (String(as.name || "").toLowerCase().endsWith(".apk")) {
            const buf = await descargarBufferDeUrl(as.url, ghTok, true);
            lista.push({
              nombre: as.name,
              buffer: buf,
              urlDescarga: as.browser_download_url || ""
            });
          }
        }
      }
    }
  }
  return lista;
}

async function distribuirACanales(info) {
  await sincronizarDesdeGitHub();
  if (!datos.canales || datos.canales.length === 0) {
    return { ok: false, error: "No hay canales registrados en canales.json. Abre el bot en Telegram y toca '➕ Añadir nuevo canal'." };
  }
  let apks = [];
  try {
    apks = await obtenerApksParaPublicar(info);
  } catch (e) {
    return { ok: false, error: "No se pudo descargar el APK: " + e.message };
  }
  if (apks.length === 0) {
    return { ok: false, error: "No se encontró ningún archivo APK para distribuir." };
  }

  const op = normalizarOpciones(info.opciones_publicacion || datos.opciones_publicacion);
  const caption = armarTextoPublicacion(info, op);
  const fijar = info.fijar !== undefined ? Boolean(info.fijar) : (op.fijar !== false);
  const usarReacciones = op.reacciones !== false;
  const resultados = [];
  let enviados = 0;

  for (const apk of apks) {
    let fileIdReutilizable = apk.file_id || null;
    const demasiadoGrande = apk.buffer && apk.buffer.length > 49 * 1024 * 1024;
    const teclado = armarTecladoPublicacion(0, 0, info.paypal_url, info.texto_boton_donar, demasiadoGrande ? apk.urlDescarga : "", op);

    for (const canal of datos.canales) {
      try {
        let resEnvio;
        if (demasiadoGrande && apk.urlDescarga) {
          resEnvio = await llamar("sendMessage", {
            chat_id: canal.id,
            text: (caption ? (caption + "\n\n") : "") + "📦 <b>Archivo:</b> " + escaparHtml(apk.nombre),
            parse_mode: "HTML",
            reply_markup: teclado
          });
        } else if (fileIdReutilizable) {
          const payloadDoc = {
            chat_id: canal.id,
            document: fileIdReutilizable,
            reply_markup: teclado
          };
          if (caption) {
            payloadDoc.caption = caption;
            payloadDoc.parse_mode = "HTML";
          }
          resEnvio = await llamar("sendDocument", payloadDoc);
        } else if (apk.buffer) {
          resEnvio = await enviarDocumentoMultipart(canal.id, apk.nombre, apk.buffer, caption, teclado);
          if (resEnvio && resEnvio.ok && resEnvio.result && resEnvio.result.document) {
            fileIdReutilizable = resEnvio.result.document.file_id;
          }
        }
        if (resEnvio && resEnvio.ok && resEnvio.result) {
          enviados++;
          const msgId = resEnvio.result.message_id;
          const claveVoto = String(canal.id) + ":" + String(msgId);
          datos.votos[claveVoto] = {
            up: [],
            down: [],
            paypal: op.boton_paypal !== false ? normalizarPaypal(info.paypal_url || datos.paypal_url) : "",
            reacciones: usarReacciones
          };
          if (usarReacciones) {
            try {
              await llamar("setMessageReaction", {
                chat_id: canal.id,
                message_id: msgId,
                reaction: [{ type: "emoji", emoji: "👍" }]
              });
            } catch (_) {}
          }
          let fijado = false;
          if (fijar) {
            try {
              const rPin = await llamar("pinChatMessage", {
                chat_id: canal.id,
                message_id: msgId,
                disable_notification: false
              });
              fijado = Boolean(rPin && rPin.ok);
            } catch (_) {}
          }
          resultados.push({ canal: canal.titulo, id: canal.id, ok: true, message_id: msgId, fijado });
        } else {
          resultados.push({ canal: canal.titulo, id: canal.id, ok: false, error: (resEnvio && resEnvio.description) || "Error al enviar" });
        }
      } catch (e) {
        resultados.push({ canal: canal.titulo, id: canal.id, ok: false, error: e.message });
      }
    }
  }

  datos.historial_publicaciones = datos.historial_publicaciones || [];
  datos.historial_publicaciones.unshift({
    fecha: new Date().toISOString(),
    app: info.app_name || info.repo || "App",
    version: info.version_name || "",
    es_actualizacion: Boolean(info.es_actualizacion),
    enviados,
    total_canales: datos.canales.length
  });
  if (datos.historial_publicaciones.length > 30) datos.historial_publicaciones.length = 30;
  guardarTodo();

  if (datos.propietario_id) {
    try {
      await llamar("sendMessage", {
        chat_id: datos.propietario_id,
        text: "✅ <b>Publicación automática completada</b>\n\n📱 <b>App:</b> " + escaparHtml(info.app_name || info.repo || "App") +
          (info.version_name ? " v" + escaparHtml(info.version_name) : "") +
          " (" + (info.es_actualizacion ? "Actualización" : "Aplicación nueva") + ")" +
          "\n📢 <b>Canales alcanzados:</b> " + enviados + " de " + datos.canales.length +
          (fijar ? "\n📌 Mensaje fijado en los canales." : ""),
        parse_mode: "HTML",
        reply_markup: tecladoPrincipal()
      });
    } catch (_) {}
  }

  return { ok: enviados > 0, enviados, total: datos.canales.length, resultados };
}

function esAdminBot(userId) {
  if (!datos.propietario_id) {
    datos.propietario_id = userId;
    guardarTodo();
    return true;
  }
  if (String(datos.propietario_id) === String(userId)) return true;
  if (Array.isArray(datos.admins) && datos.admins.some((a) => String(a) === String(userId))) return true;
  return false;
}

async function mostrarListaCanales(chatId) {
  if (!datos.canales || datos.canales.length === 0) {
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "📭 <b>Aún no tienes canales guardados en canales.json.</b>\n\n" +
        "Toca el botón <b>➕ Añadir nuevo canal</b> de abajo para ver la lista de los canales que administras (públicos y privados) y agregar el bot.",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }
  const lineas = ["📋 <b>Canales registrados en canales.json (" + datos.canales.length + "):</b>\n"];
  const botones = [];
  for (let i = 0; i < datos.canales.length; i++) {
    const c = datos.canales[i];
    const tipo = c.username ? ("Público · @" + c.username) : "Privado";
    lineas.push((i + 1) + ". <b>" + escaparHtml(c.titulo) + "</b> (" + tipo + ")\n   ID: <code>" + c.id + "</code>");
    botones.push([{ text: "🗑 Quitar: " + String(c.titulo).slice(0, 28), callback_data: "del_ch:" + c.id }]);
  }
  botones.push([{ text: "🔔 Probar mensaje en mis canales", callback_data: "test_ch" }]);
  await llamar("sendMessage", {
    chat_id: chatId,
    text: lineas.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: botones }
  });
}

async function manejarChatShared(m) {
  const cs = m.chat_shared;
  const chatId = cs.chat_id;
  let titulo = cs.title || "";
  let username = cs.username || "";
  try {
    const info = await llamar("getChat", { chat_id: chatId });
    if (info && info.ok && info.result) {
      titulo = info.result.title || titulo;
      username = info.result.username || username;
    }
  } catch (_) {}
  const guardado = registrarCanal({ id: chatId, titulo: titulo || ("Canal " + chatId), username });
  await llamar("sendMessage", {
    chat_id: m.chat.id,
    text: "✅ <b>Canal agregado:</b> " + escaparHtml(guardado.titulo) + "\n" +
      "🔒 <b>Tipo:</b> " + (guardado.username ? ("Público (@" + escaparHtml(guardado.username) + ")") : "Privado") + "\n" +
      "🆔 <b>ID:</b> <code>" + guardado.id + "</code>\n" +
      "📂 <b>Total en canales.json:</b> " + datos.canales.length + " canal(es).\n\n" +
      "Cuando termine de compilarse tu aplicación o actualización en el panel, el bot se activará, descargará el APK y lo distribuirá aquí según tus opciones de publicación.",
    parse_mode: "HTML",
    reply_markup: tecladoPrincipal()
  });
}

async function manejarMiembroCanal(mcm) {
  const chat = mcm.chat;
  if (!chat || chat.type !== "channel") return;
  const estado = mcm.new_chat_member && mcm.new_chat_member.status;
  if (estado === "administrator" || estado === "member") {
    const guardado = registrarCanal({
      id: chat.id,
      titulo: chat.title || ("Canal " + chat.id),
      username: chat.username || ""
    });
    const destino = (mcm.from && mcm.from.id) || datos.propietario_id;
    if (destino) {
      if (!datos.propietario_id) {
        datos.propietario_id = destino;
        guardarTodo();
      }
      await llamar("sendMessage", {
        chat_id: destino,
        text: "✅ <b>Canal agregado automáticamente:</b> " + escaparHtml(guardado.titulo) + " (" + (guardado.username ? "@" + escaparHtml(guardado.username) : "Privado") + ").\nYa quedó guardado en <code>canales.json</code>.",
        parse_mode: "HTML",
        reply_markup: tecladoPrincipal()
      });
    }
  } else if (estado === "left" || estado === "kicked") {
    if (quitarCanalPorId(chat.id) && datos.propietario_id) {
      await llamar("sendMessage", {
        chat_id: datos.propietario_id,
        text: "ℹ️ El bot fue retirado del canal <b>" + escaparHtml(chat.title || chat.id) + "</b> y se actualizó <code>canales.json</code>.",
        parse_mode: "HTML"
      });
    }
  }
}

async function manejarCallback(cb) {
  const data = String(cb.data || "");
  if (data === "v_up" || data === "v_down") {
    if (!cb.message || !cb.message.chat) return;
    const clave = String(cb.message.chat.id) + ":" + String(cb.message.message_id);
    if (!datos.votos[clave]) {
      datos.votos[clave] = { up: [], down: [], paypal: datos.paypal_url };
    }
    const reg = datos.votos[clave];
    if (!Array.isArray(reg.up)) reg.up = [];
    if (!Array.isArray(reg.down)) reg.down = [];
    const uid = String(cb.from.id);
    let aviso = "";
    if (data === "v_up") {
      reg.down = reg.down.filter((x) => x !== uid);
      if (reg.up.includes(uid)) {
        reg.up = reg.up.filter((x) => x !== uid);
        aviso = "Quitaste tu 👍";
      } else {
        reg.up.push(uid);
        aviso = "¡Gracias por tu 👍!";
      }
    } else {
      reg.up = reg.up.filter((x) => x !== uid);
      if (reg.down.includes(uid)) {
        reg.down = reg.down.filter((x) => x !== uid);
        aviso = "Quitaste tu 👎";
      } else {
        reg.down.push(uid);
        aviso = "Reacción 👎 registrada";
      }
    }
    guardarLocal();
    const filasActuales = (cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) || [];
    const nuevasFilas = [
      [
        { text: "👍 " + reg.up.length, callback_data: "v_up" },
        { text: "👎 " + reg.down.length, callback_data: "v_down" }
      ]
    ];
    for (let i = 1; i < filasActuales.length; i++) {
      nuevasFilas.push(filasActuales[i]);
    }
    await llamar("editMessageReplyMarkup", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: nuevasFilas }
    });
    await llamar("answerCallbackQuery", { callback_query_id: cb.id, text: aviso });
    return;
  }

  if (!cb.from || !esAdminBot(cb.from.id)) {
    await llamar("answerCallbackQuery", { callback_query_id: cb.id, text: "Solo el propietario del bot puede usar esta opción.", show_alert: true });
    return;
  }

  if (data.startsWith("del_ch:")) {
    const idCanal = data.slice(7);
    const quitado = quitarCanalPorId(idCanal);
    await llamar("answerCallbackQuery", { callback_query_id: cb.id, text: quitado ? "Canal eliminado de canales.json" : "Ya no estaba en la lista" });
    if (cb.message && cb.message.chat) {
      await mostrarListaCanales(cb.message.chat.id);
    }
    return;
  }

  if (data === "test_ch") {
    await llamar("answerCallbackQuery", { callback_query_id: cb.id, text: "Enviando mensaje de prueba..." });
    let okCount = 0;
    for (const c of datos.canales) {
      const r = await llamar("sendMessage", {
        chat_id: c.id,
        text: "✅ <b>Prueba de conexión del bot</b>\nEste canal está listo para recibir actualizaciones de tus aplicaciones.",
        parse_mode: "HTML"
      });
      if (r && r.ok) okCount++;
    }
    if (cb.message && cb.message.chat) {
      await llamar("sendMessage", {
        chat_id: cb.message.chat.id,
        text: "🔔 Prueba terminada: se envió correctamente en " + okCount + " de " + datos.canales.length + " canal(es).",
        reply_markup: tecladoPrincipal()
      });
    }
  }
}

async function responderMensaje(m) {
  if (!m.chat || m.chat.type !== "private") return;
  const chatId = m.chat.id;
  if (!esAdminBot(m.from && m.from.id)) {
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "Hola, soy el bot distribuidor de aplicaciones de este proyecto."
    });
    return;
  }

  if (m.chat_shared) {
    return manejarChatShared(m);
  }

  const fChat = (m.forward_origin && m.forward_origin.chat) || m.forward_from_chat;
  if (fChat && fChat.type === "channel") {
    const guardado = registrarCanal({
      id: fChat.id,
      titulo: fChat.title || ("Canal " + fChat.id),
      username: fChat.username || ""
    });
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "✅ <b>Canal agregado por mensaje reenviado:</b> " + escaparHtml(guardado.titulo) + "\n" +
        "🆔 ID: <code>" + guardado.id + "</code>\n" +
        "Asegúrate de que el bot sea administrador en ese canal con permiso de publicar y fijar mensajes.",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  if (m.document && String(m.document.file_name || "").toLowerCase().endsWith(".apk")) {
    const est = estadosChat[chatId] || {};
    const nombreBase = String(m.document.file_name).replace(/\.[aA][pP][kK]$/, "");
    const textoCaption = String(m.caption || "").trim();
    estadosChat[chatId] = {
      esperando: "datos_apk",
      file_id: m.document.file_id,
      apk_nombre: m.document.file_name,
      app_name: est.app_name || nombreBase
    };
    if (textoCaption) {
      const partes = textoCaption.split("\n---\n");
      const desc = partes.length > 1 ? partes[0] : "";
      const nov = partes.length > 1 ? partes[1] : textoCaption;
      estadosChat[chatId] = null;
      await llamar("sendMessage", { chat_id: chatId, text: "📤 Distribuyendo APK en todos tus canales..." });
      const res = await distribuirACanales({
        file_id: m.document.file_id,
        apk_nombre: m.document.file_name,
        app_name: nombreBase,
        descripcion: desc,
        novedades: nov,
        es_actualizacion: partes.length === 1
      });
      if (!res.ok) {
        await llamar("sendMessage", { chat_id: chatId, text: "❌ " + (res.error || "No se pudo publicar."), reply_markup: tecladoPrincipal() });
      }
      return;
    }
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "📦 Recibí <b>" + escaparHtml(m.document.file_name) + "</b>.\n\n" +
        "Envíame los <b>cambios en esta actualización</b> (o descripción y cambios separados por una línea en blanco si es una app nueva).",
      parse_mode: "HTML"
    });
    return;
  }

  const texto = String(m.text || "").trim();
  if (!texto) return;
  const t = texto.toLowerCase();

  const estadoActual = estadosChat[chatId];
  if (estadoActual && t !== "/cancelar" && !t.startsWith("/")) {
    if (estadoActual.esperando === "paypal") {
      estadosChat[chatId] = null;
      if (t === "quitar" || t === "ninguno") {
        datos.paypal_url = "";
      } else {
        datos.paypal_url = normalizarPaypal(texto);
      }
      guardarTodo();
      await llamar("sendMessage", {
        chat_id: chatId,
        text: datos.paypal_url
          ? ("✅ <b>Enlace de PayPal guardado en canales.json:</b>\n" + datos.paypal_url)
          : "ℹ️ Se quitó el enlace de PayPal.",
        parse_mode: "HTML",
        reply_markup: tecladoPrincipal()
      });
      return;
    }
    if (estadoActual.esperando === "datos_apk") {
      estadosChat[chatId] = null;
      let desc = "";
      let nov = texto;
      let esAct = true;
      const bloques = texto.split(/\n\s*\n/);
      if (bloques.length >= 2) {
        desc = bloques[0];
        nov = bloques.slice(1).join("\n\n");
        esAct = false;
      }
      await llamar("sendMessage", { chat_id: chatId, text: "📤 Publicando el APK en tus " + datos.canales.length + " canal(es)..." });
      const res = await distribuirACanales({
        file_id: estadoActual.file_id,
        apk_nombre: estadoActual.apk_nombre,
        app_name: estadoActual.app_name,
        descripcion: desc,
        novedades: nov,
        es_actualizacion: esAct
      });
      if (!res.ok) {
        await llamar("sendMessage", { chat_id: chatId, text: "❌ " + (res.error || "No se pudo publicar."), reply_markup: tecladoPrincipal() });
      }
      return;
    }
  }

  if (t === "/start" || t === "/ayuda" || texto === "⚙️ Estado del bot") {
    estadosChat[chatId] = null;
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "🤖 <b>" + escaparHtml(infoBot.first_name || "E m company") + " — Distribuidor automático de APK</b>\n\n" +
        "📢 <b>Canales en canales.json:</b> " + datos.canales.length + "\n" +
        "💳 <b>Botón de PayPal:</b> " + (datos.paypal_url ? escaparHtml(datos.paypal_url) : "Sin configurar (usa 💳 Configurar PayPal)") + "\n" +
        "📌 <b>Fijar mensaje:</b> " + (datos.opciones_publicacion.fijar !== false ? "Activado" : "Desactivado") + "\n" +
        "👍 <b>Reacciones (👍 / 👎):</b> " + (datos.opciones_publicacion.reacciones !== false ? "Activadas" : "Desactivadas") + "\n\n" +
        "<b>¿Cómo añadir tus canales (públicos o privados)?</b>\n" +
        "• Toca <b>➕ Añadir nuevo canal</b> abajo: verás la lista de los canales que administras y podrás elegirlos e incluir al bot.\n" +
        "• O toca <b>📢 Canales donde está el bot</b> para elegir entre los canales que administras donde el bot ya es miembro.",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  if (t === "/canales" || texto === "📋 Mis canales") {
    estadosChat[chatId] = null;
    await mostrarListaCanales(chatId);
    return;
  }

  if (t === "/anadir" || t === "/agregar") {
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "👇 Toca el botón <b>➕ Añadir nuevo canal</b> en el teclado de abajo para ver la lista de los canales que administras (públicos y privados), o escribe <code>/agregar @nombre_canal</code>.",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  if (t.startsWith("/agregar ") || t.startsWith("/anadir ")) {
    const arg = texto.split(/\s+/)[1].trim();
    const rChat = await llamar("getChat", { chat_id: arg });
    if (!rChat || !rChat.ok || !rChat.result) {
      await llamar("sendMessage", {
        chat_id: chatId,
        text: "❌ No pude acceder a <code>" + escaparHtml(arg) + "</code>. Primero agrega al bot como administrador en el canal o usa el botón <b>➕ Añadir nuevo canal</b>.",
        parse_mode: "HTML",
        reply_markup: tecladoPrincipal()
      });
      return;
    }
    const ch = rChat.result;
    const guardado = registrarCanal({ id: ch.id, titulo: ch.title || arg, username: ch.username || "" });
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "✅ <b>Canal agregado:</b> " + escaparHtml(guardado.titulo) + " (ID: <code>" + guardado.id + "</code>).",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  if (t === "/paypal" || texto === "💳 Configurar PayPal") {
    estadosChat[chatId] = { esperando: "paypal" };
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "💳 <b>Configurar botón de donar vía PayPal</b>\n\n" +
        "Actual: " + (datos.paypal_url ? escaparHtml(datos.paypal_url) : "ninguno") + "\n\n" +
        "Envíame ahora tu enlace de PayPal (ej: <code>https://paypal.me/tuusuario</code>, tu usuario de PayPal.me o tu correo de PayPal), o escribe <code>quitar</code> para desactivarlo.",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  if (t.startsWith("/paypal ")) {
    const valor = texto.slice(8).trim();
    datos.paypal_url = (valor.toLowerCase() === "quitar") ? "" : normalizarPaypal(valor);
    guardarTodo();
    await llamar("sendMessage", {
      chat_id: chatId,
      text: datos.paypal_url ? ("✅ Enlace de PayPal actualizado: " + datos.paypal_url) : "ℹ️ Enlace de PayPal desactivado.",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  if (t === "/publicar" || texto === "📤 Publicar APK") {
    await llamar("sendMessage", {
      chat_id: chatId,
      text: "📤 <b>Cómo publicar un APK:</b>\n\n" +
        "1️⃣ <b>Automático desde el Mega panel de GitHub:</b> En cuanto termina de compilarse la aplicación y pasa a la descarga/cola, el panel despierta al bot vía Render y el bot distribuye el APK según tus <b>Opciones de publicación</b> (app nueva vs actualización).\n\n" +
        "2️⃣ <b>Directo desde este chat:</b> Envíame aquí cualquier archivo <code>.apk</code> para distribuirlo en tus " + datos.canales.length + " canal(es).",
      parse_mode: "HTML",
      reply_markup: tecladoPrincipal()
    });
    return;
  }

  await llamar("sendMessage", {
    chat_id: chatId,
    text: "Usa los botones de abajo para añadir canales, ver tus canales guardados en <code>canales.json</code> o configurar PayPal.",
    parse_mode: "HTML",
    reply_markup: tecladoPrincipal()
  });
}

function leerCuerpoJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (d) => {
      total += d.length;
      if (total > 65 * 1024 * 1024) {
        reject(new Error("Cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf8");
        resolve(str ? JSON.parse(str) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function autorizado(req, body) {
  if (!API_SECRET) return true;
  const auth = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const secHeader = String(req.headers["x-api-secret"] || "").trim();
  const secBody = body && body.secret ? String(body.secret).trim() : "";
  return auth === API_SECRET || secHeader === API_SECRET || secBody === API_SECRET || auth === TOKEN || secBody === TOKEN;
}

http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/" || u.pathname === "/health") {
    res.writeHead(200, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, cors));
    res.end("ok");
    return;
  }
  if (u.pathname === "/api/estado") {
    res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
    res.end(JSON.stringify({
      ok: true,
      bot: infoBot,
      total_canales: datos.canales.length,
      paypal_url: datos.paypal_url,
      opciones_publicacion: datos.opciones_publicacion
    }));
    return;
  }
  if (u.pathname === "/api/canales" && req.method === "GET") {
    await sincronizarDesdeGitHub();
    res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
    res.end(JSON.stringify({
      ok: true,
      canales: datos.canales,
      paypal_url: datos.paypal_url,
      texto_boton_donar: datos.texto_boton_donar,
      opciones_publicacion: datos.opciones_publicacion
    }));
    return;
  }
  if (u.pathname === "/api/canales" && req.method === "POST") {
    try {
      const body = await leerCuerpoJson(req);
      if (!autorizado(req, body)) {
        res.writeHead(401, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
        res.end(JSON.stringify({ ok: false, error: "No autorizado" }));
        return;
      }
      if (Array.isArray(body.canales)) datos.canales = body.canales;
      if (body.agregar_canal) registrarCanal(body.agregar_canal);
      if (body.quitar_canal_id !== undefined) quitarCanalPorId(body.quitar_canal_id);
      if (body.paypal_url !== undefined) datos.paypal_url = normalizarPaypal(body.paypal_url);
      if (body.texto_boton_donar) datos.texto_boton_donar = String(body.texto_boton_donar);
      if (body.opciones_publicacion) datos.opciones_publicacion = normalizarOpciones(body.opciones_publicacion);
      guardarTodo();
      res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
      res.end(JSON.stringify({ ok: true, canales: datos.canales, paypal_url: datos.paypal_url, opciones_publicacion: datos.opciones_publicacion }));
    } catch (e) {
      res.writeHead(400, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (u.pathname === "/api/publicar" && req.method === "POST") {
    try {
      const body = await leerCuerpoJson(req);
      if (!autorizado(req, body)) {
        res.writeHead(401, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
        res.end(JSON.stringify({ ok: false, error: "No autorizado" }));
        return;
      }
      const resultado = await distribuirACanales(body);
      res.writeHead(resultado.ok ? 200 : 400, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
      res.end(JSON.stringify(resultado));
    } catch (e) {
      res.writeHead(500, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  res.writeHead(404, cors);
  res.end("no encontrado");
}).listen(PORT, () => console.log("Bot distribuidor activo en puerto " + PORT));

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  cargarLocal();
  await sincronizarDesdeGitHub();
  if (!TOKEN) {
    console.log("Falta TELEGRAM_BOT_TOKEN");
    return;
  }
  try {
    const me = await llamar("getMe", {});
    if (me && me.ok && me.result) {
      infoBot = me.result;
      console.log("Bot conectado como @" + (infoBot.username || infoBot.first_name));
    }
    await llamar("deleteWebhook", { drop_pending_updates: false });
    await llamar("setMyCommands", {
      commands: [
        { command: "start", description: "Menú principal y añadir canales" },
        { command: "canales", description: "Ver y gestionar mis canales guardados" },
        { command: "anadir", description: "Añadir nuevo canal público o privado" },
        { command: "paypal", description: "Configurar botón de donar vía PayPal" },
        { command: "publicar", description: "Publicar un APK en todos los canales" },
        { command: "ayuda", description: "Ver estado y ayuda del bot" }
      ]
    });
  } catch (e) {
    console.log("Aviso inicializando Telegram:", e.message);
  }
  let offset = 0;
  for (;;) {
    try {
      const r = await llamar("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"]
      });
      if (r && r.ok && Array.isArray(r.result)) {
        for (const u of r.result) {
          offset = u.update_id + 1;
          if (u.my_chat_member) await manejarMiembroCanal(u.my_chat_member);
          if (u.callback_query) await manejarCallback(u.callback_query);
          if (u.message) await responderMensaje(u.message);
        }
      } else {
        await esperar(5000);
      }
    } catch (e) {
      console.log("Error en polling:", e.message);
      await esperar(5000);
    }
  }
})();

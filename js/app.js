// app.js — Copresentar: presentación PDF con control compartido en tiempo real.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { createDefaultHub } from './relay.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/* ------------------------------ utilidades ------------------------------ */

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
function randId(n) {
  const r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (x) => ALFABETO[x % ALFABETO.length]).join('');
}
const clientId = randId(12);

function leerHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { sala: (p.get('sala') || '').toLowerCase().replace(/[^a-z0-9]/g, ''), rol: p.get('rol') || '' };
}
function baseUrl() { return location.href.split('#')[0]; }
function enlaceControl(sala) { return baseUrl() + '#sala=' + sala; }

async function copiar(texto, boton) {
  let ok = false;
  try { await navigator.clipboard.writeText(texto); ok = true; } catch (e) {
    const t = document.createElement('textarea');
    t.value = texto; document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
    t.remove();
  }
  if (boton) {
    const orig = boton.dataset.orig || boton.textContent;
    boton.dataset.orig = orig;
    boton.textContent = ok ? '¡Copiado!' : 'Copialo a mano';
    setTimeout(() => { boton.textContent = orig; }, 1600);
  }
}

function esCampo(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'); }

// Para pruebas: ?broker=ws://localhost:9001 usa un broker propio en lugar de los públicos.
function opcionesRed() {
  const q = new URLSearchParams(location.search);
  const b = q.get('broker');
  if (b) return { brokers: [{ label: 'propio', url: b }], noNtfy: true };
  return undefined;
}

/* ------------------------------ PDF ------------------------------ */

async function abrirPdf(file) {
  const nombre = (file.name || '').toLowerCase();
  if (/\.(pptx?|odp|key)$/.test(nombre)) {
    const e = new Error('PPTX'); e.code = 'PPTX'; throw e;
  }
  if (!(file.type === 'application/pdf' || nombre.endsWith('.pdf'))) {
    const e = new Error('TIPO'); e.code = 'TIPO'; throw e;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjsLib.getDocument({ data }).promise;
}

class Renderizador {
  constructor(pdf) { this.pdf = pdf; this.cache = new Map(); }
  _imagen(n, w, h) {
    const key = n + '@' + Math.round(w) + 'x' + Math.round(h);
    if (this.cache.has(key)) return this.cache.get(key);
    const p = (async () => {
      const page = await this.pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(w / vp1.width, h / vp1.height);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      await page.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp }).promise;
      return c;
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return p;
  }
  async dibujar(n, canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const tok = (canvas._tok = (canvas._tok || 0) + 1);
    const src = await this._imagen(n, cssW * dpr, cssH * dpr);
    if (canvas._tok !== tok) return; // llegó otro pedido más nuevo
    canvas.width = src.width;
    canvas.height = src.height;
    canvas.style.width = src.width / dpr + 'px';
    canvas.style.height = src.height / dpr + 'px';
    canvas.getContext('2d').drawImage(src, 0, 0);
  }
  precargar(n, cssW, cssH) {
    if (n < 1 || n > this.pdf.numPages) return;
    const dpr = window.devicePixelRatio || 1;
    this._imagen(n, cssW * dpr, cssH * dpr).catch(() => {});
  }
  limpiar() { this.cache.clear(); }
}

/* ------------------------------ presencia ------------------------------ */

class Presencia {
  constructor(hub, rolPropio, nombreFn) {
    this.hub = hub;
    this.rol = rolPropio;
    this.nombreFn = nombreFn;
    this.pares = new Map(); // id -> {nombre, rol, ultimo}
    this.onchange = null;
    hub.on((m) => {
      if (m.k === 'hola' || m.k === 'estado' || m.k === 'cmd') {
        const prev = this.pares.get(m.from);
        const rol = m.k === 'hola' ? m.rol : (m.k === 'estado' ? 'presentador' : 'control');
        this.pares.set(m.from, { nombre: m.nombre || (prev && prev.nombre) || '', rol: m.rol || rol, ultimo: Date.now() });
        if (!prev) this._cambio();
      } else if (m.k === 'chau') {
        if (this.pares.delete(m.from)) this._cambio();
      }
    });
    this._latido();
    let n = 0;
    setInterval(() => { this._latido(++n % 6 === 0); this._podar(); }, 5000);
    addEventListener('pagehide', () => this.hub.send({ k: 'chau' }));
  }
  _latido(tambienNtfy) {
    this.hub.send({ k: 'hola', rol: this.rol, nombre: this.nombreFn() }, { ntfyIfAlone: !!tambienNtfy });
  }
  _podar() {
    const ahora = Date.now();
    let cambio = false;
    for (const [id, p] of this.pares) if (ahora - p.ultimo > 45000) { this.pares.delete(id); cambio = true; }
    this._cambio(cambio);
  }
  _cambio() { this.onchange && this.onchange(); }
  activos(rol) {
    const ahora = Date.now();
    return [...this.pares.values()].filter((p) => (!rol || p.rol === rol) && ahora - p.ultimo < 45000);
  }
}

function pintarRed(el, hub) {
  const { on, total } = hub.networkSummary();
  el.className = 'red ' + (on.length === 0 ? 'mal' : on.length < 2 ? 'regular' : 'bien');
  el.textContent = on.length === 0 ? 'Sin conexión' : 'Conectado (' + on.length + '/' + total + ')';
  el.title = on.length ? 'Servidores activos: ' + on.join(', ') : 'Reintentando conectar…';
}

/* ------------------------------ vistas ------------------------------ */

function mostrar(id) {
  for (const v of document.querySelectorAll('.vista')) v.hidden = v.id !== id;
}

let pdfActual = null;

function iniciarInicio(salaReanudar) {
  mostrar('inicio');
  const nombre = $('#nombre-pres');
  nombre.value = store.get('cp-nombre') || '';
  nombre.addEventListener('input', () => store.set('cp-nombre', nombre.value.trim()));

  const aviso = $('#aviso-reanudar');
  if (salaReanudar) {
    aviso.hidden = false;
    aviso.innerHTML = 'Se recargó la página. Volvé a elegir el PDF para seguir en la <strong>misma sala</strong>: el enlace de tu colega sigue sirviendo.';
  }

  const zona = $('#zona');
  const input = $('#archivo');
  const err = $('#error-archivo');

  async function usar(file) {
    err.hidden = true;
    zona.classList.add('cargando');
    try {
      const pdf = await abrirPdf(file);
      pdfActual = { pdf, nombre: file.name };
      const sala = salaReanudar || randId(10);
      history.replaceState(null, '', '#sala=' + sala + '&rol=presentador');
      iniciarPresentador(sala, pdf, !salaReanudar);
    } catch (e) {
      err.hidden = false;
      if (e.code === 'PPTX') err.innerHTML = 'Ese es un archivo de PowerPoint. Exportalo primero a PDF: <b>Archivo → Exportar → Crear PDF</b> (o “Guardar como… PDF”) y elegí ese PDF.';
      else if (e.code === 'TIPO') err.textContent = 'El archivo tiene que ser un PDF.';
      else err.textContent = 'No se pudo abrir el PDF (' + (e.message || e) + ').';
    } finally {
      zona.classList.remove('cargando');
      input.value = '';
    }
  }

  input.addEventListener('change', () => input.files[0] && usar(input.files[0]));
  zona.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('encima'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
  zona.addEventListener('drop', (e) => {
    e.preventDefault();
    zona.classList.remove('encima');
    const f = e.dataTransfer.files[0];
    if (f) usar(f);
  });
}

/* ------------------------------ PRESENTADOR ------------------------------ */

function iniciarPresentador(sala, pdf, mostrarDialogo) {
  mostrar('presentador');
  document.title = 'Presentando · Copresentar';
  const total = pdf.numPages;
  const rend = new Renderizador(pdf);
  const lienzo = $('#lienzo');
  const escenario = $('#escenario');
  const barra = $('#barra');
  const nombre = () => store.get('cp-nombre') || 'Presentador';
  const enlace = enlaceControl(sala);

  let slide = 1;
  let seq = 0;
  let restaurando = true;
  let ultimoCambio = null;

  const hub = createDefaultHub(sala, clientId, opcionesRed());
  const pres = new Presencia(hub, 'presentador', nombre);

  function tamEscenario() { return { w: escenario.clientWidth, h: escenario.clientHeight }; }
  function render() {
    const { w, h } = tamEscenario();
    rend.dibujar(slide, lienzo, w, h).catch((e) => console.error(e));
    rend.precargar(slide + 1, w, h);
    rend.precargar(slide - 1, w, h);
    $('#p-num').textContent = slide + ' / ' + total;
  }
  function publicar() {
    seq = Math.max(Date.now(), seq + 1);
    hub.send({ k: 'estado', slide, total, seq, nombre: nombre(), por: ultimoCambio }, { retain: true, important: true });
  }
  function ir(n, por) {
    n = Math.max(1, Math.min(total, n | 0));
    restaurando = false;
    ultimoCambio = por || nombre();
    if (n !== slide) { slide = n; render(); }
    publicar();
    pintarEstado();
  }

  hub.on((m) => {
    if (m.k === 'cmd') {
      const quien = m.nombre || 'Colaborador';
      if (m.op === 'sig') ir(slide + 1, quien);
      else if (m.op === 'ant') ir(slide - 1, quien);
      else if (m.op === 'ir') ir(Number(m.n), quien);
    } else if (m.k === 'pedir') {
      publicar();
    } else if (m.k === 'estado' && m.total === total && m.seq > seq) {
      // Otro presentador en la misma sala, o el estado guardado antes de recargar la página.
      seq = m.seq;
      if (m.slide !== slide) { slide = Math.max(1, Math.min(total, m.slide)); render(); }
      if (restaurando) { restaurando = false; }
    }
  });

  // Espera un momento al estado guardado (por si se recargó la página) y luego publica.
  setTimeout(() => { restaurando = false; publicar(); }, 1500);

  function pintarEstado() {
    const ctrls = pres.activos('control');
    const el = $('#p-colabs');
    if (ctrls.length === 0) {
      el.textContent = 'Nadie más conectado';
      el.className = 'estado apagado';
    } else {
      const nombres = ctrls.map((p) => p.nombre || 'Sin nombre').join(', ');
      el.textContent = 'Controlan: ' + nombres;
      el.className = 'estado encendido';
    }
    el.title = ultimoCambio ? 'Último cambio: ' + ultimoCambio : '';
  }
  pres.onchange = pintarEstado;
  hub.onstatus = () => pintarRed($('#p-red'), hub);
  hub.start();
  setInterval(pintarEstado, 5000);
  pintarEstado();

  // Controles
  $('#p-ant').onclick = () => ir(slide - 1);
  $('#p-sig').onclick = () => ir(slide + 1);
  $('#p-copiar').onclick = (e) => copiar(enlace, e.currentTarget);
  $('#p-full').onclick = alternarPantallaCompleta;
  $('#p-salir').onclick = () => {
    if (confirm('¿Salir de la presentación? Tu colega dejará de poder controlarla.')) {
      history.replaceState(null, '', baseUrl());
      location.reload();
    }
  };

  let numTecleado = '';
  addEventListener('keydown', (e) => {
    if (esCampo(e.target) || $('#dlg-enlace').open) return;
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'n', 'N'].includes(k) || (k === 'Enter' && !numTecleado)) { e.preventDefault(); ir(slide + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) { e.preventDefault(); ir(slide - 1); }
    else if (k === 'Home') ir(1);
    else if (k === 'End') ir(total);
    else if (k === 'f' || k === 'F') alternarPantallaCompleta();
    else if (k === 'b' || k === 'B' || k === '.') $('#negro').hidden = !$('#negro').hidden;
    else if (/^[0-9]$/.test(k)) { numTecleado += k; clearTimeout(ir._t); ir._t = setTimeout(() => (numTecleado = ''), 2000); }
    else if (k === 'Enter' && numTecleado) { ir(Number(numTecleado)); numTecleado = ''; }
  });

  // Barra que se oculta sola para que no aparezca en la pantalla compartida
  let ocultarT;
  function mostrarBarra() {
    barra.classList.add('visible');
    document.body.classList.remove('sin-cursor');
    clearTimeout(ocultarT);
    ocultarT = setTimeout(() => {
      if (barra.matches(':hover')) return mostrarBarra();
      barra.classList.remove('visible');
      document.body.classList.add('sin-cursor');
    }, 2500);
  }
  addEventListener('mousemove', mostrarBarra);
  mostrarBarra();

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { rend.limpiar(); render(); }, 120); });
  render();

  // Diálogo inicial con el enlace
  $('#dlg-url').value = enlace;
  $('#dlg-copiar').onclick = (e) => copiar(enlace, e.currentTarget);
  $('#dlg-cerrar').onclick = () => $('#dlg-enlace').close();
  if (mostrarDialogo) $('#dlg-enlace').showModal();

  addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
}

function alternarPantallaCompleta() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

/* ------------------------------ CONTROL REMOTO ------------------------------ */

function iniciarControl(sala) {
  mostrar('control');
  document.title = 'Control remoto · Copresentar';
  $('#c-estado').title = 'Sala ' + sala;

  const inpNombre = $('#nombre-ctrl');
  inpNombre.value = store.get('cp-nombre') || '';
  inpNombre.addEventListener('input', () => store.set('cp-nombre', inpNombre.value.trim()));
  const nombre = () => inpNombre.value.trim() || 'Colaborador';

  let slide = 0, total = 0, seq = 0;
  let pendiente = null; // diapositiva esperada tras un comando propio
  let pendienteT = null;
  let rend = null;
  let ultimoEstado = 0;
  let por = null;

  const hub = createDefaultHub(sala, clientId, opcionesRed());
  const pres = new Presencia(hub, 'control', nombre);

  function pintar() {
    const mostrado = pendiente != null ? pendiente : slide;
    const txtNum = total ? mostrado + ' / ' + total : '– / –';
    $('#c-num').textContent = txtNum;
    $('#c-num-grande').textContent = txtNum;
    $('#c-num').classList.toggle('pendiente', pendiente != null);
    $('#c-ant').disabled = !total || mostrado <= 1;
    $('#c-sig').disabled = !total || mostrado >= total;

    const sel = $('#c-ir');
    if (sel.options.length !== total) {
      sel.innerHTML = '';
      for (let i = 1; i <= total; i++) sel.add(new Option('Diapositiva ' + i, i));
    }
    if (total) sel.value = String(mostrado);

    const presentadores = pres.activos('presentador');
    const est = $('#c-estado');
    if (presentadores.length || Date.now() - ultimoEstado < 45000) {
      const quien = (presentadores[0] && presentadores[0].nombre) || 'el presentador';
      est.textContent = 'Conectado con ' + quien + (por ? ' · último cambio: ' + por : '');
      est.className = 'c-estado ok';
    } else {
      est.textContent = total ? 'Se perdió contacto con el presentador… reintentando' : 'Buscando al presentador… (tiene que tener la presentación abierta)';
      est.className = 'c-estado espera';
    }

    if (rend && total) {
      const v = $('#c-escenario');
      const n = Math.min(mostrado, rend.pdf.numPages);
      rend.dibujar(n, $('#c-lienzo'), v.clientWidth, v.clientHeight).catch(() => {});
      rend.precargar(n + 1, v.clientWidth, v.clientHeight);
      rend.precargar(n - 1, v.clientWidth, v.clientHeight);
      const sig = mostrado + 1;
      $('#c-siguiente').hidden = sig > rend.pdf.numPages;
      if (sig <= rend.pdf.numPages) rend.dibujar(sig, $('#c-lienzo2'), 104, 58).catch(() => {});
    }
  }

  function comando(op, n) {
    if (!total) return;
    const base = pendiente != null ? pendiente : slide;
    let destino = op === 'sig' ? base + 1 : op === 'ant' ? base - 1 : n;
    destino = Math.max(1, Math.min(total, destino));
    pendiente = destino;
    clearTimeout(pendienteT);
    pendienteT = setTimeout(() => { pendiente = null; pintar(); }, 4000);
    hub.send({ k: 'cmd', op, n: destino, nombre: nombre() }, { important: true });
    pintar();
  }

  hub.on((m) => {
    if (m.k === 'estado' && m.seq > seq) {
      seq = m.seq;
      slide = m.slide;
      total = m.total;
      por = m.por || null;
      ultimoEstado = Date.now();
      if (pendiente === slide) { pendiente = null; clearTimeout(pendienteT); }
      pintar();
    }
  });
  pres.onchange = pintar;
  hub.onstatus = () => pintarRed($('#c-red'), hub);
  hub.start();

  // Pide el estado al entrar y cada tanto mientras no haya respuesta.
  const pedir = () => hub.send({ k: 'pedir', nombre: nombre() }, { important: true });
  setTimeout(pedir, 800);
  setInterval(() => { if (!total || Date.now() - ultimoEstado > 30000) pedir(); pintar(); }, 4000);

  $('#c-ant').onclick = () => comando('ant');
  $('#c-sig').onclick = () => comando('sig');
  $('#c-ir').onchange = (e) => comando('ir', Number(e.target.value));
  $('#c-zona-ant').onclick = () => comando('ant');
  $('#c-zona-sig').onclick = () => comando('sig');
  $('#c-full').onclick = alternarPantallaCompleta;

  addEventListener('keydown', (e) => {
    if (esCampo(e.target)) return;
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)) { e.preventDefault(); comando('sig'); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) { e.preventDefault(); comando('ant'); }
    else if (k === 'Home') comando('ir', 1);
    else if (k === 'End') comando('ir', total);
    else if (k === 'f' || k === 'F') alternarPantallaCompleta();
  });

  // PDF opcional para ver las diapositivas en el control
  const inp = $('#c-archivo');
  $('#c-cargar').onclick = () => inp.click();
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const pdf = await abrirPdf(f);
      rend = new Renderizador(pdf);
      $('#c-sinpdf').hidden = true;
      $('#c-escenario').classList.add('con-pdf');
      pintar();
    } catch (e) {
      alert(e.code === 'PPTX' ? 'Elegí el PDF exportado, no el PowerPoint.' : 'No se pudo abrir ese archivo.');
    }
  };
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (rend) { rend.limpiar(); pintar(); } }, 150); });

  // Mantener la pantalla del celular encendida
  async function wake() { try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {} }
  wake();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });

  pintar();
}

/* ------------------------------ arranque ------------------------------ */

function arrancar() {
  const { sala, rol } = leerHash();
  if (sala && rol !== 'presentador') iniciarControl(sala);
  else iniciarInicio(sala && rol === 'presentador' ? sala : null);
}

addEventListener('hashchange', () => location.reload());
arrancar();

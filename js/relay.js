// relay.js — mensajería en tiempo real sin servidor propio.
//
// Usa varios "relays" públicos a la vez y descarta duplicados:
//   · Brokers MQTT públicos por WebSocket seguro (HiveMQ, EMQX, Mosquitto).
//   · ntfy.sh por el puerto 443, como respaldo para redes que bloquean otros puertos.
//   · BroadcastChannel, para pestañas del mismo navegador (pruebas locales).
// Alcanza con que UN relay funcione en cada lado para que la sincronización ande.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const MQTT_BROKERS = [
  { label: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
  { label: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  { label: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
];
export const NTFY_BASE = 'https://ntfy.sh';

/* ------------------------------------------------------------------ */
/* Cliente MQTT 3.1.1 mínimo (QoS 0) sobre WebSocket                   */
/* ------------------------------------------------------------------ */

function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
}
function mqttString(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 255;
  out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}
function remainingLength(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    out.push(d);
  } while (n > 0);
  return out;
}
function mqttPacket(firstByte, parts) {
  const body = concat(parts);
  return concat([Uint8Array.from([firstByte, ...remainingLength(body.length)]), body]);
}

export class MqttRelay {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.kind = 'mqtt';
    this.status = 'off'; // off | connecting | on
    this.onmessage = null;
    this.onstatus = null;
    this.retryMs = 1000;
    this.buf = new Uint8Array(0);
  }
  start(topic, clientId) {
    this.topic = topic;
    this.clientId = clientId.slice(0, 23);
    this._connect();
  }
  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onstatus && this.onstatus();
  }
  _connect() {
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url, ['mqtt']);
    } catch (e) {
      this._setStatus('off');
      this._scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    const giveUp = setTimeout(() => { if (this.status !== 'on') try { ws.close(); } catch (e) {} }, 8000);

    ws.onopen = () => {
      const keepAlive = 30;
      ws.send(mqttPacket(0x10, [
        mqttString('MQTT'),
        Uint8Array.from([4, 0x02, keepAlive >> 8, keepAlive & 255]), // nivel 4 = 3.1.1, clean session
        mqttString(this.clientId),
      ]));
    };
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      this.buf = concat([this.buf, new Uint8Array(ev.data)]);
      this._parse();
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(giveUp);
      clearInterval(this.pingTimer);
      if (this.ws === ws) {
        this.ws = null;
        this._setStatus('off');
        this._scheduleRetry();
      }
    };
  }
  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 20000);
  }
  _parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let mult = 1, len = 0, i = 1, d;
      do {
        if (i >= b.length) return;
        d = b[i++];
        len += (d & 127) * mult;
        mult *= 128;
        if (i > 5) { try { this.ws && this.ws.close(); } catch (e) {} return; }
      } while (d & 128);
      if (b.length < i + len) return;
      const type = b[0] >> 4;
      const flags = b[0] & 15;
      const body = b.subarray(i, i + len);
      this.buf = b.slice(i + len);
      this._handle(type, flags, body);
    }
  }
  _handle(type, flags, body) {
    if (type === 2) { // CONNACK
      if (body.length < 2 || body[1] !== 0) { try { this.ws.close(); } catch (e) {} return; }
      this.retryMs = 1000;
      // SUBSCRIBE (id de paquete 1, QoS 0)
      this.ws.send(mqttPacket(0x82, [Uint8Array.from([0, 1]), mqttString(this.topic), Uint8Array.from([0])]));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try { if (this.ws && this.ws.readyState === 1) this.ws.send(Uint8Array.from([0xC0, 0])); } catch (e) {}
      }, 20000);
    } else if (type === 9) { // SUBACK
      this._setStatus('on');
    } else if (type === 3) { // PUBLISH
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      let p = 2 + tl;
      if ((flags >> 1) & 3) p += 2; // id de paquete si QoS > 0
      if (topic === this.topic && this.onmessage) this.onmessage(dec.decode(body.subarray(p)), this.label);
    }
  }
  send(text, retain) {
    if (this.status !== 'on' || !this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(mqttPacket(0x30 | (retain ? 1 : 0), [mqttString(this.topic), enc.encode(text)]));
      return true;
    } catch (e) { return false; }
  }
}

/* ------------------------------------------------------------------ */
/* ntfy.sh — respaldo por HTTPS/443                                    */
/* ------------------------------------------------------------------ */

export class NtfyRelay {
  constructor(base = NTFY_BASE) {
    this.base = base;
    this.label = 'ntfy';
    this.kind = 'ntfy';
    this.status = 'off';
    this.onmessage = null;
    this.onstatus = null;
    this.retryMs = 2000;
    this.seen = new Set();
  }
  start(topic) {
    this.topic = topic.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    this._connect();
  }
  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onstatus && this.onstatus();
  }
  _deliver(ev) {
    if (!ev || ev.event !== 'message' || typeof ev.message !== 'string') return;
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
    this.onmessage && this.onmessage(ev.message, this.label);
  }
  _connect() {
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/' + this.topic + '/ws');
    } catch (e) {
      this._setStatus('off');
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.event === 'open') {
        this.retryMs = 2000;
        this._setStatus('on');
        this._fetchLatest();
      } else {
        this._deliver(ev);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this._setStatus('off');
        this._scheduleRetry();
      }
    };
  }
  async _fetchLatest() {
    // Recupera el último mensaje (estado actual) al unirse.
    try {
      const r = await fetch(this.base + '/' + this.topic + '/json?poll=1&since=latest');
      const text = await r.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { this._deliver(JSON.parse(line)); } catch (e) {}
      }
    } catch (e) {}
  }
  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }
  send(text) {
    if (this.status !== 'on') return false;
    fetch(this.base + '/' + this.topic, { method: 'POST', body: text }).catch(() => {});
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* BroadcastChannel — mismas pestañas del mismo navegador              */
/* ------------------------------------------------------------------ */

export class LocalRelay {
  constructor() {
    this.label = 'local';
    this.kind = 'local';
    this.status = 'off';
    this.onmessage = null;
    this.onstatus = null;
  }
  start(topic) {
    if (typeof BroadcastChannel === 'undefined') return;
    this.ch = new BroadcastChannel(topic);
    this.ch.onmessage = (e) => this.onmessage && this.onmessage(e.data, this.label);
    this.status = 'on';
  }
  send(text) {
    if (!this.ch) return false;
    this.ch.postMessage(text);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Hub: reparte por todos los relays y elimina duplicados              */
/* ------------------------------------------------------------------ */

export class Hub {
  constructor({ room, clientId, relays }) {
    this.room = room;
    this.clientId = clientId;
    this.relays = relays;
    this.handlers = [];
    this.onstatus = null;
    this.seenMids = new Set();
    this.midCounter = 0;
    this.peerRelays = new Map(); // clientId -> { relays, last }
  }
  start() {
    const topic = 'copresentar/v1/' + this.room;
    for (const r of this.relays) {
      r.onmessage = (text, label) => this._receive(text, label);
      r.onstatus = () => this.onstatus && this.onstatus();
      if (r.kind === 'ntfy') r.start('copresentar_v1_' + this.room);
      else if (r.kind === 'local') r.start('copresentar-' + this.room);
      else r.start(topic, 'cp' + this.clientId);
    }
    this.onstatus && this.onstatus();
  }
  on(fn) { this.handlers.push(fn); }
  activeRelays() { return this.relays.filter((r) => r.status === 'on').map((r) => r.label); }
  networkSummary() {
    const remote = this.relays.filter((r) => r.kind !== 'local');
    return { on: remote.filter((r) => r.status === 'on').map((r) => r.label), total: remote.length };
  }
  _mqttUp() { return this.relays.filter((r) => r.kind === 'mqtt' && r.status === 'on').map((r) => r.label); }
  _needNtfy() {
    const mine = this._mqttUp();
    if (mine.length === 0) return true;
    const now = Date.now();
    for (const [, p] of this.peerRelays) {
      if (now - p.last > 60000) continue;
      if (!p.relays.some((l) => mine.includes(l))) return true;
    }
    return false;
  }
  /**
   * opts.retain: el broker guarda el mensaje para quien se una después.
   * opts.important: también va por ntfy si hace falta (cambios de diapositiva).
   */
  send(msg, opts = {}) {
    msg.v = 1;
    msg.from = this.clientId;
    msg.mid = this.clientId + '.' + Date.now().toString(36) + '.' + (this.midCounter++).toString(36);
    msg.relays = this._mqttUp();
    const text = JSON.stringify(msg);
    this.seenMids.add(msg.mid);
    const useNtfy = opts.important ? this._needNtfy() : (opts.ntfyIfAlone && this._mqttUp().length === 0);
    for (const r of this.relays) {
      if (r.kind === 'ntfy' && !useNtfy) continue;
      r.send(text, !!opts.retain);
    }
  }
  _receive(text, label) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || msg.v !== 1 || !msg.mid || msg.from === this.clientId) return;
    if (this.seenMids.has(msg.mid)) return;
    this.seenMids.add(msg.mid);
    if (this.seenMids.size > 2000) this.seenMids = new Set([...this.seenMids].slice(-500));
    if (Array.isArray(msg.relays)) this.peerRelays.set(msg.from, { relays: msg.relays, last: Date.now() });
    for (const h of this.handlers) {
      try { h(msg, label); } catch (e) { console.error(e); }
    }
  }
}

export function createDefaultHub(room, clientId, overrides) {
  const brokers = (overrides && overrides.brokers) || MQTT_BROKERS;
  const relays = brokers.map((b) => new MqttRelay(b.url, b.label));
  if (!(overrides && overrides.noNtfy)) relays.push(new NtfyRelay((overrides && overrides.ntfy) || NTFY_BASE));
  relays.push(new LocalRelay());
  return new Hub({ room, clientId, relays });
}

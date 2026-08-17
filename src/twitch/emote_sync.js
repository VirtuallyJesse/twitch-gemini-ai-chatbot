// src/twitch/emote_sync.js
// Multiplexed 7TV EventAPI + BTTV sockets with silent jittered reconnect.
// EmotePool owns what the frames mean.

export function backoffDelay(attempt, { min = 1000, max = 60_000, random = Math.random } = {}) {
  const cap = Math.min(max, min * (2 ** Math.max(0, attempt)));
  return Math.floor(cap * (0.5 + random() * 0.5));
}

const defaultTimers = {
  setTimeout: (...a) => globalThis.setTimeout(...a),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (...a) => globalThis.setInterval(...a),
  clearInterval: (id) => globalThis.clearInterval(id)
};

function safeParse(raw) {
  try { return JSON.parse(typeof raw === 'string' ? raw : String(raw)); }
  catch { return null; }
}

export class SevenTvEventListener {
  constructor({
    wsImpl,
    url = 'wss://events.7tv.io/v3',
    timerImpl = defaultTimers,
    onDispatch,
    random = Math.random
  } = {}) {
    this.#wsImpl = wsImpl;
    this.#url = url;
    this.#timer = timerImpl;
    this.#onDispatch = onDispatch || (() => {});
    this.#random = random;
  }

  #wsImpl; #url; #timer; #onDispatch; #random;
  #socket = null;
  #setIds = new Set();
  #attempt = 0;
  #reconnectTimer = null;
  #watchTimer = null;
  #heartbeatMs = 25_000;
  #lastMessageAt = 0;
  #disposed = false;
  #openedAt = 0;

  get connected() { return this.#socket?.readyState === 1; }
  get lastMessageAt() { return this.#lastMessageAt; }
  get openedAt() { return this.#openedAt; }

  setSubscriptions(setIds) {
    this.#setIds = new Set([...setIds].filter(Boolean).map(String));
    if (this.#disposed || !this.#wsImpl) return;
    if (!this.#socket) this.#connect();
    else if (this.connected) this.#flushSubs();
  }

  dispose() {
    this.#disposed = true;
    this.#timer.clearTimeout(this.#reconnectTimer);
    this.#timer.clearTimeout(this.#watchTimer);
    this.#reconnectTimer = this.#watchTimer = null;
    try { this.#socket?.close(); } catch { /* ignore */ }
    this.#socket = null;
  }

  #connect() {
    if (this.#disposed || !this.#wsImpl || this.#socket) return;
    let socket;
    try { socket = new this.#wsImpl(this.#url); }
    catch (e) {
      console.error(`[Emotes] 7TV socket construct failed: ${e.message || e}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#openedAt = Date.now();
      this.#touch();
    };
    socket.onmessage = (ev) => this.#onMessage(ev?.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      this.#socket = null;
      this.#timer.clearTimeout(this.#watchTimer);
      if (!this.#disposed) this.#scheduleReconnect();
    };
  }

  #onMessage(raw) {
    const msg = safeParse(raw);
    if (!msg || typeof msg.op !== 'number') return;
    this.#touch();
    if (msg.op === 1) {
      this.#heartbeatMs = Number(msg.d?.heartbeat_interval) || 25_000;
      this.#flushSubs();
    } else if (msg.op === 0 && msg.d) {
      try { this.#onDispatch(msg.d); } catch (e) {
        console.error(`[Emotes] 7TV dispatch failed: ${e.message || e}`);
      }
    } else if (msg.op === 4 || msg.op === 7) {
      try { this.#socket?.close(); } catch { /* ignore */ }
    }
  }

  #flushSubs() {
    if (!this.connected) return;
    for (const object_id of this.#setIds) {
      try {
        this.#socket.send(JSON.stringify({
          op: 35,
          d: { type: 'emote_set.update', condition: { object_id } }
        }));
      } catch { /* ignore */ }
    }
  }

  #touch() {
    this.#lastMessageAt = Date.now();
    this.#timer.clearTimeout(this.#watchTimer);
    const wait = this.#heartbeatMs * 2;
    this.#watchTimer = this.#timer.setTimeout(() => {
      try { this.#socket?.close(); } catch { /* ignore */ }
    }, wait);
    this.#watchTimer?.unref?.();
  }

  #scheduleReconnect() {
    this.#timer.clearTimeout(this.#reconnectTimer);
    const delay = backoffDelay(this.#attempt++, { random: this.#random });
    this.#reconnectTimer = this.#timer.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer?.unref?.();
  }
}

export class BttvEventListener {
  constructor({
    wsImpl,
    url = 'wss://sockets.betterttv.net/ws',
    timerImpl = defaultTimers,
    onEvent,
    random = Math.random
  } = {}) {
    this.#wsImpl = wsImpl;
    this.#url = url;
    this.#timer = timerImpl;
    this.#onEvent = onEvent || (() => {});
    this.#random = random;
  }

  #wsImpl; #url; #timer; #onEvent; #random;
  #socket = null;
  #twitchIds = new Set();
  #attempt = 0;
  #reconnectTimer = null;
  #lastMessageAt = 0;
  #openedAt = 0;
  #disposed = false;

  get connected() { return this.#socket?.readyState === 1; }
  get lastMessageAt() { return this.#lastMessageAt; }
  get openedAt() { return this.#openedAt; }

  setChannels(twitchIds) {
    this.#twitchIds = new Set([...twitchIds].filter(Boolean).map(String));
    if (this.#disposed || !this.#wsImpl) return;
    if (!this.#socket) this.#connect();
    else if (this.connected) this.#flushJoins();
  }

  dispose() {
    this.#disposed = true;
    this.#timer.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    try { this.#socket?.close(); } catch { /* ignore */ }
    this.#socket = null;
  }

  #connect() {
    if (this.#disposed || !this.#wsImpl || this.#socket) return;
    let socket;
    try { socket = new this.#wsImpl(this.#url); }
    catch (e) {
      console.error(`[Emotes] BTTV socket construct failed: ${e.message || e}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      this.#openedAt = Date.now();
      this.#lastMessageAt = Date.now();
      this.#flushJoins();
    };
    socket.onmessage = (ev) => {
      this.#lastMessageAt = Date.now();
      const msg = safeParse(ev?.data);
      if (!msg?.name) return;
      try { this.#onEvent(msg.name, msg.data || {}); } catch (e) {
        console.error(`[Emotes] BTTV event failed: ${e.message || e}`);
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      this.#socket = null;
      if (!this.#disposed) this.#scheduleReconnect();
    };
  }

  #flushJoins() {
    if (!this.connected) return;
    for (const id of this.#twitchIds) {
      try {
        this.#socket.send(JSON.stringify({
          name: 'join_channel',
          data: { name: `twitch:${id}` }
        }));
      } catch { /* ignore */ }
    }
  }

  #scheduleReconnect() {
    this.#timer.clearTimeout(this.#reconnectTimer);
    const delay = backoffDelay(this.#attempt++, { random: this.#random });
    this.#reconnectTimer = this.#timer.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer?.unref?.();
  }
}

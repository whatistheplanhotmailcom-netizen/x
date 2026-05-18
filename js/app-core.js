'use strict';

// Global error handler — surface real errors
window.addEventListener('error', function(e) {
  console.error('[uncaught]', e.message, e.filename, e.lineno);
  var t = document.getElementById('toast');
  if (t) {
    t.textContent = 'Error: ' + (e.message || 'unknown');
    t.className = 'toast show bad';
    setTimeout(function() { t.className = 'toast'; }, 5000);
  }
});

/* ============================================================
   0. UTILITIES
   ============================================================ */
const Utils = {
  uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  },
  distKm(a, b) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const x = Math.sin(dLat/2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  },
  bearing(a, b) {
    const toRad = d => d * Math.PI / 180;
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  },
  fmtDist(km) {
    if (km == null || isNaN(km)) return '—';
    if (km < 1) return Math.round(km * 1000) + ' m';
    return km.toFixed(1) + ' km';
  },
  /** v22.10: human-readable "time ago" from an ISO timestamp. */
  fmtAgo(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!then || isNaN(then)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (sec < 30) return 'just now';
    if (sec < 60) return sec + ' seconds ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
    const days = Math.floor(hr / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  },
  escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  },
  emoji(type, subtype) {
    if (subtype === 'box') return '📦';
    if (subtype === 'spider') return '🕷️';
    return { petrol:'⛽', checkpoint:'🛂', speed_camera:'📷',
             mobile_camera:'📱', pole_camera:'📹', spider_camera:'🕷️',
             speed_change:'⇅', gate:'🚪', traffic_light:'🚦', other:'📝' }[type] || '•';
  },
  typeLabel(t) {
    return { petrol:'Petrol', checkpoint:'Checkpoint', speed_camera:'Speed cam',
             mobile_camera:'Mobile cam', pole_camera:'Pole speed cam', spider_camera:'Spider speed cam',
             speed_change:'Speed zone', gate:'Gate', traffic_light:'Traffic light', other:'Custom' }[t] || t;
  },
  toast(msg, cls) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (cls ? ' ' + cls : '');
    clearTimeout(Utils._toastT);
    Utils._toastT = setTimeout(() => el.className = 'toast', 2400);
  },
};

/* ============================================================
   0b. LOGGER — v22.79
   In-memory event log with a 200-entry cap. Newest entries at index 0.
   When the debug modal is open, every log() call also refreshes the
   visible list via UI.renderDebugLog (looked up lazily, so the logger
   doesn't crash if it fires before UI is defined).
   ============================================================ */
const Logger = {
  MAX: 200,
  logs: [],
  log(type, message, level) {
    const entry = {
      t: new Date().toLocaleTimeString(),
      type: String(type || '').toUpperCase().slice(0, 10),
      msg: String(message == null ? '' : message),
      level: level || '',
    };
    this.logs.unshift(entry);
    if (this.logs.length > this.MAX) this.logs.length = this.MAX;
    // Mirror to devtools console
    try { console.log(`[${entry.type}]`, entry.msg); } catch (e) {}
    // If the debug modal is open, refresh the visible list
    try {
      const modal = document.getElementById('m-debug');
      if (modal && modal.classList.contains('open') &&
          typeof UI !== 'undefined' && UI.renderDebugLog) {
        UI.renderDebugLog();
      }
    } catch (e) {}
  },
  clear() {
    this.logs = [];
    try {
      if (typeof UI !== 'undefined' && UI.renderDebugLog) UI.renderDebugLog();
    } catch (e) {}
  },
  asText() {
    return this.logs.map(L => `[${L.t}] ${L.type}: ${L.msg}`).join('\n');
  },
};

/** Global helper: drop-in `logEvent("GPS", "Position updated")`. */
function logEvent(type, message, level) {
  Logger.log(type, message, level);
}

/* ============================================================
   1. STORAGE
   ============================================================ */
const Storage = {
  KEYS: {
    data: 'roadAlert.v22.data',
    settings: 'roadAlert.v22.settings',
    trips: 'roadAlert.v22.trips',
    gh: 'roadAlert.v22.gh',
    // Legacy keys for migration
    legacyData: 'roadAlert.v17.data',
    legacyDataV8: 'roadAlert.v8.data',
    legacySettings: 'roadAlert.v17.settings',
    legacySettingsV8: 'roadAlert.v8.settings',
    legacyTrips: 'roadAlert.v17.trips',
    legacyGh: 'roadAlert.v17.gh',
    safetyShown: 'roadAlert.v22.safetyShown',
  },
  load(key, def) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return def;
  },
  save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { Utils.toast('Storage full', 'bad'); logEvent('STORE', 'Save failed (' + key + '): ' + e.message, 'err'); return false; }
  },
  defaultData() {
    return { version: 22, activeDestId: null, destinations: [], points: [] };
  },
  defaultSettings() {
    return {
      theme: 'light',
      sound: 'voice',
      voiceGender: 'female',
      announceSide: true,
      alertMarkersM: [2000, 1000, 500],
      speedAlertMode: 'beep',
      overBy: 5,
      autoBackup: false,
      // v22.6: new settings
      flashStartM: 500,        // start flashing Next-ahead border at this distance
      // v22.54: toggle for auto-rotation (heading-up). Defaults ON (v22.64).
      // Survives across sessions; tap the 🧭 button on the map to toggle.
      navMode: true,
      // v22.56: long-press on map captures a point at that location. OFF by
      // default to prevent accidental captures while panning/zooming.
      longPressCapture: false,
      alertRepeatCount: 1,     // how many times each marker repeats (1 = no repeat)
      alertRepeatGapS: 1.5,    // seconds between repeats
      // v22.32: tone frequency (Hz) for proximity ping and base tone (800–3000)
      toneFreq: 1900,
      // v22.32: continuous proximity ping (stepped beeps as you approach)
      proximityPing: true,
      // v22.33: distance (meters) where proximity ping starts. Mid + final bands
      // scale to half + 20% of this (e.g. 1000 → 500 → 200).
      proximityStartM: 1000,
      // v22.76: "Name is here" voice announcement. Speed threshold decides
      // the distance ring: at/above threshold uses 100m, below uses 50m.
      hereSpeedThreshold: 100,  // km/h
      hereRepeatCount: 2,       // how many times the announcement repeats (1-10)
      // v22.78: 3D pitch mode. When true, the map camera is tilted forward
      // to ~60° for a navigation perspective. Toggled via the 3D button on
      // the map overlay; survives across sessions.
      pitchMode: false,
    };
  },
  /** One-time migration: orphan points get auto-assigned to their nearest
   *  destination. Runs once per device on the first v22.3+ launch. */
  migrate() {
    // Check if we already have v22 data
    if (localStorage.getItem(this.KEYS.data)) {
      // v22.3: orphan recovery — runs once
      if (!localStorage.getItem('roadAlert.v22.3.orphansMigrated')) {
        try {
          const d = this.load(this.KEYS.data);
          if (d && Array.isArray(d.points) && Array.isArray(d.destinations) && d.destinations.length) {
            let assigned = 0;
            d.points.forEach(p => {
              if (p.destId) return; // Already assigned
              // Find nearest destination
              let best = null, bestDist = Infinity;
              d.destinations.forEach(dest => {
                const dx = (p.lat - dest.lat) * 111;
                const dy = (p.lng - dest.lng) * 111 * Math.cos(p.lat * Math.PI / 180);
                const km = Math.sqrt(dx * dx + dy * dy);
                if (km < bestDist) { bestDist = km; best = dest; }
              });
              if (best) { p.destId = best.id; assigned++; }
            });
            if (assigned > 0) {
              this.save(this.KEYS.data, d);
              console.log('v22.3: assigned', assigned, 'orphan points to nearest destinations');
            }
          }
          localStorage.setItem('roadAlert.v22.3.orphansMigrated', '1');
        } catch (e) { console.warn('orphan migration', e); }
      }
      // v22.64: heading-up rotation is now the default. Flip existing
      // users' navMode to true once. They can still turn it off via the
      // 🧭 button on the map — we only force the new default a single
      // time, then their preference sticks.
      if (!localStorage.getItem('roadAlert.v22.64.navModeDefault')) {
        try {
          const s = this.load(this.KEYS.settings, null);
          if (s && s.navMode !== true) {
            s.navMode = true;
            this.save(this.KEYS.settings, s);
            console.log('v22.64: navMode set to true (heading-up rotation default)');
          }
          localStorage.setItem('roadAlert.v22.64.navModeDefault', '1');
        } catch (e) { console.warn('navMode default migration', e); }
      }
      // v22.69: re-run navMode default once. The rotation direction was
      // bugged (setBearing(-heading)) through v22.68, so users may have
      // toggled it off thinking it was broken. Reset to true once so they
      // see the corrected behavior. After this runs, their preference
      // (toggled via the 🧭 button) sticks for good.
      if (!localStorage.getItem('roadAlert.v22.69.navModeRefresh')) {
        try {
          const s = this.load(this.KEYS.settings, null);
          if (s && s.navMode !== true) {
            s.navMode = true;
            this.save(this.KEYS.settings, s);
            console.log('v22.69: navMode reset to true (rotation direction fix)');
          }
          localStorage.setItem('roadAlert.v22.69.navModeRefresh', '1');
        } catch (e) { console.warn('navMode refresh migration', e); }
      }
      return;
    }
    // Try v17 first, then v8
    const legacyData = this.load(this.KEYS.legacyData) || this.load(this.KEYS.legacyDataV8);
    if (legacyData) {
      const newData = this.defaultData();
      if (Array.isArray(legacyData.destinations)) newData.destinations = legacyData.destinations;
      if (Array.isArray(legacyData.points)) newData.points = legacyData.points;
      if (legacyData.activeDestId || legacyData.activeDestinationId) {
        newData.activeDestId = legacyData.activeDestId || legacyData.activeDestinationId;
      }
      newData.points.forEach(p => {
        if (!p.id) p.id = Utils.uid();
        if (!p.status) p.status = 'active';
      });
      this.save(this.KEYS.data, newData);
      console.log('Migrated', newData.points.length, 'points from legacy storage');
    }
    const legacySettings = this.load(this.KEYS.legacySettings) || this.load(this.KEYS.legacySettingsV8);
    if (legacySettings) {
      const s = { ...this.defaultSettings(), ...legacySettings };
      this.save(this.KEYS.settings, s);
    }
    const legacyTrips = this.load(this.KEYS.legacyTrips);
    if (Array.isArray(legacyTrips)) this.save(this.KEYS.trips, legacyTrips);
    const legacyGh = this.load(this.KEYS.legacyGh);
    if (legacyGh) this.save(this.KEYS.gh, legacyGh);
  },
};

Storage.migrate();

/* ============================================================
   2. STATE
   ============================================================ */
const State = {
  data: Storage.load(Storage.KEYS.data, Storage.defaultData()),
  settings: { ...Storage.defaultSettings(), ...Storage.load(Storage.KEYS.settings, {}) },
  trips: Storage.load(Storage.KEYS.trips, []),
  gh: Storage.load(Storage.KEYS.gh, { token: '', repo: '', path: 'road-alert.json' }),

  // Runtime
  mode: 'idle',
  watchId: null,
  pos: null,
  prevPos: null,
  prevTs: null,
  accuracy: null,
  lowAccuracy: false,
  // v22.37: GPS health tracking
  lastFixAt: null,        // timestamp of last position update
  lastFixJump: false,     // flag if the latest fix was suspiciously far from the previous one
  speedMps: 0,
  heading: null,
  // v22.52: track WHERE the current heading value came from — 'gps' = iOS
  // gave us coords.heading; 'derived' = we computed from position delta.
  headingSource: null,
  // v22.82: device-orientation compass heading. Set by GPS.setupDeviceOrientation
  // (listens to the `deviceorientation` event). Preferred over GPS heading
  // for the directional triangle because it works even when stationary.
  deviceHeading: null,
  // v22.36: U-turn detection — track previous heading + how many consecutive
  // ticks the heading has reversed. We require sustained reversal (~3 ticks)
  // to avoid false positives from momentary GPS jitter / lane changes.
  prevHeading: null,
  uTurnTicks: 0,
  speedBuffer: [],
  manualLimit: null, // user override via tap on sign
  // v22: threshold-crossing alerts
  // Map: pointId -> Set of marker meters already fired
  alertedMarkers: new Map(),
  // Map: pointId -> last seen distance in meters
  lastDistByPoint: new Map(),
  // v22.15: minimum distance ever seen this trip for each point
  // — used to detect "passed" even when geometric dest-check still says ahead.
  minDistByPoint: new Map(),
  passedPoints: new Set(),
  // v22.16: point IDs that have been auto-announced as "next-ahead" this trip,
  // so we don't repeat the same announcement on every tick.
  autoAnnouncedAhead: new Set(),
  // v22.76: point IDs that have had the "X is here" announcement fired
  // this trip. Cleared on each GPS.start so a fresh session re-announces.
  hereAnnouncedPoints: new Set(),

  wakeLock: null,
  activeTrip: null,
  followMap: true,
  speedAlertWasOver: false,
  lastSpeedAlertZone: null,
  // v22.68: track the last limit we ANNOUNCED out loud, so we only speak
  // when the effective limit changes (entering a new zone).
  lastAnnouncedLimit: null,
  backupTimer: null,
  lastBackup: null,
  lastBackupHash: null,
  pendingCapture: null,
  // v22.39: when a user long-presses on the map to capture at an arbitrary
  // location, beginCapture() uses this lat/lng instead of State.pos.
  // Cleared in finalizeCapture and on capture-menu close.
  captureLocationOverride: null,
  editingPointId: null,
  editingDestId: null,
  limitPickerMode: 'manual', // 'manual' | 'speedchange'
  lastTripCaptureId: null, // v22.10: id of most recent point captured this trip (for double-tap recall)
  alertsFiredThisTrip: 0, // v22.12: count alerts fired since trip start, shown in diag strip

  saveData()     { Storage.save(Storage.KEYS.data, this.data); UI.updateMapPoints(); UI.render(); },
  saveSettings() { Storage.save(Storage.KEYS.settings, this.settings); },
  saveTrips()    { Storage.save(Storage.KEYS.trips, this.trips); },
  saveGh()       { Storage.save(Storage.KEYS.gh, this.gh); },

  activeDest() {
    return this.data.destinations.find(d => d.id === this.data.activeDestId) || null;
  },
  activePoints() {
    // v22.3: STRICT filter — only points belonging to the currently active
    // destination. No more "orphan" points (without destId) leaking into
    // the map view. Orphans can be assigned via Audit or Edit point.
    const id = this.data.activeDestId;
    if (!id) return []; // No active destination → show nothing on the map
    return this.data.points.filter(p => p.destId === id);
  },

  /** All points without a destination assignment (for orphan management). */
  orphanPoints() {
    return this.data.points.filter(p => !p.destId);
  },
};

/* ============================================================
   3. AUDIO
   ============================================================ */
const Audio = {
  ctx: null,
  _voiceCache: null,
  _voiceCacheFor: null,
  _unlocked: false,

  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  unlock() {
    if (this._unlocked) return;
    this.ensure();
    if (this.ctx) {
      try {
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
      } catch (e) {}
    }
    if ('speechSynthesis' in window) {
      try {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch (e) {}
    }
    this._unlocked = true;
  },

  beep(type) {
    const ctx = this.ensure();
    if (!ctx) {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
      return;
    }
    // v22.31: Radarbot-style alert — two pure-tone "pings" with slight pitch
    // rise between them. Distinctive radar-return character: short attack,
    // sustained body, exponential decay. Different per-type pings to keep
    // the per-camera-type cue, but all share the Radarbot signature timbre.
    //
    // Each ping is one entry: { freq, dur, gap }
    // Frequencies based on common radar warning tones (~1800–2400 Hz).
    const patterns = {
      // Classic Radarbot fixed-camera: rising 2-ping
      speed_camera:  [
        { freq: 1900, dur: 0.12 },
        { freq: 2400, dur: 0.18 },
      ],
      // Mobile camera: faster, more urgent triple
      mobile_camera: [
        { freq: 1900, dur: 0.10 },
        { freq: 2200, dur: 0.10 },
        { freq: 2400, dur: 0.14 },
      ],
      // Pole camera: low-high double (distinct from fixed)
      pole_camera: [
        { freq: 1700, dur: 0.12 },
        { freq: 2300, dur: 0.20 },
      ],
      // Spider camera: rapid 4-ping ("many eyes")
      spider_camera: [
        { freq: 2000, dur: 0.08 },
        { freq: 2200, dur: 0.08 },
        { freq: 2400, dur: 0.08 },
        { freq: 2600, dur: 0.16 },
      ],
      // Checkpoint: single sustained mid tone
      checkpoint: [
        { freq: 1500, dur: 0.20 },
        { freq: 1500, dur: 0.20 },
      ],
      // Speed change zone: low rising
      speed_change: [
        { freq: 1400, dur: 0.14 },
        { freq: 1900, dur: 0.14 },
      ],
      // Petrol: single soft chime
      petrol: [
        { freq: 1600, dur: 0.22 },
      ],
      // Gate: triple short
      gate: [
        { freq: 1800, dur: 0.10 },
        { freq: 1800, dur: 0.10 },
        { freq: 1800, dur: 0.10 },
      ],
      other: [
        { freq: 1800, dur: 0.18 },
      ],
    };
    const pings = patterns[type] || patterns.other;
    const peakGain = 0.6;
    const gap = 0.05; // gap between pings
    // v22.32: scale all per-type frequencies by user's preferred base.
    // Patterns are designed around 1900 Hz baseline; user picks 800–3000.
    const userFreq = +State.settings.toneFreq || 1900;
    const freqScale = userFreq / 1900;
    let t = ctx.currentTime;

    pings.forEach(ping => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = ping.freq * freqScale;
      // Sharp attack (3ms), held body, exponential tail
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(peakGain, t + 0.003);
      gain.gain.setValueAtTime(peakGain, t + ping.dur * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.001, t + ping.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + ping.dur + 0.01);
      t += ping.dur + gap;
    });

    // Vibration mirror — silent mode safety net
    if (navigator.vibrate) {
      const vibPattern = [];
      pings.forEach((p, i) => {
        if (i > 0) vibPattern.push(60);
        vibPattern.push(Math.round(p.dur * 1000));
      });
      navigator.vibrate(vibPattern);
    }
  },

  pickVoice() {
    const pref = State.settings.voiceGender || 'female';
    if (pref === 'none') return null;
    if (this._voiceCacheFor === pref && this._voiceCache) return this._voiceCache;
    if (!('speechSynthesis' in window)) return null;
    const voices = speechSynthesis.getVoices();
    if (!voices || !voices.length) return null;
    const femaleNames = ['Samantha', 'Karen', 'Moira', 'Tessa', 'Veena', 'Fiona', 'Victoria'];
    const maleNames   = ['Daniel', 'Alex', 'Aaron', 'Fred', 'Tom', 'Oliver'];
    const wanted = pref === 'male' ? maleNames : femaleNames;
    const enVoices = voices.filter(v => /en[-_]/i.test(v.lang) || v.lang === 'en');
    for (const name of wanted) {
      const v = enVoices.find(x => x.name.includes(name));
      if (v) { this._voiceCache = v; this._voiceCacheFor = pref; return v; }
    }
    if (enVoices[0]) { this._voiceCache = enVoices[0]; this._voiceCacheFor = pref; return enVoices[0]; }
    this._voiceCache = voices[0]; this._voiceCacheFor = pref; return voices[0];
  },

  say(text) {
    if (!('speechSynthesis' in window)) return;
    if (State.settings.voiceGender === 'none') return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) {}
  },

  /** Fire alert for a point crossing a specific marker (meters).
   *  v22.32: tone plays unconditionally; voice plays additionally if
   *  voiceGender !== 'none'. The old 4-way sound mode is now binary
   *  (off vs on) via the master mute. */
  alert(point, meters) {
    const s = State.settings.sound;
    if (s === 'off') return; // master mute still respected
    logEvent('ALERT', `${point.name || Utils.typeLabel(point.type)} @ ${meters}m`);
    // v22.12: count for diagnostic strip
    State.alertsFiredThisTrip = (State.alertsFiredThisTrip || 0) + 1;
    State.lastAlertAt = Date.now();
    State.lastAlertText = (point.name || Utils.typeLabel(point.type)) + ' @ ' + (meters >= 1000 ? (meters/1000) + 'km' : meters + 'm');
    const distText = meters >= 1000 ? (meters/1000) + ' kilometers' : meters + ' meters';
    let text = (point.name || Utils.typeLabel(point.type)) + ' in ' + distText;
    if (State.settings.announceSide && point.side) {
      text += point.side === 'left' ? ', left' : ', right';
    }
    // v22.6: repeat N times with a gap
    const count = Math.max(1, Math.min(5, +State.settings.alertRepeatCount || 1));
    const gapMs = Math.max(0.3, +State.settings.alertRepeatGapS || 1.5) * 1000;
    const voiceOn = State.settings.voiceGender && State.settings.voiceGender !== 'none';
    const fireOnce = () => {
      // v22.32: tone ALWAYS plays (unless master sound is off, which is checked above)
      this.beep(point.type);
      // Voice plays only if a voice gender is selected
      if (voiceOn) this.say(text);
    };
    fireOnce();
    for (let i = 1; i < count; i++) {
      setTimeout(fireOnce, i * gapMs);
    }
  },
  /** v22.32: short single ping at user-configured frequency.
   *  Used by the proximity ping system (continuous stepped beep).
   *  Different from beep() — single tone, short duration, no per-type pattern.
   *  v22.34: also pulses the focused (#1) map marker visually in sync. */
  proximityPing() {
    const ctx = this.ensure();
    if (!ctx) return;
    const freq = +State.settings.toneFreq || 1900;
    const dur = 0.10;
    const peakGain = 0.5;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(peakGain, t + 0.003);
    gain.gain.setValueAtTime(peakGain, t + dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    // v22.34: visual flash on the focused (#1) marker, synced with this ping.
    // v22.60: also flash the matching sidebar timeline entry for ahead-1.
    try {
      const els = document.querySelectorAll('.ra-marker.ahead-1, .timeline-entry.ahead-1');
      els.forEach(el => {
        el.classList.add('flash-on');
        setTimeout(() => el.classList.remove('flash-on'), 140);
      });
    } catch (e) {}
  },

  /** v22.32: state for the stepped proximity pinger.
   *  Tracks last ping time + currently-tracked point id so we know when to reset. */
  _lastProximityPing: 0,
  _proximityPointId: null,

  /** v22.32: called every Alerts.tick() with the distance to the focused point.
   *  v22.33: bands scale with State.settings.proximityStartM:
   *    >= startM         →  silent
   *    startM .. mid     →  one ping every 1.2s  (~0.8 Hz)
   *    mid .. final      →  one ping every 0.5s  (~2 Hz)
   *    < final           →  one ping every 0.2s  (~5 Hz)
   *  Where mid = startM × 0.5, final = startM × 0.2.
   *  When the focused point changes (passed → next), state resets cleanly. */
  updateProximityPing(pointId, distMeters) {
    if (State.settings.sound === 'off') { this._proximityPointId = null; return; }
    if (State.settings.proximityPing === false) { this._proximityPointId = null; return; }
    const startM = +State.settings.proximityStartM || 1000;
    if (pointId == null || distMeters == null || distMeters >= startM) {
      this._proximityPointId = null;
      return;
    }
    // Reset on focus change
    if (pointId !== this._proximityPointId) {
      this._proximityPointId = pointId;
      this._lastProximityPing = 0; // fire immediately on new target
    }
    const midM = startM * 0.5;
    const finalM = startM * 0.2;
    let interval;
    if (distMeters >= midM) interval = 1200;
    else if (distMeters >= finalM) interval = 500;
    else interval = 200;
    const now = Date.now();
    if (now - this._lastProximityPing >= interval) {
      this.proximityPing();
      this._lastProximityPing = now;
    }
  },
};

if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => {
    Audio._voiceCache = null;
    Audio._voiceCacheFor = null;
  };
}

// Unlock audio on first gesture
['touchstart', 'touchend', 'mousedown', 'click'].forEach(ev =>
  document.addEventListener(ev, () => Audio.unlock(), { once: true, passive: true })
);

/* ============================================================
   4. GPS
   ============================================================ */
const GPS = {
  async start() {
    if (!navigator.geolocation) { Utils.toast('GPS not supported', 'bad'); logEvent('GPS', 'Not supported by browser', 'err'); return; }
    logEvent('GPS', 'Tracking started');
    Audio.unlock();
    this.stop();
    // v22.1: reset all runtime alert state for a fresh drive session.
    // Otherwise points that were "passed" in a previous session keep their
    // muted state and never alert again until reload.
    State.alertedMarkers.clear();
    State.lastDistByPoint.clear();
    State.minDistByPoint.clear(); // v22.15: reset passed-detection tracker
    State.passedPoints.clear();
    State.autoAnnouncedAhead.clear(); // v22.16: clear auto-announce history
    State.hereAnnouncedPoints.clear(); // v22.76: clear here-now history
    State.speedAlertWasOver = false;
    State.lastSpeedAlertZone = null;
    State.lastAnnouncedLimit = null; // v22.68: re-announce limit on new session
    State.speedBuffer = [];
    State.lastTripCaptureId = null; // v22.10: reset for new trip
    State.alertsFiredThisTrip = 0; // v22.12: reset alert counter for new trip
    // v22.36: reset U-turn detection state
    State.prevHeading = null;
    State.uTurnTicks = 0;
    // v22.38: reset confirmation queue for fresh trip
    Confirm.resetTrip();
    // v22.58: force the route to be refetched on the first tick of this
    // session — start of the route line is always the current GPS position.
    if (typeof MapView !== 'undefined' && MapView) MapView._routeForDestId = null;
    State.mode = 'gps';
    UI.setStatusMode('LIVE', 'live');
    await this.requestWakeLock();
    State.watchId = navigator.geolocation.watchPosition(
      pos => this.onTick(pos),
      err => { Utils.toast('GPS: ' + err.message, 'bad'); logEvent('GPS', 'Error: ' + err.message, 'err'); this.stop(); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
    UI.setBtnGoActive(true);
  },

  stop() {
    const wasGps = State.mode === 'gps';
    if (State.watchId != null) { navigator.geolocation.clearWatch(State.watchId); State.watchId = null; }
    if (State.wakeLock) { try { State.wakeLock.release(); } catch (e) {} State.wakeLock = null; }
    State.mode = 'idle';
    // v22.58: remove the drawn route line when GPS stops
    if (typeof MapView !== 'undefined' && MapView && MapView.clearRoute) MapView.clearRoute();
    UI.setStatusMode('Idle', '');
    UI.setBtnGoActive(false);
    if (wasGps) logEvent('GPS', 'Tracking stopped');
  },

  /** v22.82: subscribe to the device's compass via DeviceOrientationEvent.
   *  Best-effort:
   *    - On iOS 13+ requires user-gesture permission (piggybacks the next
   *      tap, mirroring how Audio.unlock requests audio).
   *    - On Android, registers immediately; `e.absolute` must be true
   *      to trust `alpha` as a compass bearing.
   *    - On iOS, reads `e.webkitCompassHeading` (already true-north
   *      compass degrees clockwise).
   *  Sets State.deviceHeading; the directional triangle reads from there.
   *  Idempotent — safe to call multiple times. */
  setupDeviceOrientation() {
    if (this._deviceOrientationWired) return;
    this._deviceOrientationWired = true;
    if (typeof DeviceOrientationEvent === 'undefined') {
      logEvent('GPS', 'DeviceOrientationEvent not supported');
      return;
    }
    const handler = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
        // iOS true-north compass
        h = e.webkitCompassHeading;
      } else if (e.alpha != null && !isNaN(e.alpha) && e.absolute === true) {
        // Android absolute orientation: alpha is degrees CCW from north
        h = (360 - e.alpha) % 360;
      }
      if (h != null) State.deviceHeading = h;
    };
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS 13+: needs a user gesture before requestPermission resolves.
      const ask = () => {
        DeviceOrientationEvent.requestPermission().then(s => {
          if (s === 'granted') {
            window.addEventListener('deviceorientation', handler);
            logEvent('GPS', 'Compass permission granted', 'ok');
          } else {
            logEvent('GPS', 'Compass permission ' + s, 'err');
          }
        }).catch(err => logEvent('GPS', 'Compass error: ' + err.message, 'err'));
      };
      // Piggyback on the next user tap (most likely the first interaction).
      document.addEventListener('click', ask, { once: true, passive: true });
      logEvent('GPS', 'Compass: waiting for first tap to request permission');
    } else {
      // Non-iOS or older iOS — no permission flow.
      window.addEventListener('deviceorientation', handler);
      logEvent('GPS', 'Compass listener registered');
    }
  },

  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { State.wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) {}
  },

  /** 4-sample rolling average for speed smoothing */
  smoothSpeed(rawMps) {
    if (rawMps == null || isNaN(rawMps) || rawMps < 0) return State.speedMps;
    State.speedBuffer.push(rawMps);
    if (State.speedBuffer.length > 4) State.speedBuffer.shift();
    return State.speedBuffer.reduce((a, b) => a + b, 0) / State.speedBuffer.length;
  },

  /** v22.36: U-turn detected — un-pass nearby points so they can re-alert.
   *  Only points within 5 km of current position are affected; far-away ones
   *  stay passed (no point re-arming cameras you'll never approach again). */
  _handleUTurn() {
    if (!State.pos) return;
    let reArmed = 0;
    const toReArm = [];
    for (const pid of State.passedPoints) {
      const p = State.data.points.find(x => x.id === pid);
      if (!p) continue;
      const distKm = Utils.distKm(State.pos, p);
      if (distKm <= 5) {
        toReArm.push(pid);
      }
    }
    toReArm.forEach(pid => {
      State.passedPoints.delete(pid);
      State.alertedMarkers.delete(pid);
      State.autoAnnouncedAhead.delete(pid);
      State.minDistByPoint.delete(pid);
      State.lastDistByPoint.delete(pid);
      reArmed++;
    });
    if (reArmed > 0) {
      Utils.toast(`U-turn — ${reArmed} point${reArmed === 1 ? '' : 's'} re-armed`, 'good');
      // Force an immediate map refresh so visuals update
      if (MapView.m) {
        MapView._lastPointRefresh = 0;
        MapView.updatePoints();
      }
    }
  },

  onTick(pos) {
    // v22.79: rate-limited GPS log — every 10s, not every tick.
    if (!this._lastGpsLogAt || Date.now() - this._lastGpsLogAt > 10000) {
      this._lastGpsLogAt = Date.now();
      logEvent('GPS', `Pos ${pos.coords.latitude.toFixed(4)},${pos.coords.longitude.toFixed(4)} ±${Math.round(pos.coords.accuracy)}m ${(pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) + 'km/h' : '')}`.trim());
    }
    // v22.1: don't silently drop low-accuracy readings.
    // Show a "LOW GPS" warning in the status line but still use the position;
    // skipping entirely can freeze the map in poor-signal areas (tunnel, urban canyon).
    State.accuracy = pos.coords.accuracy;
    // v22.12 FIX: raise threshold from 100m → 200m. Phones in cars often
    // report ±50-150m on the highway; the old 100m cut-off was silently
    // dropping ALL alerts in noisy conditions. 200m is still tight enough
    // to ignore obvious garbage readings.
    const lowAcc = pos.coords.accuracy != null && pos.coords.accuracy > 200;
    State.lowAccuracy = lowAcc;

    const prevPos = State.pos;
    const prevTs = State.prevTs;
    State.prevPos = prevPos;
    State.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    State.prevTs = pos.timestamp || Date.now();
    // v22.37: GPS health — record timestamp + detect implausible position jumps.
    // A "jump" is a position change > 500m in under 5 seconds (impossible at
    // realistic driving speed). Could indicate multipath GPS or a bad satellite
    // fix; alert accuracy will be poor until it settles.
    const nowMs = Date.now();
    State.lastFixAt = nowMs;
    if (prevPos && prevTs) {
      const dtSec = (State.prevTs - prevTs) / 1000;
      const jumpM = Utils.distKm(prevPos, State.pos) * 1000;
      State.lastFixJump = (dtSec > 0 && dtSec < 5 && jumpM > 500);
    } else {
      State.lastFixJump = false;
    }

    // Speed: prefer GPS, fall back to time-delta calc
    let rawSpeed = pos.coords.speed;
    if (rawSpeed == null || isNaN(rawSpeed) || rawSpeed < 0) {
      if (prevPos && prevTs) {
        const dtSec = (State.prevTs - prevTs) / 1000;
        if (dtSec > 0 && dtSec < 30) {
          const meters = Utils.distKm(prevPos, State.pos) * 1000;
          if (meters < 1000) {
            rawSpeed = meters / dtSec;
          }
        }
      }
    }
    State.speedMps = this.smoothSpeed(rawSpeed);

    if (State.speedMps * 3.6 > 350) State.speedMps = 0;

    if (pos.coords.heading != null && !isNaN(pos.coords.heading) && State.speedMps > 1) {
      // v22.36: U-turn detection — check angular delta vs last heading.
      // Circular subtraction so 350° → 20° gives a small delta, not 330°.
      if (State.prevHeading != null && State.speedMps > 5) {
        let delta = Math.abs(pos.coords.heading - State.prevHeading);
        if (delta > 180) delta = 360 - delta;
        if (delta > 120) {
          State.uTurnTicks = (State.uTurnTicks || 0) + 1;
        } else if (delta < 30) {
          // Heading stable — reset counter
          State.uTurnTicks = 0;
        }
        // Trigger after 3 consecutive ticks of large heading change
        if (State.uTurnTicks >= 3) {
          this._handleUTurn();
          State.uTurnTicks = 0;
        }
      }
      State.prevHeading = pos.coords.heading;
      State.heading = pos.coords.heading;
      State.headingSource = 'gps';
    } else if (prevPos && State.speedMps > 1) {
      // v22.52: iOS Safari often doesn't provide coords.heading reliably.
      // Compute heading from position delta as a fallback — always works
      // because we always have two consecutive positions over time when
      // moving. Bearing formula: angle from prevPos to current pos.
      const φ1 = prevPos.lat * Math.PI / 180;
      const φ2 = State.pos.lat * Math.PI / 180;
      const Δλ = (State.pos.lng - prevPos.lng) * Math.PI / 180;
      const y = Math.sin(Δλ) * Math.cos(φ2);
      const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
      let bearingDeg = Math.atan2(y, x) * 180 / Math.PI;
      if (bearingDeg < 0) bearingDeg += 360;
      // Only trust the computed heading if the position delta is large
      // enough that we're not just GPS-jitter wobbling.
      // v22.68: 3m -> 1m, so rotation kicks in even at very slow rolls.
      const movedM = Utils.distKm(prevPos, State.pos) * 1000;
      if (movedM > 1) {
        State.prevHeading = bearingDeg;
        State.heading = bearingDeg;
        State.headingSource = 'derived';
      }
    }

    if (State.activeTrip) {
      const kmh = State.speedMps * 3.6;
      if (kmh > State.activeTrip.maxSpeed) State.activeTrip.maxSpeed = kmh;
      if (prevPos && State.speedMps > 1) {
        const segKm = Utils.distKm(prevPos, State.pos);
        if (segKm < 1) State.activeTrip.distanceKm += segKm;
      }
    }

    // v22.12 FIX: only skip alerts on TRULY garbage GPS readings (>500m).
    // Old logic: skipped alerts whenever accuracy was lowAcc (>100m), which
    // meant in noisy areas the user never heard any alerts at all.
    const veryLowAcc = pos.coords.accuracy != null && pos.coords.accuracy > 500;
    if (!veryLowAcc) Alerts.tick();
    UI.render();
    MapView.update();
  },
};

/* ============================================================
   5. ALERTS — threshold crossing
   ============================================================ */
const Alerts = {
  /** Currently effective speed limit (km/h). Manual override wins.
   *  v22.68: proximity-based, cross-destination lookup. We look at every
   *  speed_change point across ALL destinations within 3 km of the user
   *  and take the closest one as "the zone we're in". This means a limit
   *  captured while driving from A → B applies again when driving B → A:
   *  same road, same physical sign, same limit. */
  currentLimit() {
    if (State.manualLimit != null) return State.manualLimit;
    if (!State.pos) return null;
    const candidates = State.data.points
      .filter(p => p.type === 'speed_change' && typeof p.limit === 'number' && p.status !== 'no')
      .map(p => ({ p, dKm: Utils.distKm(State.pos, p) }))
      .filter(x => x.dKm < 3)
      .sort((a, b) => a.dKm - b.dKm);
    return candidates.length ? candidates[0].p.limit : null;
  },

  /** Points relevant for the "Next ahead" display + alert checking */
  ahead() {
    if (!State.pos) return [];
    const dest = State.activeDest();
    if (!dest) {
      return State.activePoints()
        .filter(p => p.status !== 'no' && !State.passedPoints.has(p.id))
        .map(p => ({ ...p, dist: Utils.distKm(State.pos, p) }))
        .sort((a, b) => a.dist - b.dist);
    }
    const myDist = Utils.distKm(State.pos, dest);
    return State.activePoints()
      .filter(p => p.status !== 'no' && !State.passedPoints.has(p.id))
      .map(p => ({ ...p, dist: Utils.distKm(State.pos, p), distToDest: Utils.distKm(p, dest) }))
      .filter(p => p.distToDest < myDist + 0.1)
      .sort((a, b) => a.dist - b.dist);
  },

  /** v22: Threshold-crossing alert logic.
   *  For each point within 5km, check if we've crossed any of the
   *  configured alert markers (e.g., 2000m, 1000m, 500m) since last tick.
   *  v22.18: alerts only fire for the FOCUSED (closest ahead) point — other
   *  points stay silent until the closest one is passed, so two points close
   *  together no longer announce on top of each other. */
  tick() {
    if (!State.pos) return;
    const dest = State.activeDest();
    const myDistToDest = dest ? Utils.distKm(State.pos, dest) : null;

    // v22.18: identify the single focused (closest ahead) point. Only IT
    // gets to make noise this tick. Other points still update tracking
    // state (so passed-detection works) but don't fire any alerts.
    const aheadList = this.ahead();
    const focusedId = aheadList.length ? aheadList[0].id : null;

    State.activePoints().forEach(p => {
      if (p.status === 'no') return;
      if (State.passedPoints.has(p.id)) return;

      const distKm = Utils.distKm(State.pos, p);
      if (distKm > 5) {
        // Too far — clear stale state
        State.lastDistByPoint.delete(p.id);
        State.minDistByPoint.delete(p.id); // v22.15: also reset min tracker
        return;
      }
      const meters = distKm * 1000;

      // v22.76: "Name is here" voice announcement. Fires once per (point, trip)
      // when the user is within a speed-dependent distance ring:
      //   speed >= hereSpeedThreshold -> 100m
      //   speed <  hereSpeedThreshold -> 50m
      // Repeats N times by concatenating the phrase into a single utterance,
      // so the speech engine handles the pauses naturally without
      // cancel/re-speak races.
      const _speedKmh = State.speedMps * 3.6;
      const _hereSpeedT = +State.settings.hereSpeedThreshold || 100;
      const _hereRingM = _speedKmh >= _hereSpeedT ? 100 : 50;
      if (meters <= _hereRingM && !State.hereAnnouncedPoints.has(p.id)) {
        State.hereAnnouncedPoints.add(p.id);
        const reps = Math.max(1, Math.min(10, +State.settings.hereRepeatCount || 2));
        const name = p.name || Utils.typeLabel(p.type);
        const text = Array(reps).fill(`${name} is here`).join('. ');
        if (State.settings.sound !== 'off' && State.settings.voiceGender !== 'none') {
          Audio.say(text);
        }
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        State.alertsFiredThisTrip = (State.alertsFiredThisTrip || 0) + 1;
        State.lastAlertAt = Date.now();
        State.lastAlertText = name + ' is here';
      }

      const prevMeters = State.lastDistByPoint.get(p.id);

      // v22.15 FIX: track the minimum distance ever seen for this point this
      // trip. When we got close (< 200m) and start moving away (> 30m past min),
      // mark the point as passed — regardless of what the heading/destination
      // check says.
      const prevMin = State.minDistByPoint.get(p.id);
      if (prevMin == null || meters < prevMin) {
        State.minDistByPoint.set(p.id, meters);
      }
      const curMin = State.minDistByPoint.get(p.id);
      if (curMin != null && curMin < 200 && meters > curMin + 30) {
        // We got close, now we're moving away → must have passed it
        State.passedPoints.add(p.id);
        State.alertedMarkers.delete(p.id);
        State.lastDistByPoint.delete(p.id);
        State.minDistByPoint.delete(p.id);
        // v22.56: only ASK the user to confirm if we got DIRECTLY over the
        // point (≤30m). If we only got close (30–200m), still mark passed
        // for the visual greyout — but skip the popup, since we can't be
        // sure if we actually drove past it or just near it.
        if (curMin <= 30) Confirm.onPassed(p);
        return;
      }

      // v22.12 FIX: prefer the geometric route-based check.
      let ahead;
      if (dest && myDistToDest != null) {
        const pDistToDest = Utils.distKm(p, dest);
        ahead = pDistToDest < myDistToDest + 0.15;
      } else if (State.prevPos && State.speedMps > 1) {
        const heading = Utils.bearing(State.prevPos, State.pos);
        const toPt = Utils.bearing(State.pos, p);
        const diff = Math.abs(((toPt - heading + 540) % 360) - 180);
        ahead = diff <= 90;
      } else {
        ahead = true;
      }

      if (!ahead) {
        if (prevMeters != null && meters > prevMeters && meters > 80) {
          State.passedPoints.add(p.id);
          State.alertedMarkers.delete(p.id);
          State.lastDistByPoint.delete(p.id);
          State.minDistByPoint.delete(p.id);
          // v22.56: same 30m gate on the geometry-based pass path
          if (curMin != null && curMin <= 30) Confirm.onPassed(p);
        } else {
          State.lastDistByPoint.set(p.id, meters);
        }
        return;
      }

      // v22.18: ONLY the focused (closest ahead) point fires alerts.
      // Other points just track distance state for passed-detection.
      const isFocused = p.id === focusedId;
      const fired = State.alertedMarkers.get(p.id) || new Set();
      const markers = State.settings.alertMarkersM || [2000, 1000, 500];

      if (prevMeters == null) {
        // v22.18: First sight — silently mark every marker we're already past
        // as "fired" so they don't spuriously trigger later. We don't fire any
        // alert from here; the auto-announce gives the user a heads-up with
        // the actual current distance, so a duplicate here would just be noise.
        for (const m of markers) {
          if (meters <= m) fired.add(m);
        }
      } else if (isFocused) {
        // v22.18: Normal threshold-crossing detection — only for the focused point
        // v22.32: ±10m tolerance — GPS jitter near a threshold could otherwise
        // skip a marker. Crossing is "was clearly outside, now at-or-near inside".
        const tol = 10; // meters
        for (const m of markers) {
          if (fired.has(m)) continue;
          if (prevMeters > m + tol && meters <= m + tol) {
            Audio.alert(p, m);
            fired.add(m);
            if (navigator.vibrate) navigator.vibrate(60);
          }
        }
      }
      // For non-focused points: track state, don't fire. When this point
      // BECOMES focused (closest one is passed), its threshold logic resumes
      // and only the markers it hasn't fired yet will fire on future crossings.
      State.alertedMarkers.set(p.id, fired);
      State.lastDistByPoint.set(p.id, meters);
    });

    this.checkAutoAnnounce(); // v22.16

    // v22.32: continuous proximity ping for the focused (closest) point
    if (focusedId != null) {
      const focusedPoint = aheadList.find(p => p.id === focusedId);
      if (focusedPoint) {
        const focusedMeters = focusedPoint.dist * 1000;
        Audio.updateProximityPing(focusedId, focusedMeters);
      } else {
        Audio.updateProximityPing(null, null);
      }
    } else {
      Audio.updateProximityPing(null, null);
    }

    // v22.68: announce the speed limit out loud whenever the effective
    // zone changes. Triggers on every transition (entering a new zone
    // captured in either direction). Skips when sound is off or voice
    // is disabled; manualLimit changes also trigger it (user just set it).
    const curLimit = this.currentLimit();
    if (curLimit !== State.lastAnnouncedLimit) {
      State.lastAnnouncedLimit = curLimit;
      if (curLimit != null &&
          State.settings.sound !== 'off' &&
          State.settings.voiceGender !== 'none') {
        Audio.say(`Speed limit ${curLimit}`);
      }
    }

    this.checkSpeed();
  },

  /** v22.16: speak the "next ahead" the first time a new point reaches #1
   *  in the ahead list. Each point announces at most once per trip — so you
   *  hear about it when it becomes relevant, and aren't spammed afterwards.
   *  Threshold alerts (2000/1000/500m) still fire as you approach. */
  checkAutoAnnounce() {
    const ahead = this.ahead();
    if (!ahead.length) return;
    const top = ahead[0];
    if (State.autoAnnouncedAhead.has(top.id)) return;
    State.autoAnnouncedAhead.add(top.id);

    const s = State.settings.sound;
    if (s === 'off') return;

    // Build the announcement text
    const distText = top.dist >= 1
      ? top.dist.toFixed(1) + ' kilometers'
      : Math.round(top.dist * 1000) + ' meters';
    let text = (top.name || Utils.typeLabel(top.type)) + ' in ' + distText;
    if (State.settings.announceSide && top.side) {
      text += top.side === 'left' ? ', left' : ', right';
    }

    // Respect sound mode: voice mode → only voice; tone mode → only tone; both → both
    if (s === 'beep' || s === 'both') Audio.beep(top.type);
    if ((s === 'voice' || s === 'both') && State.settings.voiceGender !== 'none') {
      setTimeout(() => Audio.say(text), 200);
    }

    // Count it for the diag strip
    State.alertsFiredThisTrip = (State.alertsFiredThisTrip || 0) + 1;
    State.lastAlertAt = Date.now();
    State.lastAlertText = '(auto) ' + (top.name || Utils.typeLabel(top.type));
  },

  checkSpeed() {
    const limit = this.currentLimit();
    if (limit == null) { State.speedAlertWasOver = false; return; }
    const kmh = State.speedMps * 3.6;
    const isOver = kmh > limit + State.settings.overBy;
    if (!isOver) { State.speedAlertWasOver = false; return; }

    const mode = State.settings.speedAlertMode;
    if (mode === 'off') { State.speedAlertWasOver = true; return; }

    const newZone = State.lastSpeedAlertZone !== limit;
    const wasOver = State.speedAlertWasOver;
    if (newZone || !wasOver) {
      State.lastSpeedAlertZone = limit;
      State.speedAlertWasOver = true;
      const sign = document.getElementById('sign');
      sign.classList.remove('flash');
      void sign.offsetWidth;
      sign.classList.add('flash');
      if (mode === 'beep' || mode === 'both') Audio.beep('speed_change');
      if (mode === 'voice' || mode === 'both') Audio.say(`Speed limit ${limit}`);
      if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
    }
    State.speedAlertWasOver = true;
  },
};

/* ============================================================
   7c. CONFIRM — v22.38 post-pass survey ("is this point still there?")
   ============================================================ */
const Confirm = {
  // Point types that warrant a confirmation popup after passing.
  ASKABLE_TYPES: ['speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera', 'checkpoint'],
  // After this many consecutive "NO" answers, the point auto-retires (status='no').
  RETIRE_AFTER: 3,
  // Don't ask more than once per point per trip.
  _askedThisTrip: new Set(),
  // FIFO queue of point IDs waiting to be asked about.
  _queue: [],
  _activeId: null,
  _timer: null,
  _remainingMs: 0,

  /** Called by Alerts.tick when a point transitions to "passed". */
  onPassed(point) {
    if (!point || !point.id) return;
    if (!this.ASKABLE_TYPES.includes(point.type)) return;
    if (point.status === 'no') return; // already retired — don't pester
    if (this._askedThisTrip.has(point.id)) return;
    this._askedThisTrip.add(point.id);
    this._queue.push(point.id);
    if (!this._activeId) this._showNext();
  },

  /** Show the next queued point, if any. */
  _showNext() {
    this._cleanup();
    if (!this._queue.length) {
      this._activeId = null;
      return;
    }
    const id = this._queue.shift();
    const point = State.data.points.find(p => p.id === id);
    if (!point) { this._showNext(); return; }
    this._activeId = id;
    this._render(point);
    this._startCountdown(10);
  },

  _render(point) {
    let host = document.getElementById('confirm-popup');
    if (!host) {
      host = document.createElement('div');
      host.id = 'confirm-popup';
      host.className = 'confirm-popup';
      document.body.appendChild(host);
    }
    const typeLbl = Utils.typeLabel(point.type);
    const side = point.side ? (point.side === 'left' ? 'L' : 'R') : '';
    const sideText = side ? ` · ${side}` : '';
    const name = Utils.escapeHtml(point.name || typeLbl);
    host.innerHTML = `
      <div class="confirm-card">
        <div class="confirm-head">
          <div class="confirm-title">${Utils.emoji(point.type)} ${name}</div>
          <div class="confirm-meta">${Utils.escapeHtml(typeLbl)}${sideText} · Still there?</div>
        </div>
        <div class="confirm-progress"><div class="confirm-progress-bar" id="confirm-bar"></div></div>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-yes" id="confirm-yes">YES</button>
          <button class="confirm-btn confirm-no"  id="confirm-no">NO</button>
        </div>
      </div>`;
    host.classList.add('show');
    document.getElementById('confirm-yes').onclick = () => this._answer('yes');
    document.getElementById('confirm-no').onclick  = () => this._answer('no');
  },

  _startCountdown(secs) {
    this._remainingMs = secs * 1000;
    const startedAt = Date.now();
    const totalMs = this._remainingMs;
    const bar = document.getElementById('confirm-bar');
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const left = Math.max(0, totalMs - elapsed);
      this._remainingMs = left;
      if (bar) bar.style.width = (left / totalMs * 100) + '%';
      if (left <= 0) {
        // No answer — timeout. Don't log anything, just move on.
        this._showNext();
      }
    }, 100);
  },

  _answer(value) {
    const id = this._activeId;
    if (!id) return;
    const point = State.data.points.find(p => p.id === id);
    if (!point) { this._showNext(); return; }
    // Initialize log array + counter if missing
    if (!Array.isArray(point.confirmations)) point.confirmations = [];
    if (typeof point.missingCount !== 'number') point.missingCount = 0;
    point.confirmations.push({ ts: Date.now(), value });
    if (value === 'yes') {
      point.missingCount = 0;
      // If it was retired and now confirmed back, re-enable
      if (point.status === 'no') point.status = 'yes';
    } else {
      point.missingCount += 1;
      if (point.missingCount >= Confirm.RETIRE_AFTER) {
        point.status = 'no';
      }
    }
    State.saveData();
    Utils.toast(
      value === 'yes'
        ? `✓ ${point.name || Utils.typeLabel(point.type)} confirmed`
        : (point.status === 'no'
            ? `${point.name || Utils.typeLabel(point.type)} retired (3 missed)`
            : `${point.name || Utils.typeLabel(point.type)} marked missing (${point.missingCount}/${Confirm.RETIRE_AFTER})`),
      value === 'yes' ? 'good' : 'bad'
    );
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
    this._showNext();
  },

  _cleanup() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const host = document.getElementById('confirm-popup');
    if (host) host.classList.remove('show');
  },

  /** Reset trip state when GPS starts a fresh session. */
  resetTrip() {
    this._askedThisTrip.clear();
    this._queue = [];
    this._activeId = null;
    this._cleanup();
  },
};

/* ============================================================
   8. BACKUP
   ============================================================ */
const Backup = {
  hash() {
    const s = JSON.stringify({ d: State.data, t: State.trips, st: State.settings });
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  },
  async push(opts = {}) {
    if (!State.gh.token || !State.gh.repo || !State.gh.path) {
      if (!opts.silent) Utils.toast('Set token/repo/path first', 'bad');
      return false;
    }
    try {
      const apiBase = `https://api.github.com/repos/${State.gh.repo}/contents/${State.gh.path}`;
      const headers = {
        'Authorization': 'token ' + State.gh.token,
        'Accept': 'application/vnd.github+json',
      };
      let sha = null;
      try {
        const r = await fetch(apiBase, { headers });
        if (r.ok) sha = (await r.json()).sha;
      } catch (e) {}
      const payload = JSON.stringify({
        version: 22,
        exportedAt: new Date().toISOString(),
        data: State.data,
        settings: State.settings,
        trips: State.trips,
      }, null, 2);
      const b64 = btoa(unescape(encodeURIComponent(payload)));
      const body = {
        message: (opts.silent ? 'Auto-backup ' : 'Backup ') + new Date().toISOString(),
        content: b64,
      };
      if (sha) body.sha = sha;
      const resp = await fetch(apiBase, {
        method: 'PUT', headers, body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (!opts.silent) Utils.toast('Backup failed: ' + (err.message || resp.status), 'bad');
        return false;
      }
      State.lastBackup = Date.now();
      State.lastBackupHash = this.hash();
      UI.updateBackupStatus();
      if (!opts.silent) Utils.toast('Backed up ✓', 'good');
      return true;
    } catch (e) {
      if (!opts.silent) Utils.toast('Backup error', 'bad');
      return false;
    }
  },
  async tryAuto() {
    if (!State.settings.autoBackup) return;
    if (!State.gh.token || !State.gh.repo) return;
    const h = this.hash();
    if (h === State.lastBackupHash) return;
    await this.push({ silent: true });
  },

  /** v22.30: pull backup from GitHub. Replaces local data with remote.
   *  Destructive — must be confirmed by user. */
  async pull() {
    if (!State.gh.token || !State.gh.repo || !State.gh.path) {
      Utils.toast('Set token/repo/path first', 'bad');
      return false;
    }
    try {
      const apiBase = `https://api.github.com/repos/${State.gh.repo}/contents/${State.gh.path}`;
      const headers = {
        'Authorization': 'token ' + State.gh.token,
        'Accept': 'application/vnd.github+json',
      };
      const r = await fetch(apiBase, { headers });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        Utils.toast('Restore failed: ' + (err.message || r.status), 'bad');
        return false;
      }
      const json = await r.json();
      // GitHub returns file content as base64; decode + parse
      const raw = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ''))));
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        Utils.toast('Restore: invalid payload', 'bad');
        return false;
      }
      // Validate shape — data must exist; settings/trips are optional
      if (!parsed.data || !parsed.data.points || !parsed.data.destinations) {
        Utils.toast('Restore: missing data shape', 'bad');
        return false;
      }
      // Apply
      State.data = parsed.data;
      if (parsed.settings) State.settings = Object.assign({}, State.settings, parsed.settings);
      if (parsed.trips) State.trips = parsed.trips;
      State.saveData();
      State.saveSettings();
      State.saveTrips();
      State.lastBackupHash = this.hash();
      // Re-render everything that depends on data
      UI.renderRouteBar();
      UI.renderMarkerChips();
      if (MapView.m) MapView.updatePoints();
      UI.updateBackupStatus();
      Utils.toast(`Restored: ${State.data.points.length} points, ${State.data.destinations.length} dests`, 'good');
      return true;
    } catch (e) {
      Utils.toast('Restore error: ' + (e.message || e), 'bad');
      return false;
    }
  },
  start() { this.stop(); State.backupTimer = setInterval(() => this.tryAuto(), 5 * 60 * 1000); },
  stop()  { if (State.backupTimer) { clearInterval(State.backupTimer); State.backupTimer = null; } },
};

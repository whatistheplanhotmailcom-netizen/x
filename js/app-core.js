'use strict';

// Single source of truth for the running app version. Every visible
// surface (document.title, the top-bar badge, the debug log header,
// the [APP] boot line) is populated from this constant at boot. Bump
// this on every release; the boot wiring synchronizes the DOM and the
// asset cache-bust query string must be advanced in lockstep.
// Semantic versioning: MAJOR.MINOR.PATCH.
//   MAJOR — architecture or major system milestone
//   MINOR — new features or meaningful capability additions
//   PATCH — bug fixes, tuning, logging, UI adjustments
const APP_VERSION = 'v23.18.24';

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
  MAX: 500,
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
   0b2. AUDIO AUDIT — lightweight audio/speech/vibration log collector
   SEPARATE from Logger / the alert-audit. Newest entries at index 0.
   Bounded ring buffer (MAX 400). The SAME decision object that gates an
   emission is what gets logged here — no gating logic is duplicated.
   The collector answers ONLY audio-layer questions: did the audio policy
   allow this tone/speech, which audio policy blocked it, did preview
   bypass mute, did the audio API throw, did haptics fire.
   Exposed as window.AudioAudit for console troubleshooting.
   ============================================================ */
const AudioAudit = {
  MAX: 400,
  logs: [],

  /** Normalize + push one audit entry. `decision` is the SAME object the
   *  emitter used to gate the tone/speech (or null for haptics/preview). */
  log(o) {
    o = o || {};
    const s = (typeof State !== 'undefined' && State.settings) ? State.settings : {};
    const decision = o.decision;
    const entry = {
      ts: Date.now(),
      source: o.source,
      action: o.action,
      pointId: o.pointId || null,
      pointType: o.pointType || null,
      distanceM: o.distanceM != null ? o.distanceM : null,
      markerM: o.markerM != null ? o.markerM : null,
      sound: o.sound != null ? o.sound : s.sound,
      voiceGender: o.voiceGender != null ? o.voiceGender : s.voiceGender,
      speedAlertMode: o.speedAlertMode != null ? o.speedAlertMode : (s.speedAlertMode || null),
      allowed: (decision && decision.allowed != null) ? decision.allowed : null,
      reason: (decision && decision.reason) || o.reason || null,
      previewBypass: !!o.previewBypass,
      vibrationFired: !!o.vibrationFired,
      error: o.error || null,
      extra: o.extra || null,
    };
    this.logs.unshift(entry);
    if (this.logs.length > this.MAX) this.logs.length = this.MAX;
    // If a diagnostics view is open, refresh it (looked up lazily).
    try {
      const modal = document.getElementById('m-debug');
      if (modal && modal.classList.contains('open') &&
          typeof UI !== 'undefined' && UI.renderAudioAudit) {
        UI.renderAudioAudit();
      }
    } catch (e) {}
    return entry;
  },

  /** Per-point throttle bookkeeping for proximity_ping. Logs when: first
   *  ping for a point, distance-band change, suppression-state change,
   *  error, OR at most once per 5000ms per point. */
  _proxState: {},
  PROX_THROTTLE_MS: 5000,
  logProximity(o) {
    o = o || {};
    const pid = o.pointId || '_';
    const decision = o.decision || {};
    const allowed = decision.allowed;
    const band = o.band != null ? o.band : null;
    const isErr = !!o.error;
    const now = Date.now();
    const prev = this._proxState[pid];
    let should = false;
    if (!prev) should = true;                              // first ping
    else if (prev.band !== band) should = true;            // band change
    else if (prev.allowed !== allowed) should = true;      // suppression-state change
    else if (isErr) should = true;                         // error
    else if (now - prev.ts >= this.PROX_THROTTLE_MS) should = true; // time cap
    this._proxState[pid] = { band, allowed, ts: now };
    if (!should) return null;
    return this.log(o);
  },

  /** Return a shallow copy of the buffer (newest first) and console.table it. */
  dump() {
    const copy = this.logs.slice();
    try { console.table(copy); } catch (e) { try { console.log(copy); } catch (e2) {} }
    return copy;
  },

  asText() {
    return this.logs.map(L => {
      const d = new Date(L.ts).toLocaleTimeString();
      const bits = [
        d,
        L.source + '/' + L.action,
        'allowed=' + L.allowed,
        L.reason ? ('reason=' + L.reason) : null,
        L.pointType ? ('type=' + L.pointType) : null,
        L.distanceM != null ? ('dist=' + L.distanceM) : null,
        'sound=' + L.sound,
        'voice=' + L.voiceGender,
        L.speedAlertMode ? ('speedMode=' + L.speedAlertMode) : null,
        L.previewBypass ? 'preview' : null,
        L.vibrationFired ? 'vibrated' : null,
        L.error ? ('error=' + L.error) : null,
        L.extra ? ('extra=' + (function(){ try { return JSON.stringify(L.extra); } catch (e) { return String(L.extra); } })()) : null,
      ].filter(Boolean);
      return bits.join(' | ');
    }).join('\n');
  },

  clear() {
    this.logs = [];
    this._proxState = {};
    try {
      if (typeof UI !== 'undefined' && UI.renderAudioAudit) UI.renderAudioAudit();
    } catch (e) {}
  },
};
try { window.AudioAudit = AudioAudit; } catch (e) {}

/* ============================================================
   0c. SPEED — v22.91
   Pure-math helpers + scoring engine for road-aware speed-limit alerts.
   Storage.migrate calls Speed.migrateSpeedPoints to extend the schema
   of existing saved points; Alerts.currentLimit + Alerts.tick use
   Speed.scoreSpeedPoint + Speed.shouldAlert for road-aware filtering.
   Pure functions are easy to test in isolation; the only stateful bits
   are the in-memory _lastAlerted map (cleared on page reload) and the
   rolling speed/heading histories on State.
   ============================================================ */
const Speed = {
  /** Shortest-arc angular difference between two compass bearings,
   *  return in degrees [0, 180]. angleDiff(350, 10) === 20. */
  angleDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  },

  /** Initial-bearing FROM (lat1,lng1) TO (lat2,lng2), degrees [0, 360). */
  bearingBetween(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    let b = Math.atan2(y, x) * 180 / Math.PI;
    if (b < 0) b += 360;
    return b;
  },

  /** GPS heading is noisy below ~10 km/h (stationary jitter, slow walks). */
  isHeadingReliable(speedKmh) {
    return typeof speedKmh === 'number' && speedKmh >= 10;
  },

  /** True if userHeading is within `tolerance` (default 45°) of pointBearing. */
  headingMatches(userHeading, pointBearing, tolerance) {
    if (userHeading == null || pointBearing == null) return false;
    return Speed.angleDiff(userHeading, pointBearing) <= (tolerance == null ? 45 : tolerance);
  },

  /** v23.10 — direction-aware camera filter helper. True when two compass
   *  bearings point the SAME way within `toleranceDeg` (default 45°). Both
   *  bearings are normalized to [0,360) and compared on the shortest arc,
   *  so isSameDirection(355, 5) is true (20° apart) and (90, 270) is false
   *  (180° apart). Null / NaN inputs return false (caller treats as
   *  "direction unknown" and falls back to existing behavior). */
  isSameDirection(userBearingDeg, cameraBearingDeg, toleranceDeg) {
    if (userBearingDeg == null || cameraBearingDeg == null) return false;
    if (isNaN(userBearingDeg) || isNaN(cameraBearingDeg)) return false;
    const tol = (typeof toleranceDeg === 'number') ? toleranceDeg : 45;
    const u = ((userBearingDeg % 360) + 360) % 360;
    const c = ((cameraBearingDeg % 360) + 360) % 360;
    return Speed.angleDiff(u, c) <= tol;
  },

  /** Returns true if the point is roughly in front of the user (≤90° off
   *  the user's heading vector). Returns null if heading is unavailable. */
  isPointAhead(userLat, userLng, userHeading, pointLat, pointLng) {
    if (userHeading == null) return null;
    const b = Speed.bearingBetween(userLat, userLng, pointLat, pointLng);
    return Speed.angleDiff(userHeading, b) <= 90;
  },

  /** Rolling-speed-based road type guess.
   *  highway ≥ 80 km/h, city ≥ 30, otherwise unknown.
   *  Returns 'unknown' for null/insufficient data (caller treats neutral). */
  inferRoadTypeFromRollingSpeed(avgSpeedKmh) {
    if (avgSpeedKmh == null || isNaN(avgSpeedKmh)) return 'unknown';
    if (avgSpeedKmh >= 80) return 'highway';
    if (avgSpeedKmh >= 30) return 'city';
    return 'unknown';
  },

  /** Configurable alert radius based on the point's stored roadType.
   *  Highway points need more lead time; city points are tighter. */
  getAlertRadius(point) {
    const t = point && point.roadType;
    if (t === 'highway') return 400;
    if (t === 'city')    return 200;
    return 300; // unknown / missing
  },

  /** Confidence score for whether a point should alert NOW, given the
   *  user's current state. Returns { score, distance, reasons } —
   *  score >= 60 means the alert SHOULD fire (subject to hysteresis).
   *  reasons[] is a human-readable trace for the debug panel.
   *
   *  Components (per spec):
   *    +35  inside the road-type-specific alert radius
   *    +25  point is ahead of user (or low-speed/no-heading neutral grant)
   *    +25  heading matches captureBearing (or non-directional / neutral)
   *    +10  road-type match (or unknown-on-either-side neutral)
   *
   *  Hard fails: outside radius (return 0) OR point clearly behind user
   *  when speed >= 10 and heading is known (return 0). */
  scoreSpeedPoint(u, p) {
    const reasons = [];
    let score = 0;
    const distKm = Utils.distKm({ lat: u.lat, lng: u.lng }, p);
    const distM = distKm * 1000;
    const radius = Speed.getAlertRadius(p);

    if (distM > radius) {
      return { score: 0, distance: distM, reasons: ['outside radius (' + Math.round(distM) + 'm > ' + radius + 'm)'] };
    }
    score += 35;
    reasons.push('in radius +35');

    // AHEAD CHECK
    if (u.speedKmh != null && u.speedKmh < 10) {
      // Low speed → bearing is unreliable, auto-grant
      score += 25;
      reasons.push('low speed → ahead +25 (neutral)');
    } else if (u.heading == null) {
      // No heading data → auto-grant, don't penalize
      score += 25;
      reasons.push('no heading → ahead +25 (neutral)');
    } else {
      const bTo = Speed.bearingBetween(u.lat, u.lng, p.lat, p.lng);
      const dAhead = Speed.angleDiff(u.heading, bTo);
      if (dAhead > 90) {
        return { score: 0, distance: distM, reasons: ['behind user (' + dAhead.toFixed(0) + '° off)'] };
      }
      score += 25;
      reasons.push('ahead +25');
    }

    // HEADING MATCH (only meaningful for directional points)
    if (!p.directional) {
      score += 25;
      reasons.push('non-directional → heading +25');
    } else if (u.speedKmh != null && u.speedKmh < 10) {
      score += 25;
      reasons.push('low speed → heading +25 (neutral)');
    } else if (u.heading == null) {
      score += 25;
      reasons.push('no heading → heading +25 (neutral)');
    } else if (p.captureBearing == null) {
      score += 25;
      reasons.push('no captureBearing → heading +25 (neutral)');
    } else {
      const dH = Speed.angleDiff(u.heading, p.captureBearing);
      if (dH <= 45) {
        score += 25;
        reasons.push('heading match (' + dH.toFixed(0) + '°) +25');
      } else {
        reasons.push('heading mismatch (' + dH.toFixed(0) + '°)');
      }
    }

    // ROAD TYPE (neutral when either side is unknown)
    const userRT = Speed.inferRoadTypeFromRollingSpeed(u.avgSpeedKmh);
    if (!p.roadType || p.roadType === 'unknown' || userRT === 'unknown' || userRT === p.roadType) {
      score += 10;
      reasons.push('roadType ok (+10)');
    } else {
      reasons.push('roadType mismatch (user=' + userRT + ', point=' + p.roadType + ')');
    }

    return { score, distance: distM, reasons };
  },

  /** Search all candidate points and return the best-scoring match
   *  (score >= 60), or null. Caller is responsible for hysteresis. */
  findBestSpeedPoint(userState, points) {
    let best = null;
    for (const p of points) {
      if (!p || p.status === 'no') continue;
      if (p.type !== 'speed_change') continue;
      const limit = (typeof p.speedLimit === 'number') ? p.speedLimit
                  : (typeof p.limit === 'number') ? p.limit : null;
      if (limit == null) continue;
      const r = Speed.scoreSpeedPoint(userState, p);
      if (r.score >= 60 && (!best || r.score > best.score)) {
        best = { point: p, limit, score: r.score, distance: r.distance, reasons: r.reasons };
      }
    }
    return best;
  },

  /** In-memory per-point hysteresis. Map<pointId, { t, lat, lng }>.
   *  NOT persisted — fresh page reload starts clean (per user spec). */
  _lastAlerted: new Map(),

  /** True if the point is allowed to alert right now:
   *    - never alerted → yes
   *    - last alert > 30 seconds ago → yes
   *    - user has moved > 500 m from last-alert position → yes
   *    - otherwise → no (suppressed) */
  shouldAlert(point, userLat, userLng) {
    const rec = this._lastAlerted.get(point.id);
    if (!rec) return true;
    if ((Date.now() - rec.t) / 1000 > 30) return true;
    const movedKm = Utils.distKm({ lat: userLat, lng: userLng }, { lat: rec.lat, lng: rec.lng });
    if (movedKm > 0.5) return true;
    return false;
  },

  /** Record that we just fired an alert for this point at the given
   *  user position. Pairs with shouldAlert. */
  recordAlert(point, userLat, userLng) {
    this._lastAlerted.set(point.id, { t: Date.now(), lat: userLat, lng: userLng });
  },

  /** Extend old saved points with the v22.91 schema fields in place.
   *  Cameras default directional=true; speed_change defaults false.
   *  Returns how many records were touched (for logging). */
  migrateSpeedPoints(points) {
    if (!Array.isArray(points)) return 0;
    let touched = 0;
    const camTypes = new Set(['speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera']);
    for (const p of points) {
      if (p.type !== 'speed_change' && !camTypes.has(p.type)) continue;
      let changed = false;
      if (p.directional === undefined) {
        p.directional = camTypes.has(p.type); // cameras directional by default
        changed = true;
      }
      if (p.roadType === undefined) {
        p.roadType = 'unknown';
        changed = true;
      }
      if (p.captureBearing === undefined) {
        p.captureBearing = null;
        changed = true;
      }
      if (p.updatedAt === undefined) {
        p.updatedAt = p.createdAt || new Date().toISOString();
        changed = true;
      }
      // speedLimit alias for speed_change (kept alongside legacy `limit`).
      if (p.type === 'speed_change' && typeof p.limit === 'number' && p.speedLimit === undefined) {
        p.speedLimit = p.limit;
        changed = true;
      }
      // v23.7.2: lazy migration of observation/confidence fields for
      // legacy speed_change points. Additive only — never overwrites
      // existing values, never deletes anything.
      if (p.type === 'speed_change') {
        if (p.observationCount === undefined) {
          p.observationCount = Math.max(1, p.confidence || 1);
          changed = true;
        }
        if (p.confirmationCount === undefined) {
          // Derive from legacy confidence: each merge bumped confidence
          // by 1, so confidence-1 == prior re-confirmations.
          p.confirmationCount = Math.max(0, (p.confidence || 1) - 1);
          changed = true;
        }
        if (p.rejectionCount === undefined) { p.rejectionCount = 0; changed = true; }
        if (p.lastObservedAt === undefined) {
          p.lastObservedAt = p.updatedAt || p.createdAt || null;
          changed = true;
        }
        if (p.confidenceStatus === undefined) {
          p.confidenceStatus = Speed.deriveConfidenceStatus(p);
          changed = true;
        }
      }
      if (changed) touched++;
    }
    return touched;
  },

  /** v23.7.2: derive confidenceStatus from observation counts + age.
   *  Returns one of: possible | probable | trusted | disputed | stale.
   *  Always safe to call; returns 'possible' for empty inputs.
   *  v23.17.0: prefer p.validConfirmationCount (gate-passed confirmations)
   *  when present so opposite-direction / far / poor-GPS samples don't
   *  inflate trust. Falls back to the raw historical confirmationCount for
   *  un-audited points; raw count is preserved as audit history. */
  deriveConfidenceStatus(p) {
    if (!p) return 'possible';
    const obs  = p.observationCount   || p.confidence || 1;
    const conf = (typeof p.validConfirmationCount === 'number')
               ? p.validConfirmationCount
               : (p.confirmationCount || 0);
    const rej  = p.rejectionCount     || 0;
    const lastSeen = p.lastObservedAt || p.updatedAt || p.createdAt;
    if (lastSeen) {
      const ageMs = Date.now() - new Date(lastSeen).getTime();
      // Stale = no observation in >180 days
      if (ageMs > 180 * 24 * 3600 * 1000) return 'stale';
    }
    if (p.pendingSpeedLimitChange) return 'disputed';
    if (rej >= 2 && rej >= conf)   return 'disputed';
    if (conf >= 3 || obs >= 4)     return 'trusted';
    if (conf >= 1 || obs >= 2)     return 'probable';
    return 'possible';
  },
};

/* ============================================================
   0d. MIGRATION — v22.96
   Global speed-point store + destination-as-metadata refactor.
   Decouples points from destinations: points live in a single global
   array; destinations carry .routePointRefs (array of point ids).
   Migration is dry-run-first, user-confirmed, with a localStorage
   backup so a failed migration can be rolled back. Deterministic
   single-pass first-match-wins deduplication per spec.

   DEFERRED to a follow-up commit (intentionally):
     - Full corridor filtering integrated into the alert path
       (helpers are here, hookup in Alerts.tick is not).
     - Destination list UI (search / favorite / archive).
     - Map display modes (active route / nearby / all).
     - Auto-delete backup after MIGRATION_BACKUP_TTL_DAYS.
   ============================================================ */
const MigrationConfig = {
  DEDUPE_DISTANCE_METERS: 25,
  DEDUPE_BEARING_DIFF_DEGREES: 25,
  CORRIDOR_HIGHWAY_METERS: 300,
  CORRIDOR_CITY_METERS: 150,
  CORRIDOR_UNKNOWN_METERS: 250,
  MAP_MAX_VISIBLE_POINTS: 200,
  MIGRATION_BACKUP_TTL_DAYS: 7,
};

/** Deterministic JSON stringification — recursively sorts object keys
 *  alphabetically so the output is invariant to insertion order. Used
 *  by the determinism test in the dry-run UI and by integrity checks. */
function sortedKeyStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(sortedKeyStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedKeyStringify(obj[k])).join(',') + '}';
}

const Migration = {
  /** Build a structurally-complete dry-run output IN MEMORY without
   *  touching localStorage. Returns the full would-be new data shape
   *  plus a report object the UI displays for confirmation. Calling
   *  this twice on the same input must produce byte-identical output
   *  (sortedKeyStringify equality) — the single test asserts this. */
  runMigrationDryRun(oldData) {
    const points = (oldData && Array.isArray(oldData.points)) ? oldData.points : [];
    const dests  = (oldData && Array.isArray(oldData.destinations)) ? oldData.destinations : [];

    const dedup = Migration.dedupeSpeedPoints(points);

    // Build new destinations with routePointRefs derived from sourceDestinationIds
    const newDests = [];
    const pointsByDestSrc = new Map(); // destId -> [pointId]
    for (const np of dedup.globalPoints) {
      for (const src of (np.sourceDestinationIds || [])) {
        if (!pointsByDestSrc.has(src)) pointsByDestSrc.set(src, []);
        pointsByDestSrc.get(src).push(np.id);
      }
    }
    let zeroPointDests = 0;
    for (const oldD of [...dests].sort((a, b) => (a.id || '').localeCompare(b.id || ''))) {
      const refs = pointsByDestSrc.get(oldD.id) || [];
      const newD = {
        id: oldD.id,
        name: oldD.name,
        lat: oldD.lat,
        lng: oldD.lng,
        createdAt: oldD.createdAt || new Date(0).toISOString(),
        updatedAt: oldD.updatedAt || oldD.createdAt || new Date(0).toISOString(),
        favorite: !!oldD.favorite,
        archived: !!oldD.archived,
        routePointRefs: refs.slice().sort(),
      };
      if (refs.length === 0) zeroPointDests++;
      newDests.push(newD);
    }

    const newData = {
      version: 23,
      activeDestId: (oldData && oldData.activeDestId) || null,
      destinations: newDests,
      points: dedup.globalPoints,
    };

    const report = {
      oldDestCount: dests.length,
      oldPointCount: points.length,
      duplicateGroups: dedup.duplicateGroups,
      pointsToMerge: dedup.mergedCount,
      newGlobalPoints: dedup.globalPoints.length,
      destsToMigrate: dests.length,
      zeroPointDests: zeroPointDests,
    };

    return { newData, mergeMap: dedup.mergeMap, report };
  },

  /** Execute the actual migration: backup → swap data → save. Returns
   *  { ok, errors } from validateMigrationResult. Caller is responsible
   *  for having run dry-run + gotten user confirmation. */
  migrateToGlobalSpeedPoints(oldData) {
    const backupOk = Migration.backupOldRouteData(oldData);
    if (!backupOk) {
      return { ok: false, errors: ['Backup failed — migration aborted'] };
    }
    const dry = Migration.runMigrationDryRun(oldData);
    const val = Migration.validateMigrationResult(oldData, dry.newData, dry.mergeMap);
    if (!val.ok) {
      logEvent('MIGRATE', 'validation failed before commit: ' + val.errors.join('; '), 'err');
      return { ok: false, errors: val.errors };
    }
    // Commit
    try {
      State.data = dry.newData;
      Storage.save(Storage.KEYS.data, State.data);
      localStorage.setItem(Storage.KEYS.migrationCompletedAt, new Date().toISOString());
      logEvent('MIGRATE', 'migration applied — ' +
        `${dry.report.oldPointCount} old points → ${dry.report.newGlobalPoints} global ` +
        `(merged ${dry.report.pointsToMerge}); ${dry.report.destsToMigrate} destinations migrated`,
        'ok');
      return { ok: true, errors: [], report: dry.report };
    } catch (e) {
      logEvent('MIGRATE', 'commit exception: ' + (e && e.message || e), 'err');
      return { ok: false, errors: [String(e && e.message || e)] };
    }
  },

  /** Persist the old data structure to localStorage under a versioned key
   *  before destructive changes. Survives until restoreFromMigrationBackup
   *  is called OR the user explicitly clears it via Settings. */
  backupOldRouteData(oldData) {
    try {
      const wrapper = {
        version: 22,
        backedUpAt: new Date().toISOString(),
        data: oldData,
      };
      localStorage.setItem(Storage.KEYS.migrationBackup, JSON.stringify(wrapper));
      logEvent('MIGRATE', `backup saved (${JSON.stringify(oldData).length} bytes)`, 'ok');
      return true;
    } catch (e) {
      logEvent('MIGRATE', 'backup write failed: ' + (e && e.message || e), 'err');
      return false;
    }
  },

  /** Return parsed backup wrapper { version, backedUpAt, data } or null. */
  readMigrationBackup() {
    try {
      const raw = localStorage.getItem(Storage.KEYS.migrationBackup);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  },

  /** Replace State.data with the old structure from the backup. */
  restoreFromMigrationBackup() {
    const backup = Migration.readMigrationBackup();
    if (!backup || !backup.data) {
      logEvent('MIGRATE', 'restore aborted — no backup found', 'err');
      return false;
    }
    try {
      State.data = backup.data;
      Storage.save(Storage.KEYS.data, State.data);
      localStorage.removeItem(Storage.KEYS.migrationCompletedAt);
      logEvent('MIGRATE', `restored backup from ${backup.backedUpAt}`, 'ok');
      return true;
    } catch (e) {
      logEvent('MIGRATE', 'restore exception: ' + (e && e.message || e), 'err');
      return false;
    }
  },

  /** Single-pass first-match-wins deduplication. Sort first for
   *  determinism (createdAt, then id). Returns:
   *   - globalPoints[]: deduplicated array (new IDs preserved from
   *     the original first-seen point)
   *   - mergeMap: { oldId → globalId }
   *   - mergedCount: how many points got merged into others
   *   - duplicateGroups: how many merge targets received >1 source */
  dedupeSpeedPoints(points) {
    const sorted = [...points].sort((a, b) => {
      const ca = a.createdAt || '';
      const cb = b.createdAt || '';
      if (ca !== cb) return ca.localeCompare(cb);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    const globalPoints = [];
    const mergeMap = {};
    let mergedCount = 0;
    for (const p of sorted) {
      const target = Migration.findDuplicatePoint(p, globalPoints);
      if (target) {
        Migration._mergeInto(target, p);
        mergeMap[p.id] = target.id;
        mergedCount++;
      } else {
        const np = Migration._toGlobalPoint(p);
        globalPoints.push(np);
        mergeMap[p.id] = np.id;
      }
    }
    // Count duplicate groups (targets that received more than one source)
    const incoming = {};
    for (const oldId in mergeMap) {
      incoming[mergeMap[oldId]] = (incoming[mergeMap[oldId]] || 0) + 1;
    }
    let duplicateGroups = 0;
    for (const k in incoming) if (incoming[k] > 1) duplicateGroups++;
    return { globalPoints, mergeMap, mergedCount, duplicateGroups };
  },

  /** First-match-wins lookup in `existingPoints`. Returns the matching
   *  point or null. Implements the per-spec duplicate rule with the
   *  known-different-roadType non-merge edge case. */
  findDuplicatePoint(point, existingPoints) {
    const limit = (typeof point.speedLimit === 'number') ? point.speedLimit
                : (typeof point.limit === 'number') ? point.limit : null;
    for (const ex of existingPoints) {
      const distM = Utils.distKm(ex, point) * 1000;
      if (distM > MigrationConfig.DEDUPE_DISTANCE_METERS) continue;
      const exLimit = (typeof ex.speedLimit === 'number') ? ex.speedLimit
                    : (typeof ex.limit === 'number') ? ex.limit : null;
      if (exLimit !== limit) continue;
      // Road type: same OR at least one unknown. Two known but different → no merge.
      const rtA = ex.roadType || 'unknown';
      const rtB = point.roadType || 'unknown';
      if (rtA !== rtB && rtA !== 'unknown' && rtB !== 'unknown') continue;
      // Directional: bearings must be close. Non-directional → bearing doesn't block.
      if (ex.directional && point.directional) {
        const bA = ex.captureBearing;
        const bB = point.captureBearing;
        if (bA != null && bB != null) {
          const diff = Speed.angleDiff(bA, bB);
          if (diff > MigrationConfig.DEDUPE_BEARING_DIFF_DEGREES) continue;
        }
      }
      return ex; // first match wins
    }
    return null;
  },

  /** Build a clean new global-point record from an old point. Preserves
   *  the id and all existing fields; adds sourceDestinationIds and the
   *  speedLimit alias. */
  _toGlobalPoint(p) {
    const np = { ...p };
    if (!Array.isArray(np.sourceDestinationIds)) {
      np.sourceDestinationIds = p.destId ? [p.destId] : [];
    }
    if (np.speedLimit == null && typeof p.limit === 'number') np.speedLimit = p.limit;
    if (!np.updatedAt) np.updatedAt = p.updatedAt || p.createdAt || new Date(0).toISOString();
    if (!Array.isArray(np.mergedFromIds)) np.mergedFromIds = [];
    return np;
  },

  /** Merge `src` into `target` IN PLACE per spec rules. */
  _mergeInto(target, src) {
    // oldest createdAt
    if (src.createdAt && (!target.createdAt || src.createdAt < target.createdAt)) {
      target.createdAt = src.createdAt;
    }
    // newest updatedAt
    const su = src.updatedAt || src.createdAt;
    if (su && (!target.updatedAt || su > target.updatedAt)) target.updatedAt = su;
    // union sourceDestinationIds
    const a = target.sourceDestinationIds || (target.destId ? [target.destId] : []);
    const b = src.sourceDestinationIds || (src.destId ? [src.destId] : []);
    target.sourceDestinationIds = Array.from(new Set([...a, ...b])).sort();
    // track merged-from
    if (!Array.isArray(target.mergedFromIds)) target.mergedFromIds = [];
    target.mergedFromIds.push(src.id);
    if (Array.isArray(src.mergedFromIds)) target.mergedFromIds.push(...src.mergedFromIds);
    target.mergedFromIds = Array.from(new Set(target.mergedFromIds)).sort();
    // prefer known roadType
    if ((!target.roadType || target.roadType === 'unknown') && src.roadType && src.roadType !== 'unknown') {
      target.roadType = src.roadType;
    }
    // directional sticky-true
    if (src.directional) {
      target.directional = true;
      if (target.captureBearing == null && src.captureBearing != null) {
        target.captureBearing = src.captureBearing;
      }
    }
    // confidence aggregate
    target.confidence = (target.confidence || 1) + (src.confidence || 1);
  },

  /** Verify the migrated structure matches the old data per the spec's
   *  9-point success criteria (subset that's checkable without runtime
   *  state). Returns { ok, errors[] }. */
  validateMigrationResult(oldData, newData, mergeMap) {
    const errors = [];
    const oldDests = (oldData.destinations || []);
    const oldPoints = (oldData.points || []);

    // 1. Every old destination has a corresponding new destination record.
    const newDestIds = new Set(newData.destinations.map(d => d.id));
    for (const od of oldDests) {
      if (!newDestIds.has(od.id)) errors.push(`Destination ${od.id} ("${od.name}") missing in new data`);
    }
    // 2. Every old point has either a new global point or a documented merge target.
    const newPointIds = new Set(newData.points.map(p => p.id));
    for (const op of oldPoints) {
      const target = mergeMap[op.id];
      if (!target) { errors.push(`Point ${op.id} has no merge target`); continue; }
      if (!newPointIds.has(target)) errors.push(`Merge target ${target} for old point ${op.id} not in global points`);
    }
    // 4. Total alert-eligible point count equals old point count minus deduplicated.
    const expectedNewCount = oldPoints.length - oldPoints.filter(op => {
      const t = mergeMap[op.id];
      return t && t !== op.id;
    }).length;
    if (newData.points.length !== expectedNewCount) {
      errors.push(`Global point count mismatch: expected ${expectedNewCount}, got ${newData.points.length}`);
    }
    // 5. Zero-point destinations preserved (they still appear in newData.destinations).
    for (const od of oldDests) {
      const owned = oldPoints.filter(p => p.destId === od.id).length;
      if (owned === 0 && !newDestIds.has(od.id)) {
        errors.push(`Zero-point destination ${od.id} was dropped`);
      }
    }
    return { ok: errors.length === 0, errors };
  },

  /** Whether a migration has been committed on this device. */
  isMigrated() {
    return !!localStorage.getItem(Storage.KEYS.migrationCompletedAt);
  },
};

/* ============================================================
   0e. CORRIDOR — v22.96
   Pure-geometry helpers for active-route candidate filtering. Not yet
   wired into Alerts.tick (deferred). Kept here so the helpers are
   available to whichever code later opts into corridor filtering.
   ============================================================ */
const Corridor = {
  /** Planar distance from a single point to the segment a→b, in metres. */
  distanceToRouteSegment(point, segmentStart, segmentEnd) {
    const latToM = 111320;
    const lngToM = 111320 * Math.cos(point.lat * Math.PI / 180);
    const px = (point.lng - segmentStart.lng) * lngToM;
    const py = (point.lat - segmentStart.lat) * latToM;
    const bx = (segmentEnd.lng - segmentStart.lng) * lngToM;
    const by = (segmentEnd.lat - segmentStart.lat) * latToM;
    const segLenSq = bx * bx + by * by;
    if (segLenSq === 0) return Math.sqrt(px * px + py * py);
    let t = (px * bx + py * by) / segLenSq;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx, dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
  },

  /** True if the point is within corridorMeters of any segment of the
   *  route polyline. routeGeometry expected as a GeoJSON LineString
   *  ({ type:'LineString', coordinates:[[lng,lat],...] }). */
  isPointInsideRouteCorridor(point, routeGeometry, corridorMeters) {
    if (!routeGeometry || !Array.isArray(routeGeometry.coordinates)) return false;
    const coords = routeGeometry.coordinates;
    if (coords.length < 2) return false;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = { lng: coords[i][0],     lat: coords[i][1] };
      const b = { lng: coords[i + 1][0], lat: coords[i + 1][1] };
      const d = Corridor.distanceToRouteSegment(point, a, b);
      if (d <= corridorMeters) return true;
    }
    return false;
  },

  /** Filter global points to those inside the active route's corridor.
   *  Falls back to a bounding-box around the destination if no
   *  routeGeometry is available, or to "all points" if neither is set. */
  getRouteCandidatePoints(activeRoute, globalPoints) {
    if (!activeRoute) return globalPoints.slice();
    const dest = activeRoute.destination;
    const geom = activeRoute.routeGeometry;
    // Determine corridor width per road type (defaults to unknown if not set)
    const rt = activeRoute.roadType || 'unknown';
    const corridor = rt === 'highway' ? MigrationConfig.CORRIDOR_HIGHWAY_METERS
                  : rt === 'city'    ? MigrationConfig.CORRIDOR_CITY_METERS
                  : MigrationConfig.CORRIDOR_UNKNOWN_METERS;
    if (geom && Array.isArray(geom.coordinates)) {
      return globalPoints.filter(p => Corridor.isPointInsideRouteCorridor(p, geom, corridor));
    }
    // Fallback: bbox around destination (5 km square)
    if (dest && typeof dest.lat === 'number') {
      const km = 5;
      const dLat = km / 111;
      const dLng = km / (111 * Math.cos(dest.lat * Math.PI / 180));
      return globalPoints.filter(p =>
        p.lat >= dest.lat - dLat && p.lat <= dest.lat + dLat &&
        p.lng >= dest.lng - dLng && p.lng <= dest.lng + dLng);
    }
    return globalPoints.slice();
  },

  /** Nearby-only filter for "no active route" mode. Returns points
   *  within `radiusKm` of userState.{lat,lng}. */
  getGlobalCandidatePoints(userState, globalPoints, radiusKm) {
    const r = (typeof radiusKm === 'number') ? radiusKm : 5;
    return globalPoints.filter(p => Utils.distKm(p, userState) <= r);
  },

  /** Top-level dispatcher used by future Alerts integration. */
  getAlertCandidates(userState, activeRoute, globalPoints) {
    if (activeRoute) return Corridor.getRouteCandidatePoints(activeRoute, globalPoints);
    return Corridor.getGlobalCandidatePoints(userState, globalPoints);
  },
};

/* ============================================================
   0e1b. AUTO ROUTE — v23.18.0
   Destinationless-trip support. Does NOT re-implement live candidate
   selection — Observations.liveCandidates + Alerts.tick already scan the
   GLOBAL pool, treat the destination as context-only, and never require
   destId/routePointRefs. AutoRoute only (a) exposes the autoRouteMode
   config with safe defaults and (b) provides a read-only geometry
   classifier built on the same Utils/Speed math, for diagnostics.
   ============================================================ */
const AutoRoute = {
  DEFAULTS: {
    enabled: true,
    startWithoutDestination: true,
    scanRadiusM: 3000,
    forwardConeDeg: 60,
    behindRejectDeg: 120,
    destinationMatchBonus: true,
  },
  config() {
    const s = (typeof State !== 'undefined' && State.settings && State.settings.autoRouteMode) || {};
    return Object.assign({}, this.DEFAULTS, s);
  },
  startWithoutDestinationAllowed() {
    const c = this.config();
    return c.enabled !== false && c.startWithoutDestination !== false;
  },
  isPointAheadOfTravel(userPosition, point, heading, options) {
    const cfg = Object.assign({}, this.config(), options || {});
    const headingKnown = Number.isFinite(heading);
    const out = {
      distanceM: null,
      bearingToPoint: null,
      bearingDiff: null,
      ahead: false,
      behind: false,
      lateral: false,
      headingKnown,
    };
    if (!userPosition || point == null ||
        typeof point.lat !== 'number' || typeof point.lng !== 'number') {
      return out;
    }
    out.distanceM = Utils.distKm(userPosition, point) * 1000;
    if (!headingKnown) {
      out.ahead = true;
      out.lateral = true;
      return out;
    }
    out.bearingToPoint = Speed.bearingBetween(userPosition.lat, userPosition.lng, point.lat, point.lng);
    out.bearingDiff = Speed.angleDiff(heading, out.bearingToPoint);
    if (out.bearingDiff <= cfg.forwardConeDeg) out.ahead = true;
    else if (out.bearingDiff >= cfg.behindRejectDeg) out.behind = true;
    else out.lateral = true;
    return out;
  },

  // v23.18.4 — AUTO ROUTE GATE STACK
  // Tighter candidate filtering for DESTINATIONLESS trips. Runs as a
  // POST-FILTER on Observations.liveCandidates(); never replaces the
  // engine, never re-scans the global pool, never touches DirectionFilter
  // or FeedbackGate. Each gate is additive and skippable per-config.
  // Defaults below match the AutoRoute config (forwardConeDeg=60,
  // behindRejectDeg=120) plus a few new constants kept local to this
  // module.
  LATERAL_CORRIDOR_M: 40,             // perpendicular distance from heading line
  LATERAL_CORRIDOR_HIGHWAY_M: 80,
  LATERAL_CORRIDOR_POOR_GPS_M: 90,
  HIGHWAY_SPEED_KMH: 80,
  POOR_GPS_ACCURACY_M: 35,
  DIRECTIONAL_OPPOSITE_DEG: 135,      // captureBearing vs heading
  DIRECTIONAL_ALIGNED_DEG: 45,
  SAFETY_OVERRIDE_M: 80,              // never suppress this close
  MOVE_AWAY_SLACK_M: 25,              // dist must increase by more than this to "move-away"
  DIST_HISTORY_LEN: 3,
  // Per-point rolling distance history used by the movement-sequence gate.
  // Map<pointId, number[]> — newest sample appended; only the last
  // DIST_HISTORY_LEN samples are kept. Lives on the module so it
  // persists across ticks but is cleared at trip-start by GPS.startTrip
  // (see app-core.js — added below).
  _distHistory: new Map(),
  _filterLogAt: 0,
  recordDistance(pointId, distM) {
    let buf = this._distHistory.get(pointId);
    if (!buf) { buf = []; this._distHistory.set(pointId, buf); }
    buf.push(distM);
    if (buf.length > this.DIST_HISTORY_LEN) buf.shift();
  },
  clearDistanceHistory() { this._distHistory.clear(); },
  /** True if the candidate is generally moving away across the last 3 samples.
   *  Requires at least 2 samples; tolerates jitter via MOVE_AWAY_SLACK_M. */
  isMovingAway(pointId, currentDistM) {
    const buf = this._distHistory.get(pointId);
    if (!buf || buf.length < 2) return false;
    // last sample is the previous tick; current is fresh
    const prev = buf[buf.length - 1];
    if (currentDistM <= prev + this.MOVE_AWAY_SLACK_M) return false;
    // and at least the prior step was also non-decreasing
    if (buf.length >= 2) {
      const older = buf[buf.length - 2];
      if (prev < older - this.MOVE_AWAY_SLACK_M) return false; // recent approach
    }
    return true;
  },
  /** Perpendicular distance (m) from point to the line through userPosition
   *  along `headingDeg`. Local-flat-earth approximation; matches the math
   *  used by Corridor.distanceToRouteSegment. */
  lateralOffsetM(userPosition, point, headingDeg) {
    if (!userPosition || !point || !Number.isFinite(headingDeg)) return null;
    const latToM = 111320;
    const lngToM = 111320 * Math.cos(userPosition.lat * Math.PI / 180);
    const dx = (point.lng - userPosition.lng) * lngToM;
    const dy = (point.lat - userPosition.lat) * latToM;
    // unit vector along heading (heading is compass deg from north, clockwise)
    const hr = headingDeg * Math.PI / 180;
    const hx = Math.sin(hr), hy = Math.cos(hr);
    // perpendicular component magnitude
    return Math.abs(dx * hy - dy * hx);
  },
  /** Filter a liveCandidates() output list. Pure: returns a NEW array.
   *  Each rejection emits a single throttled [AUTO-ROUTE-FILTER] log
   *  line (whole-tick throttle, not per-candidate, to avoid spam). */
  applyGates(cands, userState) {
    if (!Array.isArray(cands) || !cands.length) return cands || [];
    if (!userState) return cands;
    const cfg = this.config();
    const heading = (userState.heading != null) ? userState.heading
                  : (typeof Observations !== 'undefined' && Observations.effectiveHeading)
                    ? Observations.effectiveHeading() : null;
    const headingKnown = Number.isFinite(heading);
    const speedKmh = userState.speedKmh || 0;
    const accM = userState.accuracy || 0;
    const corridorM = (speedKmh >= this.HIGHWAY_SPEED_KMH) ? this.LATERAL_CORRIDOR_HIGHWAY_M
                    : (accM >= this.POOR_GPS_ACCURACY_M)   ? this.LATERAL_CORRIDOR_POOR_GPS_M
                    : this.LATERAL_CORRIDOR_M;
    const out = [];
    let firstReject = null;
    for (const c of cands) {
      const p = c.point;
      const distM = c.distM != null ? c.distM
                  : (Utils.distKm(userState, p) * 1000);
      // Update the per-point history regardless of whether we keep this
      // tick's candidate — needed for the movement gate next tick.
      this.recordDistance(p.id, distM);
      // FeedbackGate-driven hard suppression: respect it.
      if (p.suppressedPendingRevalidation === true) {
        if (!firstReject) firstReject = { id: p.id, reason: 'feedback', distM, heading };
        continue;
      }
      // Safety override: never suppress something this close.
      const closeSafety = distM <= this.SAFETY_OVERRIDE_M;
      // Geometry classifier — reuses isPointAheadOfTravel for the cone test.
      const geo = this.isPointAheadOfTravel(userState, p, headingKnown ? heading : null);
      // 1) Forward-cone gate (default 60°). headingKnown=false ⇒ allowed.
      if (!closeSafety && headingKnown && geo.behind) {
        if (!firstReject) firstReject = { id: p.id, reason: 'behind', distM, heading,
          captureBearing: p.captureBearing, angleDiff: geo.bearingDiff };
        continue;
      }
      if (!closeSafety && headingKnown && geo.bearingDiff != null &&
          geo.bearingDiff > cfg.forwardConeDeg && geo.bearingDiff < cfg.behindRejectDeg) {
        // Lateral band — fall through to lateral corridor gate which is stricter.
      }
      // 2) Lateral corridor gate.
      if (!closeSafety && headingKnown) {
        const lat = this.lateralOffsetM(userState, p, heading);
        if (lat != null && lat > corridorM) {
          if (!firstReject) firstReject = { id: p.id, reason: 'lateral', distM, heading,
            captureBearing: p.captureBearing, angleDiff: geo.bearingDiff };
          continue;
        }
      }
      // 3) Directional-capture gate (non-camera or general directional).
      //    DirectionFilter (v23.10/15) already handles camera audio
      //    suppression; this gate covers ANY directional capture by
      //    keeping it out of the AutoRoute focused list when the driver
      //    is approaching from the opposite side.
      //    v23.18.20 — HARD: closeSafety no longer bypasses this gate.
      //    An opposite-direction directional capture at < 80 m is the
      //    classic safety-override-misfire pattern (e.g. parallel road
      //    going the other way) — suppress regardless of distance.
      if (headingKnown && p.directional === true &&
          typeof p.captureBearing === 'number') {
        const diff = Speed.angleDiff(heading, p.captureBearing);
        if (diff >= this.DIRECTIONAL_OPPOSITE_DEG) {
          if (!firstReject) firstReject = { id: p.id, reason: 'direction', distM, heading,
            captureBearing: p.captureBearing, angleDiff: Math.round(diff) };
          continue;
        }
      }
      // 4) Recent movement-sequence gate.
      if (!closeSafety && this.isMovingAway(p.id, distM)) {
        if (!firstReject) firstReject = { id: p.id, reason: 'moving-away', distM, heading,
          captureBearing: p.captureBearing, angleDiff: geo.bearingDiff };
        continue;
      }
      // v23.18.13 — chain + feedback evidence. Pure reads; never mutates
      // the point. Either may suppress (drops from focused list while
      // marker stays visible) or contribute a scoreDelta used to re-sort
      // survivors below.
      const chainEv = this.chainEvidenceForCandidate(p, userState);
      const fbEv = this.feedbackEvidenceForCandidate(p, userState);
      if (chainEv.action === 'suppress') {
        if (!firstReject) firstReject = { id: p.id, reason: chainEv.suppressReason || 'chain',
          distM, heading, captureBearing: p.captureBearing, angleDiff: chainEv.chainAlignmentDeg };
        this._maybeLogChainEvent(p, chainEv, distM, heading);
        continue;
      }
      if (fbEv.action === 'suppress') {
        if (!firstReject) firstReject = { id: p.id, reason: fbEv.suppressReason || 'feedback',
          distM, heading, captureBearing: p.captureBearing, angleDiff: fbEv._diff };
        this._maybeLogFeedbackEvent(p, fbEv, distM, heading);
        continue;
      }
      c._chainEvidence = chainEv;
      c._feedbackEvidence = fbEv;
      c._scoreDelta = (chainEv.scoreDelta || 0) + (fbEv.scoreDelta || 0);
      // Log non-suppress events too (boost/penalize) for audit visibility.
      if (chainEv.action === 'boost' || chainEv.action === 'penalize') {
        this._maybeLogChainEvent(p, chainEv, distM, heading);
      }
      if (fbEv.action === 'penalize') {
        this._maybeLogFeedbackEvent(p, fbEv, distM, heading);
      }
      out.push(c);
    }
    // v23.18.13 — sort survivors so chain/feedback evidence reorders the
    // focused-id selection. Highest scoreDelta wins; ties fall back to
    // ascending distance (closest first), preserving the prior behavior
    // when no evidence is available.
    out.sort((a, b) => {
      const da = (a._scoreDelta || 0);
      const db = (b._scoreDelta || 0);
      if (da !== db) return db - da;
      const ad = (a.distM != null) ? a.distM : (Utils.distKm(userState, a.point) * 1000);
      const bd = (b.distM != null) ? b.distM : (Utils.distKm(userState, b.point) * 1000);
      return ad - bd;
    });
    // Whole-tick throttled diagnostic — log only the first rejection so
    // the debug buffer doesn't flood. Drops below ~once per 1.5s.
    const now = Date.now();
    if (firstReject && now - this._filterLogAt >= 1500) {
      this._filterLogAt = now;
      const cb = (firstReject.captureBearing != null) ? Math.round(firstReject.captureBearing) : 'n/a';
      const hd = (firstReject.heading != null) ? Math.round(firstReject.heading) : 'n/a';
      const ad = (firstReject.angleDiff != null) ? Math.round(firstReject.angleDiff) : 'n/a';
      logEvent('AUTO-ROUTE-FILTER',
        `suppressed point=${firstReject.id} reason=${firstReject.reason}` +
        ` dist=${Math.round(firstReject.distM)} heading=${hd}` +
        ` captureBearing=${cb} angleDiff=${ad}`);
    }
    return out;
  },

  // v23.18.13 — CHAIN + FEEDBACK EVIDENCE
  // Pure helpers consumed by applyGates above. Read-only on the point;
  // no mutation, no I/O.
  CHAIN_STRONG_ALIGN_DEG: 45,
  CHAIN_WEAK_ALIGN_DEG: 75,
  CHAIN_OPPOSITE_DEG: 135,
  CHAIN_BOOST: 25,
  CHAIN_PENALIZE: -25,
  CHAIN_OPPOSITE_PENALTY: -60,
  SIDE_ROAD_BEARING_DIFF_DEG: 75,
  SIDE_ROAD_CHAIN_DIFF_DEG: 60,
  FEEDBACK_HEADING_MATCH_DEG: 45,
  FEEDBACK_PENALIZE: -40,
  FEEDBACK_SUPPRESS_AFTER: 2, // ≥ N matching-heading FPs ⇒ suppress
  _chainLogAt: 0,
  _feedbackLogAt: 0,
  /** Best-effort chain direction (deg). Prefers captureBearing; falls
   *  back to the segment from the closest prev to the closest next
   *  chain neighbor, then to a single segment if only one neighbor
   *  exists. Returns `{deg, confidence}` — confidence is one of
   *  'unknown' / 'weak' / 'medium' / 'strong'. */
  _inferChainDirection(p) {
    const prev = Array.isArray(p.chainPrev3) ? p.chainPrev3 : [];
    const next = Array.isArray(p.chainNext3) ? p.chainNext3 : [];
    const lastPrev = prev.length ? prev[prev.length - 1] : null;
    const firstNext = next.length ? next[0] : null;
    const hasCB = (typeof p.captureBearing === 'number' && isFinite(p.captureBearing));
    if (hasCB && (lastPrev || firstNext)) return { deg: p.captureBearing, confidence: 'strong' };
    if (hasCB) return { deg: p.captureBearing, confidence: 'medium' };
    if (lastPrev && firstNext &&
        typeof lastPrev.lat === 'number' && typeof firstNext.lat === 'number') {
      const deg = Speed.bearingBetween(lastPrev.lat, lastPrev.lng, firstNext.lat, firstNext.lng);
      return { deg, confidence: 'strong' };
    }
    if (lastPrev && typeof lastPrev.lat === 'number' &&
        typeof p.lat === 'number' && typeof p.lng === 'number') {
      const deg = Speed.bearingBetween(lastPrev.lat, lastPrev.lng, p.lat, p.lng);
      return { deg, confidence: 'weak' };
    }
    if (firstNext && typeof firstNext.lat === 'number' &&
        typeof p.lat === 'number' && typeof p.lng === 'number') {
      const deg = Speed.bearingBetween(p.lat, p.lng, firstNext.lat, firstNext.lng);
      return { deg, confidence: 'weak' };
    }
    return { deg: null, confidence: 'unknown' };
  },
  /** Per-candidate chain evidence. Pure. */
  chainEvidenceForCandidate(p, userState) {
    const out = {
      usable: false, action: 'neutral', scoreDelta: 0, reasons: [],
      chainDirectionDeg: null, chainAlignmentDeg: null, approachAlignmentDeg: null,
      lateralConfidence: 'unknown', suppressReason: null,
    };
    if (!p || !userState) return out;
    const heading = (userState.heading != null) ? userState.heading : null;
    if (!Number.isFinite(heading)) return out; // no heading ⇒ neutral, not broken
    const chain = this._inferChainDirection(p);
    out.chainDirectionDeg = chain.deg;
    out.lateralConfidence = chain.confidence;
    if (chain.deg == null) return out;
    out.usable = true;
    const chainAlign = Speed.angleDiff(heading, chain.deg);
    out.chainAlignmentDeg = chainAlign;
    const bearingToPt = Speed.bearingBetween(userState.lat, userState.lng, p.lat, p.lng);
    const approachAlign = Speed.angleDiff(heading, bearingToPt);
    out.approachAlignmentDeg = approachAlign;
    const distM = Utils.distKm(userState, p) * 1000;
    const closeSafety = distM <= this.SAFETY_OVERRIDE_M;
    const isDirectional = (p.directional === true) ||
      (typeof p.captureBearing === 'number' && isFinite(p.captureBearing));
    // 1) Opposite chain direction.
    //    v23.18.20 — HARD: directional opposite-direction always
    //    suppresses, even within the safety-override distance. Only
    //    the non-directional opposite-chain penalty still respects
    //    closeSafety (since geometry there is noisy at < 80 m).
    if (chainAlign >= this.CHAIN_OPPOSITE_DEG) {
      if (isDirectional) {
        out.action = 'suppress';
        out.suppressReason = 'chain-opposite-directional';
        out.scoreDelta = this.CHAIN_OPPOSITE_PENALTY;
        out.reasons.push('chain-opposite');
        return out;
      }
      if (!closeSafety) {
        out.action = 'penalize';
        out.scoreDelta = this.CHAIN_OPPOSITE_PENALTY;
        out.reasons.push('chain-opposite');
        return out;
      }
    }
    // 2) Perpendicular/penalize band.
    if (!closeSafety && chainAlign > this.CHAIN_WEAK_ALIGN_DEG && chainAlign < this.CHAIN_OPPOSITE_DEG) {
      out.action = 'penalize';
      out.scoreDelta = this.CHAIN_PENALIZE;
      out.reasons.push('chain-misaligned');
    } else if (chainAlign <= this.CHAIN_STRONG_ALIGN_DEG &&
               (chain.confidence === 'medium' || chain.confidence === 'strong')) {
      out.action = 'boost';
      out.scoreDelta = this.CHAIN_BOOST;
      out.reasons.push('chain-aligned');
    }
    // 3) Side-road / parallel-road suppression.
    //    bearing-to-candidate > 75° from heading AND chain alignment > 60°
    //    AND candidate not extremely close.
    if (!closeSafety &&
        approachAlign > this.SIDE_ROAD_BEARING_DIFF_DEG &&
        chainAlign > this.SIDE_ROAD_CHAIN_DIFF_DEG) {
      out.action = 'suppress';
      out.suppressReason = 'side-road-chain';
      out.reasons.push('side-road-chain');
    }
    return out;
  },
  /** False-positive evidence — reads point.falsePositiveApproaches[]
   *  (v23.18.13/17 enriched shape) AND the back-compat v23.9.6
   *  point.feedbackStats.falsePositiveDirectionEvidence[].
   *  v23.18.17 — similarity matches on ANY of: stored heading,
   *  movementBearing, bearingToCandidate (each within ±45° of the
   *  current approach).
   *  v23.18.19 — opposite_direction_likely fast-path: a SINGLE prior
   *  FP carrying that issue + similar approach geometry suppresses
   *  immediately (no 2-FP threshold). Other issues still need
   *  FEEDBACK_SUPPRESS_AFTER matches. Pure. */
  feedbackEvidenceForCandidate(p, userState) {
    const out = { usable: false, action: 'neutral', scoreDelta: 0, reasons: [],
                  suppressReason: null, _diff: null, _matchedField: null, _issue: null };
    if (!p || !userState) return out;
    const heading = userState.heading;
    if (!Number.isFinite(heading)) return out;
    const moveBear = this._movementBearingFromBuffer();
    let bearingToPt = null;
    if (typeof p.lat === 'number' && typeof userState.lat === 'number') {
      bearingToPt = Speed.bearingBetween(userState.lat, userState.lng, p.lat, p.lng);
    }
    // Pull richer approach entries (each may contain heading / moveBear /
    // bearingToCandidate). Old-shape entries fall back to `heading`.
    const approaches = [];
    if (Array.isArray(p.falsePositiveApproaches)) {
      for (const a of p.falsePositiveApproaches) {
        if (!a) continue;
        approaches.push({
          heading: Number.isFinite(a.headingDeg) ? a.headingDeg
                 : Number.isFinite(a.heading)    ? a.heading : null,
          moveBear: Number.isFinite(a.movementBearingDeg) ? a.movementBearingDeg : null,
          bearingTo: Number.isFinite(a.bearingToCandidateDeg) ? a.bearingToCandidateDeg : null,
          issue: (typeof a.issue === 'string' && a.issue) ? a.issue
               : (typeof a.reason === 'string' && a.reason) ? a.reason : null,
        });
      }
    }
    // Back-compat heading derivation from v23.9.6 evidence list.
    const fb = (p.feedbackStats && Array.isArray(p.feedbackStats.falsePositiveDirectionEvidence))
      ? p.feedbackStats.falsePositiveDirectionEvidence : [];
    if (fb.length && typeof p.captureBearing === 'number') {
      for (const e of fb) {
        if (!e || !Number.isFinite(e.headingDelta)) continue;
        approaches.push({
          heading: ((p.captureBearing + e.headingDelta) % 360 + 360) % 360,
          moveBear: null, bearingTo: null,
        });
        approaches.push({
          heading: ((p.captureBearing - e.headingDelta) % 360 + 360) % 360,
          moveBear: null, bearingTo: null,
        });
      }
    }
    if (!approaches.length) return out;
    let matches = 0, bestDiff = null, bestField = null, bestIssue = null;
    let oppositeMatch = false;
    const matchCh = (field, prevVal, curVal) => {
      if (!Number.isFinite(prevVal) || !Number.isFinite(curVal)) return false;
      const d = Speed.angleDiff(curVal, prevVal);
      if (d <= this.FEEDBACK_HEADING_MATCH_DEG) {
        if (bestDiff == null || d < bestDiff) { bestDiff = d; bestField = field; }
        return true;
      }
      return false;
    };
    for (const a of approaches) {
      let hit = false;
      if (matchCh('heading',   a.heading,   heading))    hit = true;
      if (matchCh('moveBear',  a.moveBear,  moveBear))   hit = true;
      if (matchCh('bearingTo', a.bearingTo, bearingToPt))hit = true;
      if (hit) {
        matches++;
        if (a.issue && bestIssue == null) bestIssue = a.issue;
        if (a.issue === 'opposite_direction_likely') oppositeMatch = true;
      }
    }
    if (!matches) return out;
    out.usable = true;
    out._diff = bestDiff;
    out._matchedField = bestField;
    out._issue = bestIssue;
    // v23.18.19/20 — single-FP fast path for the strong
    // direction-based classifier issues. Both opposite_direction_likely
    // AND parallel_road_likely indicate "user is approaching from a
    // direction the capture wasn't meant to alert from" and one match
    // is enough to suppress.
    const directionFp = oppositeMatch ||
      bestIssue === 'parallel_road_likely';
    if (directionFp) {
      out.action = 'suppress';
      out.suppressReason = oppositeMatch
        ? 'feedback-opposite-direction'
        : 'feedback-similar-approach';
      out.scoreDelta = -200;
      out.reasons.push(out.suppressReason);
      return out;
    }
    if (matches >= this.FEEDBACK_SUPPRESS_AFTER) {
      out.action = 'suppress';
      out.suppressReason = 'feedback-similar-approach';
      out.scoreDelta = -200;
    } else {
      out.action = 'penalize';
      out.scoreDelta = this.FEEDBACK_PENALIZE;
    }
    out.reasons.push('feedback-similar-approach');
    return out;
  },
  /** Throttled diagnostic emitters. Per-channel rate-limit (1.5 s). */
  _maybeLogChainEvent(p, ev, distM, heading) {
    const now = Date.now();
    if (now - this._chainLogAt < 1500) return;
    this._chainLogAt = now;
    const cb = (typeof p.captureBearing === 'number') ? Math.round(p.captureBearing) : 'n/a';
    const ch = (ev.chainDirectionDeg != null) ? Math.round(ev.chainDirectionDeg) : 'n/a';
    const diff = (ev.chainAlignmentDeg != null) ? Math.round(ev.chainAlignmentDeg) : 'n/a';
    const hd = Number.isFinite(heading) ? Math.round(heading) : 'n/a';
    const reason = ev.suppressReason || (ev.reasons.length ? ev.reasons[0] : 'none');
    logEvent('AUTO-ROUTE-CHAIN',
      `point=${this.shortIdOf(p)} action=${ev.action} reason=${reason} dist=${Math.round(distM)}` +
      ` heading=${hd} chain=${ch} captureBearing=${cb} diff=${diff}`);
  },
  _maybeLogFeedbackEvent(p, ev, distM, heading) {
    const now = Date.now();
    if (now - this._feedbackLogAt < 1500) return;
    this._feedbackLogAt = now;
    const hd = Number.isFinite(heading) ? Math.round(heading) : 'n/a';
    const diff = (ev._diff != null) ? Math.round(ev._diff) : 'n/a';
    const idShown = this.shortIdOf(p);
    // v23.18.17/19 — emit as AUTO-ROUTE-FP-SUPPRESS when the action is
    // suppress. The reason already encodes whether it's the
    // single-FP opposite-direction fast path or the generic
    // similar-approach match.
    if (ev.action === 'suppress') {
      logEvent('AUTO-ROUTE-FP-SUPPRESS',
        `point=${idShown} reason=${ev.suppressReason || 'feedback-similar-approach'}` +
        ` heading=${hd} matched=${ev._matchedField || 'n/a'} diff=${diff}` +
        ` issue=${ev._issue || 'n/a'}`);
    } else {
      logEvent('AUTO-ROUTE-FEEDBACK',
        `point=${idShown} action=${ev.action} reason=${ev.suppressReason || 'feedback-similar-approach'}` +
        ` heading=${hd} diff=${diff}`);
    }
  },
  /** Record a false-positive approach onto the point. Append-only;
   *  size-capped so the array can't grow without bound. */
  FALSE_POSITIVE_APPROACH_CAP: 5,
  recordFalsePositiveApproach(point, userState, reason) {
    if (!point) return;
    if (!Array.isArray(point.falsePositiveApproaches)) point.falsePositiveApproaches = [];
    // v23.18.17 — pull richer context from the most recent emission
    // snapshot so the stored approach has everything needed for
    // similarity matching: movement bearing, bearingToCandidate,
    // captureBearing, chainDirection, lateralOffset, gpsAccuracy.
    const last = (point.lastAutoRouteDecision && typeof point.lastAutoRouteDecision === 'object')
      ? point.lastAutoRouteDecision : null;
    const heading = (userState && Number.isFinite(userState.heading))
      ? userState.heading
      : (Number.isFinite(State && State.heading) ? State.heading : null);
    const moveBear = this._movementBearingFromBuffer();
    let bearingToPt = null;
    if (userState && userState.lat != null && point.lat != null && typeof Speed !== 'undefined') {
      bearingToPt = Speed.bearingBetween(userState.lat, userState.lng, point.lat, point.lng);
    }
    const captureBearingDeg = (typeof point.captureBearing === 'number') ? point.captureBearing : null;
    let chainDirectionDeg = null;
    try {
      const cd = this._inferChainDirection(point);
      chainDirectionDeg = (cd && cd.deg != null) ? Math.round(cd.deg * 10) / 10 : null;
    } catch (e) {}
    const angleDiffDeg = (Number.isFinite(heading) && Number.isFinite(captureBearingDeg))
      ? Speed.angleDiff(heading, captureBearingDeg) : null;
    const lateralOffsetM = (userState && Number.isFinite(heading))
      ? this.lateralOffsetM(userState, point, heading) : null;
    const distanceM = (userState && userState.lat != null && point.lat != null)
      ? Math.round(Utils.distKm(userState, point) * 1000)
      : (last && Number.isFinite(last.distM)) ? Math.round(last.distM) : null;
    // Infer a structured reason if the caller didn't classify.
    let resolved = reason || null;
    if (!resolved || resolved === 'manual') {
      resolved = this._inferFpReason({ angleDiffDeg, lateralOffsetM, point });
    }
    const entry = {
      createdAt: new Date().toISOString(),
      pointId: point.id || null,
      shortId: point.shortId || null,
      chainId: point.chainId || null,
      headingDeg: (heading != null) ? Math.round(heading * 10) / 10 : null,
      movementBearingDeg: (moveBear != null) ? Math.round(moveBear * 10) / 10 : null,
      captureBearingDeg: (captureBearingDeg != null) ? Math.round(captureBearingDeg * 10) / 10 : null,
      chainDirectionDeg,
      bearingToCandidateDeg: (bearingToPt != null) ? Math.round(bearingToPt * 10) / 10 : null,
      angleDiffDeg: (angleDiffDeg != null) ? Math.round(angleDiffDeg * 10) / 10 : null,
      lateralOffsetM: (lateralOffsetM != null) ? Math.round(lateralOffsetM) : null,
      distM: distanceM,
      // Back-compat alias the v23.18.13 reader expects:
      heading: (heading != null) ? Math.round(heading * 10) / 10 : null,
      distanceM: distanceM,
      reason: resolved || 'unknown',
      // v23.18.19 — `issue` mirrors the FeedbackGate classifier output
      // (opposite_direction_likely / parallel_road_likely / …) so the
      // suppression read-side can act on it without re-classifying.
      issue: resolved || 'unknown',
      source: 'feedback-popup',
      sourceDecisionReason: last ? (last.finalReason || null) : null,
      sourceDecisionScore: last ? (last.score != null ? last.score : null) : null,
    };
    point.falsePositiveApproaches.push(entry);
    while (point.falsePositiveApproaches.length > this.FALSE_POSITIVE_APPROACH_CAP) {
      point.falsePositiveApproaches.shift();
    }
    point.lastFalsePositiveAt = entry.createdAt;
    point.lastFalsePositiveReason = entry.reason;
    if (typeof point.falsePositiveCount !== 'number') point.falsePositiveCount = 0;
    point.falsePositiveCount++;
    try {
      const sid = this.shortIdOf(point);
      const cb = (entry.captureBearingDeg != null) ? Math.round(entry.captureBearingDeg) : 'null';
      const ch = (entry.chainDirectionDeg != null) ? Math.round(entry.chainDirectionDeg) : 'null';
      const hd = (entry.headingDeg != null) ? Math.round(entry.headingDeg) : 'n/a';
      const bt = (entry.bearingToCandidateDeg != null) ? Math.round(entry.bearingToCandidateDeg) : 'n/a';
      logEvent('AUTO-ROUTE-FP-STORED',
        `point=${sid} reason=${entry.reason} issue=${entry.issue || 'n/a'}` +
        ` heading=${hd} bearingTo=${bt} captureBearing=${cb} chain=${ch}`);
    } catch (e) {}
  },

  /* ------------------------------------------------------------------
   * v23.18.17 — DECISION SNAPSHOT + EMISSION HOOK
   * Captures the exact state at the moment an AutoRoute alert fires
   * so a later false-positive report can explain "why was this
   * allowed?" without re-running the gates. Pure write; never touches
   * scoring or sound.
   * ------------------------------------------------------------------ */
  /** Compute the movement bearing across the most recent two GPS fixes.
   *  Returns null if we don't have two distinct fixes yet. */
  _movementBearingFromBuffer() {
    try {
      const buf = (State && Array.isArray(State.gpsFixBuffer)) ? State.gpsFixBuffer : [];
      if (buf.length < 2) return null;
      const a = buf[buf.length - 2], b = buf[buf.length - 1];
      if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
      if (a.lat === b.lat && a.lng === b.lng) return null;
      if (typeof Speed === 'undefined') return null;
      return Speed.bearingBetween(a.lat, a.lng, b.lat, b.lng);
    } catch (e) { return null; }
  },
  /** Best-effort distance trend across recent fixes. */
  _distTrendForPoint(point) {
    const buf = (State && Array.isArray(State.gpsFixBuffer)) ? State.gpsFixBuffer : [];
    if (buf.length < 2 || !point) return null;
    const last = buf[buf.length - 1], prev = buf[buf.length - 2];
    if (!last || !prev || typeof point.lat !== 'number') return null;
    const lastM = Utils.distKm(last, point) * 1000;
    const prevM = Utils.distKm(prev, point) * 1000;
    if (lastM > prevM + this.MOVE_AWAY_SLACK_M) return 'increasing';
    if (lastM < prevM - this.MOVE_AWAY_SLACK_M) return 'decreasing';
    return 'flat';
  },
  /** Returns gate pass/fail map for the current state. Pure. */
  gateStatusForPoint(point, userState, distM) {
    const cfg = this.config();
    const out = {
      distance: 'unknown', forward: 'unknown', direction: 'unknown',
      lateral: 'unknown', movingToward: 'unknown', cooldown: 'unknown',
      feedback: 'unknown', chain: 'unknown',
    };
    if (!point || !userState) return out;
    const heading = (userState.heading != null) ? userState.heading
                  : (typeof Observations !== 'undefined' && Observations.effectiveHeading)
                    ? Observations.effectiveHeading() : null;
    const headingKnown = Number.isFinite(heading);
    out.distance = (distM != null && distM <= cfg.scanRadiusM) ? 'pass' : 'fail';
    if (headingKnown) {
      const geo = this.isPointAheadOfTravel(userState, point, heading);
      out.forward = (geo && !geo.behind) ? 'pass' : 'fail';
      const lat = this.lateralOffsetM(userState, point, heading);
      const speedKmh = userState.speedKmh || 0;
      const accM = userState.accuracy || 0;
      const corridorM = (speedKmh >= this.HIGHWAY_SPEED_KMH) ? this.LATERAL_CORRIDOR_HIGHWAY_M
                      : (accM >= this.POOR_GPS_ACCURACY_M)   ? this.LATERAL_CORRIDOR_POOR_GPS_M
                      : this.LATERAL_CORRIDOR_M;
      out.lateral = (lat == null || lat <= corridorM) ? 'pass' : 'fail';
      if (point.directional === true && typeof point.captureBearing === 'number') {
        out.direction = (Speed.angleDiff(heading, point.captureBearing) < this.DIRECTIONAL_OPPOSITE_DEG)
          ? 'pass' : 'fail';
      }
    }
    if (point.id && State && State.passedPoints) {
      out.cooldown = State.passedPoints.has(point.id) ? 'fail' : 'pass';
    }
    out.movingToward = (this.isMovingAway(point.id, distM)) ? 'fail' : 'pass';
    out.feedback = (point.suppressedPendingRevalidation === true) ? 'fail' : 'pass';
    try {
      const chain = this.chainEvidenceForCandidate(point, userState);
      out.chain = (chain && chain.action === 'suppress') ? 'fail' : 'pass';
    } catch (e) {}
    return out;
  },
  /** Build a compact decision snapshot. Pure. */
  buildDecisionSnapshot(point, userState, distM, finalReason, score) {
    const heading = (userState && Number.isFinite(userState.heading)) ? userState.heading : null;
    const moveBear = this._movementBearingFromBuffer();
    const cb = (typeof point.captureBearing === 'number') ? point.captureBearing : null;
    let chainDir = null;
    try {
      const cd = this._inferChainDirection(point);
      chainDir = (cd && cd.deg != null) ? Math.round(cd.deg * 10) / 10 : null;
    } catch (e) {}
    let bearingTo = null;
    if (userState && userState.lat != null && point.lat != null) {
      bearingTo = Speed.bearingBetween(userState.lat, userState.lng, point.lat, point.lng);
    }
    const angleDiff = (Number.isFinite(heading) && Number.isFinite(cb))
      ? Speed.angleDiff(heading, cb) : null;
    const lateral = (userState && Number.isFinite(heading))
      ? this.lateralOffsetM(userState, point, heading) : null;
    return {
      alertedAt: new Date().toISOString(),
      pointId: point.id || null,
      shortId: point.shortId || null,
      chainId: point.chainId || null,
      type: point.type || null,
      distM: (distM != null) ? Math.round(distM) : null,
      headingDeg: (heading != null) ? Math.round(heading * 10) / 10 : null,
      movementBearingDeg: (moveBear != null) ? Math.round(moveBear * 10) / 10 : null,
      captureBearingDeg: (cb != null) ? Math.round(cb * 10) / 10 : null,
      chainDirectionDeg: chainDir,
      bearingToCandidateDeg: (bearingTo != null) ? Math.round(bearingTo * 10) / 10 : null,
      angleDiffDeg: (angleDiff != null) ? Math.round(angleDiff * 10) / 10 : null,
      lateralOffsetM: (lateral != null) ? Math.round(lateral) : null,
      gpsAccuracyM: (userState && typeof userState.accuracy === 'number') ? Math.round(userState.accuracy) : null,
      score: (score != null) ? score : null,
      finalAction: 'alert',
      finalReason: finalReason || 'threshold-cross',
      gates: this.gateStatusForPoint(point, userState, distM),
    };
  },
  /** Infer an FP reason from the most recent snapshot when the user
   *  didn't (or couldn't) classify. Returns one of the documented
   *  reason strings or 'unknown'. */
  _inferFpReason(ctx) {
    if (!ctx) return 'unknown';
    const { angleDiffDeg, lateralOffsetM, point } = ctx;
    if (angleDiffDeg != null && angleDiffDeg >= 135) return 'opposite-direction';
    if (lateralOffsetM != null && lateralOffsetM > this.LATERAL_CORRIDOR_M * 1.5) return 'side-road';
    try {
      const trend = this._distTrendForPoint(point);
      if (trend === 'increasing') return 'already-passed';
    } catch (e) {}
    return 'unknown';
  },
  /** Called from Audio.alert at the exact emission moment. Writes
   *  point.lastAutoRouteDecision and emits AUTO-ROUTE-EMIT. Pure-ish:
   *  only mutates the point's snapshot field. */
  noteAlertEmitted(point, meters, finalReason) {
    if (!point || !State || typeof State.activeDest !== 'function') return;
    // Snapshot is only meaningful for AutoRoute (destinationless)
    // emissions — destination mode has its own context-only sort and
    // we don't want to pollute that path's per-point snapshot.
    if (State.activeDest()) return;
    const userState = (typeof Observations !== 'undefined' && Observations.buildUserState)
      ? Observations.buildUserState() : null;
    if (!userState) return;
    const distM = (meters != null) ? meters
      : (point.lat != null) ? Utils.distKm(userState, point) * 1000 : null;
    const snap = this.buildDecisionSnapshot(point, userState, distM, finalReason, null);
    point.lastAutoRouteDecision = snap;
    // v23.18.19 — keep a per-module "last emitted alert" pointer so
    // Confirm._showNext can log binding source and the final emission
    // gate can re-verify against this exact point.
    this.lastEmittedAlert = {
      pointId: point.id || null,
      shortId: point.shortId || null,
      type: snap.type,
      emittedAt: snap.alertedAt,
      distM: snap.distM,
      headingDeg: snap.headingDeg,
      movementBearingDeg: snap.movementBearingDeg,
      bearingToCandidateDeg: snap.bearingToCandidateDeg,
      captureBearingDeg: snap.captureBearingDeg,
      chainDirectionDeg: snap.chainDirectionDeg,
      finalReason: snap.finalReason,
      score: snap.score,
    };
    try {
      const sid = this.shortIdOf(point);
      const cb = (snap.captureBearingDeg != null) ? Math.round(snap.captureBearingDeg) : 'null';
      const ch = (snap.chainDirectionDeg != null) ? Math.round(snap.chainDirectionDeg) : 'null';
      const hd = (snap.headingDeg != null) ? Math.round(snap.headingDeg) : 'n/a';
      const bt = (snap.bearingToCandidateDeg != null) ? Math.round(snap.bearingToCandidateDeg) : 'n/a';
      logEvent('AUTO-ROUTE-EMIT',
        `point=${sid} type=${snap.type || '?'} dist=${snap.distM}` +
        ` score=${snap.score != null ? snap.score : 'n/a'}` +
        ` reason=${snap.finalReason} heading=${hd} bearingTo=${bt}` +
        ` captureBearing=${cb} chain=${ch}`);
    } catch (e) {}
  },

  /** v23.18.19 — Canonical shortId fallback used by every AutoRoute
   *  log. Order: point.shortId → point.id → 'unknown'. */
  shortIdOf(p) {
    if (!p) return 'unknown';
    if (typeof p.shortId === 'string' && p.shortId) return p.shortId;
    if (typeof p.id === 'string' && p.id) return p.id;
    return 'unknown';
  },

  /** v23.18.19 — Feedback-binding window (ms). A feedback prompt that
   *  opens within this window of a real AutoRoute alert emission for
   *  the SAME pointId is treated as "bound" to the emitted alert; an
   *  out-of-window or different-point prompt is logged as a
   *  passed-fallback for troubleshooting. */
  FEEDBACK_BINDING_WINDOW_MS: 60 * 1000,
  /** Returns 'last-emitted' or 'passed-fallback' for a given queued
   *  prompt. Pure read; emits the FEEDBACK-BINDING log line so the
   *  audit channel makes the binding explicit. */
  logFeedbackBinding(point, queuedKind) {
    if (!point) return 'unknown';
    const last = this.lastEmittedAlert;
    const now = Date.now();
    let source = 'passed-fallback';
    let reason = (queuedKind === 'passed') ? 'queued-onPassed' : 'queued-' + (queuedKind || 'ahead');
    if (last && last.pointId === point.id) {
      const emittedMs = last.emittedAt ? Date.parse(last.emittedAt) : NaN;
      if (isFinite(emittedMs) && now - emittedMs <= this.FEEDBACK_BINDING_WINDOW_MS) {
        source = 'last-emitted';
        reason = 'same-point-within-window';
      }
    }
    try {
      logEvent('FEEDBACK-BINDING',
        `source=${source} point=${this.shortIdOf(point)} kind=${queuedKind || 'ahead'} reason=${reason}`);
    } catch (e) {}
    return source;
  },

  /** v23.18.19 — Final emission gate. Re-runs the cheap suppression
   *  checks at the EXACT moment before Audio.alert fires, so a
   *  late-arrived FP / a state change since aheadList was computed
   *  can still veto the sound. Returns {emit, reason}.
   *  v23.18.20 — accepts `alertKind` so re-approach / here-now /
   *  threshold paths can share one gate and emit a unified
   *  AUTO-ROUTE-FINAL log. The returned object now also carries
   *  pointId / shortId / dist / heading / bearingTo / captureBearing
   *  / chain / safetyOverride so callers can log uniformly. */
  HARD_SUPPRESSION_REASONS: new Set([
    'feedback-similar-approach',
    'feedback-opposite-direction',
    'feedback-revalidation',
    'chain-opposite-directional',
    'opposite-direction',
    'side-road-chain',
    'lateral',
    'moving-away',
    'cooldown-passed',
  ]),
  isHardSuppression(reason) {
    return !!(reason && this.HARD_SUPPRESSION_REASONS.has(reason));
  },
  finalGateForEmission(point, meters, alertKind) {
    const kind = alertKind || 'threshold';
    const out = { emit: true, reason: 'pass', source: 'final',
                  alertKind: kind, pointId: null, shortId: null, type: null,
                  distM: null, headingDeg: null, bearingToCandidateDeg: null,
                  captureBearingDeg: null, chainDirectionDeg: null,
                  safetyOverride: false };
    if (!point || !State || typeof State.activeDest !== 'function') return out;
    if (State.activeDest()) return out; // destination mode unchanged
    const userState = (typeof Observations !== 'undefined' && Observations.buildUserState)
      ? Observations.buildUserState() : null;
    if (!userState) return out;
    const distM = (meters != null) ? meters
      : (point.lat != null) ? Utils.distKm(userState, point) * 1000 : null;
    out.pointId = point.id || null;
    out.shortId = point.shortId || null;
    out.type = point.type || null;
    out.distM = (distM != null) ? Math.round(distM) : null;
    out.headingDeg = (Number.isFinite(userState.heading)) ? Math.round(userState.heading) : null;
    if (point.lat != null) {
      out.bearingToCandidateDeg = Math.round(
        Speed.bearingBetween(userState.lat, userState.lng, point.lat, point.lng));
    }
    out.captureBearingDeg = (typeof point.captureBearing === 'number')
      ? Math.round(point.captureBearing) : null;
    try {
      const cd = this._inferChainDirection(point);
      out.chainDirectionDeg = (cd && cd.deg != null) ? Math.round(cd.deg) : null;
    } catch (e) {}
    out.safetyOverride = (distM != null && distM <= this.SAFETY_OVERRIDE_M);
    // 1) FeedbackGate-driven hard suppression. ALWAYS fires.
    if (point.suppressedPendingRevalidation === true) {
      out.emit = false; out.reason = 'feedback-revalidation'; return out;
    }
    // 2) Feedback similar approach (heading / moveBear / bearingTo).
    //    v23.18.19 + 20 — opposite-direction fast path = single-FP
    //    suppress; remains a HARD suppression that safety override
    //    cannot bypass.
    const fb = this.feedbackEvidenceForCandidate(point, userState);
    if (fb && fb.action === 'suppress') {
      out.emit = false;
      out.reason = fb.suppressReason || 'feedback-similar-approach';
      return out;
    }
    // 3) Chain evidence (opposite-direction directional / side-road).
    //    v23.18.20 — chainEvidenceForCandidate now reports opposite-
    //    direction-directional even when distM ≤ SAFETY_OVERRIDE_M.
    const ce = this.chainEvidenceForCandidate(point, userState);
    if (ce && ce.action === 'suppress') {
      out.emit = false;
      out.reason = ce.suppressReason || 'chain-suppress';
      return out;
    }
    // 4) Directional capture opposite-bearing. Hard.
    if (point.directional === true && typeof point.captureBearing === 'number' &&
        Number.isFinite(userState.heading)) {
      const diff = Speed.angleDiff(userState.heading, point.captureBearing);
      if (diff >= this.DIRECTIONAL_OPPOSITE_DEG) {
        out.emit = false; out.reason = 'opposite-direction'; return out;
      }
    }
    // 5) Moving-away (uses already-recorded rolling distance history).
    //    Safety-override skips this only for very close approaches
    //    that already passed the harder checks above.
    if (distM != null && !out.safetyOverride && this.isMovingAway(point.id, distM)) {
      out.emit = false; out.reason = 'moving-away'; return out;
    }
    // 6) Cooldown / already passed. Threshold path may explicitly want
    //    to bypass (re-approach re-arm is what clears it), so re-approach
    //    callers explicitly pass alertKind='re-approach' and accept the
    //    cooldown check as informational rather than suppressive.
    if (kind !== 're-approach' && point.id && State.passedPoints &&
        State.passedPoints.has(point.id)) {
      out.emit = false; out.reason = 'cooldown-passed'; return out;
    }
    return out;
  },

  /** v23.18.20 — Single, shared final-emission gate used by every
   *  AutoRoute alert path (threshold, here-now, re-approach,
   *  focused-candidate diagnostics, safety-override). Wraps
   *  finalGateForEmission and emits a single throttled
   *  [AUTO-ROUTE-FINAL] log per call. Suppress logs are throttled to
   *  1.5 s per channel; emit logs are not throttled (rare event). */
  _finalLogAt: { emit: 0, suppress: 0 },
  finalEmissionAllowed(point, meters, alertKind, opts) {
    const g = this.finalGateForEmission(point, meters, alertKind);
    const allowed = !!g.emit;
    const sid = this.shortIdOf(point);
    const hd = (g.headingDeg != null) ? g.headingDeg : 'n/a';
    const bt = (g.bearingToCandidateDeg != null) ? g.bearingToCandidateDeg : 'n/a';
    const cb = (g.captureBearingDeg != null) ? g.captureBearingDeg : 'null';
    const ch = (g.chainDirectionDeg != null) ? g.chainDirectionDeg : 'null';
    const so = g.safetyOverride ? 'true' : 'false';
    const finalLbl = allowed ? 'emit' : 'suppress';
    const channel = allowed ? 'emit' : 'suppress';
    const now = Date.now();
    const force = !!(opts && opts.forceLog);
    const throttle = (channel === 'suppress') ? 1500 : 0;
    if (force || throttle === 0 || (now - (this._finalLogAt[channel] || 0)) >= throttle) {
      this._finalLogAt[channel] = now;
      try {
        logEvent('AUTO-ROUTE-FINAL',
          `point=${sid} alertKind=${g.alertKind} final=${finalLbl} reason=${g.reason}` +
          ` dist=${g.distM} heading=${hd} bearingTo=${bt}` +
          ` captureBearing=${cb} chain=${ch} safetyOverride=${so}`);
      } catch (e) {}
    }
    return { allowed, gate: g };
  },
};

/* ============================================================
   0e2. OBSERVATIONS — v23.8.0
   Global observation pool + destination-intent matcher.

   The primitive is an OBSERVATION (a captured road item at a fixed
   GPS location), not a route. Observations live in State.data.points
   and are matched globally on every trip that drives past them.

   Primary gate (always runs):
     - proximity (distance from current GPS position)
     - ahead-of-driver (current heading or recent movement bearing)
     - heading compatibility (only directional points may be rejected,
       and only when reliable heading shows them clearly opposite)
     - confidence (trusted points alert even with weak side signals)

   Active route corridor (when MapView._routeCoords is populated):
     - ADDITIVE only — may extend lookahead, raise priority, mark
       observations as "on route" for ordering and known-road counts.
     - Must NOT remove a nearby/ahead observation that already passed
       the primary gate. Calculated routes can disagree with the road
       actually driven; gating on the polyline would silently miss
       alerts.

   Lateral corridor width vs. forward lookahead are TWO SEPARATE
   parameters. corridorWidthM answers "how far sideways from the
   route line may a point still count as route-related?". lookaheadM
   answers "how far in front of the driver should we look?". Re-using
   one as the other was the prior source of mistuned trigger timing.

   Backward compatibility: every existing State.data.points entry is
   alertable. migrateAdditive() adds {confirmedCount, firstSeenAt,
   lastSeenAt, heading, bidirectional, source, routeTags,
   lastConfirmedAt} as NEW fields when missing — no rename, no
   delete, no silent suppression. Legacy points (no captureBearing /
   no observationCount) inherit a baseline confidence that keeps
   them alertable; the spec mandates "every currently-rendering and
   currently-alerting point still alerts after migration".
   ============================================================ */
const ObservationsConfig = {
  // Forward lookahead (longitudinal). Distance ahead of the driver
  // where alerts are evaluated. Tuned for ≈8-15s of lead time at the
  // matching speed band.
  LOOKAHEAD_CITY_M:    120,   // ≤ 30 km/h
  LOOKAHEAD_MEDIUM_M:  250,   // 30 - 80 km/h
  LOOKAHEAD_HIGHWAY_M: 400,   // > 80 km/h
  // Lateral corridor width (sideways from the active route polyline).
  CORRIDOR_CITY_M:     75,
  CORRIDOR_HIGHWAY_M:  150,
  CORRIDOR_WEAK_GPS_M: 200,
  WEAK_GPS_ACCURACY_M: 50,
  // Hard outer envelope for the linear scan.
  MAX_SCAN_RADIUS_KM:  5,
  // Behind-the-driver tolerance — never reject an observation that's
  // still within this distance even if heading suggests it's behind
  // (the user may have just driven over it; passed-detection handles
  // the rest).
  BEHIND_TOLERANCE_M:  60,
  // Heading-mismatch threshold for directional points. Only a strong
  // mismatch (≥ this) suppresses; oblique angles still alert.
  STRONG_MISMATCH_DEG: 135,
  // Known-road thresholds for the small ahead-of-driver indicator.
  KNOWN_ROAD_MIN_COUNT: 3,
};

const Observations = {
  /** All usable observations from the global pool. Filters out
   *  retired (status === 'no') and any record missing coordinates.
   *  Never filters by active destination.
   *  v23.9.6: also filters out points the false-positive ladder has
   *  marked suppressedPendingRevalidation. They stay in storage and
   *  on the map (visible markers and audit trail are unchanged) but
   *  the alert / next-ahead engines treat them as silent until the
   *  flag is cleared by manual edit or future positive feedback. */
  globalPool() {
    if (!State || !State.data || !Array.isArray(State.data.points)) return [];
    return State.data.points.filter(p =>
      p && p.status !== 'no'
        && !p.suppressedPendingRevalidation
        && typeof p.lat === 'number' && typeof p.lng === 'number'
    );
  },

  /** Forward lookahead distance (m) for the given speed (km/h). */
  forwardLookaheadM(speedKmh) {
    if (speedKmh == null || isNaN(speedKmh)) return ObservationsConfig.LOOKAHEAD_MEDIUM_M;
    if (speedKmh >= 80) return ObservationsConfig.LOOKAHEAD_HIGHWAY_M;
    if (speedKmh >= 30) return ObservationsConfig.LOOKAHEAD_MEDIUM_M;
    return ObservationsConfig.LOOKAHEAD_CITY_M;
  },

  /** Lateral corridor width (m) from the active route polyline. */
  corridorWidthM(speedKmh, gpsAccuracy) {
    let w = (speedKmh != null && speedKmh >= 80)
      ? ObservationsConfig.CORRIDOR_HIGHWAY_M
      : ObservationsConfig.CORRIDOR_CITY_M;
    if (gpsAccuracy != null && gpsAccuracy > ObservationsConfig.WEAK_GPS_ACCURACY_M) {
      w = Math.max(w, ObservationsConfig.CORRIDOR_WEAK_GPS_M);
    }
    return w;
  },

  /** Best-available driver heading. Prefers reliable GPS heading,
   *  falls back to movement bearing from the last two samples, then
   *  to null. */
  effectiveHeading() {
    const speedKmh = (State.speedMps || 0) * 3.6;
    if (State.heading != null && Speed.isHeadingReliable(speedKmh)) return State.heading;
    if (State.prevPos && State.pos && State.speedMps > 1) {
      return Utils.bearing(State.prevPos, State.pos);
    }
    if (State.heading != null) return State.heading; // low-speed fallback (noisy)
    return null;
  },

  /** Is this observation ahead of the driver?  Returns true when:
   *    - no usable heading (low speed / stationary)        — neutral
   *    - heading is reliable and point is within ±90° of it
   *    - point is within BEHIND_TOLERANCE_M (just-passed safety)
   *  Returns false only when the driver has a clearly forward-facing
   *  heading and the point sits well behind them. */
  isAhead(p, userLat, userLng, heading, speedKmh, distM) {
    if (distM != null && distM <= ObservationsConfig.BEHIND_TOLERANCE_M) return true;
    if (heading == null) return true;
    // Low-speed: heading is noisy, never reject for it (spec 7).
    if (speedKmh != null && speedKmh < 10) return true;
    const b = Speed.bearingBetween(userLat, userLng, p.lat, p.lng);
    return Speed.angleDiff(heading, b) <= 90;
  },

  /** Heading compatibility for directional observations. Legacy /
   *  null heading is bidirectional by default (spec 8 + 12c). Only
   *  a clearly opposite heading suppresses a directional point. */
  headingCompatible(p, heading, speedKmh) {
    if (!p) return true;
    if (p.bidirectional === true) return true;
    if (!p.directional) return true;
    const pointBearing = (p.captureBearing != null) ? p.captureBearing
                       : (typeof p.heading === 'number')   ? p.heading
                       : null;
    if (pointBearing == null) return true; // legacy directional with no recorded bearing
    if (heading == null) return true;
    if (speedKmh != null && speedKmh < 10) return true;
    const diff = Speed.angleDiff(heading, pointBearing);
    // v23.9.6: per-observation directional-strictness override. Set
    // when the false-positive ladder classifies an FP as
    // opposite_direction_likely / parallel_road_likely. The threshold
    // drops from the global STRONG_MISMATCH_DEG (135°) to 45° for THIS
    // observation only — global gating is unchanged.
    if (p.needsDirectionalValidation === true) {
      return diff < 45;
    }
    return diff < ObservationsConfig.STRONG_MISMATCH_DEG;
  },

  /** Confidence tier for the alert prioritizer. Legacy points
   *  (lacking the v23.7.2 observation counters) inherit 'trusted' so
   *  they remain alertable per spec 10 + 12c. */
  confidenceLevel(p) {
    if (!p) return 'possible';
    if (p.confidenceStatus === 'trusted' || p.confidenceStatus === 'probable'
        || p.confidenceStatus === 'possible' || p.confidenceStatus === 'stale'
        || p.confidenceStatus === 'disputed') {
      return p.confidenceStatus;
    }
    const obs  = (typeof p.observationCount === 'number') ? p.observationCount
              : (typeof p.confidence === 'number') ? p.confidence : null;
    const conf = (typeof p.confirmationCount === 'number') ? p.confirmationCount
              : (typeof p.confirmedCount === 'number') ? p.confirmedCount : null;
    if ((conf != null && conf >= 3) || (obs != null && obs >= 4)) return 'trusted';
    if ((conf != null && conf >= 1) || (obs != null && obs >= 2)) return 'probable';
    // Legacy point: no counters, but it exists in the road memory —
    // treat as trusted-by-default so it stays alertable.
    if (obs == null && conf == null) return 'trusted';
    return 'possible';
  },

  /** Is the observation laterally inside the active route's corridor?
   *  Returns false when no routeCoords are available (free-drive). */
  isOnRouteCorridor(p, routeCoords, corridorM) {
    if (!Array.isArray(routeCoords) || routeCoords.length < 2) return false;
    return Corridor.isPointInsideRouteCorridor(p,
      { type: 'LineString', coordinates: routeCoords }, corridorM);
  },

  /** Primary alert-candidate engine.
   *
   *  Evaluates the global pool with proximity → ahead-of-driver →
   *  heading-compatibility → confidence. Route corridor (when
   *  available) is added as additive context: matched points are
   *  flagged onRoute=true and get a slightly extended lookahead, but
   *  off-route candidates that pass the primary gate are NEVER
   *  dropped here. Caller decides whether to alert; this returns the
   *  ordered candidate list.
   *
   *  Returns: [{ point, distM, ahead, onRoute, confidence }]
   *           sorted by ahead/onRoute/distance. */
  liveCandidates(userState, routeCoords) {
    const out = [];
    if (!userState || userState.lat == null || userState.lng == null) return out;
    const pool = Observations.globalPool();
    const speedKmh = userState.speedKmh || 0;
    const lookaheadM = Observations.forwardLookaheadM(speedKmh);
    const corridorM  = Observations.corridorWidthM(speedKmh, userState.accuracy);
    const heading    = (userState.heading != null) ? userState.heading
                     : Observations.effectiveHeading();
    const headingReliable = Speed.isHeadingReliable(speedKmh);
    for (const p of pool) {
      const distKm = Utils.distKm(userState, p);
      if (distKm > ObservationsConfig.MAX_SCAN_RADIUS_KM) continue;
      const distM = distKm * 1000;
      const ahead = Observations.isAhead(p, userState.lat, userState.lng,
                                          heading, speedKmh, distM);
      // Strong rear rejection: only when heading is reliable AND the
      // point sits well behind AND we've already passed the tolerance.
      if (!ahead && headingReliable && distM > ObservationsConfig.BEHIND_TOLERANCE_M) {
        continue;
      }
      // Directional suppression: only on clear opposite. Bidirectional
      // and legacy null-heading points always survive this gate.
      if (!Observations.headingCompatible(p, heading, speedKmh)) {
        continue;
      }
      const onRoute = Observations.isOnRouteCorridor(p, routeCoords, corridorM);
      // Forward lookahead. Route candidates get a generous extension
      // (route corridor is additive: it must NEVER shorten anyone's
      // reach). Free-drive candidates use the speed-tuned lookahead
      // for live alerts but the caller still receives anything inside
      // the 5 km scan envelope for ordering / next-ahead UI.
      const effectiveLookahead = onRoute
        ? Math.max(lookaheadM * 2, 800)
        : lookaheadM;
      const confidence = Observations.confidenceLevel(p);
      out.push({
        point: p,
        distM,
        ahead,
        onRoute,
        confidence,
        withinLookahead: distM <= effectiveLookahead,
      });
    }
    out.sort((a, b) => {
      if (a.ahead !== b.ahead)       return a.ahead   ? -1 : 1;
      if (a.onRoute !== b.onRoute)   return a.onRoute ? -1 : 1;
      return a.distM - b.distM;
    });
    return out;
  },

  /** Build a fresh user-state snapshot from State. Used by the
   *  Alerts module so it doesn't duplicate the wiring. */
  buildUserState() {
    if (!State.pos) return null;
    return {
      lat: State.pos.lat,
      lng: State.pos.lng,
      heading: Observations.effectiveHeading(),
      speedKmh: (State.speedMps || 0) * 3.6,
      avgSpeedKmh: State.avgSpeedKmh(),
      accuracy: State.accuracy,
    };
  },

  /** Estimate the count of known + trusted observations ahead of the
   *  driver, used by the small "known road detected" indicator. */
  knownAheadSummary(userState, routeCoords) {
    const cands = Observations.liveCandidates(userState, routeCoords);
    let ahead = 0, trusted = 0;
    for (const c of cands) {
      if (!c.ahead) continue;
      ahead++;
      if (c.confidence === 'trusted') trusted++;
    }
    return { ahead, trusted, isKnownRoad: ahead >= ObservationsConfig.KNOWN_ROAD_MIN_COUNT };
  },

  /** Conservative, type-aware merge guard for new captures. Returns
   *  the existing point that should absorb this new observation, or
   *  null when no safe match exists. NEVER merges across types,
   *  NEVER merges opposite-direction directional points, and NEVER
   *  deletes the old record. Caller is responsible for updating
   *  confirmedCount / lastConfirmedAt; this function only locates
   *  the merge target.
   *
   *  Defaults:
   *    radius — 18 m
   *    bearing — 25° if both points are directional with known bearings
   *
   *  When uncertain, returns null so both observations are kept
   *  (spec 11 + 12d). */
  findMergeTarget(newPoint, existingPoints, opts) {
    if (!newPoint || !Array.isArray(existingPoints)) return null;
    const radiusM    = (opts && opts.radiusM)    || 18;
    const bearingDeg = (opts && opts.bearingDeg) || 25;
    const type = newPoint.type;
    for (const ex of existingPoints) {
      if (!ex || ex.type !== type) continue;
      const distM = Utils.distKm(ex, newPoint) * 1000;
      if (distM > radiusM) continue;
      // Directional / opposite-heading guard.
      if (ex.directional && newPoint.directional) {
        const eb = (ex.captureBearing != null) ? ex.captureBearing : ex.heading;
        const nb = (newPoint.captureBearing != null) ? newPoint.captureBearing : newPoint.heading;
        if (eb != null && nb != null) {
          const diff = Speed.angleDiff(eb, nb);
          if (diff > bearingDeg) continue;
          // Hard-opposite => never merge.
          if (diff >= 135) continue;
        }
      }
      // speed_change with different speedLimit => never merge (caller
      // handles pending-speed-change promotion separately).
      if (type === 'speed_change') {
        const exLim = (typeof ex.speedLimit === 'number') ? ex.speedLimit : ex.limit;
        const npLim = (typeof newPoint.speedLimit === 'number') ? newPoint.speedLimit : newPoint.limit;
        if (exLim != null && npLim != null && exLim !== npLim) continue;
      }
      return ex;
    }
    return null;
  },

  /** Additive backward-compatible migration. Touches each point in
   *  the global pool and fills the new spec fields when missing. Never
   *  overwrites an existing value, never deletes. Returns count of
   *  records that gained at least one new field. */
  migrateAdditive(points) {
    if (!Array.isArray(points)) return 0;
    let touched = 0;
    for (const p of points) {
      if (!p || typeof p !== 'object') continue;
      let changed = false;
      // Detect a true legacy record (one captured before any of the
      // v23.7.2 observation counters or status existed). The spec
      // mandates that these stay alertable after migration.
      const isLegacy = (p.observationCount === undefined)
                    && (p.confirmationCount === undefined)
                    && (p.confidenceStatus === undefined);
      // confirmedCount — alias of v23.7.2 confirmationCount, or
      // derived from legacy confidence (each merge bumped confidence
      // so confidence-1 represents prior re-confirmations). Legacy
      // points get a minimum of 1 per spec 12c.
      if (p.confirmedCount === undefined) {
        if (typeof p.confirmationCount === 'number') p.confirmedCount = p.confirmationCount;
        else if (typeof p.confidence === 'number')   p.confirmedCount = Math.max(1, p.confidence - 1);
        else                                         p.confirmedCount = isLegacy ? 1 : 0;
        changed = true;
      }
      // confidenceStatus baseline — legacy points get 'trusted' so
      // they remain alertable. Speed_change records already had this
      // set by the v23.7.2 migration so we never overwrite.
      if (p.confidenceStatus === undefined && isLegacy) {
        p.confidenceStatus = 'trusted';
        changed = true;
      }
      if (p.firstSeenAt === undefined) {
        p.firstSeenAt = p.createdAt || null;
        changed = true;
      }
      if (p.lastSeenAt === undefined) {
        p.lastSeenAt = p.lastObservedAt || p.updatedAt || p.createdAt || null;
        changed = true;
      }
      if (p.lastConfirmedAt === undefined) {
        p.lastConfirmedAt = p.lastConfirmedAt || null;
        changed = true;
      }
      // heading — alias of captureBearing. Legacy may have neither;
      // leave null and let bidirectional take over below.
      if (p.heading === undefined) {
        p.heading = (typeof p.captureBearing === 'number') ? p.captureBearing : null;
        changed = true;
      }
      // directional — keep existing if set, default to false (legacy
      // null-bearing points should NOT be assumed directional).
      if (p.directional === undefined) {
        p.directional = false;
        changed = true;
      }
      // bidirectional — true when no usable bearing OR explicitly
      // flagged. Null/missing heading => bidirectional (spec 12c).
      if (p.bidirectional === undefined) {
        const hasBearing = (typeof p.captureBearing === 'number') || (typeof p.heading === 'number');
        p.bidirectional = !hasBearing;
        changed = true;
      }
      if (p.source === undefined) {
        p.source = 'capture';
        changed = true;
      }
      if (p.routeTags === undefined) {
        p.routeTags = Array.isArray(p.sourceDestinationIds)
          ? p.sourceDestinationIds.slice()
          : (p.destId ? [p.destId] : []);
        changed = true;
      }
      if (changed) touched++;
    }
    return touched;
  },
};

/* ============================================================
   0f. ROUTE MEMORY — v22.98
   Learn successful OSRM routes per destination + restore them
   instantly on re-selection if the origin matches roughly. The
   restore is a UX fast-start — fresh deviation-triggered reroutes
   still replace stored geometry whenever the live path diverges.
   localStorage only; no network.
   ============================================================ */
const RouteMemory = {
  MAX_ENTRIES: 20,
  TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  ORIGIN_MATCH_KM: 2,               // current pos must be within this of stored origin to match

  /** Read all stored entries. Returns []. */
  _all() {
    try {
      const raw = localStorage.getItem(Storage.KEYS.learnedRoutes);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  },

  _write(arr) {
    try {
      localStorage.setItem(Storage.KEYS.learnedRoutes, JSON.stringify(arr));
      return true;
    } catch (e) {
      logEvent('ROUTE', 'learned route storage write failed: ' + (e && e.message || e), 'err');
      return false;
    }
  },

  /** Sort newest-first, drop expired, cap at MAX_ENTRIES. */
  _prune(arr) {
    const now = Date.now();
    const sorted = arr.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const fresh = sorted.filter(r => r && r.timestamp && (now - r.timestamp) <= RouteMemory.TTL_MS);
    return fresh.slice(0, RouteMemory.MAX_ENTRIES);
  },

  /** Persist a successful route. Replaces any existing entry for the
   *  same destId (newer wins). originPos = the GPS pos at fetch time.
   *  v22.104: new entries start with confirmed=false. They only become
   *  confirmed once RouteMemory.confirmLearnedRoute(destId) is called
   *  (on arrival at the destination). findLearnedRoute returns only
   *  confirmed entries, so unconfirmed routes are never auto-restored. */
  saveLearnedRoute(destId, destName, geometry, distance, duration, originPos) {
    if (!destId || !geometry || !originPos) return;
    let arr = RouteMemory._all();
    const wasReplacement = arr.some(r => r.destId === destId);
    arr = arr.filter(r => r.destId !== destId);
    arr.unshift({
      destId,
      destName: String(destName || ''),
      geometry,
      distance: typeof distance === 'number' ? distance : 0,
      duration: typeof duration === 'number' ? duration : 0,
      timestamp: Date.now(),
      originLat: originPos.lat,
      originLng: originPos.lng,
      confirmed: false, // v22.104
    });
    arr = RouteMemory._prune(arr);
    RouteMemory._write(arr);
    const km = (distance / 1000).toFixed(0);
    logEvent('ROUTE', `learned route ${wasReplacement ? 'replaced' : 'saved'} (pending): ${destName || destId} (${km}km)`, 'ok');
  },

  /** v22.104: flip confirmed=true on the entry for this destId. Called
   *  when the user actually reaches the destination — proving the
   *  proposed route was the one they drove. Only confirmed routes are
   *  returned by findLearnedRoute, so this is what gates re-use. */
  confirmLearnedRoute(destId) {
    if (!destId) return false;
    const arr = RouteMemory._all();
    const entry = arr.find(r => r && r.destId === destId);
    if (!entry) {
      logEvent('ROUTE', `confirm skipped — no stored route for ${destId}`);
      return false;
    }
    if (entry.confirmed) return false; // idempotent
    entry.confirmed = true;
    entry.confirmedAt = Date.now();
    RouteMemory._write(arr);
    logEvent('ROUTE', `learned route confirmed: ${entry.destName || destId}`, 'ok');
    return true;
  },

  /** Lookup a learned route. Match requires:
   *    - same destId
   *    - timestamp within TTL_MS
   *    - current pos within ORIGIN_MATCH_KM of stored origin
   *    - v22.104: entry is confirmed (user has driven it to arrival)
   *  Returns the entry or null. Logs mismatch reasons. */
  findLearnedRoute(destId, currentPos) {
    if (!destId || !currentPos) return null;
    const arr = RouteMemory._all();
    const now = Date.now();
    for (const r of arr) {
      if (!r || r.destId !== destId) continue;
      if (!r.timestamp || (now - r.timestamp) > RouteMemory.TTL_MS) {
        logEvent('ROUTE', `learned route expired for "${r.destName || destId}"`);
        continue;
      }
      if (typeof r.originLat !== 'number' || typeof r.originLng !== 'number') continue;
      const km = Utils.distKm({ lat: r.originLat, lng: r.originLng }, currentPos);
      if (km > RouteMemory.ORIGIN_MATCH_KM) {
        logEvent('ROUTE', `learned route mismatch: origin ${km.toFixed(1)}km from current pos (limit ${RouteMemory.ORIGIN_MATCH_KM}km)`);
        continue;
      }
      if (!r.confirmed) {
        logEvent('ROUTE', `learned route not confirmed yet for "${r.destName || destId}" — fetching fresh`);
        continue;
      }
      return r;
    }
    return null;
  },

  /** Drop expired entries from storage. Safe to call repeatedly; no-op
   *  if nothing changes. Called on app boot. */
  cleanupExpiredRoutes() {
    const arr = RouteMemory._all();
    const pruned = RouteMemory._prune(arr);
    if (pruned.length !== arr.length) {
      RouteMemory._write(pruned);
      logEvent('ROUTE', `cleaned up ${arr.length - pruned.length} expired learned routes`);
    }
  },

  /** Convenience wrapper: same as saveLearnedRoute but logs as
   *  "replaced" — called from the reroute success path. */
  replaceLearnedRoute(destId, destName, geometry, distance, duration, originPos) {
    RouteMemory.saveLearnedRoute(destId, destName, geometry, distance, duration, originPos);
  },
};

/* ============================================================
   0f. VALIDATOR — v22.104 (Phase 0)
   Defensive schema validation for imported / restored / JSON-edited
   data. Never destroys road memory silently — produces a report the
   user confirms before overwrite. Salvages id-less-but-valid points
   by minting a new id; truncates over-long strings with a warning;
   drops genuinely invalid points (bad coords, missing critical
   fields) only after the user has confirmed.
   ============================================================ */
const ValidatorConfig = {
  MAX_NAME_LEN: 200,
  MAX_NOTE_LEN: 1000,
  MAX_LABEL_LEN: 200,
  MIN_LIMIT_KMH: 5,
  MAX_LIMIT_KMH: 250,
  KNOWN_SIDES: ['left', 'right'],
  KNOWN_STATUSES: ['active', 'no'],
  KNOWN_TYPES: ['speed_camera', 'speed_change', 'redlight', 'bump', 'petrol', 'service', 'parking', 'rest', 'hazard', 'other'],
  MAX_WARNINGS_REPORTED: 5,
};

const Validator = {
  /** Top-level entry point. `parsed` may be the full export shape
   *  ({ data, settings, trips }) OR a bare State.data object. Returns
   *  { ok, report, sanitized } where:
   *    - ok           : true if at least the shape was recognizable
   *    - report       : human-readable counts + sample warnings
   *    - sanitized    : { data, settings, trips } with valid rows kept
   *  Caller (UI) is responsible for showing the report and prompting
   *  the user to confirm before assigning sanitized → State.* */
  validateImport(parsed) {
    const warnings = [];
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        report: 'Not a JSON object',
        warnings: ['root is not an object'],
        sanitized: null,
      };
    }

    // Normalize: accept either { data: {...}, settings, trips } or a
    // bare data object with .points/.destinations.
    let rawData, rawSettings, rawTrips;
    if (parsed.data && (Array.isArray(parsed.data.points) || Array.isArray(parsed.data.destinations))) {
      rawData = parsed.data;
      rawSettings = parsed.settings || null;
      rawTrips = Array.isArray(parsed.trips) ? parsed.trips : null;
    } else if (Array.isArray(parsed.points) || Array.isArray(parsed.destinations)) {
      rawData = parsed;
      rawSettings = null;
      rawTrips = null;
    } else {
      return {
        ok: false,
        report: 'Missing data.points / data.destinations',
        warnings: ['shape not recognized'],
        sanitized: null,
      };
    }

    const destsIn = Array.isArray(rawData.destinations) ? rawData.destinations : [];
    const pointsIn = Array.isArray(rawData.points) ? rawData.points : [];
    const tripsIn = Array.isArray(rawTrips) ? rawTrips : [];

    const destsOut = [];
    let destsDropped = 0;
    for (const d of destsIn) {
      const res = Validator._validateDestination(d, warnings);
      if (res) destsOut.push(res); else destsDropped++;
    }

    const pointsOut = [];
    let pointsDropped = 0;
    for (const p of pointsIn) {
      const res = Validator._validatePoint(p, warnings);
      if (res) pointsOut.push(res); else pointsDropped++;
    }

    const tripsOut = [];
    let tripsDropped = 0;
    for (const t of tripsIn) {
      const res = Validator._validateTrip(t, warnings);
      if (res) tripsOut.push(res); else tripsDropped++;
    }

    // Settings: drop unknown shape, keep object-typed payload as-is.
    let settingsApplied = false;
    let sanitizedSettings = null;
    if (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
      sanitizedSettings = rawSettings;
      settingsApplied = true;
    } else if (rawSettings != null) {
      warnings.push('settings skipped — not an object');
    }

    const cap = ValidatorConfig.MAX_WARNINGS_REPORTED;
    const sampleWarnings = warnings.slice(0, cap);
    const more = warnings.length > cap ? `\n…and ${warnings.length - cap} more` : '';

    const report = [
      `Destinations: kept ${destsOut.length} of ${destsIn.length} (dropped ${destsDropped})`,
      `Points:       kept ${pointsOut.length} of ${pointsIn.length} (dropped ${pointsDropped})`,
      `Trips:        kept ${tripsOut.length} of ${tripsIn.length} (dropped ${tripsDropped})`,
      `Settings:     ${settingsApplied ? 'applied' : 'skipped'}`,
      sampleWarnings.length
        ? `\nFirst ${sampleWarnings.length} warning${sampleWarnings.length === 1 ? '' : 's'}:\n  - ` + sampleWarnings.join('\n  - ') + more
        : '\nNo warnings',
    ].join('\n');

    return {
      ok: true,
      report,
      warnings,
      sanitized: {
        data: {
          ...rawData,
          destinations: destsOut,
          points: pointsOut,
        },
        settings: sanitizedSettings,
        trips: tripsOut,
      },
      counts: {
        destsIn: destsIn.length, destsKept: destsOut.length, destsDropped,
        pointsIn: pointsIn.length, pointsKept: pointsOut.length, pointsDropped,
        tripsIn: tripsIn.length, tripsKept: tripsOut.length, tripsDropped,
        settingsApplied,
      },
    };
  },

  _validateDestination(d, warnings) {
    if (!d || typeof d !== 'object') { warnings.push('destination dropped — not an object'); return null; }
    const lat = Validator._coord(d.lat);
    const lng = Validator._coord(d.lng);
    if (lat == null || lng == null) {
      warnings.push(`destination "${Validator._safeShort(d.name)}" dropped — invalid coordinates`);
      return null;
    }
    const out = { ...d, lat, lng };
    if (!out.id || typeof out.id !== 'string') {
      out.id = Utils.uid();
      warnings.push(`destination at ${lat.toFixed(4)},${lng.toFixed(4)} missing id; generated ${out.id}`);
    }
    out.name = Validator._truncString(out.name, ValidatorConfig.MAX_NAME_LEN, `destination ${out.id} name`, warnings) || '';
    if (out.createdAt && !Validator._isIsoLike(out.createdAt)) {
      warnings.push(`destination ${out.id} createdAt invalid — reset`);
      out.createdAt = new Date().toISOString();
    }
    if (out.updatedAt && !Validator._isIsoLike(out.updatedAt)) {
      warnings.push(`destination ${out.id} updatedAt invalid — reset`);
      out.updatedAt = new Date().toISOString();
    }
    if (out.routePointRefs && !Array.isArray(out.routePointRefs)) {
      warnings.push(`destination ${out.id} routePointRefs not array — reset`);
      out.routePointRefs = [];
    }
    return out;
  },

  _validatePoint(p, warnings) {
    if (!p || typeof p !== 'object') { warnings.push('point dropped — not an object'); return null; }
    const lat = Validator._coord(p.lat);
    const lng = Validator._coord(p.lng);
    if (lat == null || lng == null) {
      warnings.push(`point "${Validator._safeShort(p.name)}" dropped — invalid coordinates`);
      return null;
    }
    const out = { ...p, lat, lng };
    if (!out.id || typeof out.id !== 'string') {
      const newId = Utils.uid();
      warnings.push(`point at ${lat.toFixed(4)},${lng.toFixed(4)} missing id; generated ${newId}`);
      out.id = newId;
    }
    if (out.type && typeof out.type === 'string') {
      if (!ValidatorConfig.KNOWN_TYPES.includes(out.type)) {
        warnings.push(`point ${out.id} unknown type "${out.type}" — accepted (display will fall back)`);
      }
    } else {
      warnings.push(`point ${out.id} missing type — set to "other"`);
      out.type = 'other';
    }
    if (out.side != null) {
      if (typeof out.side !== 'string' || !ValidatorConfig.KNOWN_SIDES.includes(out.side)) {
        warnings.push(`point ${out.id} invalid side "${out.side}" — cleared`);
        delete out.side;
      }
    }
    if (out.status != null) {
      if (typeof out.status !== 'string' || !ValidatorConfig.KNOWN_STATUSES.includes(out.status)) {
        warnings.push(`point ${out.id} invalid status "${out.status}" — reset to "active"`);
        out.status = 'active';
      }
    }
    const limit = Validator._speedLimit(out.limit);
    if (out.limit != null && limit == null) {
      warnings.push(`point ${out.id} invalid speed limit "${out.limit}" — cleared`);
      delete out.limit;
    } else if (limit != null) {
      out.limit = limit;
    }
    const speedLimit = Validator._speedLimit(out.speedLimit);
    if (out.speedLimit != null && speedLimit == null) {
      warnings.push(`point ${out.id} invalid speedLimit "${out.speedLimit}" — cleared`);
      delete out.speedLimit;
    } else if (speedLimit != null) {
      out.speedLimit = speedLimit;
    }
    out.name = Validator._truncString(out.name, ValidatorConfig.MAX_NAME_LEN, `point ${out.id} name`, warnings) || '';
    if (out.note != null) {
      out.note = Validator._truncString(out.note, ValidatorConfig.MAX_NOTE_LEN, `point ${out.id} note`, warnings) || '';
    }
    if (out.label != null) {
      out.label = Validator._truncString(out.label, ValidatorConfig.MAX_LABEL_LEN, `point ${out.id} label`, warnings) || '';
    }
    if (out.createdAt && !Validator._isIsoLike(out.createdAt)) {
      warnings.push(`point ${out.id} createdAt invalid — reset`);
      out.createdAt = new Date().toISOString();
    }
    if (out.updatedAt && !Validator._isIsoLike(out.updatedAt)) {
      warnings.push(`point ${out.id} updatedAt invalid — reset`);
      out.updatedAt = new Date().toISOString();
    }
    return out;
  },

  _validateTrip(t, warnings) {
    if (!t || typeof t !== 'object') { warnings.push('trip dropped — not an object'); return null; }
    if (!t.startedAt || !Validator._isIsoLike(t.startedAt)) {
      warnings.push('trip dropped — missing/invalid startedAt');
      return null;
    }
    const out = { ...t };
    if (out.endedAt && !Validator._isIsoLike(out.endedAt)) {
      warnings.push('trip endedAt invalid — cleared');
      delete out.endedAt;
    }
    if (typeof out.distanceKm !== 'number' || !isFinite(out.distanceKm) || out.distanceKm < 0) out.distanceKm = 0;
    if (typeof out.maxSpeed !== 'number' || !isFinite(out.maxSpeed) || out.maxSpeed < 0) out.maxSpeed = 0;
    return out;
  },

  _coord(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) return null;
    if (n < -180 || n > 180) return null; // lat is tighter but lng covers both
    return n;
  },

  _speedLimit(v) {
    if (v == null) return null;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) return null;
    if (n < ValidatorConfig.MIN_LIMIT_KMH || n > ValidatorConfig.MAX_LIMIT_KMH) return null;
    return n;
  },

  _isIsoLike(s) {
    if (typeof s !== 'string') return false;
    const d = new Date(s);
    return !isNaN(d.getTime());
  },

  _truncString(s, max, label, warnings) {
    if (s == null) return s;
    const str = String(s);
    if (str.length <= max) return str;
    warnings.push(`${label} truncated to ${max} chars`);
    return str.slice(0, max);
  },

  _safeShort(s) {
    if (s == null) return '?';
    return String(s).slice(0, 40);
  },
};

/* ============================================================
   0g. STORAGE INVENTORY — v23.x (Phase 2a, safety net)
   Read-only observability + local snapshot creation around the
   existing localStorage layout. NEVER mutates road memory.
   No schemaVersion is written; no migration is run; the existing
   Storage / Backup / Migration modules are not modified.

   Public surface:
     StorageInventory.inventoryReport()      — log [STORAGE] inventory
     StorageInventory.detectSchema(data)     — return 0|1, no write
     StorageInventory.validateRoadMemory(d)  — return {ok, warnings, ...}
     StorageInventory.routeGeometryReport()  — log size of learnedRoutes
     StorageInventory.createSnapshot()       — write a safety snapshot
     StorageInventory.listSnapshots()        — array of {key, ts, bytes}
     StorageInventory.validateSnapshot(key)  — return {ok, errors, parsed}
     StorageInventory.restoreSnapshot(k,o)   — stubbed manual restore
     StorageInventory.pruneSnapshots(retain) — keep newest N

   All log lines use one of the prefixes the spec mandates:
     [STORAGE]            general inventory / schema / route warnings
     [STORAGE-VALIDATION] corruption-report findings
     [STORAGE-SNAPSHOT]   snapshot create / prune / read-back
     [STORAGE-QUOTA]      quota estimates and quota failures
   ============================================================ */
const StorageInventoryConfig = {
  SNAPSHOT_PREFIX: 'roadalert:migrationSnapshot:', // explicitly outside roadAlert.v22.* namespace
  SNAPSHOT_RETAIN: 3,
  QUOTA_TYPICAL_BYTES: 5 * 1024 * 1024, // 5 MB — typical browser limit
  QUOTA_WARN_BYTES: 4 * 1024 * 1024,    // warn at 80% of typical
  ROUTE_GEOMETRY_WARN_BYTES: 256 * 1024, // 256 KB
};

const StorageInventory = {
  /** Best-effort UTF-16 byte count for a localStorage value. localStorage
   *  stores DOMString (UTF-16) so length * 2 is the safe upper bound. */
  _bytesOf(value) {
    if (value == null) return 0;
    return String(value).length * 2;
  },

  /** All localStorage keys + their byte sizes. Includes keys we don't own
   *  so the report can surface foreign tenants. */
  _allKeyBytes() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k == null) continue;
        const v = localStorage.getItem(k);
        out.push({ key: k, bytes: StorageInventory._bytesOf(k) + StorageInventory._bytesOf(v) });
      }
    } catch (e) {
      logEvent('STORAGE', '[STORAGE] enumerate failed: ' + (e && e.message || e), 'err');
    }
    return out;
  },

  /** True if the key belongs to this app (any roadAlert.* or roadalert:*). */
  _isAppKey(k) {
    if (typeof k !== 'string') return false;
    return k.indexOf('roadAlert.') === 0 || k.indexOf('roadalert:') === 0;
  },

  /** Section 1 — inventory report. Logs total + per-key sizes + flags
   *  unknown app keys. Returns the same structure for callers/UI. */
  inventoryReport() {
    const all = StorageInventory._allKeyBytes();
    const totalBytes = all.reduce((s, e) => s + e.bytes, 0);

    const known = new Set(Object.values(Storage.KEYS));
    // Also recognize the well-known one-shot flag keys + snapshots
    const knownExtras = [
      'roadAlert.v22.3.orphansMigrated',
      'roadAlert.v22.64.navModeDefault',
      'roadAlert.v22.69.navModeRefresh',
      'roadAlert.v22.91.speedPointsMigrated',
    ];
    knownExtras.forEach(k => known.add(k));

    const appKeys = all.filter(e => StorageInventory._isAppKey(e.key));
    const snapshotKeys = appKeys.filter(e => e.key.indexOf(StorageInventoryConfig.SNAPSHOT_PREFIX) === 0);
    const otherAppKeys = appKeys.filter(e => e.key.indexOf(StorageInventoryConfig.SNAPSHOT_PREFIX) !== 0);
    const foreignKeys = all.filter(e => !StorageInventory._isAppKey(e.key));

    const unknownAppKeys = otherAppKeys.filter(e => !known.has(e.key));
    const snapshotBytes = snapshotKeys.reduce((s, e) => s + e.bytes, 0);
    const knownBytes = otherAppKeys.reduce((s, e) => s + e.bytes, 0);
    const foreignBytes = foreignKeys.reduce((s, e) => s + e.bytes, 0);

    const top = appKeys.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5);

    logEvent('STORAGE', `[STORAGE] inventory · total ${StorageInventory._fmtBytes(totalBytes)} · app ${StorageInventory._fmtBytes(knownBytes)} · snapshots ${StorageInventory._fmtBytes(snapshotBytes)} · foreign ${StorageInventory._fmtBytes(foreignBytes)}`);
    for (const e of top) {
      logEvent('STORAGE', `[STORAGE] inventory · ${e.key} = ${StorageInventory._fmtBytes(e.bytes)}`);
    }
    if (unknownAppKeys.length) {
      logEvent('STORAGE', `[STORAGE] inventory · ${unknownAppKeys.length} unknown app-namespaced key(s): ` +
        unknownAppKeys.map(e => e.key).slice(0, 5).join(', '), 'err');
    }
    if (totalBytes > StorageInventoryConfig.QUOTA_WARN_BYTES) {
      logEvent('STORAGE-QUOTA', `[STORAGE-QUOTA] total ${StorageInventory._fmtBytes(totalBytes)} exceeds warn threshold ${StorageInventory._fmtBytes(StorageInventoryConfig.QUOTA_WARN_BYTES)}`, 'err');
    }

    return {
      totalBytes,
      knownBytes,
      snapshotBytes,
      foreignBytes,
      keys: all,
      appKeys,
      snapshotKeys,
      unknownAppKeys,
      foreignKeys,
      topByBytes: top,
    };
  },

  _fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  },

  /** Section 2 — schema detection, READ-ONLY. Returns:
   *    0 — pre-v22.96 legacy: points carry destId; destinations have no routePointRefs.
   *    1 — post-v22.96 global store: destinations carry routePointRefs[].
   *  Does NOT write any schemaVersion field anywhere. */
  detectSchema(data) {
    let schema = 0;
    try {
      if (data && Array.isArray(data.destinations)) {
        const anyRefs = data.destinations.some(d => Array.isArray(d && d.routePointRefs));
        if (anyRefs) schema = 1;
      }
      const migratedAt = localStorage.getItem(Storage.KEYS.migrationCompletedAt);
      if (migratedAt) schema = 1; // migration timestamp present → migrated
    } catch (e) {
      logEvent('STORAGE', '[STORAGE] schema detect threw: ' + (e && e.message || e), 'err');
    }
    logEvent('STORAGE', `[STORAGE] schema detected: ${schema}${schema === 0 ? ' (legacy, pre-v22.96)' : ' (global store, v22.96+)'}`);
    return schema;
  },

  /** Section 3 — corruption detection, REPORT-ONLY. Invalid records are
   *  recorded in `warnings[]`. The data is NEVER mutated. Caller decides
   *  what to do with the report. */
  validateRoadMemory(data) {
    const warnings = [];
    const errors = [];
    let pointsValid = 0, pointsInvalid = 0;
    let destsValid = 0, destsInvalid = 0;
    let danglingRefs = 0;
    let duplicatePointIds = 0;
    let duplicateDestIds = 0;

    if (!data || typeof data !== 'object') {
      errors.push('road-memory is not an object');
      logEvent('STORAGE-VALIDATION', '[STORAGE-VALIDATION] report · road-memory is not an object', 'err');
      return { ok: false, warnings, errors, stats: {} };
    }

    const points = Array.isArray(data.points) ? data.points : [];
    const dests = Array.isArray(data.destinations) ? data.destinations : [];

    // Duplicate / missing ids on points
    const seenPointIds = new Set();
    for (const p of points) {
      if (!p || typeof p !== 'object') { pointsInvalid++; warnings.push('point: not an object'); continue; }
      if (!p.id || typeof p.id !== 'string') { warnings.push('point at ' + (p.lat) + ',' + (p.lng) + ' missing/non-string id'); pointsInvalid++; continue; }
      if (seenPointIds.has(p.id)) { duplicatePointIds++; warnings.push('point ' + p.id + ' duplicate id'); }
      else seenPointIds.add(p.id);

      // Coords
      const lat = (typeof p.lat === 'number') ? p.lat : null;
      const lng = (typeof p.lng === 'number') ? p.lng : null;
      if (lat == null || !isFinite(lat) || lat < -90 || lat > 90) {
        warnings.push('point ' + p.id + ' invalid lat: ' + p.lat); pointsInvalid++; continue;
      }
      if (lng == null || !isFinite(lng) || lng < -180 || lng > 180) {
        warnings.push('point ' + p.id + ' invalid lng: ' + p.lng); pointsInvalid++; continue;
      }

      // Timestamps
      if (p.createdAt && !StorageInventory._isIsoLike(p.createdAt)) warnings.push('point ' + p.id + ' invalid createdAt');
      if (p.updatedAt && !StorageInventory._isIsoLike(p.updatedAt)) warnings.push('point ' + p.id + ' invalid updatedAt');

      // Type / side / status enums
      if (p.type != null && typeof p.type === 'string' && !ValidatorConfig.KNOWN_TYPES.includes(p.type)) {
        warnings.push('point ' + p.id + ' unknown type: ' + p.type);
      }
      if (p.side != null && !ValidatorConfig.KNOWN_SIDES.includes(p.side)) {
        warnings.push('point ' + p.id + ' invalid side: ' + p.side);
      }
      if (p.status != null && !ValidatorConfig.KNOWN_STATUSES.includes(p.status)) {
        warnings.push('point ' + p.id + ' invalid status: ' + p.status);
      }
      pointsValid++;
    }

    // Duplicate / missing ids on destinations
    const seenDestIds = new Set();
    for (const d of dests) {
      if (!d || typeof d !== 'object') { destsInvalid++; warnings.push('destination: not an object'); continue; }
      if (!d.id || typeof d.id !== 'string') { warnings.push('destination at ' + (d.lat) + ',' + (d.lng) + ' missing/non-string id'); destsInvalid++; continue; }
      if (seenDestIds.has(d.id)) { duplicateDestIds++; warnings.push('destination ' + d.id + ' duplicate id'); }
      else seenDestIds.add(d.id);
      const lat = (typeof d.lat === 'number') ? d.lat : null;
      const lng = (typeof d.lng === 'number') ? d.lng : null;
      if (lat == null || lat < -90 || lat > 90) { warnings.push('destination ' + d.id + ' invalid lat'); destsInvalid++; continue; }
      if (lng == null || lng < -180 || lng > 180) { warnings.push('destination ' + d.id + ' invalid lng'); destsInvalid++; continue; }
      destsValid++;

      // Dangling routePointRefs
      if (Array.isArray(d.routePointRefs)) {
        for (const ref of d.routePointRefs) {
          if (!seenPointIds.has(ref)) { danglingRefs++; warnings.push('destination ' + d.id + ' references missing point ' + ref); }
        }
      }
    }

    const ok = errors.length === 0;
    const stats = {
      pointsTotal: points.length, pointsValid, pointsInvalid,
      destsTotal: dests.length, destsValid, destsInvalid,
      duplicatePointIds, duplicateDestIds, danglingRefs,
      warningCount: warnings.length,
    };

    const summary = `[STORAGE-VALIDATION] report · ${pointsValid}/${points.length} points ok, ${destsValid}/${dests.length} dests ok, ${duplicatePointIds} dup-point-ids, ${duplicateDestIds} dup-dest-ids, ${danglingRefs} dangling refs, ${warnings.length} warnings`;
    logEvent('STORAGE-VALIDATION', summary, warnings.length ? 'err' : 'ok');
    // First 5 warnings only — keep the log usable
    for (const w of warnings.slice(0, 5)) {
      logEvent('STORAGE-VALIDATION', '[STORAGE-VALIDATION] ' + w);
    }
    return { ok, warnings, errors, stats };
  },

  _isIsoLike(s) {
    if (typeof s !== 'string') return false;
    const d = new Date(s);
    return !isNaN(d.getTime());
  },

  /** Section 4 — quota safety. Estimate total bytes used by ALL keys. */
  estimateUsageBytes() {
    return StorageInventory._allKeyBytes().reduce((s, e) => s + e.bytes, 0);
  },

  /** Section 6 helper — write with read-back verification. Used ONLY by
   *  the snapshot path; routine GPS/capture writes still go through
   *  Storage.save and are NOT slowed down. Returns {ok, error}. */
  _writeWithReadback(key, serialized) {
    try {
      localStorage.setItem(key, serialized);
    } catch (e) {
      const name = e && e.name || '';
      if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        logEvent('STORAGE-QUOTA', '[STORAGE-QUOTA] quota exceeded writing ' + key, 'err');
        return { ok: false, error: 'quota_exceeded' };
      }
      logEvent('STORAGE-SNAPSHOT', '[STORAGE-SNAPSHOT] write threw: ' + (e && e.message || e), 'err');
      return { ok: false, error: 'write_failed' };
    }
    // Read-back — confirm what we wrote round-tripped exactly
    let readBack;
    try { readBack = localStorage.getItem(key); }
    catch (e) {
      logEvent('STORAGE-SNAPSHOT', '[STORAGE] read-back verification failed (read threw): ' + (e && e.message || e), 'err');
      return { ok: false, error: 'readback_threw' };
    }
    if (readBack !== serialized) {
      logEvent('STORAGE-SNAPSHOT', '[STORAGE] read-back verification failed (mismatch) for ' + key, 'err');
      return { ok: false, error: 'readback_mismatch' };
    }
    return { ok: true };
  },

  /** Section 5 — create a Phase 2a local safety snapshot. Quota-aware:
   *  estimates usage first, prunes oldest snapshots if needed, never
   *  prunes live road memory. */
  createSnapshot() {
    const beforeBytes = StorageInventory.estimateUsageBytes();
    logEvent('STORAGE-QUOTA', `[STORAGE-QUOTA] pre-snapshot usage ${StorageInventory._fmtBytes(beforeBytes)}`);

    // Capture current road memory + relevant peripherals
    const payload = {
      createdAt: new Date().toISOString(),
      appVersion: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : 'unknown',
      schemaDetected: StorageInventory.detectSchema(State.data),
      data: State.data,
      settings: State.settings,
      trips: State.trips,
      learnedRoutes: Storage.load(Storage.KEYS.learnedRoutes, []),
    };
    const serialized = JSON.stringify(payload);
    const snapshotBytes = StorageInventory._bytesOf(serialized);

    // Quota gate — proactively prune oldest snapshots if we're near limit
    const projectedTotal = beforeBytes + snapshotBytes;
    if (projectedTotal > StorageInventoryConfig.QUOTA_WARN_BYTES) {
      logEvent('STORAGE-QUOTA', `[STORAGE-QUOTA] projected ${StorageInventory._fmtBytes(projectedTotal)} > warn ${StorageInventory._fmtBytes(StorageInventoryConfig.QUOTA_WARN_BYTES)} — pruning before write`);
      StorageInventory.pruneSnapshots(Math.max(1, StorageInventoryConfig.SNAPSHOT_RETAIN - 1));
    }

    const key = StorageInventoryConfig.SNAPSHOT_PREFIX + payload.createdAt;
    const res = StorageInventory._writeWithReadback(key, serialized);
    if (!res.ok) {
      // On quota: surface a persistent warning via the log (err level)
      logEvent('STORAGE-SNAPSHOT', `[STORAGE-SNAPSHOT] create FAILED · ${res.error} · ${StorageInventory._fmtBytes(snapshotBytes)} would have pushed total to ${StorageInventory._fmtBytes(projectedTotal)}`, 'err');
      return { ok: false, error: res.error, bytes: snapshotBytes };
    }
    // Successful write — prune any beyond retention
    const pruned = StorageInventory.pruneSnapshots(StorageInventoryConfig.SNAPSHOT_RETAIN);
    const afterBytes = StorageInventory.estimateUsageBytes();
    logEvent('STORAGE-SNAPSHOT', `[STORAGE-SNAPSHOT] created ${key} · ${StorageInventory._fmtBytes(snapshotBytes)} · pruned ${pruned} older · total ${StorageInventory._fmtBytes(beforeBytes)} → ${StorageInventory._fmtBytes(afterBytes)}`, 'ok');
    return { ok: true, key, bytes: snapshotBytes, prunedCount: pruned };
  },

  /** Section 5 — list snapshots, newest first. */
  listSnapshots() {
    const all = StorageInventory._allKeyBytes();
    const snaps = all
      .filter(e => e.key.indexOf(StorageInventoryConfig.SNAPSHOT_PREFIX) === 0)
      .map(e => ({ key: e.key, ts: e.key.slice(StorageInventoryConfig.SNAPSHOT_PREFIX.length), bytes: e.bytes }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    return snaps;
  },

  /** Section 5 — prune oldest snapshots to keep `retain` newest.
   *  NEVER prunes the single most recent snapshot. NEVER touches
   *  live road memory or any non-snapshot key. */
  pruneSnapshots(retain) {
    const snaps = StorageInventory.listSnapshots();
    if (snaps.length <= retain) return 0;
    // Snaps already sorted newest first — drop indices >= retain
    let prunedCount = 0;
    for (let i = retain; i < snaps.length; i++) {
      // Defensive: never prune index 0 (most recent)
      if (i === 0) continue;
      try {
        localStorage.removeItem(snaps[i].key);
        prunedCount++;
        logEvent('STORAGE-SNAPSHOT', `[STORAGE-SNAPSHOT] pruned ${snaps[i].key}`);
      } catch (e) {
        logEvent('STORAGE-SNAPSHOT', '[STORAGE-SNAPSHOT] prune failed for ' + snaps[i].key, 'err');
      }
    }
    return prunedCount;
  },

  /** Section 7 — validate a snapshot WITHOUT applying it. */
  validateSnapshot(key) {
    let raw;
    try { raw = localStorage.getItem(key); }
    catch (e) {
      logEvent('STORAGE', '[STORAGE] restore validation failed · read threw: ' + (e && e.message || e), 'err');
      return { ok: false, error: 'read_failed' };
    }
    if (raw == null) {
      logEvent('STORAGE', '[STORAGE] restore validation failed · not found: ' + key, 'err');
      return { ok: false, error: 'not_found' };
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      logEvent('STORAGE', '[STORAGE] restore validation failed · JSON parse error: ' + (e && e.message || e), 'err');
      return { ok: false, error: 'parse_failed' };
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.data) {
      logEvent('STORAGE', '[STORAGE] restore validation failed · missing data key', 'err');
      return { ok: false, error: 'shape_invalid' };
    }
    const val = StorageInventory.validateRoadMemory(parsed.data);
    if (!val.ok) {
      logEvent('STORAGE', '[STORAGE] restore validation failed · ' + val.errors.join('; '), 'err');
      return { ok: false, error: 'data_invalid', detail: val };
    }
    logEvent('STORAGE', '[STORAGE] restore validation passed · ' + key, 'ok');
    return { ok: true, parsed, detail: val };
  },

  /** Section 7 — STUBBED manual restore. Refuses to run unless
   *  caller passes { confirm: true }. Validates first. Does NOT
   *  auto-rollback on failure. */
  restoreSnapshot(key, opts) {
    if (!opts || opts.confirm !== true) {
      logEvent('STORAGE', '[STORAGE] restore refused — pass {confirm:true} explicitly', 'err');
      return { ok: false, error: 'confirmation_required' };
    }
    const val = StorageInventory.validateSnapshot(key);
    if (!val.ok) {
      logEvent('STORAGE', '[STORAGE] restore aborted — validation failed', 'err');
      return { ok: false, error: 'validation_failed', detail: val };
    }
    const p = val.parsed;
    try {
      State.data = p.data;
      if (p.settings) State.settings = Object.assign({}, State.settings, p.settings);
      if (Array.isArray(p.trips)) State.trips = p.trips;
      State.saveData();
      State.saveSettings();
      State.saveTrips();
      if (Array.isArray(p.learnedRoutes)) {
        try { localStorage.setItem(Storage.KEYS.learnedRoutes, JSON.stringify(p.learnedRoutes)); } catch (e) {}
      }
      logEvent('STORAGE', '[STORAGE] restore applied from ' + key, 'ok');
      return { ok: true, key };
    } catch (e) {
      logEvent('STORAGE', '[STORAGE] restore apply threw: ' + (e && e.message || e), 'err');
      return { ok: false, error: 'apply_failed' };
    }
  },

  /** Section 8 — route geometry size warning. Reports the size of the
   *  RouteMemory blob without modifying it. */
  routeGeometryReport() {
    let raw = null;
    try { raw = localStorage.getItem(Storage.KEYS.learnedRoutes); }
    catch (e) {}
    const bytes = StorageInventory._bytesOf(raw);
    if (bytes === 0) {
      logEvent('STORAGE', '[STORAGE] route geometry · none stored');
      return { bytes: 0 };
    }
    const level = (bytes > StorageInventoryConfig.ROUTE_GEOMETRY_WARN_BYTES) ? 'err' : '';
    logEvent('STORAGE', `[STORAGE] route geometry · ${StorageInventory._fmtBytes(bytes)} in ${Storage.KEYS.learnedRoutes}` +
      (bytes > StorageInventoryConfig.ROUTE_GEOMETRY_WARN_BYTES ? ' (major storage contributor)' : ''), level);
    return { bytes };
  },
};

/* ============================================================
   0h. DUPLICATE DETECTOR — v23.x (Phase 2c-1c)

   STRICTLY observe-only. The detector classifies pairs of stored
   road-memory points into one of seven categories and produces a
   report. It does NOT merge, delete, repair, archive, normalize,
   or mutate any record. There is no auto-merge in this phase and
   no merge button anywhere.

   Determinism: distance is computed ONLY from each record's stored
   lat/lng. No live GPS, no State.pos, no current-fix accuracy. The
   detector produces identical output regardless of whether GPS is
   on or off.

   Manual trigger only — wired to the "🔎 Duplicates" button in
   Settings → Storage safety net. Never invoked from boot, GPS
   ticks, Settings repaints, or any background timer.

   Classification priority order (first match wins):
     1. Identical IDs                          → TRUE_DUPLICATE
     2. confidence ≥ 2 on either record        → ALREADY_COLLAPSED (silent)
     3. Different days + both have confirmations[] → LEGITIMATE_REPEAT
     4. < 60s gap + same type + same destId + ≤ 5m → SAME_PASS_DUPLICATE
        (referred to as "high-confidence duplicate candidate" in UI/logs.
         There is no merge of any kind in this phase.)
     5. Both directional + bearing diff > 25°  → DIFFERENT_CARRIAGEWAY
     6. Different destId, not linked via
        sourceDestinationIds                   → CROSS_DESTINATION
     7. Everything else                        → AMBIGUOUS
   ============================================================ */
const DuplicateDetectorConfig = {
  MAX_PAIR_RADIUS_M: 100,           // hard spatial prune before classification
  SAME_PASS_MAX_DIST_M: 5,
  SAME_PASS_MAX_TIME_MS: 60_000,
  BEARING_DIFF_THRESHOLD_DEG: 25,
};

const DuplicateDetector = {
  /** Run the scan against the supplied points array. Caller passes
   *  the static snapshot — typically State.data.points. The detector
   *  does NOT reach into State on its own.
   *
   *  Returns: { rows: [...flagged pairs...], counts: {...all 7 classes...},
   *             totalPoints, candidateCount } */
  scan(points) {
    const startMs = Date.now();
    const N = Array.isArray(points) ? points.length : 0;
    logEvent('DUP-SCAN', `[DUP-SCAN] started · ${N} points`);

    // Pre-filter: retired (status === 'no') points are excluded so the
    // report doesn't relitigate things the user already disabled. Records
    // with non-numeric coordinates are excluded (Phase 2a validation
    // would have already flagged them).
    const active = Array.isArray(points) ? points.filter(p =>
      p && p.status !== 'no' &&
      typeof p.lat === 'number' && isFinite(p.lat) &&
      typeof p.lng === 'number' && isFinite(p.lng)
    ) : [];

    // O(n²) pair scan with hard spatial prune. Acceptable for thousands of
    // points on a manual button click; grid-bucket optimisation is a
    // future phase if it ever becomes a real-world problem.
    const pairs = [];
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        const distM = DuplicateDetector._staticDistanceM(a, b);
        if (distM > DuplicateDetectorConfig.MAX_PAIR_RADIUS_M) continue;
        pairs.push({ a, b, distM });
      }
    }
    logEvent('DUP-SCAN', `[DUP-SCAN] candidates: ${pairs.length}`);

    const rows = [];
    const counts = {
      TRUE_DUPLICATE: 0,
      ALREADY_COLLAPSED: 0,
      LEGITIMATE_REPEAT: 0,
      SAME_PASS_DUPLICATE: 0,
      DIFFERENT_CARRIAGEWAY: 0,
      CROSS_DESTINATION: 0,
      AMBIGUOUS: 0,
    };

    for (const pair of pairs) {
      const row = DuplicateDetector._classify(pair.a, pair.b, pair.distM);
      counts[row.classification]++;
      // ALREADY_COLLAPSED is silent — counted but not reported as a row
      if (row.classification !== 'ALREADY_COLLAPSED') {
        rows.push(row);
      }
    }

    const summary = `[DUP-SCAN] classified: TRUE=${counts.TRUE_DUPLICATE} SAMEPASS=${counts.SAME_PASS_DUPLICATE} REPEAT=${counts.LEGITIMATE_REPEAT} CARRIAGEWAY=${counts.DIFFERENT_CARRIAGEWAY} CROSSDEST=${counts.CROSS_DESTINATION} AMBIG=${counts.AMBIGUOUS} (silent ALREADY_COLLAPSED=${counts.ALREADY_COLLAPSED})`;
    logEvent('DUP-SCAN', summary, rows.length ? 'err' : 'ok');

    // One log line per flagged pair. TRUE_DUPLICATE + SAME_PASS_DUPLICATE
    // get err-level (red, persistent in the 500-entry buffer); the rest
    // are info-level observe-only entries.
    for (const r of rows) {
      const gapStr = DuplicateDetector._formatGap(r.timeGapMs);
      const level = (r.classification === 'TRUE_DUPLICATE' || r.classification === 'SAME_PASS_DUPLICATE') ? 'err' : '';
      logEvent('DUP-SCAN', `[DUP-SCAN] ${r.classification} ${r.a.id} ↔ ${r.b.id} · ${Math.round(r.staticDistanceM)}m · Δt ${gapStr}`, level);
    }

    const elapsedMs = Date.now() - startMs;
    logEvent('DUP-SCAN', `[DUP-SCAN] done · ${elapsedMs}ms`);

    return {
      rows,
      counts,
      totalPoints: N,
      activePoints: active.length,
      candidateCount: pairs.length,
      elapsedMs,
    };
  },

  /** Apply priority rules to a single pair. First match wins. */
  _classify(a, b, distM) {
    const gap = DuplicateDetector._timeGapMs(a, b);
    const bearingDiff = DuplicateDetector._bearingDiff(a, b);

    let classification, appliedRule;

    // Rule 1 — Identical IDs
    if (a.id != null && a.id === b.id) {
      classification = 'TRUE_DUPLICATE'; appliedRule = 1;
    }
    // Rule 2 — confidence ≥ 2 on either record (already passed through merge logic)
    else if ((a.confidence || 0) >= 2 || (b.confidence || 0) >= 2) {
      classification = 'ALREADY_COLLAPSED'; appliedRule = 2;
    }
    // Rule 3 — different days AND both have non-empty confirmations[]
    else if (DuplicateDetector._dayDifferent(a, b)
             && DuplicateDetector._hasConfirmations(a)
             && DuplicateDetector._hasConfirmations(b)) {
      classification = 'LEGITIMATE_REPEAT'; appliedRule = 3;
    }
    // Rule 4 — same-pass: gap < 60s, same type, same destId, dist ≤ 5m
    else if (gap != null && gap < DuplicateDetectorConfig.SAME_PASS_MAX_TIME_MS
             && a.type === b.type
             && a.destId != null && a.destId === b.destId
             && distM <= DuplicateDetectorConfig.SAME_PASS_MAX_DIST_M) {
      classification = 'SAME_PASS_DUPLICATE'; appliedRule = 4;
    }
    // Rule 5 — both directional, bearing diff > 25°
    else if (a.directional === true && b.directional === true
             && bearingDiff != null
             && bearingDiff > DuplicateDetectorConfig.BEARING_DIFF_THRESHOLD_DEG) {
      classification = 'DIFFERENT_CARRIAGEWAY'; appliedRule = 5;
    }
    // Rule 6 — different destId, not linked via sourceDestinationIds
    else if (a.destId !== b.destId && !DuplicateDetector._linkedBySourceDests(a, b)) {
      classification = 'CROSS_DESTINATION'; appliedRule = 6;
    }
    // Rule 7 — everything else
    else {
      classification = 'AMBIGUOUS'; appliedRule = 7;
    }

    return {
      classification,
      appliedRule,
      a: DuplicateDetector._snapshot(a),
      b: DuplicateDetector._snapshot(b),
      staticDistanceM: distM,
      timeGapMs: gap,
      bearingDiffDeg: bearingDiff,
    };
  },

  // ---- pure helpers, static persisted-data only ----

  /** Static distance between two records' stored coordinates. The only
   *  spatial primitive the detector uses. Never reads State.pos. */
  _staticDistanceM(a, b) {
    return Utils.distKm(a, b) * 1000;
  },

  _timeGapMs(a, b) {
    const ta = a && a.createdAt ? Date.parse(a.createdAt) : NaN;
    const tb = b && b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (isNaN(ta) || isNaN(tb)) return null;
    return Math.abs(ta - tb);
  },

  _dayDifferent(a, b) {
    if (!a || !b || !a.createdAt || !b.createdAt) return false;
    return String(a.createdAt).slice(0, 10) !== String(b.createdAt).slice(0, 10);
  },

  _hasConfirmations(p) {
    return !!(p && Array.isArray(p.confirmations) && p.confirmations.length > 0);
  },

  _bearingDiff(a, b) {
    if (!a || !b || a.captureBearing == null || b.captureBearing == null) return null;
    return Speed.angleDiff(a.captureBearing, b.captureBearing);
  },

  _linkedBySourceDests(a, b) {
    const sa = Array.isArray(a.sourceDestinationIds) ? a.sourceDestinationIds
             : (a.destId ? [a.destId] : []);
    const sb = Array.isArray(b.sourceDestinationIds) ? b.sourceDestinationIds
             : (b.destId ? [b.destId] : []);
    if (!sa.length || !sb.length) return false;
    return sa.some(x => sb.includes(x)) || sb.some(x => sa.includes(x));
  },

  /** Return a UI-safe snapshot of a point. NEVER includes mutable refs. */
  _snapshot(p) {
    return {
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      type: p.type,
      destId: p.destId,
      createdAt: p.createdAt,
      confidence: p.confidence || 0,
      confirmationsCount: Array.isArray(p.confirmations) ? p.confirmations.length : 0,
      captureBearing: p.captureBearing,
      directional: !!p.directional,
    };
  },

  _formatGap(ms) {
    if (ms == null) return 'unknown';
    if (ms < 60_000) return Math.round(ms / 1000) + 's';
    if (ms < 3600_000) return Math.round(ms / 60_000) + 'm';
    if (ms < 86_400_000) return Math.round(ms / 3600_000) + 'h';
    return Math.round(ms / 86_400_000) + 'd';
  },
};

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
    // v22.96: migration backup + completion timestamp
    migrationBackup: 'roadAlert.v22.96.migrationBackup',
    migrationCompletedAt: 'roadAlert.v22.96.migrationCompletedAt',
    // v22.98: learned-route memory (RouteMemory module)
    learnedRoutes: 'roadAlert.v22.98.learnedRoutes',
    // v23.5: persistent backup retry queue (Phase 4 offline resilience).
    // Survives iOS Safari suspension, lock screen, page reload, killed
    // timers. Cleared on first successful Backup.push after a failure.
    backupQueue: 'roadAlert.v23.5.backupQueue',
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
      // v22.83: show the top-right compass control on the map. Default on.
      showCompass: true,
      // v22.88: persisted map style id. See MAP_STYLES in app-ui.js for the
      // available options ('liberty', 'positron', 'dark', 'satellite',
      // 'terrain'). Default 'liberty' = the original street view.
      mapStyle: 'liberty',
      // v23.0.1: show the explanatory paragraphs under each settings row.
      // Default on — first-time users benefit from the context. Power users
      // can switch off in Settings → Display to reclaim vertical space.
      showHints: true,
      // v23.3.x Phase 3: alert engine operating mode.
      //   'legacy' = current alert engine controls real alerts (default)
      //   'shadow' = legacy controls alerts; IntelligenceEngine evaluates
      //              in parallel and logs decisions (no real effect)
      //   'active' = IntelligenceEngine can suppress legacy alerts
      // Must be explicitly switched. Never silently elevated.
      intelMode: 'legacy',
      // v23.6.0 — Sound Alerts settings.
      //   soundAlerts[<soundId>] = { frequency: 'high'|'medium'|'low', usedFor: '<categoryId>' }
      // Missing entries fall back to per-sound defaults from
      // SoundCatalogue at render time. PREVIEW-ONLY today: the
      // frequency value affects Audio.preview repeats/intensity but
      // not live alert triggering.
      soundAlerts: {},
      // v23.9.9 — master switch for the "Still there?" feedback popup.
      // Default ON. Toggled from the topbar 💬 button. When OFF, no
      // feedback popup is queued or shown (alerts, capture, sounds are
      // unaffected).
      feedbackEnabled: true,
      // v23.7.3 — per-type override for the proximity heartbeat ping.
      // Shape: { speed_camera: true, petrol: false, … }. Missing keys
      // default to ON, so legacy installs keep their current behavior.
      // Toggle is on the Edit Point modal; applies to ALL points of
      // that type. Global proximityPing remains the master switch.
      heartbeatByType: {},
      // v23.17.0 — feedback-geometry gating. Distance/heading/GPS gates
      // applied to every feedback/revalidation sample so opposite-direction
      // or far-away samples never inflate trust. Backward-compatible: when
      // any field is missing the FeedbackGate.DEFAULTS apply.
      feedbackGeometryGates: {
        enabled: true,
        alignedHeadingMaxDeg: 45,
        oppositeHeadingMinDeg: 135,
        minReliableHeadingSpeedKmh: 15,
        acceptedDistanceM: 100,
        quarantineDistanceM: 200,
        hardRejectDistanceM: 500,
        headingGateAppliesToTypes: [
          'speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera', 'speed_change',
        ],
        exemptBidirectionalFromHeadingGate: true,
        poorGpsAccuracyM: 50,
      },
      // v23.18.0 — Auto Route Mode. Lets a drive start with NO destination.
      // Live alerts still come from the existing Observations/Alerts engine
      // (no parallel scanner). Backward-compatible via the shallow merge.
      autoRouteMode: {
        enabled: true,
        startWithoutDestination: true,
        scanRadiusM: 3000,
        forwardConeDeg: 60,
        behindRejectDeg: 120,
        destinationMatchBonus: true,
      },
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
      // v22.91: extend speed-point schema — adds directional, roadType,
      // captureBearing, updatedAt, speedLimit alias. One-time per device.
      if (!localStorage.getItem('roadAlert.v22.91.speedPointsMigrated')) {
        try {
          const d = this.load(this.KEYS.data);
          if (d && Array.isArray(d.points)) {
            const n = Speed.migrateSpeedPoints(d.points);
            if (n > 0) {
              this.save(this.KEYS.data, d);
              console.log('v22.91: extended schema on', n, 'speed-related points');
            }
          }
          localStorage.setItem('roadAlert.v22.91.speedPointsMigrated', '1');
        } catch (e) { console.warn('speed-point migration', e); }
      }
      // v23.8.0: additive observation schema for the global pool —
      // confirmedCount, firstSeenAt, lastSeenAt, heading,
      // bidirectional, source, routeTags, lastConfirmedAt.
      // ADDITIVE ONLY — never overwrites existing fields, never
      // deletes, never suppresses. Legacy points stay alertable.
      if (!localStorage.getItem('roadAlert.v23.8.0.observationFields')) {
        try {
          const d = this.load(this.KEYS.data);
          if (d && Array.isArray(d.points)) {
            const n = Observations.migrateAdditive(d.points);
            if (n > 0) {
              this.save(this.KEYS.data, d);
              console.log('v23.8.0: added observation fields on', n, 'points');
            }
          }
          localStorage.setItem('roadAlert.v23.8.0.observationFields', '1');
        } catch (e) { console.warn('observation-field migration', e); }
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
   1b. NETWORK MONITOR — v23.5 (Phase 4, offline resilience)

   Tracks network health from MULTIPLE signals, with the spec's
   explicit hint-vs-authoritative distinction:

     HINT (cheap but unreliable):
       navigator.onLine          — set by the browser; can lie on
                                   captive portals, VPNs, hotspots.
       online / offline events   — fired when the OS thinks state
                                   changed. Treated as hints only.

     AUTHORITATIVE (expensive but truthful):
       Real fetch outcomes from existing call sites:
         - MapView._fetchAndDrawRoute → recordFetchResult('route', ok)
         - Backup.push                → recordFetchResult('backup', ok)
       These are the only signals that can promote state to
       'confirmed-offline'.

   Derived state:
       online              — recent success on any scope, no recent
                             failures
       suspected-offline   — navigator.onLine === false OR a single
                             recent failure
       confirmed-offline   — ≥ 2 consecutive failures across scopes,
                             OR navigator.onLine false + recent failure

   Per-scope flags also tracked:
       routeUnavailable    — true if last route fetch failed and not
                             yet succeeded again
       backupPending       — true if a backup attempt failed; cleared
                             when BackupQueue drains successfully
   ============================================================ */
const NetworkMonitorConfig = {
  FAILURE_PROMOTION_THRESHOLD: 2,        // ≥ N consecutive failures → confirmed-offline
  FAILURE_FORGET_MS: 5 * 60 * 1000,      // clear "recent" flag after 5 min of silence
  ROUTE_BACKOFF_MS: 30 * 1000,           // suggested gap between route retries when offline
};

const NetworkMonitor = {
  _consecutiveFailures: 0,
  _lastSuccessAt: null,
  _lastFailureAt: null,
  _lastFailureScope: null,
  _lastFailureMessage: null,
  _routeUnavailable: false,
  _backupPending: false,
  _navigatorOnlineHint: null,            // last value of navigator.onLine

  /** Called on real network outcomes. scope is 'route' | 'backup' |
   *  any future call site. ok = true on success, false on failure. */
  recordFetchResult(scope, ok, message) {
    if (ok) {
      const wasOffline = NetworkMonitor.getState() !== 'online';
      NetworkMonitor._consecutiveFailures = 0;
      NetworkMonitor._lastSuccessAt = Date.now();
      NetworkMonitor._lastFailureMessage = null;
      if (scope === 'route') NetworkMonitor._routeUnavailable = false;
      if (scope === 'backup') NetworkMonitor._backupPending = false;
      if (wasOffline) {
        logEvent('OFFLINE-NETWORK',
          `[OFFLINE-NETWORK] recovered · ${scope} succeeded after ${NetworkMonitor._consecutiveFailures + 0} failures`, 'ok');
      }
      return;
    }
    NetworkMonitor._consecutiveFailures++;
    NetworkMonitor._lastFailureAt = Date.now();
    NetworkMonitor._lastFailureScope = scope;
    NetworkMonitor._lastFailureMessage = message || null;
    if (scope === 'route') NetworkMonitor._routeUnavailable = true;
    if (scope === 'backup') NetworkMonitor._backupPending = true;
    const state = NetworkMonitor.getState();
    const prefix = scope === 'route' ? 'OFFLINE-ROUTE'
                 : scope === 'backup' ? 'OFFLINE-BACKUP'
                 : 'OFFLINE-NETWORK';
    logEvent(prefix,
      `[${prefix}] ${scope} failed · state=${state} · consec=${NetworkMonitor._consecutiveFailures}` +
      (message ? ` · ${message}` : ''),
      'err');
  },

  /** Hint signal from window.online / window.offline events. */
  recordNavigatorOnline(bool) {
    NetworkMonitor._navigatorOnlineHint = !!bool;
    logEvent('OFFLINE-NETWORK',
      `[OFFLINE-NETWORK] hint navigator.onLine=${bool}`,
      bool ? 'ok' : '');
  },

  /** Derived state. Authoritative failures dominate the hint. */
  getState() {
    const hintOffline = (NetworkMonitor._navigatorOnlineHint === false);
    const confirmedOffline = NetworkMonitor._consecutiveFailures >= NetworkMonitorConfig.FAILURE_PROMOTION_THRESHOLD
      || (hintOffline && NetworkMonitor._consecutiveFailures >= 1);
    if (confirmedOffline) return 'confirmed-offline';
    if (hintOffline || NetworkMonitor._consecutiveFailures >= 1) return 'suspected-offline';
    return 'online';
  },

  /** Full snapshot for UI / debug. */
  getStatus() {
    return {
      state: NetworkMonitor.getState(),
      routeUnavailable: NetworkMonitor._routeUnavailable,
      backupPending: NetworkMonitor._backupPending,
      consecutiveFailures: NetworkMonitor._consecutiveFailures,
      lastSuccessAt: NetworkMonitor._lastSuccessAt,
      lastFailureAt: NetworkMonitor._lastFailureAt,
      lastFailureScope: NetworkMonitor._lastFailureScope,
      lastFailureMessage: NetworkMonitor._lastFailureMessage,
      navigatorOnlineHint: NetworkMonitor._navigatorOnlineHint,
    };
  },
};

/* ============================================================
   1c. BACKUP QUEUE — v23.5 (Phase 4, persistent retry across
   iOS Safari suspension / page reload / killed timers)
   ============================================================ */
const BackupQueue = {
  /** Read the queue. Returns the single pending push entry, or null. */
  read() {
    try {
      const raw = localStorage.getItem(Storage.KEYS.backupQueue);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && parsed.push) ? parsed : null;
    } catch (e) {
      logEvent('OFFLINE-BACKUP', '[OFFLINE-BACKUP] queue read failed: ' + (e && e.message || e), 'err');
      return null;
    }
  },

  /** Record a failed push so the retry survives reload / suspension. */
  enqueueFailedPush(err) {
    const existing = BackupQueue.read();
    const entry = {
      push: {
        queuedAt: existing && existing.push ? existing.push.queuedAt : new Date().toISOString(),
        attempts: (existing && existing.push ? existing.push.attempts : 0) + 1,
        lastError: String((err && err.message) || err || ''),
        lastAttemptAt: new Date().toISOString(),
      },
    };
    try {
      localStorage.setItem(Storage.KEYS.backupQueue, JSON.stringify(entry));
      logEvent('OFFLINE-BACKUP',
        `[OFFLINE-BACKUP] queued failed push · attempts=${entry.push.attempts} · since ${entry.push.queuedAt}`,
        'err');
    } catch (e) {
      logEvent('OFFLINE-BACKUP', '[OFFLINE-BACKUP] queue write failed: ' + (e && e.message || e), 'err');
    }
  },

  /** Clear the queue after a successful push. */
  clear() {
    try {
      localStorage.removeItem(Storage.KEYS.backupQueue);
    } catch (e) {}
  },

  /** True iff there's a pending entry the resume/visibility path
   *  should attempt to drain. */
  hasPending() {
    return !!BackupQueue.read();
  },

  /** Returns the current entry (or null) so callers can log it. */
  inspect() {
    const q = BackupQueue.read();
    return q && q.push ? q.push : null;
  },

  /** Drain the queue. Best-effort single retry of Backup.push.
   *  Idempotent: caller (visibility/resume) may call this multiple
   *  times; the first successful push removes the entry. */
  async drain() {
    if (!BackupQueue.hasPending()) return { ok: true, drained: false };
    const before = BackupQueue.inspect();
    logEvent('OFFLINE-BACKUP',
      `[OFFLINE-BACKUP] draining queue · attempts=${before.attempts} · last="${before.lastError}"`);
    try {
      const result = await Backup.push({ silent: true });
      if (result) {
        BackupQueue.clear();
        logEvent('OFFLINE-BACKUP', '[OFFLINE-BACKUP] drained successfully', 'ok');
        return { ok: true, drained: true };
      }
      // Backup.push handles its own failure logging via NetworkMonitor.
      return { ok: false, drained: false };
    } catch (e) {
      logEvent('OFFLINE-BACKUP', '[OFFLINE-BACKUP] drain threw: ' + (e && e.message || e), 'err');
      return { ok: false, drained: false };
    }
  },
};

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
  // v23.5.8: GPS altitude diagnostics. ADDITIVE ONLY — these never
  // feed alerts, scoring, route logic, or map markers. Surfaced in
  // the debug modal as a read-only readout. All three may be null
  // when the device/browser does not expose vertical fix data.
  altitude: null,            // meters above WGS84 ellipsoid (or null)
  altitudeAccuracy: null,    // ± meters vertical (or null)
  gpsTimestamp: null,        // raw pos.timestamp (or null)
  // v23.2.1: PERMISSION_DENIED (code 1) flag. Set when the geolocation
  // API rejects with code 1; cleared when GPS.start() is called again.
  // Codes 2 and 3 (POSITION_UNAVAILABLE / TIMEOUT) do NOT set this flag.
  gpsPermissionDenied: false,
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
  // v22.91: rolling histories for road-type inference + heading averaging.
  //   speedHistory:   { t, kmh } entries within the last 30 seconds
  //   headingHistory: { t, deg } entries within the last 10 seconds
  // Both reset at GPS.start. Used by Speed.scoreSpeedPoint and by capture
  // auto-fill (captureBearing). Not persisted.
  speedHistory: [],
  headingHistory: [],
  // v23.14.0: rolling buffer of the last 3 raw GPS fixes. MEMORY-ONLY —
  // never persisted (lives on the State root, not State.data, so
  // saveData() never serializes it). Pushed from GPS.onTick. Read by
  // CaptureMeta.getCurrentGpsCaptureSnapshot to attach capture-time
  // metadata to a freshly captured point. Feeds NO alert, route,
  // marker, sound, or scoring logic.
  gpsFixBuffer: [],
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
  // v23.8.7: distance (m) at which each passed point was last seen,
  // used by Alerts.tick to detect re-approach (u-turn / round-trip)
  // and re-arm the point so it can alert again. Map<pointId, distM>.
  // Cleared alongside passedPoints on trip start / destination change.
  passedDistByPoint: new Map(),
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
  // v23.8.6: limitPickerMode removed — the picker is unified. Both
  // entry points (LIMIT sign tap, Capture → Speed zone) run through
  // UI._commitSpeedLimit which sets the manual override AND captures
  // a speed_change at the current GPS position when available.
  lastTripCaptureId: null, // v22.10: id of most recent point captured this trip (for double-tap recall)
  alertsFiredThisTrip: 0, // v22.12: count alerts fired since trip start, shown in diag strip
  feedbackPassId: null,   // v23.7.1: per-session uid for missed-feedback dedup

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
    // v22.96: post-migration, destinations carry .routePointRefs (array
    // of point ids). Use that when present; fall back to the legacy
    // destId filter for un-migrated data.
    const id = this.data.activeDestId;
    if (!id) return [];
    const dest = this.data.destinations.find(d => d.id === id);
    if (dest && Array.isArray(dest.routePointRefs)) {
      const refSet = new Set(dest.routePointRefs);
      return this.data.points.filter(p => refSet.has(p.id));
    }
    return this.data.points.filter(p => p.destId === id);
  },

  /** v22.101: keep dest.routePointRefs in sync when a new point is captured
   *  for the active destination.
   *  v23.17.0: previously this only updated routePointRefs when it was
   *  already an Array — for destinations created after the v22.96 migration
   *  whose routePointRefs field was never initialized, every captured point
   *  vanished from the destination's reference list (visible in exports as
   *  "N points by destId, 0 routePointRefs"). Always ensure the field is
   *  an array and append exactly once. Treat the active destination the
   *  same as any other. */
  addPointToActiveDest(point) {
    this.data.points.push(point);
    const dest = this.activeDest();
    if (!dest) return;
    if (!Array.isArray(dest.routePointRefs)) dest.routePointRefs = [];
    if (!dest.routePointRefs.includes(point.id)) dest.routePointRefs.push(point.id);
  },

  /** v22.101: remove a point and clean it out of every destination's
   *  routePointRefs[] so the timeline / map / next-ahead stop seeing it. */
  removePointById(id) {
    this.data.points = this.data.points.filter(p => p.id !== id);
    for (const d of this.data.destinations) {
      if (Array.isArray(d.routePointRefs)) {
        d.routePointRefs = d.routePointRefs.filter(pid => pid !== id);
      }
    }
  },

  /** v22.91: rolling-average current speed (km/h) over the last 30 seconds.
   *  Returns null if we don't have at least 10 samples (≈ 10 s of data).
   *  null = "insufficient history → caller should treat as unknown". */
  avgSpeedKmh() {
    const n = this.speedHistory.length;
    if (n < 10) return null;
    let sum = 0;
    for (const e of this.speedHistory) sum += e.kmh;
    return sum / n;
  },

  /** v22.91: rolling vector-averaged heading over the last 10 seconds.
   *  Returns null if we have fewer than 3 samples. Used to seed
   *  captureBearing when saving a new speed_change point. */
  avgHeading() {
    const n = this.headingHistory.length;
    if (n < 3) return null;
    let sx = 0, sy = 0;
    for (const e of this.headingHistory) {
      sx += Math.cos(e.deg * Math.PI / 180);
      sy += Math.sin(e.deg * Math.PI / 180);
    }
    let avg = Math.atan2(sy / n, sx / n) * 180 / Math.PI;
    if (avg < 0) avg += 360;
    return avg;
  },

  /** All points without a destination assignment (for orphan management). */
  orphanPoints() {
    return this.data.points.filter(p => !p.destId);
  },
};

/* ============================================================
   2b. SOUND CATALOGUE — v23.6.0 (Phase: Sound Alerts settings)
   18 sound IDs. Each entry has a label, a Web-Audio ping pattern,
   and a default category (used-for). Patterns are independent of
   the legacy Audio.beep patterns so live alert behavior is
   untouched. SoundCatalogue is read by Audio.preview() only.
   ============================================================ */
/* v23.6.1 — Sound Alerts "Used For" mapping rebuilt against the real
 * X capture/alert type keys.
 *
 *   - Real captured point.type keys come from Utils.typeLabel(t)
 *     (app-core.js:85) — the single source of truth. The 10 valid
 *     point.type values are listed in CAPTURED_ALERT_TYPES below.
 *   - App / system targets are stable reserved keys for future
 *     non-captured sound events (route, GPS, storage, feedback). They
 *     are NOT wired to any live behavior in this task.
 *
 * Display labels for captured alerts come straight from Utils.typeLabel
 * so they stay in sync with the rest of the app — except for "other",
 * which uses a Sound-Alerts-local label "Custom / Other Captured
 * Alert" for clarity (without touching Utils.typeLabel).
 *
 * Saved values are always the internal key (e.g. "speed_change"), never
 * a display label.
 */
const CAPTURED_ALERT_TYPES = [
  'petrol', 'checkpoint',
  'speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera',
  'speed_change', 'gate', 'traffic_light', 'other',
];

const SoundUsedForGroups = [
  // "None" sits alone at the top, outside any optgroup.
  { id: '_none', label: '', items: [
    { id: 'none', label: 'None' },
  ]},
  { id: '_captured', label: 'Captured Alerts', items: CAPTURED_ALERT_TYPES.map(t => ({
    id: t,
    label: t === 'other' ? 'Custom / Other Captured Alert' : (Utils.typeLabel(t) || t),
  })) },
  // v23.8.9 — driving-safety events that aren't tied to a captured
  // point.type. speed_limit_exceeded is fired by Alerts.checkSpeed
  // when the driver crosses the limit + overBy threshold; mapping a
  // catalogue sound to it routes the over-speed beep through the
  // user's preferred sound instead of the legacy speed_change radar
  // tone. Leaving it unmapped preserves legacy behavior.
  { id: '_driving', label: 'Driving Alerts', items: [
    { id: 'speed_limit_exceeded', label: 'Speed Limit Exceeded' },
  ]},
  { id: '_nav', label: 'Navigation / Route', items: [
    { id: 'route_deviation',    label: 'Route Deviation' },
    { id: 'reroute_completed',  label: 'Reroute Completed' },
    { id: 'destination_near',   label: 'Destination Near' },
  ]},
  { id: '_gps', label: 'GPS / Sensor', items: [
    { id: 'gps_weak_signal',    label: 'GPS Weak Signal' },
    { id: 'gps_lost_offline',   label: 'GPS Lost / Offline' },
    { id: 'gps_recovered',      label: 'GPS Recovered' },
    { id: 'heading_weak',       label: 'Heading Weak' },
  ]},
  { id: '_system', label: 'Storage / System', items: [
    { id: 'storage_warning',         label: 'Storage Warning' },
    { id: 'backup_restore_warning',  label: 'Backup / Restore Warning' },
    { id: 'app_notification',        label: 'App Notification' },
    { id: 'system_notice',           label: 'System Notice' },
    { id: 'sos_emergency',           label: 'SOS / Emergency' },
  ]},
  { id: '_feedback', label: 'Feedback', items: [
    { id: 'user_feedback',     label: 'User Feedback' },
    { id: 'success_feedback',  label: 'Success Feedback' },
    { id: 'error_feedback',    label: 'Error Feedback' },
    { id: 'capture_feedback',  label: 'Capture Feedback' },
  ]},
];

// Flat set of every valid Used-For key — used by the migration helper
// to recognize an already-migrated value.
const SOUND_USEDFOR_VALID_KEYS = (function() {
  const out = new Set();
  for (const g of SoundUsedForGroups) for (const it of g.items) out.add(it.id);
  return out;
})();

// Legacy generic labels and pre-v23.6.1 lowercase keys → new keys.
// Migrate-on-read only — saved entries are NOT proactively rewritten.
const SOUND_USEDFOR_LEGACY_MAP = {
  // user-facing label strings (parallel agent's capitalized values)
  'Speed Limit':      'speed_change',
  'Speed Camera':     'speed_camera',
  'Hazard':           'none',
  'Police':           'none',
  'Road Work':        'none',
  'Accident':         'none',
  'Route Deviation':  'route_deviation',
  'GPS Warning':      'gps_weak_signal',
  'General Warning':  'app_notification',
  'SOS / Emergency':  'sos_emergency',
  'App Notification': 'app_notification',
  'User Feedback':    'user_feedback',
  'Success Feedback': 'success_feedback',
  'Error Feedback':   'error_feedback',
  'Non':              'none',
  'None':             'none',
  // pre-v23.6.1 lowercase generic keys (my own previous impl)
  'speed_limit':     'speed_change',
  'hazard':          'none',
  'police':          'none',
  'road_work':       'none',
  'accident':        'none',
  'general_warning': 'app_notification',
  'gps_warning':     'gps_weak_signal',
};

/** Migrate a saved usedFor value to the new key space. Idempotent on
 *  already-valid keys. Returns "none" + logs for unrecognized values. */
function migrateSoundUsedFor(value) {
  if (value == null || value === '') return 'none';
  if (SOUND_USEDFOR_VALID_KEYS.has(value)) return value;
  const mapped = SOUND_USEDFOR_LEGACY_MAP[value];
  if (mapped) return mapped;
  try { logEvent('SOUND', '[SOUND] unmapped legacy usedFor: ' + value, 'err'); } catch (e) {}
  return 'none';
}

/** Normalize the saved frequency value. Accepts case-insensitive
 *  'high'|'medium'|'low' (and parallel-agent's 'High'/'Medium'/'Low').
 *  Falls back to 'medium' on anything else. */
function normalizeSoundFrequency(value) {
  if (!value) return 'medium';
  const s = String(value).toLowerCase();
  return (s === 'high' || s === 'medium' || s === 'low') ? s : 'medium';
}

/* v23.6.3 — single canonical registry of 18 sounds matching the spec
 * IDs. Each entry: { id, label, defaultUsedFor, pattern[] }.
 * Pattern = sequence of {freq, dur} sine pings (existing playPattern). */
const SoundCatalogue = [
  // 1. Soft Chime — gentle two-tone descending
  { id: 'soft_chime',         label: 'Soft Chime',         defaultUsedFor: 'app_notification',
    pattern: [{freq:1600,dur:0.14},{freq:1300,dur:0.18}] },
  // 2. Double Beep — two equal mid pings
  { id: 'double_beep',        label: 'Double Beep',        defaultUsedFor: 'app_notification',
    pattern: [{freq:1800,dur:0.10},{freq:1800,dur:0.10}] },
  // 3. Radar Ping — rising 2-tone, classic speed-cam timbre
  { id: 'radar_ping',         label: 'Radar Ping',         defaultUsedFor: 'speed_camera',
    pattern: [{freq:1900,dur:0.12},{freq:2400,dur:0.18}] },
  // 4. Warning Pulse — even mid-tone double pulse
  { id: 'warning_pulse',      label: 'Warning Pulse',      defaultUsedFor: 'app_notification',
    pattern: [{freq:1600,dur:0.18},{freq:1600,dur:0.18}] },
  // 5. Camera Tick — short low-high tick
  { id: 'camera_tick',        label: 'Camera Tick',        defaultUsedFor: 'speed_camera',
    pattern: [{freq:1200,dur:0.06},{freq:1700,dur:0.06}] },
  // 6. Speed Tone — low rising sweep, suits speed-zone context
  { id: 'speed_tone',         label: 'Speed Tone',         defaultUsedFor: 'speed_change',
    pattern: [{freq:1400,dur:0.14},{freq:1900,dur:0.14}] },
  // 7. Route Alert — rapid 3-tone "attention" cue
  { id: 'route_alert',        label: 'Route Alert',        defaultUsedFor: 'route_deviation',
    pattern: [{freq:1900,dur:0.10},{freq:2200,dur:0.10},{freq:2400,dur:0.14}] },
  // 8. Attention Bell — single sustained mid bell tone
  { id: 'attention_bell',     label: 'Attention Bell',     defaultUsedFor: 'app_notification',
    pattern: [{freq:1500,dur:0.22}] },
  // 9. Short Siren — alternating low/high 4-pulse
  { id: 'short_siren',        label: 'Short Siren',        defaultUsedFor: 'sos_emergency',
    pattern: [{freq:1400,dur:0.10},{freq:2400,dur:0.10},{freq:1400,dur:0.10},{freq:2400,dur:0.10}] },
  // 10. Calm Notification — soft long mid chime
  { id: 'calm_notification',  label: 'Calm Notification',  defaultUsedFor: 'app_notification',
    pattern: [{freq:1450,dur:0.24}] },
  // 11. SOS Alert — Morse-style 3 short / 3 long / 3 short
  { id: 'sos_alert',          label: 'SOS Alert',          defaultUsedFor: 'sos_emergency',
    pattern: [
      {freq:2000,dur:0.08},{freq:2000,dur:0.08},{freq:2000,dur:0.08},
      {freq:2000,dur:0.22},{freq:2000,dur:0.22},{freq:2000,dur:0.22},
      {freq:2000,dur:0.08},{freq:2000,dur:0.08},{freq:2000,dur:0.08},
    ] },
  // 12. Feedback Pop — brief single ping
  { id: 'feedback_pop',       label: 'Feedback Pop',       defaultUsedFor: 'user_feedback',
    pattern: [{freq:1200,dur:0.06}] },
  // 13. Success Ding — clean rising 2-tone
  { id: 'success_ding',       label: 'Success Ding',       defaultUsedFor: 'success_feedback',
    pattern: [{freq:1500,dur:0.10},{freq:2100,dur:0.16}] },
  // 14. Error Buzz — low buzzing 3-tone descending
  { id: 'error_buzz',         label: 'Error Buzz',         defaultUsedFor: 'error_feedback',
    pattern: [{freq:300,dur:0.08},{freq:280,dur:0.08},{freq:260,dur:0.10}] },
  // 15. Notify Drop — soft descending 2-tone
  { id: 'notify_drop',        label: 'Notify Drop',        defaultUsedFor: 'app_notification',
    pattern: [{freq:1800,dur:0.12},{freq:1400,dur:0.18}] },
  // 16. Urgent Alarm — alternating 3-tone, between Warning Pulse and Short Siren
  { id: 'urgent_alarm',       label: 'Urgent Alarm',       defaultUsedFor: 'app_notification',
    pattern: [{freq:2200,dur:0.12},{freq:1700,dur:0.12},{freq:2200,dur:0.12}] },
  // 17. Soft Tap — minimal low-frequency single ping
  { id: 'soft_tap',           label: 'Soft Tap',           defaultUsedFor: 'user_feedback',
    pattern: [{freq:900,dur:0.05}] },
  // 18. System Notice — neutral 2-tone, distinct from Calm Notification
  { id: 'system_notice',      label: 'System Notice',      defaultUsedFor: 'system_notice',
    pattern: [{freq:1700,dur:0.10},{freq:2000,dur:0.10}] },
];

/* ============================================================
   3. AUDIO
   ============================================================ */
const Audio = {
  ctx: null,
  _voiceCache: null,
  _voiceCacheFor: null,
  _unlocked: false,

  // v23.6.0 merge: removed the parallel "Audio.PREVIEW_SOUNDS" 10-sound
  // metadata array — the 18-sound SoundCatalogue defined above this
  // module is the spec-compliant source. SoundCatalogue + Audio.preview
  // own the catalogue surface; the old PREVIEW_SOUNDS array would have
  // duplicated half of those IDs.

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

  /* ----- Decision helpers -----
     SINGLE source of truth for whether a tone / speech is allowed by the
     audio policy. Enforcement AND audit logging must use the SAME returned
     decision object per emission. Boolean helpers DERIVE from these. */
  beepDecision() {
    if (State.settings.sound === 'off') return { allowed: false, reason: 'sound_off' };
    if (State.settings.sound === 'voice') return { allowed: false, reason: 'tone_not_allowed_by_sound_mode' };
    return { allowed: true, reason: null };
  },
  speakDecision() {
    if (State.settings.sound === 'off') return { allowed: false, reason: 'sound_off' };
    if (State.settings.voiceGender === 'none') return { allowed: false, reason: 'voice_gender_none' };
    if (State.settings.sound === 'beep') return { allowed: false, reason: 'speech_not_allowed_by_sound_mode' };
    return { allowed: true, reason: null };
  },
  speedToneDecision() {
    const base = this.beepDecision(); if (!base.allowed) return base;
    const mode = State.settings.speedAlertMode || 'beep';
    if (mode === 'off') return { allowed: false, reason: 'speed_alert_mode_off' };
    if (mode === 'voice') return { allowed: false, reason: 'tone_not_allowed_by_speed_alert_mode' };
    return { allowed: true, reason: null };
  },
  speedSpeechDecision() {
    const base = this.speakDecision(); if (!base.allowed) return base;
    const mode = State.settings.speedAlertMode || 'beep';
    if (mode === 'off') return { allowed: false, reason: 'speed_alert_mode_off' };
    if (mode === 'beep') return { allowed: false, reason: 'speech_not_allowed_by_speed_alert_mode' };
    return { allowed: true, reason: null };
  },
  shouldBeep() { return this.beepDecision().allowed; },
  shouldSpeak() { return this.speakDecision().allowed; },

  // `opts` may carry { preview:true } (preview-test bypass) and { auditSource }
  // so a thrown AudioContext error is logged against the right source. beep()
  // does NOT gate by the master sound mode — gating stays the caller's job so
  // historically-ungated paths keep playing exactly as before.
  beep(type, opts) {
    opts = opts || {};
    const auditSrc = opts.auditSource || (opts.preview ? 'preview_test' : null);
    const ctx = this.ensure();
    if (!ctx) {
      // Vibration is intentionally independent from the master sound setting.
      // sound='off' mutes generated audio/speech only; haptic feedback remains enabled.
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
      if (auditSrc) AudioAudit.log({ source: 'haptic', action: 'haptic_fired', vibrationFired: true, reason: null, extra: { relatedSource: auditSrc, fallback: 'no_audio_context' } });
      return;
    }
    // Declared outside the try so the vibration mirror below can still
    // read the pattern even if tone scheduling throws.
    let pings = null;
    try {
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
    pings = patterns[type] || patterns.other;
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
    } catch (e) {
      if (auditSrc) AudioAudit.log({ source: auditSrc, action: 'tone_error', error: String(e), reason: 'audio_context_error', pointType: type });
    }

    // Vibration mirror — silent mode safety net.
    // Vibration is intentionally independent from the master sound setting.
    // sound='off' mutes generated audio/speech only; haptic feedback remains enabled.
    if (pings && navigator.vibrate) {
      const vibPattern = [];
      pings.forEach((p, i) => {
        if (i > 0) vibPattern.push(60);
        vibPattern.push(Math.round(p.dur * 1000));
      });
      navigator.vibrate(vibPattern);
      if (auditSrc) AudioAudit.log({ source: 'haptic', action: 'haptic_fired', vibrationFired: true, reason: null, pointType: type, extra: { relatedSource: auditSrc, pattern: 'beep_mirror' } });
    }
  },

  /** v23.7.0 — find the SoundCatalogue entry currently mapped to a
   *  point.type via State.settings.soundAlerts. Returns the soundId
   *  or null when no mapping resolves. Used by playAlertSoundForType
   *  to drive the live "next ahead" peep from user preference. */
  findMappedSoundId(type) {
    if (!type) return null;
    const saved = (typeof State !== 'undefined' && State.settings && State.settings.soundAlerts) || {};
    const cat = (typeof SoundCatalogue !== 'undefined' && Array.isArray(SoundCatalogue)) ? SoundCatalogue : [];
    for (const s of cat) {
      const entry = saved[s.id] || {};
      const usedRaw = entry.usedFor || s.defaultUsedFor || 'none';
      const used = (typeof migrateSoundUsedFor === 'function') ? migrateSoundUsedFor(usedRaw) : usedRaw;
      if (used === type) return s.id;
    }
    return null;
  },

  /** v23.7.0 — preference-driven live alert sound. The peep that
   *  fires when approaching a point ahead now respects the Sound
   *  Alerts mapping: whichever sound has its usedFor set to this
   *  point.type plays. When no mapping resolves, falls back to the
   *  legacy Audio.beep(type) radar tones — so users who never
   *  edited their mapping see no behavior change.
   *  Plays the catalogue pattern ONCE (the surrounding Audio.alert
   *  loop handles repeat counts via alertRepeatCount). */
  playAlertSoundForType(type, opts) {
    opts = opts || {};
    const auditSrc = opts.auditSource || (opts.preview ? 'preview_test' : null);
    const mappedId = this.findMappedSoundId(type);
    if (mappedId) {
      const def = (typeof SoundCatalogue !== 'undefined')
        ? SoundCatalogue.find(s => s.id === mappedId) : null;
      if (def && Array.isArray(def.pattern) && def.pattern.length) {
        const ctx = this.ensure();
        if (ctx) {
          this.playPattern(def.pattern, { intensity: 0.7 });
          // Vibration mirror — silent-mode safety net (matches Audio.beep).
          // Vibration is intentionally independent from the master sound setting.
          // sound='off' mutes generated audio/speech only; haptic feedback remains enabled.
          if (navigator.vibrate) {
            const totalMs = Math.round(def.pattern.reduce((s, p) => s + p.dur + 0.05, 0) * 1000);
            try {
              navigator.vibrate(Math.max(60, totalMs));
              AudioAudit.log({ source: 'haptic', action: 'haptic_fired', vibrationFired: true, reason: null, pointType: type, extra: { relatedSource: auditSrc || 'threshold_alert', pattern: 'mapped_mirror' } });
            } catch (e) {}
          }
          return;
        }
      }
    }
    // No mapping (or catalogue lookup failed) → legacy radar tones
    this.beep(type, { auditSource: auditSrc || 'threshold_alert', preview: !!opts.preview });
  },

  /** v23.7.1 — feedback popup sound. Plays the catalogue sound mapped
   *  to 'user_feedback' (default: feedback_pop). Fires once per
   *  feedback-popup display; the popup renderer guards against
   *  re-plays from GPS ticks / re-renders. */
  playFeedbackPopupSound() {
    this.playAlertSoundForType('user_feedback');
  },

  /** v23.7.1 — feedback confirmation sound. Plays the catalogue sound
   *  mapped to 'success_feedback' (default: success_ding). Fires only
   *  after a feedback response was successfully saved — NEVER on
   *  timeout, NEVER on simply opening the popup. */
  playFeedbackConfirmSound() {
    this.playAlertSoundForType('success_feedback');
  },

  /** v23.6.0 — Web-Audio pattern player extracted as a reusable helper.
   *  Plays ONE pass of a ping pattern. `opts.intensity` is a peakGain
   *  multiplier (0.55 low / 0.75 medium / 1.0 high). Returns the
   *  AudioContext "ends-at" time (seconds, relative to AudioContext
   *  start) so callers can chain repeats without overlap. Pure helper;
   *  no live-alert wiring changes — Audio.beep still controls every
   *  alert path. */
  playPattern(pattern, opts) {
    const ctx = this.ensure();
    if (!ctx || !Array.isArray(pattern) || !pattern.length) return null;
    const intensity = Math.max(0.05, Math.min(1.0,
      (opts && typeof opts.intensity === 'number') ? opts.intensity : 0.6));
    const peakGain = 0.6 * (intensity / 0.6); // keep 0.6 as the 'medium' anchor
    const gap = 0.05;
    let t = ctx.currentTime;
    for (const ping of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = ping.freq;
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(peakGain, t + 0.003);
      gain.gain.setValueAtTime(peakGain, t + ping.dur * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.001, t + ping.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + ping.dur + 0.01);
      t += ping.dur + gap;
    }
    return t;
  },

  /** v23.6.0 — Preview a sound from SoundCatalogue. PREVIEW-ONLY: does
   *  NOT affect live alert triggers. Frequency option controls repeat
   *  count + intensity + inter-repeat gap per spec:
   *    high   → 3 plays · 200 ms gap · intensity 1.0
   *    medium → 2 plays · 320 ms gap · intensity 0.75 (default)
   *    low    → 1 play  · n/a       · intensity 0.55
   *  opts.onStatus(label) is called with 'Buffering…', 'Playing…',
   *  'Played', or 'Failed' so the caller's row can paint state.
   *  Single-flight enforced by Audio._previewToken — calling preview
   *  again cancels the previous run and the previous row's status is
   *  reset via opts.onCancelPrev() before the new run begins. */
  _previewToken: 0,
  _previewCancelPrev: null,
  cancelPreview() {
    this._previewToken++;
    if (typeof this._previewCancelPrev === 'function') {
      try { this._previewCancelPrev(); } catch (e) {}
    }
    this._previewCancelPrev = null;
  },
  async preview(soundId, opts) {
    opts = opts || {};
    const def = (typeof SoundCatalogue !== 'undefined') ? SoundCatalogue.find(s => s.id === soundId) : null;
    const onStatus = (typeof opts.onStatus === 'function') ? opts.onStatus : function() {};
    if (!def) { onStatus('Failed'); return { ok: false, error: 'unknown_sound' }; }

    // Single-flight: bump token + reset prior row first.
    this._previewToken++;
    const myToken = this._previewToken;
    if (typeof this._previewCancelPrev === 'function') {
      try { this._previewCancelPrev(); } catch (e) {}
    }
    this._previewCancelPrev = function() { try { onStatus(''); } catch (e) {} };

    const freq = (opts.frequency || 'medium').toLowerCase();
    const repeats   = freq === 'high' ? 3 : freq === 'low' ? 1 : 2;
    const gapMs     = freq === 'high' ? 200 : 320;
    const intensity = freq === 'high' ? 1.0 : freq === 'low' ? 0.55 : 0.75;

    onStatus('Buffering…');
    Audio.unlock();
    const ctx = Audio.ensure();
    if (!ctx) {
      onStatus('Failed');
      if (this._previewToken === myToken) this._previewCancelPrev = null;
      return { ok: false, error: 'no_audio_context' };
    }

    onStatus('Playing…');
    try {
      const patternDur = def.pattern.reduce((s, p) => s + p.dur + 0.05, 0); // seconds incl. inter-ping gaps
      for (let r = 0; r < repeats; r++) {
        if (this._previewToken !== myToken) return { ok: false, cancelled: true };
        Audio.playPattern(def.pattern, { intensity });
        const waitMs = Math.round(patternDur * 1000) + (r < repeats - 1 ? gapMs : 0);
        await new Promise(res => setTimeout(res, waitMs));
      }
      if (this._previewToken === myToken) {
        onStatus('Played');
        this._previewCancelPrev = null;
      }
      // Catalogue preview explicitly bypasses the master mute (preview-only).
      AudioAudit.log({ source: 'preview_test', action: 'preview_tone_played', previewBypass: true, reason: 'preview_bypass', extra: { soundId: soundId } });
      return { ok: true };
    } catch (e) {
      onStatus('Failed');
      if (this._previewToken === myToken) this._previewCancelPrev = null;
      try { logEvent('SOUND', '[SOUND] preview failed: ' + (e && e.message || e), 'err'); } catch (err) {}
      AudioAudit.log({ source: 'preview_test', action: 'preview_error', previewBypass: true, error: String(e), reason: 'audio_context_error', extra: { soundId: soundId } });
      return { ok: false, error: 'play_failed' };
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

  // `opts` may carry { preview:true } and { auditSource } so a
  // speechSynthesis failure is logged against the right source. say() keeps
  // its historical gate (voiceGender==='none') only — callers apply the
  // master sound-mode gate.
  say(text, opts) {
    opts = opts || {};
    const auditSrc = opts.auditSource || (opts.preview ? 'preview_test' : null);
    if (!('speechSynthesis' in window)) return;
    if (State.settings.voiceGender === 'none') return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) {
      if (auditSrc) AudioAudit.log({ source: auditSrc, action: 'speech_error', error: String(e), reason: 'speech_synthesis_error', extra: { textLen: (text || '').length } });
    }
  },

  /** Fire alert for a point crossing a specific marker (meters).
   *  v22.32: tone plays unconditionally; voice plays additionally if
   *  voiceGender !== 'none'. The old 4-way sound mode is now binary
   *  (off vs on) via the master mute. */
  // `opts.preview` is set by the Sound Check / settings preview path so the
  // alert plays even when sound==='off'. Generated runtime alerts never set it.
  alert(point, meters, opts) {
    opts = opts || {};
    const preview = !!opts.preview;
    const s = State.settings.sound;
    // master mute still respected for GENERATED alerts (preview bypasses it).
    // Behavior preserved: when muted and not preview, the entire alert path
    // (AutoRoute snapshot, counters, tones, speech) is skipped exactly as before,
    // and we record a single suppression event per channel for the audit.
    if (s === 'off' && !preview) {
      const dec = { allowed: false, reason: 'sound_off' };
      AudioAudit.log({ source: 'threshold_alert', action: 'tone_suppressed', pointId: point.id, pointType: point.type, distanceM: meters, decision: dec });
      AudioAudit.log({ source: 'threshold_alert', action: 'speech_suppressed', pointId: point.id, pointType: point.type, distanceM: meters, decision: dec });
      return;
    }
    // v23.18.17 — at the exact emission moment, write the decision
    // snapshot to point.lastAutoRouteDecision (AutoRoute mode only)
    // and emit the AUTO-ROUTE-EMIT line. The snapshot is what later
    // false-positive feedback uses to explain "why was this allowed?".
    try {
      if (typeof AutoRoute !== 'undefined' && AutoRoute.noteAlertEmitted) {
        AutoRoute.noteAlertEmitted(point, meters, 'threshold-cross');
      }
    } catch (e) {}
    // v22.102: level='ok' so ALERTs show green in the debug log
    logEvent('ALERT', `${point.name || Utils.typeLabel(point.type)} @ ${meters}m`, 'ok');
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
    const fireOnce = (i) => {
      const src = i === 0 ? 'threshold_alert' : 'threshold_alert_repeat';
      // Re-compute the decision at EMISSION time so muting between repeats is honored.
      const toneDec = this.beepDecision();
      const speakDec = this.speakDecision();
      // ----- tone channel -----
      // NOTE: preview bypasses the master mute; the original code played the
      // tone whenever sound !== 'off' (i.e. unless muted) regardless of
      // 'voice' mode, so to preserve outcomes exactly the runtime tone fires
      // whenever sound !== 'off'. We therefore gate on (s !== 'off') for the
      // ACTUAL play, but log the policy decision (beepDecision) for visibility.
      const tonePlays = preview || s !== 'off';
      if (preview) {
        this.playAlertSoundForType(point.type, { preview: true, auditSource: 'preview_test' });
        AudioAudit.log({ source: 'preview_test', action: 'preview_tone_played', pointId: point.id, pointType: point.type, distanceM: meters, previewBypass: true, reason: 'preview_bypass' });
      } else if (tonePlays) {
        this.playAlertSoundForType(point.type, { auditSource: src });
        AudioAudit.log({ source: src, action: 'tone_played', pointId: point.id, pointType: point.type, distanceM: meters, decision: { allowed: true, reason: null } });
      } else {
        AudioAudit.log({ source: src, action: 'tone_suppressed', pointId: point.id, pointType: point.type, distanceM: meters, decision: toneDec });
      }
      // ----- speech channel -----
      // Original behavior: voice plays only when a voice gender is selected
      // (independent of beep/voice/both — the master mute already gated above).
      const voiceOn = State.settings.voiceGender && State.settings.voiceGender !== 'none';
      if (preview) {
        if (voiceOn) this.say(text, { preview: true, auditSource: 'preview_test' });
        AudioAudit.log({ source: 'preview_test', action: 'preview_speech_spoken', pointId: point.id, pointType: point.type, distanceM: meters, previewBypass: true, reason: 'preview_bypass' });
      } else if (voiceOn) {
        this.say(text, { auditSource: src });
        AudioAudit.log({ source: src, action: 'speech_spoken', pointId: point.id, pointType: point.type, distanceM: meters, decision: { allowed: true, reason: null } });
      } else {
        AudioAudit.log({ source: src, action: 'speech_suppressed', pointId: point.id, pointType: point.type, distanceM: meters, decision: { allowed: false, reason: 'voice_gender_none' } });
      }
    };
    fireOnce(0);
    for (let i = 1; i < count; i++) {
      setTimeout(() => fireOnce(i), i * gapMs);
    }
  },
  /** v22.32: short single ping at user-configured frequency.
   *  Used by the proximity ping system (continuous stepped beep).
   *  Different from beep() — single tone, short duration, no per-type pattern.
   *  v22.34: also pulses the focused (#1) map marker visually in sync. */
  // `audit` (optional) carries { decision, pointId, pointType, distanceM,
  // band } so the proximity ping can be logged (throttled) at emission time.
  proximityPing(audit) {
    const ctx = this.ensure();
    if (!ctx) return;
    try {
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
      if (audit) AudioAudit.logProximity({ source: 'proximity_ping', action: 'tone_played', pointId: audit.pointId, pointType: audit.pointType, distanceM: audit.distanceM, decision: audit.decision, band: audit.band });
    } catch (e) {
      if (audit) AudioAudit.logProximity({ source: 'proximity_ping', action: 'tone_error', pointId: audit.pointId, pointType: audit.pointType, distanceM: audit.distanceM, error: String(e), reason: 'audio_context_error', band: audit.band });
    }
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
  updateProximityPing(pointId, distMeters, pointType) {
    // Audio-policy gate for the ping tone. Original enforcement only checked
    // sound==='off' (the ping plays in 'voice' mode too), so we preserve that
    // exact gate for the ACTUAL play while logging the same decision object.
    if (State.settings.sound === 'off') {
      this._proximityPointId = null;
      AudioAudit.logProximity({ source: 'proximity_ping', action: 'tone_suppressed', pointId: pointId, pointType: pointType, distanceM: distMeters, decision: { allowed: false, reason: 'sound_off' }, band: 'suppressed' });
      return;
    }
    if (State.settings.proximityPing === false) { this._proximityPointId = null; return; }
    // v23.7.3 — per-type heartbeat override. When the focused point's
    // type is explicitly toggled OFF in Edit Point, suppress its ping
    // even when the global proximityPing setting is ON. Missing entry
    // (typical for fresh installs) defaults to ON so existing users
    // hear no change.
    if (pointType) {
      const map = (State.settings && State.settings.heartbeatByType) || {};
      if (map[pointType] === false) { this._proximityPointId = null; return; }
    }
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
      this.proximityPing({ decision: { allowed: true, reason: null }, pointId: pointId, pointType: pointType, distanceM: distMeters, band: interval });
      this._lastProximityPing = now;
    }
  },

  // v23.6.7 merge-cleanup: removed the parallel agent's duplicate
  //   preview(soundId)          + _scheduleAndReturn(ctx, soundId)
  // which lived here and silently overwrote the catalogue-driven
  // Audio.preview(soundId, opts) defined earlier in this same object
  // literal at line ~2836. Object-literal duplicate keys keep only the
  // last definition in JS, so the hardcoded switch with 10 cases was
  // the one that ran — sounds 11–18 hit `default: return null` and
  // failed silently. The single catalogue-driven preview above is now
  // the only one.
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
    // v23.2.1: clear PERMISSION_DENIED flag on every retry so the
    // diag-strip warning clears if the user fixed the browser setting.
    State.gpsPermissionDenied = false;
    // v22.1: reset all runtime alert state for a fresh drive session.
    // Otherwise points that were "passed" in a previous session keep their
    // muted state and never alert again until reload.
    State.alertedMarkers.clear();
    State.lastDistByPoint.clear();
    State.minDistByPoint.clear(); // v22.15: reset passed-detection tracker
    State.passedPoints.clear();
    State.passedDistByPoint.clear(); // v23.8.7: re-approach tracker
    State.autoAnnouncedAhead.clear(); // v22.16: clear auto-announce history
    State.hereAnnouncedPoints.clear(); // v22.76: clear here-now history
    // v23.18.4 — AutoRoute movement-sequence gate uses a rolling
    // per-point distance history; reset it for the new trip session.
    try { if (typeof AutoRoute !== 'undefined' && AutoRoute.clearDistanceHistory) AutoRoute.clearDistanceHistory(); } catch (e) {}
    State.speedAlertWasOver = false;
    State.lastSpeedAlertZone = null;
    State.lastAnnouncedLimit = null; // v22.68: re-announce limit on new session
    State.speedBuffer = [];
    State.speedHistory = []; // v22.91: clear rolling histories on each GPS session
    State.headingHistory = [];
    if (Speed && Speed._lastAlerted) Speed._lastAlerted.clear(); // fresh hysteresis
    State.lastTripCaptureId = null; // v22.10: reset for new trip
    State.alertsFiredThisTrip = 0; // v22.12: reset alert counter for new trip
    // v22.36: reset U-turn detection state
    State.prevHeading = null;
    State.uTurnTicks = 0;
    // v22.38: reset confirmation queue for fresh trip
    Confirm.resetTrip();
    // v23.7.1: fresh feedback pass id so missed_feedback dedup works
    // per-session. Used by Confirm._attachMissedFeedback.
    State.feedbackPassId = Utils.uid();
    // v22.58: force the route to be refetched on the first tick of this
    // session — start of the route line is always the current GPS position.
    if (typeof MapView !== 'undefined' && MapView) MapView._routeForDestId = null;
    State.mode = 'gps';
    UI.setStatusMode('LIVE', 'live');
    await this.requestWakeLock();
    State.watchId = navigator.geolocation.watchPosition(
      pos => this.onTick(pos),
      err => {
        // v23.2.1: PERMISSION_DENIED (code 1) gets a persistent warning.
        // POSITION_UNAVAILABLE (2) and TIMEOUT (3) keep the v22 behavior
        // exactly: transient toast + err log + stop. No retry change.
        if (err && err.code === 1) {
          State.gpsPermissionDenied = true;
          const persistentMsg = 'Location permission is denied. Enable Location access in your device or browser settings, then press Start GPS again.';
          logEvent('GPS', '[GPS-PERMISSION-DENIED] ' + persistentMsg, 'err');
          Utils.toast('GPS: ' + (err.message || 'permission denied'), 'bad');
          try { UI.renderDiagStrip(); } catch (e) {}
          this.stop();
          return;
        }
        Utils.toast('GPS: ' + err.message, 'bad');
        logEvent('GPS', 'Error: ' + err.message, 'err');
        this.stop();
      },
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
      if (h != null) {
        State.deviceHeading = h;
        // v22.85: drive map rotation from compass events too, not just
        // GPS ticks — so the map rotates as the user turns the phone
        // even before Start GPS is tapped.
        if (typeof MapView !== 'undefined' && MapView._applyNavRotation) {
          MapView._applyNavRotation();
        }
        if (typeof UI !== 'undefined' && UI && MapView && MapView._updateLocationTriangle) {
          MapView._updateLocationTriangle();
        }
      }
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
    // v23.5.8: capture altitude diagnostics (additive — read-only).
    // Stored on State for the debug modal; NEVER feeds alerts, scoring,
    // route logic, or map markers. Null when the device omits vertical fix.
    State.altitude = (pos.coords && pos.coords.altitude != null && !isNaN(pos.coords.altitude))
      ? pos.coords.altitude : null;
    State.altitudeAccuracy = (pos.coords && pos.coords.altitudeAccuracy != null && !isNaN(pos.coords.altitudeAccuracy))
      ? pos.coords.altitudeAccuracy : null;
    State.gpsTimestamp = pos.timestamp || null;

    // v22.79: rate-limited GPS log — every 10s, not every tick.
    // v23.5.8: append altitude when present so the existing log doubles
    // as the altitude trace (no duplicate logger).
    if (!this._lastGpsLogAt || Date.now() - this._lastGpsLogAt > 10000) {
      this._lastGpsLogAt = Date.now();
      const altPart = (State.altitude != null)
        ? ` alt ${Math.round(State.altitude)}m${State.altitudeAccuracy != null ? ' ±' + Math.round(State.altitudeAccuracy) + 'm' : ''}`
        : '';
      logEvent('GPS', `Pos ${pos.coords.latitude.toFixed(4)},${pos.coords.longitude.toFixed(4)} ±${Math.round(pos.coords.accuracy)}m ${(pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) + 'km/h' : '')}${altPart}`.trim());
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

    // v22.91: feed the rolling speed history (≤ 30 s window). Used by
    // Speed.inferRoadTypeFromRollingSpeed so road-type scoring isn't
    // tricked by a single bad sample (e.g. traffic jam on a highway).
    {
      const _now = Date.now();
      State.speedHistory.push({ t: _now, kmh: State.speedMps * 3.6 });
      while (State.speedHistory.length && _now - State.speedHistory[0].t > 30000) {
        State.speedHistory.shift();
      }
    }

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
      // v22.91: feed rolling heading history (≤ 10s window)
      { const _now = Date.now();
        State.headingHistory.push({ t: _now, deg: State.heading });
        while (State.headingHistory.length && _now - State.headingHistory[0].t > 10000) State.headingHistory.shift();
      }
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
        // v22.91: feed rolling heading history (≤ 10s window)
        { const _now = Date.now();
          State.headingHistory.push({ t: _now, deg: State.heading });
          while (State.headingHistory.length && _now - State.headingHistory[0].t > 10000) State.headingHistory.shift();
        }
      }
    }

    // v23.14.0: append the resolved fix to the memory-only capture buffer
    // (keep the last 3). Read by CaptureMeta at capture time only. Never
    // persisted; never feeds alerts/route/markers/sound/scoring.
    {
      State.gpsFixBuffer.push({
        t: nowMs,
        lat: State.pos.lat,
        lng: State.pos.lng,
        accuracy: (typeof State.accuracy === 'number') ? State.accuracy : null,
        altitude: (State.altitude != null) ? State.altitude : null,
        altitudeAccuracy: (State.altitudeAccuracy != null) ? State.altitudeAccuracy : null,
        gpsTimestamp: (State.gpsTimestamp != null) ? State.gpsTimestamp : null,
        heading: (typeof State.heading === 'number') ? State.heading : null,
        headingSource: State.headingSource || null,
        speedMps: (typeof State.speedMps === 'number') ? State.speedMps : null,
      });
      while (State.gpsFixBuffer.length > 3) State.gpsFixBuffer.shift();
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
   4c. CAPTURE METADATA — v23.14.0 (additive, read-only)

   Attaches a structured, capture-time metadata block to every newly
   captured point and surfaces it (read-only) in the Edit Point modal.
   STRICTLY ADDITIVE / OBSERVABILITY ONLY:
     - Does NOT change alert triggering, captureBearing behavior,
       heading thresholds, GPS route logic, marker rendering, sound
       behavior, storage key names, or the persisted alert list
       (State.data.points remains the only persisted list).
     - headingDeg is metadata-only — it mirrors existing heading data
       but is never read back into captureBearing or any alert path.

   The 20 metadata fields (all present on a fresh capture):
     capturedAt, gpsTimestamp, accuracyM, altitudeM, altitudeAccuracyM,
     headingDeg, headingSource, directionQuality, captureMotionState,
     previousSimilarAlertIds, previousSimilarCount, repetitionCount,
     confirmedCount, falsePositiveCount, alertSoundId,
     configuredAlertDistanceM, sideOfRoadEstimate, sideOfRoadConfidence,
     heartbeatAtCapture, captureQuality
   ============================================================ */
const CaptureMetaConfig = {
  // The 20 metadata field names — single source of truth for the
  // capture writer, the migration normalizer, and the editor summary.
  FIELDS: [
    'capturedAt', 'gpsTimestamp', 'accuracyM', 'altitudeM', 'altitudeAccuracyM',
    'headingDeg', 'headingSource', 'directionQuality', 'captureMotionState',
    'previousSimilarAlertIds', 'previousSimilarCount', 'repetitionCount',
    'confirmedCount', 'falsePositiveCount', 'alertSoundId',
    'configuredAlertDistanceM', 'sideOfRoadEstimate', 'sideOfRoadConfidence',
    'heartbeatAtCapture', 'captureQuality',
  ],
  // Motion classification (km/h)
  MOTION_STATIONARY_KMH: 3,
  MOTION_SLOW_KMH: 20,
  // GPS quality bands (meters of horizontal accuracy)
  QUALITY_HIGH_M: 20,
  QUALITY_MEDIUM_M: 50,
  // "Previous similar" search — same type, within this radius; for
  // directional types also within this bearing window.
  SIMILAR_RADIUS_M: 60,
  SIMILAR_BEARING_DEG: 45,
  // v23.18.12 — Chain integrity. Sessions split when the time gap
  // between consecutive captures exceeds this many ms (20 min default).
  chainSessionGapMs: 20 * 60 * 1000,
  // Length of the prev/next chain windows (single source of truth —
  // CaptureMeta.CHAIN_LENGTH stays in sync via this constant).
  CHAIN_LENGTH: 3,
  // Short-ID alphabet (lowercase URL-safe alphanumeric, no look-alikes:
  // l/1/o/0 removed to make IDs human-readable on paper).
  SHORT_ID_ALPHABET: '23456789abcdefghjkmnpqrstuvwxyz',
  SHORT_ID_LENGTH: 6,
};

const CaptureMeta = {
  /** Snapshot the live GPS state at capture time. Pure read of State;
   *  mutates nothing. All numeric fields may be null. */
  getCurrentGpsCaptureSnapshot() {
    const buf = Array.isArray(State.gpsFixBuffer) ? State.gpsFixBuffer : [];
    const last = buf.length ? buf[buf.length - 1] : null;
    return {
      lat: (State.pos && typeof State.pos.lat === 'number') ? State.pos.lat : null,
      lng: (State.pos && typeof State.pos.lng === 'number') ? State.pos.lng : null,
      accuracy: (typeof State.accuracy === 'number') ? State.accuracy : null,
      altitude: (State.altitude != null && !isNaN(State.altitude)) ? State.altitude : null,
      altitudeAccuracy: (State.altitudeAccuracy != null && !isNaN(State.altitudeAccuracy)) ? State.altitudeAccuracy : null,
      gpsTimestamp: (State.gpsTimestamp != null) ? State.gpsTimestamp : null,
      heading: (typeof State.heading === 'number') ? State.heading : null,
      headingSource: State.headingSource || null,
      deviceHeading: (typeof State.deviceHeading === 'number') ? State.deviceHeading : null,
      speedMps: (typeof State.speedMps === 'number') ? State.speedMps : null,
      fixCount: buf.length,
      lastFix: last,
    };
  },

  /** Resolve a metadata-only heading for the capture. Reads (never
   *  writes) c.captureBearing and the GPS snapshot. captureBearing is
   *  the strongest signal (vector-averaged), then live GPS/derived
   *  heading, then the device compass. Returns { headingDeg, headingSource }
   *  with headingDeg rounded to 1 decimal or null. */
  resolveCaptureHeading(snapshot, c) {
    const cb = (c && typeof c.captureBearing === 'number' && !isNaN(c.captureBearing)) ? c.captureBearing : null;
    if (cb != null) {
      return { headingDeg: Math.round(cb * 10) / 10, headingSource: 'capture-bearing' };
    }
    if (snapshot && typeof snapshot.heading === 'number') {
      return {
        headingDeg: Math.round(snapshot.heading * 10) / 10,
        headingSource: snapshot.headingSource || 'gps',
      };
    }
    if (snapshot && typeof snapshot.deviceHeading === 'number') {
      return { headingDeg: Math.round(snapshot.deviceHeading * 10) / 10, headingSource: 'device' };
    }
    return { headingDeg: null, headingSource: null };
  },

  /** How trustworthy the captured direction is. One of
   *  good | fair | poor | none. */
  deriveDirectionQuality(snapshot, headingDeg, headingSource) {
    if (headingDeg == null) return 'none';
    const motion = this.deriveCaptureMotionState(snapshot);
    if (headingSource === 'capture-bearing') {
      return (motion === 'moving') ? 'good' : 'fair';
    }
    if (headingSource === 'gps') {
      return (motion === 'moving') ? 'good' : 'poor';
    }
    if (headingSource === 'derived') {
      return (motion === 'stationary') ? 'poor' : 'fair';
    }
    if (headingSource === 'device') return 'fair';
    return 'poor';
  },

  /** Motion class at capture time. stationary | slow | moving | unknown. */
  deriveCaptureMotionState(snapshot) {
    if (!snapshot || typeof snapshot.speedMps !== 'number') return 'unknown';
    const kmh = snapshot.speedMps * 3.6;
    if (kmh < CaptureMetaConfig.MOTION_STATIONARY_KMH) return 'stationary';
    if (kmh < CaptureMetaConfig.MOTION_SLOW_KMH) return 'slow';
    return 'moving';
  },

  /** GPS-quality grade from horizontal accuracy. high | medium | low | unknown. */
  deriveCaptureQuality(snapshot) {
    const acc = snapshot ? snapshot.accuracy : null;
    if (typeof acc !== 'number') return 'unknown';
    if (acc <= CaptureMetaConfig.QUALITY_HIGH_M) return 'high';
    if (acc <= CaptureMetaConfig.QUALITY_MEDIUM_M) return 'medium';
    return 'low';
  },

  /** Find already-stored points of the SAME type near the capture (and,
   *  for directional captures with a bearing, roughly the same bearing).
   *  Read-only scan of State.data.points; excludes the capture itself.
   *  Returns an array of matching point objects. */
  getPreviousSimilarCaptures(c) {
    if (!c || !State || !State.data || !Array.isArray(State.data.points)) return [];
    const out = [];
    const cb = (typeof c.captureBearing === 'number') ? c.captureBearing
      : (typeof c.headingDeg === 'number') ? c.headingDeg : null;
    for (const p of State.data.points) {
      if (!p || p === c) continue;
      if (c.id && p.id === c.id) continue;
      if (p.type !== c.type) continue;
      const distM = Utils.distKm(p, c) * 1000;
      if (isNaN(distM) || distM > CaptureMetaConfig.SIMILAR_RADIUS_M) continue;
      // Directional + both bearings known => require rough alignment.
      if (c.directional && p.directional && cb != null) {
        const pb = (typeof p.captureBearing === 'number') ? p.captureBearing
          : (typeof p.headingDeg === 'number') ? p.headingDeg : null;
        if (pb != null && typeof Speed !== 'undefined' && Speed.angleDiff
            && Speed.angleDiff(pb, cb) > CaptureMetaConfig.SIMILAR_BEARING_DEG) continue;
      }
      out.push(p);
    }
    return out;
  },

  /** Snapshot of the heartbeat-ping configuration that applies to this
   *  point's type AT CAPTURE TIME. Read-only; mirrors the settings the
   *  Edit Point heartbeat toggle controls. Changes nothing. */
  buildHeartbeatAtCapture(c) {
    const s = (State && State.settings) ? State.settings : {};
    const byType = (s && s.heartbeatByType) ? s.heartbeatByType : {};
    const type = (c && c.type) ? c.type : null;
    const typeEnabled = !(type && byType[type] === false);
    const globalPing = (s.proximityPing !== false);
    return {
      globalProximityPing: globalPing,
      typeEnabled: typeEnabled,
      effective: globalPing && typeEnabled,
      proximityStartM: (typeof s.proximityStartM === 'number') ? s.proximityStartM : 1000,
    };
  },

  /** The largest configured threshold-alert distance (meters). Reads
   *  State.settings.alertMarkersM without changing it. */
  getConfiguredAlertDistanceM() {
    const arr = (State && State.settings && Array.isArray(State.settings.alertMarkersM) && State.settings.alertMarkersM.length)
      ? State.settings.alertMarkersM
      : [2000, 1000, 500];
    let max = null;
    for (const m of arr) {
      if (typeof m === 'number' && (max == null || m > max)) max = m;
    }
    return max;
  },

  /** Estimate which side of the road the point sits on, from the
   *  user-set side when present. Returns { estimate, confidence }.
   *  estimate: 'left' | 'right' | 'unknown'. confidence: high|low|none. */
  _deriveSideOfRoad(c) {
    if (c && (c.side === 'left' || c.side === 'right')) {
      return { estimate: c.side, confidence: 'high' };
    }
    return { estimate: 'unknown', confidence: 'none' };
  },

  /** Resolve the sound mapped to this point's type, when the UI sound
   *  catalogue is available (capture-time only). Returns a soundId
   *  string or null. Never throws if UI is not yet loaded. */
  _resolveAlertSoundId(c) {
    try {
      if (typeof UI !== 'undefined' && UI && typeof UI.findSoundForType === 'function') {
        const id = UI.findSoundForType(c.type);
        return id ? id : null;
      }
    } catch (e) {}
    return null;
  },

  // v23.18.10 — capture-chain support. Each capture stores a backward
  // link to the 3 most recently captured points and (filled in later
  // as more captures arrive) a forward link to the next 3 points.
  // v23.18.12 — chain integrity: every point now also carries
  //   shortId (6-char, unique, stable)
  //   chainId  (ch_YYYYMMDD_HHmm_<4-char>, session-grouped by 20 min gap)
  // chain builders/refs use chainId + valid timestamps to reject
  // cross-session, self-referencing, or out-of-order links. Pure
  // metadata — alert engine never reads any of this.
  CHAIN_LENGTH: 3,

  /* ---------- shortId ---------- */
  /** Generate a SHORT_ID_LENGTH-char lowercase ID using SHORT_ID_ALPHABET.
   *  `taken` is a Set<string> of every id/shortId already in use; the
   *  function regenerates until a non-colliding value is produced. */
  generateShortId(taken) {
    const alpha = CaptureMetaConfig.SHORT_ID_ALPHABET;
    const len = CaptureMetaConfig.SHORT_ID_LENGTH;
    const max = 24; // bounded retry — alphabet^len is huge so this is safe
    for (let attempt = 0; attempt < max; attempt++) {
      let s = '';
      for (let i = 0; i < len; i++) {
        s += alpha.charAt(Math.floor(Math.random() * alpha.length));
      }
      if (!taken || !taken.has(s)) return s;
    }
    // Pathological fallback: extend length until unique.
    let s = '';
    for (let i = 0; i < len + 4; i++) {
      s += alpha.charAt(Math.floor(Math.random() * alpha.length));
    }
    return s;
  },
  /** Build a Set of every shortId currently in use across `points`.
   *  Also includes raw point.id values so a future shortId can't
   *  accidentally collide with an existing UUID-style id. */
  _collectTakenShortIds(points) {
    const taken = new Set();
    if (!Array.isArray(points)) return taken;
    for (const p of points) {
      if (!p) continue;
      if (typeof p.shortId === 'string' && p.shortId) taken.add(p.shortId);
      if (typeof p.id === 'string' && p.id) taken.add(p.id);
    }
    return taken;
  },
  /** Ensure `p` has a shortId. Returns the resolved shortId. Never
   *  overwrites an existing valid value. */
  ensureShortId(p, taken) {
    if (!p) return null;
    if (typeof p.shortId === 'string' && p.shortId && (!taken || !taken.has(p.shortId) || taken.has(p.shortId))) {
      // Already valid — nothing to do (the Set is populated externally).
      return p.shortId;
    }
    const s = this.generateShortId(taken);
    p.shortId = s;
    if (taken) taken.add(s);
    return s;
  },

  /* ---------- capturedAt ---------- */
  /** Return the capture timestamp in ms since epoch, or null if no
   *  usable value is on the point. Tries capturedAt, then createdAt,
   *  then numeric `timestamp`, then updatedAt. */
  getCapturedAtMs(p) {
    if (!p) return null;
    const tryParse = (v) => {
      if (v == null) return null;
      if (typeof v === 'number' && isFinite(v)) {
        // Heuristic: 10-digit values are seconds, otherwise ms
        return v < 1e12 ? v * 1000 : v;
      }
      if (typeof v === 'string' && v) {
        const ms = Date.parse(v);
        return isFinite(ms) ? ms : null;
      }
      return null;
    };
    return tryParse(p.capturedAt) ||
           tryParse(p.createdAt)  ||
           tryParse(p.timestamp)  ||
           tryParse(p.updatedAt)  ||
           null;
  },
  /** Normalize p.capturedAt to an ISO string. Preserves a valid
   *  existing value; falls through to createdAt / timestamp /
   *  updatedAt; final fallback is `now`. Set additively — never
   *  clobbers a valid historical timestamp. */
  ensureCapturedAt(p) {
    if (!p) return null;
    const existing = (typeof p.capturedAt === 'string' && Date.parse(p.capturedAt))
      ? p.capturedAt : null;
    if (existing) return existing;
    const ms = this.getCapturedAtMs(p);
    const iso = (ms != null) ? new Date(ms).toISOString() : new Date().toISOString();
    p.capturedAt = iso;
    return iso;
  },

  /* ---------- chainId ---------- */
  _pad2(n) { return (n < 10 ? '0' : '') + n; },
  /** Format a session prefix from a Date. */
  _chainIdPrefix(d) {
    return 'ch_' +
      d.getUTCFullYear() +
      this._pad2(d.getUTCMonth() + 1) +
      this._pad2(d.getUTCDate()) + '_' +
      this._pad2(d.getUTCHours()) +
      this._pad2(d.getUTCMinutes());
  },
  /** Generate a chainId based on `refMs` (defaults to now). The suffix
   *  is 4 random alphabet chars so two sessions in the same minute
   *  remain distinct. */
  generateChainId(refMs) {
    const ms = (typeof refMs === 'number' && isFinite(refMs)) ? refMs : Date.now();
    const d = new Date(ms);
    const alpha = CaptureMetaConfig.SHORT_ID_ALPHABET;
    let suf = '';
    for (let i = 0; i < 4; i++) {
      suf += alpha.charAt(Math.floor(Math.random() * alpha.length));
    }
    return this._chainIdPrefix(d) + '_' + suf;
  },
  /** Return the chainId for a NEW capture `c`. If the most recent
   *  point in `points` was captured within chainSessionGapMs of `c`,
   *  reuse its chainId; otherwise mint a new one. */
  resolveChainIdForNewCapture(c, points) {
    const cMs = this.getCapturedAtMs(c) || Date.now();
    if (typeof c.chainId === 'string' && c.chainId) return c.chainId;
    let latest = null, latestMs = -Infinity;
    if (Array.isArray(points)) {
      for (const p of points) {
        if (!p || p === c) continue;
        if (typeof p.chainId !== 'string' || !p.chainId) continue;
        const t = this.getCapturedAtMs(p);
        if (t != null && t > latestMs) { latestMs = t; latest = p; }
      }
    }
    if (latest && (cMs - latestMs) <= CaptureMetaConfig.chainSessionGapMs) {
      return latest.chainId;
    }
    return this.generateChainId(cMs);
  },

  /* ---------- chain refs / link builders ---------- */
  /** Compact reference object stored in chainPrev3 / chainNext3. */
  _chainRef(p) {
    if (!p || !p.id) return null;
    return {
      id: p.id,
      shortId: (typeof p.shortId === 'string' && p.shortId) ? p.shortId : null,
      chainId: (typeof p.chainId === 'string' && p.chainId) ? p.chainId : null,
      lat: (typeof p.lat === 'number') ? Math.round(p.lat * 1e6) / 1e6 : null,
      lng: (typeof p.lng === 'number') ? Math.round(p.lng * 1e6) / 1e6 : null,
      type: p.type || null,
      capturedAt: (typeof p.capturedAt === 'string' && p.capturedAt) ? p.capturedAt : null,
      captureBearing: (typeof p.captureBearing === 'number') ? Math.round(p.captureBearing * 10) / 10 : null,
    };
  },
  /** Stable comparator: oldest first. Ties broken by shortId, then id. */
  _byCapturedAt(a, b) {
    const at = CaptureMeta.getCapturedAtMs(a) || 0;
    const bt = CaptureMeta.getCapturedAtMs(b) || 0;
    if (at !== bt) return at - bt;
    const as = (a.shortId || a.id || '');
    const bs = (b.shortId || b.id || '');
    return as < bs ? -1 : as > bs ? 1 : 0;
  },
  /** True if `p` is a valid chain-link candidate (lat/lng numeric and
   *  capturedAt parseable). */
  _validChainCandidate(p) {
    if (!p || !p.id) return false;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
    if (CaptureMeta.getCapturedAtMs(p) == null) return false;
    return true;
  },
  /** Build chainPrev3 for `c`. Only same-chainId, strictly-older,
   *  geometry-valid, non-self points are eligible. Returns at most
   *  CHAIN_LENGTH refs, oldest first. */
  buildChainPrev3(c, points) {
    if (!c || !Array.isArray(points)) return [];
    const cMs = this.getCapturedAtMs(c);
    if (cMs == null) return [];
    const cChain = c.chainId || null;
    const candidates = [];
    for (const p of points) {
      if (!p || p === c || p.id === c.id) continue;
      if (!this._validChainCandidate(p)) continue;
      if (cChain && p.chainId && p.chainId !== cChain) continue;
      const t = this.getCapturedAtMs(p);
      if (t == null || t >= cMs) continue;
      candidates.push(p);
    }
    candidates.sort(this._byCapturedAt);
    return candidates.slice(-this.CHAIN_LENGTH).map(p => this._chainRef(p)).filter(Boolean);
  },
  /** Same constraints as buildChainPrev3 but going forward in time.
   *  Used by the integrity migration when seeding chainNext3 on
   *  existing points. */
  buildChainNext3(c, points) {
    if (!c || !Array.isArray(points)) return [];
    const cMs = this.getCapturedAtMs(c);
    if (cMs == null) return [];
    const cChain = c.chainId || null;
    const candidates = [];
    for (const p of points) {
      if (!p || p === c || p.id === c.id) continue;
      if (!this._validChainCandidate(p)) continue;
      if (cChain && p.chainId && p.chainId !== cChain) continue;
      const t = this.getCapturedAtMs(p);
      if (t == null || t <= cMs) continue;
      candidates.push(p);
    }
    candidates.sort(this._byCapturedAt);
    return candidates.slice(0, this.CHAIN_LENGTH).map(p => this._chainRef(p)).filter(Boolean);
  },
  /** Back-link a new point into the chainNext3 of every prev neighbor
   *  that shares its chainId. Refuses cross-chain or self refs. */
  linkChainNeighbors(newPoint, points) {
    if (!newPoint || !Array.isArray(points)) return 0;
    const prev = Array.isArray(newPoint.chainPrev3) ? newPoint.chainPrev3 : [];
    if (!prev.length) return 0;
    const newRef = this._chainRef(newPoint);
    if (!newRef) return 0;
    const byId = new Map();
    for (const p of points) { if (p && p.id) byId.set(p.id, p); }
    let touched = 0;
    for (const ref of prev) {
      if (!ref || !ref.id) continue;
      const neighbor = byId.get(ref.id);
      if (!neighbor || neighbor === newPoint) continue;
      // Reject cross-chain back-links.
      if (newPoint.chainId && neighbor.chainId && neighbor.chainId !== newPoint.chainId) continue;
      if (!Array.isArray(neighbor.chainNext3)) neighbor.chainNext3 = [];
      if (neighbor.chainNext3.some(x => x && x.id === newRef.id)) continue;
      neighbor.chainNext3.unshift(newRef);
      if (neighbor.chainNext3.length > this.CHAIN_LENGTH) {
        neighbor.chainNext3.length = this.CHAIN_LENGTH;
      }
      touched++;
    }
    return touched;
  },

  /* ---------- legacy v23.18.10 migration kept for back-compat ---------- */
  /** Pre-integrity migration. Still used by the v23.18.10 flag path
   *  for any environment that already ran it; the new integrity
   *  migration below (migrateChainIntegrity) is the source of truth
   *  from v23.18.12 onwards and rebuilds the chains under the
   *  integrity rules. */
  migrateChain(points) {
    if (!Array.isArray(points) || !points.length) return 0;
    const sorted = [];
    for (const p of points) {
      if (!p || !p.id || !(p.capturedAt || p.createdAt)) continue;
      sorted.push(p);
    }
    sorted.sort(this._byCapturedAt);
    let touched = 0;
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      let changed = false;
      if (p.chainPrev3 === undefined) {
        const start = Math.max(0, i - this.CHAIN_LENGTH);
        p.chainPrev3 = sorted.slice(start, i).map(q => this._chainRef(q)).filter(Boolean);
        changed = true;
      }
      if (p.chainNext3 === undefined) {
        const end = Math.min(sorted.length, i + 1 + this.CHAIN_LENGTH);
        p.chainNext3 = sorted.slice(i + 1, end).map(q => this._chainRef(q)).filter(Boolean);
        changed = true;
      }
      if (changed) touched++;
    }
    return touched;
  },

  /* ---------- v23.18.12 chain integrity migration ---------- */
  /** Walks every point and:
   *    1) Ensures shortId (uniquely regenerates duplicates).
   *    2) Ensures capturedAt (normalized to ISO).
   *    3) Assigns chainId by 20-minute gap grouping.
   *    4) Rebuilds chainPrev3 / chainNext3 under the integrity rules.
   *  Returns a counts object suitable for diagnostics. */
  migrateChainIntegrity(points) {
    const counts = { points: 0, repaired: 0, duplicateShortIds: 0,
                     invalidTimestamps: 0, crossChainLinks: 0, selfLinks: 0,
                     chainsAssigned: 0 };
    if (!Array.isArray(points) || !points.length) return counts;

    // ── Pass 1: shortId uniqueness ───────────────────────────────
    const seenShort = new Set();
    const taken = this._collectTakenShortIds(points);
    for (const p of points) {
      if (!p) continue;
      counts.points++;
      let sid = (typeof p.shortId === 'string' && p.shortId) ? p.shortId : null;
      if (sid && seenShort.has(sid)) {
        const oldSid = sid;
        // Duplicate — regenerate.
        taken.delete(oldSid); // we'll reissue & re-add via ensureShortId
        p.shortId = undefined;
        sid = null;
        counts.duplicateShortIds++;
        try { logEvent('CHAIN-MIGRATION', `repaired duplicate shortId old=${oldSid} point=${p.id || '(no-id)'}`); } catch (e) {}
      }
      if (!sid) {
        sid = this.ensureShortId(p, taken);
        counts.repaired++;
      }
      seenShort.add(sid);
    }

    // ── Pass 2: capturedAt normalization ─────────────────────────
    for (const p of points) {
      if (!p) continue;
      const had = typeof p.capturedAt === 'string' && Date.parse(p.capturedAt);
      if (!had) {
        const before = p.capturedAt;
        this.ensureCapturedAt(p);
        if (before !== p.capturedAt) counts.repaired++;
        if (this.getCapturedAtMs(p) == null) counts.invalidTimestamps++;
      }
    }

    // ── Pass 3: chainId via 20-min gap grouping ──────────────────
    // Sort points by capturedAt for the walk. We never assign chainId
    // to points that still lack a parseable timestamp.
    const sortedAll = points.slice().sort(this._byCapturedAt);
    let activeChainId = null;
    let lastMs = null;
    for (const p of sortedAll) {
      if (!p) continue;
      const t = this.getCapturedAtMs(p);
      if (t == null) continue;
      // Preserve an existing valid chainId so subsequent edits are
      // stable; only mint a chainId when one is missing.
      if (typeof p.chainId === 'string' && p.chainId) {
        activeChainId = p.chainId; lastMs = t; continue;
      }
      if (activeChainId == null || lastMs == null ||
          (t - lastMs) > CaptureMetaConfig.chainSessionGapMs) {
        activeChainId = this.generateChainId(t);
        counts.chainsAssigned++;
      }
      p.chainId = activeChainId;
      lastMs = t;
    }

    // ── Pass 4: rebuild chainPrev3 / chainNext3 under integrity ──
    // We always rebuild here: the v23.18.10 chains may include
    // cross-chain or out-of-order links from before integrity rules.
    for (const p of points) {
      if (!p) continue;
      const before = JSON.stringify([p.chainPrev3 || null, p.chainNext3 || null]);
      p.chainPrev3 = this.buildChainPrev3(p, points);
      p.chainNext3 = this.buildChainNext3(p, points);
      if (JSON.stringify([p.chainPrev3, p.chainNext3]) !== before) counts.repaired++;
    }

    return counts;
  },

  /** Read-only integrity report. Emits a single compact diagnostic
   *  line; never mutates `points`. Useful for confirming a clean
   *  state after migration. */
  validateChainIntegrity(points) {
    const out = { points: 0, repaired: 0, duplicateShortIds: 0,
                  invalidTimestamps: 0, crossChainLinks: 0, selfLinks: 0,
                  missingShortIds: 0, missingChainIds: 0 };
    if (!Array.isArray(points)) return out;
    const seen = new Set();
    for (const p of points) {
      if (!p) continue;
      out.points++;
      if (typeof p.shortId !== 'string' || !p.shortId) out.missingShortIds++;
      else if (seen.has(p.shortId)) out.duplicateShortIds++;
      else seen.add(p.shortId);
      if (typeof p.chainId !== 'string' || !p.chainId) out.missingChainIds++;
      if (this.getCapturedAtMs(p) == null) out.invalidTimestamps++;
      const pMs = this.getCapturedAtMs(p);
      const lists = [
        [Array.isArray(p.chainPrev3) ? p.chainPrev3 : [], 'prev'],
        [Array.isArray(p.chainNext3) ? p.chainNext3 : [], 'next'],
      ];
      for (const [list, dir] of lists) {
        for (const ref of list) {
          if (!ref) continue;
          if (ref.id === p.id) { out.selfLinks++; continue; }
          if (p.chainId && ref.chainId && ref.chainId !== p.chainId) out.crossChainLinks++;
          const rMs = Date.parse(ref.capturedAt || '');
          if (isFinite(rMs) && pMs != null) {
            if (dir === 'prev' && rMs >= pMs) out.invalidTimestamps++;
            if (dir === 'next' && rMs <= pMs) out.invalidTimestamps++;
          }
        }
      }
    }
    try {
      logEvent('CHAIN-INTEGRI',
        `points=${out.points} repaired=${out.repaired}` +
        ` duplicateShortIds=${out.duplicateShortIds}` +
        ` invalidTimestamps=${out.invalidTimestamps}` +
        ` crossChainLinks=${out.crossChainLinks}` +
        ` selfLinks=${out.selfLinks}`);
    } catch (e) {}
    return out;
  },

  /** Attach the full 20-field capture-metadata block to a capture object.
   *  ADDITIVE: only fills fields that are currently undefined, so a
   *  re-finalize never clobbers an earlier value. NEVER writes
   *  captureBearing. Returns the same object. */
  applyCaptureMetadata(c) {
    if (!c || typeof c !== 'object') return c;
    const snap = this.getCurrentGpsCaptureSnapshot();
    const hd = this.resolveCaptureHeading(snap, c);
    const similar = this.getPreviousSimilarCaptures(c);
    const side = this._deriveSideOfRoad(c);

    const set = (k, v) => { if (c[k] === undefined) c[k] = v; };

    set('capturedAt', c.createdAt || new Date().toISOString());
    set('gpsTimestamp', snap.gpsTimestamp);
    set('accuracyM', snap.accuracy);
    set('altitudeM', snap.altitude);
    set('altitudeAccuracyM', snap.altitudeAccuracy);
    set('headingDeg', hd.headingDeg);
    set('headingSource', hd.headingSource);
    set('directionQuality', this.deriveDirectionQuality(snap, hd.headingDeg, hd.headingSource));
    set('captureMotionState', this.deriveCaptureMotionState(snap));
    set('previousSimilarAlertIds', similar.map(p => p.id).filter(Boolean));
    set('previousSimilarCount', similar.length);
    set('repetitionCount', 0);
    set('confirmedCount', (typeof c.confirmedCount === 'number') ? c.confirmedCount : 0);
    set('falsePositiveCount', (typeof c.falsePositiveCount === 'number') ? c.falsePositiveCount : 0);
    set('alertSoundId', this._resolveAlertSoundId(c));
    set('configuredAlertDistanceM', this.getConfiguredAlertDistanceM());
    set('sideOfRoadEstimate', side.estimate);
    set('sideOfRoadConfidence', side.confidence);
    set('heartbeatAtCapture', this.buildHeartbeatAtCapture(c));
    set('captureQuality', this.deriveCaptureQuality(snap));
    // v23.18.12 — chain integrity. Order matters: shortId →
    // capturedAt → chainId → chainPrev3 → chainNext3. Each builder
    // below depends on the fields the previous step normalized.
    const allPts = (State && State.data && Array.isArray(State.data.points)) ? State.data.points : [];
    if (typeof c.shortId !== 'string' || !c.shortId) {
      const taken = this._collectTakenShortIds(allPts);
      this.ensureShortId(c, taken);
    }
    this.ensureCapturedAt(c);
    if (typeof c.chainId !== 'string' || !c.chainId) {
      c.chainId = this.resolveChainIdForNewCapture(c, allPts);
    }
    set('chainPrev3', this.buildChainPrev3(c, allPts));
    set('chainNext3', []);
    return c;
  },

  /** Merge capture metadata from an incoming capture into an existing
   *  (already stored) point during a true merge. Read-only on the
   *  incoming point. Rules:
   *    - Ensure the existing point carries all 20 fields (normalize).
   *    - Bump repetitionCount (this confirming sighting).
   *    - Union previousSimilarAlertIds; refresh previousSimilarCount.
   *    - Mirror confirmedCount / falsePositiveCount from the point's own
   *      counters (kept in sync by the existing merge logic).
   *    - captureBearing: DO NOT overwrite unless the existing point has
   *      no direction (null captureBearing, not directional) AND the
   *      incoming point carries a usable bearing. Only then fill it
   *      (and the metadata-only headingDeg) from the incoming capture. */
  mergeCaptureMetadata(existingPoint, incomingPoint) {
    if (!existingPoint || typeof existingPoint !== 'object') return existingPoint;
    // Guarantee the existing point has the full metadata block first.
    this.normalize(existingPoint);

    existingPoint.repetitionCount = (typeof existingPoint.repetitionCount === 'number')
      ? existingPoint.repetitionCount + 1 : 1;

    // Keep the metadata mirrors in step with the point's live counters.
    if (typeof existingPoint.confirmedCount === 'number') {
      // confirmedCount is already maintained by the surrounding merge
      // code; just make sure it is never undefined.
    } else {
      existingPoint.confirmedCount = 0;
    }
    if (typeof existingPoint.falsePositiveCount !== 'number') {
      existingPoint.falsePositiveCount = (typeof existingPoint.rejectionCount === 'number')
        ? existingPoint.rejectionCount : 0;
    }

    // Union of previous-similar ids (incoming + the freshly recomputed set).
    const ids = new Set(Array.isArray(existingPoint.previousSimilarAlertIds) ? existingPoint.previousSimilarAlertIds : []);
    if (incomingPoint && Array.isArray(incomingPoint.previousSimilarAlertIds)) {
      incomingPoint.previousSimilarAlertIds.forEach(id => { if (id) ids.add(id); });
    }
    existingPoint.previousSimilarAlertIds = Array.from(ids);
    existingPoint.previousSimilarCount = existingPoint.previousSimilarAlertIds.length;

    // captureBearing fill — strictly guarded so existing bearings and
    // captureBearing behavior are never altered. ONLY a real incoming
    // captureBearing counts as "usable direction" here; the metadata-only
    // headingDeg (which may be seeded from instantaneous GPS) must NOT
    // leak into captureBearing.
    const incomingBearing = (incomingPoint && typeof incomingPoint.captureBearing === 'number')
      ? incomingPoint.captureBearing
      : null;
    const existingHasDirection = (typeof existingPoint.captureBearing === 'number') || existingPoint.directional === true;
    if (!existingHasDirection && incomingBearing != null) {
      existingPoint.captureBearing = incomingBearing;
      existingPoint.headingDeg = Math.round(incomingBearing * 10) / 10;
    }
    return existingPoint;
  },

  /** One-time additive normalization for an existing stored point.
   *  Fills any missing metadata field, deriving from legacy fields.
   *  NEVER deletes a legacy field and NEVER touches captureBearing.
   *  Returns true when at least one field was added. */
  normalize(p) {
    if (!p || typeof p !== 'object') return false;
    let changed = false;
    const set = (k, v) => { if (p[k] === undefined) { p[k] = v; changed = true; } };

    set('capturedAt', p.createdAt || null);
    set('gpsTimestamp', null);
    set('accuracyM', (typeof p.gpsAccuracy === 'number') ? p.gpsAccuracy : null);
    set('altitudeM', null);
    set('altitudeAccuracyM', null);
    // headingDeg mirrors a legacy captureBearing (copy bearing -> heading,
    // never the reverse).
    set('headingDeg', (typeof p.captureBearing === 'number') ? p.captureBearing : null);
    set('headingSource', (typeof p.captureBearing === 'number') ? 'legacy-bearing' : null);
    set('directionQuality', (typeof p.captureBearing === 'number') ? 'fair' : 'none');
    set('captureMotionState', 'unknown');
    set('previousSimilarAlertIds', []);
    set('previousSimilarCount', 0);
    // repetitionCount / confirmedCount / falsePositiveCount inferred from
    // whatever legacy confidence / confirmation counters exist.
    set('repetitionCount', (typeof p.confirmationCount === 'number') ? p.confirmationCount
      : (typeof p.confidence === 'number') ? Math.max(0, p.confidence - 1) : 0);
    set('confirmedCount', (typeof p.confirmationCount === 'number') ? p.confirmationCount
      : (typeof p.confidence === 'number') ? Math.max(0, p.confidence - 1) : 0);
    set('falsePositiveCount', (typeof p.rejectionCount === 'number') ? p.rejectionCount : 0);
    set('alertSoundId', null);
    set('configuredAlertDistanceM', this.getConfiguredAlertDistanceM());
    const side = this._deriveSideOfRoad(p);
    set('sideOfRoadEstimate', side.estimate);
    set('sideOfRoadConfidence', side.confidence);
    set('heartbeatAtCapture', this.buildHeartbeatAtCapture(p));
    set('captureQuality', (typeof p.gpsAccuracy === 'number')
      ? this.deriveCaptureQuality({ accuracy: p.gpsAccuracy })
      : 'unknown');
    return changed;
  },

  /** Bulk additive normalization over a points array (migration entry).
   *  Returns the number of points that gained at least one field. */
  migrateAdditive(points) {
    if (!Array.isArray(points)) return 0;
    let touched = 0;
    for (const p of points) {
      if (this.normalize(p)) touched++;
    }
    return touched;
  },
};

// v23.14.0: one-time additive capture-metadata normalization. This is
// the "equivalent" of a Storage.migrate() step — it runs HERE, after the
// CaptureMeta namespace exists, because Storage.migrate() executes at
// module load (before this namespace is defined). Mirrors the existing
// migrate() conventions exactly: localStorage-flag gated, additive only,
// never deletes legacy fields, never touches captureBearing, and persists
// through Storage.save into the single State.data.points list.
(function migrateCaptureMetadata() {
  try {
    if (localStorage.getItem('roadAlert.v23.14.0.captureMetaFields')) return;
    if (State && State.data && Array.isArray(State.data.points)) {
      const n = CaptureMeta.migrateAdditive(State.data.points);
      if (n > 0) {
        Storage.save(Storage.KEYS.data, State.data);
        console.log('v23.14.0: added capture-metadata fields on', n, 'points');
      }
    }
    localStorage.setItem('roadAlert.v23.14.0.captureMetaFields', '1');
  } catch (e) { console.warn('capture-metadata migration', e); }
})();
// v23.18.10 — one-shot bulk fill of chainPrev3 / chainNext3 across every
// existing point. Same pattern as the v23.14.0 migration above: flag-
// gated in localStorage, additive only, never overwrites an existing
// chain field. Runs after CaptureMeta is defined so the helper is
// available; persists through Storage.save.
(function migrateCaptureChain() {
  try {
    if (localStorage.getItem('roadAlert.v23.18.10.captureChain')) return;
    if (State && State.data && Array.isArray(State.data.points)) {
      const n = CaptureMeta.migrateChain(State.data.points);
      if (n > 0) {
        Storage.save(Storage.KEYS.data, State.data);
        console.log('v23.18.10: filled capture chain on', n, 'point(s)');
      }
    }
    localStorage.setItem('roadAlert.v23.18.10.captureChain', '1');
  } catch (e) { console.warn('capture-chain migration', e); }
})();
// v23.18.12 — chain integrity migration. One-shot, flag-gated, runs
// after CaptureMeta is defined. Ensures every point has a unique
// shortId, a normalized capturedAt, and a chainId grouped by the
// 20-min session-gap rule; rebuilds chainPrev3 / chainNext3 under
// the integrity rules (same chainId, valid timestamp order, valid
// geometry, no self refs). Idempotent: re-running is a no-op.
(function migrateChainIntegrity() {
  try {
    if (localStorage.getItem('roadAlert.v23.18.11.captureChainIntegrity')) return;
    if (State && State.data && Array.isArray(State.data.points)) {
      const r = CaptureMeta.migrateChainIntegrity(State.data.points);
      if (r && (r.repaired || r.chainsAssigned || r.duplicateShortIds)) {
        Storage.save(Storage.KEYS.data, State.data);
        console.log('v23.18.12: chain integrity', r);
      }
      try { CaptureMeta.validateChainIntegrity(State.data.points); } catch (e) {}
    }
    localStorage.setItem('roadAlert.v23.18.11.captureChainIntegrity', '1');
  } catch (e) { console.warn('chain-integrity migration', e); }
})();
// v23.18.11 — backfill captureBearing on EVERY capture type. Older
// non-camera / non-speed_change points were saved without a bearing.
// Recover the value from the existing capture-metadata heading
// (p.headingDeg) or the legacy p.heading alias. Additive: never
// overwrites an existing captureBearing.
(function migrateUniversalCaptureBearing() {
  try {
    if (localStorage.getItem('roadAlert.v23.18.11.captureBearingAll')) return;
    if (State && State.data && Array.isArray(State.data.points)) {
      let touched = 0;
      for (const p of State.data.points) {
        if (!p) continue;
        if (typeof p.captureBearing === 'number' && isFinite(p.captureBearing)) continue;
        let b = null;
        if (typeof p.headingDeg === 'number' && isFinite(p.headingDeg)) b = p.headingDeg;
        else if (typeof p.heading === 'number' && isFinite(p.heading)) b = p.heading;
        if (b != null) { p.captureBearing = b; touched++; }
      }
      if (touched > 0) {
        Storage.save(Storage.KEYS.data, State.data);
        console.log('v23.18.11: backfilled captureBearing on', touched, 'point(s)');
      }
    }
    localStorage.setItem('roadAlert.v23.18.11.captureBearingAll', '1');
  } catch (e) { console.warn('captureBearing backfill', e); }
})();

/* ============================================================
   4b. INTELLIGENCE ENGINE — v23.3.x (Phase 3, shadow-by-default)

   Centralized alert-decision engine. Evaluates every candidate
   observation against confidence, direction, route relevance, age,
   stale decay (type-aware), GPS quality, and timing. Produces an
   intelligenceScore plus a structured reason map.

   Operating modes:
     legacy : engine present but inert (default)
     shadow : runs in parallel with legacy alert path, logs only
     active : intelligence has veto power over legacy alerts
              (legacy still detects threshold crossings; intelligence
              gates whether Audio.alert is actually called)

   Trusted-observation floor:
     If a candidate is "trusted" (confidence ≥ 3, or
     confirmations.length ≥ 3) then GPS quality, stale decay,
     route relevance, and timing CANNOT individually or
     collectively suppress it. ONLY a strong direction mismatch
     on a directional observation may suppress a trusted point.

   Performance:
     evaluate() is pure-math, single allocation per call. Called
     at most once per focused candidate per GPS tick (≈1 Hz).
   ============================================================ */
const IntelligenceConfig = {
  // Trust tier thresholds
  TRUSTED_CONFIDENCE: 3,
  TRUSTED_CONFIRMATIONS: 3,

  // Score thresholds
  ALERT_THRESHOLD: 50,   // intelligenceWouldAlert when score ≥ this
  TRUSTED_FLOOR: 30,     // trusted points may never score below this in active mode

  // Direction
  DIRECTION_MATCH_DEG: 45,
  DIRECTION_OPPOSITE_DEG: 135,
  STRONG_MISMATCH_DEG: 135, // only mismatch this severe may suppress a trusted point

  // GPS quality
  GPS_GOOD_M: 30,
  GPS_DEGRADED_M: 100,
  GPS_POOR_M: 300,

  // Distance / timing
  IDEAL_ALERT_FAR_M: 800,    // upper end of useful alert window
  IDEAL_ALERT_NEAR_M: 200,   // lower end
  TOO_FAR_M: 2000,
  TOO_CLOSE_M: 80,

  // Type-aware stale decay. Half-life days (Infinity = no decay).
  // Fixed infrastructure decays slowly or not at all. Transient types
  // decay faster but cannot suppress trusted observations alone.
  DECAY_HALFLIFE_DAYS: {
    speed_change: Infinity,   // permanent speed-limit sign
    redlight: Infinity,       // traffic-light camera = fixed infrastructure
    bump: Infinity,           // road feature
    speed_camera: 730,        // fixed cameras dominate; 2-year half-life is generous
    hazard: 30,               // transient by nature
    petrol: 365,
    service: 365,
    parking: 365,
    rest: 365,
    other: 180,
  },
  // Floor: even after decay, factor never drops below this. Stale decay
  // cannot fully zero a candidate's freshness contribution.
  DECAY_FACTOR_FLOOR: 0.25,
};

const IntelligenceEngine = {
  /** Throttle for per-tick [INTEL-SCORE] heartbeat lines. Disagreement
   *  events bypass this throttle so they're never lost. */
  _lastScoreLogAt: 0,
  _lastModeLogged: null,

  /** Returns true if the candidate has crossed any of the trust tiers. */
  isTrusted(point) {
    if (!point) return false;
    if (typeof point.confidence === 'number' && point.confidence >= IntelligenceConfig.TRUSTED_CONFIDENCE) return true;
    if (Array.isArray(point.confirmations) && point.confirmations.length >= IntelligenceConfig.TRUSTED_CONFIRMATIONS) return true;
    return false;
  },

  /** Type-aware freshness factor in [DECAY_FACTOR_FLOOR, 1].
   *  Returns 1 if no createdAt or no decay rule. */
  freshness(point) {
    if (!point || !point.createdAt) return 1;
    const half = IntelligenceConfig.DECAY_HALFLIFE_DAYS[point.type];
    if (half == null || half === Infinity) return 1;
    const ageMs = Date.now() - Date.parse(point.createdAt);
    if (!isFinite(ageMs) || ageMs <= 0) return 1;
    const ageDays = ageMs / 86_400_000;
    // exponential half-life decay
    const f = Math.pow(0.5, ageDays / half);
    return Math.max(IntelligenceConfig.DECAY_FACTOR_FLOOR, f);
  },

  /** GPS quality tier: 'good' / 'degraded' / 'poor' / 'unknown'. */
  gpsQualityTier(accuracy) {
    if (accuracy == null) return 'unknown';
    if (accuracy <= IntelligenceConfig.GPS_GOOD_M) return 'good';
    if (accuracy <= IntelligenceConfig.GPS_DEGRADED_M) return 'degraded';
    return 'poor';
  },

  /** Pure-math evaluator. NO side effects, NO mutations, NO logs.
   *  Caller (Alerts.tick) emits the structured logs.
   *
   *  Inputs:
   *    point — candidate observation (NOT mutated)
   *    user  — { lat, lng, heading, speedKmh, accuracy, distanceToPointM,
   *              isOnActiveRoute (bool|null) }
   *
   *  Output: {
   *    intelligenceScore: number 0..100,
   *    intelligenceWouldAlert: boolean,
   *    trusted: boolean,
   *    reasons: { distance, direction, route, confidence, freshness,
   *               gps, timing, suppression: [strings], primary: string },
   *    contributions: { distance, direction, route, confidence,
   *                     freshness, gpsPenalty, timingPenalty }
   *  } */
  evaluate(point, user) {
    const reasons = {
      distance: '', direction: '', route: '', confidence: '',
      freshness: '', gps: '', timing: '',
      suppression: [], primary: '',
    };
    const contrib = {
      distance: 0, direction: 0, route: 0, confidence: 0,
      freshness: 0, gpsPenalty: 0, timingPenalty: 0,
    };

    const trusted = IntelligenceEngine.isTrusted(point);
    const directional = point && point.directional === true;
    const distM = (user && typeof user.distanceToPointM === 'number')
      ? user.distanceToPointM
      : Utils.distKm(user, point) * 1000;

    // ---- distance / timing contribution ----
    if (distM > IntelligenceConfig.TOO_FAR_M) {
      contrib.distance = 0;
      contrib.timingPenalty = 25;
      reasons.distance = `far ${Math.round(distM)}m`;
      reasons.timing = `too early (${Math.round(distM)}m > ${IntelligenceConfig.TOO_FAR_M}m)`;
    } else if (distM < IntelligenceConfig.TOO_CLOSE_M) {
      contrib.distance = 5;
      contrib.timingPenalty = 15;
      reasons.distance = `near ${Math.round(distM)}m`;
      reasons.timing = `too late (${Math.round(distM)}m < ${IntelligenceConfig.TOO_CLOSE_M}m)`;
    } else if (distM <= IntelligenceConfig.IDEAL_ALERT_FAR_M && distM >= IntelligenceConfig.IDEAL_ALERT_NEAR_M) {
      // ideal window — distance gives full marks
      contrib.distance = 30;
      reasons.distance = `ideal ${Math.round(distM)}m`;
      reasons.timing = 'within ideal window';
    } else if (distM > IntelligenceConfig.IDEAL_ALERT_FAR_M) {
      const span = IntelligenceConfig.TOO_FAR_M - IntelligenceConfig.IDEAL_ALERT_FAR_M;
      const offset = distM - IntelligenceConfig.IDEAL_ALERT_FAR_M;
      contrib.distance = Math.round(30 * (1 - offset / span));
      reasons.distance = `pre-ideal ${Math.round(distM)}m`;
      reasons.timing = 'a bit early';
    } else {
      const span = IntelligenceConfig.IDEAL_ALERT_NEAR_M - IntelligenceConfig.TOO_CLOSE_M;
      const offset = distM - IntelligenceConfig.TOO_CLOSE_M;
      contrib.distance = Math.round(30 * (offset / span));
      reasons.distance = `post-ideal ${Math.round(distM)}m`;
      reasons.timing = 'getting late';
    }

    // ---- confidence contribution ----
    const conf = (typeof point.confidence === 'number') ? point.confidence : 1;
    const confirms = Array.isArray(point.confirmations) ? point.confirmations.length : 0;
    if (conf >= IntelligenceConfig.TRUSTED_CONFIDENCE || confirms >= IntelligenceConfig.TRUSTED_CONFIRMATIONS) {
      contrib.confidence = 35;
      reasons.confidence = `trusted (c=${conf}, confirms=${confirms})`;
    } else if (conf >= 2 || confirms >= 2) {
      contrib.confidence = 20;
      reasons.confidence = `probable (c=${conf}, confirms=${confirms})`;
    } else {
      contrib.confidence = 8;
      reasons.confidence = `possible (c=${conf}, confirms=${confirms})`;
    }

    // ---- direction contribution ----
    let directionMismatchDeg = null;
    if (directional && point.captureBearing != null && user && user.heading != null
        && Speed && Speed.isHeadingReliable && Speed.isHeadingReliable(user.speedKmh)) {
      directionMismatchDeg = Speed.angleDiff(user.heading, point.captureBearing);
      if (directionMismatchDeg <= IntelligenceConfig.DIRECTION_MATCH_DEG) {
        contrib.direction = 15;
        reasons.direction = `match (Δ${Math.round(directionMismatchDeg)}°)`;
      } else if (directionMismatchDeg >= IntelligenceConfig.STRONG_MISMATCH_DEG) {
        contrib.direction = -40;
        reasons.direction = `opposite (Δ${Math.round(directionMismatchDeg)}°)`;
      } else {
        contrib.direction = -10;
        reasons.direction = `oblique (Δ${Math.round(directionMismatchDeg)}°)`;
      }
    } else if (!directional) {
      contrib.direction = 0;
      reasons.direction = 'non-directional';
    } else if (point.captureBearing == null) {
      contrib.direction = 0;
      reasons.direction = 'no captureBearing on point';
    } else {
      contrib.direction = 0;
      reasons.direction = 'heading unreliable';
    }

    // ---- route relevance contribution ----
    if (user && user.isOnActiveRoute === true) {
      contrib.route = 15;
      reasons.route = 'on active route';
    } else if (user && user.isOnActiveRoute === false) {
      contrib.route = -5;
      reasons.route = 'off active route';
    } else {
      contrib.route = 0;
      reasons.route = 'no active route';
    }

    // ---- freshness / stale decay contribution ----
    const freshFactor = IntelligenceEngine.freshness(point);
    contrib.freshness = Math.round(15 * freshFactor);
    if (freshFactor >= 0.95) {
      reasons.freshness = 'fresh';
    } else {
      const ageDays = point.createdAt
        ? Math.round((Date.now() - Date.parse(point.createdAt)) / 86_400_000)
        : null;
      const halfLife = IntelligenceConfig.DECAY_HALFLIFE_DAYS[point.type];
      reasons.freshness = `decayed factor=${freshFactor.toFixed(2)}` +
        (ageDays != null ? ` (age=${ageDays}d` : '') +
        (halfLife !== Infinity ? `, half-life=${halfLife}d)` : ')');
    }

    // ---- GPS quality penalty ----
    const gpsTier = IntelligenceEngine.gpsQualityTier(user && user.accuracy);
    if (gpsTier === 'poor') {
      contrib.gpsPenalty = 15;
      reasons.gps = `poor (±${Math.round(user.accuracy)}m)`;
    } else if (gpsTier === 'degraded') {
      contrib.gpsPenalty = 7;
      reasons.gps = `degraded (±${Math.round(user.accuracy)}m)`;
    } else if (gpsTier === 'good') {
      contrib.gpsPenalty = 0;
      reasons.gps = `good (±${Math.round(user.accuracy)}m)`;
    } else {
      contrib.gpsPenalty = 5;
      reasons.gps = 'no GPS accuracy';
    }

    // ---- score assembly ----
    let score =
      contrib.distance +
      contrib.confidence +
      contrib.direction +
      contrib.route +
      contrib.freshness -
      contrib.gpsPenalty -
      contrib.timingPenalty;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // ---- trusted-observation floor enforcement ----
    let intelligenceWouldAlert = score >= IntelligenceConfig.ALERT_THRESHOLD;
    if (trusted) {
      // Only strong directional mismatch may suppress a trusted observation.
      const strongMismatch = directional && directionMismatchDeg != null
        && directionMismatchDeg >= IntelligenceConfig.STRONG_MISMATCH_DEG;
      if (strongMismatch) {
        intelligenceWouldAlert = false;
        reasons.suppression.push('trusted but strong direction mismatch — allowed suppression');
        reasons.primary = 'opposite-direction trusted';
      } else {
        // Floor protection: trusted observations alert as long as they're
        // not directional opposite. GPS, stale decay, route relevance,
        // weak timing cannot suppress.
        if (score < IntelligenceConfig.ALERT_THRESHOLD) {
          reasons.suppression.push('would suppress but TRUSTED FLOOR overrides');
        }
        intelligenceWouldAlert = true;
        score = Math.max(score, IntelligenceConfig.TRUSTED_FLOOR);
        reasons.primary = 'trusted-floor protected';
      }
    } else if (!intelligenceWouldAlert) {
      // Non-trusted suppression — record reason
      const primary =
        contrib.direction <= -30 ? 'opposite-direction' :
        contrib.timingPenalty >= 20 ? 'timing window' :
        contrib.gpsPenalty >= 10 ? 'GPS quality' :
        contrib.freshness < 5 ? 'stale decay' :
        contrib.confidence <= 8 ? 'low confidence' :
        'low score';
      reasons.suppression.push(primary);
      reasons.primary = primary;
    } else {
      reasons.primary = 'composite score above threshold';
    }

    return {
      intelligenceScore: score,
      intelligenceWouldAlert,
      trusted,
      directional,
      directionMismatchDeg,
      gpsTier,
      freshness: freshFactor,
      reasons,
      contributions: contrib,
    };
  },

  /** Build user-state object for evaluate(). Reads State once. */
  buildUserState(distanceToPointM, isOnActiveRoute) {
    return {
      lat: State.pos ? State.pos.lat : null,
      lng: State.pos ? State.pos.lng : null,
      heading: State.heading,
      speedKmh: (State.speedMps || 0) * 3.6,
      accuracy: State.accuracy,
      distanceToPointM,
      isOnActiveRoute,
    };
  },

  /** Throttled [INTEL-SCORE] log helper. Used by Alerts.tick to emit
   *  a heartbeat without flooding the 500-entry buffer. */
  logScoreLine(point, result) {
    const now = Date.now();
    if (now - this._lastScoreLogAt < 5000) return;
    this._lastScoreLogAt = now;
    const r = result;
    const breakdown = `d=${r.contributions.distance} c=${r.contributions.confidence}` +
      ` dir=${r.contributions.direction} rt=${r.contributions.route} fr=${r.contributions.freshness}` +
      ` -gps=${r.contributions.gpsPenalty} -t=${r.contributions.timingPenalty}`;
    logEvent('INTEL-SCORE',
      `[INTEL-SCORE] ${point.id || '?'} type=${point.type} score=${r.intelligenceScore}` +
      ` would=${r.intelligenceWouldAlert ? 'YES' : 'NO'}` +
      ` trusted=${r.trusted ? 'Y' : 'N'} · ${breakdown}` +
      ` · ${r.reasons.primary}`);
  },

  /** Log a mode transition. Called from the Settings handler. */
  logModeTransition(prev, next) {
    if (prev === next) return;
    logEvent('INTEL-MODE', `[INTEL-MODE] ${prev || 'unset'} → ${next}`, 'ok');
    this._lastModeLogged = next;
    // v23.4.1: any mode change resets the runaway counter so a fresh
    // session doesn't carry over an old streak.
    IntelligenceEngine._suppressionStreak = 0;
    IntelligenceEngine._recentSuppressions = [];
  },

  /** v23.4.1 — Active-mode runaway guard.
   *  Counter increments only when intelligence suppresses a legacy
   *  threshold-crossing alert. Counter resets on:
   *    - any allowed alert (legacy + intel agree to fire)
   *    - mode change
   *    - app cold start (in-memory only; nothing persisted)
   *  When >3 consecutive suppressions accumulate without a fired alert,
   *  the engine reverts itself to Legacy mode for the rest of this
   *  driving session. */
  _suppressionStreak: 0,
  _recentSuppressions: [],
  RUNAWAY_THRESHOLD: 4, // >3 means counter reaches 4

  /** Called from Alerts.tick when active mode suppresses a legacy
   *  threshold-crossing alert. Records diagnostic snapshot and may
   *  trigger automatic revert. */
  noteSuppression(point, evalResult, distM, ring) {
    const entry = {
      ts: new Date().toISOString(),
      pointId: point && point.id,
      type: point && point.type,
      distanceM: Math.round(distM),
      ring,
      confidence: (point && typeof point.confidence === 'number') ? point.confidence : 0,
      score: evalResult ? evalResult.intelligenceScore : null,
      reasonsPrimary: evalResult && evalResult.reasons ? evalResult.reasons.primary : null,
      suppressionReasons: (evalResult && evalResult.reasons && evalResult.reasons.suppression) ? evalResult.reasons.suppression.slice() : [],
      contributions: evalResult ? Object.assign({}, evalResult.contributions) : null,
    };
    IntelligenceEngine._recentSuppressions.push(entry);
    if (IntelligenceEngine._recentSuppressions.length > 3) {
      IntelligenceEngine._recentSuppressions.shift();
    }
    IntelligenceEngine._suppressionStreak++;

    // Detailed structured log per spec — point ID, type, distance,
    // confidence, reason, score breakdown.
    const breakdown = entry.contributions
      ? `d=${entry.contributions.distance} c=${entry.contributions.confidence} dir=${entry.contributions.direction} rt=${entry.contributions.route} fr=${entry.contributions.freshness} -gps=${entry.contributions.gpsPenalty} -t=${entry.contributions.timingPenalty}`
      : '';
    logEvent('INTEL-SUPPRESS',
      `[INTEL-SUPPRESS] ${entry.pointId} type=${entry.type} @ ${entry.distanceM}m (ring ${ring}m)` +
      ` conf=${entry.confidence} score=${entry.score} primary="${entry.reasonsPrimary}"` +
      (breakdown ? ` · ${breakdown}` : '') +
      ` · streak ${IntelligenceEngine._suppressionStreak}/${IntelligenceEngine.RUNAWAY_THRESHOLD}`,
      'err');

    if (IntelligenceEngine._suppressionStreak >= IntelligenceEngine.RUNAWAY_THRESHOLD) {
      IntelligenceEngine._triggerRunawayRevert();
    }
  },

  /** Called when an alert fires (legacy + intelligence agree to alert).
   *  Resets the suppression streak. */
  noteAlertFired() {
    if (IntelligenceEngine._suppressionStreak > 0) {
      logEvent('INTEL', `[INTEL] alert fired — suppression streak reset (was ${IntelligenceEngine._suppressionStreak})`);
    }
    IntelligenceEngine._suppressionStreak = 0;
    IntelligenceEngine._recentSuppressions = [];
  },

  /** Conservative safety trip — revert to Legacy and log the last 3
   *  suppression reasons. The user can re-enable Active from Settings;
   *  a runaway revert is NOT proof of engine failure, just a guardrail. */
  _triggerRunawayRevert() {
    const snapshot = IntelligenceEngine._recentSuppressions.slice();
    const detail = snapshot.map(e =>
      `${e.pointId}(${e.type},c=${e.confidence},score=${e.score},"${e.reasonsPrimary}")`
    ).join(' · ');
    logEvent('INTEL-SUPPRESS',
      `[INTEL-SUPPRESS] runaway-suppression-revert · streak=${IntelligenceEngine._suppressionStreak} · last3: ${detail || '(none)'}`,
      'err');
    logEvent('INTEL-MODE', `[INTEL-MODE] active → legacy (runaway revert)`, 'err');
    State.settings.intelMode = 'legacy';
    try { State.saveSettings(); } catch (e) {}
    IntelligenceEngine._suppressionStreak = 0;
    IntelligenceEngine._recentSuppressions = [];
    // Update visible UI when available
    try { if (typeof UI !== 'undefined' && UI.syncSettings) UI.syncSettings(); } catch (e) {}
    try { if (typeof UI !== 'undefined' && UI.applyIntelIndicator) UI.applyIntelIndicator(); } catch (e) {}
    try { Utils.toast('Alert engine reverted to Legacy (runaway guard)', 'bad'); } catch (e) {}
  },

  /** Boot-time sanity check — if intelMode is non-legacy but the engine
   *  cannot evaluate a trivial input, fall back to Legacy and log.
   *  Returns the effective mode. */
  bootCheck() {
    const mode = (State && State.settings && State.settings.intelMode) || 'legacy';
    if (mode === 'legacy') return 'legacy';
    try {
      // Trivial sanity evaluation — must not throw.
      const probe = IntelligenceEngine.evaluate(
        { id: '_probe', type: 'other', lat: 0, lng: 0, confidence: 1, createdAt: new Date().toISOString() },
        { lat: 0, lng: 0, heading: null, speedKmh: 0, accuracy: null, distanceToPointM: 500, isOnActiveRoute: null }
      );
      if (!probe || typeof probe.intelligenceScore !== 'number') throw new Error('probe returned malformed result');
      return mode;
    } catch (e) {
      logEvent('INTEL-MODE', `[INTEL-MODE] fallback-to-legacy · ${e && e.message || e}`, 'err');
      State.settings.intelMode = 'legacy';
      try { State.saveSettings(); } catch (e2) {}
      return 'legacy';
    }
  },
};

/* ============================================================
   5. ALERTS — threshold crossing
   ============================================================ */
const Alerts = {
  /** Currently effective speed limit (km/h). Manual override wins.
   *  v22.91: primary lookup uses Speed.findBestSpeedPoint — a confidence
   *  score combining distance + ahead + heading + roadType. Score >= 60
   *  triggers an alert (subject to hysteresis in Alerts.tick).
   *  PROXIMITY FALLBACK preserves v22.68 behavior so the LIMIT card
   *  isn't blank while you're driving BETWEEN two speed-change points
   *  — closest point within 1 km wins as the visible value even if
   *  it doesn't pass the alert threshold.
   *  v22.103: fallback now requires heading alignment with the
   *  candidate's captureBearing. Turning onto a side road (heading
   *  mismatch ≥45°) clears the display until a point on the NEW road
   *  scores high enough — or one was previously captured there. */
  currentLimit() {
    if (State.manualLimit != null) return State.manualLimit;
    if (!State.pos) return null;
    const userState = {
      lat: State.pos.lat,
      lng: State.pos.lng,
      heading: State.heading,
      speedKmh: (State.speedMps || 0) * 3.6,
      avgSpeedKmh: State.avgSpeedKmh(),
    };
    const best = Speed.findBestSpeedPoint(userState, State.data.points);
    if (best) return best.limit;
    // v22.103: proximity fallback — 1 km radius + heading match
    const headingReliable = Speed.isHeadingReliable(userState.speedKmh);
    const candidates = State.data.points
      .filter(p => p.type === 'speed_change' && p.status !== 'no')
      .map(p => ({ p, dKm: Utils.distKm(State.pos, p), lim: typeof p.speedLimit === 'number' ? p.speedLimit : p.limit }))
      .filter(x => typeof x.lim === 'number' && x.dKm < 1)
      .filter(x => {
        // Heading guard: only match when going the same direction as
        // the captured sign. If the user's heading isn't reliable
        // (stopped / very slow), allow through. If the point has no
        // captureBearing (legacy data), allow through.
        if (!headingReliable) return true;
        if (x.p.captureBearing == null) return true;
        return Speed.headingMatches(userState.heading, x.p.captureBearing, 45);
      })
      .sort((a, b) => a.dKm - b.dKm);
    return candidates.length ? candidates[0].lim : null;
  },

  /** v22.91: helper used by Alerts.tick. Like currentLimit but returns
   *  the FULL match (point + score + reasons) so the caller can apply
   *  hysteresis at the per-point level. Null if no point scores >= 60. */
  bestScoredSpeedPoint() {
    if (!State.pos) return null;
    const userState = {
      lat: State.pos.lat,
      lng: State.pos.lng,
      heading: State.heading,
      speedKmh: (State.speedMps || 0) * 3.6,
      avgSpeedKmh: State.avgSpeedKmh(),
    };
    return Speed.findBestSpeedPoint(userState, State.data.points);
  },

  /** v23.8.4 — types that have a permanent visual / contextual role
   *  (map markers, LIMIT sign feed) but should NOT drive per-point
   *  peeps, NEXT AHEAD card focus, proximity heartbeat, here-now voice,
   *  flash-near border, or auto-announce. They're road features, not
   *  alert events:
   *    speed_change   — fed via the LIMIT sign + over-speed alert
   *    traffic_light  — static road feature; not an alert
   *    gate           — static road feature; not an alert */
  SILENT_ALERT_TYPES: new Set(['speed_change', 'traffic_light', 'gate']),

  /** v23.8.5 — types that DO appear in NEXT AHEAD, get auto-announced
   *  ("mobile cam in 500 meters"), and fire the standard threshold-
   *  cross alerts, but should NOT drive the continuous proximity
   *  heartbeat. Mobile cams in particular are common enough that the
   *  stepped 5-Hz heartbeat became noisy without adding info beyond
   *  the existing distance announcements. */
  PROXIMITY_PING_EXCLUDED_TYPES: new Set(['mobile_camera']),

  /* ============================================================
     v23.10 — DIRECTION-AWARE CAMERA ALERT FILTERING
     Announce a directional camera only when it faces the driver's
     current travel direction. Opposite-facing cameras stay on the map
     (markers, score, passed-state untouched) but their audio + "is here"
     announcements are suppressed. Pure announcement gate — never deletes,
     hides, re-scores, or marks a point passed. Reuses the existing
     captureBearing metadata, Observations.effectiveHeading() heading
     source, and Speed.isSameDirection()/angleDiff() math.
     ============================================================ */
  DirectionFilter: {
    // Only these directional camera types are filtered. All other alert
    // types (and non-camera points) keep their existing behavior.
    CAMERA_TYPES: new Set(['speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera']),
    // Same-direction tolerance (deg). A camera "faces our way" when the
    // angular difference between travel heading and camera bearing is
    // within this. Configurable constant — not a hardcoded magic number.
    TOLERANCE_DEG: 45,
    // Below this speed (km/h) GPS heading is unreliable; never make a
    // strict opposite-direction call (spec 1 + 7 + scenario H).
    LOW_SPEED_KMH: 5,
    // Throttle window for [DIRECTION-FILTER] log lines, per point, so the
    // per-tick scan can't flood the 500-entry debug log.
    LOG_THROTTLE_MS: 30000,
    // v23.16 capture-sequence validation: only previous camera captures
    // whose timestamp is within this window of the evaluated point's
    // capture time count as the "same driving session". Configurable —
    // not hardcoded inside the inference logic.
    CAPTURE_SEQUENCE_WINDOW_MINUTES: 20,
    // Use at most the latest N relevant captures (newest first).
    CAPTURE_SEQUENCE_MAX: 3,
    // Need at least this many usable captures before the sequence is
    // allowed to influence the decision at all (spec 5 / scenario F).
    CAPTURE_SEQUENCE_MIN_USABLE: 2,
    // pointId -> { reason, t } of the last logged decision (throttling).
    _lastLog: new Map(),
  },

  /** Camera direction source of truth. Mirrors the field precedence used
   *  by the radar / directional-camera / heading-compatibility logic
   *  (Observations.headingCompatible): captureBearing first, then the
   *  legacy `heading` field. Returns null when neither is a usable number. */
  cameraBearing(p) {
    if (!p) return null;
    if (typeof p.captureBearing === 'number' && !isNaN(p.captureBearing)) return p.captureBearing;
    if (typeof p.heading === 'number' && !isNaN(p.heading)) return p.heading;
    return null;
  },

  /** Boolean announcement gate (back-compat wrapper used by tick(),
   *  checkAutoAnnounce(), and the proximity ping). Delegates to the rich
   *  decision so callers that only need yes/no are unchanged. */
  cameraDirectionAllows(p, meters) {
    return this.cameraDirectionDecision(p, meters).allowed;
  },

  /** Parse the best-available capture timestamp (ms epoch) from a point.
   *  Precedence: capturedAt → createdAt → updatedAt → timestamp. Returns
   *  null when none parse — callers then skip sequence validation (spec 2:
   *  missing time metadata must NOT fail closed). */
  _pointTimeMs(p) {
    if (!p) return null;
    for (const c of [p.capturedAt, p.createdAt, p.updatedAt, p.timestamp]) {
      if (c == null) continue;
      const t = (typeof c === 'number') ? c : Date.parse(c);
      if (typeof t === 'number' && !isNaN(t)) return t;
    }
    return null;
  },

  /** Circular mean of a list of bearings (deg), or null. */
  _circularMean(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    let sx = 0, sy = 0, n = 0;
    for (const a of arr) {
      if (typeof a !== 'number' || isNaN(a)) continue;
      const r = a * Math.PI / 180; sx += Math.cos(r); sy += Math.sin(r); n++;
    }
    if (!n || (sx === 0 && sy === 0)) return null;
    return Math.round(((Math.atan2(sy, sx) * 180 / Math.PI) % 360 + 360) % 360);
  },

  /** v23.16 — capture-sequence direction inference. Inspects the latest
   *  CAPTURE_SEQUENCE_MAX directional-camera captures recorded within
   *  CAPTURE_SEQUENCE_WINDOW_MINUTES of the evaluated point's own capture
   *  time, and infers whether that "driving session" agrees (same) or
   *  disagrees (opposite) with the evaluated camera's stored bearing.
   *
   *  Two independent signals, combined by majority vote:
   *    (A) stored capture-bearing consistency — each prior capture's
   *        bearing vs the evaluated camera bearing, and
   *    (B) movement bearing — bearing from the OLDEST → NEWEST capture
   *        coordinate (the session's travel direction) vs the camera.
   *  Candidates are sorted by timestamp DESCENDING and the newest 3 used;
   *  the movement-bearing subset is re-sorted ascending so oldest→newest
   *  is well defined.
   *
   *  Returns { support:'same'|'opposite'|'mixed'|'unavailable',
   *            sequenceBearing, count, ids, times, bearings, sameVotes,
   *            oppVotes, windowMinutes, note }. 'same'/'opposite' are only
   *            reported when at least 2 votes are unanimous (clear
   *            evidence); any conflict yields 'mixed'. Never mutates points
   *            and never throws on missing metadata. */
  captureSequenceDirection(point, camB) {
    const DF = this.DirectionFilter;
    const tol = DF.TOLERANCE_DEG;
    const out = {
      support: 'unavailable', sequenceBearing: null, count: 0,
      ids: [], times: [], bearings: [], sameVotes: 0, oppVotes: 0,
      windowMinutes: DF.CAPTURE_SEQUENCE_WINDOW_MINUTES, note: '',
    };
    if (camB == null) { out.note = 'no-eval-bearing'; return out; }
    const refT = this._pointTimeMs(point);
    if (refT == null) { out.note = 'no-eval-timestamp'; return out; }
    const winMs = DF.CAPTURE_SEQUENCE_WINDOW_MINUTES * 60 * 1000;
    const pool = (State && State.data && Array.isArray(State.data.points)) ? State.data.points : [];

    const collect = (sameTypeOnly) => {
      const arr = [];
      for (const q of pool) {
        if (!q || q === point || q.id === point.id) continue;
        if (q.status === 'no') continue;
        if (!DF.CAMERA_TYPES.has(q.type)) continue;       // directional camera group only
        if (q.directional === false) continue;
        if (sameTypeOnly && q.type !== point.type) continue;
        if (typeof q.lat !== 'number' && typeof q.lng !== 'number'
            && this.cameraBearing(q) == null) continue;   // nothing usable to contribute
        const t = this._pointTimeMs(q);
        if (t == null) continue;                          // missing timestamp → skip
        if (Math.abs(t - refT) > winMs) continue;         // outside 20-min window → skip
        arr.push({ q, t });
      }
      return arr;
    };

    // Prefer type-specific history; broaden to all directional camera
    // types only if the type-specific set is too narrow (spec 1).
    let cands = collect(true);
    if (cands.length < DF.CAPTURE_SEQUENCE_MIN_USABLE) cands = collect(false);
    if (cands.length < DF.CAPTURE_SEQUENCE_MIN_USABLE) {
      out.note = 'fewer-than-min'; out.count = cands.length; return out;
    }

    cands.sort((a, b) => b.t - a.t);                      // newest first
    const used = cands.slice(0, DF.CAPTURE_SEQUENCE_MAX);
    out.count = used.length;
    out.ids = used.map(x => x.q.id);
    out.times = used.map(x => new Date(x.t).toISOString());
    out.bearings = used.map(x => this.cameraBearing(x.q));

    let sameVotes = 0, oppVotes = 0;
    // (A) stored capture-bearing consistency.
    for (const b2 of out.bearings) {
      if (typeof b2 !== 'number' || isNaN(b2)) continue;
      const d = Speed.angleDiff(b2, camB);
      if (d <= tol) sameVotes++;
      else if (d >= 180 - tol) oppVotes++;
    }
    // (B) movement bearing from oldest → newest capture coordinate.
    let moveB = null;
    const geo = used.filter(x => typeof x.q.lat === 'number' && typeof x.q.lng === 'number')
                    .sort((a, b) => a.t - b.t);
    if (geo.length >= 2) {
      const a = geo[0].q, z = geo[geo.length - 1].q;
      if (a.lat !== z.lat || a.lng !== z.lng) {
        moveB = Speed.bearingBetween(a.lat, a.lng, z.lat, z.lng);
        const d = Speed.angleDiff(moveB, camB);
        if (d <= tol) sameVotes++;
        else if (d >= 180 - tol) oppVotes++;
      }
    }

    out.sequenceBearing = (moveB != null)
      ? Math.round(((moveB % 360) + 360) % 360)
      : this._circularMean(out.bearings);
    out.sameVotes = sameVotes; out.oppVotes = oppVotes;

    const total = sameVotes + oppVotes;
    if (total === 0) { out.support = 'unavailable'; out.note = 'no-directional-signal'; }
    else if (sameVotes >= 2 && oppVotes === 0) out.support = 'same';
    else if (oppVotes >= 2 && sameVotes === 0) out.support = 'opposite';
    else out.support = 'mixed';
    return out;
  },

  /** Rich direction decision. Live current-heading validation first; when
   *  the heading is unknown or clearly opposite, the capture sequence is
   *  consulted. Policy (spec 5): the sequence may RESCUE an alert the live
   *  heading would suppress (clear contradicting evidence), and — only when
   *  the live heading is unavailable — may itself suppress on CLEAR opposite
   *  evidence. The sequence never overrides a same-direction heading, never
   *  suppresses at low speed, and never suppresses on weak/mixed evidence.
   *  Returns the decision object (spec 6); never mutates the point. */
  cameraDirectionDecision(p, meters) {
    const DF = this.DirectionFilter;
    const tol = DF.TOLERANCE_DEG;
    const res = {
      allowed: true, reason: 'not-camera',
      userBearing: null, cameraBearing: null, sequenceBearing: null,
      sequenceCount: 0, angularDifference: null,
      sequenceWindowMinutes: DF.CAPTURE_SEQUENCE_WINDOW_MINUTES,
    };
    if (!p || !DF.CAMERA_TYPES.has(p.type)) return res;          // not a directional camera type
    if (p.bidirectional === true) { res.reason = 'bidirectional'; return res; }
    if (p.directional === false)  { res.reason = 'non-directional'; return res; }

    const camB = this.cameraBearing(p);
    const userB = Observations.effectiveHeading();
    const speedKmh = (State.speedMps || 0) * 3.6;
    const dist = (meters != null) ? meters
               : (State.pos ? Utils.distKm(State.pos, p) * 1000 : null);
    res.userBearing = userB;
    res.cameraBearing = camB;

    // Fallback (spec 8): camera direction metadata missing → preserve
    // existing behavior; do not run the sequence against a null bearing.
    if (camB == null) {
      res.reason = 'missing-bearing';
      this._logDecision(res, p, dist, null);
      return res;
    }
    // Spec 1 + 7 + scenario H/K: too slow for a trustworthy heading →
    // never make a strict opposite call (sequence cannot suppress here).
    if (!Speed.isHeadingReliable(speedKmh) && speedKmh < DF.LOW_SPEED_KMH) {
      res.reason = 'low-speed-fallback';
      if (userB != null) res.angularDifference = Math.round(Speed.angleDiff(userB, camB));
      this._logDecision(res, p, dist, null);
      return res;
    }

    // Heading unknown (spec 5 / scenarios C, D): lean on capture sequence.
    if (userB == null) {
      const seq = this.captureSequenceDirection(p, camB);
      res.sequenceBearing = seq.sequenceBearing;
      res.sequenceCount = seq.count;
      if (seq.support === 'same') { res.allowed = true; res.reason = 'sequence-supported'; }
      else if (seq.support === 'opposite') { res.allowed = false; res.reason = 'sequence-conflict'; }
      else { res.allowed = true; res.reason = 'unknown-heading'; }   // missing/mixed → preserve behavior
      this._logDecision(res, p, dist, seq);
      return res;
    }

    const diff = Speed.angleDiff(userB, camB);
    res.angularDifference = Math.round(diff);

    // Live heading says same direction → always allow (sequence may not
    // override a same-direction heading — safety).
    if (Speed.isSameDirection(userB, camB, tol)) {
      res.reason = 'same-direction';
      this._logDecision(res, p, dist, null);
      return res;
    }
    // Live heading clearly opposite → suppress UNLESS a clear capture
    // sequence contradicts it (rescue, reduces false negatives).
    if (diff >= 180 - tol) {
      const seq = this.captureSequenceDirection(p, camB);
      res.sequenceBearing = seq.sequenceBearing;
      res.sequenceCount = seq.count;
      if (seq.support === 'same') { res.allowed = true; res.reason = 'sequence-supported'; }
      else { res.allowed = false; res.reason = 'opposite-direction'; }
      this._logDecision(res, p, dist, seq);
      return res;
    }
    // Oblique middle band — not clearly opposite. Allow (spec 5).
    res.reason = 'oblique';
    this._logDecision(res, p, dist, null);
    return res;
  },

  /** Throttled [DIRECTION-FILTER] diagnostic logger. Logs at most once per
   *  point per `LOG_THROTTLE_MS` unless the decision REASON changes. When a
   *  capture sequence was evaluated, its evidence (ids / timestamps /
   *  bearings / inferred bearing / support) is appended. */
  _logDecision(res, p, dist, seq) {
    const DF = this.DirectionFilter;
    const prev = DF._lastLog.get(p.id);
    const now = Date.now();
    if (prev && prev.reason === res.reason && (now - prev.t) < DF.LOG_THROTTLE_MS) return;
    DF._lastLog.set(p.id, { reason: res.reason, t: now });

    const ub = (res.userBearing == null) ? 'n/a' : Math.round(res.userBearing) + '°';
    const cb = (res.cameraBearing == null) ? 'n/a' : Math.round(res.cameraBearing) + '°';
    const ad = (res.angularDifference == null) ? 'n/a' : res.angularDifference + '°';
    const dm = (dist == null) ? 'n/a' : Math.round(dist) + 'm';
    const tol = DF.TOLERANCE_DEG + '°';
    const base = `id=${p.id} type=${p.type} cameraBearing=${cb} userBearing=${ub}` +
                 ` angularDiff=${ad} tolerance=${tol} dist=${dm}`;
    let line, level = '';
    switch (res.reason) {
      case 'same-direction':
        line = `[DIRECTION-FILTER] allowed same-direction camera · ${base}`; level = 'ok'; break;
      case 'opposite-direction':
        line = `[DIRECTION-FILTER] suppressed opposite-direction camera · ${base}`; break;
      case 'oblique':
        line = `[DIRECTION-FILTER] oblique angle — not suppressing · ${base}`; break;
      case 'missing-bearing':
        line = `[DIRECTION-FILTER] camera direction metadata missing — keeping existing behavior · ` +
               `id=${p.id} type=${p.type} userBearing=${ub} dist=${dm}`; break;
      case 'unknown-heading':
        line = `[DIRECTION-FILTER] user heading unknown — keeping existing behavior · ` +
               `id=${p.id} type=${p.type} cameraBearing=${cb} dist=${dm}`; break;
      case 'low-speed-fallback':
        line = `[DIRECTION-FILTER] low speed — no strict opposite-direction suppression · ${base}`; break;
      case 'sequence-supported':
        line = `[DIRECTION-FILTER] capture sequence evaluated — allowed (same direction) · ${base}`; level = 'ok'; break;
      case 'sequence-conflict':
        line = `[DIRECTION-FILTER] capture sequence evaluated — suppressed (opposite direction) · ${base}`; break;
      default:
        line = `[DIRECTION-FILTER] ${res.reason} · ${base}`;
    }
    if (seq) {
      const sb = (seq.sequenceBearing == null) ? 'n/a' : seq.sequenceBearing + '°';
      const bl = (seq.bearings || []).map(b => (typeof b === 'number' && !isNaN(b)) ? Math.round(b) + '°' : 'n/a');
      line += ` · seqCount=${seq.count} seqWindow=${seq.windowMinutes}min seqSupport=${seq.support}` +
              ` seqBearing=${sb} seqVotes=same:${seq.sameVotes}/opp:${seq.oppVotes}` +
              ` seqIds=[${(seq.ids || []).join(',')}] seqTimes=[${(seq.times || []).join(',')}]` +
              ` seqBearings=[${bl.join(',')}]`;
      if (seq.note) line += ` seqNote=${seq.note}`;
    }
    logEvent('DIRECTION-FILTER', line, level);
  },

  /** Points relevant for the "Next ahead" display + alert checking.
   *  v23.8.0: pulls from the global observation pool (not just the
   *  active destination's route-pair points) and runs them through
   *  the proximity-first / ahead-of-driver / heading-compatibility
   *  primary gate. Active destination, when set, is used purely to
   *  ORDER + prioritize candidates that lie between the driver and
   *  the destination — it never filters anything out (spec 1-3, 12a).
   *  v23.8.4: SILENT_ALERT_TYPES are filtered out — they live on the
   *  map and (for speed_change) drive the LIMIT sign, but they never
   *  appear in NEXT AHEAD and never become the focused alert point. */
  ahead() {
    if (!State.pos) return [];
    const userState = Observations.buildUserState();
    if (!userState) return [];
    const routeCoords = (typeof MapView !== 'undefined' && MapView && MapView._routeCoords)
      ? MapView._routeCoords : null;
    let cands = Observations.liveCandidates(userState, routeCoords);
    // v23.18.4 — Auto Route post-filter. Runs ONLY in destinationless
    // trips; destination mode is untouched and follows the existing
    // sort-only branch below. The filter tightens forward-cone /
    // lateral / directional / movement-sequence gates on top of the
    // already-applied liveCandidates filters — no new engine.
    if (!State.activeDest() && typeof AutoRoute !== 'undefined' &&
        AutoRoute.startWithoutDestinationAllowed && AutoRoute.startWithoutDestinationAllowed()) {
      cands = AutoRoute.applyGates(cands, userState);
    }
    const out = cands
      .filter(c => !State.passedPoints.has(c.point.id))
      .filter(c => !this.SILENT_ALERT_TYPES.has(c.point.type))
      .map(c => Object.assign({}, c.point, {
        dist: c.distM / 1000,
        _onRoute: c.onRoute,
        _confidence: c.confidence,
      }));
    // Destination is context only: prefer candidates that sit between
    // the driver and the destination (smaller distToDest), but DO NOT
    // drop anyone — spec 12a forbids using the route polyline as a
    // gate. A point further from the dest can still alert if it's
    // genuinely ahead of the driver.
    const dest = State.activeDest();
    if (dest) {
      const myDist = Utils.distKm(State.pos, dest);
      out.forEach(p => { p.distToDest = Utils.distKm(p, dest); });
      out.sort((a, b) => {
        const aPref = (a.distToDest != null && a.distToDest < myDist + 0.5) ? 0 : 1;
        const bPref = (b.distToDest != null && b.distToDest < myDist + 0.5) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
        if ((!!a._onRoute) !== (!!b._onRoute)) return a._onRoute ? -1 : 1;
        return a.dist - b.dist;
      });
    }
    return out;
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

    // v23.18.0 — Auto Route diagnostics: only with no destination, throttled
    // to once / 5s, focused candidate only (no extra pool scan).
    // v23.18.19 — relabel as "focused" (not "accepted") and tag
    // safety-override so a freshly-passed candidate at distance ≤ 80m
    // (legitimately let through by the safety override) doesn't read
    // as a contradictory "accepted with bearingDiff=179". Field
    // renamed: bearingDiff → headingToBearingDiff for clarity.
    if (!State.activeDest() && focusedId) {
      const now = Date.now();
      if (now - (this._autoRouteLogAt || 0) >= 5000) {
        const c = aheadList && aheadList[0];
        if (c) {
          this._autoRouteLogAt = now;
          const geo = AutoRoute.isPointAheadOfTravel(State.pos, c, Observations.effectiveHeading());
          const distM = Math.round(geo.distanceM != null ? geo.distanceM : (c.dist || 0) * 1000);
          const safety = (distM <= AutoRoute.SAFETY_OVERRIDE_M) ? 'true' : 'false';
          logEvent('AUTO-ROUTE',
            `focused candidate point=${AutoRoute.shortIdOf(c)} type=${c.type}` +
            ` distanceM=${distM}` +
            ` headingToBearingDiff=${geo.bearingDiff != null ? Math.round(geo.bearingDiff) : 'n/a'}` +
            ` safetyOverride=${safety}`);
        }
      }
    }

    // v23.8.0: iterate the GLOBAL observation pool, not just the
    // active destination's route-pair points. Selecting Home no
    // longer hides Camera-on-Osrati-road from alert evaluation.
    // The 5 km gate keeps the linear scan cheap at the current scale.
    State.data.points.forEach(p => {
      if (!p || p.status === 'no') return;
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
      // v23.8.8: SILENT_ALERT_TYPES (speed_change, traffic_light, gate)
      // are permanent road infrastructure. They never become "passed",
      // never need distance tracking, never need ahead-of-driver gating,
      // and never need re-approach logic — they stay full-color on the
      // map forever and their value (for speed_change) is surfaced via
      // the LIMIT sign through Alerts.currentLimit(). Skipping the
      // entire per-tick loop for them prevents any code path from
      // adding them to State.passedPoints, which is what was greying
      // out the speed-sign markers after a drive-by.
      if (this.SILENT_ALERT_TYPES.has(p.type)) return;

      const distKm = Utils.distKm(State.pos, p);
      // v23.8.7: re-approach detection for u-turns / round trips.
      // If a point was marked passed earlier in the session but the
      // driver is now meaningfully closer than they were when it was
      // marked, treat it as a fresh approach: clear the passed flag,
      // re-arm threshold markers, clear here-now / auto-announce
      // history, and let the rest of the loop drive new alerts.
      if (State.passedPoints.has(p.id)) {
        const distM = distKm * 1000;
        const recordedM = State.passedDistByPoint.get(p.id);
        if (recordedM == null) {
          // First tick since this point was marked passed — seed the
          // baseline distance and continue muting it for now.
          State.passedDistByPoint.set(p.id, distM);
          return;
        }
        // User keeps moving away — track the new maximum so we
        // re-arm only on a genuine drop.
        if (distM > recordedM) {
          State.passedDistByPoint.set(p.id, distM);
          return;
        }
        // Approaching: meaningfully closer than the last "moving away"
        // sample AND inside a reasonable re-engage envelope.
        if (distM < recordedM - 50 && distM < 800) {
          // v23.18.20 — re-approach must pass the shared final gate.
          // Without it, a candidate that was correctly marked passed
          // (e.g. opposite-direction directional, lateral, or
          // feedback-suppressed) gets re-armed solely because distance
          // dropped — leaking past every chain/feedback/direction
          // gate. The gate runs in AutoRoute mode only; destination
          // mode keeps the legacy unconditional re-arm.
          let reapproachAllowed = true;
          if (!State.activeDest() && typeof AutoRoute !== 'undefined' &&
              AutoRoute.finalEmissionAllowed) {
            try {
              const ev = AutoRoute.finalEmissionAllowed(p, distM, 're-approach');
              reapproachAllowed = !!ev.allowed;
            } catch (e) {}
          }
          if (!reapproachAllowed) {
            // Update the moving-away tracker so the next tick's
            // re-approach window is fresh, but DO NOT clear passed
            // state or fire the ALERT line.
            State.passedDistByPoint.set(p.id, distM);
            return;
          }
          State.passedPoints.delete(p.id);
          State.passedDistByPoint.delete(p.id);
          State.alertedMarkers.delete(p.id);
          State.lastDistByPoint.delete(p.id);
          State.minDistByPoint.delete(p.id);
          State.hereAnnouncedPoints.delete(p.id);
          State.autoAnnouncedAhead.delete(p.id);
          logEvent('ALERT',
            `re-approach: ${p.name || Utils.typeLabel(p.type)} @ ${Math.round(distM)}m (was ${Math.round(recordedM)}m) — re-armed`,
            'ok');
          // Fall through to the normal loop so the point is treated
          // as a fresh focused candidate from this tick onward.
        } else {
          return; // still passed
        }
      }

      if (distKm > 5) {
        // Too far — clear stale state
        State.lastDistByPoint.delete(p.id);
        State.minDistByPoint.delete(p.id); // v22.15: also reset min tracker
        return;
      }
      const meters = distKm * 1000;

      // v23.10: direction-aware camera gate. Evaluated once per point per
      // tick and reused by the here-now + threshold-cross announcements.
      // Only computed within announce range (≤ 2.5 km) so distant cameras
      // don't churn the diagnostic log — nothing announces beyond that
      // anyway. For non-camera / non-directional points this is always
      // true, so their behavior is untouched.
      const _camDirAllows = (meters <= 2500) ? this.cameraDirectionAllows(p, meters) : true;

      // v22.76: "Name is here" voice announcement. Fires once per (point, trip)
      // when the user is within a speed-dependent distance ring:
      //   speed >= hereSpeedThreshold -> 100m
      //   speed <  hereSpeedThreshold -> 50m
      // Repeats N times by concatenating the phrase into a single utterance,
      // so the speech engine handles the pauses naturally without
      // cancel/re-speak races.
      // v23.8.4: SILENT_ALERT_TYPES (speed_change, traffic_light, gate)
      // skip this announcement — they're static road features, not
      // alert events. Speed limits are surfaced through the LIMIT sign
      // and the over-speed flash on the speed card instead.
      const _speedKmh = State.speedMps * 3.6;
      const _hereSpeedT = +State.settings.hereSpeedThreshold || 100;
      const _hereRingM = _speedKmh >= _hereSpeedT ? 100 : 50;
      const _silent = this.SILENT_ALERT_TYPES.has(p.type);
      if (!_silent && _camDirAllows && meters <= _hereRingM && !State.hereAnnouncedPoints.has(p.id)) {
        // v23.18.20 — here-now must also pass the shared final gate
        // in AutoRoute mode. Without it, the "is here" voice could
        // fire for a candidate that chain/feedback/direction gates
        // had already classified as opposite/side-road/FP — the very
        // pattern the user reported (lateral / opposite-direction
        // points at < ring distance still announcing).
        let hereAllowed = true;
        if (!State.activeDest() && typeof AutoRoute !== 'undefined' &&
            AutoRoute.finalEmissionAllowed) {
          try {
            const ev = AutoRoute.finalEmissionAllowed(p, meters, 'here-now');
            hereAllowed = !!ev.allowed;
          } catch (e) {}
        }
        if (!hereAllowed) {
          // Mark as already-announced so we don't re-evaluate next
          // tick; suppression already produced its AUTO-ROUTE-FINAL log.
          State.hereAnnouncedPoints.add(p.id);
        } else {
          State.hereAnnouncedPoints.add(p.id);
          // v22.87: suppress the distance-marker announcements ("in 500m",
          // "in 1km") for this point now that we're at it. They were
          // continuing to fire alongside "is here" and the user reported
          // them as repetitive noise.
          const _firedMark = State.alertedMarkers.get(p.id) || new Set();
          for (const _m of (State.settings.alertMarkersM || [2000, 1000, 500])) _firedMark.add(_m);
          State.alertedMarkers.set(p.id, _firedMark);
          const reps = Math.max(1, Math.min(10, +State.settings.hereRepeatCount || 2));
          const name = p.name || Utils.typeLabel(p.type);
          const text = Array(reps).fill(`${name} is here`).join('. ');
          // Original here-now speech gate is sound!=='off' && voiceGender!=='none'
          // (speech plays even in 'beep' mode). Preserve that for enforcement and
          // log an equivalent decision object.
          if (State.settings.sound !== 'off' && State.settings.voiceGender !== 'none') {
            Audio.say(text, { auditSource: 'here_now' });
            AudioAudit.log({ source: 'here_now', action: 'speech_spoken', pointId: p.id, pointType: p.type, distanceM: Math.round(meters), decision: { allowed: true, reason: null } });
          } else {
            AudioAudit.log({ source: 'here_now', action: 'speech_suppressed', pointId: p.id, pointType: p.type, distanceM: Math.round(meters), decision: { allowed: false, reason: State.settings.sound === 'off' ? 'sound_off' : 'voice_gender_none' } });
          }
          // Vibration is intentionally independent from the master sound setting.
          // sound='off' mutes generated audio/speech only; haptic feedback remains enabled.
          if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
            AudioAudit.log({ source: 'haptic', action: 'haptic_fired', vibrationFired: true, reason: null, pointId: p.id, pointType: p.type, extra: { relatedSource: 'here_now' } });
          }
          State.alertsFiredThisTrip = (State.alertsFiredThisTrip || 0) + 1;
          State.lastAlertAt = Date.now();
          State.lastAlertText = name + ' is here';
          logEvent('ALERT', `here-now: ${name} @ ${Math.round(meters)}m (ring=${_hereRingM}m, ${reps}x)`, 'ok');
        }
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

      // v23.8.0: ahead-of-driver from the BEST available signal —
      // GPS heading (when reliable) → movement bearing → neutral.
      // Per spec 7 + 12a, never make destination geometry the primary
      // gate: the calculated route may not be the road actually driven.
      // Destination only refines ordering (in Alerts.ahead()), never
      // suppresses an otherwise-ahead point.
      let ahead;
      const speedKmh = (State.speedMps || 0) * 3.6;
      const headingReliable = Speed.isHeadingReliable(speedKmh);
      if (headingReliable && State.heading != null) {
        const toPt = Speed.bearingBetween(State.pos.lat, State.pos.lng, p.lat, p.lng);
        ahead = Speed.angleDiff(State.heading, toPt) <= 90;
      } else if (State.prevPos && State.speedMps > 1) {
        const moveHeading = Utils.bearing(State.prevPos, State.pos);
        const toPt = Utils.bearing(State.pos, p);
        const diff = Math.abs(((toPt - moveHeading + 540) % 360) - 180);
        ahead = diff <= 90;
      } else {
        // Heading unknown / very slow → neutral. Do not suppress.
        ahead = true;
      }
      // Directional opposite-heading guard: only when heading is
      // reliable, never silently suppress otherwise.
      if (ahead && headingReliable
          && p.directional && p.bidirectional !== true) {
        const pb = (p.captureBearing != null) ? p.captureBearing
                 : (typeof p.heading === 'number') ? p.heading : null;
        if (pb != null && Speed.angleDiff(State.heading, pb) >= ObservationsConfig.STRONG_MISMATCH_DEG) {
          ahead = false;
        }
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

      // v23.7.1 — feedback prompt 50 m before the focused ahead point.
      // Reuses Alerts.tick's existing ahead detection + focused-point
      // selection + GPS-accuracy gating (Alerts.tick is skipped above
      // 500 m accuracy in GPS.onTick). The _askedThisTrip Set inside
      // Confirm prevents duplicate prompts per pass. Does NOT replace
      // the threshold-cross alerts below — pure validation overlay.
      if (isFocused && meters <= Confirm.FEEDBACK_DIST_M
          && Confirm.ASKABLE_TYPES.includes(p.type)) {
        try { Confirm.requestFeedbackAhead(p, meters); } catch (e) {}
      }

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
        // v23.3.x Phase 3: run IntelligenceEngine once per tick for the
        // focused candidate so shadow / active mode can compare against
        // legacy decisions. Engine runs only if intelMode !== 'legacy'.
        let intelEval = null;
        const intelMode = State.settings.intelMode || 'legacy';
        if (intelMode !== 'legacy') {
          try {
            // v23.8.0: feed the real route-corridor verdict so the
            // intelligence engine can add the on-route bonus. Route
            // is additive context only — a true value adds confidence
            // but a false/null value does NOT suppress.
            let onRoute = null;
            if (typeof MapView !== 'undefined' && MapView && MapView._routeCoords) {
              const corridorM = Observations.corridorWidthM(
                (State.speedMps || 0) * 3.6, State.accuracy);
              onRoute = Observations.isOnRouteCorridor(p, MapView._routeCoords, corridorM);
            }
            const userState = IntelligenceEngine.buildUserState(meters, onRoute);
            intelEval = IntelligenceEngine.evaluate(p, userState);
            IntelligenceEngine.logScoreLine(p, intelEval);
          } catch (e) {
            logEvent('INTEL', '[INTEL] evaluator threw: ' + (e && e.message || e), 'err');
          }
        }
        for (const m of markers) {
          if (fired.has(m)) continue;
          if (prevMeters > m + tol && meters <= m + tol) {
            // Legacy decided YES on this marker crossing.
            // Phase 3 shadow logging: compare with intelligence verdict.
            if (intelEval) {
              if (!intelEval.intelligenceWouldAlert) {
                logEvent('INTEL-DISAGREE',
                  `[INTEL-DISAGREE] legacy=YES intel=NO @ ${m}m · ${p.id} type=${p.type}` +
                  ` score=${intelEval.intelligenceScore} primary="${intelEval.reasons.primary}"`, 'err');
              } else {
                logEvent('INTEL-ALERT',
                  `[INTEL-ALERT] AGREE legacy=YES intel=YES @ ${m}m · ${p.id} type=${p.type}` +
                  ` score=${intelEval.intelligenceScore}`);
              }
            }
            // v23.3.x: in ACTIVE mode, intelligence has veto. In shadow / legacy
            // modes, legacy decision wins unconditionally — Audio.alert always fires.
            // v23.4.1: feed the runaway counter on both branches.
            // v23.10: opposite-direction directional cameras skip the audio +
            // vibration but still consume the marker (fired.add) so the point
            // isn't re-evaluated every tick. Tracking state is left intact —
            // the point is NOT marked passed, hidden, or re-scored.
            const suppressedByDirection = !_camDirAllows;
            const suppressedByIntel = (intelMode === 'active' && intelEval && !intelEval.intelligenceWouldAlert);
            // v23.18.20 — single shared final gate for the threshold
            // path. Wraps suppressedByDirection / suppressedByIntel
            // so all suppress branches emit a uniform
            // AUTO-ROUTE-FINAL line via finalEmissionAllowed.
            let allowed = true;
            if (suppressedByDirection || suppressedByIntel) {
              allowed = false;
              const reason = suppressedByDirection ? 'opposite-direction-camera' : 'intel-veto';
              if (typeof AutoRoute !== 'undefined' && AutoRoute.finalEmissionAllowed) {
                // Re-use the canonical log shape; treat it as already
                // decided to suppress by stamping a synthetic gate
                // result before the call. Simpler: just emit a
                // separate AUTO-ROUTE-FINAL line.
                try {
                  const sid = AutoRoute.shortIdOf(p);
                  const hd = Number.isFinite(State.heading) ? Math.round(State.heading) : 'n/a';
                  const bt = (State.pos && typeof p.lat === 'number')
                    ? Math.round(Speed.bearingBetween(State.pos.lat, State.pos.lng, p.lat, p.lng)) : 'n/a';
                  const cb = (typeof p.captureBearing === 'number') ? Math.round(p.captureBearing) : 'null';
                  let chainDeg = 'null';
                  try {
                    const cd = AutoRoute._inferChainDirection(p);
                    if (cd && cd.deg != null) chainDeg = Math.round(cd.deg);
                  } catch (e) {}
                  const so = (meters <= AutoRoute.SAFETY_OVERRIDE_M) ? 'true' : 'false';
                  logEvent('AUTO-ROUTE-FINAL',
                    `point=${sid} alertKind=threshold final=suppress reason=${reason}` +
                    ` dist=${meters} heading=${hd} bearingTo=${bt}` +
                    ` captureBearing=${cb} chain=${chainDeg} safetyOverride=${so}`);
                } catch (e) {}
              }
              if (suppressedByIntel) IntelligenceEngine.noteSuppression(p, intelEval, meters, m);
            } else if (typeof AutoRoute !== 'undefined' && AutoRoute.finalEmissionAllowed) {
              try {
                const ev = AutoRoute.finalEmissionAllowed(p, meters, 'threshold');
                allowed = !!ev.allowed;
              } catch (e) {}
            }
            if (allowed) {
              Audio.alert(p, m);
              if (intelMode === 'active') IntelligenceEngine.noteAlertFired();
              // Vibration is intentionally independent from the master sound setting.
              // sound='off' mutes generated audio/speech only; haptic feedback remains enabled.
              if (navigator.vibrate) {
                navigator.vibrate(60);
                AudioAudit.log({ source: 'haptic', action: 'haptic_fired', vibrationFired: true, reason: null, pointId: p.id, pointType: p.type, distanceM: m, extra: { relatedSource: 'threshold_alert' } });
              } else {
                // Device has no Vibration API — record once so the audit shows
                // why no haptic fired.
                AudioAudit.log({ source: 'haptic', action: 'haptic_not_applicable', vibrationFired: false, reason: 'not_applicable', pointId: p.id, pointType: p.type, distanceM: m, extra: { relatedSource: 'threshold_alert' } });
              }
            }
            fired.add(m);
          }
        }
        // Disagreement on the OTHER direction: legacy didn't fire this tick
        // but intelligence would have. Only log once per (point, focused-tick)
        // when no marker was crossed — fired.size hasn't changed.
        if (intelEval && intelEval.intelligenceWouldAlert) {
          // suppress noise: only log when at least one marker hasn't fired
          // yet AND the point is in the ideal window
          const unfired = markers.some(m => !fired.has(m) && meters <= m);
          if (unfired && meters >= 200 && meters <= 1500) {
            // Throttled via the engine's _lastScoreLogAt — already 5s.
            // No additional log line here to avoid duplication.
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

    // v22.32: continuous proximity ping for the focused (closest) point.
    // v23.8.5: types in PROXIMITY_PING_EXCLUDED_TYPES (mobile_camera)
    // still get NEXT AHEAD focus + threshold-cross peeps + voice, but
    // skip the continuous heartbeat — clear the ping state so it
    // doesn't carry over from a previous focused point either.
    if (focusedId != null) {
      const focusedPoint = aheadList.find(p => p.id === focusedId);
      // v23.10: silence the continuous heartbeat for opposite-facing
      // directional cameras too (same announcement gate as voice/peeps).
      if (focusedPoint && !this.PROXIMITY_PING_EXCLUDED_TYPES.has(focusedPoint.type)
          && this.cameraDirectionAllows(focusedPoint, focusedPoint.dist * 1000)) {
        const focusedMeters = focusedPoint.dist * 1000;
        Audio.updateProximityPing(focusedId, focusedMeters, focusedPoint.type);
      } else {
        Audio.updateProximityPing(null, null, null);
      }
    } else {
      Audio.updateProximityPing(null, null, null);
    }

    // v22.68 / v22.91: announce speed limit on zone change.
    // Primary path: a scored speed_change point with score >= 60
    // → announce its limit (subject to Speed.shouldAlert hysteresis).
    // Fallback path: manualLimit change → simple value compare.
    // The hysteresis is per-point (in memory, cleared on page reload).
    const best = this.bestScoredSpeedPoint();
    if (best && best.point && best.point.id) {
      const limit = best.limit;
      if (limit !== State.lastAnnouncedLimit &&
          Speed.shouldAlert(best.point, State.pos.lat, State.pos.lng)) {
        State.lastAnnouncedLimit = limit;
        Speed.recordAlert(best.point, State.pos.lat, State.pos.lng);
        // Speed-limit ZONE announce (not overspeed). Original gate preserved.
        if (State.settings.sound !== 'off' && State.settings.voiceGender !== 'none') {
          Audio.say(`Speed limit ${limit}`, { auditSource: 'auto_announce' });
          AudioAudit.log({ source: 'auto_announce', action: 'speech_spoken', pointId: best.point.id, decision: { allowed: true, reason: null }, extra: { kind: 'speed_limit_zone', limit: limit } });
        } else {
          AudioAudit.log({ source: 'auto_announce', action: 'speech_suppressed', pointId: best.point.id, decision: { allowed: false, reason: State.settings.sound === 'off' ? 'sound_off' : 'voice_gender_none' }, extra: { kind: 'speed_limit_zone', limit: limit } });
        }
        logEvent('ALERT', `Speed limit ${limit} (score ${best.score}, ${Math.round(best.distance)}m)`, 'ok');
      }
    } else {
      // No scored alert candidate — fall back to currentLimit (proximity)
      const curLimit = this.currentLimit();
      if (curLimit !== State.lastAnnouncedLimit) {
        State.lastAnnouncedLimit = curLimit;
        if (curLimit != null &&
            State.settings.sound !== 'off' &&
            State.settings.voiceGender !== 'none') {
          Audio.say(`Speed limit ${curLimit}`);
        }
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
    // v23.10: don't auto-announce an opposite-facing directional camera.
    // Return WITHOUT marking it announced so it can still announce later
    // if the driver turns onto the matching direction (re-approach also
    // clears this set). The marker stays visible / unpassed / unscored.
    if (!this.cameraDirectionAllows(top, top.dist * 1000)) return;
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

    // Respect sound mode: voice mode → only voice; tone mode → only tone; both → both.
    // Enforcement preserved exactly; decisions logged for visibility.
    {
      const toneDec = Audio.beepDecision();
      if (s === 'beep' || s === 'both') {
        Audio.beep(top.type, { auditSource: 'auto_announce' });
        AudioAudit.log({ source: 'auto_announce', action: 'tone_played', pointId: top.id, pointType: top.type, decision: { allowed: true, reason: null } });
      } else {
        AudioAudit.log({ source: 'auto_announce', action: 'tone_suppressed', pointId: top.id, pointType: top.type, decision: toneDec });
      }
      const speakDec = Audio.speakDecision();
      if ((s === 'voice' || s === 'both') && State.settings.voiceGender !== 'none') {
        setTimeout(() => Audio.say(text, { auditSource: 'auto_announce' }), 200);
        AudioAudit.log({ source: 'auto_announce', action: 'speech_spoken', pointId: top.id, pointType: top.type, decision: { allowed: true, reason: null } });
      } else {
        AudioAudit.log({ source: 'auto_announce', action: 'speech_suppressed', pointId: top.id, pointType: top.type, decision: speakDec });
      }
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
      if (mode === 'beep' || mode === 'both') {
        // v23.8.9 — route over-speed beep through the Sound Alerts
        // catalogue. If the user mapped a sound to
        // 'speed_limit_exceeded', play that pattern; otherwise fall
        // back to the legacy speed_change radar tone so users who
        // never edited the mapping see no behavior change.
        const mappedId = Audio.findMappedSoundId('speed_limit_exceeded');
        if (mappedId && typeof SoundCatalogue !== 'undefined') {
          const def = SoundCatalogue.find(s => s.id === mappedId);
          if (def && Array.isArray(def.pattern) && def.pattern.length && Audio.ensure()) {
            Audio.playPattern(def.pattern, { intensity: 0.7 });
          } else {
            Audio.beep('speed_change');
          }
        } else {
          Audio.beep('speed_change');
        }
      }
      if (_overspeedTonePlayed) {
        AudioAudit.log({ source: 'overspeed', action: 'tone_played', decision: { allowed: true, reason: null }, extra: { limit: limit, mode: mode } });
      } else {
        AudioAudit.log({ source: 'overspeed', action: 'tone_suppressed', decision: overspeedToneDec, extra: { limit: limit, mode: mode } });
      }
      if (mode === 'voice' || mode === 'both') {
        Audio.say(`Speed limit ${limit}`, { auditSource: 'overspeed' });
        AudioAudit.log({ source: 'overspeed', action: 'speech_spoken', decision: { allowed: true, reason: null }, extra: { limit: limit, mode: mode } });
      } else {
        AudioAudit.log({ source: 'overspeed', action: 'speech_suppressed', decision: overspeedSpeechDec, extra: { limit: limit, mode: mode } });
      }
      // Vibration is intentionally independent from the master sound setting.
      // sound='off' mutes generated audio/speech only; haptic feedback remains enabled.
      // (Behavior preserved exactly: the original over-speed buzz fired only inside
      // this s!=='off' block, so it stays here — no new haptic path is introduced.)
      if (navigator.vibrate) {
        navigator.vibrate([50, 50, 50]);
        AudioAudit.log({ source: 'haptic', action: 'haptic_fired', vibrationFired: true, reason: null, extra: { relatedSource: 'overspeed', limit: limit } });
      }
    } else {
      // Master mute suppressed both over-speed channels this episode.
      AudioAudit.log({ source: 'overspeed', action: 'tone_suppressed', decision: overspeedToneDec, extra: { limit: limit, mode: mode } });
      AudioAudit.log({ source: 'overspeed', action: 'speech_suppressed', decision: overspeedSpeechDec, extra: { limit: limit, mode: mode } });
    }
    State.speedAlertWasOver = true;
  },
};

/* ============================================================
   7c. CONFIRM — v22.38 post-pass survey ("is this point still there?")
   ============================================================ */
const Confirm = {
  // Point types that warrant a confirmation popup.
  ASKABLE_TYPES: ['speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera', 'checkpoint'],
  // After this many consecutive "NO" answers, the point auto-retires (status='no').
  RETIRE_AFTER: 3,
  // v23.7.1: feedback prompt fires when point is this close ahead.
  FEEDBACK_DIST_M: 50,
  // v23.7.1: feedback countdown duration (30 s per spec).
  FEEDBACK_COUNTDOWN_S: 30,
  // v23.9.7: when one askable point opens a feedback popup, any other
  // askable points within this radius are silently added to
  // _askedThisTrip so the same cluster (typically opposite-direction
  // cameras captured at the same intersection) doesn't queue several
  // popups back-to-back. Cluster suppression is in-memory only; on a
  // future GPS session each point can prompt again.
  FEEDBACK_CLUSTER_RADIUS_M: 50,
  // Don't ask more than once per point per trip.
  _askedThisTrip: new Set(),
  // FIFO queue of point IDs waiting to be asked about.
  _queue: [],
  _activeId: null,
  _activeDistanceM: null,    // v23.7.1: last known distance for the active prompt
  _timer: null,
  _remainingMs: 0,
  // v23.7.1: gate so the popup sound plays exactly once per popup display.
  _popupSoundPlayedForId: null,
  // v23.7.1: missed-feedback resolution flow — when a user taps the
  // "Missed Feedback N" chip in Edit Point, we open the popup pointing
  // at the missed entry. _resolvingMissedId carries that mapping so
  // _answer knows to flip the missed record to status=resolved.
  _resolvingMissedId: null,

  /** v23.7.1 — fire feedback prompt 50 m BEFORE the focused next-ahead
   *  alert (replaces v22's onPassed-only timing). Called from
   *  Alerts.tick when ahead && distance ≤ FEEDBACK_DIST_M. The
   *  _askedThisTrip guard prevents duplicate prompts within the same
   *  GPS session for the same point. */
  requestFeedbackAhead(point, distM) {
    if (!point || !point.id) return;
    if (State.settings && State.settings.feedbackEnabled === false) return; // v23.9.9 master switch
    if (!this.ASKABLE_TYPES.includes(point.type)) return;
    if (point.status === 'no') return;
    if (this._askedThisTrip.has(point.id)) return;
    this._askedThisTrip.add(point.id);
    // v23.9.7: cluster-suppress nearby askable points so opposite-
    // direction cameras captured at the same intersection don't both
    // queue popups for this trip.
    this._addClusterToAskedThisTrip(point);
    this._queue.push({ id: point.id, kind: 'ahead', distM });
    try {
      const sid = (typeof AutoRoute !== 'undefined' && AutoRoute.shortIdOf)
        ? AutoRoute.shortIdOf(point) : (point.shortId || point.id);
      logEvent('FEEDBACK', `[FEEDBACK] feedback_prompt_shown — ${sid} @ ${Math.round(distM)}m (ahead)`);
    } catch (e) {}
    if (!this._activeId) this._showNext();
  },

  /** Legacy onPassed fallback — fires if the user crossed the 50 m
   *  window faster than one GPS tick. Same queue, same guard.
   *  v23.18.22 — gated by AutoRoute.finalEmissionAllowed so we don't
   *  enqueue passed-fallback prompts for points the engine already
   *  classified as opposite-direction / side-road / feedback-suppressed.
   *  Those are points the user never actually approached. Skipping
   *  the popup avoids nuisance prompts; the engine's existing
   *  AUTO-ROUTE-FINAL log already explains why the candidate would
   *  not have alerted, so a FEEDBACK-SKIP line just references it. */
  onPassed(point) {
    if (!point || !point.id) return;
    if (State.settings && State.settings.feedbackEnabled === false) return; // v23.9.9 master switch
    if (!this.ASKABLE_TYPES.includes(point.type)) return;
    if (point.status === 'no') return;
    if (this._askedThisTrip.has(point.id)) return;
    // v23.18.22 — engine-suppressed candidates don't get a passed-fallback
    // popup. Only runs in AutoRoute mode (destinationless trip); the
    // destination flow is untouched.
    try {
      if (!State.activeDest() && typeof AutoRoute !== 'undefined' &&
          AutoRoute.finalGateForEmission) {
        const distM = State.pos ? Math.round(Utils.distKm(State.pos, point) * 1000) : null;
        const g = AutoRoute.finalGateForEmission(point, distM, 'passed-fallback');
        if (g && g.emit === false) {
          const sid = AutoRoute.shortIdOf(point);
          logEvent('FEEDBACK-SKIP',
            `passed-fallback skipped point=${sid} reason=${g.reason} dist=${g.distM}` +
            ` heading=${g.headingDeg != null ? g.headingDeg : 'n/a'}` +
            ` captureBearing=${g.captureBearingDeg != null ? g.captureBearingDeg : 'null'}`);
          return;
        }
      }
    } catch (e) {}
    this._askedThisTrip.add(point.id);
    // v23.9.7: cluster-suppress nearby askable points so opposite-
    // direction cameras captured at the same intersection don't both
    // queue popups for this trip.
    this._addClusterToAskedThisTrip(point);
    this._queue.push({ id: point.id, kind: 'passed', distM: 0 });
    try {
      const sid = (typeof AutoRoute !== 'undefined' && AutoRoute.shortIdOf)
        ? AutoRoute.shortIdOf(point) : (point.shortId || point.id);
      logEvent('FEEDBACK', `[FEEDBACK] feedback_prompt_shown — ${sid} (passed-fallback)`);
    } catch (e) {}
    if (!this._activeId) this._showNext();
  },

  /** v23.9.7: Mark any askable points within FEEDBACK_CLUSTER_RADIUS_M
   *  of `centerPoint` as already-asked-this-trip. Prevents back-to-back
   *  popups for cameras captured at the same physical location (e.g.
   *  one per direction). In-memory only — `resetTrip()` clears the set
   *  on the next GPS session so each point can prompt again later. */
  _addClusterToAskedThisTrip(centerPoint) {
    if (!centerPoint || !State || !State.data || !Array.isArray(State.data.points)) return;
    const radiusM = Confirm.FEEDBACK_CLUSTER_RADIUS_M;
    let added = 0;
    for (const p of State.data.points) {
      if (!p || p.id === centerPoint.id) continue;
      if (!Confirm.ASKABLE_TYPES.includes(p.type)) continue;
      if (this._askedThisTrip.has(p.id)) continue;
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
      let dM;
      try { dM = Utils.distKm(p, centerPoint) * 1000; } catch (e) { continue; }
      if (dM <= radiusM) {
        this._askedThisTrip.add(p.id);
        added++;
      }
    }
    if (added > 0) {
      try { logEvent('FEEDBACK-POPUP', `cluster-suppressed ${added} nearby askable point${added === 1 ? '' : 's'} around ${centerPoint.id} (≤${radiusM}m)`); } catch (e) {}
    }
  },

  /** v23.7.1 — open the popup pointing at a specific missed-feedback
   *  entry from the Edit Point UI. Reuses the same _render +
   *  _answer flow; _answer detects _resolvingMissedId and resolves
   *  the missed record after writing the confirmations entry. */
  openMissedFeedback(pointId, missedId) {
    const point = State.data.points.find(p => p.id === pointId);
    if (!point) return false;
    if (!Confirm._countUnresolvedMissed(point)) {
      Utils.toast('No missed feedback', 'good');
      return false;
    }
    // Hard reset any in-flight popup first.
    this._cleanup();
    this._queue = [];
    this._activeId = pointId;
    this._activeDistanceM = null;
    this._resolvingMissedId = missedId || (Confirm._firstUnresolvedMissed(point) || {}).id || null;
    this._popupSoundPlayedForId = null;
    this._render(point);
    this._startCountdown(this.FEEDBACK_COUNTDOWN_S);
    this._maybePlayPopupSound();
    return true;
  },

  /** Count unresolved missed-feedback entries on a point. */
  _countUnresolvedMissed(point) {
    if (!point || !point.feedback || !Array.isArray(point.feedback.missed)) return 0;
    let n = 0;
    for (const m of point.feedback.missed) {
      if (m && m.status === 'missed_feedback') n++;
    }
    return n;
  },

  /** Return the first unresolved missed-feedback entry, or null. */
  _firstUnresolvedMissed(point) {
    if (!point || !point.feedback || !Array.isArray(point.feedback.missed)) return null;
    return point.feedback.missed.find(m => m && m.status === 'missed_feedback') || null;
  },

  /** Show the next queued point, if any. */
  _showNext() {
    this._cleanup();
    if (!this._queue.length) {
      this._activeId = null;
      this._activeDistanceM = null;
      this._resolvingMissedId = null;
      return;
    }
    const next = this._queue.shift();
    const id = (typeof next === 'string') ? next : next.id;
    const queuedKind = (next && next.kind) ? next.kind : 'ahead';
    this._activeDistanceM = (next && typeof next.distM === 'number') ? next.distM : null;
    const point = State.data.points.find(p => p.id === id);
    if (!point) { this._showNext(); return; }
    this._activeId = id;
    this._resolvingMissedId = null;
    this._popupSoundPlayedForId = null;
    // v23.18.19 — emit a binding source line so audit logs make it
    // explicit whether the popup attaches to the actual last-emitted
    // alert or to a passed-fallback (different point or stale).
    try {
      if (typeof AutoRoute !== 'undefined' && AutoRoute.logFeedbackBinding) {
        AutoRoute.logFeedbackBinding(point, queuedKind);
      }
    } catch (e) {}
    this._render(point);
    this._startCountdown(this.FEEDBACK_COUNTDOWN_S);
    this._maybePlayPopupSound();
  },

  /** v23.7.1 — fire popup sound exactly once per popup show. Gated by
   *  `_popupSoundPlayedForId` so GPS-tick re-renders / countdown
   *  ticks can't replay the sound. */
  _maybePlayPopupSound() {
    if (this._popupSoundPlayedForId === this._activeId) return;
    this._popupSoundPlayedForId = this._activeId;
    try {
      if (typeof Audio !== 'undefined' && typeof Audio.playFeedbackPopupSound === 'function') {
        Audio.playFeedbackPopupSound();
        AudioAudit.log({ source: 'feedback_popup', action: 'tone_played', decision: Audio.beepDecision(), extra: { activeId: this._activeId } });
        logEvent('FEEDBACK', `[FEEDBACK] feedback_popup_sound_played — ${this._activeId}`);
      }
    } catch (e) {}
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
    // v23.7.1: when resolving an existing missed entry, label clearly.
    const headline = this._resolvingMissedId
      ? `Still there? (missed feedback)`
      : `Still there?`;
    host.innerHTML = `
      <div class="confirm-card">
        <button class="confirm-close" id="confirm-x" title="Dismiss" aria-label="Dismiss">×</button>
        <div class="confirm-head">
          <div class="confirm-title">${Utils.emoji(point.type)} ${name}</div>
          <div class="confirm-meta">${Utils.escapeHtml(typeLbl)}${sideText} · ${headline}</div>
        </div>
        <div class="confirm-progress"><div class="confirm-progress-bar" id="confirm-bar"></div></div>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-yes" id="confirm-yes">YES</button>
          <button class="confirm-btn confirm-no"  id="confirm-no">NO</button>
        </div>
        <div class="confirm-actions confirm-actions-fp">
          <button class="confirm-btn confirm-fp" id="confirm-fp" title="Alert on the wrong road or wrong direction">False positive</button>
        </div>
      </div>`;
    host.classList.add('show');
    document.getElementById('confirm-yes').onclick = () => this._answer('yes');
    document.getElementById('confirm-no').onclick  = () => this._answer('no');
    document.getElementById('confirm-x').onclick   = () => this._dismiss();
    document.getElementById('confirm-fp').onclick  = () => this._answerFalsePositive();
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
        // v23.7.1 — timeout: attach a missed_feedback record to the
        // captured point (UNLESS we were resolving an existing missed
        // entry, in which case it stays unresolved). NO confirmation
        // sound, NO additional modal, popup just closes.
        const expiredId = this._activeId;
        const expiredDist = this._activeDistanceM;
        const wasResolvingMissed = !!this._resolvingMissedId;
        try {
          const point = State.data.points.find(p => p.id === expiredId);
          if (point && !wasResolvingMissed) {
            Confirm._attachMissedFeedback(point, expiredDist);
          }
          logEvent('FEEDBACK', `[FEEDBACK] feedback_prompt_expired — ${expiredId}${wasResolvingMissed ? ' (resolving missed; left as-is)' : ''}`);
        } catch (e) {}
        this._showNext();
      }
    }, 100);
  },

  /** v23.7.1 — attach one missed_feedback record to the point. Idempotent
   *  per (pass, pointId): if a record already exists for this pass we
   *  do NOT add another. The Edit Point UI reads `point.feedback.missed`
   *  to render the "Missed Feedback N" count.
   *
   *  Schema (additive only; existing point fields untouched):
   *    point.feedback = { missed: [
   *      { id, pointId, type, status: 'missed_feedback'|'resolved',
   *        missedAt, resolvedAt, response, distanceM, passId, route }
   *    ]}
   */
  _attachMissedFeedback(point, distM) {
    if (!point || !point.id) return;
    if (!point.feedback || typeof point.feedback !== 'object') point.feedback = {};
    if (!Array.isArray(point.feedback.missed)) point.feedback.missed = [];
    const passId = State.feedbackPassId || null;
    // Idempotence guard: one missed entry per (pass, pointId).
    if (passId && point.feedback.missed.some(m => m && m.passId === passId && m.status === 'missed_feedback')) {
      try { logEvent('FEEDBACK', `[FEEDBACK] missed_feedback_attached_to_point — skipped duplicate for pass ${passId}`); } catch (e) {}
      return;
    }
    const entry = {
      id: Utils.uid(),
      pointId: point.id,
      type: point.type,
      status: 'missed_feedback',
      missedAt: new Date().toISOString(),
      resolvedAt: null,
      response: null,
      distanceM: (typeof distM === 'number') ? Math.round(distM) : null,
      passId,
    };
    // Route/destination context if available.
    try {
      const dest = State.activeDest && State.activeDest();
      if (dest && dest.id) entry.destId = dest.id;
    } catch (e) {}
    point.feedback.missed.push(entry);
    State.saveData();
    try { logEvent('FEEDBACK', `[FEEDBACK] missed_feedback_attached_to_point — ${point.id} (pass ${passId || 'none'})`, 'ok'); } catch (e) {}
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
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
    // v23.9.5 — feedback revalidation. Capture a sample from current
    // State (lat/lng, gps accuracy, altitude, heading, speed) and use
    // it as additional evidence on the point. Quality-gated field
    // updates only — never overwrites high-quality original data with
    // low-quality samples, never auto-moves the point on a single
    // feedback event. See Confirm._applyRevalidation for the policy.
    try {
      const resolvingNow = !!this._resolvingMissedId;
      const feedbackType = resolvingNow ? 'missed_feedback_submit'
                        : (value === 'yes' ? 'confirm' : 'negative');
      const feedbackResult = (value === 'yes') ? 'positive' : 'negative';
      const sample = Confirm._captureRevalidationSample(point, feedbackResult, feedbackType);
      if (sample) Confirm._applyRevalidation(point, sample, feedbackResult);
    } catch (e) {
      try { logEvent('FEEDBACK-REVALIDATION', 'sample apply error: ' + (e && e.message || e), 'err'); } catch (e2) {}
    }
    // v23.7.1 — if this _answer is closing out a missed-feedback
    // entry (opened from Edit Point), mark that entry resolved.
    const resolvingId = this._resolvingMissedId;
    if (resolvingId && point.feedback && Array.isArray(point.feedback.missed)) {
      const target = point.feedback.missed.find(m => m && m.id === resolvingId);
      if (target) {
        target.status = 'resolved';
        target.resolvedAt = new Date().toISOString();
        target.response = value;
        try { logEvent('FEEDBACK', `[FEEDBACK] missed_feedback_resolved — ${point.id} entry ${resolvingId} → ${value}`, 'ok'); } catch (e) {}
      }
    }
    State.saveData();
    // v23.7.1 — confirmation sound AFTER successful save, never on timeout.
    try {
      if (typeof Audio !== 'undefined' && typeof Audio.playFeedbackConfirmSound === 'function') {
        Audio.playFeedbackConfirmSound();
        AudioAudit.log({ source: 'feedback_confirm', action: 'tone_played', pointId: point.id, decision: Audio.beepDecision() });
        logEvent('FEEDBACK', `[FEEDBACK] feedback_confirmation_sound_played — ${point.id}`);
      }
    } catch (e) {}
    try { logEvent('FEEDBACK', `[FEEDBACK] feedback_response_recorded — ${point.id} → ${value}`, 'ok'); } catch (e) {}
    Utils.toast(
      value === 'yes'
        ? `✓ ${point.name || Utils.typeLabel(point.type)} confirmed`
        : (point.status === 'no'
            ? `${point.name || Utils.typeLabel(point.type)} retired (3 missed)`
            : `${point.name || Utils.typeLabel(point.type)} marked missing (${point.missingCount}/${Confirm.RETIRE_AFTER})`),
      value === 'yes' ? 'good' : 'bad'
    );
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
    // v23.7.1 — refresh Edit Point UI if currently open for this point.
    try {
      if (State.editingPointId === point.id && typeof UI !== 'undefined' && typeof UI.refreshMissedFeedbackCount === 'function') {
        UI.refreshMissedFeedbackCount(point.id);
      }
    } catch (e) {}
    this._resolvingMissedId = null;
    this._showNext();
  },

  _cleanup() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const host = document.getElementById('confirm-popup');
    if (host) host.classList.remove('show');
  },

  /** v23.9.6 — driver taps X. Close popup, do NOT update point fields,
   *  do NOT count as confirmation or missing, do NOT create a missed-
   *  feedback entry. Suppression for the rest of this trip is already
   *  in place via _askedThisTrip (added before the popup was shown). */
  _dismiss() {
    const id = this._activeId;
    try { logEvent('FEEDBACK-POPUP', `dismissed ${id || '(none)'} — no point update`); } catch (e) {}
    // If we were resolving an existing missed-feedback entry, leave it
    // in its current state (unresolved). The user explicitly chose not
    // to answer; treating dismiss as resolution would lose that intent.
    this._resolvingMissedId = null;
    this._showNext();
  },

  /** v23.9.6 — driver taps False Positive. Records a revalidation
   *  sample with feedbackResult='false_positive' (which uses the
   *  v23.9.5 path to classify cause, never moves the point, and bumps
   *  falsePositiveCount), then applies the 1st/2nd/3rd confidence
   *  ladder (suspect → likely-bad → suppressed-pending-revalidation)
   *  and, when classification is opposite_direction_likely, marks the
   *  point as needsDirectionalValidation so the alert engine will
   *  require stricter heading alignment in future encounters. */
  _answerFalsePositive() {
    const id = this._activeId;
    if (!id) return;
    const point = State.data.points.find(p => p.id === id);
    if (!point) { this._showNext(); return; }
    // Capture sample BEFORE we apply the ladder so the classifier
    // sees the point in its pre-penalty state (cleaner attribution).
    try {
      const sample = Confirm._captureRevalidationSample(point, 'false_positive', 'false_positive');
      if (sample) Confirm._applyRevalidation(point, sample, 'false_positive');
      Confirm._applyFalsePositiveConfidence(point);
      // Opposite-direction learning: if the classifier flagged this as
      // a direction problem, enable stricter heading gating for THIS
      // observation only (additive boolean — no global threshold change).
      const r = point.revalidation;
      const lastIssue = (r && Array.isArray(r.suggestedAdjustments) && r.suggestedAdjustments.length)
        ? r.suggestedAdjustments[r.suggestedAdjustments.length - 1].reason
        : null;
      if (lastIssue === 'opposite_direction_likely' || lastIssue === 'parallel_road_likely') {
        point.needsDirectionalValidation = true;
        if (!point.feedbackStats) point.feedbackStats = {};
        if (!Array.isArray(point.feedbackStats.falsePositiveDirectionEvidence)) {
          point.feedbackStats.falsePositiveDirectionEvidence = [];
        }
        const delta = (typeof point.captureBearing === 'number' && sample && sample.heading != null)
          ? Speed.angleDiff(point.captureBearing, sample.heading) : null;
        point.feedbackStats.falsePositiveDirectionEvidence.push({
          ts: Date.now(),
          headingDelta: delta,
          classification: lastIssue,
        });
      }
      // v23.18.13 — also record the FP approach in the structured
      // falsePositiveApproaches[] AutoRoute consumes for heading-based
      // suppression. Captures the actual approach heading + distance
      // without depending on captureBearing existing.
      try {
        if (typeof AutoRoute !== 'undefined' && AutoRoute.recordFalsePositiveApproach) {
          const userState = (typeof Observations !== 'undefined' && Observations.buildUserState)
            ? Observations.buildUserState() : null;
          AutoRoute.recordFalsePositiveApproach(point, userState, lastIssue || 'manual');
        }
      } catch (e) {}
    } catch (e) {
      try { logEvent('FEEDBACK-POPUP', 'false_positive handling error: ' + (e && e.message || e), 'err'); } catch (e2) {}
    }
    // Persist
    State.saveData();
    try {
      if (typeof Audio !== 'undefined' && typeof Audio.playFeedbackConfirmSound === 'function') {
        Audio.playFeedbackConfirmSound();
        AudioAudit.log({ source: 'feedback_confirm', action: 'tone_played', pointId: point.id, decision: Audio.beepDecision(), extra: { kind: 'false_positive' } });
      }
    } catch (e) {}
    try { logEvent('FEEDBACK-POPUP', `false_positive submitted ${point.id}`); } catch (e) {}
    Utils.toast(`Marked false positive`, 'bad');
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
    this._resolvingMissedId = null;
    this._showNext();
  },

  /** v23.9.6 — confidence ladder for false-positive feedback.
   *  Reads point.revalidation.falsePositiveCount (already incremented
   *  by Confirm._applyRevalidation). Applies an inverse of the
   *  possible/probable/trusted observation ladder:
   *
   *    1st FP  → feedbackStats.suspect = true   (warning, minor penalty)
   *    2nd FP  → feedbackStats.probableIssue = true (stronger penalty)
   *    3rd FP+ → point.suppressedPendingRevalidation = true
   *              UNLESS recent positive confirmations (last 30 days)
   *              outweigh the FP count.
   *
   *  Counter penalty: confirmationCount is reduced by 1 (floor 0) per
   *  FP, mirroring how YES bumps it by 1 elsewhere. observationCount
   *  is bumped (every FP is still an observation event). The
   *  confidenceStatus is then re-derived. */
  _applyFalsePositiveConfidence(point) {
    if (!point) return;
    const r = point.revalidation || {};
    const fpCount = r.falsePositiveCount || 0;
    // Count recent positives (last 30 days)
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    let recentPositives = 0;
    if (Array.isArray(point.confirmations)) {
      for (const c of point.confirmations) {
        if (c && c.value === 'yes' && (c.ts || 0) > cutoff) recentPositives++;
      }
    }
    if (!point.feedbackStats) point.feedbackStats = {};
    if (fpCount >= 1) point.feedbackStats.suspect = true;
    if (fpCount >= 2) point.feedbackStats.probableIssue = true;
    if (fpCount >= 3 && recentPositives < fpCount) {
      point.suppressedPendingRevalidation = true;
    }
    // Adjust the v23.7.2 counters used by Speed.deriveConfidenceStatus.
    // Treat each FP as a counter-observation: bump observationCount,
    // decrement confirmationCount, and bump rejectionCount.
    point.observationCount  = (point.observationCount  || 1) + 1;
    point.confirmationCount = Math.max(0, (point.confirmationCount || 0) - 1);
    point.rejectionCount    = (point.rejectionCount    || 0) + 1;
    point.lastObservedAt    = new Date().toISOString();
    if (typeof Speed !== 'undefined' && typeof Speed.deriveConfidenceStatus === 'function') {
      try { point.confidenceStatus = Speed.deriveConfidenceStatus(point); } catch (e) {}
    }
    try {
      logEvent('FEEDBACK-POPUP',
        `false_positive ladder ${point.id} · fpCount=${fpCount} recentPos=${recentPositives} suspect=${!!point.feedbackStats.suspect} probableIssue=${!!point.feedbackStats.probableIssue} suppressed=${!!point.suppressedPendingRevalidation}`);
    } catch (e) {}
  },

  /* ============================================================
     v23.9.5 — Feedback-based observation revalidation.
     ============================================================
     Tuning constants. Conservative on purpose so trusted points
     are never disturbed by a single low-quality sample. */
  REVAL_GOOD_ACC_M: 10,
  REVAL_MEDIUM_ACC_M: 25,
  REVAL_MIN_SPEED_KMH: 10,
  REVAL_MAX_POS_DELTA_M: 50,
  REVAL_BEARING_TOL_DEG: 30,
  REVAL_MIN_SAMPLES_FOR_REFINE: 3,
  REVAL_MAX_SAMPLES: 50,
  REVAL_ALT_AGREEMENT_M: 5,
  REVAL_GPS_ACC_IMPROVEMENT_M: 5,
  REVAL_ALT_ACC_IMPROVEMENT_M: 2,

  /** Build a revalidation sample from current State + point. Reads
   *  only — no side effects. Returns null if no GPS fix yet. */
  _captureRevalidationSample(point, feedbackResult, feedbackType) {
    if (!point) return null;
    const pos = State.pos;
    const acc = (typeof State.accuracy === 'number') ? State.accuracy : null;
    const alt = (typeof State.altitude === 'number') ? State.altitude : null;
    const altAcc = (typeof State.altitudeAccuracy === 'number') ? State.altitudeAccuracy : null;
    const hdg = (typeof State.heading === 'number') ? State.heading : null;
    const spdKmh = (typeof State.speedMps === 'number') ? State.speedMps * 3.6 : null;
    // v23.17.0 — read the live heading source and active destination so
    // FeedbackGate can apply heading-reliability + destination gates.
    const hdgSource = State.headingSource || null;
    let activeDestId = null;
    try { const ad = State.activeDest && State.activeDest(); if (ad && ad.id) activeDestId = ad.id; } catch (e) {}
    const sample = {
      ts: Date.now(),
      pointId: point.id,
      pointType: point.type,
      feedbackType: feedbackType || 'confirm',
      feedbackResult: feedbackResult || 'unknown',
      lat: pos ? pos.lat : null,
      lng: pos ? pos.lng : null,
      gpsAccuracy: acc,
      altitude: alt,
      altitudeAccuracy: altAcc,
      heading: hdg,
      headingSource: hdgSource,
      speedKmh: spdKmh,
      destId: activeDestId,
      // Snapshot of original point fields at time of feedback so the
      // audit trail is self-contained even if the point is later edited.
      originalLat: point.lat,
      originalLng: point.lng,
      originalAltitude: (typeof point.altitude === 'number') ? point.altitude : null,
      originalCaptureBearing: (typeof point.captureBearing === 'number') ? point.captureBearing : null,
    };
    if (pos) {
      try {
        sample.distanceM = Utils.distKm(pos, point) * 1000;
        sample.bearingToPoint = Utils.bearing(pos, point);
      } catch (e) {}
    }
    sample.quality = Confirm._classifySampleQuality(sample);
    return sample;
  },

  /** Classify a sample as good/medium/poor. */
  _classifySampleQuality(s) {
    if (!s || s.lat == null || s.lng == null) return 'poor';
    const acc = s.gpsAccuracy;
    if (acc == null || acc > 50) return 'poor';
    if (acc <= Confirm.REVAL_GOOD_ACC_M
        && s.heading != null
        && (s.speedKmh || 0) >= Confirm.REVAL_MIN_SPEED_KMH) {
      return 'good';
    }
    if (acc <= Confirm.REVAL_MEDIUM_ACC_M) return 'medium';
    return 'poor';
  },

  /** Apply a revalidation sample to a point. Quality-gated. Never
   *  overwrites high-quality original data with low-quality samples;
   *  never auto-moves the point on a single sample. Position
   *  refinement is SUGGESTED, not auto-applied. */
  _applyRevalidation(point, sample, feedbackResult) {
    if (!point || !sample) return;
    if (!point.revalidation) {
      point.revalidation = {
        count: 0,
        lastAt: null,
        samples: [],
        positionEvidence: [],
        altitudeEvidence: [],
        headingEvidence: [],
        falsePositiveCount: 0,
        lastFalsePositiveAt: null,
        qualitySummary: { good: 0, medium: 0, poor: 0 },
        suggestedAdjustments: [],
      };
    }
    const r = point.revalidation;
    r.samples.push(sample);
    if (r.samples.length > Confirm.REVAL_MAX_SAMPLES) {
      r.samples = r.samples.slice(-Confirm.REVAL_MAX_SAMPLES);
    }
    r.count++;
    r.lastAt = new Date(sample.ts).toISOString();
    r.qualitySummary[sample.quality] = (r.qualitySummary[sample.quality] || 0) + 1;

    if (feedbackResult === 'false_positive') {
      r.falsePositiveCount = (r.falsePositiveCount || 0) + 1;
      r.lastFalsePositiveAt = new Date(sample.ts).toISOString();
      const issue = Confirm._classifyFalsePositive(point, sample);
      r.suggestedAdjustments.push({ at: sample.ts, type: 'false_positive_issue', reason: issue });
      try { logEvent('FEEDBACK-REVALIDATION', `false_positive ${point.id} · quality=${sample.quality} · issue=${issue}`); } catch (e) {}
      return; // Do NOT update fields or move the point.
    }

    if (feedbackResult === 'negative') {
      // Record evidence only — no field updates, no refinement.
      try { logEvent('FEEDBACK-REVALIDATION', `negative ${point.id} · quality=${sample.quality} · evidence-only`); } catch (e) {}
      return;
    }

    // v23.17.0 — feedback-geometry gate. Every positive sample is
    // validated for distance / heading / GPS / destination compatibility
    // BEFORE it can promote trust or feed evidence arrays. Opposite-direction
    // or far samples land in quarantinedSamples / rejectedSamples (still
    // preserved on the point), bump suspicious / rejected counters, and
    // do NOT inflate validConfirmationCount, lastConfirmedAt, refinement
    // suggestions, or position/altitude/heading evidence used for refits.
    const gateEnabled = !State.settings || !State.settings.feedbackGeometryGates
                      || State.settings.feedbackGeometryGates.enabled !== false;
    const verdict = gateEnabled ? FeedbackGate.validateFeedbackGeometry(point, sample) : null;
    sample._gate = verdict ? {
      verdict: verdict.verdict, reasons: verdict.reasons.slice(),
      headingDiffDeg: verdict.headingDiffDeg, distanceM: verdict.distanceM,
      gateVersion: verdict.gateVersion,
    } : null;
    if (verdict && verdict.verdict !== 'accepted') {
      FeedbackGate.recordNonAcceptedPositive(point, sample, verdict);
      return; // Do NOT update lastConfirmedAt, evidence, or refinements.
    }

    // From here on, feedbackResult === 'positive' AND the gate accepted it.
    FeedbackGate.recordAcceptedPositive(point);
    point.lastConfirmedAt = new Date(sample.ts).toISOString();
    point.lastObservedAt = point.lastConfirmedAt;

    const filled = [];
    const improved = [];

    // (B) Fill missing fields when sample is at least medium quality.
    if (sample.quality === 'good' || sample.quality === 'medium') {
      if (point.altitude == null && sample.altitude != null) {
        point.altitude = sample.altitude;
        if (sample.altitudeAccuracy != null) point.altitudeAccuracy = sample.altitudeAccuracy;
        filled.push('altitude');
      }
      if (point.gpsAccuracy == null && sample.gpsAccuracy != null) {
        point.gpsAccuracy = sample.gpsAccuracy;
        filled.push('gpsAccuracy');
      }
    }

    // (C) Improve weak fields only if the new sample is materially better
    // AND it is a 'good' sample.
    if (sample.quality === 'good') {
      if (point.altitude != null && sample.altitude != null
          && typeof point.altitudeAccuracy === 'number'
          && typeof sample.altitudeAccuracy === 'number'
          && sample.altitudeAccuracy < point.altitudeAccuracy - Confirm.REVAL_ALT_ACC_IMPROVEMENT_M) {
        point.altitude = sample.altitude;
        point.altitudeAccuracy = sample.altitudeAccuracy;
        improved.push('altitude');
      }
      if (point.gpsAccuracy != null && sample.gpsAccuracy != null
          && sample.gpsAccuracy < point.gpsAccuracy - Confirm.REVAL_GPS_ACC_IMPROVEMENT_M) {
        point.gpsAccuracy = sample.gpsAccuracy;
        improved.push('gpsAccuracy');
      }
    }

    // Add to evidence arrays for cluster-based refinement (good only).
    if (sample.quality === 'good') {
      if (sample.lat != null && sample.lng != null) {
        r.positionEvidence.push({ lat: sample.lat, lng: sample.lng, ts: sample.ts, acc: sample.gpsAccuracy });
        if (r.positionEvidence.length > Confirm.REVAL_MAX_SAMPLES) r.positionEvidence = r.positionEvidence.slice(-Confirm.REVAL_MAX_SAMPLES);
      }
      if (sample.altitude != null && sample.altitudeAccuracy != null) {
        r.altitudeEvidence.push({ alt: sample.altitude, accuracy: sample.altitudeAccuracy, ts: sample.ts });
        if (r.altitudeEvidence.length > Confirm.REVAL_MAX_SAMPLES) r.altitudeEvidence = r.altitudeEvidence.slice(-Confirm.REVAL_MAX_SAMPLES);
      }
      if (sample.heading != null) {
        r.headingEvidence.push({ heading: sample.heading, ts: sample.ts });
        if (r.headingEvidence.length > Confirm.REVAL_MAX_SAMPLES) r.headingEvidence = r.headingEvidence.slice(-Confirm.REVAL_MAX_SAMPLES);
      }
    }

    // (E,F,J) Conservative refinements after enough evidence.
    Confirm._tryBearingRefinement(point);
    Confirm._tryAltitudeRefinement(point);
    Confirm._suggestPositionRefinement(point);

    if (filled.length || improved.length) {
      try { logEvent('FEEDBACK-REVALIDATION',
        `positive ${point.id} · quality=${sample.quality} · filled=[${filled.join(',')}] improved=[${improved.join(',')}]`); } catch (e) {}
    } else if (sample.quality === 'poor') {
      try { logEvent('FEEDBACK-REVALIDATION', `positive ${point.id} · quality=poor · audit-only`); } catch (e) {}
    } else {
      try { logEvent('FEEDBACK-REVALIDATION', `positive ${point.id} · quality=${sample.quality} · recorded`); } catch (e) {}
    }
  },

  /** Classify suspected cause when a false-positive is reported. */
  _classifyFalsePositive(point, sample) {
    if (typeof point.captureBearing === 'number' && sample.heading != null) {
      const d = Speed.angleDiff(point.captureBearing, sample.heading);
      if (d > 150) return 'opposite_direction_likely';
      if (d > 60) return 'parallel_road_likely';
    }
    if (sample.gpsAccuracy != null && sample.gpsAccuracy > 30) return 'gps_drift_possible';
    if (sample.distanceM != null && sample.distanceM > 80) return 'radius_too_large_possible';
    const lastSeen = point.lastObservedAt || point.updatedAt || point.createdAt;
    if (lastSeen) {
      const ageMs = Date.now() - new Date(lastSeen).getTime();
      if (ageMs > 90 * 24 * 3600 * 1000) return 'stale_observation_possible';
    }
    return 'unknown_false_positive';
  },

  /** Derive captureBearing if it's missing AND we have 3+ aligned
   *  positive heading samples. Never overwrites an existing bearing. */
  _tryBearingRefinement(point) {
    if (typeof point.captureBearing === 'number') return; // never overwrite
    const r = point.revalidation;
    if (!r || !r.headingEvidence || r.headingEvidence.length < Confirm.REVAL_MIN_SAMPLES_FOR_REFINE) return;
    const recent = r.headingEvidence.slice(-5);
    let sx = 0, sy = 0;
    for (const h of recent) {
      const rad = h.heading * Math.PI / 180;
      sx += Math.cos(rad);
      sy += Math.sin(rad);
    }
    const meanRad = Math.atan2(sy, sx);
    const mean = ((meanRad * 180 / Math.PI) + 360) % 360;
    for (const h of recent) {
      if (Speed.angleDiff(h.heading, mean) > Confirm.REVAL_BEARING_TOL_DEG) return;
    }
    point.captureBearing = mean;
    if (typeof point.heading !== 'number') point.heading = mean;
    try { logEvent('FEEDBACK-REVALIDATION', `bearing derived ${point.id} → ${mean.toFixed(1)}° (n=${recent.length})`); } catch (e) {}
  },

  /** Refine altitude with the possible/probable/trusted progression
   *  defined in spec §E. Only refines when 3+ samples agree within
   *  REVAL_ALT_AGREEMENT_M; otherwise records altitudeConfidence as
   *  low_or_mixed without overwriting the stored value. */
  _tryAltitudeRefinement(point) {
    const r = point.revalidation;
    if (!r || !r.altitudeEvidence || r.altitudeEvidence.length === 0) return;
    const recent = r.altitudeEvidence.slice(-5);
    let sum = 0;
    for (const a of recent) sum += a.alt;
    const mean = sum / recent.length;
    let maxDelta = 0;
    for (const a of recent) {
      const d = Math.abs(a.alt - mean);
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta > Confirm.REVAL_ALT_AGREEMENT_M) {
      point.altitudeConfidence = 'low_or_mixed';
      return;
    }
    point.altitudeConfidence = recent.length >= 3 ? 'trusted'
                            : recent.length >= 2 ? 'probable'
                            : 'possible';
    // Only update the stored value when accuracy is better OR
    // we now have enough agreement to upgrade confidence.
    if (recent.length < Confirm.REVAL_MIN_SAMPLES_FOR_REFINE) return;
    let bestAcc = Infinity;
    for (const a of recent) if (a.accuracy < bestAcc) bestAcc = a.accuracy;
    const improves = (typeof point.altitudeAccuracy !== 'number')
                  || (bestAcc < point.altitudeAccuracy - Confirm.REVAL_ALT_ACC_IMPROVEMENT_M);
    if (improves) {
      point.altitude = mean;
      point.altitudeAccuracy = bestAcc;
      try { logEvent('FEEDBACK-REVALIDATION', `altitude refined ${point.id} → ${mean.toFixed(1)}m ±${bestAcc.toFixed(1)}m (n=${recent.length})`); } catch (e) {}
    }
  },

  /** Position adjustment: SUGGESTION only. Never auto-moves a point.
   *  When 3+ good positive samples cluster within 25 m of each other
   *  AND the cluster centroid is 3-50 m from the stored point, record
   *  a suggestedAdjustment for later review. */
  _suggestPositionRefinement(point) {
    const r = point.revalidation;
    if (!r || !r.positionEvidence || r.positionEvidence.length < Confirm.REVAL_MIN_SAMPLES_FOR_REFINE) return;
    const recent = r.positionEvidence.slice(-5);
    let slat = 0, slng = 0;
    for (const e of recent) { slat += e.lat; slng += e.lng; }
    const cLat = slat / recent.length;
    const cLng = slng / recent.length;
    let distM;
    try { distM = Utils.distKm({ lat: point.lat, lng: point.lng }, { lat: cLat, lng: cLng }) * 1000; } catch (e) { return; }
    if (distM > Confirm.REVAL_MAX_POS_DELTA_M || distM < 3) return;
    let maxSpread = 0;
    for (const e of recent) {
      try {
        const d = Utils.distKm({ lat: e.lat, lng: e.lng }, { lat: cLat, lng: cLng }) * 1000;
        if (d > maxSpread) maxSpread = d;
      } catch (e2) {}
    }
    if (maxSpread > 25) return;
    r.suggestedAdjustments.push({
      at: Date.now(),
      type: 'position_refine',
      proposedLat: cLat,
      proposedLng: cLng,
      currentDeltaM: distM,
      sampleCount: recent.length,
      maxSpreadM: maxSpread,
    });
    try { logEvent('FEEDBACK-REVALIDATION', `position adjustment suggested ${point.id} · Δ ${distM.toFixed(1)}m · spread ${maxSpread.toFixed(1)}m · n=${recent.length} (not auto-applied)`); } catch (e) {}
  },
  /** Reset trip state when GPS starts a fresh session. */
  resetTrip() {
    this._askedThisTrip.clear();
    this._queue = [];
    this._activeId = null;
    this._activeDistanceM = null;
    this._resolvingMissedId = null;
    this._popupSoundPlayedForId = null;
    this._cleanup();
  },
};

/* ============================================================
   7d. FEEDBACK GEOMETRY GATE — v23.17.0
   Validates every feedback / revalidation sample against distance,
   heading, GPS-accuracy, and destination-compatibility gates BEFORE the
   sample is allowed to inflate any trust counter, evidence array, or
   suggested adjustment. Pure-validator + sample-router + one-time audit.
   No alert engine, no new store — augments the existing
   point.revalidation block. Live alert trigger logic is unchanged: the
   only effect on alerts is that trust derives from
   validConfirmationCount instead of the raw confirmationCount once
   migration has run.
   ============================================================ */
const FeedbackGate = {
  // Conservative defaults; overridden when State.settings.feedbackGeometryGates
  // exposes a field. Mirrors the schema documented in Storage.defaultSettings.
  DEFAULTS: {
    enabled: true,
    alignedHeadingMaxDeg: 45,
    oppositeHeadingMinDeg: 135,
    minReliableHeadingSpeedKmh: 15,
    acceptedDistanceM: 100,
    quarantineDistanceM: 200,
    hardRejectDistanceM: 500,
    headingGateAppliesToTypes: [
      'speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera', 'speed_change',
    ],
    exemptBidirectionalFromHeadingGate: true,
    poorGpsAccuracyM: 50,
  },
  GATE_VERSION: 'feedback-geometry-v1',

  /** Resolve effective gate settings: explicit per-call options override
   *  the user's State.settings.feedbackGeometryGates, which in turn
   *  override DEFAULTS. Settings remain backward compatible — missing
   *  fields fall through to DEFAULTS. */
  _resolveOptions(options) {
    const user = (typeof State !== 'undefined' && State && State.settings
                  && State.settings.feedbackGeometryGates) || {};
    return Object.assign({}, this.DEFAULTS, user, options || {});
  },

  /** Pure validator. Reads sample + point + options; mutates nothing.
   *  Returns the verdict object documented in spec §1. */
  validateFeedbackGeometry(point, sample, options) {
    const opts = this._resolveOptions(options);
    const out = {
      accepted: false, verdict: 'rejected', reasons: [],
      headingDiffDeg: null, distanceM: null,
      headingReliable: false, distanceReliable: false,
      gpsAccuracyM: null, destinationCompatible: null,
      gateVersion: this.GATE_VERSION,
    };
    if (!point || !sample) { out.reasons.push('missing_point_or_sample'); return out; }

    // pointId match — never pin a sample to the wrong point.
    if (sample.pointId != null && sample.pointId !== point.id) {
      out.reasons.push('pointId_mismatch'); return out;
    }

    // ---- Distance ----------------------------------------------------
    let distanceM = (typeof sample.distanceM === 'number' && !isNaN(sample.distanceM))
      ? sample.distanceM : null;
    if (distanceM == null && typeof sample.lat === 'number' && typeof sample.lng === 'number'
        && typeof point.lat === 'number' && typeof point.lng === 'number') {
      try { distanceM = Utils.distKm(sample, point) * 1000; } catch (e) {}
    }
    out.distanceM = (distanceM == null) ? null : Math.round(distanceM);
    out.distanceReliable = (distanceM != null);

    // ---- GPS accuracy ----------------------------------------------
    const gpsAcc = (typeof sample.gpsAccuracy === 'number' && !isNaN(sample.gpsAccuracy))
      ? sample.gpsAccuracy : null;
    out.gpsAccuracyM = (gpsAcc == null) ? null : Math.round(gpsAcc);
    let gpsPoor = false;
    if (gpsAcc == null) {
      out.reasons.push('gps_accuracy_missing');
    } else if (gpsAcc > opts.poorGpsAccuracyM) {
      out.reasons.push('gps_accuracy_poor'); gpsPoor = true;
    }

    // ---- Destination compatibility ---------------------------------
    if (sample.destId && point.destId) {
      out.destinationCompatible = (sample.destId === point.destId);
      if (!out.destinationCompatible) out.reasons.push('destination_mismatch');
    } else {
      out.destinationCompatible = null; // not enough info — do not gate.
    }

    // ---- Heading reliability + gate --------------------------------
    const pointBearing = (typeof point.captureBearing === 'number' && !isNaN(point.captureBearing))
      ? point.captureBearing
      : (typeof point.heading === 'number' && !isNaN(point.heading) ? point.heading : null);
    const sampleHeading = (typeof sample.heading === 'number' && !isNaN(sample.heading))
      ? sample.heading : null;
    const speedKmh = (typeof sample.speedKmh === 'number') ? sample.speedKmh : null;
    const hSource = sample.headingSource || null;

    let headingReliable = false;
    if (hSource === 'capture-bearing') headingReliable = true;
    else if (speedKmh != null && speedKmh >= opts.minReliableHeadingSpeedKmh) headingReliable = true;
    else if (hSource === 'gps' && speedKmh != null && speedKmh >= opts.minReliableHeadingSpeedKmh) headingReliable = true;
    if (sampleHeading == null) headingReliable = false;
    out.headingReliable = headingReliable;

    let headingDiffDeg = null;
    if (pointBearing != null && sampleHeading != null) {
      headingDiffDeg = Speed.angleDiff(pointBearing, sampleHeading);
    }
    out.headingDiffDeg = (headingDiffDeg == null) ? null : Math.round(headingDiffDeg);

    // Does the heading gate apply at all?
    const isBidirectional = point.bidirectional === true;
    const isDirectionalCamera = (point.directional === true)
      && (opts.headingGateAppliesToTypes || []).indexOf(point.type) >= 0
      && point.type !== 'speed_change';
    const isSpeedChange = point.type === 'speed_change';
    let applyHeadingGate = false;
    if (isBidirectional && opts.exemptBidirectionalFromHeadingGate) {
      applyHeadingGate = false;
    } else if (isSpeedChange) {
      applyHeadingGate = true;
    } else if (isDirectionalCamera) {
      applyHeadingGate = true;
    }
    if (applyHeadingGate && (pointBearing == null || sampleHeading == null)) {
      applyHeadingGate = false;
      out.reasons.push('heading_metadata_missing');
    }
    if (applyHeadingGate && !headingReliable) {
      applyHeadingGate = false;
      out.reasons.push('heading_unreliable_low_speed_or_missing_source');
    }

    // ---- Distance verdict (always applied) -------------------------
    let distanceVerdict = 'accepted';   // accepted | quarantine | rejected
    if (distanceM == null) {
      // Missing distance — be permissive, mirror existing fallback.
      distanceVerdict = 'accepted';
    } else if (distanceM > opts.hardRejectDistanceM) {
      distanceVerdict = 'rejected'; out.reasons.push('distance_hard_reject');
    } else if (distanceM > opts.quarantineDistanceM) {
      distanceVerdict = 'rejected'; out.reasons.push('distance_far');
    } else if (distanceM > opts.acceptedDistanceM) {
      distanceVerdict = 'quarantine'; out.reasons.push('distance_marginal');
    }

    // ---- Heading verdict (only when gate applies) ------------------
    let headingVerdict = 'accepted';
    if (applyHeadingGate) {
      if (headingDiffDeg >= opts.oppositeHeadingMinDeg) {
        headingVerdict = 'rejected'; out.reasons.push('opposite_heading');
      } else if (headingDiffDeg >= opts.alignedHeadingMaxDeg) {
        headingVerdict = 'quarantine'; out.reasons.push('ambiguous_heading');
      }
    }

    // ---- GPS verdict -----------------------------------------------
    let gpsVerdict = 'accepted';
    if (gpsPoor) {
      // Tolerate poor GPS only when otherwise close + aligned.
      const closeAndAligned = (distanceM != null && distanceM <= opts.acceptedDistanceM)
        && headingVerdict === 'accepted';
      gpsVerdict = closeAndAligned ? 'accepted' : 'quarantine';
    }

    // ---- Destination verdict ---------------------------------------
    let destVerdict = 'accepted';
    if (out.destinationCompatible === false) destVerdict = 'quarantine';

    // ---- Combine ---------------------------------------------------
    const verdicts = [distanceVerdict, headingVerdict, gpsVerdict, destVerdict];
    let combined = 'accepted';
    if (verdicts.includes('rejected')) combined = 'rejected';
    else if (verdicts.includes('quarantine')) combined = 'quarantined';
    out.verdict = combined;
    out.accepted = (combined === 'accepted');
    if (out.accepted && out.reasons.length === 0) out.reasons.push('all_gates_passed');
    return out;
  },

  /** Build the quarantined/rejected sample snapshot recorded on the point. */
  _snapshotForArchive(sample, verdict) {
    return {
      ts: sample.ts,
      feedbackType: sample.feedbackType,
      feedbackResult: sample.feedbackResult,
      lat: sample.lat, lng: sample.lng,
      heading: sample.heading, speedKmh: sample.speedKmh,
      distanceM: verdict.distanceM,
      headingDiffDeg: verdict.headingDiffDeg,
      headingReliable: verdict.headingReliable,
      gpsAccuracyM: verdict.gpsAccuracyM,
      destinationCompatible: verdict.destinationCompatible,
      reasons: verdict.reasons.slice(),
      gateVersion: verdict.gateVersion,
    };
  },

  /** Ensure the per-point gate fields exist as additive arrays/counters
   *  without disturbing legacy data. */
  _ensureGateFields(point) {
    if (!point.revalidation) {
      point.revalidation = {
        count: 0, lastAt: null, samples: [], positionEvidence: [],
        altitudeEvidence: [], headingEvidence: [], falsePositiveCount: 0,
        lastFalsePositiveAt: null, qualitySummary: { good: 0, medium: 0, poor: 0 },
        suggestedAdjustments: [],
      };
    }
    const r = point.revalidation;
    if (!Array.isArray(r.quarantinedSamples)) r.quarantinedSamples = [];
    if (!Array.isArray(r.rejectedSamples))    r.rejectedSamples    = [];
    if (typeof point.validConfirmationCount      !== 'number') point.validConfirmationCount      = 0;
    if (typeof point.suspiciousConfirmationCount !== 'number') point.suspiciousConfirmationCount = 0;
    if (typeof point.rejectedConfirmationCount   !== 'number') point.rejectedConfirmationCount   = 0;
  },

  /** Bump the suspicious/rejected counters and persist the archived
   *  sample on the point. Logs a single [FEEDBACK-GATE] line per call. */
  recordNonAcceptedPositive(point, sample, verdict) {
    this._ensureGateFields(point);
    const archived = this._snapshotForArchive(sample, verdict);
    if (verdict.verdict === 'rejected') {
      point.revalidation.rejectedSamples.push(archived);
      point.rejectedConfirmationCount = (point.rejectedConfirmationCount || 0) + 1;
    } else if (verdict.verdict === 'quarantined') {
      point.revalidation.quarantinedSamples.push(archived);
      point.suspiciousConfirmationCount = (point.suspiciousConfirmationCount || 0) + 1;
    }
    this._updateEvidenceHealth(point);
    try {
      logEvent('FEEDBACK-GATE',
        `[FEEDBACK-GATE] ${verdict.verdict} point=${point.id} type=${point.type}` +
        ` distanceM=${verdict.distanceM} headingDiffDeg=${verdict.headingDiffDeg}` +
        ` headingReliable=${verdict.headingReliable} gpsAccuracyM=${verdict.gpsAccuracyM}` +
        ` reasons=[${verdict.reasons.join(',')}]`);
    } catch (e) {}
  },

  /** Bump validConfirmationCount and refresh evidence health when an
   *  accepted positive sample lands. Raw confirmationCount is untouched
   *  here — callers that historically bumped it (e.g. speed-limit
   *  revalidation) continue to do so. */
  recordAcceptedPositive(point) {
    this._ensureGateFields(point);
    point.validConfirmationCount = (point.validConfirmationCount || 0) + 1;
    this._updateEvidenceHealth(point);
  },

  /** Derive evidenceHealth from the live counters. Tracks previous health
   *  when it changes for the audit summary. */
  _updateEvidenceHealth(point) {
    const valid = point.validConfirmationCount      || 0;
    const susp  = point.suspiciousConfirmationCount || 0;
    const rej   = point.rejectedConfirmationCount   || 0;
    const total = valid + susp + rej;
    let next;
    if (total === 0) next = 'unknown';
    else if (rej > 0 && rej >= valid)             next = 'polluted';
    else if (rej > 0 || susp > 0)                 next = 'mixed';
    else                                           next = 'clean';
    const prev = point.evidenceHealth;
    if (next !== prev) {
      if (prev) point.previousEvidenceHealth = prev;
      point.evidenceHealth = next;
    } else if (point.evidenceHealth === undefined) {
      point.evidenceHealth = next;
    }
    point.lastEvidenceAuditAt = new Date().toISOString();
  },

  /** One-time audit migration. Walks every point's existing revalidation
   *  samples, classifies each, projects derived counters from the raw
   *  confirmationCount, and emits the spec §14 summary. Existing samples
   *  are NEVER deleted — only annotated and (for non-accepted positives)
   *  archived into quarantinedSamples / rejectedSamples. */
  runAuditV1(data) {
    const summary = {
      pointsAudited: 0, samplesAudited: 0,
      acceptedSamples: 0, quarantinedSamples: 0, rejectedSamples: 0,
      oppositeHeadingSamples: 0, unreliableHeadingSamples: 0,
      gpsPoorSamples: 0, destinationMismatchSamples: 0,
      hardDistanceRejects: 0, maxDistanceM: 0,
      evidenceHealthChanged: {
        cleanToMixed: 0, cleanToPolluted: 0,
        mixedToClean: 0, mixedToPolluted: 0, pollutedToMixed: 0,
        unknownToClean: 0, unknownToMixed: 0, unknownToPolluted: 0,
      },
      pointsRecategorized: 0,
    };
    if (!data || !Array.isArray(data.points)) return summary;

    for (const point of data.points) {
      if (!point || !point.revalidation || !Array.isArray(point.revalidation.samples)) continue;
      summary.pointsAudited++;
      this._ensureGateFields(point);

      const prevHealth = point.evidenceHealth || 'unknown';
      let acceptedHere = 0, quarantineHere = 0, rejectedHere = 0;

      for (const sample of point.revalidation.samples) {
        if (!sample) continue;
        // Only positive samples can promote trust — only those are gated
        // for accept/quarantine/reject. Other feedback types are recorded
        // as-is (negatives, false-positives have their own flow).
        if (sample.feedbackResult !== 'positive') continue;
        summary.samplesAudited++;

        const verdict = this.validateFeedbackGeometry(point, sample);
        // annotate the sample in place (additive metadata only).
        sample._gate = {
          verdict: verdict.verdict,
          reasons: verdict.reasons.slice(),
          headingDiffDeg: verdict.headingDiffDeg,
          distanceM: verdict.distanceM,
          gateVersion: verdict.gateVersion,
          auditedAt: new Date().toISOString(),
        };

        if (verdict.reasons.indexOf('opposite_heading') >= 0) summary.oppositeHeadingSamples++;
        if (verdict.reasons.indexOf('heading_unreliable_low_speed_or_missing_source') >= 0) summary.unreliableHeadingSamples++;
        if (verdict.reasons.indexOf('gps_accuracy_poor') >= 0) summary.gpsPoorSamples++;
        if (verdict.reasons.indexOf('destination_mismatch') >= 0) summary.destinationMismatchSamples++;
        if (verdict.reasons.indexOf('distance_hard_reject') >= 0) summary.hardDistanceRejects++;
        if (verdict.distanceM != null && verdict.distanceM > summary.maxDistanceM) summary.maxDistanceM = verdict.distanceM;

        if (verdict.verdict === 'accepted') {
          acceptedHere++; summary.acceptedSamples++;
        } else if (verdict.verdict === 'quarantined') {
          quarantineHere++; summary.quarantinedSamples++;
          // Avoid duplicating an already-archived sample on re-runs.
          const dup = point.revalidation.quarantinedSamples.some(s => s && s.ts === sample.ts);
          if (!dup) point.revalidation.quarantinedSamples.push(this._snapshotForArchive(sample, verdict));
        } else {
          rejectedHere++; summary.rejectedSamples++;
          const dup = point.revalidation.rejectedSamples.some(s => s && s.ts === sample.ts);
          if (!dup) point.revalidation.rejectedSamples.push(this._snapshotForArchive(sample, verdict));
        }
      }

      // Project the gated counters from the raw historical count without
      // touching confirmationCount itself (spec §7: raw count preserved).
      const raw = (typeof point.confirmationCount === 'number') ? point.confirmationCount : 0;
      point.suspiciousConfirmationCount = quarantineHere;
      point.rejectedConfirmationCount   = rejectedHere;
      const polluted = quarantineHere + rejectedHere;
      point.validConfirmationCount = Math.max(0, raw - polluted);

      this._updateEvidenceHealth(point);
      const nowHealth = point.evidenceHealth;
      if (prevHealth !== nowHealth) {
        summary.pointsRecategorized++;
        const k = prevHealth + 'To' + nowHealth.charAt(0).toUpperCase() + nowHealth.slice(1);
        if (summary.evidenceHealthChanged[k] != null) summary.evidenceHealthChanged[k]++;
      }
    }
    return summary;
  },

  /** Repair routePointRefs to match the live points-by-destId grouping.
   *  Adds missing refs, removes duplicates, flags refs that point to
   *  retired/missing points. Returns the spec §10 summary. */
  repairDestinationRoutePointRefs(data) {
    const out = { destinationsChecked: 0, refsAdded: 0, duplicatesRemoved: 0, missingPointRefsFound: 0 };
    if (!data || !Array.isArray(data.destinations) || !Array.isArray(data.points)) return out;
    const byDest = new Map();
    const pointIds = new Set();
    for (const p of data.points) {
      if (!p || !p.id) continue;
      pointIds.add(p.id);
      if (p.status === 'no') continue;          // retired — leave out of refs
      if (!p.destId) continue;
      if (!byDest.has(p.destId)) byDest.set(p.destId, []);
      byDest.get(p.destId).push(p.id);
    }
    for (const dest of data.destinations) {
      if (!dest || !dest.id) continue;
      out.destinationsChecked++;
      if (!Array.isArray(dest.routePointRefs)) dest.routePointRefs = [];
      // Drop duplicates while preserving original order.
      const seen = new Set(), deduped = [];
      for (const ref of dest.routePointRefs) {
        if (seen.has(ref)) { out.duplicatesRemoved++; continue; }
        seen.add(ref); deduped.push(ref);
      }
      dest.routePointRefs = deduped;
      // Append any active points-by-destId that aren't already listed.
      const owned = byDest.get(dest.id) || [];
      for (const id of owned) {
        if (!seen.has(id)) { dest.routePointRefs.push(id); seen.add(id); out.refsAdded++; }
      }
      // Flag refs that point to deleted points (audit only; don't drop).
      for (const ref of dest.routePointRefs) {
        if (!pointIds.has(ref)) out.missingPointRefsFound++;
      }
    }
    return out;
  },

  /** Mark trips whose destination no longer exists AND whose distance /
   *  duration are essentially zero as orphans. Preserves the original
   *  record; downstream stats can filter on trip.orphaned. */
  auditOrphanTrips(trips, destinations) {
    const out = { orphanTripsMarked: 0 };
    if (!Array.isArray(trips)) return out;
    const destIds = new Set((destinations || []).map(d => d && d.id).filter(Boolean));
    for (const t of trips) {
      if (!t || t.orphaned === true) continue;
      const missingDest = t.destId && !destIds.has(t.destId);
      const km   = (typeof t.distanceKm === 'number') ? t.distanceKm : 0;
      const ms   = (t.endedAt && t.startedAt) ? (Date.parse(t.endedAt) - Date.parse(t.startedAt)) : 0;
      const maxS = (typeof t.maxSpeed   === 'number') ? t.maxSpeed   : 0;
      const nearZero = (km < 0.05) && (maxS < 1) && (ms < 10000);
      if (missingDest && nearZero) {
        t.orphaned = true;
        t.invalidReason = 'missing_destination_near_zero_trip';
        out.orphanTripsMarked++;
      }
    }
    return out;
  },
};

// v23.17.0 — one-time feedback-geometry audit, routePointRefs repair,
// and orphan-trip audit. Mirrors the migrateCaptureMetadata pattern:
// localStorage-flagged, runs after the relevant namespaces exist, never
// repeats. Each migration is independently gated so they can be re-run
// individually if a flag is cleared. Safe-guarded — any thrown error is
// logged and the flag is set so the migration never loops on bad data.
(function migrateFeedbackGeometryGateV1() {
  try {
    if (localStorage.getItem('roadAlert.v23.17.0.feedbackGeometryGateV1')) return;
    if (!State || !State.data) return;
    const summary = FeedbackGate.runAuditV1(State.data);
    if (typeof State.data.migrations !== 'object' || State.data.migrations === null
        || Array.isArray(State.data.migrations)) State.data.migrations = {};
    State.data.migrations.feedbackGeometryGateV1 = true;
    State.data.lastEvidenceAuditAt = new Date().toISOString();
    Storage.save(Storage.KEYS.data, State.data);
    localStorage.setItem('roadAlert.v23.17.0.feedbackGeometryGateV1', '1');
    try { logEvent('FEEDBACK-GATE',
      `[FEEDBACK-GATE-AUDIT] pointsAudited=${summary.pointsAudited} samples=${summary.samplesAudited}` +
      ` accepted=${summary.acceptedSamples} quarantined=${summary.quarantinedSamples} rejected=${summary.rejectedSamples}` +
      ` opposite=${summary.oppositeHeadingSamples} unreliable=${summary.unreliableHeadingSamples}` +
      ` gpsPoor=${summary.gpsPoorSamples} destMismatch=${summary.destinationMismatchSamples}` +
      ` hardDistance=${summary.hardDistanceRejects} maxDistanceM=${summary.maxDistanceM}` +
      ` recategorized=${summary.pointsRecategorized}`); } catch (e) {}
    console.log('v23.17.0: feedback-geometry audit', summary);
  } catch (e) {
    try { localStorage.setItem('roadAlert.v23.17.0.feedbackGeometryGateV1', '1'); } catch (e2) {}
    console.warn('feedback-geometry audit', e);
  }
})();

(function migrateRoutePointRefsRepairV1() {
  try {
    if (localStorage.getItem('roadAlert.v23.17.0.routePointRefsRepairV1')) return;
    if (!State || !State.data) return;
    const summary = FeedbackGate.repairDestinationRoutePointRefs(State.data);
    if (typeof State.data.migrations !== 'object' || State.data.migrations === null
        || Array.isArray(State.data.migrations)) State.data.migrations = {};
    State.data.migrations.routePointRefsRepairV1 = true;
    if (summary.refsAdded || summary.duplicatesRemoved || summary.missingPointRefsFound) {
      Storage.save(Storage.KEYS.data, State.data);
    }
    localStorage.setItem('roadAlert.v23.17.0.routePointRefsRepairV1', '1');
    try { logEvent('DATA-REPAIR',
      `[ROUTE-POINT-REFS-REPAIR] destinationsChecked=${summary.destinationsChecked}` +
      ` refsAdded=${summary.refsAdded} duplicatesRemoved=${summary.duplicatesRemoved}` +
      ` missingPointRefsFound=${summary.missingPointRefsFound}`); } catch (e) {}
    console.log('v23.17.0: routePointRefs repair', summary);
  } catch (e) {
    try { localStorage.setItem('roadAlert.v23.17.0.routePointRefsRepairV1', '1'); } catch (e2) {}
    console.warn('routePointRefs repair', e);
  }
})();

(function migrateOrphanTripsAuditV1() {
  try {
    if (localStorage.getItem('roadAlert.v23.17.0.orphanTripsAuditV1')) return;
    if (!State) return;
    const summary = FeedbackGate.auditOrphanTrips(State.trips,
      (State.data && State.data.destinations) || []);
    if (summary.orphanTripsMarked) Storage.save(Storage.KEYS.trips, State.trips);
    if (State.data) {
      if (typeof State.data.migrations !== 'object' || State.data.migrations === null
        || Array.isArray(State.data.migrations)) State.data.migrations = {};
      State.data.migrations.orphanTripsAuditV1 = true;
      Storage.save(Storage.KEYS.data, State.data);
    }
    localStorage.setItem('roadAlert.v23.17.0.orphanTripsAuditV1', '1');
    try { logEvent('DATA-REPAIR', `[ORPHAN-TRIPS-AUDIT] orphanTripsMarked=${summary.orphanTripsMarked}`); } catch (e) {}
    console.log('v23.17.0: orphan trips audit', summary);
  } catch (e) {
    try { localStorage.setItem('roadAlert.v23.17.0.orphanTripsAuditV1', '1'); } catch (e2) {}
    console.warn('orphan trips audit', e);
  }
})();

/* ============================================================
   8. BACKUP
   ============================================================ */
const Backup = {
  // v22.104: serial restore lock. A second pull() while one is in flight
  // returns false safely with a log/toast — prevents two GitHub fetches
  // and two confirmation flows stomping local data in parallel.
  _pulling: false,

  /** v22.104: deterministic weak hash. Used as the SHA-256 fallback when
   *  crypto.subtle.digest is unavailable (file://, insecure context, very
   *  old browsers). Caller wraps the return value with a "weak:" prefix. */
  _weakHash() {
    const s = JSON.stringify({ d: State.data, t: State.trips, st: State.settings });
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  },

  /** v22.104: async SHA-256 hash of the current data+trips+settings,
   *  hex-encoded. Returns a "weak:<int32>" string on fallback (digest
   *  unavailable or threw). Backup must not break — change comparison
   *  still works because weak: hashes are deterministic too. */
  async hash() {
    const s = JSON.stringify({ d: State.data, t: State.trips, st: State.settings });
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
        const buf = new TextEncoder().encode(s);
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.from(new Uint8Array(digest))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        return hex;
      }
    } catch (e) {
      logEvent('BACKUP', 'sha-256 digest failed, using weak fallback: ' + (e && e.message || e));
    }
    logEvent('BACKUP', 'sha-256 unavailable — using weak hash');
    return 'weak:' + Backup._weakHash();
  },
  async push(opts = {}) {
    if (!State.gh.token || !State.gh.repo || !State.gh.path) {
      if (!opts.silent) Utils.toast('Set token/repo/path first', 'bad');
      logEvent('BACKUP', 'push aborted — token/repo/path missing', 'err');
      return false;
    }
    const tag = opts.silent ? 'auto' : 'manual';
    logEvent('BACKUP', `push start (${tag})`);
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
      } catch (e) {
        logEvent('BACKUP', 'sha lookup soft-fail: ' + (e && e.message || e));
      }
      const payload = JSON.stringify({
        version: 22,
        exportedAt: new Date().toISOString(),
        data: State.data,
        settings: State.settings,
        trips: State.trips,
      }, null, 2);
      // v22.104: replace deprecated unescape()/escape() round-trip with
      // TextEncoder. Same bytes (UTF-8), no deprecated globals.
      const bytes = new TextEncoder().encode(payload);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
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
        const msg = err.message || ('HTTP ' + resp.status);
        if (!opts.silent) Utils.toast('Backup failed: ' + msg, 'bad');
        logEvent('BACKUP', `push HTTP ${resp.status}: ${msg}`, 'err');
        // v23.5 Phase 4: queue the failed push and signal NetworkMonitor.
        try { NetworkMonitor.recordFetchResult('backup', false, msg); } catch (e) {}
        try { BackupQueue.enqueueFailedPush(new Error(msg)); } catch (e) {}
        try { if (typeof UI !== 'undefined' && UI.applyOfflineIndicator) UI.applyOfflineIndicator(); } catch (e) {}
        return false;
      }
      State.lastBackup = Date.now();
      State.lastBackupHash = await this.hash();
      UI.updateBackupStatus();
      if (!opts.silent) Utils.toast('Backed up ✓', 'good');
      logEvent('BACKUP', `push ok (${(payload.length / 1024).toFixed(1)}KB, ${tag})`, 'ok');
      // v23.5 Phase 4: success clears the persistent retry queue and
      // signals the network monitor.
      try { NetworkMonitor.recordFetchResult('backup', true); } catch (e) {}
      try { BackupQueue.clear(); } catch (e) {}
      try { if (typeof UI !== 'undefined' && UI.applyOfflineIndicator) UI.applyOfflineIndicator(); } catch (e) {}
      return true;
    } catch (e) {
      if (!opts.silent) Utils.toast('Backup error', 'bad');
      logEvent('BACKUP', 'push exception: ' + (e && e.message || e), 'err');
      // v23.5 Phase 4: network exception = authoritative offline signal.
      try { NetworkMonitor.recordFetchResult('backup', false, (e && e.message) || String(e)); } catch (err) {}
      try { BackupQueue.enqueueFailedPush(e); } catch (err) {}
      try { if (typeof UI !== 'undefined' && UI.applyOfflineIndicator) UI.applyOfflineIndicator(); } catch (err) {}
      return false;
    }
  },
  async tryAuto() {
    if (!State.settings.autoBackup) return;
    if (!State.gh.token || !State.gh.repo) return;
    const h = await this.hash();
    if (h === State.lastBackupHash) return;
    await this.push({ silent: true });
  },

  /** v22.30: pull backup from GitHub. Replaces local data with remote.
   *  Destructive — must be confirmed by user.
   *  v22.104: serial lock via Backup._pulling. Validator-gated overwrite —
   *  caller (UI) sees a sanitization report and explicitly confirms
   *  before any State.* assignment. Decoding via TextDecoder. */
  async pull() {
    if (Backup._pulling) {
      Utils.toast('Restore already in progress', 'bad');
      logEvent('BACKUP', 'pull aborted — already in progress');
      return false;
    }
    if (!State.gh.token || !State.gh.repo || !State.gh.path) {
      Utils.toast('Set token/repo/path first', 'bad');
      logEvent('BACKUP', 'pull aborted — token/repo/path missing', 'err');
      return false;
    }
    Backup._pulling = true;
    logEvent('BACKUP', 'pull start');
    try {
      const apiBase = `https://api.github.com/repos/${State.gh.repo}/contents/${State.gh.path}`;
      const headers = {
        'Authorization': 'token ' + State.gh.token,
        'Accept': 'application/vnd.github+json',
      };
      const r = await fetch(apiBase, { headers });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg = err.message || ('HTTP ' + r.status);
        Utils.toast('Restore failed: ' + msg, 'bad');
        logEvent('BACKUP', `pull HTTP ${r.status}: ${msg}`, 'err');
        return false;
      }
      const json = await r.json();
      // v22.104: decode base64 → UTF-8 via TextDecoder (no escape()).
      const b64clean = (json.content || '').replace(/\n/g, '');
      const bin = atob(b64clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const raw = new TextDecoder('utf-8').decode(bytes);
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) {
        Utils.toast('Restore: invalid JSON', 'bad');
        logEvent('BACKUP', 'pull JSON parse error: ' + e.message, 'err');
        return false;
      }
      // v22.104: validate before showing the report. Validator returns
      // sanitized copies; do not assign until UI.confirm comes back true.
      const val = Validator.validateImport(parsed);
      if (!val.ok) {
        Utils.toast('Restore: ' + val.report, 'bad');
        logEvent('BACKUP', 'pull validation failed: ' + val.report, 'err');
        return false;
      }
      const ok = await UI.confirm(val.report, {
        title: 'Restore — apply this data?',
        okLabel: 'Apply',
      });
      if (!ok) {
        Utils.toast('Restore cancelled', 'bad');
        logEvent('BACKUP', 'pull cancelled at validation confirm');
        return false;
      }
      // Apply sanitized data
      State.data = val.sanitized.data;
      if (val.sanitized.settings) State.settings = Object.assign({}, State.settings, val.sanitized.settings);
      if (Array.isArray(val.sanitized.trips)) State.trips = val.sanitized.trips;
      State.saveData();
      State.saveSettings();
      State.saveTrips();
      State.lastBackupHash = await this.hash();
      UI.renderRouteBar();
      UI.renderMarkerChips();
      if (MapView.m) MapView.updatePoints();
      UI.updateBackupStatus();
      Utils.toast(`Restored: ${State.data.points.length} points, ${State.data.destinations.length} dests`, 'good');
      logEvent('BACKUP', `pull ok (${State.data.points.length} points, ${State.data.destinations.length} dests)`, 'ok');
      return true;
    } catch (e) {
      Utils.toast('Restore error: ' + (e.message || e), 'bad');
      logEvent('BACKUP', 'pull exception: ' + (e && e.message || e), 'err');
      return false;
    } finally {
      Backup._pulling = false;
    }
  },
  start() { this.stop(); State.backupTimer = setInterval(() => this.tryAuto(), 5 * 60 * 1000); },
  stop()  { if (State.backupTimer) { clearInterval(State.backupTimer); State.backupTimer = null; } },
};

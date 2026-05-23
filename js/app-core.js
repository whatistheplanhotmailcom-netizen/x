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
const APP_VERSION = 'v23.9.0';

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
   *    + 5  road-name match (TODO — no geocoder yet)
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

    // ROAD NAME (+5) — needs reverse geocoding, not implemented in this pass.

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
   *  Always safe to call; returns 'possible' for empty inputs. */
  deriveConfidenceStatus(p) {
    if (!p) return 'possible';
    const obs  = p.observationCount   || p.confidence || 1;
    const conf = p.confirmationCount  || 0;
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
    // prefer non-null roadName
    if (!target.roadName && src.roadName) target.roadName = src.roadName;
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
   lastSeenAt, heading, bidirectional, source, routeTags, roadName,
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
   *  Never filters by active destination. */
  globalPool() {
    if (!State || !State.data || !Array.isArray(State.data.points)) return [];
    return State.data.points.filter(p =>
      p && p.status !== 'no' && typeof p.lat === 'number' && typeof p.lng === 'number'
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
      if (p.roadName === undefined) {
        p.roadName = null;
        changed = true;
      }
      // v23.9.0: Road Movement Fingerprint additive fields. NEVER
      // overwrites existing values — purely fills the schema so legacy
      // points don't break the evidence gate / debug surfaces.
      if (p.directionStatus === undefined) {
        p.directionStatus = (p.captureBearing != null) ? 'known' : 'unknown';
        changed = true;
      }
      if (p.altitudeStatus === undefined) {
        p.altitudeStatus = (typeof p.altitudeM === 'number') ? 'known' : 'unavailable';
        changed = true;
      }
      if (p.altitudeQuality === undefined) {
        p.altitudeQuality = (typeof p.altitudeM === 'number')
          ? (typeof p.verticalAccuracyM === 'number' && p.verticalAccuracyM <= 20
             ? 'usable'
             : (typeof p.verticalAccuracyM === 'number' && p.verticalAccuracyM <= 40
                ? 'low_confidence' : 'unavailable'))
          : 'unavailable';
        changed = true;
      }
      if (p.sameDirectionConfirmations === undefined) {
        p.sameDirectionConfirmations = (typeof p.confirmedCount === 'number') ? p.confirmedCount : 0;
        changed = true;
      }
      if (p.oppositeDirectionRejects === undefined) {
        p.oppositeDirectionRejects = 0;
        changed = true;
      }
      if (p.directionConfidence === undefined) {
        p.directionConfidence = (p.captureBearing != null) ? 0.5 : 0.2;
        changed = true;
      }
      if (p.observationConfidence === undefined) {
        p.observationConfidence = 0.5;
        changed = true;
      }
      if (p.confidenceState === undefined) {
        p.confidenceState = p.confidenceStatus || 'possible';
        changed = true;
      }
      if (p.fingerprintVersion === undefined) {
        p.fingerprintVersion = 1;
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
      // v23.7.2 — optional revalidation prompt for stored speed-limit
      // observations. When ON, the app may ask "The speed limit here is
      // N. Confirm?" as the user approaches a saved speed_change point.
      // Default OFF — must be explicitly enabled per spec; never fires
      // automatically out of the box.
      speedLimitRevalidation: false,
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
      // bidirectional, source, routeTags, roadName, lastConfirmedAt.
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
   *  for the active destination. Pre-migration data (no routePointRefs[])
   *  is left untouched and continues to use the legacy destId filter. */
  addPointToActiveDest(point) {
    this.data.points.push(point);
    const dest = this.activeDest();
    if (!dest) return;
    if (Array.isArray(dest.routePointRefs)) {
      if (!dest.routePointRefs.includes(point.id)) dest.routePointRefs.push(point.id);
    }
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
  playAlertSoundForType(type) {
    const mappedId = this.findMappedSoundId(type);
    if (mappedId) {
      const def = (typeof SoundCatalogue !== 'undefined')
        ? SoundCatalogue.find(s => s.id === mappedId) : null;
      if (def && Array.isArray(def.pattern) && def.pattern.length) {
        const ctx = this.ensure();
        if (ctx) {
          this.playPattern(def.pattern, { intensity: 0.7 });
          // Vibration mirror — silent-mode safety net (matches Audio.beep)
          if (navigator.vibrate) {
            const totalMs = Math.round(def.pattern.reduce((s, p) => s + p.dur + 0.05, 0) * 1000);
            try { navigator.vibrate(Math.max(60, totalMs)); } catch (e) {}
          }
          return;
        }
      }
    }
    // No mapping (or catalogue lookup failed) → legacy radar tones
    this.beep(type);
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
      return { ok: true };
    } catch (e) {
      onStatus('Failed');
      if (this._previewToken === myToken) this._previewCancelPrev = null;
      try { logEvent('SOUND', '[SOUND] preview failed: ' + (e && e.message || e), 'err'); } catch (err) {}
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
    const voiceOn = State.settings.voiceGender && State.settings.voiceGender !== 'none';
    const fireOnce = () => {
      // v22.32: tone ALWAYS plays (unless master sound is off, which is checked above)
      // v23.7.0: route through playAlertSoundForType so the Sound
      // Alerts mapping (Settings → Sound Alerts / Edit Point's
      // "Sound alert" row) controls the actual peep.
      this.playAlertSoundForType(point.type);
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
    // v23.9.0: reset Road Movement Fingerprint runtime buffers + state
    // machine so a fresh drive does not inherit stale heading / U-turn /
    // passed-sequence context from the previous session.
    try { if (typeof RoadMovement !== 'undefined') RoadMovement.resetTripState(); } catch (e) {}
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

    if (State.activeTrip) {
      const kmh = State.speedMps * 3.6;
      if (kmh > State.activeTrip.maxSpeed) State.activeTrip.maxSpeed = kmh;
      if (prevPos && State.speedMps > 1) {
        const segKm = Utils.distKm(prevPos, State.pos);
        if (segKm < 1) State.activeTrip.distanceKm += segKm;
      }
    }

    // v23.9.0: feed the Road Movement Fingerprint buffer + tick the
    // U-turn / movement state machine. Wrapped so a thrown error in the
    // movement module NEVER breaks the GPS loop — alerts and UI must
    // keep working even when the new helpers are unavailable.
    try {
      if (typeof RoadMovement !== 'undefined') {
        RoadMovement.pushSample(pos.coords, pos.timestamp || Date.now());
        RoadMovement.tickMovementState(Date.now());
      }
    } catch (e) {
      try { logEvent('RMF', '[RMF] tick step-down: ' + (e && e.message || e), 'err'); } catch (_) {}
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
   4c. ROAD MOVEMENT FINGERPRINT — v23.9.0
   Directional-alert hardening. Replaces proximity-only matching
   for directional types with evidence-based scoring built from a
   short rolling movement buffer + capture-time enrichment.

   Source of truth stays in State.data.points; this module never
   creates a parallel store. It is additive only:
     - runtime buffer in RoadMovement._samples (not persisted)
     - capture-time enrichment via RoadMovement.enrichCapture
     - match-time evidence gate via RoadMovement.evaluateAlert
     - U-turn state machine that complements GPS._handleUTurn
     - recent passed-point sequence (runtime only)
     - altitude as supporting evidence (never primary)
     - decision-function replay harness for testing without driving

   Failure mode: every public entry point is wrapped so a thrown
   exception NEVER breaks the GPS loop. On any internal failure the
   gate steps down to "insufficient_evidence" and lets the caller
   keep the existing safe behavior path (location-based / legacy
   compatibility fallback).

   Thresholds live in RoadMovementConfig — single source so tuning
   is one edit, not a hunt across the file.
   ============================================================ */
const RoadMovementConfig = {
  // GPS quality bands (horizontal).
  H_ACC_GOOD_M:     15,
  H_ACC_DEGRADED_M: 25,
  // Altitude (vertical) quality bands.
  V_ACC_USABLE_M:        20,
  V_ACC_LOW_CONF_M:      40,
  // Movement reliability thresholds.
  HEADING_TRUST_SPEED_MPS: 1.5,
  MIN_SAMPLES_FOR_BEARING: 3,
  STABLE_BEARING_MAX_SPREAD_DEG: 30,
  // Direction-delta bands (Phase 5).
  DIR_SAME_MAX_DEG:       35,
  DIR_WEAK_MAX_DEG:       70,
  DIR_AMBIG_MAX_DEG:     120,
  // Ahead-delta bands (Phase 5).
  AHEAD_MAX_DEG:          45,
  AHEAD_SIDE_MAX_DEG:     90,
  AHEAD_SIDE_BEHIND_MAX:  135,
  // U-turn detection (Phase 6).
  UTURN_BEARING_DELTA:    120,
  UTURN_PERSIST_TICKS:    2,
  UTURN_FRESH_WINDOW_MS:  15000,
  // Distance / approach trend tolerances.
  APPROACH_MIN_CLOSE_M:   2,
  CLOSE_TRUST_M:          120,
  // Buffer sizing (Phase 2).
  BUFFER_MAX_SAMPLES:     30,
  BUFFER_MAX_AGE_MS:      90000,
  // Recent-passed-points sequence (Phase 7).
  PASSED_SEQUENCE_MAX:    8,
  PASSED_SEQUENCE_TTL_MS: 600000,
  // Confidence floors for weak/ambiguous bands (Phase 5/9).
  WEAK_DIR_MIN_SCORE:     55,
  AMBIG_MIN_SCORE:        80,
  // Logging throttle per (point, decision).
  DECISION_LOG_THROTTLE_MS: 4000,
  // Step-down log throttle (Phase 10).
  STEPDOWN_LOG_THROTTLE_MS: 30000,
  // Replay harness identifier.
  FINGERPRINT_VERSION: 1,
};

const RoadMovement = {
  // ---- runtime state (not persisted) ----
  _samples: [],
  _movementState: 'UNKNOWN',
  _movementStatePrev: 'UNKNOWN',
  _stableBearingCurr: null,
  _stableBearingPrev: null,
  _uturnTickCount: 0,
  _lastUTurnAt: 0,
  _passedSequence: [],
  _decisionLogAt: new Map(),
  _stepdownLogAt: new Map(),
  _lastDecisionByPoint: new Map(),
  _lastTickDiag: null,

  /** Reset runtime state — called when GPS.start() resets the trip. */
  resetTripState() {
    this._samples = [];
    this._movementState = 'UNKNOWN';
    this._movementStatePrev = 'UNKNOWN';
    this._stableBearingCurr = null;
    this._stableBearingPrev = null;
    this._uturnTickCount = 0;
    this._lastUTurnAt = 0;
    this._passedSequence = [];
    this._decisionLogAt.clear();
    this._stepdownLogAt.clear();
    this._lastDecisionByPoint.clear();
    this._lastTickDiag = null;
  },

  /** Phase 4 — directional alert types. */
  DIRECTIONAL_TYPES: new Set([
    'speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera',
    'speed_change', 'checkpoint', 'traffic_light', 'gate',
  ]),
  /** Phase 4 — location-based alert type(s). */
  LOCATION_TYPES: new Set(['petrol']),

  /** Phase 4 — true when the point's type should be evidence-gated.
   *  "other" defaults to directional (reported in trace findings). */
  isDirectionalType(type) {
    if (!type) return false;
    if (this.LOCATION_TYPES.has(type)) return false;
    if (this.DIRECTIONAL_TYPES.has(type)) return true;
    return type === 'other'; // default per spec
  },

  // ---- Phase 1: pure helpers ----

  /** Shortest-arc angular difference in degrees, [0, 180]. */
  circularAngleDelta(a, b) {
    if (a == null || b == null || isNaN(a) || isNaN(b)) return null;
    let d = Math.abs((a - b) % 360);
    if (d > 180) d = 360 - d;
    return d;
  },

  /** Initial-bearing from (lat1,lng1) to (lat2,lng2), degrees [0,360). */
  bearingBetween(lat1, lng1, lat2, lng2) {
    return Speed.bearingBetween(lat1, lng1, lat2, lng2);
  },

  /** Classify a direction delta into one of the Phase 5 bands. */
  classifyDirectionDelta(deltaDeg) {
    if (deltaDeg == null) return 'unknown';
    const C = RoadMovementConfig;
    if (deltaDeg <= C.DIR_SAME_MAX_DEG)  return 'same_direction';
    if (deltaDeg <= C.DIR_WEAK_MAX_DEG)  return 'weak_same_direction';
    if (deltaDeg <= C.DIR_AMBIG_MAX_DEG) return 'ambiguous';
    return 'opposite_direction';
  },

  /** Classify an ahead-delta into one of the Phase 5 bands. */
  classifyAheadDelta(deltaDeg) {
    if (deltaDeg == null) return 'unknown';
    const C = RoadMovementConfig;
    if (deltaDeg <= C.AHEAD_MAX_DEG)        return 'ahead';
    if (deltaDeg <= C.AHEAD_SIDE_MAX_DEG)   return 'side_or_curve';
    if (deltaDeg <= C.AHEAD_SIDE_BEHIND_MAX) return 'side_behind';
    return 'behind';
  },

  /** Approach bearing from recent samples: vector-sum of step bearings,
   *  weighted by step length. Returns null if insufficient movement. */
  calculateApproachBearing(recentSamples) {
    const C = RoadMovementConfig;
    if (!Array.isArray(recentSamples) || recentSamples.length < 2) return null;
    let sx = 0, sy = 0, totalW = 0;
    for (let i = 1; i < recentSamples.length; i++) {
      const a = recentSamples[i - 1];
      const b = recentSamples[i];
      if (!a || !b || a.lat == null || b.lat == null) continue;
      const dM = Utils.distKm(a, b) * 1000;
      if (dM < C.APPROACH_MIN_CLOSE_M) continue;
      const bg = this.bearingBetween(a.lat, a.lng, b.lat, b.lng);
      const rad = bg * Math.PI / 180;
      sx += Math.cos(rad) * dM;
      sy += Math.sin(rad) * dM;
      totalW += dM;
    }
    if (totalW < C.APPROACH_MIN_CLOSE_M * 2) return null;
    let avg = Math.atan2(sy, sx) * 180 / Math.PI;
    if (avg < 0) avg += 360;
    return avg;
  },

  /** Stable bearing — vector-average of the most recent valid headings.
   *  Returns null when fewer than 3 reliable samples are available. */
  calculateStableBearing(recentSamples) {
    const C = RoadMovementConfig;
    if (!Array.isArray(recentSamples)) return null;
    let sx = 0, sy = 0, n = 0;
    for (const s of recentSamples) {
      if (!s || s.headingDeg == null || isNaN(s.headingDeg)) continue;
      if (s.speedMps != null && s.speedMps < C.HEADING_TRUST_SPEED_MPS) continue;
      const rad = s.headingDeg * Math.PI / 180;
      sx += Math.cos(rad);
      sy += Math.sin(rad);
      n++;
    }
    if (n < C.MIN_SAMPLES_FOR_BEARING) return null;
    let avg = Math.atan2(sy / n, sx / n) * 180 / Math.PI;
    if (avg < 0) avg += 360;
    return avg;
  },

  /** Distance trend: 'approaching' / 'receding' / 'flat' / 'unknown'.
   *  Compares first vs last distance in the window. */
  calculateDistanceTrend(point, recentSamples) {
    if (!point || !Array.isArray(recentSamples) || recentSamples.length < 2) return 'unknown';
    const first = recentSamples[0];
    const last  = recentSamples[recentSamples.length - 1];
    if (!first || !last || first.lat == null || last.lat == null) return 'unknown';
    const d0 = Utils.distKm(first, point) * 1000;
    const d1 = Utils.distKm(last,  point) * 1000;
    const delta = d0 - d1;
    if (Math.abs(delta) < 5) return 'flat';
    return (delta > 0) ? 'approaching' : 'receding';
  },

  /** Altitude trend over the window: 'climbing' / 'descending' / 'flat' /
   *  'unknown'. Uses only samples with usable altitudeQuality. */
  calculateAltitudeTrend(recentSamples) {
    if (!Array.isArray(recentSamples) || recentSamples.length < 3) return 'unknown';
    const usable = recentSamples.filter(s =>
      s && s.altitudeM != null && s.altitudeQuality && s.altitudeQuality !== 'unavailable'
    );
    if (usable.length < 3) return 'unknown';
    const first = usable[0].altitudeM;
    const last  = usable[usable.length - 1].altitudeM;
    const delta = last - first;
    if (Math.abs(delta) < 2) return 'flat';
    return (delta > 0) ? 'climbing' : 'descending';
  },

  /** GPS quality tier from horizontal accuracy. */
  calculateGpsQuality(sample) {
    const C = RoadMovementConfig;
    const acc = sample && sample.horizontalAccuracyM;
    if (acc == null || isNaN(acc)) return 'unknown';
    if (acc <= C.H_ACC_GOOD_M)     return 'good';
    if (acc <= C.H_ACC_DEGRADED_M) return 'degraded';
    return 'poor';
  },

  /** Altitude quality tier from vertical accuracy. */
  calculateAltitudeQuality(sample) {
    const C = RoadMovementConfig;
    if (!sample || sample.altitudeM == null) return 'unavailable';
    const vacc = sample.verticalAccuracyM;
    if (vacc == null || isNaN(vacc) || vacc > C.V_ACC_LOW_CONF_M) return 'unavailable';
    if (vacc <= C.V_ACC_USABLE_M)   return 'usable';
    return 'low_confidence';
  },

  /** Is the point ahead of the vehicle given the current approach bearing?
   *  Returns { aheadDelta, band }. band ∈ ahead/side_or_curve/side_behind/behind/unknown. */
  isPointAheadOfVehicle(currentPosition, point, currentApproachBearing) {
    if (!currentPosition || !point || currentApproachBearing == null) {
      return { aheadDelta: null, band: 'unknown' };
    }
    const bToPoint = this.bearingBetween(currentPosition.lat, currentPosition.lng, point.lat, point.lng);
    const delta = this.circularAngleDelta(currentApproachBearing, bToPoint);
    return { aheadDelta: delta, band: this.classifyAheadDelta(delta) };
  },

  /** Phase 6 — classify movement state from recent samples + previous
   *  stable bearing. States:
   *    UNKNOWN, FORWARD_TRACKING, TURNING, UTURN_DETECTED,
   *    REVERSE_TRACKING, AMBIGUOUS.
   *  Detection is conservative: requires persistence across multiple
   *  valid samples. Caller is responsible for clearing candidates on
   *  UTURN_DETECTED. */
  classifyMovementState(recentSamples, previousStableBearing) {
    const C = RoadMovementConfig;
    if (!Array.isArray(recentSamples) || recentSamples.length < C.MIN_SAMPLES_FOR_BEARING) {
      return { state: 'UNKNOWN', stableBearing: null, reason: 'insufficient_movement_history' };
    }
    const stable = this.calculateStableBearing(recentSamples);
    if (stable == null) {
      return { state: 'AMBIGUOUS', stableBearing: null, reason: 'no_stable_bearing' };
    }
    if (previousStableBearing == null) {
      return { state: 'FORWARD_TRACKING', stableBearing: stable, reason: 'first_stable_bearing' };
    }
    const delta = this.circularAngleDelta(previousStableBearing, stable);
    if (delta == null) {
      return { state: 'AMBIGUOUS', stableBearing: stable, reason: 'bearing_compare_unknown' };
    }
    if (delta > C.UTURN_BEARING_DELTA) {
      return { state: 'UTURN_DETECTED', stableBearing: stable, reason: 'reversed_stable_bearing', delta };
    }
    if (delta > 60) {
      return { state: 'TURNING', stableBearing: stable, reason: 'large_bearing_change', delta };
    }
    return { state: 'FORWARD_TRACKING', stableBearing: stable, reason: 'stable_forward', delta };
  },

  /** Phase 1/5 — pure-math fingerprint score for (point, runtime). NOT a
   *  driver-facing decision; the evidence gate (evaluateAlert) consumes
   *  this output. Returns null when the point is missing, or when there
   *  is no usable runtime state — never throws. */
  calculateRoadMovementFingerprint(point, runtimeState) {
    if (!point || !runtimeState) return null;
    const r = runtimeState;
    const C = RoadMovementConfig;
    const out = {
      fingerprintVersion: C.FINGERPRINT_VERSION,
      distM: null,
      directionDelta: null,
      directionBand: 'unknown',
      aheadDelta: null,
      aheadBand: 'unknown',
      distanceTrend: 'unknown',
      altitudeTrend: 'unknown',
      altitudeDeltaM: null,
      gpsQuality: r.gpsQuality || 'unknown',
      altitudeQuality: r.altitudeQuality || 'unavailable',
      movementState: r.movementState || 'UNKNOWN',
      uTurnFresh: !!r.uTurnFresh,
      hasRecentSequenceSupport: false,
      sequenceConflict: false,
      score: 0,
      reasons: [],
    };
    if (!r.position) return out;
    out.distM = Utils.distKm(r.position, point) * 1000;
    // Direction match
    const capturedBearing =
      (point.capturedHeadingDeg != null) ? point.capturedHeadingDeg :
      (point.approachBearingDeg != null) ? point.approachBearingDeg :
      (point.captureBearing     != null) ? point.captureBearing     :
      (typeof point.heading === 'number') ? point.heading : null;
    if (capturedBearing != null && r.approachBearing != null) {
      out.directionDelta = this.circularAngleDelta(capturedBearing, r.approachBearing);
      out.directionBand  = this.classifyDirectionDelta(out.directionDelta);
    }
    // Ahead
    if (r.approachBearing != null) {
      const ahead = this.isPointAheadOfVehicle(r.position, point, r.approachBearing);
      out.aheadDelta = ahead.aheadDelta;
      out.aheadBand  = ahead.band;
    }
    // Distance trend
    out.distanceTrend = this.calculateDistanceTrend(point, r.samples || []);
    // Altitude
    if (Array.isArray(r.samples) && r.samples.length) {
      out.altitudeTrend = this.calculateAltitudeTrend(r.samples);
      const last = r.samples[r.samples.length - 1];
      if (last && last.altitudeM != null && typeof point.altitudeM === 'number') {
        out.altitudeDeltaM = last.altitudeM - point.altitudeM;
      }
    }
    // Recent passed sequence support / conflict (Phase 7)
    const seq = this._passedSequence;
    if (seq.length >= 2) {
      const last2 = seq.slice(-2);
      const bA = last2[0].passBearingDeg;
      const bB = last2[1].passBearingDeg;
      if (bA != null && bB != null) {
        const dAB = this.circularAngleDelta(bA, bB);
        const supports = (dAB != null && dAB <= C.DIR_SAME_MAX_DEG);
        const reverses = (dAB != null && dAB > C.DIR_AMBIG_MAX_DEG);
        out.hasRecentSequenceSupport = supports;
        out.sequenceConflict = reverses;
      }
    }
    // Score assembly (Phase 9 — supporting evidence only)
    let score = 0;
    if (out.directionBand === 'same_direction') { score += 35; out.reasons.push('direction_same +35'); }
    else if (out.directionBand === 'weak_same_direction') { score += 18; out.reasons.push('direction_weak +18'); }
    else if (out.directionBand === 'ambiguous') { score += 0;  out.reasons.push('direction_ambiguous 0'); }
    else if (out.directionBand === 'opposite_direction') { score -= 50; out.reasons.push('direction_opposite -50'); }
    if (out.aheadBand === 'ahead') { score += 25; out.reasons.push('ahead +25'); }
    else if (out.aheadBand === 'side_or_curve') { score += 10; out.reasons.push('side_or_curve +10'); }
    else if (out.aheadBand === 'side_behind') { score -= 15; out.reasons.push('side_behind -15'); }
    else if (out.aheadBand === 'behind') { score -= 50; out.reasons.push('behind -50'); }
    if (out.distanceTrend === 'approaching') { score += 15; out.reasons.push('approaching +15'); }
    else if (out.distanceTrend === 'receding') { score -= 15; out.reasons.push('receding -15'); }
    if (out.gpsQuality === 'good') { score += 8; out.reasons.push('gps_good +8'); }
    else if (out.gpsQuality === 'degraded') { /* neutral */ out.reasons.push('gps_degraded 0'); }
    else if (out.gpsQuality === 'poor') { score -= 18; out.reasons.push('gps_poor -18'); }
    if (out.movementState === 'UTURN_DETECTED' || out.uTurnFresh) { score -= 30; out.reasons.push('u_turn -30'); }
    if (out.movementState === 'TURNING') { score -= 10; out.reasons.push('turning -10'); }
    if (out.hasRecentSequenceSupport) { score += 8; out.reasons.push('sequence_support +8'); }
    if (out.sequenceConflict)        { score -= 12; out.reasons.push('sequence_conflict -12'); }
    if (out.altitudeQuality === 'usable') {
      if (out.altitudeTrend !== 'unknown' && point.altitudeTrend && out.altitudeTrend === point.altitudeTrend) {
        score += 4; out.reasons.push('altitude_trend_match +4');
      } else if (out.altitudeTrend !== 'unknown' && point.altitudeTrend
                 && out.altitudeTrend !== 'flat' && point.altitudeTrend !== 'flat'
                 && out.altitudeTrend !== point.altitudeTrend) {
        score -= 4; out.reasons.push('altitude_trend_conflict -4');
      }
    }
    out.score = Math.max(0, Math.min(100, score + 50)); // anchor neutral at 50
    return out;
  },

  // ---- Phase 2: movement buffer ----

  /** Push a normalized GPS sample into the rolling buffer. Returns the
   *  inserted sample or null when the input was rejected. Never throws.
   *  Buffer is runtime-only — never persisted. */
  pushSample(coords, timestamp) {
    try {
      const C = RoadMovementConfig;
      if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
        return null;
      }
      const sample = {
        lat: coords.latitude,
        lng: coords.longitude,
        timestamp: timestamp || Date.now(),
        speedMps: (typeof coords.speed === 'number' && coords.speed >= 0 && !isNaN(coords.speed))
          ? coords.speed : null,
        headingDeg: (typeof coords.heading === 'number' && !isNaN(coords.heading))
          ? coords.heading : null,
        altitudeM: (typeof coords.altitude === 'number' && !isNaN(coords.altitude))
          ? coords.altitude : null,
        horizontalAccuracyM: (typeof coords.accuracy === 'number' && !isNaN(coords.accuracy))
          ? coords.accuracy : null,
        verticalAccuracyM: (typeof coords.altitudeAccuracy === 'number' && !isNaN(coords.altitudeAccuracy))
          ? coords.altitudeAccuracy : null,
      };
      sample.gpsQuality = this.calculateGpsQuality(sample);
      sample.altitudeQuality = this.calculateAltitudeQuality(sample);
      // Validity flags — keep the sample but mark it.
      sample.validForBearing = (sample.gpsQuality !== 'poor')
        && (sample.speedMps == null || sample.speedMps >= C.HEADING_TRUST_SPEED_MPS);
      this._samples.push(sample);
      // Trim by size and age.
      while (this._samples.length > C.BUFFER_MAX_SAMPLES) this._samples.shift();
      const now = sample.timestamp;
      while (this._samples.length && (now - this._samples[0].timestamp) > C.BUFFER_MAX_AGE_MS) {
        this._samples.shift();
      }
      return sample;
    } catch (e) {
      this._safeLog('pushSample threw', e);
      return null;
    }
  },

  /** Slice of the buffer with samples newer than maxAgeMs (default: full
   *  window). Returns a shallow copy so callers can safely sort/filter. */
  recentSamples(maxAgeMs) {
    const win = (maxAgeMs == null) ? RoadMovementConfig.BUFFER_MAX_AGE_MS : maxAgeMs;
    const now = Date.now();
    return this._samples.filter(s => (now - s.timestamp) <= win).slice();
  },

  // ---- Phase 3: capture-time enrichment ----

  /** Enrich a freshly captured point in place with road-movement
   *  metadata. Additive only — never overwrites existing meaningful
   *  values unless the new value is clearly better quality. Safe to
   *  call even when GPS state is sparse: missing fields are recorded
   *  with explicit "unknown" / "unavailable" status. */
  enrichCapture(point) {
    try {
      if (!point || typeof point !== 'object') return point;
      const C = RoadMovementConfig;
      const samples = this.recentSamples();
      const last = samples.length ? samples[samples.length - 1] : null;
      const approachBearing = this.calculateApproachBearing(samples);
      const stableBearing   = this.calculateStableBearing(samples);
      const altitudeTrend   = this.calculateAltitudeTrend(samples);
      const stateInfo = this.classifyMovementState(samples, this._stableBearingPrev);
      const nowIso = new Date().toISOString();

      const setIfUndef = (k, v) => { if (point[k] === undefined) point[k] = v; };

      // capturedHeadingDeg — prefer device/GPS heading at capture time;
      // fall back to stable bearing from movement.
      const headingAtCapture = (last && last.headingDeg != null) ? last.headingDeg
        : (typeof State !== 'undefined' && State.heading != null) ? State.heading
        : null;
      setIfUndef('capturedHeadingDeg', headingAtCapture);
      setIfUndef('approachBearingDeg', approachBearing);
      // Mirror to legacy captureBearing/heading when those are missing,
      // so existing scoring code keeps working.
      if (point.captureBearing == null) {
        if (approachBearing != null) point.captureBearing = approachBearing;
        else if (headingAtCapture != null) point.captureBearing = headingAtCapture;
      }
      if (point.heading == null && point.captureBearing != null) {
        point.heading = point.captureBearing;
      }

      const dirBucket = (approachBearing != null) ? Math.round(approachBearing / 22.5) * 22.5 % 360 : null;
      setIfUndef('directionBucket', dirBucket);
      setIfUndef('directionStatus', approachBearing != null ? 'known' : 'unknown');
      if (approachBearing == null) {
        setIfUndef('directionStatusReason', samples.length < C.MIN_SAMPLES_FOR_BEARING
          ? 'insufficient_movement_history' : 'no_stable_bearing');
      }

      // GPS / speed / altitude snapshot.
      setIfUndef('gpsAccuracyM', last && last.horizontalAccuracyM != null
        ? last.horizontalAccuracyM
        : (typeof State !== 'undefined' && typeof State.accuracy === 'number' ? State.accuracy : null));
      setIfUndef('speedMps', last && last.speedMps != null
        ? last.speedMps
        : (typeof State !== 'undefined' && State.speedMps != null ? State.speedMps : null));
      setIfUndef('altitudeM', last && last.altitudeM != null
        ? last.altitudeM
        : (typeof State !== 'undefined' && State.altitude != null ? State.altitude : null));
      setIfUndef('verticalAccuracyM', last && last.verticalAccuracyM != null
        ? last.verticalAccuracyM
        : (typeof State !== 'undefined' && State.altitudeAccuracy != null ? State.altitudeAccuracy : null));
      setIfUndef('altitudeTrend', altitudeTrend);
      const altQ = this.calculateAltitudeQuality({
        altitudeM: point.altitudeM,
        verticalAccuracyM: point.verticalAccuracyM,
      });
      setIfUndef('altitudeQuality', altQ);
      setIfUndef('altitudeStatus',
        point.altitudeM == null ? 'unavailable'
          : (altQ === 'low_confidence' ? 'low_confidence' : 'known'));

      setIfUndef('movementStateAtCapture', stateInfo.state);

      // Lifecycle timestamps.
      setIfUndef('capturedAt', point.createdAt || nowIso);
      setIfUndef('firstSeenAt', point.firstSeenAt || point.createdAt || nowIso);
      setIfUndef('lastSeenAt', point.lastSeenAt || nowIso);
      setIfUndef('lastConfirmedAt', null);
      setIfUndef('lastPassedAt', null);
      setIfUndef('lastDirectionMatchedAt', null);
      setIfUndef('lastOppositeSuppressedAt', null);

      // Counters / confidence (Phase 9).
      setIfUndef('sameDirectionConfirmations', 0);
      setIfUndef('oppositeDirectionRejects', 0);
      setIfUndef('directionConfidence', approachBearing != null ? 0.5 : 0.2);
      setIfUndef('observationConfidence', 0.5);
      setIfUndef('confidenceState', point.confidenceStatus
        ? point.confidenceStatus
        : 'possible');
      setIfUndef('fingerprintVersion', C.FINGERPRINT_VERSION);

      return point;
    } catch (e) {
      this._safeLog('enrichCapture threw', e);
      return point;
    }
  },

  // ---- Phase 12: existing point lazy migration ----

  /** Lazy migration helper — called from Alerts.tick when a point is
   *  next observed with reliable data. Additive only. Never throws. */
  enrichExistingLazy(point, opportunity) {
    try {
      if (!point) return false;
      let touched = false;
      const setIfUndef = (k, v) => {
        if (point[k] === undefined) { point[k] = v; touched = true; }
      };
      setIfUndef('directionStatus', point.captureBearing != null ? 'known' : 'unknown');
      setIfUndef('altitudeStatus', point.altitudeM != null ? 'known' : 'unavailable');
      setIfUndef('altitudeQuality', this.calculateAltitudeQuality({
        altitudeM: point.altitudeM,
        verticalAccuracyM: point.verticalAccuracyM,
      }));
      setIfUndef('sameDirectionConfirmations', 0);
      setIfUndef('oppositeDirectionRejects', 0);
      setIfUndef('directionConfidence', point.captureBearing != null ? 0.5 : 0.2);
      setIfUndef('observationConfidence', 0.5);
      setIfUndef('confidenceState', point.confidenceStatus || 'possible');
      setIfUndef('fingerprintVersion', RoadMovementConfig.FINGERPRINT_VERSION);
      setIfUndef('firstSeenAt', point.createdAt || null);
      setIfUndef('lastSeenAt', point.lastObservedAt || point.updatedAt || point.createdAt || null);
      if (touched) {
        try { logEvent('RMF-MIGRATE', `[RMF-MIGRATE] ${point.id} (${point.type}) on ${opportunity || 'observe'}`); } catch (e) {}
      }
      return touched;
    } catch (e) {
      this._safeLog('enrichExistingLazy threw', e);
      return false;
    }
  },

  // ---- Phase 5/6/7/8: match-time evidence gate ----

  /** Build the runtime state passed to the fingerprint + gate. Reads
   *  the latest sample, current movement state, and approach bearing. */
  buildRuntimeState() {
    const samples = this.recentSamples();
    const last = samples.length ? samples[samples.length - 1] : null;
    const approachBearing = this.calculateApproachBearing(samples);
    const stableBearing   = this.calculateStableBearing(samples);
    const headingSource =
      (approachBearing != null) ? 'movement_trail'
      : (last && last.headingDeg != null && last.speedMps != null && last.speedMps >= RoadMovementConfig.HEADING_TRUST_SPEED_MPS)
        ? 'raw_heading'
        : (last && last.headingDeg != null) ? 'raw_heading_low_speed'
        : 'none';
    const usedBearing =
      (approachBearing != null) ? approachBearing
      : (last && last.headingDeg != null && last.speedMps != null && last.speedMps >= RoadMovementConfig.HEADING_TRUST_SPEED_MPS)
        ? last.headingDeg
        : null;
    return {
      samples,
      lastSample: last,
      position: last ? { lat: last.lat, lng: last.lng } : (State.pos ? { lat: State.pos.lat, lng: State.pos.lng } : null),
      approachBearing: usedBearing,
      headingSource,
      stableBearing,
      gpsQuality: last ? last.gpsQuality : 'unknown',
      altitudeQuality: last ? last.altitudeQuality : 'unavailable',
      movementState: this._movementState,
      movementStatePrev: this._movementStatePrev,
      uTurnFresh: this.isUTurnFresh(),
      speedMps: (last && last.speedMps != null) ? last.speedMps
        : (typeof State !== 'undefined' && State.speedMps != null ? State.speedMps : 0),
      horizontalAccuracyM: last ? last.horizontalAccuracyM : (typeof State !== 'undefined' ? State.accuracy : null),
      verticalAccuracyM: last ? last.verticalAccuracyM : (typeof State !== 'undefined' ? State.altitudeAccuracy : null),
      sampleCount: samples.length,
    };
  },

  /** Phase 5 — evidence gate. Returns:
   *    { allowed, reason, fingerprint, runtimeState, directional, suppressions }
   *  - allowed=false means the directional alert MUST be suppressed for
   *    sound / popup / card flash / feedback prompt.
   *  - allowed=true means caller may proceed using their existing path.
   *  - Non-directional point types short-circuit to allowed=true and a
   *    'location_based_passthrough' reason so caller logic is unchanged.
   *  Never throws — internal failures step down to a permissive verdict
   *  with reason='evidence_gate_stepped_down' so legacy behavior is
   *  preserved on engine failure (one false alert vs. broken app). */
  evaluateAlert(point, options) {
    const C = RoadMovementConfig;
    const opts = options || {};
    const directional = this.isDirectionalType(point && point.type);
    try {
      if (!point) {
        return { allowed: false, reason: 'no_point', directional: false };
      }
      if (!directional) {
        return { allowed: true, reason: 'location_based_passthrough', directional: false };
      }
      const r = this.buildRuntimeState();
      const fp = this.calculateRoadMovementFingerprint(point, r);
      const suppressions = [];

      // Step-down: insufficient movement history. Permissive but
      // tagged so caller (and debug) can see why.
      if (r.sampleCount < C.MIN_SAMPLES_FOR_BEARING) {
        this._stepdownLog('insufficient_movement_history',
          `point=${point.id} samples=${r.sampleCount}`);
        return {
          allowed: true,
          reason: 'insufficient_movement_history',
          directional: true,
          fingerprint: fp,
          runtimeState: r,
          suppressions,
        };
      }

      // Hard suppressions per spec.
      if (r.gpsQuality === 'poor' && !opts.alreadyTrusted) {
        suppressions.push('gps_low_confidence_suppression');
      }
      if (fp && fp.aheadBand === 'behind') {
        suppressions.push('behind_vehicle');
      }
      if (fp && fp.directionBand === 'opposite_direction') {
        suppressions.push('opposite_direction');
      }
      if (this.isUTurnFresh() && !opts.candidateRebuilt) {
        suppressions.push('u_turn_stale_candidate');
      }
      if (r.movementState === 'TURNING' && !opts.criticalAndAhead) {
        suppressions.push('turning_state');
      }
      if (fp && fp.sequenceConflict) {
        suppressions.push('recent_sequence_reversed');
      }

      // Soft band rules (Phase 5).
      let allowed = true;
      let reason = 'evidence_ok';
      if (suppressions.length) {
        allowed = false;
        reason = suppressions[0];
      } else if (fp && fp.directionBand === 'weak_same_direction') {
        if (fp.score < C.WEAK_DIR_MIN_SCORE) {
          allowed = false;
          suppressions.push('weak_direction_low_score');
          reason = 'weak_direction_low_score';
        } else {
          reason = 'evidence_weak_direction_ok';
        }
      } else if (fp && fp.directionBand === 'ambiguous') {
        const veryClose = fp.distM != null && fp.distM <= C.CLOSE_TRUST_M;
        if (!(opts.alreadyTrusted && veryClose) && fp.score < C.AMBIG_MIN_SCORE) {
          allowed = false;
          suppressions.push('ambiguous_direction');
          reason = 'ambiguous_direction';
        } else {
          reason = 'evidence_ambiguous_close_trusted';
        }
      } else if (fp && fp.aheadBand === 'side_behind') {
        if (!opts.alreadyTrusted) {
          allowed = false;
          suppressions.push('side_behind');
          reason = 'side_behind';
        }
      }

      // Stamp the decision on the point (Phase 9 counters).
      try {
        const ts = new Date().toISOString();
        if (allowed && fp && fp.directionBand === 'same_direction') {
          point.sameDirectionConfirmations = (point.sameDirectionConfirmations || 0) + 1;
          point.lastDirectionMatchedAt = ts;
        } else if (!allowed && fp && fp.directionBand === 'opposite_direction') {
          point.oppositeDirectionRejects = (point.oppositeDirectionRejects || 0) + 1;
          point.lastOppositeSuppressedAt = ts;
        }
      } catch (e) { /* never break the gate */ }

      const decision = {
        allowed,
        reason,
        directional: true,
        fingerprint: fp,
        runtimeState: r,
        suppressions,
      };
      this._recordDecision(point, decision);
      return decision;
    } catch (e) {
      this._safeLog('evaluateAlert threw', e);
      return {
        allowed: true,
        reason: 'evidence_gate_stepped_down',
        directional,
        suppressions: ['gate_exception'],
      };
    }
  },

  /** Record + throttle-log a decision. Visible in the debug log. */
  _recordDecision(point, decision) {
    try {
      const pid = point && point.id;
      if (!pid) return;
      this._lastDecisionByPoint.set(pid, { ts: Date.now(), decision });
      const now = Date.now();
      const last = this._decisionLogAt.get(pid) || 0;
      if (now - last < RoadMovementConfig.DECISION_LOG_THROTTLE_MS) return;
      this._decisionLogAt.set(pid, now);
      const fp = decision.fingerprint || {};
      const r  = decision.runtimeState || {};
      const parts = [
        `[RMF] ${pid}`,
        `type=${point.type}`,
        `dist=${fp.distM != null ? Math.round(fp.distM) + 'm' : '—'}`,
        `cur=${r.approachBearing != null ? Math.round(r.approachBearing) + '°' : '—'}`,
        `pt=${(point.capturedHeadingDeg != null ? point.capturedHeadingDeg : point.captureBearing) != null
          ? Math.round(point.capturedHeadingDeg != null ? point.capturedHeadingDeg : point.captureBearing) + '°' : '—'}`,
        `Δh=${fp.directionDelta != null ? Math.round(fp.directionDelta) + '°' : '—'}`,
        `Δa=${fp.aheadDelta != null ? Math.round(fp.aheadDelta) + '°' : '—'}`,
        `dir=${fp.directionBand}`,
        `ahead=${fp.aheadBand}`,
        `mv=${r.movementState}`,
        `gps=${fp.gpsQuality}`,
        `alt=${fp.altitudeQuality}/${fp.altitudeTrend}`,
        `seq=${fp.sequenceConflict ? 'reversed' : fp.hasRecentSequenceSupport ? 'support' : 'n/a'}`,
        `score=${fp.score}`,
        `alert=${decision.allowed ? 'YES' : 'NO'}`,
        `reason=${decision.reason}`,
      ];
      logEvent(decision.allowed ? 'RMF-ALERT' : 'RMF-SUPPRESS', parts.join(' '),
        decision.allowed ? 'ok' : 'err');
    } catch (e) {
      this._safeLog('_recordDecision threw', e);
    }
  },

  /** Quick reference for the Edit Point + Debug surfaces. */
  describeLastDecision(pointId) {
    return this._lastDecisionByPoint.get(pointId) || null;
  },

  // ---- Phase 6: U-turn state machine ----

  /** Tick the movement state machine once per GPS sample. Called from
   *  GPS.onTick after pushSample. On UTURN_DETECTED, clears stale
   *  candidate state via the spec contract:
   *    - State.alertedMarkers / lastDistByPoint / minDistByPoint refreshed
   *    - passedPoints partially cleared (handled by existing GPS._handleUTurn)
   *    - cooldown window opened so suppress_u_turn_stale_candidate fires
   *  Never throws. */
  tickMovementState(now) {
    try {
      const samples = this.recentSamples();
      const info = this.classifyMovementState(samples, this._stableBearingPrev);
      this._movementStatePrev = this._movementState;
      this._stableBearingCurr = info.stableBearing;
      // Persistence: require UTURN_DETECTED to repeat across UTURN_PERSIST_TICKS
      // before promoting (defensive against GPS jitter). The classifier
      // already requires a large delta between previous and current stable
      // bearings; this counter just ensures it persists.
      if (info.state === 'UTURN_DETECTED') {
        this._uturnTickCount = (this._uturnTickCount || 0) + 1;
        if (this._uturnTickCount >= RoadMovementConfig.UTURN_PERSIST_TICKS) {
          this._movementState = 'UTURN_DETECTED';
          this._lastUTurnAt = now || Date.now();
          this._onUTurnPromoted();
          // Rotate so next pass classifies as REVERSE_TRACKING.
          this._stableBearingPrev = info.stableBearing;
          this._uturnTickCount = 0;
          return this._movementState;
        } else {
          this._movementState = 'TURNING';
        }
      } else {
        this._uturnTickCount = 0;
        if (this._movementState === 'UTURN_DETECTED' && info.state === 'FORWARD_TRACKING') {
          this._movementState = 'REVERSE_TRACKING';
        } else {
          this._movementState = info.state;
        }
        // Update previous stable bearing only when we have a fresh one.
        if (info.stableBearing != null) {
          this._stableBearingPrev = info.stableBearing;
        }
      }
      return this._movementState;
    } catch (e) {
      this._safeLog('tickMovementState threw', e);
      return this._movementState;
    }
  },

  /** True while the U-turn cooldown window is open. Candidates that
   *  predate the U-turn must wait this window out before alerting. */
  isUTurnFresh() {
    if (!this._lastUTurnAt) return false;
    return (Date.now() - this._lastUTurnAt) < RoadMovementConfig.UTURN_FRESH_WINDOW_MS;
  },

  /** Hook fired exactly once when UTURN_DETECTED is promoted. Clears
   *  stale forward candidate state so a stale "next alert" cannot
   *  keep firing. Does NOT delete stored points; only runtime state. */
  _onUTurnPromoted() {
    try {
      logEvent('RMF-UTURN', `[RMF-UTURN] state=UTURN_DETECTED · clearing stale forward candidates`, 'ok');
      // Suppress any pending feedback that was queued from the old direction.
      try {
        if (typeof Confirm !== 'undefined' && Confirm._queue) {
          const dropped = Confirm._queue.length;
          Confirm._queue = [];
          if (dropped) logEvent('RMF-UTURN', `[RMF-UTURN] cleared ${dropped} pending feedback prompt(s)`);
        }
      } catch (e) {}
      // Re-arm nearby passed points so the rebuilt candidate list can re-engage.
      try { if (typeof GPS !== 'undefined' && GPS._handleUTurn) GPS._handleUTurn(); } catch (e) {}
      // Open the cooldown window — Alerts.tick will read isUTurnFresh().
      this._lastUTurnAt = Date.now();
    } catch (e) {
      this._safeLog('_onUTurnPromoted threw', e);
    }
  },

  // ---- Phase 7: recent passed-point sequence ----

  /** Record that a point was just passed. Caller (Alerts.tick passed
   *  detection) supplies the distance-at-pass. Sequence is runtime-only
   *  and aged out automatically. */
  recordPassedPoint(point, distAtPass) {
    try {
      if (!point || !point.id) return;
      const C = RoadMovementConfig;
      const r = this.buildRuntimeState();
      const entry = {
        pointId: point.id,
        type: point.type,
        passedAt: Date.now(),
        passBearingDeg: r.approachBearing,
        distanceAtPass: distAtPass != null ? distAtPass : null,
        directionDecision: r.movementState,
        sequenceIndex: this._passedSequence.length,
      };
      // Drop stale entries first.
      const now = entry.passedAt;
      this._passedSequence = this._passedSequence.filter(e =>
        (now - e.passedAt) <= C.PASSED_SEQUENCE_TTL_MS);
      this._passedSequence.push(entry);
      while (this._passedSequence.length > C.PASSED_SEQUENCE_MAX) {
        this._passedSequence.shift();
      }
      // Point-level timestamp.
      try { point.lastPassedAt = new Date(entry.passedAt).toISOString(); } catch (e) {}
      logEvent('RMF-SEQ',
        `[RMF-SEQ] pass ${point.id} bearing=${entry.passBearingDeg != null ? Math.round(entry.passBearingDeg) + '°' : '—'} state=${entry.directionDecision}`);
    } catch (e) {
      this._safeLog('recordPassedPoint threw', e);
    }
  },

  // ---- Phase 1 Mode B replay harness ----

  /** Synthesize a sample for the replay harness. Mirrors the shape of
   *  the live pushSample input but builds a coords-like object. */
  _replaySample(opts) {
    return this.pushSample({
      latitude: opts.lat,
      longitude: opts.lng,
      accuracy: opts.accuracy != null ? opts.accuracy : 10,
      heading: opts.heading != null ? opts.heading : null,
      speed: opts.speed != null ? opts.speed : 15,
      altitude: opts.altitude != null ? opts.altitude : null,
      altitudeAccuracy: opts.altitudeAccuracy != null ? opts.altitudeAccuracy : null,
    }, opts.timestamp || Date.now());
  },

  /** Predefined scenarios — decision-function replay (Mode B). Each
   *  scenario constructs an isolated runtime state, evaluates the gate,
   *  and returns a verdict. Use RoadMovement.runReplay() in the debug
   *  console to run them all. */
  scenarios: {
    'A_same_direction': function(RM) {
      RM.resetTripState();
      // Drive northbound (bearing ~0°). 6 samples advancing ~10 m north each tick.
      const t0 = Date.now() - 6000;
      for (let i = 0; i < 6; i++) {
        RM._replaySample({ lat: 32.0 + i * 0.0001, lng: 35.0, speed: 20, heading: 0,
          accuracy: 8, altitude: 100, altitudeAccuracy: 8, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      const point = { id: '_A', type: 'speed_camera', lat: 32.001, lng: 35.0,
        capturedHeadingDeg: 0, altitudeM: 102, altitudeTrend: 'flat', directional: true };
      return RM.evaluateAlert(point);
    },
    'B_opposite_direction': function(RM) {
      RM.resetTripState();
      // Camera captured northbound (0°); driver travelling southbound (180°).
      const t0 = Date.now() - 6000;
      for (let i = 0; i < 6; i++) {
        RM._replaySample({ lat: 32.001 - i * 0.0001, lng: 35.0, speed: 20, heading: 180,
          accuracy: 8, altitude: 100, altitudeAccuracy: 8, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      const point = { id: '_B', type: 'speed_camera', lat: 32.0, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'C_uturn_before_reach': function(RM) {
      RM.resetTripState();
      const t0 = Date.now() - 12000;
      // First half — drive north.
      for (let i = 0; i < 5; i++) {
        RM._replaySample({ lat: 32.0 + i * 0.0001, lng: 35.0, speed: 18, heading: 0,
          accuracy: 8, timestamp: t0 + i * 1000 });
        RM.tickMovementState();
      }
      // Now u-turn — heading flips to 180°, 5 more samples south.
      for (let i = 0; i < 5; i++) {
        RM._replaySample({ lat: 32.0004 - i * 0.0001, lng: 35.0, speed: 18, heading: 180,
          accuracy: 8, timestamp: t0 + (5 + i) * 1000 });
        RM.tickMovementState();
      }
      const point = { id: '_C', type: 'speed_camera', lat: 32.001, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'D_reversed_sequence': function(RM) {
      RM.resetTripState();
      // Record two passes with opposing bearings — should mark sequenceConflict.
      RM._replaySample({ lat: 32.0, lng: 35.0, speed: 18, heading: 0, accuracy: 8 });
      RM._replaySample({ lat: 32.0001, lng: 35.0, speed: 18, heading: 0, accuracy: 8 });
      RM._replaySample({ lat: 32.0002, lng: 35.0, speed: 18, heading: 0, accuracy: 8 });
      RM.tickMovementState();
      RM.recordPassedPoint({ id: '_D1', type: 'speed_camera' }, 10);
      // Now driver reverses; new pass bearing should be ~180°.
      RM.resetTripState();
      for (let i = 0; i < 4; i++) {
        RM._replaySample({ lat: 32.0003 - i * 0.0001, lng: 35.0, speed: 18, heading: 180,
          accuracy: 8 });
      }
      RM.tickMovementState();
      RM.recordPassedPoint({ id: '_D2', type: 'speed_camera' }, 10);
      // The next candidate ahead — expect sequenceConflict in fingerprint.
      const point = { id: '_D3', type: 'speed_camera', lat: 31.999, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'E_missing_altitude': function(RM) {
      RM.resetTripState();
      const t0 = Date.now() - 4000;
      for (let i = 0; i < 4; i++) {
        RM._replaySample({ lat: 32.0 + i * 0.0001, lng: 35.0, speed: 20, heading: 0,
          accuracy: 8, altitude: null, altitudeAccuracy: null, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      const point = { id: '_E', type: 'speed_camera', lat: 32.001, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'F_poor_altitude_accuracy': function(RM) {
      RM.resetTripState();
      const t0 = Date.now() - 4000;
      for (let i = 0; i < 4; i++) {
        RM._replaySample({ lat: 32.0 + i * 0.0001, lng: 35.0, speed: 20, heading: 0,
          accuracy: 8, altitude: 100, altitudeAccuracy: 80, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      const point = { id: '_F', type: 'speed_camera', lat: 32.001, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'G_poor_gps_accuracy': function(RM) {
      RM.resetTripState();
      const t0 = Date.now() - 4000;
      for (let i = 0; i < 4; i++) {
        RM._replaySample({ lat: 32.0 + i * 0.0001, lng: 35.0, speed: 20, heading: 0,
          accuracy: 80, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      const point = { id: '_G', type: 'speed_camera', lat: 32.001, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'H_point_behind_vehicle': function(RM) {
      RM.resetTripState();
      const t0 = Date.now() - 4000;
      for (let i = 0; i < 4; i++) {
        RM._replaySample({ lat: 32.001 + i * 0.0001, lng: 35.0, speed: 20, heading: 0,
          accuracy: 8, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      // Point sits behind the driver who is moving north.
      const point = { id: '_H', type: 'speed_camera', lat: 32.0, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
    'I_point_ahead_and_approaching': function(RM) {
      RM.resetTripState();
      const t0 = Date.now() - 4000;
      for (let i = 0; i < 4; i++) {
        RM._replaySample({ lat: 32.0 + i * 0.0001, lng: 35.0, speed: 20, heading: 0,
          accuracy: 8, altitude: 100, altitudeAccuracy: 8, timestamp: t0 + i * 1000 });
      }
      RM.tickMovementState();
      const point = { id: '_I', type: 'speed_camera', lat: 32.002, lng: 35.0,
        capturedHeadingDeg: 0, directional: true };
      return RM.evaluateAlert(point);
    },
  },

  /** Run a single replay scenario by name. Returns the decision +
   *  expectation match. */
  runReplay(name) {
    const fn = this.scenarios[name];
    if (typeof fn !== 'function') return { ok: false, error: 'unknown_scenario' };
    const savedSamples = this._samples.slice();
    const savedState = {
      movementState: this._movementState,
      movementStatePrev: this._movementStatePrev,
      stableBearingPrev: this._stableBearingPrev,
      stableBearingCurr: this._stableBearingCurr,
      lastUTurnAt: this._lastUTurnAt,
      uturnTickCount: this._uturnTickCount,
      passedSequence: this._passedSequence.slice(),
    };
    let decision;
    try {
      decision = fn(this);
    } catch (e) {
      decision = { allowed: null, reason: 'replay_exception', error: e && e.message };
    } finally {
      // Restore runtime state — replay must not pollute the live trip.
      this._samples = savedSamples;
      this._movementState        = savedState.movementState;
      this._movementStatePrev    = savedState.movementStatePrev;
      this._stableBearingPrev    = savedState.stableBearingPrev;
      this._stableBearingCurr    = savedState.stableBearingCurr;
      this._lastUTurnAt          = savedState.lastUTurnAt;
      this._uturnTickCount       = savedState.uturnTickCount;
      this._passedSequence       = savedState.passedSequence;
    }
    return { name, decision };
  },

  /** Run every replay scenario and emit a concise PASS/FAIL summary to
   *  the Logger. Expectations are baked in by scenario letter. */
  runReplayAll() {
    const expectations = {
      'A_same_direction':           r => r.allowed === true,
      'B_opposite_direction':       r => r.allowed === false && r.suppressions.includes('opposite_direction'),
      'C_uturn_before_reach':       r => r.allowed === false || r.runtimeState && r.runtimeState.uTurnFresh,
      'D_reversed_sequence':        r => r.allowed === false || (r.fingerprint && r.fingerprint.sequenceConflict),
      'E_missing_altitude':         r => r.allowed === true,
      'F_poor_altitude_accuracy':   r => r.allowed === true,
      'G_poor_gps_accuracy':        r => r.allowed === false && r.suppressions.includes('gps_low_confidence_suppression'),
      'H_point_behind_vehicle':     r => r.allowed === false && r.suppressions.includes('behind_vehicle'),
      'I_point_ahead_and_approaching': r => r.allowed === true,
    };
    const results = [];
    let pass = 0;
    for (const name of Object.keys(this.scenarios)) {
      const out = this.runReplay(name);
      const exp = expectations[name];
      const ok  = exp ? !!exp(out.decision || {}) : true;
      if (ok) pass++;
      results.push({ name, ok, reason: out.decision && out.decision.reason });
      logEvent('RMF-REPLAY',
        `[RMF-REPLAY] ${name} → ${ok ? 'PASS' : 'FAIL'} reason=${out.decision && out.decision.reason}`,
        ok ? 'ok' : 'err');
    }
    logEvent('RMF-REPLAY',
      `[RMF-REPLAY] summary ${pass}/${results.length} passed`,
      pass === results.length ? 'ok' : 'err');
    return { pass, total: results.length, results };
  },

  // ---- Phase 10: step-down / error helpers ----

  _stepdownLog(key, detail) {
    try {
      const now = Date.now();
      const last = this._stepdownLogAt.get(key) || 0;
      if (now - last < RoadMovementConfig.STEPDOWN_LOG_THROTTLE_MS) return;
      this._stepdownLogAt.set(key, now);
      logEvent('RMF', `[RMF] step_down · ${key}` + (detail ? ' · ' + detail : ''));
    } catch (e) {}
  },

  _safeLog(label, err) {
    try {
      logEvent('RMF', `[RMF] ${label}: ${err && err.message ? err.message : err}`, 'err');
    } catch (e) {
      try { console.error('[RMF]', label, err); } catch (_) {}
    }
  },
};

// Convenience: surface replay harness to the window so it can be run
// from the DevTools console without exporting the whole module.
try { if (typeof window !== 'undefined') window.RoadMovement = RoadMovement; } catch (e) {}

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
    const cands = Observations.liveCandidates(userState, routeCoords);
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
      if (!_silent && meters <= _hereRingM && !State.hereAnnouncedPoints.has(p.id)) {
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
        if (State.settings.sound !== 'off' && State.settings.voiceGender !== 'none') {
          Audio.say(text);
        }
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        State.alertsFiredThisTrip = (State.alertsFiredThisTrip || 0) + 1;
        State.lastAlertAt = Date.now();
        State.lastAlertText = name + ' is here';
        logEvent('ALERT', `here-now: ${name} @ ${Math.round(meters)}m (ring=${_hereRingM}m, ${reps}x)`, 'ok');
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
        // v23.9.0: record the pass in the Road Movement sequence so the
        // next directional candidate can read sequence support/conflict.
        try { if (typeof RoadMovement !== 'undefined') RoadMovement.recordPassedPoint(p, curMin); } catch (e) {}
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
          // v23.9.0: record the pass in the Road Movement sequence.
          try { if (typeof RoadMovement !== 'undefined') RoadMovement.recordPassedPoint(p, curMin); } catch (e) {}
          // v22.56: same 30m gate on the geometry-based pass path
          if (curMin != null && curMin <= 30) Confirm.onPassed(p);
        } else {
          State.lastDistByPoint.set(p.id, meters);
        }
        return;
      }

      // v23.9.0: Road Movement Fingerprint evidence gate. Runs ONCE per
      // tick per point on the live alert path. Decision is reused for
      // marker-cross / feedback-prompt / proximity hooks below so we
      // never have two competing verdicts in the same frame.
      let rmfDecision = null;
      try {
        if (typeof RoadMovement !== 'undefined') {
          const trusted = (p.confidenceStatus === 'trusted')
            || (typeof p.confidence === 'number' && p.confidence >= 3);
          // Lazy migrate legacy points the first time we see them ahead.
          if (p.fingerprintVersion === undefined) {
            RoadMovement.enrichExistingLazy(p, 'observed_ahead');
          }
          rmfDecision = RoadMovement.evaluateAlert(p, { alreadyTrusted: trusted });
        }
      } catch (e) {
        try { logEvent('RMF', '[RMF] gate step-down: ' + (e && e.message || e), 'err'); } catch (_) {}
      }
      // Directional + opposite/behind/u-turn → hard suppress for THIS
      // tick. Skip threshold-cross alerts AND the feedback prompt. Map
      // marker, NEXT-AHEAD ordering, and silent state tracking are
      // unchanged so the driver still sees the point on the map.
      const rmfSuppress = !!(rmfDecision && rmfDecision.directional && rmfDecision.allowed === false);

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
      // v23.9.0: suppress when the Road Movement Fingerprint gate
      // rejects the candidate (opposite direction / behind / u-turn).
      if (isFocused && meters <= Confirm.FEEDBACK_DIST_M
          && Confirm.ASKABLE_TYPES.includes(p.type) && !rmfSuppress) {
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
            const suppressedByIntel = (intelMode === 'active' && intelEval && !intelEval.intelligenceWouldAlert);
            // v23.9.0: Road Movement Fingerprint hard-suppresses
            // directional alerts when evidence shows opposite direction,
            // point-behind, U-turn staleness, or low GPS. Non-directional
            // types (petrol) pass straight through.
            const suppressedByRmf = rmfSuppress;
            if (suppressedByIntel) {
              IntelligenceEngine.noteSuppression(p, intelEval, meters, m);
              fired.add(m); // legacy parity: mark the marker as consumed
            } else if (suppressedByRmf) {
              fired.add(m); // mark consumed so we don't fire later when state changes
            } else {
              Audio.alert(p, m);
              if (intelMode === 'active') IntelligenceEngine.noteAlertFired();
              fired.add(m);
              if (navigator.vibrate) navigator.vibrate(60);
            }
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
      if (focusedPoint && !this.PROXIMITY_PING_EXCLUDED_TYPES.has(focusedPoint.type)) {
        const focusedMeters = focusedPoint.dist * 1000;
        Audio.updateProximityPing(focusedId, focusedMeters);
      } else {
        Audio.updateProximityPing(null, null);
      }
    } else {
      Audio.updateProximityPing(null, null);
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
        if (State.settings.sound !== 'off' && State.settings.voiceGender !== 'none') {
          Audio.say(`Speed limit ${limit}`);
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

    // v23.7.2 — optional speed-limit revalidation prompt. Self-gated by
    // setting (default OFF), so this is a no-op unless the user
    // explicitly enabled it in Settings. When ON, finds the nearest
    // saved speed_change point ahead within SPEED_REVAL_DIST_M and asks
    // the driver to confirm or reject the saved limit.
    if (State.settings && State.settings.speedLimitRevalidation) {
      try {
        const userHeading = State.heading;
        const headingReliable = Speed.isHeadingReliable((State.speedMps || 0) * 3.6);
        const candidates = State.data.points
          .filter(p => p && p.type === 'speed_change' && p.status !== 'no')
          .map(p => ({ p, dM: Utils.distKm(State.pos, p) * 1000 }))
          .filter(x => x.dM <= Confirm.SPEED_REVAL_DIST_M)
          .filter(x => {
            // Direction guard: only prompt when going the same way as the
            // captured sign (or when heading isn't reliable / sign has
            // no recorded bearing — legacy data gets the benefit).
            if (!headingReliable) return true;
            if (x.p.captureBearing == null) return true;
            return Speed.headingMatches(userHeading, x.p.captureBearing, 45);
          })
          .sort((a, b) => a.dM - b.dM);
        if (candidates.length) {
          Confirm.requestSpeedLimitConfirm(candidates[0].p, candidates[0].dM);
        }
      } catch (e) {}
    }
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
  // Point types that warrant a confirmation popup.
  ASKABLE_TYPES: ['speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera', 'checkpoint'],
  // After this many consecutive "NO" answers, the point auto-retires (status='no').
  RETIRE_AFTER: 3,
  // v23.7.1: feedback prompt fires when point is this close ahead.
  FEEDBACK_DIST_M: 50,
  // v23.7.1: feedback countdown duration (30 s per spec).
  FEEDBACK_COUNTDOWN_S: 30,
  // v23.7.2 — speed-limit revalidation tuning. Trigger when a saved
  // speed_change is this close ahead; auto-dismiss after this many s
  // if the driver doesn't respond; suppress re-prompt for the same
  // point for this many minutes (additionally to the in-memory
  // _promptedSpeedIds set).
  SPEED_REVAL_DIST_M: 120,
  SPEED_REVAL_COUNTDOWN_S: 20,
  SPEED_REVAL_COOLDOWN_MIN: 30,
  // v23.7.2 — session set of point IDs already prompted for revalidation
  // this trip. Cleared on resetTrip() (GPS restart).
  _promptedSpeedIds: new Set(),
  _speedLimitMode: false,
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
    if (!this.ASKABLE_TYPES.includes(point.type)) return;
    if (point.status === 'no') return;
    if (this._askedThisTrip.has(point.id)) return;
    this._askedThisTrip.add(point.id);
    this._queue.push({ id: point.id, kind: 'ahead', distM });
    try { logEvent('FEEDBACK', `[FEEDBACK] feedback_prompt_shown — ${point.id} @ ${Math.round(distM)}m (ahead)`); } catch (e) {}
    if (!this._activeId) this._showNext();
  },

  /** Legacy onPassed fallback — fires if the user crossed the 50 m
   *  window faster than one GPS tick. Same queue, same guard. */
  onPassed(point) {
    if (!point || !point.id) return;
    if (!this.ASKABLE_TYPES.includes(point.type)) return;
    if (point.status === 'no') return;
    if (this._askedThisTrip.has(point.id)) return;
    this._askedThisTrip.add(point.id);
    this._queue.push({ id: point.id, kind: 'passed', distM: 0 });
    try { logEvent('FEEDBACK', `[FEEDBACK] feedback_prompt_shown — ${point.id} (passed-fallback)`); } catch (e) {}
    if (!this._activeId) this._showNext();
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
    this._activeDistanceM = (next && typeof next.distM === 'number') ? next.distM : null;
    const point = State.data.points.find(p => p.id === id);
    if (!point) { this._showNext(); return; }
    this._activeId = id;
    this._resolvingMissedId = null;
    this._popupSoundPlayedForId = null;
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
        <div class="confirm-head">
          <div class="confirm-title">${Utils.emoji(point.type)} ${name}</div>
          <div class="confirm-meta">${Utils.escapeHtml(typeLbl)}${sideText} · ${headline}</div>
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

  /** v23.7.2 — speed-limit revalidation entry point.
   *  Called from Alerts.tick when a saved speed_change is close ahead.
   *  Gated by:
   *    1. settings.speedLimitRevalidation must be true (default false)
   *    2. no other popup currently active
   *    3. not already prompted this session (_promptedSpeedIds)
   *    4. point.lastPromptedAt cooldown (default 30 min)
   *    5. point has a numeric speedLimit/limit value
   *  Records lastPromptedAt + adds id to session set BEFORE showing,
   *  so re-entry within the same tick window can't double-fire. */
  requestSpeedLimitConfirm(point, distM) {
    if (!point || point.type !== 'speed_change') return false;
    if (point.status === 'no') return false;
    if (!State.settings || !State.settings.speedLimitRevalidation) return false;
    if (this._activeId) return false;
    if (this._promptedSpeedIds.has(point.id)) return false;
    if (point.lastPromptedAt) {
      const ageMs = Date.now() - new Date(point.lastPromptedAt).getTime();
      if (ageMs < this.SPEED_REVAL_COOLDOWN_MIN * 60 * 1000) return false;
    }
    const lim = (typeof point.speedLimit === 'number') ? point.speedLimit
      : (typeof point.limit === 'number' ? point.limit : null);
    if (lim == null || !isFinite(lim)) return false;
    this._promptedSpeedIds.add(point.id);
    point.lastPromptedAt = new Date().toISOString();
    try { State.saveData(); } catch (e) {}
    this._showSpeedLimitPrompt(point, lim, distM);
    try { logEvent('SPEED', `[SPEED] revalidation_prompt_shown — ${point.id} limit=${lim} @ ${distM != null ? Math.round(distM) : '?'}m`); } catch (e) {}
    return true;
  },

  _showSpeedLimitPrompt(point, lim, distM) {
    let host = document.getElementById('confirm-popup');
    if (!host) {
      host = document.createElement('div');
      host.id = 'confirm-popup';
      host.className = 'confirm-popup';
      document.body.appendChild(host);
    }
    this._activeId = point.id;
    this._activeDistanceM = (typeof distM === 'number') ? distM : null;
    this._speedLimitMode = true;
    const distText = (typeof distM === 'number') ? ` · ${Math.round(distM)} m ahead` : '';
    host.innerHTML = `
      <div class="confirm-card">
        <div class="confirm-head">
          <div class="confirm-title">🚦 Speed limit revalidation</div>
          <div class="confirm-meta">The speed limit here is ${Utils.escapeHtml(String(lim))}. Confirm?${Utils.escapeHtml(distText)}</div>
        </div>
        <div class="confirm-progress"><div class="confirm-progress-bar" id="confirm-bar"></div></div>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-yes" id="confirm-yes">YES</button>
          <button class="confirm-btn confirm-no"  id="confirm-no">NO</button>
        </div>
      </div>`;
    host.classList.add('show');
    document.getElementById('confirm-yes').onclick = () => this._answerSpeedLimit('yes');
    document.getElementById('confirm-no').onclick  = () => this._answerSpeedLimit('no');
    this._startSpeedLimitCountdown(this.SPEED_REVAL_COUNTDOWN_S);
    // Reuse the existing popup sound — same UX as feedback prompts.
    try {
      if (typeof Audio !== 'undefined' && typeof Audio.playFeedbackPopupSound === 'function') {
        Audio.playFeedbackPopupSound();
      }
    } catch (e) {}
  },

  _startSpeedLimitCountdown(secs) {
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
        try { logEvent('SPEED', `[SPEED] revalidation_timeout — ${this._activeId}`); } catch (e) {}
        this._cleanup();
        this._activeId = null;
        this._activeDistanceM = null;
        this._speedLimitMode = false;
      }
    }, 100);
  },

  _answerSpeedLimit(value) {
    const id = this._activeId;
    if (!id) return;
    const point = State.data.points.find(p => p.id === id);
    if (!point) {
      this._cleanup();
      this._activeId = null;
      this._speedLimitMode = false;
      return;
    }
    const now = new Date().toISOString();
    point.observationCount = (point.observationCount || 1) + 1;
    if (value === 'yes') {
      point.confirmationCount = (point.confirmationCount || 0) + 1;
      point.lastConfirmedAt = now;
    } else {
      point.rejectionCount = (point.rejectionCount || 0) + 1;
      point.lastRejectedAt = now;
    }
    point.lastObservedAt = now;
    point.confidenceStatus = Speed.deriveConfidenceStatus(point);
    State.saveData();
    try { logEvent('SPEED', `[SPEED] revalidation_response — ${point.id} → ${value} · status=${point.confidenceStatus}`, 'ok'); } catch (e) {}
    Utils.toast(value === 'yes' ? `✓ Speed limit confirmed` : `Speed limit marked unsure`, value === 'yes' ? 'good' : 'bad');
    try {
      if (typeof Audio !== 'undefined' && typeof Audio.playFeedbackConfirmSound === 'function') {
        Audio.playFeedbackConfirmSound();
      }
    } catch (e) {}
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
    this._cleanup();
    this._activeId = null;
    this._activeDistanceM = null;
    this._speedLimitMode = false;
  },

  /** Reset trip state when GPS starts a fresh session. */
  resetTrip() {
    this._askedThisTrip.clear();
    this._queue = [];
    this._activeId = null;
    this._activeDistanceM = null;
    this._resolvingMissedId = null;
    this._popupSoundPlayedForId = null;
    // v23.7.2 — clear session-suppression set so fresh trip can prompt again.
    this._promptedSpeedIds.clear();
    this._speedLimitMode = false;
    this._cleanup();
  },
};

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

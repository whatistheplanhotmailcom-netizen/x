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
const APP_VERSION = 'v23.1.3';

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
      if (changed) touched++;
    }
    return touched;
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
        return false;
      }
      State.lastBackup = Date.now();
      State.lastBackupHash = await this.hash();
      UI.updateBackupStatus();
      if (!opts.silent) Utils.toast('Backed up ✓', 'good');
      logEvent('BACKUP', `push ok (${(payload.length / 1024).toFixed(1)}KB, ${tag})`, 'ok');
      return true;
    } catch (e) {
      if (!opts.silent) Utils.toast('Backup error', 'bad');
      logEvent('BACKUP', 'push exception: ' + (e && e.message || e), 'err');
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

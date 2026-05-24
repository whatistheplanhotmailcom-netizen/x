/* ============================================================
   6. MAP
   ============================================================ */

/** v22.88: available map style definitions. Each entry has an id
 *  (persisted in State.settings.mapStyle), a display label, an emoji,
 *  and a `style` field that's either a URL (MapLibre vector style JSON)
 *  or an inline style object (for raster XYZ tile sources that aren't
 *  served as MapLibre styles natively).
 *
 *  No API keys required — every source here is free public tiles. */
const MAP_STYLES = [
  {
    id: 'liberty',
    label: 'Default',
    em: '🗺',
    style: 'https://tiles.openfreemap.org/styles/liberty',
  },
  {
    id: 'positron',
    label: 'Light',
    em: '☀',
    style: 'https://tiles.openfreemap.org/styles/positron',
  },
  {
    id: 'dark',
    label: 'Dark',
    em: '🌙',
    style: 'https://tiles.openfreemap.org/styles/dark',
  },
  {
    id: 'satellite',
    label: 'Satellite',
    em: '🛰️',
    style: {
      version: 8,
      sources: {
        'sat-tiles': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Imagery © Esri',
          maxzoom: 19,
        },
      },
      layers: [{ id: 'sat-layer', type: 'raster', source: 'sat-tiles' }],
    },
  },
  {
    id: 'terrain',
    label: 'Terrain',
    em: '⛰️',
    style: {
      version: 8,
      sources: {
        'topo-tiles': {
          type: 'raster',
          tiles: [
            'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
            'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
            'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '© OpenTopoMap (CC-BY-SA)',
          maxzoom: 17,
        },
      },
      layers: [{ id: 'topo-layer', type: 'raster', source: 'topo-tiles' }],
    },
  },
];

const MapView = {
  m: null,
  currentMarker: null,
  currentMarkerEl: null,
  destMarker: null,
  _pointMarkers: null,   // id -> maplibregl.Marker
  _activePopup: null,
  longPressTimer: null,
  _initTries: 0,
  _mapLoaded: false,
  _lastPointRefresh: 0,

  // v22.51: heading smoothing for auto-rotation
  _headingBuf: [],
  _smoothedHeading: null,
  _lastBearingApplied: null,
  _lastBearingAt: 0,

  // v22.58: route line state. Fetch once per (GPS session, destination) pair
  // from OSRM's free public endpoint and render as a MapLibre line layer.
  _routeForDestId: null,
  _routeFetching: false,
  // v22.95: stored coordinates of the currently-drawn route, used by
  // _checkRouteDeviation to detect when the user has drifted off-route
  // and trigger a fresh OSRM fetch from their current position.
  _routeCoords: null,
  _lastRouteCheckAt: 0,
  _lastRefetchAt: 0,
  // v22.97: tightened reroute thresholds per spec.
  _offRouteDeviationM: 25,         // metres past route before it counts as a strike
  _rerouteCooldownMs: 10000,       // min interval between auto-reroutes
  _offRouteAccuracyMaxM: 30,       // skip the whole check if GPS ±accuracy is worse
  _offRouteStrikesRequired: 2,     // need this many consecutive off-route GPS updates
  _offRouteStrikes: 0,             // running counter, resets when back on route
  _isReroute: false,               // flag for _fetchAndDrawRoute so its log lines say "reroute"
  _lastDevDistLogAt: 0,            // throttle for the per-tick distance log
  _loggedDebounceAt: 0,            // throttle for the "skipped — debounce" log
  // v23.1.0: cached route metrics so the diag-strip ETA cell can show
  // distance + estimated time remaining without re-issuing OSRM calls.
  // Both set when a route is drawn/restored; cleared in clearRoute().
  _routeDistanceM: null,
  _routeDurationS: null,
  _routeDestCoords: null,          // {lat,lng} of the destination at fetch time
  // v23.5 Phase 4: offline routing back-off. When OSRM fetch fails, set
  // this to a future timestamp; _checkRouteDeviation refuses to call
  // _fetchAndDrawRoute until then. Last-known-good route stays drawn.
  _offlineRouteBackoffUntil: 0,
  // v22.104: arrival detection — when GPS gets within ARRIVAL_RADIUS_M of
  // the active destination, flip the stored route to confirmed and clear
  // the drawn line. Session-scoped Set prevents re-firing on every tick.
  _arrivedDestIds: new Set(),
  ARRIVAL_RADIUS_M: 100,

  // v22.78: zoom snapshot taken when entering 3D pitch so we can restore
  // the user's original zoom level when they return to 2D.
  _zoomBeforePitch: null,

  init() {
    if (this.m) return;
    if (typeof maplibregl === 'undefined') {
      this._initTries++;
      if (this._initTries > 30) {
        const mapEl = document.getElementById('map');
        if (mapEl) {
          mapEl.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--ink-3);font-size:11px;padding:20px;text-align:center;"><div style="font-size:32px;margin-bottom:8px;">🗺</div><div>Map library failed to load.</div><button onclick="location.reload()" style="margin-top:12px;padding:8px 14px;background:var(--amber);color:#000;border:none;border-radius:6px;font-weight:700;">Reload</button></div>';
        }
        return;
      }
      return setTimeout(() => this.init(), 200);
    }
    try {
      // v22.58: register RTL text plugin BEFORE creating the map so Arabic
      // (and Hebrew, Persian) labels render in correct reading order
      // instead of visually reversed. MapLibre uses Mapbox's bidi plugin.
      // Idempotent — status check prevents double-registration on re-init.
      try {
        const status = (typeof maplibregl.getRTLTextPluginStatus === 'function')
          ? maplibregl.getRTLTextPluginStatus()
          : 'unavailable';
        if (status === 'unavailable') {
          maplibregl.setRTLTextPlugin(
            'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js',
            err => { if (err) console.warn('RTL plugin load error:', err); },
            true  // lazy: only fetch when an RTL character is encountered
          );
        }
      } catch (e) { console.warn('RTL plugin setup failed:', e); }

      const dest = State.activeDest();
      // MapLibre uses [lng, lat] (NOT [lat, lng] like Leaflet!).
      const center = dest ? [dest.lng, dest.lat]
                  : State.pos ? [State.pos.lng, State.pos.lat]
                  : [39.1728, 21.5433]; // Jeddah fallback

      this._pointMarkers = new globalThis.Map();

      this.m = new maplibregl.Map({
        container: 'map',
        // OpenFreeMap Liberty style (OSM-based, no API key required)
        // v22.88: use the persisted map style on first load (defaults to
        // 'liberty'). User can switch via the 🗺 button on the map overlay.
        style: (MAP_STYLES.find(s => s.id === (State.settings.mapStyle || 'liberty'))
                || MAP_STYLES[0]).style,
        center: center,
        zoom: 13,
        bearing: 0,
        pitch: 0,
        // Disable pitch (3D tilt) — we want flat top-down for driving
        pitchWithRotate: false,
        dragRotate: false,    // no 2-finger drag rotation (we control bearing)
        // v23.5.6: enable native MapLibre two-finger pitch gesture
        // (Google-Maps-style). Setting this to true wires the existing
        // built-in TouchPitchHandler; no fake CSS rotation, no marker
        // misalignment, no GPS coord change. The existing 2D/3D toggle
        // (#btn-pitch) and setPitchMode() are unchanged — the user can
        // still snap to 0° / 60° via that button.
        touchPitch: true,
        // Snap bearing to north when within this many degrees on user-stop.
        // 0 means never snap — we want auto-rotate to "stick" at any bearing.
        bearingSnap: 0,
        // v22.80: explicit maxPitch so the 60° we apply in setPitchMode is
        // unambiguously within bounds. (MapLibre 5.x default is 85; setting
        // explicitly anyway in case a future version changes the default.)
        maxPitch: 85,
        // Show zoom controls
        attributionControl: { compact: true },
        // Performance: lower the device pixel ratio cap on iOS to keep WebGL fast
        maxPixelRatio: 2,
      });

      // Add zoom-in/out buttons (top-right by default; CSS-tweak placement)
      this.m.addControl(new maplibregl.NavigationControl({
        visualizePitch: false,
        showCompass: false,
        showZoom: true,
      }), 'top-left');

      // v22.51: when user drags, exit follow mode (matches old Leaflet behavior)
      this.m.on('dragstart', () => {
        if (State.followMap) { State.followMap = false; UI.updateFollowPill(); }
      });

      // v22.51: long-press to capture — MapLibre fires 'contextmenu' on iOS
      // long-press natively. Use that directly. e.lngLat has {lng, lat}.
      this.m.on('contextmenu', (e) => {
        e.preventDefault && e.preventDefault();
        this.startCaptureAt({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      });

      // Backup long-press detection on touchstart, in case contextmenu doesn't fire
      this.m.on('touchstart', (e) => {
        clearTimeout(this.longPressTimer);
        // Only one finger
        if (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length !== 1) return;
        const lngLat = e.lngLat;
        if (!lngLat) return;
        this.longPressTimer = setTimeout(() => {
          this.startCaptureAt({ lat: lngLat.lat, lng: lngLat.lng });
        }, 700);
      });
      // v22.104: MapLibre doesn't support space-separated event names.
      // Cancel long-press on touchend (finger lifted) and dragstart (map
      // pan started). Do NOT cancel on touchmove — finger jitter fires it
      // constantly even when the user is holding still, which broke
      // long-press capture.
      ['touchend', 'dragstart'].forEach(ev =>
        this.m.on(ev, () => clearTimeout(this.longPressTimer))
      );

      // v22.81: keep the on-screen compass synced with the actual map
      // bearing. 'rotate' fires continuously during easeTo/setBearing,
      // 'rotateend' is a safety net for the final position.
      // v22.82: also re-rotate the directional triangle on every map
      // bearing change so the arrow always points to true real-world
      // heading regardless of which way the map is facing.
      // v22.83: subscribe to 'move' and 'pitch' too — covers any code
      // path that touches bearing without firing a pure rotate event.
      const onMapMove = () => {
        UI.updateCompass();
        MapView._updateLocationTriangle();
        // v23.9.4: keep camera radar arcs earth-aligned as the map
        // bearing changes. The marker container stays upright; only the
        // inner SVG <g> rotates.
        MapView._updateRadarRotations();
      };
      this.m.on('rotate', onMapMove);
      this.m.on('rotateend', onMapMove);
      this.m.on('move', onMapMove);
      this.m.on('pitch', onMapMove);

      // Wait for style+tiles to load before drawing points (otherwise markers
      // attach to a non-ready map and may not render).
      this.m.on('load', () => {
        this._mapLoaded = true;
        this.updatePoints();
        // v22.78: if the user had 3D mode on across sessions, apply it now
        // that the map is ready. Use duration 0 so it appears immediately
        // (animating on first load looks janky).
        if (State.settings.pitchMode) {
          this.setPitchMode(true, { duration: 0 });
        }
        // v22.81: initial compass sync once the map has a real bearing.
        UI.updateCompass();
      });

      // Resize after a tick so the canvas matches the actual container size
      setTimeout(() => { try { this.m.resize(); } catch (e) {} }, 200);

    } catch (e) {
      console.error('Map init error', e);
      Utils.toast('Map error: ' + e.message, 'bad');
    }
  },

  /** v22.51: build a DOM element for a captured point.
   *  v22.87 / v22.88: top-right .conf-badge ALWAYS shows the cumulative
   *  count of confirmation feedback ({yes,no} answered after passing).
   *  Visible at 0 too (grey) so the user can see at a glance which points
   *  have any feedback yet. Color reflects the majority once votes exist:
   *  green = mostly yes, red = mostly no, amber = tied, grey = no votes. */
  _buildPointEl(p, classes) {
    const el = document.createElement('div');
    // v23.13.0: side badge carries a directional arrow pointing to the
    // side of the road — left side → "←L", right side → "R→".
    const sideHtml = p.side
      ? `<span class="side side-${p.side === 'left' ? 'l' : 'r'}">${p.side === 'left' ? '←L' : 'R→'}</span>`
      : '';
    let yes = 0, no = 0;
    if (Array.isArray(p.confirmations)) {
      for (const c of p.confirmations) {
        if (c && c.value === 'yes') yes++;
        else if (c && c.value === 'no') no++;
      }
    }
    const total = yes + no;
    let cls = 'conf-zero';
    if (total > 0) cls = yes > no ? 'conf-pos' : (no > yes ? 'conf-neg' : 'conf-neutral');
    const confHtml = `<span class="conf-badge ${cls}" title="${yes} yes / ${no} no">${total}</span>`;
    // v23.9.4 — directional radar decoration on camera markers.
    // Three short thin arcs centred on the captureBearing, anchored at
    // the marker's centre (SVG origin = 0,0). Hidden for passed /
    // disabled markers and for points without a valid bearing.
    //
    // Bearing field: prefer p.captureBearing; fall back to p.heading
    // (the existing alias set by Speed.migrateSpeedPoints). Never
    // invented, never recalculated.
    //
    // Rotation model:
    //   The default SVG arc geometry below peaks at (0, -22) — i.e. it
    //   faces UP. SVG rotate(a) is clockwise, matching compass
    //   bearings. To keep the arcs EARTH-aligned regardless of the
    //   map's current bearing, the SVG <g> transform is
    //   rotate(captureBearing - mapBearing). The marker container
    //   itself is NEVER rotated (HTML markers stay screen-upright by
    //   default), so the icon remains readable at every map bearing.
    //   _updateRadarRotations() refreshes the same transform on every
    //   map 'move' / 'rotate' / 'rotateend' tick so the bearing tracks
    //   live as the user rotates the map.
    const CAM_TYPES_RADAR = { speed_camera: 1, mobile_camera: 1, pole_camera: 1, spider_camera: 1 };
    let radarHtml = '';
    if (CAM_TYPES_RADAR[p.type]
        && p.directional !== false
        && p.status !== 'no'
        && !classes.includes('passed')
        && !classes.includes('disabled')) {
      let rawB = (typeof p.captureBearing === 'number') ? p.captureBearing
               : (typeof p.heading === 'number') ? p.heading
               : null;
      if (rawB != null && isFinite(rawB)) {
        // Normalize to [0, 360). Handles −10 → 350, 370 → 10, 720 → 0.
        const capB = ((rawB % 360) + 360) % 360;
        let mapB = 0;
        try { if (this.m) mapB = this.m.getBearing() || 0; } catch (e) {}
        const visualDeg = ((capB - mapB) % 360 + 360) % 360;
        radarHtml =
          '<svg class="cam-radar" data-bearing="' + capB.toFixed(1) + '" width="64" height="64" viewBox="-32 -32 64 64" aria-hidden="true">' +
            '<g class="cam-radar-g" transform="rotate(' + Math.round(visualDeg) + ')">' +
              '<path class="cam-radar-arc cam-radar-arc-1" d="M -11 -19.05 A 22 22 0 0 1 11 -19.05"/>' +
              '<path class="cam-radar-arc cam-radar-arc-2" d="M -13.5 -23.38 A 27 27 0 0 1 13.5 -23.38"/>' +
              '<path class="cam-radar-arc cam-radar-arc-3" d="M -16 -27.71 A 32 32 0 0 1 16 -27.71"/>' +
            '</g>' +
          '</svg>';
      }
    }
    // v23.9.1 — missed-feedback red square in the top-left corner of the
    // marker. Shows the count of unresolved missed-feedback entries
    // (point.feedback.missed[] where status === 'missed_feedback').
    // Hidden entirely when count is 0 so unaffected markers stay clean.
    let missedHtml = '';
    try {
      const missedN = (typeof Confirm !== 'undefined' && typeof Confirm._countUnresolvedMissed === 'function')
        ? Confirm._countUnresolvedMissed(p)
        : 0;
      if (missedN > 0) {
        missedHtml = `<span class="missed-badge" title="${missedN} missed feedback">${missedN}</span>`;
      }
    } catch (e) {}
    // v23.12.0 — prior-capture count badge in the BOTTOM-LEFT corner.
    // Shows how many times this point was previously captured/confirmed
    // (p.confirmedCount, default 0). Bold, circled, color-coded:
    //   0       → orange  (single sighting)
    //   1       → red
    //   2 or 3+ → green   (well confirmed)
    // Always shown (even at 0) so the count is glanceable on every marker.
    const depN = (typeof p.confirmedCount === 'number' && isFinite(p.confirmedCount))
      ? p.confirmedCount : 0;
    let depCls = 'dep-zero';
    if (depN === 1) depCls = 'dep-one';
    else if (depN >= 2) depCls = 'dep-ok';
    const depHtml = `<span class="dep-badge ${depCls}" title="${depN} prior confirmations">${depN}</span>`;
    // v23.7.2 — speed_change observations render as proper white-circle
    // road-sign markers with a red border + black number, not as a
    // generic emoji marker. Falls back to a generic sign emoji if the
    // value is missing (does NOT hide the marker, per spec).
    if (p.type === 'speed_change') {
      const lim = (typeof p.speedLimit === 'number') ? p.speedLimit
        : (typeof p.limit === 'number' ? p.limit : null);
      const valHtml = (lim != null && isFinite(lim))
        ? Utils.escapeHtml(String(Math.round(lim)))
        : '?';
      const conf = p.confidenceStatus || '';
      el.innerHTML = `<div class="${classes.join(' ')} sign-style conf-${Utils.escapeHtml(conf)}">` +
        `<span class="sign-num">${valHtml}</span>${sideHtml}${confHtml}${missedHtml}${depHtml}</div>`;
      return el;
    }
    el.innerHTML = `<div class="${classes.join(' ')}">${radarHtml}${Utils.emoji(p.type, p.subtype)}${sideHtml}${confHtml}${missedHtml}${depHtml}</div>`;
    return el;
  },

  /** v22.51 (was v22.50): update ahead-rank class on existing point markers
   *  without rebuilding them. Cheap; called every GPS tick. */
  updateAheadRanks() {
    if (!this._pointMarkers) return;
    const aheadList = Alerts.ahead();
    const aheadIds = new globalThis.Map();
    aheadList.slice(0, 3).forEach((a, idx) => aheadIds.set(a.id, idx + 1));
    this._pointMarkers.forEach((mk, pid) => {
      const el = mk.getElement();
      const inner = el && el.querySelector('.ra-marker');
      if (!inner) return;
      inner.classList.remove('ahead-1', 'ahead-2', 'ahead-3');
      if (aheadIds.has(pid)) inner.classList.add('ahead-' + aheadIds.get(pid));
    });
    // v22.60: keep sidebar timeline entries in sync. Same class names →
    // CSS handles the visual mirroring (flash on ahead-1, heartbeat on 2/3).
    const rail = document.getElementById('tools-rail');
    if (rail) {
      rail.querySelectorAll('.timeline-entry').forEach(el => {
        el.classList.remove('ahead-1', 'ahead-2', 'ahead-3');
        const pid = el.dataset.tlEdit;
        if (pid && aheadIds.has(pid)) el.classList.add('ahead-' + aheadIds.get(pid));
      });
    }
  },

  /** Open a popup near a marker. We render edit/delete buttons and wire
   *  them after the popup opens so they work in the WebGL canvas. */
  _showPointPopup(p, lngLat) {
    if (this._activePopup) {
      try { this._activePopup.remove(); } catch (e) {}
      this._activePopup = null;
    }
    const dist = State.pos ? Utils.distKm(State.pos, p) : null;
    const agoText = p.createdAt ? Utils.fmtAgo(p.createdAt) : '';
    const confText = (p.confidence && p.confidence > 1) ? ` · ×${p.confidence}` : '';
    const html = `
      <div class="pop-name">${Utils.emoji(p.type, p.subtype)} ${Utils.escapeHtml(p.name)}</div>
      <div class="pop-meta">${Utils.escapeHtml(Utils.typeLabel(p.type))}${p.side ? ' · ' + Utils.escapeHtml(p.side) : ''}${dist != null ? ' · ' + Utils.escapeHtml(Utils.fmtDist(dist)) : ''}${confText}</div>
      ${agoText ? `<div class="pop-meta" style="margin-top:2px;">📅 ${Utils.escapeHtml(agoText)}</div>` : ''}
      <button data-edit="${Utils.escapeHtml(p.id)}">✎ Edit</button>
      <button data-del="${Utils.escapeHtml(p.id)}" style="background:var(--red);color:#fff;">🗑 Delete</button>
    `;
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '280px' })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(this.m);
    this._activePopup = popup;
    // Wire buttons after DOM exists
    setTimeout(() => {
      const root = popup.getElement();
      if (!root) return;
      const editBtn = root.querySelector('[data-edit]');
      const delBtn  = root.querySelector('[data-del]');
      if (editBtn) editBtn.onclick = () => {
        const id = editBtn.getAttribute('data-edit');
        try { popup.remove(); } catch (e) {}
        this._activePopup = null;
        UI.openPointEditor(id);
      };
      if (delBtn) delBtn.onclick = async () => {
        // v22.74: use the in-app confirm modal (window.confirm is blocked
        // on some mobile browsers and silently returns false).
        const id = delBtn.getAttribute('data-del');
        const p = State.data.points.find(x => x.id === id);
        const label = p ? (p.name || Utils.typeLabel(p.type)) : 'point';
        const ok = await UI.confirm(`Delete ${label}?`, { title: 'Delete point' });
        if (!ok) return;
        State.removePointById(id);
        State.alertedMarkers.delete(id);
        State.lastDistByPoint.delete(id);
        State.passedPoints.delete(id);
        State.saveData();
        try { popup.remove(); } catch (e) {}
        this._activePopup = null;
        const mk = this._pointMarkers.get(id);
        if (mk) { mk.remove(); this._pointMarkers.delete(id); }
        UI.renderTimeline();
        Utils.toast(`Deleted ${label}`, 'good');
      };
    }, 50);
  },

  /** v22.51: rebuild all point markers from scratch. Called on data change
   *  (capture / edit / delete) and via a passive 30s refresh sweep. */
  updatePoints() {
    if (!this.m || !this._mapLoaded) return;

    // Tear down existing markers
    if (this._pointMarkers) {
      this._pointMarkers.forEach(mk => { try { mk.remove(); } catch (e) {} });
      this._pointMarkers.clear();
    } else {
      this._pointMarkers = new globalThis.Map();
    }
    if (this.destMarker) { try { this.destMarker.remove(); } catch (e) {} this.destMarker = null; }

    // Destination marker
    const dest = State.activeDest();
    if (dest) {
      const destEl = document.createElement('div');
      destEl.innerHTML = `<div class="ra-dest">📍</div>`;
      const popup = new maplibregl.Popup({ offset: 18 })
        .setHTML(`<div class="pop-name">🚩 ${Utils.escapeHtml(dest.name)}</div><div class="pop-meta">Destination</div>`);
      this.destMarker = new maplibregl.Marker({ element: destEl, anchor: 'center' })
        .setLngLat([dest.lng, dest.lat])
        .setPopup(popup)
        .addTo(this.m);
    }

    // v22.34: top-3 ahead get rank classes
    const aheadList = Alerts.ahead();
    const aheadIds = new globalThis.Map();
    aheadList.slice(0, 3).forEach((a, idx) => aheadIds.set(a.id, idx + 1));

    const myDist = (State.pos && dest) ? Utils.distKm(State.pos, dest) : null;
    // v23.8.0 — render the GLOBAL observation pool. Every captured
    // point is reusable across trips regardless of which destination
    // is active, so the map shows them all. The destination is
    // context only; selecting Home no longer hides points captured
    // on past Work trips that lie on the same road.
    const visible = State.data.points.filter(p =>
      p && typeof p.lat === 'number' && typeof p.lng === 'number'
    );
    visible.forEach(p => {
      // v23.8.7: passed = ACTUALLY driven past (tracker-based), not
      // "further from destination than the user is" (geometry-based).
      // The old destination-geometry flag wrongly greyed out every
      // point that happened to be further from the active destination
      // than the driver — including all points ahead during a u-turn,
      // a detour, or any approach from a different direction. With
      // the v23.8.0 global pool, alert eligibility is no longer
      // destination-bound, so the geometry flag has no business
      // muting markers either.
      // v23.8.8: SILENT_ALERT_TYPES (speed_change, traffic_light,
      // gate) are permanent road infrastructure — they never grey
      // out. Even if something else added them to State.passedPoints
      // historically, the visual layer ignores that for these types.
      const silent = (typeof Alerts !== 'undefined' && Alerts.SILENT_ALERT_TYPES)
        ? Alerts.SILENT_ALERT_TYPES.has(p.type) : false;
      const passed = !silent && State.passedPoints.has(p.id);
      const cls = ['ra-marker', 't-' + p.type];
      if (passed) cls.push('passed');
      if (p.status === 'no') cls.push('disabled');
      if (!passed && p.status !== 'no' && aheadIds.has(p.id)) cls.push('ahead-' + aheadIds.get(p.id));

      const el = this._buildPointEl(p, cls);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lng, p.lat])
        .addTo(this.m);
      // Tap to open popup
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._showPointPopup(p, [p.lng, p.lat]);
      });
      this._pointMarkers.set(p.id, marker);
    });
  },

  update() {
    if (!this.m || !this._mapLoaded || !State.pos) return;

    // Move or create user marker — v22.82: directional triangle + halo
    // instead of a static blue circle. The triangle is rotated by JS to
    // point in the real-world heading direction (compensating for map
    // bearing).
    if (!this.currentMarkerEl) {
      this.currentMarkerEl = document.createElement('div');
      this.currentMarkerEl.innerHTML =
        '<div class="ra-current">' +
          '<div class="ra-current-halo"></div>' +
          '<div class="ra-current-tri"></div>' +
        '</div>';
      this.currentMarker = new maplibregl.Marker({ element: this.currentMarkerEl, anchor: 'center' })
        .setLngLat([State.pos.lng, State.pos.lat])
        .addTo(this.m);
    } else {
      this.currentMarker.setLngLat([State.pos.lng, State.pos.lat]);
    }

    // v22.85: nav-mode rotation now lives in MapView._applyNavRotation
    // and is called from BOTH this GPS tick path AND the device
    // orientation event listener (in GPS.setupDeviceOrientation), so the
    // map rotates as the user turns the phone — even before they tap
    // Start GPS. Previously rotation only fired from this update(), which
    // returns early when State.pos is null, so heading updates without GPS
    // produced no rotation. Triangle worked because it listens to map
    // events; map didn't rotate because update() never ran.
    this._applyNavRotation();

    // Throttled diagnostic — every ~3 seconds.
    try {
      const mapB = this.m ? this.m.getBearing() : null;
      if (!this._lastDiagAt || Date.now() - this._lastDiagAt > 3000) {
        this._lastDiagAt = Date.now();
        const navOnTxt = State.settings.navMode ? 'N1' : 'N0';
        const hdg = State.heading == null ? '—' : Math.round(State.heading);
        const smo = this._smoothedHeading == null ? '—' : Math.round(this._smoothedHeading);
        const mb  = mapB == null ? '—' : Math.round(mapB);
        logEvent('ROT', `${navOnTxt} hdg ${hdg} smo ${smo} mapb ${mb}`);
      }
    } catch (e) {}

    if (State.followMap) {
      try { this.m.setCenter([State.pos.lng, State.pos.lat]); } catch (e) {}
    }

    this.updateAheadRanks();

    // v22.82: rotate the directional triangle to point in real-world heading
    this._updateLocationTriangle();

    // v22.58: fetch & draw the driving route once per (session, destination)
    // — internal guards make this cheap on subsequent ticks.
    this._fetchAndDrawRoute();
    // v22.95: detect off-route deviation and refetch from the new position
    // when the user has drifted past the threshold. Throttled internally.
    this._checkRouteDeviation();
    // v22.104: detect arrival — confirms the learned route and clears the line
    this._checkArrival();

    // Lazy full rebuild every 30 s (passed-status, fmtAgo)
    const refreshMs = 30000;
    if (!this._lastPointRefresh || Date.now() - this._lastPointRefresh > refreshMs) {
      this._lastPointRefresh = Date.now();
      this.updatePoints();
    }
  },

  fitAll() {
    if (!this.m) return;
    State.followMap = false; UI.updateFollowPill();
    // Build a bounding box [west, south, east, north]
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    const extend = (lat, lng) => {
      if (lng < west) west = lng;
      if (lat < south) south = lat;
      if (lng > east) east = lng;
      if (lat > north) north = lat;
    };
    if (State.pos) extend(State.pos.lat, State.pos.lng);
    const dest = State.activeDest();
    if (dest) extend(dest.lat, dest.lng);
    // v23.8.0: fit-all spans the global observation pool so
    // points from past trips remain visible after migration.
    State.data.points.forEach(p => {
      if (p && typeof p.lat === 'number' && typeof p.lng === 'number') extend(p.lat, p.lng);
    });
    if (isFinite(west)) {
      this.m.fitBounds([[west, south], [east, north]], {
        padding: 40,
        maxZoom: 14,
        duration: 600,
      });
    } else if (dest) {
      this.m.jumpTo({ center: [dest.lng, dest.lat], zoom: 13 });
    }
  },

  recenter() {
    if (!this.m) return;
    if (!State.pos) { Utils.toast('No GPS yet'); this.fitAll(); return; }
    State.followMap = true; UI.updateFollowPill();
    this.m.easeTo({
      center: [State.pos.lng, State.pos.lat],
      zoom: Math.max(this.m.getZoom(), 13),
      duration: 500,
    });
  },

  /** v22.82: rotate the location triangle to point in the real-world
   *  heading direction, compensating for the current map bearing.
   *
   *  Heading priority (user-specified):
   *    1. State.deviceHeading  - compass via DeviceOrientationEvent
   *    2. State.heading        - GPS movement bearing (live or derived)
   *    3. null                 - no source; triangle defaults to 0° + red
   *
   *  Visual rotation = real-world heading - map bearing. So when the map
   *  rotates (heading-up nav mode), the triangle counter-rotates to keep
   *  pointing in the actual cardinal direction the user is facing.
   *
   *  Logs throttled to once per 3 seconds to avoid spamming the debug
   *  panel on every tick. */
  /** v22.84: single source of truth for "what direction is the user
   *  actually facing". Both _updateLocationTriangle AND the nav-mode
   *  map rotation in update() read from this so they can never disagree.
   *  Compass first (works stationary), GPS heading second (more reliable
   *  while moving), null if neither is available. */
  _getBestHeading() {
    if (typeof State.deviceHeading === 'number' && !isNaN(State.deviceHeading)) {
      return State.deviceHeading;
    }
    if (typeof State.heading === 'number' && !isNaN(State.heading)) {
      return State.heading;
    }
    return null;
  },

  /** v22.86: continuous nav-mode lock.
   *
   *  Why the rewrite: the v22.85 throttle + cached _lastBearingApplied
   *  comparison was getting stuck. Once we'd set _lastBearingApplied to,
   *  say, 130°, subsequent smoothed-heading values close to 130° were
   *  inside the 1° dead-zone OR blocked by the 150ms time throttle, and
   *  easeTo never fired again. Visible symptom: map rotated once on
   *  nav-mode toggle and then froze, even though the phone kept turning.
   *
   *  New logic, per user spec:
   *    - Compare to the ACTUAL map.getBearing() each call (not cached).
   *    - Shortest-arc angle delta so 359° / 0° wrap is correct.
   *    - 2° dead-zone, no time throttle. Each easeTo cancels the
   *      previous animation and re-targets, so re-entering at 60Hz is
   *      safe — map continuously catches up to the latest heading.
   *    - duration 250ms (snappier than v22.85's 300ms).
   *    - essential:true to bypass prefers-reduced-motion.
   *
   *  Called from BOTH MapView.update() (GPS tick path) AND the
   *  deviceorientation handler in GPS.setupDeviceOrientation, so the
   *  map rotates on every heading update from either source. */
  _applyNavRotation() {
    if (!this.m || !this._mapLoaded) return;
    if (!State.settings.navMode) {
      // Throttled hint so the user knows WHY the map isn't rotating
      if (!this._lastNavOffHintAt || Date.now() - this._lastNavOffHintAt > 5000) {
        this._lastNavOffHintAt = Date.now();
        logEvent('MAP', 'navMode=OFF — tap 🧭 to enable heading-up rotation');
      }
      return;
    }
    const bestHeading = this._getBestHeading();
    if (bestHeading == null) {
      if (!this._lastNoHeadingHintAt || Date.now() - this._lastNoHeadingHintAt > 5000) {
        this._lastNoHeadingHintAt = Date.now();
        logEvent('MAP', 'navMode=ON but no heading source yet');
      }
      return;
    }
    // Vector-averaged smoothing across last 3 readings (low-pass filter)
    this._headingBuf.push(bestHeading);
    if (this._headingBuf.length > 3) this._headingBuf.shift();
    let sx = 0, sy = 0;
    for (const x of this._headingBuf) {
      sx += Math.cos(x * Math.PI / 180);
      sy += Math.sin(x * Math.PI / 180);
    }
    let smoothed = Math.atan2(sy / this._headingBuf.length, sx / this._headingBuf.length) * 180 / Math.PI;
    if (smoothed < 0) smoothed += 360;
    this._smoothedHeading = smoothed;

    // Compare to the ACTUAL current map bearing — not a cached intent.
    // This is what gets stuck if we use _lastBearingApplied as the
    // reference (per user diagnosis).
    let currentBearing = 0;
    try { currentBearing = this.m.getBearing(); } catch (e) {}
    // Shortest-arc delta so 359° -> 0° doesn't read as a 359° change.
    const delta = Math.abs(((smoothed - currentBearing + 540) % 360) - 180);

    // 2° dead-zone — below this, no visible change, skip the easeTo.
    if (delta <= 2) return;

    try {
      this.m.easeTo({
        bearing: smoothed,
        duration: 250,
        essential: true,
      });
      this._lastBearingApplied = smoothed; // kept for legacy callers
      this._lastBearingAt = Date.now();
      logEvent('MAP', `nav-lock heading=${smoothed.toFixed(1)} bearing→${smoothed.toFixed(1)} (was ${currentBearing.toFixed(1)})`);
    } catch (e) {
      logEvent('MAP', 'easeTo bearing error: ' + (e && e.message || e), 'err');
    }
  },

  /** v23.9.4 — recompute the rotate() transform on every camera radar
   *  SVG so the arcs stay earth-aligned as the user rotates the map.
   *  The stored captureBearing lives on the SVG's data-bearing
   *  attribute (already normalized to [0,360) at build time). Cheap:
   *  one querySelectorAll + at most a few hundred attribute writes per
   *  tick; only directional cameras render a .cam-radar so the working
   *  set is small. The marker container is NEVER touched — only the
   *  inner <g class="cam-radar-g">. */
  _updateRadarRotations() {
    if (!this.m) return;
    let mapBearing = 0;
    try { mapBearing = this.m.getBearing() || 0; } catch (e) { return; }
    const radars = document.querySelectorAll('.cam-radar[data-bearing]');
    radars.forEach(svg => {
      const capB = parseFloat(svg.getAttribute('data-bearing'));
      if (!isFinite(capB)) return;
      const visual = ((capB - mapBearing) % 360 + 360) % 360;
      const g = svg.querySelector('.cam-radar-g');
      if (g) g.setAttribute('transform', 'rotate(' + Math.round(visual) + ')');
    });
  },

  _updateLocationTriangle() {
    if (!this.currentMarkerEl) return;
    const tri = this.currentMarkerEl.querySelector('.ra-current-tri');
    if (!tri) return;
    const heading = this._getBestHeading();
    let mapBearing = 0;
    try { mapBearing = this.m ? this.m.getBearing() : 0; } catch (e) {}
    if (heading == null) {
      tri.classList.add('no-heading');
      tri.style.transform = 'translate(-50%, -50%) rotate(0deg)';
    } else {
      tri.classList.remove('no-heading');
      const visualRot = heading - mapBearing;
      tri.style.transform = `translate(-50%, -50%) rotate(${visualRot}deg)`;
    }
    // Throttled diagnostic — every ~3s so debug panel doesn't flood
    if (!this._lastTriLogAt || Date.now() - this._lastTriLogAt > 3000) {
      this._lastTriLogAt = Date.now();
      const h = heading == null ? '—' : heading.toFixed(1);
      logEvent('GPS', `heading=${h} mapBearing=${mapBearing.toFixed(1)} markerRotation=${heading == null ? '0' : (heading - mapBearing).toFixed(1)}`);
    }
  },

  /** v22.78 / hardened in v22.80: switch between 2D top-down and 3D
   *  navigation perspective.
   *
   *  ON  → easeTo({ pitch: 60, zoom: zoomBefore-0.5, duration: 800 })
   *  OFF → easeTo({ pitch: 0,  zoom: zoomBefore,     duration: 800 })
   *
   *  Belt-and-suspenders: we ALSO call setPitch() immediately so even if
   *  easeTo's pitch param is silently ignored by a particular MapLibre
   *  build, the camera state is still updated. The easeTo animates;
   *  setPitch makes the underlying state correct on the next frame.
   *
   *  center and bearing are not passed to easeTo, so MapLibre preserves
   *  them — doesn't fight nav-mode rotation or follow-mode panning.
   *
   *  Logs the before/after pitch via logEvent so the debug panel shows
   *  whether the call actually took effect. */
  setPitchMode(on, opts) {
    if (!this.m) {
      logEvent('MAP', 'setPitchMode called but map not ready', 'err');
      return;
    }
    opts = opts || {};
    const dur = opts.duration != null ? opts.duration : 800;
    const before = this.m.getPitch();
    try {
      if (on) {
        if (this._zoomBeforePitch == null) {
          this._zoomBeforePitch = this.m.getZoom();
        }
        const targetZoom = Math.max(10, this._zoomBeforePitch - 0.5);
        this.m.easeTo({ pitch: 60, zoom: targetZoom, duration: dur });
        try { this.m.setPitch(60); } catch (e) {}  // belt
      } else {
        const restoredZoom = this._zoomBeforePitch != null
          ? this._zoomBeforePitch
          : this.m.getZoom() + 0.5;
        this._zoomBeforePitch = null;
        this.m.easeTo({ pitch: 0, zoom: restoredZoom, duration: dur });
        try { this.m.setPitch(0); } catch (e) {}   // belt
      }
      // Update button label inside the method so every call path (boot
      // restore, click handler, programmatic) ends with the right text.
      const btn = document.getElementById('btn-pitch');
      if (btn) btn.textContent = on ? '2D' : '3D';
      logEvent('MAP', `Pitch ${on ? 'ON' : 'OFF'} (${Math.round(before)}° → ${on ? 60 : 0}°)`, 'ok');
    } catch (e) {
      logEvent('MAP', 'setPitchMode error: ' + (e && e.message || e), 'err');
    }
  },

  /** v22.88: switch the map's base style. Preserves center/zoom/bearing/
   *  pitch (MapLibre's setStyle keeps the camera). Persists the choice
   *  to State.settings.mapStyle so it survives reloads. Re-adds the
   *  route line after the new style loads (style swap drops custom
   *  sources/layers; markers added via maplibregl.Marker survive). */
  setMapStyle(styleId) {
    if (!this.m) return;
    const def = MAP_STYLES.find(s => s.id === styleId);
    if (!def) { logEvent('MAP', 'Unknown mapStyle: ' + styleId, 'err'); return; }
    State.settings.mapStyle = styleId;
    State.saveSettings();
    try {
      this.m.setStyle(def.style);
      logEvent('MAP', `Style → ${def.label}`, 'ok');
    } catch (e) {
      logEvent('MAP', 'setStyle error: ' + (e && e.message || e), 'err');
      return;
    }
    // Re-add custom sources/layers after the new style is in.
    // Markers (current pos, captured points, destination) are DOM markers
    // and persist automatically; only the route line source needs rebuilding.
    this.m.once('style.load', () => {
      const savedDestId = this._routeForDestId;
      if (savedDestId) {
        // Force a refetch so the line is redrawn on the new style.
        this._routeForDestId = null;
        try { this._fetchAndDrawRoute(); } catch (e) {}
      }
      // Re-apply 3D pitch if it was on (style swap may reset camera state on
      // some MapLibre versions — defensive).
      if (State.settings.pitchMode) {
        try { this.m.setPitch(60); } catch (e) {}
      }
      // Compass needs a paint after style load so its rose orientation
      // matches the (preserved) bearing.
      UI.updateCompass();
    });
  },

  /** v22.58: fetch a driving route from current GPS pos → active destination
   *  via OSRM's free public router and draw it on the map. Idempotent:
   *  cached per destId, so it only runs once per (GPS session, destination).
   *  Stale-fetch safe: if dest changes during the network round-trip, the
   *  result is discarded. */
  _fetchAndDrawRoute() {
    if (!this.m || !this._mapLoaded) return;
    const pos = State.pos;
    const dest = State.activeDest();
    if (!pos || !dest) {
      if (this._routeForDestId) this.clearRoute();
      return;
    }
    if (this._routeFetching) return;
    if (this._routeForDestId === dest.id) return;

    // Different destination than the currently-drawn one → wipe old line
    // immediately so the user doesn't see a stale path while we fetch.
    if (this._routeForDestId && this._routeForDestId !== dest.id) {
      this.clearRoute();
    }

    // v22.98: try the learned-route cache first. If a matching entry
    // exists (same destId, ≤30 days old, origin within 2km of current
    // pos), restore its geometry IMMEDIATELY and skip the network
    // fetch. The deviation check still runs on every tick; if the live
    // path diverges, the normal reroute path replaces both the visible
    // line AND the stored entry.
    if (!this._isReroute) {
      const learned = RouteMemory.findLearnedRoute(dest.id, pos);
      if (learned) {
        this._renderRoute(learned.geometry);
        this._routeForDestId = dest.id;
        // v23.1.0: cache for diag-strip ETA. No toast — status sits on screen.
        this._routeDistanceM = learned.distance;
        this._routeDurationS = learned.duration;
        this._routeDestCoords = { lat: dest.lat, lng: dest.lng };
        const lkm = (learned.distance / 1000).toFixed(0);
        const lmin = Math.round(learned.duration / 60);
        logEvent('ROUTE', `restored learned route — ${lkm}km / ~${lmin}min`, 'ok');
        return;
      }
    }

    this._routeFetching = true;
    const destIdSnap = dest.id;
    const destNameSnap = dest.name || '';
    const url = `https://router.project-osrm.org/route/v1/driving/${pos.lng},${pos.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('OSRM ' + r.status); return r.json(); })
      .then(data => {
        if (!data.routes || !data.routes.length) throw new Error('no route');
        // Stale check: destination may have changed during the await
        const currentDest = State.activeDest();
        if (!currentDest || currentDest.id !== destIdSnap) return;
        const route0 = data.routes[0];
        this._renderRoute(route0.geometry);
        this._routeForDestId = destIdSnap;
        // v23.1.0: cache for diag-strip ETA. No toast — status sits on screen.
        this._routeDistanceM = route0.distance;
        this._routeDurationS = route0.duration;
        this._routeDestCoords = { lat: currentDest.lat, lng: currentDest.lng };
        const km = (route0.distance / 1000).toFixed(0);
        const min = Math.round(route0.duration / 60);
        // v22.97: log line names "reroute" when this fetch was triggered
        // by _checkRouteDeviation (the _isReroute flag) vs an initial fetch.
        if (this._isReroute) {
          logEvent('ROUTE', '[ROUTE-DEVIATION] reroute success', 'ok');
          logEvent('ROUTE', `reroute completed — ${km}km / ~${min}min`, 'ok');
          this._isReroute = false;
        } else {
          logEvent('ROUTE', `Drawn ${km} km, ~${min} min`, 'ok');
        }
        // v22.98: persist the fresh route to memory so future selections
        // of this destination can fast-start. Captured here in the
        // success branch so we never cache failed/no-route attempts.
        if (State.pos) {
          RouteMemory.saveLearnedRoute(
            destIdSnap,
            destNameSnap,
            route0.geometry,
            route0.distance,
            route0.duration,
            State.pos
          );
        }
        // v23.5 Phase 4: signal NetworkMonitor + clear any route backoff
        // so the next deviation check can issue a fresh request.
        try { NetworkMonitor.recordFetchResult('route', true); } catch (e) {}
        this._offlineRouteBackoffUntil = 0;
        try { if (typeof UI !== 'undefined' && UI.applyOfflineIndicator) UI.applyOfflineIndicator(); } catch (e) {}
      })
      .catch(e => {
        console.warn('Route fetch failed:', e);
        const msg = (e && e.message) || String(e);
        if (this._isReroute) {
          logEvent('ROUTE', '[ROUTE-DEVIATION] reroute failed: ' + msg, 'err');
          logEvent('ROUTE', 'reroute failed: ' + msg, 'err');
          this._isReroute = false;
        } else {
          logEvent('ROUTE', 'Fetch failed: ' + msg, 'err');
        }
        // v23.5 Phase 4: routing-provider failure is an authoritative
        // offline signal. Keep the existing route line + destination
        // intact (clearRoute is NEVER called from this branch). Apply a
        // longer backoff so we don't hammer a dead network.
        try { NetworkMonitor.recordFetchResult('route', false, msg); } catch (err2) {}
        this._offlineRouteBackoffUntil = Date.now() + (typeof NetworkMonitorConfig !== 'undefined' ? NetworkMonitorConfig.ROUTE_BACKOFF_MS : 30000);
        logEvent('OFFLINE-ROUTE',
          `[OFFLINE-ROUTE] route fetch failed · keeping last-known-good route + active destination · backoff ${Math.round((this._offlineRouteBackoffUntil - Date.now())/1000)}s`,
          'err');
        try { if (typeof UI !== 'undefined' && UI.applyOfflineIndicator) UI.applyOfflineIndicator(); } catch (e2) {}
      })
      .finally(() => { this._routeFetching = false; });
  },

  /** v22.58: write/update the route LineString as MapLibre source+layers.
   *  Two layers: a wider translucent glow underneath + a solid line on top
   *  for HUD-style contrast against the map. */
  _renderRoute(geom) {
    if (!this.m) return;
    const data = { type: 'Feature', properties: {}, geometry: geom };
    // v22.95: cache the coordinate array so _checkRouteDeviation can
    // measure how far off-route the user has drifted. Coordinates are
    // [lng, lat] tuples in MapLibre/GeoJSON convention.
    this._routeCoords = (geom && Array.isArray(geom.coordinates)) ? geom.coordinates : null;
    const src = this.m.getSource('ra-route');
    if (src) { src.setData(data); return; }
    this.m.addSource('ra-route', { type: 'geojson', data });
    this.m.addLayer({
      id: 'ra-route-glow',
      type: 'line',
      source: 'ra-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#4285F4', 'line-width': 10, 'line-opacity': 0.25 },
    });
    this.m.addLayer({
      id: 'ra-route-line',
      type: 'line',
      source: 'ra-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#4285F4', 'line-width': 5, 'line-opacity': 0.9 },
    });
  },

  /** v22.58: remove the route layers and source. Called on GPS stop and
   *  on destination change (before a refetch). */
  clearRoute() {
    if (!this.m) return;
    this._routeCoords = null; // v22.95: drop cached coords with the line
    // v23.1.0: drop cached route metrics so the diag-strip clears too
    this._routeDistanceM = null;
    this._routeDurationS = null;
    this._routeDestCoords = null;
    ['ra-route-line', 'ra-route-glow'].forEach(id => {
      try { if (this.m.getLayer(id)) this.m.removeLayer(id); } catch (e) {}
    });
    try { if (this.m.getSource('ra-route')) this.m.removeSource('ra-route'); } catch (e) {}
    this._routeForDestId = null;
  },

  /** v22.95: planar (flat-earth) distance in metres from a point P to
   *  the closest spot on the segment A→B. Accurate over short distances
   *  (≤ a few km). Inputs in {lat,lng}. Used by _distanceToRouteMeters. */
  _pointToSegmentMeters(p, a, b) {
    const latToM = 111320;
    const lngToM = 111320 * Math.cos(p.lat * Math.PI / 180);
    const px = (p.lng - a.lng) * lngToM, py = (p.lat - a.lat) * latToM;
    const bx = (b.lng - a.lng) * lngToM, by = (b.lat - a.lat) * latToM;
    const segLenSq = bx * bx + by * by;
    if (segLenSq === 0) return Math.sqrt(px * px + py * py);
    let t = (px * bx + py * by) / segLenSq;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx, dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
  },

  /** v22.95: minimum perpendicular distance in metres from `pos` to any
   *  segment of the cached route coords. Returns Infinity if no route
   *  is currently drawn. coords are [lng, lat] tuples (GeoJSON order). */
  _distanceToRouteMeters(pos, coords) {
    if (!coords || coords.length < 2) return Infinity;
    let min = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = { lng: coords[i][0],     lat: coords[i][1] };
      const b = { lng: coords[i + 1][0], lat: coords[i + 1][1] };
      const d = this._pointToSegmentMeters(pos, a, b);
      if (d < min) min = d;
    }
    return min;
  },

  /** v22.95: detect when the vehicle has drifted off the drawn route and
   *  trigger a fresh OSRM fetch from the new position.
   *
   *  Self-throttled three ways so we don't hammer the public OSRM
   *  endpoint or jank the canvas on every tick:
   *    1. Check at most every 3 seconds.
   *    2. Skip if a fetch is already in flight.
   *    3. Skip if the last reroute fired within the cooldown (default 30s).
   *
   *  Trigger condition: minimum perpendicular distance from user to ANY
   *  segment of the route line > _offRouteDeviationM (default 100m).
   *
   *  Refetch is just "clear the destId cache and call _fetchAndDrawRoute"
   *  — the existing fetch path then builds a fresh route from current pos. */
  _checkRouteDeviation() {
    const now = Date.now();
    // v23.1.12 (Phase 1): throttled diagnostic beacons. The `_rdBeaconAt`
    // gate fires the high-frequency labels at most once per 5s so the
    // debug log isn't flooded by the per-GPS-tick heartbeat. Strike,
    // request, success and failure labels are inherently low-frequency
    // and bypass the throttle.
    const rdBeacon = !this._rdBeaconAt || now - this._rdBeaconAt > 5000;
    if (rdBeacon) {
      this._rdBeaconAt = now;
      logEvent('ROUTE', '[ROUTE-DEVIATION] gps update received');
    }

    if (!this.m || !this._mapLoaded) {
      if (rdBeacon) logEvent('ROUTE', '[ROUTE-DEVIATION] check skipped: map not ready');
      return;
    }
    if (!State.pos) {
      if (rdBeacon) logEvent('ROUTE', '[ROUTE-DEVIATION] check skipped: no GPS pos');
      return;
    }
    if (!this._routeCoords || this._routeCoords.length < 2) {
      if (rdBeacon) logEvent('ROUTE', '[ROUTE-DEVIATION] check skipped: no active route geometry');
      return;
    }
    if (this._routeFetching) {
      if (rdBeacon) logEvent('ROUTE', '[ROUTE-DEVIATION] check skipped: fetch in flight');
      return;
    }
    const dest = State.activeDest();
    if (!dest) {
      if (rdBeacon) logEvent('ROUTE', '[ROUTE-DEVIATION] check skipped: no active destination');
      return;
    }

    // v22.97: GPS accuracy gate — don't make routing decisions on a poor
    // fix. The check still runs every GPS update; we just refuse to
    // strike or trigger when the position itself is too noisy.
    if (State.accuracy != null && State.accuracy > this._offRouteAccuracyMaxM) {
      if (rdBeacon) logEvent('ROUTE', `[ROUTE-DEVIATION] check skipped: accuracy ±${Math.round(State.accuracy)}m > ${this._offRouteAccuracyMaxM}m`);
      if (!this._lastDevDistLogAt || now - this._lastDevDistLogAt > 5000) {
        this._lastDevDistLogAt = now;
        logEvent('ROUTE', `GPS update · accuracy ±${Math.round(State.accuracy)}m > ${this._offRouteAccuracyMaxM}m — deviation check skipped`);
      }
      return;
    }

    // All guards passed — distance computation runs this tick
    if (rdBeacon) logEvent('ROUTE', '[ROUTE-DEVIATION] check running');

    const distM = this._distanceToRouteMeters(State.pos, this._routeCoords);

    // Throttled distance heartbeat for the debug panel (every ~5s)
    if (!this._lastDevDistLogAt || now - this._lastDevDistLogAt > 5000) {
      this._lastDevDistLogAt = now;
      logEvent('ROUTE', `GPS update · distance from route = ${Math.round(distM)}m · strikes ${this._offRouteStrikes}`);
    }

    if (distM <= this._offRouteDeviationM) {
      // Back inside the corridor — reset strikes and log the transition once
      if (this._offRouteStrikes > 0) {
        logEvent('ROUTE', `back on route (${Math.round(distM)}m) — strikes reset`, 'ok');
        this._offRouteStrikes = 0;
      }
      return;
    }

    // Off-route this update — accumulate a strike
    this._offRouteStrikes = (this._offRouteStrikes || 0) + 1;
    logEvent('ROUTE', `[ROUTE-DEVIATION] off route detected — ${Math.round(distM)}m, strike ${this._offRouteStrikes}/${this._offRouteStrikesRequired}`);
    logEvent('ROUTE', `off-route strike ${this._offRouteStrikes}/${this._offRouteStrikesRequired}: ${Math.round(distM)}m from route`);

    // Need N consecutive strikes before we trigger
    if (this._offRouteStrikes < this._offRouteStrikesRequired) return;

    // Debounce — only one auto-reroute per cooldown window
    const sinceLast = now - this._lastRefetchAt;
    if (sinceLast < this._rerouteCooldownMs) {
      if (!this._loggedDebounceAt || now - this._loggedDebounceAt > 5000) {
        this._loggedDebounceAt = now;
        const left = Math.ceil((this._rerouteCooldownMs - sinceLast) / 1000);
        logEvent('ROUTE', `[ROUTE-DEVIATION] check skipped: reroute debounce (${left}s remaining)`);
        logEvent('ROUTE', `reroute skipped — debounce (${left}s remaining)`);
      }
      return;
    }

    // v23.5 Phase 4: extended back-off when the routing provider is
    // currently unavailable. Keeps the existing route line + destination
    // intact; does NOT block GPS alerts (this is the deviation check,
    // not the alert tick).
    if (this._offlineRouteBackoffUntil && now < this._offlineRouteBackoffUntil) {
      if (!this._loggedDebounceAt || now - this._loggedDebounceAt > 5000) {
        this._loggedDebounceAt = now;
        const left = Math.ceil((this._offlineRouteBackoffUntil - now) / 1000);
        logEvent('OFFLINE-ROUTE',
          `[OFFLINE-ROUTE] reroute deferred — routing offline · ${left}s back-off remaining`);
      }
      return;
    }

    // Fire the reroute. Reset strikes so we don't fire again on the very
    // next tick before the fetch even completes.
    this._lastRefetchAt = now;
    this._offRouteStrikes = 0;
    this._isReroute = true;
    logEvent('ROUTE', `[ROUTE-DEVIATION] reroute requested — ${Math.round(distM)}m off route`, 'ok');
    logEvent('ROUTE', `reroute started — ${Math.round(distM)}m off route, recalculating from current GPS`, 'ok');
    // v23.1.0: status sits in the diag-strip now; no toast for reroute.
    // Clearing the cached destId forces _fetchAndDrawRoute to re-issue.
    this._routeForDestId = null;
    this._fetchAndDrawRoute();
  },

  /** v22.104: arrival check. When GPS gets within ARRIVAL_RADIUS_M of the
   *  active destination, flip the stored route to confirmed and clear the
   *  drawn line. Idempotent per session via _arrivedDestIds. */
  _checkArrival() {
    if (!State.pos) return;
    const dest = State.activeDest();
    if (!dest) return;
    if (this._arrivedDestIds.has(dest.id)) return;
    const distM = Utils.distKm(State.pos, dest) * 1000;
    if (distM > this.ARRIVAL_RADIUS_M) return;
    this._arrivedDestIds.add(dest.id);
    logEvent('ROUTE', `arrived at "${dest.name || dest.id}" (${Math.round(distM)}m) — route confirmed`, 'ok');
    Utils.toast(`Arrived at ${dest.name || 'destination'}`, 'good');
    try { RouteMemory.confirmLearnedRoute(dest.id); } catch (e) {
      logEvent('ROUTE', 'confirmLearnedRoute threw: ' + (e && e.message || e), 'err');
    }
    this.clearRoute();
    // Intentionally keep _routeForDestId = dest.id so the next tick doesn't
    // refetch a degenerate near-zero route. A real destination change resets
    // both the cache and clears the line via the normal path.
  },

  askSetDest(latlng) {
    State.editingDestId = null;
    UI.openDestEditor(null, { lat: +latlng.lat.toFixed(5), lng: +latlng.lng.toFixed(5) });
  },

  /** v22.72: one-shot single-tap pick mode for setting a destination.
   *  Attaches a click handler to the map that fires once, captures the
   *  tapped coords, then re-opens the destination editor with them.
   *  Auto-cancels after 30 seconds if the user doesn't tap.
   *  v22.73: preserves the editing context — if the user was editing an
   *  existing destination, picking a new map location updates THAT dest
   *  instead of silently switching to "Add new". */
  beginDestinationPickMode() {
    if (!this.m) { Utils.toast('Map not ready', 'bad'); return; }
    if (this._destPickActive) return;
    this._destPickActive = true;
    const editingIdSnap = State.editingDestId; // v22.73: capture before close
    let clickHandler;
    const cleanup = () => {
      this._destPickActive = false;
      try { if (clickHandler) this.m.off('click', clickHandler); } catch (e) {}
      if (this._destPickTimer) { clearTimeout(this._destPickTimer); this._destPickTimer = null; }
    };
    clickHandler = (e) => {
      if (!this._destPickActive) return;
      cleanup();
      UI.openDestEditor(editingIdSnap, {
        lat: +e.lngLat.lat.toFixed(5),
        lng: +e.lngLat.lng.toFixed(5),
      });
    };
    // v22.73: small delay so the modal-close tap can't immediately register
    // as a map pick on some touch browsers (event propagation race).
    setTimeout(() => {
      if (this._destPickActive) this.m.on('click', clickHandler);
    }, 200);
    this._destPickTimer = setTimeout(() => {
      if (this._destPickActive) {
        Utils.toast('Pick cancelled — no tap within 30s', 'bad');
        cleanup();
      }
    }, 30000);
    Utils.toast('Tap anywhere on the map to set the destination', 'good');
  },

  startCaptureAt(latlng) {
    if (!latlng || latlng.lat == null || latlng.lng == null) return;
    // v22.56: respect the long-press toggle (off by default). When off,
    // tapping/holding on the map does nothing — prevents accidental captures.
    if (!State.settings.longPressCapture) return;
    const pt = { lat: +latlng.lat, lng: +latlng.lng };
    const nearby = State.data.points.find(p => Utils.distKm(p, pt) * 1000 < 30);
    if (nearby) {
      Utils.toast('Existing point nearby — tap it to edit', 'bad');
      return;
    }
    if (!State.data.activeDestId) {
      Utils.toast('Pick a destination first', 'bad');
      UI.renderRoutesList();
      UI.openModal('m-routes');
      return;
    }
    State.captureLocationOverride = {
      lat: +pt.lat.toFixed(5),
      lng: +pt.lng.toFixed(5),
    };
    if (navigator.vibrate) navigator.vibrate(40);
    Utils.toast(`Capture at ${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`, 'good');
    UI.openCaptureMenu();
  },
};

/* ============================================================
   6b. SOUND-PREVIEW CONTROLLER — v23.6.0 merge
   Removed. The 18-sound modal opened from "🔔 Sound Alerts" uses
   Audio.preview(id, {frequency, onStatus}) directly with its own
   single-flight token in app-core.js. The parallel agent's
   SoundPreview controller would have called a 1-arg form of
   Audio.preview that no longer exists.
   ============================================================ */

/* ============================================================
   7. UI
   ============================================================ */
const UI = {
  render() {
    this.renderRouteBar();
    this.renderStats();
    this.renderStatusLine();
    this.renderDisabledCount();
    this.renderDiagStrip(); // v22.12
    this.renderTimeline(); // v22.58
    this.updateBackupTicker(); // v22.68
  },

  /** v22.68: bottom-of-screen auto-backup heartbeat. Hidden when
   *  auto-backup is off or GitHub isn't configured. Shows green
   *  "✓ updated Xm ago" once a successful backup has happened. */
  updateBackupTicker() {
    const el = document.getElementById('status-backup');
    if (!el) return;
    if (!State.settings.autoBackup || !State.gh.token || !State.gh.repo) {
      el.textContent = '';
      el.className = '';
      return;
    }
    if (!State.lastBackup) {
      el.textContent = '↻ backup pending';
      el.className = 'off';
      return;
    }
    const min = Math.floor((Date.now() - State.lastBackup) / 60000);
    if (min < 1)         el.textContent = '✓ updated just now';
    else if (min < 60)   el.textContent = `✓ updated ${min}m ago`;
    else                 el.textContent = `✓ updated ${Math.floor(min / 60)}h ago`;
    el.className = '';
  },

  /** v22.81 / hardened in v22.83: rotate the compass rose to reflect the
   *  CURRENT map bearing, read directly from the MapLibre map instance
   *  (never from State, never from GPS). Subscribed to rotate / move /
   *  pitch events so any code path that changes bearing keeps it in sync.
   *
   *  Inverse rotation: when the map shows east as "up" (bearing 90),
   *  true north is to the LEFT of the screen, so the rose rotates -90°
   *  → the red N tip ends up on the left side of the dial.
   *
   *  Also handles the show/hide setting: if showCompass is false, the
   *  button has hidden=true and pointer-events disabled. No rotation
   *  work is done while hidden. */
  updateCompass() {
    const btn = document.getElementById('btn-compass');
    if (!btn) return;
    // v22.83: visibility toggle. Apply on every call so the toggle from
    // Settings takes effect on the very next event tick.
    const visible = State.settings.showCompass !== false;
    btn.hidden = !visible;
    if (!visible) return;
    const rose = document.getElementById('compass-rose');
    if (!rose || !MapView.m) return;
    let bearing;
    try { bearing = MapView.m.getBearing(); } catch (e) { return; }
    if (typeof bearing !== 'number' || isNaN(bearing)) return;
    // Use setProperty so the transform is explicitly applied (defensive
    // against any future CSS rule that might shadow the inline style).
    rose.style.setProperty('transform', `rotate(${-bearing}deg)`);
    // Throttled diagnostic — every ~3s so the debug panel doesn't flood
    // during nav-mode rotation (which fires many rotate events/sec).
    if (!this._lastCompassLogAt || Date.now() - this._lastCompassLogAt > 3000) {
      this._lastCompassLogAt = Date.now();
      logEvent('MAP', `Compass bearing=${bearing.toFixed(1)}`);
    }
  },

  /** v22.83: flip the show/hide setting, persist, and apply immediately. */
  toggleCompass() {
    State.settings.showCompass = State.settings.showCompass === false ? true : false;
    State.saveSettings();
    const btn = document.getElementById('btn-compass');
    if (btn) btn.hidden = !State.settings.showCompass;
    UI.syncSettings();
    UI.updateCompass();
    logEvent('MAP', 'Compass ' + (State.settings.showCompass ? 'ON' : 'OFF'));
    Utils.toast('Compass ' + (State.settings.showCompass ? 'on' : 'off'), 'good');
  },

  /** v22.79: render the debug log modal contents. Newest at top — Logger
   *  already unshifts new entries to index 0, so iteration order gives us
   *  the correct visual order without a sort. scrollTop = 0 keeps the
   *  newest visible (auto-scroll behavior). */
  /** v22.88: paint the map-style picker rows. Currently-selected style
   *  gets the .active class (amber background via existing .opts rule
   *  on .sheet-btn? actually .sheet-btn doesn't have an active state by
   *  default — we set border-color inline). Tap a row → setMapStyle. */
  /** v22.96: paint the small status line above the Migrate buttons and
   *  show/hide the Restore-backup button based on whether a backup
   *  exists in localStorage. Called on Settings open and after any
   *  migration action. */
  renderMigrationStatus() {
    const el = document.getElementById('migration-status');
    const restoreBtn = document.getElementById('btn-migrate-restore');
    const dryBtn = document.getElementById('btn-migrate-dry');
    if (!el) return;
    const migrated = Migration.isMigrated();
    const backup = Migration.readMigrationBackup();
    if (migrated) {
      const when = localStorage.getItem(Storage.KEYS.migrationCompletedAt) || '';
      el.innerHTML = `<strong>Migrated</strong> · using global point store · completed ${Utils.escapeHtml(when.slice(0, 19).replace('T', ' '))}` +
        (backup ? `<br>Backup still available (until you restore or clear it).` : `<br>Backup not found.`);
      if (dryBtn) dryBtn.textContent = '⚙ Re-run dry-run';
    } else {
      el.innerHTML = `<strong>Legacy layout</strong> — points are owned by destinations via destId. Run the migration to switch to a global point store with destination.routePointRefs[] indirection.`;
      if (dryBtn) dryBtn.textContent = '⚙ Migrate to global store';
    }
    if (restoreBtn) restoreBtn.style.display = backup ? 'block' : 'none';
  },

  /** v23.x Phase 2a: paint the Storage safety-net status row + snapshot
   *  list. Pure read of localStorage — never mutates road memory. The
   *  optional `prebuiltReport` skips the second inventory pass when the
   *  caller (e.g. the Report button) just ran one. */
  refreshStorageStatus(prebuiltReport) {
    const statusEl = document.getElementById('storage-status');
    const listEl = document.getElementById('storage-snapshots');
    if (!statusEl && !listEl) return;
    const inv = prebuiltReport || (function() {
      // Quiet inventory — caller didn't ask for the log noise
      const all = StorageInventory._allKeyBytes();
      const totalBytes = all.reduce((s, e) => s + e.bytes, 0);
      const appKeys = all.filter(e => StorageInventory._isAppKey(e.key));
      const snapshotKeys = appKeys.filter(e => e.key.indexOf(StorageInventoryConfig.SNAPSHOT_PREFIX) === 0);
      return { totalBytes, appKeys, snapshotKeys };
    })();
    const schema = (function() {
      try {
        const anyRefs = (State.data && Array.isArray(State.data.destinations) && State.data.destinations.some(d => Array.isArray(d && d.routePointRefs)));
        if (anyRefs) return 1;
        if (localStorage.getItem(Storage.KEYS.migrationCompletedAt)) return 1;
        return 0;
      } catch (e) { return 0; }
    })();
    if (statusEl) {
      const warn = inv.totalBytes > StorageInventoryConfig.QUOTA_WARN_BYTES;
      statusEl.style.borderLeftColor = warn ? 'var(--red)' : 'var(--amber-2)';
      statusEl.innerHTML =
        `<strong>Schema</strong> ${schema} ${schema === 1 ? '(global store)' : '(legacy)'}` +
        ` · <strong>Total</strong> ${Utils.escapeHtml(StorageInventory._fmtBytes(inv.totalBytes))}` +
        ` · <strong>Snapshots</strong> ${inv.snapshotKeys.length}` +
        (warn ? ` · <span style="color:var(--red)">QUOTA WARN</span>` : '');
    }
    if (listEl) {
      const snaps = StorageInventory.listSnapshots();
      if (!snaps.length) {
        listEl.innerHTML = '<em>No snapshots yet — tap 📸 Snapshot to create one.</em>';
      } else {
        listEl.innerHTML = snaps.map(s =>
          `<div>· ${Utils.escapeHtml(s.ts.replace('T', ' ').slice(0, 19))} · ${Utils.escapeHtml(StorageInventory._fmtBytes(s.bytes))}</div>`
        ).join('');
      }
    }
  },

  /** v23.x Phase 2c-1c: paint the duplicate-detector report into the
   *  Storage safety-net results panel. STRICTLY read-only — every row
   *  is plain text; no buttons, no click handlers, no data-* hooks
   *  back to mutators. Caller already ran DuplicateDetector.scan(); this
   *  method only renders. */
  renderDuplicateScanResults(result) {
    const host = document.getElementById('storage-dupscan-results');
    if (!host) return;
    if (!result) { host.innerHTML = ''; return; }

    const order = [
      'TRUE_DUPLICATE',
      'SAME_PASS_DUPLICATE',
      'LEGITIMATE_REPEAT',
      'DIFFERENT_CARRIAGEWAY',
      'CROSS_DESTINATION',
      'AMBIGUOUS',
    ];
    // UI labels — SAME_PASS_DUPLICATE deliberately worded
    // "high-confidence duplicate candidate" per spec. Phase 2c-1c has
    // no merge of any kind.
    const titles = {
      TRUE_DUPLICATE:        '⚠ ID collisions',
      SAME_PASS_DUPLICATE:   '⚠ High-confidence duplicate candidates',
      LEGITIMATE_REPEAT:     'Legitimate repeat sightings',
      DIFFERENT_CARRIAGEWAY: 'Different carriageway',
      CROSS_DESTINATION:     'Cross-destination',
      AMBIGUOUS:             'Ambiguous',
    };
    const colors = {
      TRUE_DUPLICATE:        'var(--red)',
      SAME_PASS_DUPLICATE:   'var(--red)',
      LEGITIMATE_REPEAT:     'var(--ink-2)',
      DIFFERENT_CARRIAGEWAY: 'var(--ink-2)',
      CROSS_DESTINATION:     'var(--ink-2)',
      AMBIGUOUS:             'var(--ink-3)',
    };

    const groups = {};
    for (const r of (result.rows || [])) {
      if (!groups[r.classification]) groups[r.classification] = [];
      groups[r.classification].push(r);
    }

    const lines = [];
    lines.push(
      `<div style="margin-bottom:4px;"><strong>Scan summary</strong> · ` +
      `${result.totalPoints} stored, ${result.activePoints} active, ` +
      `${result.candidateCount} within ${DuplicateDetectorConfig.MAX_PAIR_RADIUS_M}m · ` +
      `${(result.rows || []).length} pair(s) flagged · ` +
      `${result.counts.ALREADY_COLLAPSED} silent (already-collapsed) · ` +
      `${result.elapsedMs}ms</div>`
    );

    if (!(result.rows || []).length) {
      lines.push('<div style="color:var(--green);">No suspicious pairs found.</div>');
    }

    for (const cls of order) {
      const list = groups[cls] || [];
      if (!list.length) continue;
      lines.push(
        `<div style="margin-top:6px;color:${colors[cls]};"><strong>` +
        Utils.escapeHtml(titles[cls]) + `</strong> (${list.length})</div>`
      );
      const MAX_VIS = 10;
      for (const r of list.slice(0, MAX_VIS)) {
        const gap = DuplicateDetector._formatGap(r.timeGapMs);
        const aid = Utils.escapeHtml(String(r.a.id || '?').slice(0, 8));
        const bid = Utils.escapeHtml(String(r.b.id || '?').slice(0, 8));
        const typeTag = (r.a.type === r.b.type) ? Utils.escapeHtml(String(r.a.type || '?')) : 'mixed';
        const bearingTag = (r.bearingDiffDeg != null) ? ` · Δθ ${Math.round(r.bearingDiffDeg)}°` : '';
        const confTag = ` · conf ${r.a.confidence}/${r.b.confidence}` +
          ((r.a.confirmationsCount || r.b.confirmationsCount) ?
            ` · conf-log ${r.a.confirmationsCount}/${r.b.confirmationsCount}` : '');
        lines.push(
          `<div>· ${aid} ↔ ${bid} · ${typeTag} · ` +
          `${Math.round(r.staticDistanceM)}m · Δt ${Utils.escapeHtml(gap)}` +
          `${bearingTag}${confTag}</div>`
        );
      }
      if (list.length > MAX_VIS) {
        lines.push(`<div style="color:var(--ink-3);">… and ${list.length - MAX_VIS} more — see debug log</div>`);
      }
    }

    // Single innerHTML write — every interpolation goes through
    // Utils.escapeHtml or is a number. No event handlers attached
    // anywhere on the produced DOM.
    host.innerHTML = lines.join('');
  },

  /** v22.96: Run the dry-run migration in memory, paint the report into
   *  the modal, validate against the old data, and only enable the
   *  Run-migration button if validation passed. */
  openMigrationDryRun() {
    const oldData = State.data;
    const dry = Migration.runMigrationDryRun(oldData);
    const validation = Migration.validateMigrationResult(oldData, dry.newData, dry.mergeMap);
    const r = dry.report;
    const rep = document.getElementById('migration-report');
    const errBox = document.getElementById('migration-errors');
    const goBtn = document.getElementById('btn-do-migrate');
    rep.innerHTML = [
      `<div><span style="color:var(--ink-3)">Old destinations:</span> <strong>${r.oldDestCount}</strong></div>`,
      `<div><span style="color:var(--ink-3)">Old points:</span> <strong>${r.oldPointCount}</strong></div>`,
      `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)"><span style="color:var(--ink-3)">Duplicate groups detected:</span> <strong>${r.duplicateGroups}</strong></div>`,
      `<div><span style="color:var(--ink-3)">Points to be merged:</span> <strong>${r.pointsToMerge}</strong></div>`,
      `<div><span style="color:var(--ink-3)">Global points after merge:</span> <strong style="color:var(--green)">${r.newGlobalPoints}</strong></div>`,
      `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)"><span style="color:var(--ink-3)">Destinations to migrate:</span> <strong>${r.destsToMigrate}</strong></div>`,
      `<div><span style="color:var(--ink-3)">Zero-point destinations (kept):</span> <strong>${r.zeroPointDests}</strong></div>`,
      `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line);font-size:10px;color:var(--ink-3)">Determinism check: <strong style="color:var(--green)">${UI._runDeterminismCheck(oldData) ? 'PASS' : 'FAIL'}</strong> (dry-run output is byte-identical across two runs)</div>`,
    ].join('');
    if (validation.ok) {
      errBox.style.display = 'none';
      goBtn.disabled = false;
      goBtn.style.opacity = '1';
    } else {
      errBox.style.display = 'block';
      errBox.innerHTML = '<strong>Validation failed — migration blocked:</strong><ul style="margin:4px 0 0 18px;padding:0">' +
        validation.errors.map(e => `<li>${Utils.escapeHtml(e)}</li>`).join('') + '</ul>';
      goBtn.disabled = true;
      goBtn.style.opacity = '0.4';
    }
    logEvent('MIGRATE', `dry-run: ${r.oldPointCount}p / ${r.oldDestCount}d → ${r.newGlobalPoints}p (merged ${r.pointsToMerge}) · validation ${validation.ok ? 'ok' : 'FAIL'}`, validation.ok ? 'ok' : 'err');
    this.openModal('m-migration');
  },

  /** v22.96: run dry-run TWICE on the same input and compare via
   *  sortedKeyStringify. The whole point of deterministic dedup is
   *  byte-identical output. */
  _runDeterminismCheck(oldData) {
    try {
      const a = Migration.runMigrationDryRun(oldData);
      const b = Migration.runMigrationDryRun(oldData);
      return sortedKeyStringify({
        newData: a.newData, mergeMap: a.mergeMap,
      }) === sortedKeyStringify({
        newData: b.newData, mergeMap: b.mergeMap,
      });
    } catch (e) { return false; }
  },

  /** v22.96: commit the migration after explicit confirmation. */
  async doMigration() {
    const ok = await UI.confirm(
      'Apply migration NOW?\n\nA backup of your current data will be saved to localStorage. You can restore from it later via Settings → Data architecture → Restore backup.',
      { title: 'Confirm migration', okLabel: 'Apply' }
    );
    if (!ok) { logEvent('MIGRATE', 'user declined at confirm'); return; }
    const result = Migration.migrateToGlobalSpeedPoints(State.data);
    if (result.ok) {
      Utils.toast('Migration applied · backup saved', 'good');
      this.closeAllModals();
      UI.render();
      if (MapView.m) MapView.updatePoints();
      this.renderMigrationStatus();
    } else {
      Utils.toast('Migration failed — original data unchanged', 'bad');
      logEvent('MIGRATE', 'migration failed: ' + (result.errors || []).join('; '), 'err');
    }
  },

  /** v22.96: restore the backed-up legacy data structure. */
  async doMigrationRestore() {
    const ok = await UI.confirm(
      'Restore the pre-migration backup? This will REPLACE current data with the backed-up legacy structure.',
      { title: 'Restore backup', okLabel: 'Restore' }
    );
    if (!ok) return;
    if (Migration.restoreFromMigrationBackup()) {
      Utils.toast('Backup restored', 'good');
      UI.render();
      if (MapView.m) MapView.updatePoints();
      this.renderMigrationStatus();
    } else {
      Utils.toast('Restore failed — no backup found', 'bad');
    }
  },

  renderMapStyleList() {
    const list = document.getElementById('mapstyle-list');
    if (!list) return;
    const current = State.settings.mapStyle || 'liberty';
    list.innerHTML = MAP_STYLES.map(s => {
      const sel = s.id === current;
      const ring = sel ? 'border-color:var(--amber);background:var(--surface-2);' : '';
      return `<button class="sheet-btn" data-mapstyle="${Utils.escapeHtml(s.id)}" style="${ring}">
        <span class="em">${s.em}</span>${Utils.escapeHtml(s.label)}
      </button>`;
    }).join('');
    list.querySelectorAll('[data-mapstyle]').forEach(b => {
      b.onclick = () => {
        MapView.setMapStyle(b.dataset.mapstyle);
        UI.closeAllModals();
        Utils.toast('Map: ' + (MAP_STYLES.find(s => s.id === b.dataset.mapstyle) || {}).label, 'good');
      };
    });
  },

  renderDebugLog() {
    const list = document.getElementById('debug-log');
    const count = document.getElementById('debug-count');
    // v23.5.8: refresh the altitude block alongside the log so the
    // readout stays live while the modal is open. Safe-guarded — if
    // the block is absent (older markup) the call is a no-op.
    this.renderAltitudeDiag();
    if (!list) return;
    if (count) count.textContent = `(${Logger.logs.length})`;
    if (!Logger.logs.length) {
      list.innerHTML = '<div class="empty">No events logged yet</div>';
      return;
    }
    list.innerHTML = Logger.logs.map(L =>
      `<div class="debug-row ${Utils.escapeHtml(L.level)}">
        <span class="ts">${Utils.escapeHtml(L.t)}</span>
        <span class="ty">${Utils.escapeHtml(L.type)}</span>
        <span class="msg">${Utils.escapeHtml(L.msg)}</span>
      </div>`
    ).join('');
    list.scrollTop = 0;
  },

  /** v23.5.8: GPS altitude diagnostic readout. Pure display — never
   *  touches alert logic, scoring, route, or markers. Reads the values
   *  captured in GPS.onTick (State.altitude / State.altitudeAccuracy)
   *  and applies a quality label band:
   *    ≤ 5 m  : Excellent
   *    ≤ 15 m : Good
   *    ≤ 30 m : Weak
   *    > 30 m : Unreliable
   *    null   : Unknown
   *  Safe to call before GPS has produced a fix and before the modal
   *  exists — every DOM lookup is null-guarded. */
  renderAltitudeDiag() {
    const altEl = document.getElementById('alt-diag-altitude');
    const accEl = document.getElementById('alt-diag-accuracy');
    const qEl = document.getElementById('alt-diag-quality');
    if (!altEl && !accEl && !qEl) return;

    const alt = State.altitude;
    const acc = State.altitudeAccuracy;

    if (altEl) {
      altEl.textContent = (alt != null) ? `${alt.toFixed(1)} m` : 'Unavailable';
    }
    if (accEl) {
      accEl.textContent = (acc != null) ? `± ${acc.toFixed(1)} m` : 'Unavailable';
    }
    if (qEl) {
      let label, color;
      if (acc == null) { label = 'Unknown'; color = 'var(--ink-3)'; }
      else if (acc <= 5) { label = 'Excellent'; color = 'var(--green)'; }
      else if (acc <= 15) { label = 'Good'; color = 'var(--green)'; }
      else if (acc <= 30) { label = 'Weak'; color = 'var(--amber)'; }
      else { label = 'Unreliable'; color = 'var(--red)'; }
      qEl.textContent = label;
      qEl.style.color = color;
    }
  },

  /** v22.58: render the right-side captured-points timeline rail.
   *  Reuses Utils.emoji / Utils.typeLabel / Utils.fmtAgo from app-core.js.
   *  Each entry shows emoji + short type label + abbreviated time-ago.
   *  Tap an entry → opens the point editor (same as map-marker popup). */
  // v22.65: remember which point was at the top of the sidebar last
  // render, so we can smooth-scroll back to top when the focused (closest)
  // point shifts to a new one.
  _lastFocusedTimelineId: null,

  renderTimeline() {
    // v23.5.3: the rail now hosts the speed-limit sign + this list. Write
    // into the dedicated child #rail-list so the sign survives every render.
    // Fall back to the old #tools-rail target on legacy markup just in case.
    const railR = document.getElementById('rail-list') || document.getElementById('tools-rail');
    // v23.10.0: optional left rail showing opposite-direction captures.
    const railL = document.getElementById('rail-list-left');
    if (!railR && !railL) return;

    const myPos = State.pos;
    // v23.8.0: timeline rail surfaces the global observation pool —
    // every captured point is alertable on every trip, so the
    // sidebar reflects the same source-of-truth as the alert engine.
    let pts;
    if (myPos) {
      pts = State.data.points
        .filter(p => p && p.status !== 'no' && typeof p.lat === 'number' && typeof p.lng === 'number')
        .map(p => ({ ...p, dist: Utils.distKm(myPos, p) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 100);
    } else {
      pts = State.data.points
        .filter(p => p && p.status !== 'no' && typeof p.lat === 'number' && typeof p.lng === 'number')
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, 100);
    }

    // v23.10.0: split by direction. A point whose captureBearing is
    // roughly opposite (>135°) to the driver's current heading belongs
    // to the OTHER side of the road → left rail. Everything else (same
    // direction, no bearing, or no reliable heading) → right rail.
    const heading = State.heading;
    const speedKmh = (State.speedMps || 0) * 3.6;
    const headingReliable = (typeof Speed !== 'undefined' && Speed.isHeadingReliable)
      ? Speed.isHeadingReliable(speedKmh) : (heading != null);
    const isOpposite = (p) => {
      if (!headingReliable || heading == null) return false;
      const pb = (typeof p.captureBearing === 'number') ? p.captureBearing
               : (typeof p.heading === 'number') ? p.heading : null;
      if (pb == null) return false;
      return Speed.angleDiff(heading, pb) > 135;
    };
    // v23.11.0: only split when the left rail is enabled — otherwise
    // every capture stays on the right rail (original behavior) so
    // nothing disappears into a hidden rail.
    const leftEnabled = State.settings.leftRailEnabled !== false;
    const rightPts = [];
    const leftPts = [];
    for (const p of pts) {
      if (railL && leftEnabled && isOpposite(p)) leftPts.push(p);
      else rightPts.push(p);
    }

    const aheadList = (typeof Alerts !== 'undefined') ? Alerts.ahead() : [];
    const aheadIds = new globalThis.Map();
    aheadList.slice(0, 3).forEach((a, idx) => aheadIds.set(a.id, idx + 1));
    const startM = +State.settings.proximityStartM || 1000;
    const finalM = startM * 0.2;

    if (railR) this._renderRailList(railR, rightPts.slice(0, 50), aheadIds, startM, finalM, myPos, 'No captures yet');
    if (railL) this._renderRailList(railL, leftPts.slice(0, 50), aheadIds, startM, finalM, myPos,
      headingReliable ? 'No opposite-side captures' : 'Drive to split by direction');

    // v22.65: auto-scroll the right rail back to top when the focused
    // (closest) point changes.
    const focusedId = rightPts[0] && rightPts[0].id;
    if (railR && focusedId && this._lastFocusedTimelineId !== focusedId) {
      this._lastFocusedTimelineId = focusedId;
      try { railR.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { railR.scrollTop = 0; }
    }
  },

  /** v23.10.0: render a list of points into a rail element. Extracted
   *  from renderTimeline so the left + right rails share one template
   *  and one set of handlers (delete + two-tap locate/edit). */
  _renderRailList(rail, pts, aheadIds, startM, finalM, myPos, emptyText) {
    if (!rail) return;
    if (!pts.length) {
      rail.innerHTML = `<div class="timeline-empty">${Utils.escapeHtml(emptyText || 'No captures')}</div>`;
      return;
    }
    rail.innerHTML = pts.map(p => {
      const short = (Utils.typeLabel(p.type) || '').split(' ')[0].slice(0, 4);
      let distText, distCls = '', tierCls = '';
      if (myPos) {
        const km = (p.dist != null) ? p.dist : Utils.distKm(myPos, p);
        const distM = km * 1000;
        if (km < 1) distText = Math.round(distM) + 'm';
        else if (km < 10) distText = km.toFixed(1) + 'km';
        else distText = Math.round(km) + 'km';
        if (distM < finalM) tierCls = ' tier-near';
        else if (distM < startM) tierCls = ' tier-mid';
        else tierCls = ' tier-far';
      } else {
        distText = 'no GPS';
        distCls = ' no-gps';
      }
      const aheadCls = aheadIds.has(p.id) ? ' ahead-' + aheadIds.get(p.id) : '';
      const pid = Utils.escapeHtml(p.id);
      return `<div class="timeline-entry${aheadCls}${tierCls}" data-tl-edit="${pid}">
        <button class="tl-x" data-tl-del="${pid}" title="Delete">×</button>
        <span class="em">${Utils.emoji(p.type, p.subtype)}</span>
        <span class="lbl">${Utils.escapeHtml(short)}</span>
        <span class="dist${distCls}">${Utils.escapeHtml(distText)}</span>
      </div>`;
    }).join('');
    rail.querySelectorAll('.tl-x').forEach(el => {
      el.onclick = async (ev) => {
        ev.stopPropagation();
        const id = el.dataset.tlDel;
        const p = State.data.points.find(x => x.id === id);
        if (!p) return;
        const label = p.name || Utils.typeLabel(p.type);
        const ok = await UI.confirm(`Delete ${label}?`, { title: 'Delete point' });
        if (!ok) return;
        State.removePointById(id);
        State.alertedMarkers.delete(id);
        State.lastDistByPoint.delete(id);
        State.passedPoints.delete(id);
        State.saveData();
        if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
        UI.renderTimeline();
        Utils.toast(`Deleted ${label}`, 'good');
      };
    });
    rail.querySelectorAll('[data-tl-edit]').forEach(el => {
      el.onclick = (ev) => {
        if (ev.target.classList && ev.target.classList.contains('tl-x')) return;
        const id = el.dataset.tlEdit;
        const now = Date.now();
        const sameRow = (UI._tlLastTapId === id);
        const withinWindow = (now - (UI._tlLastTapAt || 0)) < 2500;
        if (sameRow && withinWindow) {
          UI._tlLastTapId = null;
          UI._tlLastTapAt = 0;
          UI.openPointEditor(id);
          return;
        }
        UI._tlLastTapId = id;
        UI._tlLastTapAt = now;
        const p = State.data.points.find(x => x.id === id);
        if (p && MapView.m && p.lat != null && p.lng != null) {
          try {
            MapView.m.easeTo({ center: [p.lng, p.lat], duration: 400, essential: true });
          } catch (e) {}
          el.classList.add('tl-locating');
          setTimeout(() => el.classList.remove('tl-locating'), 600);
          Utils.toast('Tap again to edit', 'good');
        }
      };
    });
  },

  /** v22.37: GPS health indicator — multi-state strip.
   *  Detects: never-locked, stale fix, position jump, low accuracy.
   *  Colors: good (green) / warn (amber) / bad (red).
   *  Idle mode (no GPS started) shows neutral "off" — not red.
   *  v23.1.0: HDG and route ETA split into sibling cells in the strip.
   *  The recurring "Route: X km · ~Y min" toast was replaced by the
   *  ETA cell so the status sits on screen instead of popping every
   *  few seconds. */
  renderDiagStrip() {
    const gpsEl = document.getElementById('diag-gps');
    const hdgEl = document.getElementById('diag-hdg');
    const etaEl = document.getElementById('diag-eta');

    // GPS cell
    if (gpsEl) {
      // v23.2.1: PERMISSION_DENIED (code 1) takes precedence over every
      // other GPS state so the warning stays visible while the user
      // fixes their browser/device setting. Cleared on next GPS.start().
      if (State.gpsPermissionDenied) {
        gpsEl.textContent = 'GPS denied · check settings';
        gpsEl.className = 'bad';
      } else if (State.mode === 'idle') {
        gpsEl.textContent = 'GPS off';
        gpsEl.className = '';
      } else if (State.accuracy == null || State.lastFixAt == null) {
        gpsEl.textContent = 'GPS acquiring…';
        gpsEl.className = 'warn';
      } else {
        const sinceFixMs = Date.now() - State.lastFixAt;
        if (sinceFixMs > 30000) {
          gpsEl.textContent = `GPS LOST · ${Math.round(sinceFixMs / 1000)}s ago`;
          gpsEl.className = 'bad';
        } else if (sinceFixMs > 8000) {
          gpsEl.textContent = `GPS stale · ${Math.round(sinceFixMs / 1000)}s ago`;
          gpsEl.className = 'warn';
        } else if (State.lastFixJump) {
          gpsEl.textContent = `GPS jump ±${Math.round(State.accuracy)}m`;
          gpsEl.className = 'warn';
        } else {
          const acc = Math.round(State.accuracy);
          if (State.accuracy > 500) {
            gpsEl.textContent = `GPS ±${acc}m (poor)`;
            gpsEl.className = 'bad';
          } else if (State.accuracy > 200) {
            gpsEl.textContent = `GPS ±${acc}m (degraded)`;
            gpsEl.className = 'warn';
          } else {
            gpsEl.textContent = `GPS ±${acc}m ✓`;
            gpsEl.className = 'good';
          }
        }
      }
    }

    // HDG cell — own slot so it's always visible alongside GPS health.
    if (hdgEl) {
      if (State.heading == null) {
        hdgEl.textContent = 'HDG —';
        hdgEl.className = '';
      } else {
        const src = State.headingSource === 'gps' ? 'gps' : (State.headingSource === 'derived' ? 'der' : '?');
        hdgEl.textContent = `HDG ${Math.round(State.heading)}° ${src}`;
        hdgEl.className = '';
      }
    }

    // ETA cell — straight-line distance to active destination + estimated
    // arrival HH:MM derived from the cached route's average speed
    // (network distance / network duration). The straight-line shrinks as
    // the user drives, so the ETA self-updates without re-issuing OSRM.
    if (etaEl) {
      const destCoords = MapView._routeDestCoords;
      const distM = MapView._routeDistanceM;
      const durS = MapView._routeDurationS;
      if (!destCoords || !State.pos || !distM || !durS) {
        etaEl.textContent = 'ETA —';
        etaEl.className = '';
      } else {
        const avgSpeedMs = distM / durS; // m/s implied by OSRM
        const straightM = Utils.distKm(State.pos, destCoords) * 1000;
        const remainingSec = avgSpeedMs > 0 ? straightM / avgSpeedMs : 0;
        const arrival = new Date(Date.now() + remainingSec * 1000);
        const hh = String(arrival.getHours()).padStart(2, '0');
        const mm = String(arrival.getMinutes()).padStart(2, '0');
        const km = straightM / 1000;
        const distTxt = km < 1 ? Math.round(straightM) + 'm' : km.toFixed(1) + 'km';
        etaEl.textContent = `ETA ${hh}:${mm} · ${distTxt}`;
        etaEl.className = 'good';
      }
    }

    // v23.8.0: known-road indicator. Non-modal hint that shows the
    // count of observations ahead of the driver — proof that the
    // global pool is matching the current road regardless of which
    // destination is active. Hidden when there are no known points
    // nearby or when GPS isn't running.
    const knownEl = document.getElementById('diag-known');
    if (knownEl) {
      let show = false;
      if (State.pos && typeof Observations !== 'undefined') {
        try {
          const userState = Observations.buildUserState();
          if (userState) {
            const routeCoords = (MapView && MapView._routeCoords) ? MapView._routeCoords : null;
            const s = Observations.knownAheadSummary(userState, routeCoords);
            if (s && s.isKnownRoad) {
              const noun = s.ahead === 1 ? 'alert' : 'alerts';
              knownEl.textContent = `Known road · ${s.ahead} ${noun} ahead`;
              knownEl.className = 'diag-known' + (s.trusted >= 3 ? ' good' : '');
              show = true;
            }
          }
        } catch (e) {}
      }
      knownEl.hidden = !show;
    }

    // Network cell — center of the strip. navigator.onLine plus the
    // online/offline event listeners (wired in boot) keep it live.
    // v23.1.7:  emoji is back. .net-emoji child holds the glyph so
    //           textContent updates don't disturb the pulse pseudo-element.
    // v23.1.11: mirror the .net-online / .net-offline class onto the
    //           parent .diag-center card so its border can flash neon
    //           green / red.
    const netEl = document.getElementById('diag-net');
    if (netEl) {
      const online = (typeof navigator !== 'undefined' && navigator.onLine !== false);
      netEl.classList.toggle('net-online', online);
      netEl.classList.toggle('net-offline', !online);
      const card = netEl.closest('.diag-center');
      if (card) {
        card.classList.toggle('net-online', online);
        card.classList.toggle('net-offline', !online);
      }
      const label = online ? 'Online' : 'Offline';
      netEl.setAttribute('title', label);
      netEl.setAttribute('aria-label', label);
      let emojiEl = netEl.querySelector('.net-emoji');
      if (!emojiEl) {
        emojiEl = document.createElement('span');
        emojiEl.className = 'net-emoji';
        netEl.appendChild(emojiEl);
      }
      const next = online ? '🟢' : '🔴';
      if (emojiEl.textContent !== next) emojiEl.textContent = next;
    }
  },

  renderRouteBar() {
    const d = State.activeDest();
    document.getElementById('route-name').textContent = d ? d.name : 'Pick a destination';
  },

  /** v23.5.4: display-only setter for the ROAD row under the destination
   *  bar. A future commit can call UI.setCurrentRoad('M-1 Riyadh→Jeddah')
   *  whenever a real road-name source becomes available. Falls back to
   *  "Unknown" on empty/null. The value is NEVER used by alert scoring,
   *  speed-limit matching, capture, or route deviation. */
  setCurrentRoad(name) {
    const el = document.getElementById('road-name');
    if (!el) return;
    const v = (name == null || String(name).trim() === '') ? 'Unknown' : String(name).trim();
    if (el.textContent !== v) el.textContent = v;
  },

  /** v23.8.2 — UI-ONLY speed-status derivation. Pure function. Takes
   *  the already-resolved limit (km/h or null) and current speed
   *  (km/h, rounded) and returns one of the speed-status-* CSS class
   *  names. Never reads GPS state, never re-computes speed or limit,
   *  never triggers alerts. Called once per renderStats tick. */
  SPEED_NEAR_LIMIT_BAND_KMH: 5,
  _computeSpeedStatus(limit, kmh) {
    if (limit == null || typeof limit !== 'number' || isNaN(limit)) {
      return 'speed-status-unknown';
    }
    if (typeof kmh !== 'number' || isNaN(kmh)) {
      return 'speed-status-unknown';
    }
    if (kmh > limit)                                       return 'speed-status-over';
    if (kmh >= limit - this.SPEED_NEAR_LIMIT_BAND_KMH)     return 'speed-status-near-limit';
    return 'speed-status-safe';
  },

  renderStats() {
    const limit = Alerts.currentLimit();
    // v23.5.1 fix 1: explicit unknown state instead of "—". Visually
    // stable, never blank, never zero. The null-check inside
    // Alerts.checkSpeed (app-core.js) still prevents overspeed alerts
    // when the limit is unknown — we don't rebuild that logic here.
    const sign = document.getElementById('sign-value');
    if (sign) sign.textContent = (limit != null) ? String(limit) : 'UNK';
    // Throttled transition log so the debug buffer records when the
    // sign goes UNK or returns to a known value, without flooding.
    if (this._lastLimitDisplayed !== limit) {
      const now = Date.now();
      if (!this._lastLimitLogAt || now - this._lastLimitLogAt > 1000) {
        this._lastLimitLogAt = now;
        if (limit == null) {
          logEvent('SPEED', '[SPEED] unknown speed displayed (UNK)');
        } else {
          logEvent('SPEED', `[SPEED] active limit resolved → ${limit} km/h`, 'ok');
        }
      }
      this._lastLimitDisplayed = limit;
    }
    const kmh = Math.round(State.speedMps * 3.6);
    const speedo = document.getElementById('speedo-val');
    speedo.textContent = kmh;
    const isOver = limit != null && kmh > limit + State.settings.overBy;
    speedo.classList.toggle('over', isOver);
    // v22.27: auto-shrink font when speed reaches 3 digits so it never overflows the card
    speedo.classList.toggle('three-digit', kmh >= 100);

    // v23.8.2 — Dynamic Current Speed card status. UI-ONLY: this reads
    // the already-resolved `limit` (from Alerts.currentLimit() above)
    // and the already-computed `kmh`. It never re-derives the limit,
    // never queries observations, never touches GPS state. The four
    // mutually-exclusive .speed-status-* classes are applied to both
    // the stat-card (for the pulse + border) and the digit (for the
    // background tint). Existing .over class for the alert tolerance
    // remains untouched so the audio alert path is unaffected.
    const speedStatus = UI._computeSpeedStatus(limit, kmh);
    const speedCard = document.getElementById('speed-card');
    const STATUS_CLASSES = ['speed-status-unknown', 'speed-status-safe',
                            'speed-status-near-limit', 'speed-status-over'];
    if (speedCard) {
      STATUS_CLASSES.forEach(c => speedCard.classList.remove(c));
      speedCard.classList.add(speedStatus);
    }
    STATUS_CLASSES.forEach(c => speedo.classList.remove(c));
    speedo.classList.add(speedStatus);

    const aheadList = Alerts.ahead();
    const body = document.getElementById('next-body');
    // v22.13: flash the Next-ahead box border red when nearest point
    // is inside the configured flashStartM distance.
    // Defensive: always set the class explicitly (don't rely on prior state).
    const card = body.closest('.stat-card');
    if (card) {
      const flashAt = +State.settings.flashStartM || 500;
      const nearest = aheadList[0];
      const shouldFlash = !!(nearest && nearest.dist * 1000 <= flashAt);
      if (shouldFlash) card.classList.add('flash-near');
      else card.classList.remove('flash-near');
    }
    if (aheadList.length === 0) {
      const dest = State.activeDest();
      const hint = !dest
        ? '<div class="next-empty">— pick a destination —</div>'
        : '<div class="next-empty">— nothing ahead —</div>';
      body.innerHTML = hint;
    } else {
      const n = aheadList[0];
      // v22.104: escape side initial — defensive even though side comes
      // from a captured enum, in case import bypassed validation.
      const sideTag = n.side ? ` · ${Utils.escapeHtml(String(n.side)[0].toUpperCase())}` : '';
      const urgent = n.dist <= 0.5 ? 'urgent' : '';
      // v22.49: proximity progress bar — fills from 0% → 100% as user
      // approaches.  Scale: 0% when point is at proximityStartM (default
      // 1000m) or further, 100% when overhead. Color tier shifts amber→red
      // as you get closer (red at <200m).
      const startM = +State.settings.proximityStartM || 1000;
      const distM = n.dist * 1000;
      let pct = Math.max(0, Math.min(100, 100 * (1 - distM / startM)));
      const tier = distM < 200 ? 'red' : (distM < 500 ? 'amber' : 'green');
      body.innerHTML = `
        <div class="next-bg-emoji">${Utils.emoji(n.type, n.subtype)}</div>
        <div class="next-name">${Utils.escapeHtml(n.name)}</div>
        <div class="next-meta">${Utils.escapeHtml(Utils.typeLabel(n.type))}${sideTag}</div>
        <div class="next-dist ${urgent}">${n.dist < 1 ? Math.round(n.dist * 1000) : n.dist.toFixed(1)}<span class="unit">${n.dist < 1 ? 'm' : 'km'}</span></div>
        <div class="next-progress" data-tier="${tier}">
          <div class="next-progress-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
      `;
    }
  },

  renderStatusLine() {
    const gpsEl = document.getElementById('status-gps');
    if (State.accuracy != null) {
      gpsEl.textContent = `±${Math.round(State.accuracy)}m` + (State.lowAccuracy ? ' ⚠' : '');
      gpsEl.style.color = State.lowAccuracy ? 'var(--red)' : '';
    } else {
      gpsEl.textContent = '—';
      gpsEl.style.color = '';
    }
    // v23.8.0: status count reflects the global observation pool —
    // every captured point is reusable across trips, so the badge
    // shows the total instead of the active-destination-only subset.
    document.getElementById('status-pts').textContent =
      `${State.data.points.filter(p => p && p.status !== 'no').length} pts`;
  },

  renderDisabledCount() {
    const c = State.data.points.filter(p => p.status === 'no').length;
    const el = document.getElementById('disabled-count');
    if (el) el.textContent = c;
  },

  setStatusMode(label, cls) {
    const el = document.getElementById('status-mode');
    el.textContent = label;
    el.className = cls || '';
  },

  setBtnGoActive(active) {
    const btn = document.getElementById('btn-go');
    btn.classList.toggle('active', active);
    btn.textContent = active ? '■ Stop' : '▶ Start GPS';
  },

  updateMapPoints() { MapView.updatePoints(); },

  /** v22.4: refresh the top-bar sound icon based on current setting */
  updateSoundIcon() {
    const el = document.getElementById('btn-sound');
    if (!el) return;
    // v22.5: only voice or tone
    el.textContent = State.settings.sound === 'voice' ? '🗣' : '🔔';
  },

  /** v22.4: refresh the top-bar theme icon based on current setting */
  updateThemeIcon() {
    const el = document.getElementById('btn-theme');
    if (!el) return;
    el.textContent = State.settings.theme === 'dark' ? '🌙'
                    : State.settings.theme === 'auto' ? '🌓'
                    : '☀';
  },

  updateFollowPill() {
    const pill = document.getElementById('follow-pill');
    pill.classList.toggle('off', !State.followMap);
    document.getElementById('follow-label').textContent = 'Follow: ' + (State.followMap ? 'ON' : 'OFF');
  },

  /** v22.56: reflect long-press-capture state on the top-bar button.
   *  Locked icon (🔒) when off, unlocked (🔓) + amber highlight when on. */
  updateLongPressBtn() {
    const b = document.getElementById('btn-longpress');
    if (!b) return;
    const on = !!State.settings.longPressCapture;
    b.textContent = on ? '🔓' : '🔒';
    b.classList.toggle('on', on);
    b.title = on ? 'Long-press capture: ON (tap to disable)' : 'Long-press capture: OFF (tap to enable)';
  },

  openModal(id) { document.getElementById(id).classList.add('open'); },
  closeAllModals() {
    document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
    // v22.11 FIX: do NOT clear pendingCapture here. This used to nuke
    // captures the moment any modal in the flow closed (side picker,
    // limit picker, etc.), making every capture silently fail.
    // pendingCapture is cleared explicitly at end of finalizeCapture()
    // and at the start of openCaptureMenu() (defensive reset).
    // v22.39: if no capture is in flight, clear the map-tap location
    // override so a stale long-press doesn't leak into the next capture.
    if (!State.pendingCapture) State.captureLocationOverride = null;
  },

  /** v22.74: in-app confirm dialog. Returns a Promise that resolves to
   *  true (OK) or false (Cancel / dismiss). Native window.confirm() is
   *  silently blocked on some mobile browsers (especially iOS Safari with
   *  certain privacy settings), which made every Delete return false
   *  without ever showing UI. This replaces it with a real modal we own.
   *  Drop-in: const ok = await UI.confirm('Delete this point?'); */
  // v22.104: reentry guard. Two parallel calls would share the same DOM
  // and the second would overwrite the first's listeners, dropping the
  // first promise. Refuse the second call instead — destructive action
  // does not proceed.
  _confirmBusy: false,
  confirm(message, opts) {
    if (UI._confirmBusy) {
      logEvent('UI', 'confirm refused — another confirm is already open');
      return Promise.resolve(false);
    }
    UI._confirmBusy = true;
    return new Promise((resolve) => {
      const modal = document.getElementById('m-confirm');
      const titleEl = document.getElementById('confirm-title');
      const msgEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok-btn');
      const cancelBtn = document.getElementById('confirm-cancel-btn');
      const closeBtn = modal.querySelector('.modal-close');
      titleEl.textContent = (opts && opts.title) || 'Confirm';
      msgEl.textContent = message || 'Are you sure?';
      okBtn.textContent = (opts && opts.okLabel) || 'Delete';
      const cleanup = (result) => {
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        closeBtn.onclick = null;
        modal.classList.remove('open');
        UI._confirmBusy = false;
        resolve(result);
      };
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
      closeBtn.onclick = () => cleanup(false);
      modal.classList.add('open');
    });
  },

  /** v22.10: build the natural-language description of a point for voice. */
  _describePoint(point, distKm) {
    const parts = [];
    parts.push(point.name || Utils.typeLabel(point.type));
    if (distKm != null) {
      parts.push('in ' + Utils.fmtDist(distKm));
    }
    if (State.settings.announceSide && point.side) {
      parts.push(point.side === 'left' ? 'left side' : 'right side');
    }
    if (point.createdAt) {
      const ago = Utils.fmtAgo(point.createdAt);
      if (ago) parts.push('captured ' + ago);
    }
    return parts.join(', ');
  },

  /** v22.17: render the alert-distance markers as removable chips.
   *  Tap a chip to remove that marker. Updates from State.settings. */
  renderMarkerChips() {
    const wrap = document.getElementById('markers-chips');
    if (!wrap) return;
    const markers = (State.settings.alertMarkersM || []).slice().sort((a, b) => b - a);
    if (!markers.length) {
      wrap.innerHTML = '<span style="font-size:11px;color:var(--ink-3);font-style:italic;">No alert distances set — add at least one</span>';
      return;
    }
    wrap.innerHTML = markers.map(m =>
      `<button class="marker-chip" data-marker="${m}">${m}m</button>`
    ).join('');
    wrap.querySelectorAll('[data-marker]').forEach(b => {
      b.addEventListener('click', () => {
        const v = +b.dataset.marker;
        State.settings.alertMarkersM = (State.settings.alertMarkersM || []).filter(x => x !== v);
        State.saveSettings();
        UI.renderMarkerChips();
        Utils.toast('Removed ' + v + 'm', 'good');
      });
    });
  },

  /** v22.10: single-tap Next-ahead → announce nearest point ahead with full details. */
  announceNearestAhead() {
    Audio.unlock();
    const list = Alerts.ahead();
    if (!list.length) {
      Utils.toast('Nothing ahead', 'bad');
      if (State.settings.voiceGender !== 'none') Audio.say('Nothing ahead');
      return;
    }
    // v22.15 FIX: Alerts.ahead() returns objects with the point's fields
    // spread directly (so `nearest.name`, `nearest.type` etc. work) plus an
    // extra `dist` field. There is NO `nearest.point` — passing
    // `nearest.point` made `_describePoint` crash, which silently killed
    // the entire announcement (no toast, no beep, no voice).
    const nearest = list[0];
    const text = this._describePoint(nearest, nearest.dist);
    Utils.toast('📢 ' + text, 'good');
    // v23.7.0: route through playAlertSoundForType — same mapping
    // pipeline as the live alert. Matches whatever the driver will
    // hear when the point fires for real.
    if (State.settings.sound !== 'off') Audio.playAlertSoundForType(nearest.type);
    if (State.settings.voiceGender !== 'none') {
      setTimeout(() => Audio.say(text), 300);
    }
  },

  /** v22.10: double-tap Next-ahead → announce last captured point this trip. */
  announceLastTripCapture() {
    Audio.unlock();
    const id = State.lastTripCaptureId;
    const point = id ? State.data.points.find(x => x.id === id) : null;
    if (!point) {
      const msg = id ? 'Last capture was deleted' : 'Nothing captured this trip yet';
      Utils.toast(msg, 'bad');
      if (State.settings.voiceGender !== 'none') Audio.say(msg);
      return;
    }
    const dist = State.pos ? Utils.distKm(State.pos, point) : null;
    const text = 'Last capture: ' + this._describePoint(point, dist);
    Utils.toast('📢 ' + text, 'good');
    // v23.7.0: route through mapping-aware peep so the preview matches
    // what would fire live for this point's type.
    if (State.settings.sound !== 'off') Audio.playAlertSoundForType(point.type);
    if (State.settings.voiceGender !== 'none') {
      setTimeout(() => Audio.say(text), 300);
    }
  },

  /** v22.8: build a diagnostic readout of the audio environment. */
  openSoundCheck() {
    Audio.unlock();
    const platform = (() => {
      const ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
      if (/Android/.test(ua)) return 'Android';
      return 'Other';
    })();
    const inStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const ctx = Audio.ctx;
    const hasAC = !!(window.AudioContext || window.webkitAudioContext);
    const hasSS = 'speechSynthesis' in window;
    const voices = hasSS ? speechSynthesis.getVoices() : [];
    const enVoices = voices.filter(v => /en[-_]/i.test(v.lang) || v.lang === 'en');

    const pick = Audio.pickVoice();
    const rows = [
      ['Platform', platform],
      ['Mode', inStandalone ? 'PWA (home screen)' : 'Browser tab'],
      ['AudioContext supported', hasAC ? '✓ yes' : '✗ NO'],
      ['AudioContext state', ctx ? ctx.state : 'not yet created'],
      ['Audio unlocked', Audio._unlocked ? '✓ yes' : '✗ not yet (tap any button)'],
      ['SpeechSynthesis supported', hasSS ? '✓ yes' : '✗ NO'],
      ['Total voices loaded', voices.length],
      ['English voices', enVoices.length],
      ['Selected voice', pick ? (pick.name + ' (' + pick.lang + ')') : '(none — voice disabled or no English voice)'],
      ['Voice preference', State.settings.voiceGender],
      ['Sound mode', State.settings.sound],
      ['Repeat × times', State.settings.alertRepeatCount],
      ['Repeat gap (s)', State.settings.alertRepeatGapS],
    ];
    const html = rows.map(function(row) {
      const k = row[0], v = row[1];
      const sv = String(v);
      const ok = sv.indexOf('✓') === 0;
      const bad = sv.indexOf('✗') === 0;
      const color = ok ? 'var(--green)' : bad ? 'var(--red)' : 'var(--ink)';
      return '<div><span style="color:var(--ink-2);">' + Utils.escapeHtml(k) + ':</span> <span style="color:' + color + ';font-weight:700;">' + Utils.escapeHtml(sv) + '</span></div>';
    }).join('');
    document.getElementById('sound-check-results').innerHTML = html;
    this.openModal('m-sound-check');
  },

  /** v23.6.0 — Sound Alerts settings table. Builds 18 rows from
   *  SoundCatalogue, each with Frequency selector + Try button +
   *  preview status + Used-For selector. Reads / writes
   *  State.settings.soundAlerts (additive, compatible with older
   *  saved settings that don't have this key).
   *  PREVIEW-ONLY: changes here do NOT affect live alert triggers.
   *  v23.6.2: openSoundAlerts is now a no-op deprecation shim — the
   *  table is rendered inline in #m-settings via UI.renderSoundAlerts()
   *  called from the settings-open path. Kept for backward
   *  compatibility with any console / external caller. */
  openSoundAlerts() {
    Audio.unlock();
    this.renderSoundAlerts();
    this.openModal('m-settings');
  },

  renderSoundAlerts() {
    const host = document.getElementById('sound-alerts-table');
    if (!host) {
      try { logEvent('SOUND', '[SOUND] render skipped — #sound-alerts-table not in DOM', 'err'); } catch (e) {}
      return;
    }
    // v23.6.3 — bulletproof catalogue lookup. If SoundCatalogue is
    // not visible to this script, fall back to a one-line registry
    // shim so the section never blanks completely.
    const catalogue = (typeof SoundCatalogue !== 'undefined' && Array.isArray(SoundCatalogue) && SoundCatalogue.length)
      ? SoundCatalogue
      : (typeof globalThis !== 'undefined' && Array.isArray(globalThis.SoundCatalogue) ? globalThis.SoundCatalogue : null);
    if (!catalogue || !catalogue.length) {
      host.innerHTML = `<div class="empty" style="padding:8px;text-align:center;color:var(--red);">Sound catalogue unavailable. Reload may help.</div>`;
      try { logEvent('SOUND', '[SOUND] render failed — SoundCatalogue missing or empty', 'err'); } catch (e) {}
      return;
    }
    try { logEvent('SOUND', `[SOUND] rendering ${catalogue.length} rows`); } catch (e) {}

    const saved = (State.settings && State.settings.soundAlerts && typeof State.settings.soundAlerts === 'object')
      ? State.settings.soundAlerts : {};

    // v23.6.1: build Used-For dropdown from SoundUsedForGroups via <optgroup>.
    const usedForGroups = (typeof SoundUsedForGroups !== 'undefined' && Array.isArray(SoundUsedForGroups))
      ? SoundUsedForGroups
      : [{ id: '_none', label: '', items: [{ id: 'none', label: 'None' }] }];

    const safe = (v) => Utils.escapeHtml(String(v == null ? '' : v));
    const buildUsedForSelect = (id, label, selectedKey) => {
      const innerOpts = usedForGroups.map(g => {
        const opts = (g.items || []).map(it => {
          const sel = (it.id === selectedKey) ? ' selected' : '';
          return `<option value="${safe(it.id)}"${sel}>${safe(it.label)}</option>`;
        }).join('');
        if (!g.label) return opts;
        return `<optgroup label="${safe(g.label)}">${opts}</optgroup>`;
      }).join('');
      return `<select class="sa-usedfor" data-sa-usedfor="${safe(id)}" aria-label="Used-For for ${safe(label)}">${innerOpts}</select>`;
    };

    // v23.6.3 — bulletproof per-row render. If any single sound fails,
    // show a small inline failure cell for THAT row and continue with
    // the rest. A whole-section blank is the failure mode we're
    // explicitly preventing.
    const rows = [];
    let brokenIds = [];
    for (let i = 0; i < catalogue.length; i++) {
      const s = catalogue[i] || {};
      const num = i + 1;
      try {
        if (!s.id) throw new Error('missing id at index ' + i);
        const entry = saved[s.id] || {};
        const freq = (typeof normalizeSoundFrequency === 'function')
          ? normalizeSoundFrequency(entry.frequency)
          : (entry.frequency || 'medium');
        const usedRaw = entry.usedFor || s.defaultUsedFor || 'none';
        const used = (typeof migrateSoundUsedFor === 'function')
          ? migrateSoundUsedFor(usedRaw)
          : usedRaw;
        rows.push(`<div class="sa-row" data-sa-id="${safe(s.id)}">
          <div class="sa-name" title="${safe(s.label)}">${num}. ${safe(s.label || s.id)}</div>
          <select class="sa-freq" data-sa-freq="${safe(s.id)}" aria-label="Frequency for ${safe(s.label || s.id)}">
            <option value="high"${freq==='high'?' selected':''}>High</option>
            <option value="medium"${freq==='medium'?' selected':''}>Medium</option>
            <option value="low"${freq==='low'?' selected':''}>Low</option>
          </select>
          <div class="sa-try-wrap">
            <button class="sa-try" data-sa-try="${safe(s.id)}">Try</button>
            <div class="sa-status" data-sa-status="${safe(s.id)}"></div>
          </div>
          ${buildUsedForSelect(s.id, s.label || s.id, used)}
        </div>`);
      } catch (rowErr) {
        brokenIds.push(s && s.id ? s.id : '(index ' + i + ')');
        rows.push(`<div class="sa-row sa-row-broken" data-sa-id="${safe(s && s.id || '_broken_' + i)}">
          <div class="sa-name" style="color:var(--red);">${num}. ${safe(s.label || s.id || 'unknown sound')} — render failed</div>
          <div class="sa-freq" style="color:var(--ink-3);font-size:10px;">${safe(rowErr.message || rowErr)}</div>
          <div class="sa-try-wrap"><button class="sa-try" disabled>—</button><div class="sa-status"></div></div>
          <div class="sa-usedfor" style="color:var(--ink-3);font-size:10px;">—</div>
        </div>`);
      }
    }
    host.innerHTML = rows.join('');
    if (brokenIds.length) {
      try { logEvent('SOUND', `[SOUND] ${brokenIds.length} row(s) failed render: ${brokenIds.join(', ')}`, 'err'); } catch (e) {}
    }

    // Wire per-row controls — single-flight Try via Audio.preview.
    const ensureEntry = (id) => {
      if (!State.settings.soundAlerts || typeof State.settings.soundAlerts !== 'object') {
        State.settings.soundAlerts = {};
      }
      if (!State.settings.soundAlerts[id]) State.settings.soundAlerts[id] = {};
      return State.settings.soundAlerts[id];
    };

    host.querySelectorAll('[data-sa-freq]').forEach(sel => {
      sel.onchange = () => {
        const id = sel.dataset.saFreq;
        ensureEntry(id).frequency = sel.value;
        State.saveSettings();
      };
    });
    host.querySelectorAll('[data-sa-usedfor]').forEach(sel => {
      sel.onchange = () => {
        const id = sel.dataset.saUsedfor;
        ensureEntry(id).usedFor = sel.value;
        State.saveSettings();
      };
    });
    host.querySelectorAll('[data-sa-try]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.saTry;
        const freqSel = host.querySelector(`[data-sa-freq="${CSS.escape(id)}"]`);
        const statusEl = host.querySelector(`[data-sa-status="${CSS.escape(id)}"]`);
        const frequency = (freqSel && freqSel.value) || 'medium';
        const setStatus = (label) => {
          if (!statusEl) return;
          statusEl.textContent = label || '';
          statusEl.classList.remove('playing', 'played', 'failed');
          if (label === 'Playing…' || label === 'Buffering…') statusEl.classList.add('playing');
          else if (label === 'Played') statusEl.classList.add('played');
          else if (label === 'Failed') statusEl.classList.add('failed');
        };
        try { logEvent('SOUND', `[SOUND] try ${id} @ ${frequency}`); } catch (e) {}
        Audio.preview(id, { frequency, onStatus: setStatus });
      };
    });
  },

  /** v22.7: confirm destination before starting GPS.
   *  - If no destination is set → block, toast, open dest picker.
   *  - If a destination is set → show confirm dialog with Cancel / Change / Start.
   *  - On Start → play tone + voice announcement + actually start GPS. */
  confirmStart() {
    const dest = State.activeDest();
    if (!dest) {
      Utils.toast('Pick a destination first', 'bad');
      this.renderRoutesList();
      this.openModal('m-routes');
      return;
    }
    // Populate confirm modal
    document.getElementById('confirm-dest-name').textContent = dest.name;
    let meta = `${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}`;
    if (State.pos) {
      const km = Utils.distKm(State.pos, dest);
      meta += `  ·  ${Utils.fmtDist(km)} away`;
    }
    document.getElementById('confirm-dest-meta').textContent = meta;
    this.openModal('m-confirm-start');
  },

  /** v22.7: actually start GPS after confirmation — with tone + voice. */
  doStart() {
    const dest = State.activeDest();
    this.closeAllModals();
    Audio.unlock();
    // Tone confirmation (uses currently selected tone style)
    Audio.beep('checkpoint');
    // Voice announcement (skipped if voice is off)
    if (dest && State.settings.sound !== 'off' && State.settings.voiceGender !== 'none') {
      setTimeout(() => Audio.say('Heading to ' + dest.name), 250);
    }
    GPS.start();
  },

  openCaptureMenu() {
    // v22.39: allow capture without GPS if user long-pressed on map.
    // In that case captureLocationOverride is set, so we have a position.
    if (!State.pos && !State.captureLocationOverride) {
      Utils.toast('Need GPS fix first', 'bad');
      return;
    }
    // v22.11: defensive reset — clear any leftover pendingCapture from
    // a previous cancelled flow before starting a new one.
    State.pendingCapture = null;
    Audio.unlock();
    this.openModal('m-capture');
  },

  beginCapture(type) {
    // v22.39: use map-tap override if set, otherwise current GPS position
    const loc = State.captureLocationOverride || State.pos;
    if (!loc) {
      Utils.toast('Need GPS fix first — tap Start GPS', 'bad');
      this.closeAllModals();
      return;
    }
    // v22.70: "Destination" is a special capture type — it doesn't create
    // a point in State.data.points. Instead, open the destination editor
    // with the current GPS coords prefilled. The user names it, saves,
    // and a new destination is added (becomes active if none was set).
    if (type === 'destination') {
      this.closeAllModals();
      State.captureLocationOverride = null;
      this.openDestEditor(null, {
        lat: +loc.lat.toFixed(5),
        lng: +loc.lng.toFixed(5),
      });
      return;
    }
    // v23.8.0: capture no longer requires an active destination — a
    // captured observation lives in the global pool and is alertable
    // on any trip past the same road segment. destId is still
    // attached as a routeTag when a destination is active, so legacy
    // routePointRefs continue to work for the existing UI.
    State.pendingCapture = {
      id: Utils.uid(),
      type,
      name: Utils.typeLabel(type),
      lat: +loc.lat.toFixed(5),
      lng: +loc.lng.toFixed(5),
      status: 'active',
      confidence: 1,
      destId: State.data.activeDestId || null,
      createdAt: new Date().toISOString(),
    };
    this.closeAllModals();
    // v22.25: pole + spider speed cams also need a side selection
    if (type === 'speed_camera' || type === 'mobile_camera' ||
        type === 'pole_camera'  || type === 'spider_camera') this.openModal('m-side');
    else if (type === 'speed_change') this.openLimitPicker();
    else if (type === 'other') this.openModal('m-other');
    else this.finalizeCapture();
  },

  /** v23.8.6 — unified speed-limit picker. Both entry points (tapping
   *  the LIMIT sign and capturing a Speed zone) open the same modal
   *  with the same behavior:
   *    - sets State.manualLimit so the LIMIT sign updates instantly
   *    - captures a speed_change observation at the current GPS
   *      position (when a fix is available), so the value persists as
   *      road memory for future trips along this segment
   *  The captured speed_change is silenced from NEXT AHEAD by the
   *  v23.8.4 SILENT_ALERT_TYPES filter, so picking a limit never
   *  produces a focused peep / heartbeat / "Speed zone in 500 m" voice.
   *  Without GPS, only the manual override is set — capture needs
   *  coordinates and the existing nearby-merge logic to be safe. */
  openLimitPicker() {
    document.getElementById('limit-title').textContent = 'Speed limit';
    document.getElementById('limit-clear').style.display = 'block';
    const grid = document.getElementById('limit-grid');
    grid.innerHTML = [30,40,50,60,70,80,90,100,110,120,130,140].map(L =>
      `<button class="limit-pick" data-limit="${L}">${L}</button>`
    ).join('');
    grid.querySelectorAll('[data-limit]').forEach(b =>
      b.onclick = () => UI._commitSpeedLimit(+b.dataset.limit)
    );
    document.getElementById('limit-custom').value = '';
    this.openModal('m-limit');
  },

  /** Single commit path for both the preset grid and the custom-value
   *  input. Sets the manual override + captures (when GPS allows). */
  _commitSpeedLimit(val) {
    if (!val || val < 10 || val > 250) {
      Utils.toast('Invalid limit', 'bad');
      return;
    }
    State.manualLimit = val;
    // Seed pendingCapture from the current GPS position if no capture
    // is already in flight (e.g. when the user tapped the LIMIT sign
    // directly, not the Capture → Speed zone menu).
    const loc = State.captureLocationOverride || State.pos;
    if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
      if (!State.pendingCapture) {
        State.pendingCapture = {
          id: Utils.uid(),
          type: 'speed_change',
          name: `Speed → ${val}`,
          lat: +loc.lat.toFixed(5),
          lng: +loc.lng.toFixed(5),
          status: 'active',
          confidence: 1,
          destId: State.data.activeDestId || null,
          createdAt: new Date().toISOString(),
        };
      } else {
        // Capture flow already seeded pendingCapture (e.g. Speed zone
        // from the Capture menu). Reuse it; just stamp the picked value.
        State.pendingCapture.type = 'speed_change';
      }
      State.pendingCapture.limit = val;
      State.pendingCapture.name  = `Speed → ${val}`;
      UI.closeAllModals();
      UI.finalizeCapture(); // toast + voice come from finalizeCapture
    } else {
      // No GPS fix — manual override only, no capture (we need coords
      // to safely de-dup against existing road memory).
      UI.closeAllModals();
      UI.render();
      Utils.toast('Limit set to ' + val + ' (no GPS — not captured)', 'good');
    }
  },

  finalizeCapture() {
    const c = State.pendingCapture;
    if (!c) return;
    // v22.91: auto-fill the v22.91 schema fields for speed_change + cameras.
    // User can edit them via the Edit Point modal afterwards.
    const camTypes = new Set(['speed_camera', 'mobile_camera', 'pole_camera', 'spider_camera']);
    if (c.type === 'speed_change' || camTypes.has(c.type)) {
      // Cameras default directional, speed_change non-directional (per spec)
      c.directional = camTypes.has(c.type);
      c.roadType = Speed.inferRoadTypeFromRollingSpeed(State.avgSpeedKmh());
      c.captureBearing = State.avgHeading();
      c.updatedAt = c.createdAt || new Date().toISOString();
      if (c.type === 'speed_change' && typeof c.limit === 'number') {
        c.speedLimit = c.limit;
      }
      // v23.7.2: observation/confidence fields for fresh speed_change points.
      // Additive — set only when missing so re-captures keep their history.
      if (c.type === 'speed_change') {
        if (c.observationCount  === undefined) c.observationCount  = 1;
        if (c.confirmationCount === undefined) c.confirmationCount = 0;
        if (c.rejectionCount    === undefined) c.rejectionCount    = 0;
        c.lastObservedAt = c.createdAt || new Date().toISOString();
        // Best-effort GPS quality snapshot (purely informational).
        if (c.gpsAccuracy === undefined && State.pos && typeof State.pos.accuracy === 'number') {
          c.gpsAccuracy = State.pos.accuracy;
        }
        if (c.heading === undefined && c.captureBearing != null) {
          c.heading = c.captureBearing;
        }
        c.confidenceStatus = Speed.deriveConfidenceStatus(c);
      }
    }
    // v23.5.1 fix 3: speed_change uses bearing-aware dedup matching the
    // MigrationConfig rules (25m / 25°). Opposite-direction signs and
    // parallel-road signs no longer merge. Other types keep the legacy
    // 100m simple rule — no behavior change for them.
    const isSpeedChange = (c.type === 'speed_change');
    const SPEED_DEDUPE_DIST_M = (typeof MigrationConfig !== 'undefined' && MigrationConfig.DEDUPE_DISTANCE_METERS)
      || 30;
    const SPEED_DEDUPE_BEARING_DEG = (typeof MigrationConfig !== 'undefined' && MigrationConfig.DEDUPE_BEARING_DIFF_DEGREES)
      || 35;

    // v23.8.0: merge across the GLOBAL pool (no destId gate) with a
    // conservative type-aware radius per spec 11 + 12d:
    //   - same canonical type only (never merge different types)
    //   - speed_change: 25m + 25° bearing (existing tight rule)
    //   - other types: 18m default (was 100m — too loose, risked
    //     merging two distinct cameras / signs near each other)
    //   - directional opposite-heading => never merge
    const SAFE_MERGE_RADIUS_M = 18;
    const nearby = State.data.points.find(p => {
      if (p.type !== c.type) return false;
      const distM = Utils.distKm(p, c) * 1000;
      if (isSpeedChange) {
        if (distM > SPEED_DEDUPE_DIST_M) return false;
        // Bearing guard: when both records have a captureBearing, require
        // them to be aligned. Skip when either is missing (legacy data
        // gets the benefit of the doubt).
        if (p.captureBearing != null && c.captureBearing != null) {
          const diff = Speed.angleDiff(p.captureBearing, c.captureBearing);
          if (diff > SPEED_DEDUPE_BEARING_DEG) return false;
        }
        return true;
      }
      if (distM > SAFE_MERGE_RADIUS_M) return false;
      // Directional + opposite-heading => never merge (spec 12d).
      if (p.directional && c.directional) {
        const pb = (p.captureBearing != null) ? p.captureBearing : p.heading;
        const cb = (c.captureBearing != null) ? c.captureBearing : c.heading;
        if (pb != null && cb != null && Speed.angleDiff(pb, cb) > 35) return false;
      }
      return true;
    });

    let announce;
    let trackedId;
    if (nearby) {
      // v23.5.1 fix 2: protect the existing speedLimit when a different
      // value is captured nearby. First different-speed sighting goes to
      // pendingSpeedLimitChange; a SECOND matching different-speed sighting
      // (same bearing-aware dedup as fix 3) promotes the new value AND
      // archives the old into speedHistory[].
      const incomingLimit = (typeof c.limit === 'number') ? c.limit
        : (typeof c.speedLimit === 'number' ? c.speedLimit : null);
      const existingLimit = (typeof nearby.limit === 'number') ? nearby.limit
        : (typeof nearby.speedLimit === 'number' ? nearby.speedLimit : null);
      const differentSpeed = isSpeedChange
        && incomingLimit != null
        && existingLimit != null
        && incomingLimit !== existingLimit;

      if (differentSpeed) {
        const pend = nearby.pendingSpeedLimitChange;
        const pendMatches = pend && pend.newLimit === incomingLimit;
        if (pendMatches) {
          // Promote — preserve old speed in speedHistory[]
          if (!Array.isArray(nearby.speedHistory)) nearby.speedHistory = [];
          nearby.speedHistory.push({
            old: existingLimit,
            new: incomingLimit,
            ts: new Date().toISOString(),
            lat: nearby.lat,
            lng: nearby.lng,
            captureBearing: nearby.captureBearing,
            previousConfidence: nearby.confidence || 1,
          });
          nearby.limit = incomingLimit;
          nearby.speedLimit = incomingLimit;
          if (c.name) nearby.name = c.name;
          nearby.confidence = (nearby.confidence || 1) + 1;
          nearby.updatedAt = new Date().toISOString();
          nearby.status = 'active';
          // v23.7.2: speed value changed => old reading was a rejection,
          // new reading starts a fresh confirmation streak.
          nearby.observationCount  = (nearby.observationCount  || 1) + 1;
          nearby.rejectionCount    = (nearby.rejectionCount    || 0) + 1;
          nearby.confirmationCount = 1;
          nearby.lastObservedAt    = nearby.updatedAt;
          nearby.lastRejectedAt    = nearby.updatedAt;
          delete nearby.pendingSpeedLimitChange;
          nearby.confidenceStatus  = Speed.deriveConfidenceStatus(nearby);
          Utils.toast(`Speed limit updated ${existingLimit}→${incomingLimit}`, 'good');
          announce = `Speed limit updated to ${incomingLimit}`;
          trackedId = nearby.id;
          logEvent('SPEED',
            `[SPEED] different-speed promoted: ${existingLimit}→${incomingLimit} @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)} · history+1 · confidence ${nearby.confidence}`,
            'ok');
        } else {
          // Record the pending change without touching the active value.
          nearby.pendingSpeedLimitChange = {
            newLimit: incomingLimit,
            observedAt: new Date().toISOString(),
            lat: c.lat,
            lng: c.lng,
            captureBearing: c.captureBearing,
            confidence: 1,
          };
          // v23.7.2: a conflicting reading still counts as an observation
          // and tips the status to 'disputed' while pending.
          nearby.observationCount = (nearby.observationCount || 1) + 1;
          nearby.lastObservedAt   = new Date().toISOString();
          nearby.confidenceStatus = Speed.deriveConfidenceStatus(nearby);
          Utils.toast(`Speed change pending: ${existingLimit}→${incomingLimit} · capture again to confirm`, 'good');
          announce = `Pending speed change to ${incomingLimit}`;
          trackedId = nearby.id;
          logEvent('SPEED',
            `[SPEED] different-speed pending: ${existingLimit}→${incomingLimit} @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)} (awaiting confirmation)`,
            'ok');
        }
      } else {
        // Same speed (or non-speed-change): legacy merge + confidence bump.
        const n = (nearby.confidence || 0) + 1;
        nearby.lat = +((nearby.lat * (n - 1) + c.lat) / n).toFixed(5);
        nearby.lng = +((nearby.lng * (n - 1) + c.lng) / n).toFixed(5);
        nearby.confidence = n;
        nearby.status = 'active';
        nearby.updatedAt = new Date().toISOString();
        if (c.side) nearby.side = c.side;
        if (c.limit) { nearby.limit = c.limit; nearby.name = c.name; }
        // v23.7.2: same-speed re-capture is a confirmation observation.
        if (isSpeedChange) {
          nearby.observationCount  = (nearby.observationCount  || 1) + 1;
          nearby.confirmationCount = (nearby.confirmationCount || 0) + 1;
          nearby.lastObservedAt    = nearby.updatedAt;
          nearby.lastConfirmedAt   = nearby.updatedAt;
          nearby.confidenceStatus  = Speed.deriveConfidenceStatus(nearby);
        }
        // v23.8.0: mirror confirmation counters on every type so the
        // global observation pool surfaces re-confirmations through the
        // spec's confirmedCount + lastConfirmedAt + lastSeenAt fields.
        nearby.confirmedCount  = (nearby.confirmedCount  || 0) + 1;
        nearby.lastConfirmedAt = nearby.updatedAt;
        nearby.lastSeenAt      = nearby.updatedAt;
        // Preserve the stronger heading evidence: if the new capture
        // brought a heading and the existing record had none, adopt it.
        if (nearby.heading == null && c.captureBearing != null) {
          nearby.heading = c.captureBearing;
        }
        // If a directional capture confirms a previously-bidirectional
        // legacy record with the same bearing, clear the bidirectional
        // flag so direction filtering can now apply. Conservative:
        // only flip when both sides agree on direction.
        if (c.directional && nearby.bidirectional === true
            && nearby.captureBearing != null && c.captureBearing != null
            && Speed.angleDiff(nearby.captureBearing, c.captureBearing) < 25) {
          nearby.bidirectional = false;
          nearby.directional = true;
        }
        // Same-speed re-confirmation discards any stale pendingSpeedLimitChange
        // that targeted a different value — the driver just re-confirmed the
        // existing reading.
        if (isSpeedChange && nearby.pendingSpeedLimitChange
            && nearby.pendingSpeedLimitChange.newLimit !== existingLimit) {
          delete nearby.pendingSpeedLimitChange;
        }
        Utils.toast(`${Utils.typeLabel(c.type)} merged (×${n})`, 'good');
        announce = Utils.typeLabel(c.type) + ' updated';
        trackedId = nearby.id;
        if (isSpeedChange) {
          logEvent('SPEED',
            `[SPEED] same-speed confidence increased to ${n} @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)} (limit ${existingLimit != null ? existingLimit : 'unset'})`,
            'ok');
        }
        logEvent('CAPTURE', `${Utils.typeLabel(c.type)} merged (×${n}) @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)}`, 'ok');
      }
    } else {
      // v23.8.0: seed additive observation fields on the fresh point
      // so it shows up consistently in the global pool view. Additive
      // ONLY — never overwrites anything set earlier in finalizeCapture.
      if (c.confirmedCount  === undefined) c.confirmedCount  = 0;
      if (c.firstSeenAt     === undefined) c.firstSeenAt     = c.createdAt || new Date().toISOString();
      if (c.lastSeenAt      === undefined) c.lastSeenAt      = c.firstSeenAt;
      if (c.lastConfirmedAt === undefined) c.lastConfirmedAt = null;
      if (c.heading         === undefined) c.heading         = (typeof c.captureBearing === 'number') ? c.captureBearing : null;
      if (c.directional     === undefined) c.directional     = false;
      if (c.bidirectional   === undefined) c.bidirectional   = (c.heading == null);
      if (c.source          === undefined) c.source          = 'capture';
      if (c.routeTags       === undefined) c.routeTags       = c.destId ? [c.destId] : [];
      if (c.roadName        === undefined) c.roadName        = null;
      // v22.101: route via State.addPointToActiveDest so the new id is
      // appended to dest.routePointRefs[] post-migration. Direct
      // State.data.points.push left captures invisible to activePoints().
      State.addPointToActiveDest(c);
      Utils.toast(`${Utils.typeLabel(c.type)} saved`, 'good');
      announce = Utils.typeLabel(c.type) + ' captured';
      trackedId = c.id;
      logEvent('CAPTURE', `${Utils.typeLabel(c.type)} @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)}`, 'ok');
      if (isSpeedChange) {
        const ll = (typeof c.limit === 'number') ? c.limit
          : (typeof c.speedLimit === 'number' ? c.speedLimit : null);
        logEvent('SPEED',
          `[SPEED] speed_change captured: limit=${ll != null ? ll : 'unset'} @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)} bearing=${c.captureBearing != null ? Math.round(c.captureBearing) : '—'}°`,
          'ok');
      }
    }
    State.lastTripCaptureId = trackedId; // v22.10: track for double-tap recall
    State.pendingCapture = null;
    State.captureLocationOverride = null; // v22.39: clear map-tap override
    State.saveData();
    // v23.5 Phase 4: audit trail — note when capture happens while
    // network is degraded/offline. Local save already succeeded above;
    // remote backup will queue via tryAuto's next tick.
    try {
      const ns = NetworkMonitor.getStatus();
      if (ns.state !== 'online' || ns.backupPending) {
        logEvent('OFFLINE-CAPTURE',
          `[OFFLINE-CAPTURE] saved locally · network=${ns.state}` +
          (ns.backupPending ? ' · backup queued' : ''),
          'ok');
      }
    } catch (e) {}
    // v22.9: force immediate map refresh (bypass the 5s throttle)
    if (MapView.m) {
      MapView._lastPointRefresh = Date.now();
      MapView.updatePoints();
    }
    if (navigator.vibrate) navigator.vibrate(40);
    // v22.9: tone confirmation + voice announcement
    if (State.settings.sound !== 'off') Audio.beep(c.type);
    if (State.settings.voiceGender !== 'none') {
      setTimeout(() => Audio.say(announce), 300);
    }
  },

  openPointEditor(id) {
    const p = State.data.points.find(x => x.id === id);
    if (!p) return;
    State.editingPointId = id;
    document.getElementById('e-name').value = p.name;
    document.getElementById('e-type').value = p.type;
    document.getElementById('e-limit').value = p.limit || '';
    document.getElementById('e-lat').value = p.lat;
    document.getElementById('e-lng').value = p.lng;
    document.querySelectorAll('#e-side-opts button').forEach(b =>
      b.classList.toggle('active', b.dataset.side === (p.side || '')));
    document.querySelectorAll('#e-status-opts button').forEach(b =>
      b.classList.toggle('active', b.dataset.status === (p.status || 'active')));
    // v22.91: load directional / roadType / captureBearing into the new rows
    const t = document.getElementById('t-directional');
    if (t) t.classList.toggle('on', !!p.directional);
    document.querySelectorAll('#e-roadtype-opts button').forEach(b =>
      b.classList.toggle('active', b.dataset.roadtype === (p.roadType || 'unknown')));
    const cbEl = document.getElementById('e-capbearing-val');
    if (cbEl) cbEl.textContent = (typeof p.captureBearing === 'number') ? p.captureBearing.toFixed(0) + '°' : '—';
    // v23.6.8: populate the Sound-alert dropdown with the sound
    // currently mapped to this point's type.
    this.renderEditPointSoundAlert(p.type);
    // v23.7.3: paint the per-type heartbeat toggle from settings.
    this.refreshHeartbeatToggle(p.type);
    // v23.7.1: paint the missed-feedback count chip.
    this.refreshMissedFeedbackCount(p.id);
    this.togglePEFields();
    this.openModal('m-edit');
  },

  /** v23.7.3 — paint the heartbeat toggle for a given point type.
   *  Default ON when no entry exists (preserves prior global behavior). */
  refreshHeartbeatToggle(type) {
    const btn = document.getElementById('t-heartbeat');
    if (!btn) return;
    const map = (State.settings && State.settings.heartbeatByType) || {};
    const on = (map[type] !== false);
    btn.classList.toggle('on', on);
  },

  /** v23.7.1 — paint "Missed Feedback N" on the Edit Point chip from
   *  point.feedback.missed[]. Always visible (0 / 1 / N), per spec. */
  refreshMissedFeedbackCount(pointId) {
    const id = pointId || State.editingPointId;
    if (!id) return;
    const p = State.data.points.find(x => x.id === id);
    if (!p) return;
    const count = (typeof Confirm !== 'undefined' && typeof Confirm._countUnresolvedMissed === 'function')
      ? Confirm._countUnresolvedMissed(p)
      : 0;
    const span = document.getElementById('e-missed-count');
    const btn = document.getElementById('e-missed-btn');
    if (span) span.textContent = String(count);
    if (btn) {
      btn.classList.toggle('has-missed', count > 0);
      btn.style.background = (count > 0) ? 'rgba(245,158,11,0.18)' : '';
      btn.style.borderColor = (count > 0) ? 'var(--amber-2)' : '';
      btn.style.color = (count > 0) ? 'var(--amber-2)' : 'var(--ink-3)';
    }
  },

  /** v23.6.8 — find which SoundCatalogue sound is currently mapped
   *  to a given point type. Reads State.settings.soundAlerts; falls
   *  back to each sound's defaultUsedFor when no saved entry exists.
   *  Returns the soundId (string) or '' when no sound is mapped. */
  findSoundForType(type) {
    if (!type || typeof SoundCatalogue === 'undefined') return '';
    const saved = (State.settings && State.settings.soundAlerts) || {};
    for (const s of SoundCatalogue) {
      const entry = saved[s.id] || {};
      const usedRaw = entry.usedFor || s.defaultUsedFor || 'none';
      const used = (typeof migrateSoundUsedFor === 'function')
        ? migrateSoundUsedFor(usedRaw)
        : usedRaw;
      if (used === type) return s.id;
    }
    return '';
  },

  /** v23.6.8 — paint the Edit-Point sound-alert dropdown. Lists "(none)"
   *  + all 18 catalogue sounds. The current mapping for `type` is
   *  preselected so the user sees which sound this point's group plays. */
  renderEditPointSoundAlert(type) {
    const sel = document.getElementById('e-soundalert');
    const hint = document.getElementById('e-soundalert-hint');
    if (!sel) return;
    const catalogue = (typeof SoundCatalogue !== 'undefined' && Array.isArray(SoundCatalogue))
      ? SoundCatalogue : [];
    const current = this.findSoundForType(type);
    const opts = ['<option value="">— (no sound)</option>'];
    for (const s of catalogue) {
      const safeId = Utils.escapeHtml(s.id);
      const safeLabel = Utils.escapeHtml(s.label || s.id);
      opts.push(`<option value="${safeId}"${s.id === current ? ' selected' : ''}>${safeLabel}</option>`);
    }
    sel.innerHTML = opts.join('');
    if (hint) {
      const typeLabel = (Utils.typeLabel && type) ? Utils.typeLabel(type) : type;
      const note = current
        ? `Type <strong>${Utils.escapeHtml(typeLabel)}</strong> → currently plays <strong>${Utils.escapeHtml((catalogue.find(s => s.id === current) || {}).label || current)}</strong>. Change above to remap.`
        : `Type <strong>${Utils.escapeHtml(typeLabel)}</strong> has no sound assigned. Pick one above to map.`;
      hint.innerHTML = note + ' Manage the full catalogue in Settings → Sound Alerts.';
    }
  },

  /** v23.6.8 — assign `soundId` (or '' for "none") to alert-group
   *  `type` by setting that sound's usedFor = type. Any OTHER sounds
   *  previously mapped to this type are cleared (set to usedFor:
   *  'none') so only one sound is mapped per type at a time. */
  assignSoundToType(soundId, type) {
    if (!type) return;
    if (!State.settings.soundAlerts || typeof State.settings.soundAlerts !== 'object') {
      State.settings.soundAlerts = {};
    }
    const saved = State.settings.soundAlerts;
    const catalogue = (typeof SoundCatalogue !== 'undefined' && Array.isArray(SoundCatalogue))
      ? SoundCatalogue : [];
    // 1. Clear any existing mapping of this type (only one sound per type)
    for (const s of catalogue) {
      const entry = saved[s.id] || {};
      const usedRaw = entry.usedFor || s.defaultUsedFor || 'none';
      const used = (typeof migrateSoundUsedFor === 'function') ? migrateSoundUsedFor(usedRaw) : usedRaw;
      if (used === type && s.id !== soundId) {
        saved[s.id] = Object.assign({}, entry, { usedFor: 'none' });
      }
    }
    // 2. Set the new mapping (if any)
    if (soundId) {
      saved[soundId] = Object.assign({}, saved[soundId] || {}, { usedFor: type });
    }
    State.saveSettings();
    try { logEvent('SOUND', `[SOUND] mapped ${soundId || '(none)'} → ${type} via Edit Point`, 'ok'); } catch (e) {}
  },

  togglePEFields() {
    const t = document.getElementById('e-type').value;
    const isSpeedChange = t === 'speed_change';
    const isCamera = t === 'speed_camera' || t === 'mobile_camera' ||
                     t === 'pole_camera' || t === 'spider_camera';
    document.getElementById('e-limit-row').style.display = isSpeedChange ? 'flex' : 'none';
    document.getElementById('e-side-row').style.display  = isCamera ? 'flex' : 'none';
    // v22.91: directional + roadType + captureBearing rows are relevant
    // for speed_change AND any camera (any 'speed-related' point).
    const speedish = isSpeedChange || isCamera;
    const rows = ['e-directional-row', 'e-roadtype-row', 'e-capbearing-row'];
    rows.forEach(rid => {
      const el = document.getElementById(rid);
      if (el) el.style.display = speedish ? 'flex' : 'none';
    });
  },

  savePoint() {
    const p = State.data.points.find(x => x.id === State.editingPointId);
    if (!p) { this.closeAllModals(); return; }
    p.name = document.getElementById('e-name').value.trim() || p.name;
    p.type = document.getElementById('e-type').value;
    p.lat = +document.getElementById('e-lat').value || p.lat;
    p.lng = +document.getElementById('e-lng').value || p.lng;
    const lim = document.getElementById('e-limit').value;
    const prevLimit = (typeof p.limit === 'number') ? p.limit
      : (typeof p.speedLimit === 'number' ? p.speedLimit : null);
    if (lim && p.type === 'speed_change') { p.limit = +lim; p.speedLimit = +lim; }
    else { delete p.limit; delete p.speedLimit; }
    // v23.7.2: manual edit updates the observation record. Same value =>
    // explicit confirmation; different value => rejection of the old reading.
    if (p.type === 'speed_change') {
      const newLimit = (typeof p.limit === 'number') ? p.limit : null;
      const now = new Date().toISOString();
      p.observationCount = (p.observationCount || 1) + 1;
      if (newLimit != null && prevLimit != null && newLimit !== prevLimit) {
        p.rejectionCount  = (p.rejectionCount  || 0) + 1;
        p.lastRejectedAt  = now;
        p.confirmationCount = 1; // reset streak around the new value
      } else if (newLimit != null) {
        p.confirmationCount = (p.confirmationCount || 0) + 1;
        p.lastConfirmedAt   = now;
      }
      p.lastObservedAt    = now;
      p.confidenceStatus  = Speed.deriveConfidenceStatus(p);
    }
    const sideBtn = document.querySelector('#e-side-opts button.active');
    if (sideBtn) { if (sideBtn.dataset.side) p.side = sideBtn.dataset.side; else delete p.side; }
    const statBtn = document.querySelector('#e-status-opts button.active');
    if (statBtn) p.status = statBtn.dataset.status;
    // v22.91: directional + roadType (captureBearing is read-only; clear via dedicated button)
    const td = document.getElementById('t-directional');
    p.directional = !!(td && td.classList.contains('on'));
    const rtBtn = document.querySelector('#e-roadtype-opts button.active');
    p.roadType = rtBtn ? rtBtn.dataset.roadtype : (p.roadType || 'unknown');
    p.updatedAt = new Date().toISOString();
    State.saveData();
    Utils.toast('Saved', 'good');
    this.closeAllModals();
  },

  /** v22.74: in-app confirm + explicit force-refresh of map + sidebar.
   *  Previous version used native window.confirm() which Safari/iOS can
   *  silently block, making Delete look broken. */
  async deletePoint() {
    const id = State.editingPointId;
    if (!id) { Utils.toast('No point selected', 'bad'); return; }
    const p = State.data.points.find(x => x.id === id);
    const label = p ? (p.name || Utils.typeLabel(p.type)) : 'point';
    const ok = await UI.confirm(`Delete ${label}?`, { title: 'Delete point' });
    if (!ok) return;
    State.removePointById(id);
    State.alertedMarkers.delete(id);
    State.lastDistByPoint.delete(id);
    State.passedPoints.delete(id);
    State.editingPointId = null;
    State.saveData();
    this.closeAllModals();
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
    this.renderTimeline();
    Utils.toast(`Deleted ${label}`, 'good');
  },

  renderRoutesList() {
    const list = document.getElementById('routes-list');
    if (!State.data.destinations.length) {
      list.innerHTML = '<div class="empty">No destinations. Tap + to add.</div>';
      return;
    }
    list.innerHTML = State.data.destinations.map(d => {
      const isActive = d.id === State.data.activeDestId;
      // v22.104: post-migration destinations carry routePointRefs[]; use it
      // when present so the displayed count reflects the global-store model.
      const ptCount = Array.isArray(d.routePointRefs)
        ? d.routePointRefs.length
        : State.data.points.filter(p => p.destId === d.id).length;
      return `
        <div class="list-row">
          <div class="em">📍</div>
          <div class="info">
            <div class="name">${Utils.escapeHtml(d.name)}</div>
            <div class="meta">${d.lat.toFixed(4)}, ${d.lng.toFixed(4)} · ${ptCount} pts</div>
          </div>
          <button class="row-btn ${isActive ? 'active keep' : ''}" data-activate="${Utils.escapeHtml(d.id)}" title="Set active">✓</button>
          <button class="row-btn" data-edit-dest="${Utils.escapeHtml(d.id)}" title="Edit">✎</button>
        </div>
      `;
    }).join('');
    list.querySelectorAll('[data-activate]').forEach(b =>
      b.onclick = () => {
        State.data.activeDestId = b.dataset.activate;
        // Reset alert state when switching
        State.alertedMarkers.clear();
        State.lastDistByPoint.clear();
        State.minDistByPoint.clear(); // v22.15
        State.passedPoints.clear();
        State.passedDistByPoint.clear(); // v23.8.7: re-approach tracker
        State.autoAnnouncedAhead.clear(); // v22.16: re-announce nearest for new route
        State.saveData();
        this.renderRoutesList();
        MapView.updatePoints();
        // v22.58: clear the old route line; next GPS tick will refetch for the new destination
        MapView.clearRoute();
        Utils.toast('Destination set', 'good');
      }
    );
    list.querySelectorAll('[data-edit-dest]').forEach(b =>
      b.onclick = () => this.openDestEditor(b.dataset.editDest)
    );
  },

  openDestEditor(id, prefilledCoords) {
    State.editingDestId = id;
    const d = id ? State.data.destinations.find(x => x.id === id) : null;
    document.getElementById('re-title').textContent = d ? 'Edit destination' : 'Add destination';
    document.getElementById('re-name').value = d ? d.name : '';
    // v22.73: prefilledCoords WIN over the stored dest coords. Previous
    // logic ignored picked-map coords when editing an existing dest, so
    // "edit dest, pick new map location" silently kept the old coords.
    document.getElementById('re-lat').value = prefilledCoords ? prefilledCoords.lat : (d ? d.lat : '');
    document.getElementById('re-lng').value = prefilledCoords ? prefilledCoords.lng : (d ? d.lng : '');
    document.getElementById('re-delete').style.display = d ? 'block' : 'none';

    const dis = document.getElementById('re-coords-display');
    if (prefilledCoords) {
      dis.style.display = 'flex';
      dis.textContent = `Coords: ${prefilledCoords.lat}, ${prefilledCoords.lng}`;
      this.setRouteTab('latlng');
    } else if (d) {
      dis.style.display = 'flex';
      dis.textContent = `Current: ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`;
      this.setRouteTab('latlng');
    } else {
      dis.style.display = 'none';
      this.setRouteTab('here');
    }
    // v22.72: refresh the "From points" list each time the editor opens.
    this.renderFromPointsList();
    document.getElementById('m-routes').classList.remove('open');
    this.openModal('m-route-edit');
  },

  /** v22.72: render the captured-points list inside the "From points" tab
   *  of the destination editor. Tapping a row fills the lat/lng fields
   *  with that point's coords and switches the editor to the Lat/Lng tab. */
  renderFromPointsList() {
    const list = document.getElementById('re-from-points');
    if (!list) return;
    const pts = State.data.points
      .filter(p => p.status !== 'no')
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (!pts.length) {
      list.innerHTML = '<div class="empty">No captured points yet.</div>';
      return;
    }
    list.innerHTML = pts.map(p => `
      <div class="list-row" data-from-pt="${Utils.escapeHtml(p.id)}" style="cursor:pointer;">
        <div class="em">${Utils.emoji(p.type, p.subtype)}</div>
        <div class="info">
          <div class="name">${Utils.escapeHtml(p.name)}</div>
          <div class="meta">${Utils.escapeHtml(Utils.typeLabel(p.type))} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-from-pt]').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.fromPt;
        const p = State.data.points.find(x => x.id === id);
        if (!p) return;
        document.getElementById('re-lat').value = p.lat;
        document.getElementById('re-lng').value = p.lng;
        const dis = document.getElementById('re-coords-display');
        if (dis) {
          dis.style.display = 'flex';
          dis.textContent = `Coords: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (from ${p.name})`;
        }
        UI.setRouteTab('latlng');
        Utils.toast(`Coords from ${p.name}`, 'good');
      };
    });
  },

  setRouteTab(name) {
    document.querySelectorAll('[data-retab]').forEach(b =>
      b.classList.toggle('active', b.dataset.retab === name));
    document.querySelectorAll('[data-pane]').forEach(p =>
      p.style.display = p.dataset.pane === name ? 'block' : 'none');
  },

  saveDest() {
    const name = document.getElementById('re-name').value.trim();
    if (!name) { Utils.toast('Enter a name', 'bad'); return; }
    let lat = +document.getElementById('re-lat').value;
    let lng = +document.getElementById('re-lng').value;
    const activeTab = document.querySelector('[data-retab].active');
    if (activeTab && activeTab.dataset.retab === 'here') {
      if (!State.pos) { Utils.toast('No GPS — start GPS first or use another tab', 'bad'); return; }
      lat = +State.pos.lat.toFixed(5);
      lng = +State.pos.lng.toFixed(5);
    }
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) { Utils.toast('Invalid coordinates', 'bad'); return; }

    if (State.editingDestId) {
      const d = State.data.destinations.find(x => x.id === State.editingDestId);
      if (d) { d.name = name; d.lat = lat; d.lng = lng; }
    } else {
      const newId = Utils.uid();
      State.data.destinations.push({ id: newId, name, lat, lng });
      if (!State.data.activeDestId) State.data.activeDestId = newId;
    }
    State.saveData();
    this.closeAllModals();
    MapView.updatePoints();
    Utils.toast('Destination saved', 'good');
  },

  /** v22.94: was using window.confirm() which Safari silently blocks
   *  on some installs — same failure mode as the v22.74 point-delete
   *  bug. Now uses the in-app UI.confirm modal and emits DEST log
   *  entries to the debug panel for every code path. */
  async deleteDest() {
    if (!State.editingDestId) {
      logEvent('DEST', 'delete aborted — no editingDestId set', 'err');
      return;
    }
    const id = State.editingDestId;
    const dest = State.data.destinations.find(d => d.id === id);
    const name = dest ? dest.name : '(unknown)';
    const ptCount = State.data.points.filter(p => p.destId === id).length;
    logEvent('DEST', `delete prompt: "${name}" (${ptCount} points tagged)`);
    const ok = await UI.confirm(
      `Delete "${name}"?` + (ptCount > 0 ? `\n\n${ptCount} captured points are tagged to this destination. They stay in the global observation pool and remain alertable on every trip past the same road.` : ''),
      { title: 'Delete destination' }
    );
    if (!ok) {
      logEvent('DEST', 'delete cancelled by user');
      return;
    }
    try {
      const before = State.data.destinations.length;
      State.data.destinations = State.data.destinations.filter(d => d.id !== id);
      const after = State.data.destinations.length;
      if (before === after) {
        logEvent('DEST', `delete no-op: id "${id}" not found in destinations array`, 'err');
        Utils.toast('Delete failed — id not found', 'bad');
        return;
      }
      if (State.data.activeDestId === id) {
        const next = State.data.destinations[0] && State.data.destinations[0].id || null;
        State.data.activeDestId = next;
        logEvent('DEST', `active destination was deleted — switched to "${next || 'none'}"`);
      }
      State.editingDestId = null;
      State.saveData();
      this.closeAllModals();
      if (MapView && MapView.updatePoints) MapView.updatePoints();
      Utils.toast(`Deleted "${name}"`, 'good');
      logEvent('DEST', `delete ok: "${name}" (${before} → ${after} destinations)`, 'ok');
    } catch (e) {
      Utils.toast('Delete error: ' + (e && e.message || e), 'bad');
      logEvent('DEST', 'delete exception: ' + (e && e.message || e), 'err');
    }
  },

  renderAuditList() {
    const list = document.getElementById('audit-list');
    // v23.8.0: audit covers the global pool so points captured under
    // any past destination remain reachable for review/cleanup.
    const pts = State.data.points.filter(p =>
      p && typeof p.lat === 'number' && typeof p.lng === 'number'
    );
    document.getElementById('audit-count').textContent = pts.length;
    if (!pts.length) {
      list.innerHTML = '<div class="empty">No points to audit.</div>';
      return;
    }
    const sorted = pts.slice().sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
    list.innerHTML = sorted.map(p => `
      <div class="list-row ${p.status === 'no' ? 'disabled' : ''}">
        <div class="em">${Utils.emoji(p.type, p.subtype)}</div>
        <div class="info">
          <div class="name">${Utils.escapeHtml(p.name)}</div>
          <div class="meta">${Utils.escapeHtml(Utils.typeLabel(p.type))}${p.side ? ' · ' + Utils.escapeHtml(p.side) : ''}${p.limit ? ' · ' + Utils.escapeHtml(String(p.limit)) + ' km/h' : ''}</div>
        </div>
        <button class="row-btn keep ${p.status === 'active' ? 'active' : ''}" data-keep="${Utils.escapeHtml(p.id)}">✓</button>
        <button class="row-btn del ${p.status === 'no' ? 'active' : ''}" data-rem="${Utils.escapeHtml(p.id)}">✕</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-keep]').forEach(b =>
      b.onclick = () => {
        const p = State.data.points.find(x => x.id === b.dataset.keep);
        if (!p) return;
        p.status = 'active';
        p.confidence = (p.confidence || 0) + 1;
        State.saveData();
        this.renderAuditList();
      }
    );
    list.querySelectorAll('[data-rem]').forEach(b =>
      b.onclick = async () => {
        // v22.104: native confirm() is silently blocked on iOS Safari.
        const ok = await UI.confirm('Delete this point?', { title: 'Delete point' });
        if (!ok) return;
        State.removePointById(b.dataset.rem);
        State.saveData();
        this.renderAuditList();
      }
    );
  },

  renderDisabledList() {
    const list = document.getElementById('disabled-list');
    const pts = State.data.points.filter(p => p.status === 'no');
    if (!pts.length) {
      list.innerHTML = '<div class="empty">No disabled points.</div>';
      return;
    }
    list.innerHTML = pts.map(p => `
      <div class="list-row disabled">
        <div class="em">${Utils.emoji(p.type, p.subtype)}</div>
        <div class="info">
          <div class="name">${Utils.escapeHtml(p.name)}</div>
          <div class="meta">${Utils.escapeHtml(Utils.typeLabel(p.type))} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</div>
        </div>
        <button class="row-btn keep" data-reactivate="${Utils.escapeHtml(p.id)}">↺</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-reactivate]').forEach(b =>
      b.onclick = () => {
        const p = State.data.points.find(x => x.id === b.dataset.reactivate);
        if (p) { p.status = 'active'; State.saveData(); this.renderDisabledList(); Utils.toast('Reactivated', 'good'); }
      }
    );
  },

  renderTripsList() {
    const list = document.getElementById('trips-list');
    if (!State.trips.length) {
      list.innerHTML = '<div class="empty">No trips yet.</div>';
      return;
    }
    list.innerHTML = State.trips.map((t, i) => {
      const start = new Date(t.startedAt);
      const end = t.endedAt ? new Date(t.endedAt) : null;
      const min = end ? Math.round((end - start) / 60000) : 0;
      return `
        <div class="list-row">
          <div class="em">🚗</div>
          <div class="info">
            <div class="name">${start.toLocaleString()}</div>
            <div class="meta">${(t.distanceKm || 0).toFixed(1)} km · ${min} min · max ${Math.round(t.maxSpeed || 0)} km/h</div>
          </div>
          <button class="row-btn del" data-trip-del="${i}">✕</button>
        </div>
      `;
    }).join('');
    list.querySelectorAll('[data-trip-del]').forEach(b =>
      b.onclick = async () => {
        // v22.104: native confirm() blocked on iOS Safari → in-app modal.
        const ok = await UI.confirm('Delete trip?', { title: 'Delete trip' });
        if (!ok) return;
        State.trips.splice(+b.dataset.tripDel, 1);
        State.saveTrips();
        this.renderTripsList();
      }
    );
  },

  toggleTrip() {
    if (State.activeTrip) {
      State.activeTrip.endedAt = new Date().toISOString();
      State.trips.unshift(State.activeTrip);
      State.saveTrips();
      Utils.toast(`Trip saved · ${State.activeTrip.distanceKm.toFixed(1)} km`, 'good');
      State.activeTrip = null;
    } else {
      State.activeTrip = {
        id: Utils.uid(),
        startedAt: new Date().toISOString(),
        destId: State.data.activeDestId,
        distanceKm: 0,
        maxSpeed: 0,
      };
      Utils.toast('Trip started', 'good');
    }
    this.updateTripButton();
  },

  updateTripButton() {
    const btn = document.getElementById('trip-toggle');
    if (!btn) return;
    if (State.activeTrip) { btn.textContent = '■ End trip'; btn.style.background = 'var(--red)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--red)'; }
    else { btn.textContent = '▶ Start trip'; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }
  },

  /** v23.8.1 — Collapsible Settings sections.
   *  Wraps every `.section-title` inside `#m-settings .modal-card` in a
   *  tappable header + a hideable body. UI-only: no settings values
   *  change, no event listeners on existing controls are touched. The
   *  bodies use `hidden` (display:none) when collapsed — lightweight,
   *  no animation, predictable. Idempotent: re-running the installer
   *  is a no-op once `_settingsCollapsibleInstalled` is set.
   *
   *  Persistence: `roadAlert.settingsCollapsedSections` →
   *  { [slug]: collapsed_bool }. Default state is hard-coded so the
   *  first practical section (Display) is expanded and every other
   *  large/technical section is collapsed; the stored value overrides
   *  the default only when the user has explicitly toggled. */
  COLLAPSIBLE_STATE_KEY: 'roadAlert.settingsCollapsedSections',

  // Sections that should start expanded out of the box. Every other
  // labelled section collapses by default. The user's choice (kept in
  // localStorage) overrides this on subsequent opens.
  _SETTINGS_DEFAULT_EXPANDED: new Set(['display']),

  _settingsSectionSlug(label) {
    return String(label || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  installCollapsibleSettings() {
    const card = document.querySelector('#m-settings .modal-card');
    if (!card || card._settingsCollapsibleInstalled) return;
    card._settingsCollapsibleInstalled = true;

    // Restore persisted collapsed-state map. Safe to fail — fall back
    // to defaults if the value is missing / unparseable.
    let stored = {};
    try {
      const raw = localStorage.getItem(this.COLLAPSIBLE_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') stored = parsed;
      }
    } catch (e) { stored = {}; }

    const persist = () => {
      try { localStorage.setItem(this.COLLAPSIBLE_STATE_KEY, JSON.stringify(stored)); }
      catch (e) { /* quota / private-mode — fail silently */ }
    };

    // Gather titles in document order from the direct modal-card children.
    const titles = Array.from(card.children).filter(el => el.classList && el.classList.contains('section-title'));
    titles.forEach(title => {
      const labelText = (title.textContent || '').trim();
      if (!labelText) return; // skip the empty spacer before the bottom "Done" button
      const slug = UI._settingsSectionSlug(labelText);

      // Build the new header. A real <button> keeps it keyboard-accessible
      // and large-tap-target on mobile without extra ARIA work.
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'settings-section-head';
      head.dataset.section = slug;
      head.setAttribute('aria-expanded', 'false');
      head.innerHTML =
        '<span class="settings-section-chev" aria-hidden="true">▸</span>' +
        '<span class="settings-section-title-text"></span>';
      head.querySelector('.settings-section-title-text').textContent = labelText;

      // Wrap subsequent siblings until the next section-title into a body.
      const body = document.createElement('div');
      body.className = 'settings-section-body';
      body.dataset.section = slug;
      const toMove = [];
      let cur = title.nextElementSibling;
      while (cur && !(cur.classList && cur.classList.contains('section-title'))) {
        toMove.push(cur);
        cur = cur.nextElementSibling;
      }
      title.replaceWith(head);
      head.insertAdjacentElement('afterend', body);
      toMove.forEach(el => body.appendChild(el));

      // Initial collapsed state: stored value wins; otherwise default
      // is "collapsed unless in _SETTINGS_DEFAULT_EXPANDED".
      let collapsed;
      if (Object.prototype.hasOwnProperty.call(stored, slug)) {
        collapsed = !!stored[slug];
      } else {
        collapsed = !this._SETTINGS_DEFAULT_EXPANDED.has(slug);
      }
      this._setSettingsSectionCollapsed(head, body, collapsed);

      head.addEventListener('click', () => {
        const wasCollapsed = head.getAttribute('aria-expanded') === 'false';
        this._setSettingsSectionCollapsed(head, body, !wasCollapsed);
        stored[slug] = !wasCollapsed;
        persist();
      });
    });
  },

  _setSettingsSectionCollapsed(head, body, collapsed) {
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    head.classList.toggle('collapsed', collapsed);
    body.classList.toggle('collapsed', collapsed);
    // Use the `hidden` attribute so the section is removed from
    // accessibility tree + layout entirely. Existing event listeners
    // and element references are preserved — the controls just aren't
    // visible until expanded.
    body.hidden = !!collapsed;
  },

  syncSettings() {
    // v23.6.4: render the Sound Alerts table from the syncSettings path
    // too. Wire() also calls it on the settings click, but having it
    // here means even a cached-JS / cache-mismatch scenario (where
    // wire's click handler is stale) still populates the inline table
    // through this path. Defensive against future timing bugs.
    try { this.renderSoundAlerts(); } catch (e) {
      try { logEvent('SOUND', '[SOUND] render via syncSettings threw: ' + (e && e.message || e), 'err'); } catch (err) {}
    }
    // v22.26: scope to settings buttons only — bare [data-theme] also matches <body>
    document.querySelectorAll('#theme-opts [data-theme]').forEach(b =>
      b.classList.toggle('active', b.dataset.theme === State.settings.theme));
    document.querySelectorAll('[data-sound]').forEach(b =>
      b.classList.toggle('active', b.dataset.sound === State.settings.sound));
    // v23.3.x Phase 3: alert engine mode (legacy / shadow / active).
    const intelMode = State.settings.intelMode || 'legacy';
    document.querySelectorAll('[data-intel-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.intelMode === intelMode));
    UI.applyIntelIndicator(); // v23.4.1: paint chip + rollback-row visibility
    document.querySelectorAll('[data-voice]').forEach(b =>
      b.classList.toggle('active', b.dataset.voice === State.settings.voiceGender));
    document.getElementById('t-side').classList.toggle('on', State.settings.announceSide);
    document.getElementById('t-autobackup').classList.toggle('on', State.settings.autoBackup);
    // v22.83: compass show/hide toggle reflects the saved setting
    const tCompass = document.getElementById('t-compass');
    if (tCompass) tCompass.classList.toggle('on', State.settings.showCompass !== false);
    // v23.0.1: hints visibility toggle + body attribute sync
    const tHints = document.getElementById('t-hints');
    if (tHints) tHints.classList.toggle('on', State.settings.showHints !== false);
    UI.applyHintsVisibility();
    document.getElementById('markers-chips') && UI.renderMarkerChips();
    document.getElementById('i-over').value = State.settings.overBy;
    // v22.6: new alert settings
    document.getElementById('i-flash').value = State.settings.flashStartM;
    document.getElementById('i-repeat').value = State.settings.alertRepeatCount;
    document.getElementById('i-repeatgap').value = State.settings.alertRepeatGapS;
    // v22.32: tone frequency + proximity ping
    document.getElementById('i-tonefreq').value = State.settings.toneFreq || 1900;
    // v22.33: proximity ping start distance
    document.getElementById('i-proximity-start').value = State.settings.proximityStartM || 1000;
    document.getElementById('t-proximity').classList.toggle('on', State.settings.proximityPing !== false);
    // v23.7.2: speed-limit revalidation toggle
    const tSpeedReval = document.getElementById('t-speed-reval');
    if (tSpeedReval) tSpeedReval.classList.toggle('on', !!State.settings.speedLimitRevalidation);
    // v22.76: here-now announcement settings
    document.getElementById('i-here-speed').value = State.settings.hereSpeedThreshold || 100;
    document.getElementById('i-here-repeat').value = State.settings.hereRepeatCount || 2;
    document.querySelectorAll('[data-speed]').forEach(b =>
      b.classList.toggle('active', b.dataset.speed === State.settings.speedAlertMode));
    document.getElementById('i-gh-token').value = State.gh.token || '';
    document.getElementById('i-gh-repo').value = State.gh.repo || '';
    document.getElementById('i-gh-path').value = State.gh.path || '';
    this.updateBackupStatus();
    this.updateTripButton();
    // v23.6.0 merge: removed the inline Sound Alerts table render; the
    // 18-sound modal is opened via UI.openSoundAlerts() from its own
    // button. No inline render needed when Settings opens.
  },

  // v23.6.0 merge: removed parallel agent's renderSoundAlertsTable.
  // The 18-row Sound Alerts modal is rendered by UI.renderSoundAlerts()
  // earlier in this object and opened via UI.openSoundAlerts() from
  // the "🔔 Sound Alerts" button in Settings.

  applyTheme() {
    let t = State.settings.theme;
    if (t === 'auto') {
      const h = new Date().getHours();
      t = (h >= 6 && h < 18) ? 'light' : 'dark';
    }
    document.body.setAttribute('data-theme', t);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#0c0a09' : '#f5f1e8');
  },

  /** v23.0.1: write body[data-hide-hints] so the CSS rule that hides every
   *  .row-hint takes effect immediately. Treat undefined as "show" so
   *  existing users default to the same behavior as before this toggle. */
  applyHintsVisibility() {
    const hide = State.settings.showHints === false;
    document.body.setAttribute('data-hide-hints', hide ? 'true' : 'false');
  },

  /** v23.5 Phase 4: paint the offline / degraded chip in the top bar.
   *  Hidden when state === 'online'. Driven by NetworkMonitor.getStatus().
   *  Tooltip carries the full breakdown — state, last failure scope,
   *  backupPending, routeUnavailable. */
  applyOfflineIndicator() {
    const chip = document.getElementById('offline-indicator');
    if (!chip) return;
    let status;
    try { status = NetworkMonitor.getStatus(); }
    catch (e) { status = { state: 'online' }; }
    chip.classList.remove('suspected', 'offline');
    if (status.state === 'online' && !status.backupPending && !status.routeUnavailable) {
      chip.textContent = '';
      chip.hidden = true;
      chip.title = '';
      return;
    }
    chip.hidden = false;
    // Labels priority: confirmed-offline → routing unavailable → backup queued → suspected
    let label, cls;
    if (status.state === 'confirmed-offline') {
      label = 'OFFLINE'; cls = 'offline';
    } else if (status.routeUnavailable) {
      label = 'NO ROUTE'; cls = 'offline';
    } else if (status.backupPending) {
      label = 'BACKUP QUEUED'; cls = 'suspected';
    } else if (status.state === 'suspected-offline') {
      label = 'DEGRADED'; cls = 'suspected';
    } else {
      label = '';
      cls = '';
    }
    chip.textContent = label;
    if (cls) chip.classList.add(cls);
    chip.title = `network: ${status.state} · ` +
      `route: ${status.routeUnavailable ? 'unavailable' : 'ok'} · ` +
      `backup: ${status.backupPending ? 'queued' : 'ok'} · ` +
      `consec failures: ${status.consecutiveFailures}` +
      (status.lastFailureScope ? ` · last failure: ${status.lastFailureScope} (${status.lastFailureMessage || ''})` : '');
  },

  /** v23.4.1: paint the alert-engine visibility chip in the top bar.
   *  Hidden in Legacy. Amber in Shadow. Red + pulse in Active so the
   *  driver always knows that live intelligence has alert control.
   *  Also toggles the "Revert to Legacy" rollback row in Settings. */
  applyIntelIndicator() {
    const mode = (State.settings && State.settings.intelMode) || 'legacy';
    const chip = document.getElementById('intel-indicator');
    if (chip) {
      chip.classList.remove('shadow', 'active');
      if (mode === 'shadow') {
        chip.textContent = 'SHADOW';
        chip.title = 'Shadow mode: intelligence logs decisions in parallel';
        chip.hidden = false;
        chip.classList.add('shadow');
      } else if (mode === 'active') {
        chip.textContent = 'INTEL';
        chip.title = 'Active Intelligence: engine can suppress legacy alerts';
        chip.hidden = false;
        chip.classList.add('active');
      } else {
        chip.textContent = '';
        chip.hidden = true;
      }
    }
    const rollbackRow = document.getElementById('intel-rollback-row');
    if (rollbackRow) rollbackRow.style.display = (mode === 'legacy') ? 'none' : '';
  },

  updateBackupStatus() {
    const el = document.getElementById('backup-status');
    if (!el) return;
    if (!State.gh.token || !State.gh.repo) {
      el.textContent = 'Set token & repo to enable backup';
      return;
    }
    if (!State.lastBackup) {
      el.textContent = State.settings.autoBackup ? 'Auto-backup on · no backup yet' : 'No backup yet';
      return;
    }
    const ageMin = Math.floor((Date.now() - State.lastBackup) / 60000);
    el.textContent = ageMin < 1 ? 'Last backup: just now'
                    : ageMin < 60 ? `Last backup: ${ageMin} min ago`
                    : `Last backup: ${Math.floor(ageMin / 60)} hr ago`;
  },
};

/* ============================================================
   9. WIRING
   ============================================================ */
function wire() {
  document.getElementById('btn-settings').onclick = () => {
    Audio.unlock(); // v23.6.2: arm audio so the inline Try previews work
    // v23.8.1: install the collapsible-section wrappers on first open.
    // Idempotent — subsequent opens are no-ops. Done before
    // syncSettings/renderSoundAlerts so the inline sound-alerts
    // table still renders into its target container after wrapping.
    UI.installCollapsibleSettings();
    UI.syncSettings();
    UI.renderMigrationStatus(); // v22.96: refresh migration status on open
    UI.refreshStorageStatus();  // v23.x Phase 2a: storage health summary
    UI.renderSoundAlerts();     // v23.6.2: populate inline 18-row table
    UI.openModal('m-settings');
  };
  // v22.96: data architecture migration wiring
  document.getElementById('btn-migrate-dry').onclick = () => UI.openMigrationDryRun();
  document.getElementById('btn-migrate-restore').onclick = () => UI.doMigrationRestore();
  document.getElementById('btn-do-migrate').onclick = () => UI.doMigration();
  // v23.x Phase 2a: storage safety net buttons. All three are read-only
  // for the existing road memory — only the Snapshot button creates new
  // storage, in its own roadalert:migrationSnapshot:* namespace.
  const _btnInv = document.getElementById('btn-storage-inventory');
  if (_btnInv) _btnInv.onclick = () => {
    const rep = StorageInventory.inventoryReport();
    StorageInventory.detectSchema(State.data);
    StorageInventory.routeGeometryReport();
    UI.refreshStorageStatus(rep);
  };
  const _btnSnap = document.getElementById('btn-storage-snapshot');
  if (_btnSnap) _btnSnap.onclick = () => {
    const res = StorageInventory.createSnapshot();
    if (res.ok) {
      Utils.toast(`Snapshot saved · ${StorageInventory._fmtBytes(res.bytes)}`, 'good');
    } else if (res.error === 'quota_exceeded') {
      Utils.toast('Snapshot failed — storage quota exceeded', 'bad');
    } else {
      Utils.toast('Snapshot failed — see debug log', 'bad');
    }
    UI.refreshStorageStatus();
  };
  const _btnVal = document.getElementById('btn-storage-validate');
  if (_btnVal) _btnVal.onclick = () => {
    const dataReport = StorageInventory.validateRoadMemory(State.data);
    const snaps = StorageInventory.listSnapshots();
    for (const s of snaps) StorageInventory.validateSnapshot(s.key);
    Utils.toast(
      `Live: ${dataReport.warnings.length} warnings · ${snaps.length} snapshot(s) validated`,
      dataReport.warnings.length ? 'bad' : 'good'
    );
    UI.refreshStorageStatus();
  };
  // v23.x Phase 2c-1c: duplicate detector (observe-only). Manual click
  // only. Reads State.data.points as a static snapshot; never touches
  // live GPS. Renders an inert, read-only result panel.
  const _btnDup = document.getElementById('btn-storage-dupscan');
  if (_btnDup) _btnDup.onclick = () => {
    const points = (State.data && Array.isArray(State.data.points)) ? State.data.points : [];
    const result = DuplicateDetector.scan(points);
    UI.renderDuplicateScanResults(result);
    Utils.toast(
      `${result.rows.length} pair(s) flagged · ${result.candidateCount} within ${DuplicateDetectorConfig.MAX_PAIR_RADIUS_M}m`,
      result.counts.TRUE_DUPLICATE > 0 || result.counts.SAME_PASS_DUPLICATE > 0 ? 'bad' : 'good'
    );
  };
  // v22.79: debug log panel — opens the rolling-200 event history.
  document.getElementById('btn-debug').onclick = () => {
    UI.renderDebugLog();
    UI.openModal('m-debug');
  };
  document.getElementById('debug-clear').onclick = () => {
    Logger.clear();
    Utils.toast('Log cleared', 'good');
  };
  document.getElementById('debug-copy').onclick = async () => {
    const text = Logger.asText();
    if (!text) { Utils.toast('Nothing to copy', 'bad'); return; }
    try {
      await navigator.clipboard.writeText(text);
      Utils.toast(`Copied ${Logger.logs.length} entries`, 'good');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select(); document.execCommand('copy');
        ta.remove();
        Utils.toast(`Copied ${Logger.logs.length} entries`, 'good');
      } catch (e2) { Utils.toast('Copy failed', 'bad'); }
    }
  };

  // v22.102: render the full log to a canvas, download as PNG. Pure 2D
  // canvas drawing — no html2canvas dep needed. Colors mirror the theme
  // (--surface bg, --amber-2 type, --ink msg, --red err, --green ok).
  document.getElementById('debug-png').onclick = () => {
    if (!Logger.logs.length) { Utils.toast('Nothing to export', 'bad'); return; }
    try {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pad = 12;
      const lineH = 18;
      const fontPx = 12;
      const headerH = 36;
      const colTs = 70;
      const colTy = 80;
      const colMsg = 720;
      const totalW = pad + colTs + colTy + colMsg + pad;
      const totalH = pad + headerH + Logger.logs.length * lineH + pad;

      const canvas = document.createElement('canvas');
      canvas.width = totalW * dpr;
      canvas.height = totalH * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // Background
      ctx.fillStyle = '#0c0a09';
      ctx.fillRect(0, 0, totalW, totalH);

      // Header
      ctx.fillStyle = '#f5f5f4';
      ctx.font = `700 14px ui-monospace, monospace`;
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      ctx.fillText(`X · debug log · ${Logger.logs.length} entries · ${stamp}`, pad, pad + 16);

      // Rows
      ctx.font = `${fontPx}px ui-monospace, monospace`;
      ctx.textBaseline = 'top';
      let y = pad + headerH;
      for (const L of Logger.logs) {
        // ts
        ctx.fillStyle = '#a8a29e';
        ctx.fillText(L.t, pad, y);
        // type — color by level
        ctx.fillStyle = L.level === 'err' ? '#ef4444'
                     : L.level === 'ok'  ? '#22c55e'
                     : '#f59e0b';
        ctx.fillText(L.type, pad + colTs, y);
        // msg — truncate to col width
        ctx.fillStyle = '#f5f5f4';
        let msg = L.msg || '';
        const maxChars = Math.floor(colMsg / (fontPx * 0.6));
        if (msg.length > maxChars) msg = msg.slice(0, maxChars - 1) + '…';
        ctx.fillText(msg, pad + colTs + colTy, y);
        y += lineH;
      }

      canvas.toBlob(blob => {
        if (!blob) { Utils.toast('PNG export failed', 'bad'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `x-debug-${stamp.replace(/[: ]/g, '-')}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        Utils.toast(`Exported ${Logger.logs.length} entries`, 'good');
      }, 'image/png');
    } catch (e) {
      logEvent('LOG', 'PNG export failed: ' + (e && e.message || e), 'err');
      Utils.toast('PNG export failed', 'bad');
    }
  };

  // v22.10: Next-ahead card single/double tap
  // Single tap (after ~280ms with no second tap) → announce nearest ahead
  // Double tap (two taps within 280ms) → announce last capture this trip
  (function() {
    const card = document.getElementById('next-card');
    if (!card) return;
    let tapCount = 0;
    let tapTimer = null;
    card.addEventListener('click', () => {
      tapCount++;
      if (tapCount === 1) {
        tapTimer = setTimeout(() => {
          tapCount = 0;
          UI.announceNearestAhead();
        }, 280);
      } else {
        clearTimeout(tapTimer);
        tapCount = 0;
        UI.announceLastTripCapture();
      }
    });
  })();

  // v22.4: top-bar quick controls
  document.getElementById('btn-sound').onclick = () => {
    // v22.5: toggle between voice and tone (no "both" or "off")
    State.settings.sound = State.settings.sound === 'voice' ? 'beep' : 'voice';
    State.saveSettings();
    UI.updateSoundIcon();
    Utils.toast('Sound: ' + (State.settings.sound === 'voice' ? 'voice' : 'tone'), 'good');
    Audio.unlock();
    Audio.beep('petrol');
  };
  document.getElementById('btn-theme').onclick = () => {
    const cycle = ['light', 'dark', 'auto'];
    const i = cycle.indexOf(State.settings.theme);
    State.settings.theme = cycle[(i + 1) % cycle.length];
    State.saveSettings();
    UI.applyTheme();
    UI.updateThemeIcon();
    Utils.toast('Theme: ' + State.settings.theme, 'good');
  };
  // v23.5.2: removed the top-bar #btn-fit-top (⛶) and #btn-recenter-top (📍)
  // duplicates. The map-overlay #btn-fit and #btn-recenter still bind to the
  // same MapView.fitAll / MapView.recenter functions (lines 3233–3234), and
  // the follow-pill also still calls MapView.recenter — so the underlying
  // capabilities are untouched.
  // v22.56: long-press capture toggle
  document.getElementById('btn-longpress').onclick = () => {
    State.settings.longPressCapture = !State.settings.longPressCapture;
    State.saveSettings();
    UI.updateLongPressBtn();
    Utils.toast(
      State.settings.longPressCapture ? 'Long-press capture: ON' : 'Long-press capture: OFF',
      'good'
    );
  };
  document.getElementById('btn-route').onclick = () => { UI.renderRoutesList(); UI.openModal('m-routes'); };
  document.getElementById('btn-capture').onclick = () => UI.openCaptureMenu();
  document.getElementById('btn-go').onclick = () => {
    if (State.mode !== 'idle') { GPS.stop(); return; }
    // v22.7: confirm destination before starting
    UI.confirmStart();
  };
  // v22.7: confirm-start modal buttons
  document.getElementById('confirm-cancel').onclick = () => UI.closeAllModals();
  document.getElementById('confirm-change').onclick = () => {
    UI.closeAllModals();
    UI.renderRoutesList();
    UI.openModal('m-routes');
  };
  document.getElementById('confirm-start').onclick = () => UI.doStart();
  document.getElementById('btn-fit').onclick = () => MapView.fitAll();
  document.getElementById('btn-recenter').onclick = () => MapView.recenter();

  // v22.81: compass tap → reset bearing to north (animated). Reads the
  // current bearing straight from the map for the log entry so we know
  // what was actually displayed at the moment of the reset.
  document.getElementById('btn-compass').onclick = () => {
    if (!MapView.m) return;
    const wasBearing = MapView.m.getBearing();
    MapView.m.easeTo({ bearing: 0, duration: 500 });
    logEvent('MAP', `Compass reset (was ${wasBearing.toFixed(1)}° → 0°)`);
  };
  // v23.5.6: 👁️ master toggle for the right-side .map-overlay-btns
  // column. In-memory state only — no localStorage write, no settings
  // schema change. Zoom (MapLibre top-left), compass, follow-pill, GPS
  // marker, route line, and all alert UI remain visible at all times.
  const _btnEye = document.getElementById('btn-eye-toggle');
  if (_btnEye) _btnEye.onclick = () => {
    const col = document.querySelector('.map-overlay-btns');
    if (!col) return;
    const willHide = !col.classList.contains('hidden-by-eye');
    col.classList.toggle('hidden-by-eye', willHide);
    _btnEye.classList.toggle('controls-hidden', willHide);
    _btnEye.setAttribute('aria-pressed', willHide ? 'true' : 'false');
    logEvent('MAP', `[MAP] right-side controls ${willHide ? 'hidden' : 'shown'}`);
  };

  // v22.54: nav-mode toggle — turns auto-rotation on/off
  document.getElementById('btn-nav').onclick = () => {
    State.settings.navMode = !State.settings.navMode;
    State.saveSettings();
    logEvent('MAP', 'Nav-mode (heading-up) ' + (State.settings.navMode ? 'ON' : 'OFF'));
    const btn = document.getElementById('btn-nav');
    btn.classList.toggle('on', State.settings.navMode);
    // Reset rotation throttle so the very next tick rotates immediately
    MapView._lastBearingApplied = null;
    MapView._lastBearingAt = 0;
    if (State.settings.navMode) {
      if (!State.followMap) { State.followMap = true; UI.updateFollowPill(); }
      Utils.toast('Rotation: heading up', 'good');
      // If we already have a heading, rotate immediately rather than waiting
      // for the next GPS tick
      if (MapView.m && MapView._smoothedHeading != null) {
        // v22.84: easeTo for a smooth flip-in, same as the update() loop.
        try { MapView.m.easeTo({ bearing: MapView._smoothedHeading, duration: 500, essential: true }); } catch (e) {}
      }
    } else {
      // Snap back to north when turning off — easeTo for smoothness.
      if (MapView.m) {
        try { MapView.m.easeTo({ bearing: 0, duration: 500, essential: true }); } catch (e) {}
      }
      Utils.toast('Rotation: north up', 'good');
    }
  };

  // v22.78 / refactor v22.80: 3D pitch toggle. The label swap and the
  // event log both live INSIDE MapView.setPitchMode now, so every code
  // path (this click, boot-restore, programmatic) stays in sync.
  document.getElementById('btn-pitch').onclick = () => {
    State.settings.pitchMode = !State.settings.pitchMode;
    State.saveSettings();
    document.getElementById('btn-pitch').classList.toggle('on', State.settings.pitchMode);
    MapView.setPitchMode(State.settings.pitchMode);
    Utils.toast(State.settings.pitchMode ? '3D perspective' : '2D top-down', 'good');
  };

  // v23.9.2: Drive view toggle — single tap snaps the map to a fixed
  // driving preset (zoom 18 / 3D pitch / heading-up / follow ON);
  // second tap exits the preset (pitch 0 / nav off; follow stays on
  // because users typically want it on regardless). Mirrors the
  // existing per-feature buttons (🧭 nav, 3D pitch, follow-pill) so
  // each one still works independently after Drive view is engaged.
  const _btnDrive = document.getElementById('btn-drive-view');
  if (_btnDrive) _btnDrive.onclick = () => {
    MapView._driveView = !MapView._driveView;
    _btnDrive.classList.toggle('on', MapView._driveView);
    if (MapView._driveView) {
      State.settings.pitchMode = true;
      State.settings.navMode = true;
      State.saveSettings();
      MapView.setPitchMode(true);
      document.getElementById('btn-pitch').classList.toggle('on', true);
      document.getElementById('btn-nav').classList.toggle('on', true);
      if (State.pos) {
        State.followMap = true;
        UI.updateFollowPill();
        try {
          MapView.m.easeTo({
            center: [State.pos.lng, State.pos.lat],
            zoom: 18,
            duration: 600,
          });
        } catch (e) {}
      }
      Utils.toast('Drive view on', 'good');
      try { logEvent('MAP', '[MAP] drive-view ON (zoom=18, pitch=60, nav=on, follow=on)'); } catch (e) {}
    } else {
      State.settings.pitchMode = false;
      State.settings.navMode = false;
      State.saveSettings();
      MapView.setPitchMode(false);
      document.getElementById('btn-pitch').classList.toggle('on', false);
      document.getElementById('btn-nav').classList.toggle('on', false);
      // Reset bearing to north so the map isn't stuck on the last heading.
      try { MapView.m.easeTo({ bearing: 0, duration: 400 }); } catch (e) {}
      Utils.toast('Drive view off', 'good');
      try { logEvent('MAP', '[MAP] drive-view OFF'); } catch (e) {}
    }
  };

  // v23.9.9: feedback-popup master toggle. ON = "Still there?" popups
  // can appear; OFF = no feedback popup is queued or shown. Persists
  // via State.settings.feedbackEnabled. If a popup is currently open
  // when switched off, close it immediately.
  const _btnFeedback = document.getElementById('btn-feedback-toggle');
  const _paintFeedbackBtn = () => {
    if (!_btnFeedback) return;
    const on = State.settings.feedbackEnabled !== false;
    _btnFeedback.classList.toggle('on', on);
    _btnFeedback.style.opacity = on ? '' : '0.45';
    _btnFeedback.title = on ? 'Feedback popup: ON (tap to turn off)' : 'Feedback popup: OFF (tap to turn on)';
  };
  if (_btnFeedback) {
    _paintFeedbackBtn();
    _btnFeedback.onclick = () => {
      const next = !(State.settings.feedbackEnabled !== false);
      State.settings.feedbackEnabled = next;
      State.saveSettings();
      _paintFeedbackBtn();
      if (!next) {
        // Switched off — dismiss any open popup + clear the queue so
        // nothing pops after the toggle.
        try { Confirm._cleanup(); } catch (e) {}
        Confirm._queue = [];
        Confirm._activeId = null;
      }
      Utils.toast('Feedback popup ' + (next ? 'on' : 'off'), 'good');
      try { logEvent('FEEDBACK-POPUP', `master toggle → ${next ? 'on' : 'off'}`); } catch (e) {}
    };
  }

  // v23.11.0: left-rail master toggle. ON = the left rail (opposite-
  // direction captures) is shown and the timeline split is active;
  // OFF = the rail is hidden, the map-row falls back to its 2-column
  // layout, and ALL captures stay on the right rail (original behavior).
  // Persists via State.settings.leftRailEnabled. Default ON.
  const _btnLeftRail = document.getElementById('btn-left-rail');
  const _paintLeftRailBtn = () => {
    const on = State.settings.leftRailEnabled !== false;
    const row = document.querySelector('.map-row');
    if (row) row.classList.toggle('lr-off', !on);
    if (!_btnLeftRail) return;
    _btnLeftRail.classList.toggle('on', on);
    _btnLeftRail.style.opacity = on ? '' : '0.45';
    _btnLeftRail.title = on ? 'Left rail: ON (tap to hide)' : 'Left rail: OFF (tap to show)';
  };
  UI._paintLeftRailBtn = _paintLeftRailBtn;
  if (_btnLeftRail) {
    _paintLeftRailBtn();
    _btnLeftRail.onclick = () => {
      const next = !(State.settings.leftRailEnabled !== false);
      State.settings.leftRailEnabled = next;
      State.saveSettings();
      _paintLeftRailBtn();
      UI.renderTimeline();
      if (MapView.m) { try { MapView.m.resize(); } catch (e) {} }
      Utils.toast('Left rail ' + (next ? 'on' : 'off'), 'good');
      try { logEvent('LEFT-RAIL', `toggle → ${next ? 'on' : 'off'}`); } catch (e) {}
    };
  }

  // v22.88: map style switcher
  document.getElementById('btn-mapstyle').onclick = () => {
    UI.renderMapStyleList();
    UI.openModal('m-mapstyle');
  };

  document.getElementById('follow-pill').onclick = () => {
    State.followMap = !State.followMap;
    UI.updateFollowPill();
    if (State.followMap && State.pos) MapView.recenter();
    logEvent('NAV', 'Follow ' + (State.followMap ? 'ON' : 'OFF'));
  };
  document.getElementById('sign').onclick = () => UI.openLimitPicker();

  document.querySelectorAll('[data-cap]').forEach(b =>
    b.onclick = () => UI.beginCapture(b.dataset.cap)
  );
  document.querySelectorAll('[data-side]').forEach(b =>
    b.onclick = () => {
      if (State.pendingCapture && b.dataset.side !== 'none') {
        State.pendingCapture.side = b.dataset.side;
      }
      UI.closeAllModals();
      if (State.pendingCapture) UI.finalizeCapture();
    }
  );
  document.getElementById('limit-save').onclick = () => {
    const v = +document.getElementById('limit-custom').value;
    UI._commitSpeedLimit(v);
  };
  document.getElementById('limit-clear').onclick = () => {
    State.manualLimit = null;
    UI.closeAllModals();
    UI.render();
    Utils.toast('Manual limit cleared');
  };
  document.getElementById('other-save').onclick = () => {
    const v = document.getElementById('other-name').value.trim();
    if (!v) { Utils.toast('Enter a name', 'bad'); return; }
    State.pendingCapture.name = v;
    UI.closeAllModals();
    UI.finalizeCapture();
  };

  document.getElementById('e-type').onchange = () => {
    UI.togglePEFields();
    // v23.6.8: when type changes in Edit Point, repaint the
    // Sound-alert dropdown so it shows the mapping for the NEW type.
    const newType = document.getElementById('e-type').value;
    UI.renderEditPointSoundAlert(newType);
  };
  // v23.6.8: Sound-alert dropdown — reassigns the chosen sound to
  // this point's type. Empty value = clear any sound mapping for the
  // type. Changes commit immediately to State.settings.soundAlerts.
  const _eSA = document.getElementById('e-soundalert');
  if (_eSA) _eSA.onchange = () => {
    const type = document.getElementById('e-type').value;
    const soundId = _eSA.value || '';
    UI.assignSoundToType(soundId, type);
    UI.renderEditPointSoundAlert(type); // refresh hint text
  };
  // v23.6.8: Try button previews the currently-selected sound at
  // Medium frequency. Uses the same Audio.preview path as Settings.
  const _eSATry = document.getElementById('e-soundalert-try');
  if (_eSATry) _eSATry.onclick = () => {
    const soundId = (document.getElementById('e-soundalert') || {}).value || '';
    if (!soundId) return;
    Audio.unlock();
    try { logEvent('SOUND', `[SOUND] try ${soundId} @ medium (from Edit Point)`); } catch (e) {}
    Audio.preview(soundId, { frequency: 'medium' });
  };
  // v23.7.3: per-type heartbeat ping toggle. Flips
  // State.settings.heartbeatByType[type] and persists immediately so
  // the change takes effect on the next Alerts.tick.
  const _eHB = document.getElementById('t-heartbeat');
  if (_eHB) _eHB.onclick = () => {
    const type = document.getElementById('e-type').value;
    if (!type) return;
    if (!State.settings.heartbeatByType || typeof State.settings.heartbeatByType !== 'object') {
      State.settings.heartbeatByType = {};
    }
    const wasOn = State.settings.heartbeatByType[type] !== false;
    State.settings.heartbeatByType[type] = !wasOn;
    State.saveSettings();
    _eHB.classList.toggle('on', !wasOn);
    Utils.toast(`Heartbeat ping for ${Utils.typeLabel(type)} ` + (!wasOn ? 'on' : 'off'), 'good');
    try { logEvent('SOUND', `[SOUND] heartbeat-by-type ${type} → ${!wasOn ? 'on' : 'off'}`); } catch (e) {}
  };
  // v23.7.1: Missed Feedback chip — count > 0 opens the YES/NO popup
  // for the first unresolved entry; count === 0 shows a small toast.
  const _eMissed = document.getElementById('e-missed-btn');
  if (_eMissed) _eMissed.onclick = () => {
    const id = State.editingPointId;
    if (!id) return;
    const p = State.data.points.find(x => x.id === id);
    if (!p) return;
    const count = Confirm._countUnresolvedMissed(p);
    if (count <= 0) {
      Utils.toast('No missed feedback', 'good');
      return;
    }
    const first = Confirm._firstUnresolvedMissed(p);
    if (!first) { Utils.toast('No missed feedback', 'good'); return; }
    // Close Edit Point first so the popup is unobstructed; the
    // missed entry's pointId is stable so we can re-open Edit Point
    // after the user submits.
    UI.closeAllModals();
    Audio.unlock();
    Confirm.openMissedFeedback(p.id, first.id);
  };
  document.querySelectorAll('#e-side-opts button').forEach(b =>
    b.onclick = () => document.querySelectorAll('#e-side-opts button').forEach(x => x.classList.toggle('active', x === b))
  );
  document.querySelectorAll('#e-status-opts button').forEach(b =>
    b.onclick = () => document.querySelectorAll('#e-status-opts button').forEach(x => x.classList.toggle('active', x === b))
  );
  // v22.91: directional toggle + road-type picker + captureBearing clear
  document.getElementById('t-directional').onclick = () => {
    const t = document.getElementById('t-directional');
    t.classList.toggle('on');
  };
  document.querySelectorAll('#e-roadtype-opts button').forEach(b =>
    b.onclick = () => document.querySelectorAll('#e-roadtype-opts button').forEach(x => x.classList.toggle('active', x === b))
  );
  document.getElementById('e-capbearing-clear').onclick = () => {
    const p = State.data.points.find(x => x.id === State.editingPointId);
    if (!p) return;
    p.captureBearing = null;
    document.getElementById('e-capbearing-val').textContent = '—';
    Utils.toast('Capture bearing cleared', 'good');
  };
  document.getElementById('e-save').onclick = () => UI.savePoint();
  document.getElementById('e-delete').onclick = () => UI.deletePoint();
  document.getElementById('e-gmap').onclick = () => {
    const lat = document.getElementById('e-lat').value;
    const lng = document.getElementById('e-lng').value;
    if (lat && lng) window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`, '_blank', 'noopener,noreferrer');
  };
  // v22.71: promote the edited point's location to a new destination.
  // Doesn't modify or delete the point — opens the destination editor
  // pre-filled with the point's coords so the user just names it.
  document.getElementById('e-add-dest').onclick = () => {
    const lat = +document.getElementById('e-lat').value;
    const lng = +document.getElementById('e-lng').value;
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      Utils.toast('Invalid coordinates', 'bad');
      return;
    }
    UI.closeAllModals();
    UI.openDestEditor(null, { lat: +lat.toFixed(5), lng: +lng.toFixed(5) });
  };

  document.getElementById('route-add').onclick = () => UI.openDestEditor(null);
  document.querySelectorAll('[data-retab]').forEach(b =>
    b.onclick = () => UI.setRouteTab(b.dataset.retab)
  );
  document.getElementById('re-here-grab').onclick = () => {
    if (!State.pos) { Utils.toast('Start GPS first', 'bad'); return; }
    document.getElementById('re-lat').value = +State.pos.lat.toFixed(5);
    document.getElementById('re-lng').value = +State.pos.lng.toFixed(5);
    UI.setRouteTab('latlng');
    Utils.toast('Coords filled', 'good');
  };
  // v22.72: "Pick on map" — closes the dialog, listens for the next tap
  // on the map, re-opens the editor with the tapped coords prefilled.
  document.getElementById('re-pickmap-go').onclick = () => {
    UI.closeAllModals();
    MapView.beginDestinationPickMode();
  };
  // v22.73: copy "lat, lng" together to clipboard. Format matches what
  // Google Maps / Waze / message apps accept in a search box.
  document.getElementById('re-copy').onclick = async () => {
    const lat = document.getElementById('re-lat').value;
    const lng = document.getElementById('re-lng').value;
    if (!lat || !lng) { Utils.toast('No coords to copy', 'bad'); return; }
    const text = `${lat}, ${lng}`;
    try {
      await navigator.clipboard.writeText(text);
      Utils.toast(`Copied: ${text}`, 'good');
    } catch (e) {
      // Fallback for browsers without clipboard API (e.g. older Safari)
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        Utils.toast(`Copied: ${text}`, 'good');
      } catch (e2) {
        Utils.toast('Copy failed', 'bad');
      }
    }
  };
  document.getElementById('re-save').onclick = () => UI.saveDest();
  document.getElementById('re-delete').onclick = () => UI.deleteDest();

  // v22.26 BUG FIX: `[data-theme]` also matched <body data-theme="…">, so the
  // top-bar theme cycle was getting clobbered by a stray handler on body.
  // Scope to the Theme button-group inside the Settings modal only.
  document.querySelectorAll('#theme-opts [data-theme]').forEach(b =>
    b.onclick = () => { State.settings.theme = b.dataset.theme; State.saveSettings(); UI.applyTheme(); UI.updateThemeIcon(); UI.syncSettings(); }
  );
  document.querySelectorAll('[data-sound]').forEach(b =>
    b.onclick = () => {
      State.settings.sound = b.dataset.sound; State.saveSettings(); UI.syncSettings(); UI.updateSoundIcon();
      Audio.unlock();
      if (b.dataset.sound !== 'off') Audio.beep('petrol');
    }
  );
  // v23.3.x Phase 3: alert engine mode segmented control. Logs the
  // transition via [INTEL-MODE] so the audit trail is preserved.
  document.querySelectorAll('[data-intel-mode]').forEach(b =>
    b.onclick = () => {
      const prev = State.settings.intelMode || 'legacy';
      const next = b.dataset.intelMode;
      if (prev === next) return;
      State.settings.intelMode = next;
      State.saveSettings();
      IntelligenceEngine.logModeTransition(prev, next);
      if (next === 'active') {
        logEvent('INTEL-MODE', '[INTEL-MODE] active', 'ok');
      }
      Utils.toast(`Alert engine: ${next}`,
        next === 'active' ? 'bad' : 'good');
      UI.syncSettings();
    }
  );
  // v23.4.1: one-tap rollback to Legacy. Same code path as tapping the
  // Legacy button in the segmented control, exposed as a prominent
  // separate button so it's reachable in a single press while driving.
  const _btnRollback = document.getElementById('btn-intel-rollback');
  if (_btnRollback) _btnRollback.onclick = () => {
    const prev = State.settings.intelMode || 'legacy';
    if (prev === 'legacy') return;
    State.settings.intelMode = 'legacy';
    State.saveSettings();
    IntelligenceEngine.logModeTransition(prev, 'legacy');
    Utils.toast('Reverted to Legacy', 'good');
    UI.syncSettings();
  };
  document.querySelectorAll('[data-voice]').forEach(b =>
    b.onclick = () => {
      State.settings.voiceGender = b.dataset.voice;
      Audio._voiceCache = null; Audio._voiceCacheFor = null;
      State.saveSettings();
      UI.syncSettings();
      Audio.unlock();
      if (b.dataset.voice !== 'none') Audio.say('Voice set');
    }
  );
  document.querySelectorAll('[data-speed]').forEach(b =>
    b.onclick = () => { State.settings.speedAlertMode = b.dataset.speed; State.saveSettings(); UI.syncSettings(); }
  );
  document.getElementById('t-side').onclick = () => { State.settings.announceSide = !State.settings.announceSide; State.saveSettings(); UI.syncSettings(); };
  // v22.83: compass show/hide toggle
  document.getElementById('t-compass').onclick = () => UI.toggleCompass();
  // v23.0.1: hide / show explanatory paragraphs under each settings row
  const tHintsBtn = document.getElementById('t-hints');
  if (tHintsBtn) tHintsBtn.onclick = () => {
    State.settings.showHints = State.settings.showHints === false ? true : false;
    State.saveSettings();
    UI.syncSettings();
  };
  document.getElementById('t-autobackup').onclick = () => {
    State.settings.autoBackup = !State.settings.autoBackup;
    State.saveSettings(); UI.syncSettings();
    if (State.settings.autoBackup) Backup.start(); else Backup.stop();
  };
  // v22.17: chip-based alert distances editor
  document.getElementById('btn-marker-add').addEventListener('click', () => {
    const inp = document.getElementById('i-marker-add');
    const v = parseInt(inp.value, 10);
    if (!v || v < 50 || v > 10000) {
      Utils.toast('Enter 50–10000 meters', 'bad');
      return;
    }
    const set = new Set(State.settings.alertMarkersM || []);
    set.add(v);
    State.settings.alertMarkersM = [...set].sort((a, b) => b - a);
    State.saveSettings();
    inp.value = '';
    UI.renderMarkerChips();
    Utils.toast('Added ' + v + 'm', 'good');
  });
  document.querySelectorAll('[data-marker-preset]').forEach(b => {
    b.addEventListener('click', () => {
      const presets = {
        default: [2000, 1000, 500],
        city: [1000, 500, 200],
        highway: [3000, 2000, 1000, 500],
      };
      const p = presets[b.dataset.markerPreset];
      if (!p) return;
      State.settings.alertMarkersM = p;
      State.saveSettings();
      UI.renderMarkerChips();
      Utils.toast('Preset: ' + b.dataset.markerPreset, 'good');
    });
  });
  document.getElementById('i-over').onchange = e => {
    const v = +e.target.value;
    if (v >= 0 && v <= 50) { State.settings.overBy = v; State.saveSettings(); }
  };
  // v22.6: new alert settings handlers
  document.getElementById('i-flash').onchange = e => {
    const v = +e.target.value;
    if (v >= 50 && v <= 3000) { State.settings.flashStartM = v; State.saveSettings(); Utils.toast('Flash at ' + v + 'm', 'good'); }
  };
  document.getElementById('i-repeat').onchange = e => {
    const v = Math.round(+e.target.value);
    if (v >= 1 && v <= 5) { State.settings.alertRepeatCount = v; State.saveSettings(); Utils.toast('Repeat × ' + v, 'good'); }
  };
  document.getElementById('i-repeatgap').onchange = e => {
    const v = +e.target.value;
    if (v >= 0.5 && v <= 10) { State.settings.alertRepeatGapS = v; State.saveSettings(); Utils.toast('Gap ' + v + 's', 'good'); }
  };
  // v22.32: tone frequency
  document.getElementById('i-tonefreq').onchange = e => {
    const v = Math.round(+e.target.value);
    if (v >= 800 && v <= 3000) {
      State.settings.toneFreq = v;
      State.saveSettings();
      Audio.unlock();
      Audio.proximityPing(); // preview
      Utils.toast('Tone ' + v + 'Hz', 'good');
    }
  };
  // v22.32: proximity ping toggle
  document.getElementById('t-proximity').onclick = () => {
    State.settings.proximityPing = !State.settings.proximityPing;
    State.saveSettings();
    document.getElementById('t-proximity').classList.toggle('on', State.settings.proximityPing);
    Utils.toast('Proximity ping ' + (State.settings.proximityPing ? 'on' : 'off'), 'good');
  };
  // v23.7.2: speed-limit revalidation toggle
  const tSpeedRevalBtn = document.getElementById('t-speed-reval');
  if (tSpeedRevalBtn) {
    tSpeedRevalBtn.onclick = () => {
      State.settings.speedLimitRevalidation = !State.settings.speedLimitRevalidation;
      State.saveSettings();
      tSpeedRevalBtn.classList.toggle('on', !!State.settings.speedLimitRevalidation);
      Utils.toast('Speed-limit revalidation ' + (State.settings.speedLimitRevalidation ? 'on' : 'off'), 'good');
    };
  }
  // v22.33: proximity ping start distance
  document.getElementById('i-proximity-start').onchange = e => {
    const v = Math.round(+e.target.value);
    if (v >= 200 && v <= 5000) {
      State.settings.proximityStartM = v;
      State.saveSettings();
      const mid = Math.round(v * 0.5);
      const final = Math.round(v * 0.2);
      Utils.toast(`Ping bands: ${v}m → ${mid}m → ${final}m`, 'good');
    }
  };
  // v22.76: here-now announcement — speed threshold + repeat count
  document.getElementById('i-here-speed').onchange = e => {
    const v = Math.round(+e.target.value);
    if (v >= 20 && v <= 300) {
      State.settings.hereSpeedThreshold = v;
      State.saveSettings();
      Utils.toast(`Here ring: ≥${v} km/h → 100m, else → 50m`, 'good');
    }
  };
  document.getElementById('i-here-repeat').onchange = e => {
    const v = Math.round(+e.target.value);
    if (v >= 1 && v <= 10) {
      State.settings.hereRepeatCount = v;
      State.saveSettings();
      Utils.toast(`Here-now × ${v}`, 'good');
    }
  };
  document.getElementById('i-gh-token').onchange = e => { State.gh.token = e.target.value.trim(); State.saveGh(); UI.updateBackupStatus(); };
  document.getElementById('i-gh-repo').onchange = e => { State.gh.repo = e.target.value.trim(); State.saveGh(); UI.updateBackupStatus(); };
  document.getElementById('i-gh-path').onchange = e => { State.gh.path = e.target.value.trim() || 'road-alert.json'; State.saveGh(); };
  // v22.93: backup/restore handlers run the buttons through a .loading
  // state so the user can see the request is in flight (spinner on the
  // right of the label, button greyed + non-interactive). Original label
  // is restored after the promise settles, success or fail.
  const _withLoading = async (btnId, label, fn) => {
    const btn = document.getElementById(btnId);
    if (!btn) { return fn(); }
    const orig = btn.textContent;
    btn.classList.add('loading');
    btn.textContent = label;
    try { return await fn(); }
    finally {
      btn.classList.remove('loading');
      btn.textContent = orig;
    }
  };
  document.getElementById('btn-backup-now').onclick = () => {
    _withLoading('btn-backup-now', '☁ Backing up…', () => Backup.push());
  };
  // v22.30: Restore — confirm first (destructive)
  // v22.104: now in-app UI.confirm (intent) + Backup.pull's second
  // validation/report confirm (post-fetch). Backup._pulling guards
  // against parallel pulls.
  document.getElementById('btn-restore').onclick = async () => {
    if (!State.gh.token || !State.gh.repo || !State.gh.path) {
      Utils.toast('Set token/repo/path first', 'bad');
      return;
    }
    const ptCount = State.data.points.length;
    const dCount = State.data.destinations.length;
    const msg = (ptCount > 0 || dCount > 0)
      ? `Replace local data?\n\nCurrent: ${ptCount} points, ${dCount} destinations.\nThis cannot be undone.`
      : `Restore from GitHub?`;
    const ok = await UI.confirm(msg, { title: 'Restore from GitHub', okLabel: 'Restore' });
    if (!ok) return;
    _withLoading('btn-restore', '⬇ Restoring…', () => Backup.pull());
  };
  // v23.9.8: Reset database — clears local points + destinations only.
  // Keeps app settings + GitHub config. Leaves the remote backup
  // untouched so Restore can undo it. Confirmation required.
  const _resetLocalData = () => {
    State.data = Storage.defaultData();
    State.saveData();
    // Clear runtime alert / pass trackers so stale markers don't linger.
    try {
      State.alertedMarkers.clear();
      State.lastDistByPoint.clear();
      State.minDistByPoint.clear();
      State.passedPoints.clear();
      if (State.passedDistByPoint) State.passedDistByPoint.clear();
    } catch (e) {}
    if (MapView.m) { MapView._lastPointRefresh = 0; MapView.updatePoints(); }
    try { UI.renderTimeline(); } catch (e) {}
    try { UI.render(); } catch (e) {}
    UI.syncSettings();
  };
  document.getElementById('btn-reset-data').onclick = async () => {
    const ptCount = State.data.points.length;
    const dCount = State.data.destinations.length;
    const ok = await UI.confirm(
      `Clear ALL local data?\n\nDeletes ${ptCount} point${ptCount === 1 ? '' : 's'} and ${dCount} destination${dCount === 1 ? '' : 's'} from this device.\n\nYour GitHub backup is NOT touched — you can Restore it afterward. App settings and GitHub config are kept.`,
      { title: 'Reset database', okLabel: 'Reset' }
    );
    if (!ok) return;
    _resetLocalData();
    Utils.toast('Local database reset', 'good');
    try { logEvent('DATA', `[DATA] local database reset — ${ptCount} points + ${dCount} destinations cleared`); } catch (e) {}
  };
  // v23.9.8: New database — clears local data AND pushes the empty
  // database to GitHub, replacing the remote backup with a clean slate.
  document.getElementById('btn-new-database').onclick = async () => {
    if (!State.gh.token || !State.gh.repo || !State.gh.path) {
      Utils.toast('Set token/repo/path first', 'bad');
      return;
    }
    const ptCount = State.data.points.length;
    const dCount = State.data.destinations.length;
    const ok = await UI.confirm(
      `Create a NEW empty database?\n\nClears ${ptCount} point${ptCount === 1 ? '' : 's'} and ${dCount} destination${dCount === 1 ? '' : 's'} locally, then pushes the empty database to GitHub (${State.gh.path}), overwriting the backup.\n\nThis cannot be undone.`,
      { title: 'Create new database', okLabel: 'Create' }
    );
    if (!ok) return;
    _resetLocalData();
    await _withLoading('btn-new-database', '✨ Creating…', async () => {
      const pushed = await Backup.push();
      if (pushed) Utils.toast('New empty database created + backed up', 'good');
      else Utils.toast('Local reset done — GitHub push failed', 'bad');
    });
    try { logEvent('DATA', `[DATA] new database created — local cleared (${ptCount} pts / ${dCount} dests) + empty pushed to GitHub`); } catch (e) {}
  };
  document.getElementById('trip-toggle').onclick = () => UI.toggleTrip();
  document.getElementById('trip-list').onclick = () => { UI.renderTripsList(); UI.openModal('m-trips'); };

  document.getElementById('btn-audit').onclick = () => { UI.renderAuditList(); UI.openModal('m-audit'); };
  document.getElementById('btn-disabled').onclick = () => { UI.renderDisabledList(); UI.openModal('m-disabled'); };
  document.getElementById('btn-export').onclick = () => exportJson();
  document.getElementById('btn-import').onclick = () => document.getElementById('import-file').click();
  document.getElementById('import-file').onchange = e => importJson(e);
  document.getElementById('btn-edit-json').onclick = () => {
    document.getElementById('json-text').value = JSON.stringify(State.data, null, 2);
    UI.openModal('m-json');
  };
  // v22.104: route JSON-editor save through Validator + UI.confirm so the
  // user sees the pre-apply sanitization report. Cancel leaves local data
  // unchanged.
  document.getElementById('btn-json-save').onclick = async () => {
    let parsed;
    try {
      parsed = JSON.parse(document.getElementById('json-text').value);
    } catch (e) { Utils.toast(e.message, 'bad'); return; }
    const val = Validator.validateImport(parsed);
    if (!val.ok) { Utils.toast(val.report, 'bad'); return; }
    const ok = await UI.confirm(val.report, {
      title: 'JSON edit — apply this data?',
      okLabel: 'Apply',
    });
    if (!ok) { Utils.toast('JSON edit cancelled', 'bad'); return; }
    State.data = val.sanitized.data;
    if (val.sanitized.settings) State.settings = Object.assign({}, State.settings, val.sanitized.settings);
    if (Array.isArray(val.sanitized.trips)) State.trips = val.sanitized.trips;
    State.saveData();
    State.saveSettings();
    State.saveTrips();
    UI.closeAllModals();
    Utils.toast('Saved', 'good');
  };
  document.getElementById('btn-json-copy').onclick = async () => {
    const ta = document.getElementById('json-text');
    try { await navigator.clipboard.writeText(ta.value); Utils.toast('Copied'); }
    catch (e) { ta.select(); document.execCommand('copy'); Utils.toast('Copied'); }
  };
  document.getElementById('btn-export-trips').onclick = () => {
    downloadFile(`road-alert-trips-${Date.now()}.json`, JSON.stringify(State.trips, null, 2));
  };
  document.getElementById('btn-clear-trips').onclick = async () => {
    // v22.104: native confirm() blocked on iOS Safari → in-app modal.
    const ok = await UI.confirm('Clear all trips?', { title: 'Clear trips' });
    if (!ok) return;
    State.trips = [];
    State.saveTrips();
    UI.renderTripsList();
  };
  document.getElementById('btn-test-sound').onclick = () => {
    Audio.unlock();
    UI.openSoundCheck();
  };
  // v23.6.2: removed the #btn-sound-alerts handler — the 18-row Sound
  // Alerts table is now inline in Settings, rendered by syncSettings.
  // v22.99: clear cache & hard reload
  document.getElementById('btn-clear-cache').onclick = async () => {
    const ok = await UI.confirm('Clear cache and reload the page? Your saved data is not affected.');
    if (!ok) return;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      logEvent('CACHE', 'cleared service workers + caches', 'ok');
    } catch (e) {
      logEvent('CACHE', 'clear failed: ' + (e && e.message || e), 'err');
    }
    const url = new URL(window.location.href);
    url.searchParams.set('_cb', Date.now().toString());
    window.location.replace(url.toString());
  };
  // v22.8: Sound check test buttons
  document.getElementById('sc-tone').onclick = () => {
    Audio.unlock();
    Audio.beep('petrol');
  };
  document.getElementById('sc-tone-cam').onclick = () => {
    Audio.unlock();
    Audio.beep('speed_camera');
  };
  document.getElementById('sc-voice').onclick = () => {
    Audio.unlock();
    Audio.say('Speed camera in 500 meters');
  };
  document.getElementById('sc-alert').onclick = () => {
    Audio.unlock();
    // Build a fake point and call alert() once
    Audio.alert({ name: 'Speed camera', type: 'speed_camera' }, 500);
  };
  document.getElementById('sc-repeat').onclick = () => {
    Audio.unlock();
    // Temporarily run a 3-rep test regardless of settings
    const original = { count: State.settings.alertRepeatCount, gap: State.settings.alertRepeatGapS };
    State.settings.alertRepeatCount = 3;
    State.settings.alertRepeatGapS = 1.5;
    Audio.alert({ name: 'Test', type: 'speed_camera' }, 500);
    // Restore after the test finishes
    setTimeout(() => {
      State.settings.alertRepeatCount = original.count;
      State.settings.alertRepeatGapS = original.gap;
    }, 5500);
  };
  // v22.12: force-alert the nearest point ahead — useful while driving to
  // verify the alert pipeline is actually firing for real data.
  document.getElementById('sc-near').onclick = () => {
    Audio.unlock();
    const ahead = Alerts.ahead();
    if (!ahead.length) {
      Utils.toast('No point ahead to alert for', 'bad');
      return;
    }
    const n = ahead[0];
    const meters = Math.round(n.dist * 1000);
    Utils.toast(`Forcing alert: ${n.name} @ ${meters}m`, 'good');
    Audio.alert(n, meters);
  };

  document.querySelectorAll('[data-close]').forEach(b =>
    b.onclick = () => UI.closeAllModals()
  );
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) UI.closeAllModals(); })
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Existing v22 behavior — request wake lock on resume during a GPS session.
    if (State.mode === 'gps') {
      GPS.requestWakeLock();
    }
    // v23.5 Phase 4: iOS Safari suspension handling. On resume:
    //   - re-check the pending backup retry queue and drain it
    //   - refresh the offline indicator from current monitor state
    //   - the next real fetch (route or backup) will re-confirm
    //     network state authoritatively
    // Reuses this single visibilitychange listener — no parallel
    // resume path is added.
    try {
      const hasPending = BackupQueue.hasPending();
      logEvent('OFFLINE-RESUME',
        `[OFFLINE-RESUME] visibility=visible · backupQueue=${hasPending ? 'pending' : 'empty'}`);
      if (hasPending) {
        // fire-and-forget; drain handles its own logging
        BackupQueue.drain();
      }
      UI.applyOfflineIndicator();
    } catch (e) {
      logEvent('OFFLINE-RESUME', '[OFFLINE-RESUME] handler threw: ' + (e && e.message || e), 'err');
    }
  });
}

/* ============================================================
   10. IMPORT / EXPORT
   ============================================================ */
function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  downloadFile(`road-alert-${Date.now()}.json`,
    JSON.stringify({ data: State.data, settings: State.settings, trips: State.trips }, null, 2));
  Utils.toast('Exported', 'good');
}

function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  // v22.104: validator-gated merge. The user sees a pre-apply sanitization
  // report and confirms. Cancel leaves local data unchanged. Existing data
  // is preserved by id-merging only the sanitized rows.
  reader.onload = async () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch (err) { Utils.toast(err.message, 'bad'); return; }
    const val = Validator.validateImport(parsed);
    if (!val.ok) { Utils.toast(val.report, 'bad'); return; }
    const ok = await UI.confirm(val.report, {
      title: 'Import — merge into local data?',
      okLabel: 'Import',
    });
    if (!ok) { Utils.toast('Import cancelled', 'bad'); return; }
    const existingDestIds = new Set(State.data.destinations.map(d => d.id));
    const existingPtIds = new Set(State.data.points.map(p => p.id));
    let dAdded = 0, pAdded = 0;
    (val.sanitized.data.destinations || []).forEach(d => {
      if (d.id && !existingDestIds.has(d.id)) { State.data.destinations.push(d); dAdded++; }
    });
    (val.sanitized.data.points || []).forEach(p => {
      if (!existingPtIds.has(p.id)) { State.data.points.push(p); pAdded++; }
    });
    if (val.sanitized.settings) State.settings = { ...State.settings, ...val.sanitized.settings };
    if (Array.isArray(val.sanitized.trips)) State.trips = val.sanitized.trips;
    State.saveData();
    State.saveSettings();
    State.saveTrips();
    Utils.toast(`Imported: ${dAdded} dests, ${pAdded} pts`, 'good');
    UI.render();
    UI.applyTheme();
    MapView.updatePoints();
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* ============================================================
   11. BOOT
   ============================================================ */
/** Push APP_VERSION into every visible surface. Safe to call before any
 *  particular element exists — each write is independently null-guarded
 *  so a missing node never aborts the rest. */
function applyAppVersion() {
  try { document.title = 'X ' + APP_VERSION; } catch (e) {}
  const label = document.getElementById('app-version-label');
  if (label) label.textContent = APP_VERSION;
  const dbg = document.getElementById('debug-version');
  if (dbg) dbg.textContent = APP_VERSION;
}

function boot() {
  try {
    // Single source of truth — populate every visible surface from
    // APP_VERSION. Each DOM write is null-guarded so a missing element
    // (test harness, partial DOM) never aborts boot.
    applyAppVersion();
    logEvent('APP', `Version ${APP_VERSION} loaded`, 'ok');
    // v23.4.1: boot-time safety check. If intelMode was active or shadow
    // and the engine fails to evaluate a probe, bootCheck reverts to
    // legacy and logs [INTEL-MODE] fallback-to-legacy. Always returns the
    // effective mode (post-fallback if needed).
    let effectiveIntelMode = 'legacy';
    try {
      effectiveIntelMode = IntelligenceEngine.bootCheck();
    } catch (e) {
      logEvent('INTEL-MODE', `[INTEL-MODE] fallback-to-legacy · bootCheck threw: ${e && e.message || e}`, 'err');
      try { State.settings.intelMode = 'legacy'; State.saveSettings(); } catch (e2) {}
    }
    logEvent('INTEL-MODE', `[INTEL-MODE] boot · ${effectiveIntelMode}`,
      effectiveIntelMode === 'active' ? 'ok' : '');
    if (effectiveIntelMode === 'active') {
      logEvent('INTEL-MODE', '[INTEL-MODE] active', 'ok');
    }
    RouteMemory.cleanupExpiredRoutes();
    UI.applyTheme();
    UI.applyHintsVisibility(); // v23.0.1: respect saved show/hide preference
    UI.applyIntelIndicator();  // v23.4.1: paint the top-bar engine chip
    // v23.5 Phase 4: prime the network monitor from the navigator hint,
    // paint the offline chip, and opportunistically drain any backup
    // retry queue left over from a previous (suspended/closed) session.
    try {
      const init = (typeof navigator !== 'undefined' && navigator.onLine !== false);
      NetworkMonitor.recordNavigatorOnline(init);
      UI.applyOfflineIndicator();
      if (BackupQueue.hasPending()) {
        const entry = BackupQueue.inspect();
        logEvent('OFFLINE-BACKUP',
          `[OFFLINE-BACKUP] queue restored from previous session · attempts=${entry.attempts} · since ${entry.queuedAt} · last="${entry.lastError}"`);
        // fire-and-forget; success or failure both update the chip
        BackupQueue.drain();
      }
    } catch (e) {
      logEvent('OFFLINE', '[OFFLINE] boot prime threw: ' + (e && e.message || e), 'err');
    }
    // v23.1.1: live online/offline cell in diag-strip. Re-render on the
    // connectivity events so the indicator flips immediately, not on the
    // next GPS tick. Log so the debug panel records the transition.
    window.addEventListener('online',  () => {
      logEvent('NET', 'online',  'ok');
      try { NetworkMonitor.recordNavigatorOnline(true); } catch (e) {}
      UI.renderDiagStrip();
      UI.applyOfflineIndicator();
      // Drain the persistent backup queue opportunistically.
      try { if (BackupQueue.hasPending()) BackupQueue.drain(); } catch (e) {}
    });
    window.addEventListener('offline', () => {
      logEvent('NET', 'offline', 'err');
      try { NetworkMonitor.recordNavigatorOnline(false); } catch (e) {}
      UI.renderDiagStrip();
      UI.applyOfflineIndicator();
    });
    wire();
    // v23.6.4: pre-populate the Sound Alerts inline table at boot so it's
    // ready before the user even opens Settings. Robust against future
    // wire/sync timing bugs.
    try { UI.renderSoundAlerts(); } catch (e) {
      try { logEvent('SOUND', '[SOUND] boot render threw: ' + (e && e.message || e), 'err'); } catch (err) {}
    }
    // v22.82: try to subscribe to the device compass. iOS will defer the
    // actual permission request to the first user tap.
    GPS.setupDeviceOrientation();
    UI.render();
    UI.updateFollowPill();
    UI.updateSoundIcon();
    UI.updateThemeIcon();
    UI.updateLongPressBtn(); // v22.56: restore long-press toggle icon
    UI.renderMarkerChips(); // v22.17: paint chips immediately so they're ready when settings opens
    MapView.init();
    // v22.54: restore 🧭 button state
    const navBtn = document.getElementById('btn-nav');
    if (navBtn) navBtn.classList.toggle('on', !!State.settings.navMode);
    // v22.78: restore 3D button state. The actual camera pitch is applied
    // inside MapView.init's 'load' handler once the map is ready.
    // v22.80: also set the label so it reads correctly before the map loads.
    const pitchBtn = document.getElementById('btn-pitch');
    if (pitchBtn) {
      pitchBtn.classList.toggle('on', !!State.settings.pitchMode);
      pitchBtn.textContent = State.settings.pitchMode ? '2D' : '3D';
    }
    // v22.83: apply the compass visibility setting from storage. The
    // updateCompass call inside MapView's load handler will then style
    // the rose correctly once the map is ready.
    const compassBtn = document.getElementById('btn-compass');
    if (compassBtn) compassBtn.hidden = State.settings.showCompass === false;
    if (State.settings.autoBackup) Backup.start();
    setInterval(() => { if (State.settings.theme === 'auto') UI.applyTheme(); }, 60 * 60 * 1000);
    // v22: driving safety reminder, once per device
    if (!localStorage.getItem(Storage.KEYS.safetyShown)) {
      setTimeout(() => {
        Utils.toast('Set up while parked. Drive safely.', 'good');
        try { localStorage.setItem(Storage.KEYS.safetyShown, '1'); } catch (e) {}
      }, 1500);
    }
  } catch (e) {
    console.error('Boot error', e);
    Utils.toast('Boot error: ' + e.message, 'bad');
    try { logEvent('BOOT', 'Error: ' + e.message, 'err'); } catch (_) {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

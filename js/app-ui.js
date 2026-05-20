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
        touchPitch: false,    // no 2-finger pitch
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
    const sideHtml = p.side ? `<span class="side">${p.side === 'left' ? 'L' : 'R'}</span>` : '';
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
    el.innerHTML = `<div class="${classes.join(' ')}">${Utils.emoji(p.type, p.subtype)}${sideHtml}${confHtml}</div>`;
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
    State.activePoints().forEach(p => {
      const passedByGeometry = (myDist != null && dest)
        ? Utils.distKm(p, dest) > myDist
        : false;
      const passedByTracker = State.passedPoints.has(p.id);
      const passed = passedByGeometry || passedByTracker;
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
    State.activePoints().forEach(p => extend(p.lat, p.lng));
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
      })
      .catch(e => {
        console.warn('Route fetch failed:', e);
        const msg = (e && e.message) || String(e);
        if (this._isReroute) {
          logEvent('ROUTE', 'reroute failed: ' + msg, 'err');
          this._isReroute = false;
        } else {
          logEvent('ROUTE', 'Fetch failed: ' + msg, 'err');
        }
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
    if (!this.m || !this._mapLoaded) return;
    if (!State.pos) return;
    if (!this._routeCoords || this._routeCoords.length < 2) return;
    if (this._routeFetching) return;
    const dest = State.activeDest();
    if (!dest) return;

    const now = Date.now();

    // v22.97: GPS accuracy gate — don't make routing decisions on a poor
    // fix. The check still runs every GPS update; we just refuse to
    // strike or trigger when the position itself is too noisy.
    if (State.accuracy != null && State.accuracy > this._offRouteAccuracyMaxM) {
      if (!this._lastDevDistLogAt || now - this._lastDevDistLogAt > 5000) {
        this._lastDevDistLogAt = now;
        logEvent('ROUTE', `GPS update · accuracy ±${Math.round(State.accuracy)}m > ${this._offRouteAccuracyMaxM}m — deviation check skipped`);
      }
      return;
    }

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
    logEvent('ROUTE', `off-route strike ${this._offRouteStrikes}/${this._offRouteStrikesRequired}: ${Math.round(distM)}m from route`);

    // Need N consecutive strikes before we trigger
    if (this._offRouteStrikes < this._offRouteStrikesRequired) return;

    // Debounce — only one auto-reroute per cooldown window
    const sinceLast = now - this._lastRefetchAt;
    if (sinceLast < this._rerouteCooldownMs) {
      if (!this._loggedDebounceAt || now - this._loggedDebounceAt > 5000) {
        this._loggedDebounceAt = now;
        const left = Math.ceil((this._rerouteCooldownMs - sinceLast) / 1000);
        logEvent('ROUTE', `reroute skipped — debounce (${left}s remaining)`);
      }
      return;
    }

    // Fire the reroute. Reset strikes so we don't fire again on the very
    // next tick before the fetch even completes.
    this._lastRefetchAt = now;
    this._offRouteStrikes = 0;
    this._isReroute = true;
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

  /** v22.58: render the right-side captured-points timeline rail.
   *  Reuses Utils.emoji / Utils.typeLabel / Utils.fmtAgo from app-core.js.
   *  Each entry shows emoji + short type label + abbreviated time-ago.
   *  Tap an entry → opens the point editor (same as map-marker popup). */
  // v22.65: remember which point was at the top of the sidebar last
  // render, so we can smooth-scroll back to top when the focused (closest)
  // point shifts to a new one.
  _lastFocusedTimelineId: null,

  renderTimeline() {
    const rail = document.getElementById('tools-rail');
    if (!rail) return;

    // v22.66: simple distance sort — order ALL active points by how far
    // they are from the current GPS position, nearest first. No direction
    // filtering, no destination-based "ahead" check — just raw distance.
    // Falls back to chronological order when GPS is off.
    const myPos = State.pos;
    let pts;
    if (myPos) {
      pts = State.activePoints()
        .filter(p => p.status !== 'no')
        .map(p => ({ ...p, dist: Utils.distKm(myPos, p) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 50);
    } else {
      pts = State.activePoints()
        .filter(p => p.status !== 'no')
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, 50);
    }

    if (!pts.length) {
      rail.innerHTML = '<div class="timeline-empty">No captures yet</div>';
      this._lastFocusedTimelineId = null;
      return;
    }

    // v22.60: bake ahead-rank class so the sidebar mirrors the map markers'
    // flash/pulse. MapView.updateAheadRanks also patches these every tick.
    const aheadList = (typeof Alerts !== 'undefined') ? Alerts.ahead() : [];
    const aheadIds = new globalThis.Map();
    aheadList.slice(0, 3).forEach((a, idx) => aheadIds.set(a.id, idx + 1));

    // v22.65: distance tier thresholds align with proximity ping bands.
    const startM = +State.settings.proximityStartM || 1000;
    const finalM = startM * 0.2;

    rail.innerHTML = pts.map(p => {
      const short = (Utils.typeLabel(p.type) || '').split(' ')[0].slice(0, 4);
      let distText, distCls = '', tierCls = '';
      if (myPos) {
        const km = (p.dist != null) ? p.dist : Utils.distKm(myPos, p);
        const distM = km * 1000;
        if (km < 1) distText = Math.round(distM) + 'm';
        else if (km < 10) distText = km.toFixed(1) + 'km';
        else distText = Math.round(km) + 'km';
        // Tier color: green far, orange mid, red near
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
    // v22.74: separate handlers for edit-tap vs delete-tap, with the
    // delete button stopping propagation so it doesn't open the editor.
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
        // Skip if the user actually tapped the × delete button
        if (ev.target.classList && ev.target.classList.contains('tl-x')) return;
        UI.openPointEditor(el.dataset.tlEdit);
      };
    });

    // v22.65: auto-scroll the rail back to top whenever the focused
    // (closest) point shifts to a new one. Only fires on focus CHANGE
    // so manual scrolling to peek at further entries isn't snapped back
    // every tick.
    const focusedId = pts[0] && pts[0].id;
    if (focusedId && this._lastFocusedTimelineId !== focusedId) {
      this._lastFocusedTimelineId = focusedId;
      try {
        rail.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) {
        rail.scrollTop = 0;
      }
    }
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
      if (State.mode === 'idle') {
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
      const dest = MapView._routeDestCoords;
      const distM = MapView._routeDistanceM;
      const durS = MapView._routeDurationS;
      if (!dest || !State.pos || !distM || !durS) {
        etaEl.textContent = 'ETA —';
        etaEl.className = '';
      } else {
        const avgSpeedMs = distM / durS; // m/s implied by OSRM
        const straightM = Utils.distKm(State.pos, dest) * 1000;
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
  },

  renderRouteBar() {
    const d = State.activeDest();
    document.getElementById('route-name').textContent = d ? d.name : 'Pick a destination';
  },

  renderStats() {
    const limit = Alerts.currentLimit();
    document.getElementById('sign-value').textContent = limit != null ? limit : '—';
    const kmh = Math.round(State.speedMps * 3.6);
    const speedo = document.getElementById('speedo-val');
    speedo.textContent = kmh;
    const isOver = limit != null && kmh > limit + State.settings.overBy;
    speedo.classList.toggle('over', isOver);
    // v22.27: auto-shrink font when speed reaches 3 digits so it never overflows the card
    speedo.classList.toggle('three-digit', kmh >= 100);

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
    document.getElementById('status-pts').textContent =
      `${State.activePoints().filter(p => p.status !== 'no').length} pts`;
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
    if (State.settings.sound !== 'off') Audio.beep(nearest.type);
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
    if (State.settings.sound !== 'off') Audio.beep(point.type);
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
    if (!State.data.activeDestId) {
      Utils.toast('Pick a destination before capturing', 'bad');
      this.closeAllModals();
      this.renderRoutesList();
      this.openModal('m-routes');
      return;
    }
    State.pendingCapture = {
      id: Utils.uid(),
      type,
      name: Utils.typeLabel(type),
      lat: +loc.lat.toFixed(5),
      lng: +loc.lng.toFixed(5),
      status: 'active',
      confidence: 1,
      destId: State.data.activeDestId,
      createdAt: new Date().toISOString(),
    };
    this.closeAllModals();
    // v22.25: pole + spider speed cams also need a side selection
    if (type === 'speed_camera' || type === 'mobile_camera' ||
        type === 'pole_camera'  || type === 'spider_camera') this.openModal('m-side');
    else if (type === 'speed_change') this.openLimitPicker('speedchange');
    else if (type === 'other') this.openModal('m-other');
    else this.finalizeCapture();
  },

  openLimitPicker(mode) {
    State.limitPickerMode = mode || 'manual';
    document.getElementById('limit-title').textContent =
      mode === 'speedchange' ? 'New speed limit (km/h)' : 'Set current speed limit';
    document.getElementById('limit-clear').style.display =
      mode === 'manual' ? 'block' : 'none';
    const grid = document.getElementById('limit-grid');
    grid.innerHTML = [30,40,50,60,70,80,90,100,110,120,130,140].map(L =>
      `<button class="limit-pick" data-limit="${L}">${L}</button>`
    ).join('');
    grid.querySelectorAll('[data-limit]').forEach(b =>
      b.onclick = () => {
        const val = +b.dataset.limit;
        if (State.limitPickerMode === 'manual') {
          State.manualLimit = val;
          UI.closeAllModals();
          UI.render();
          Utils.toast('Limit set to ' + val, 'good');
        } else if (State.pendingCapture) {
          State.pendingCapture.limit = val;
          State.pendingCapture.name = `Speed → ${val}`;
          UI.closeAllModals();
          UI.finalizeCapture();
        }
      }
    );
    document.getElementById('limit-custom').value = '';
    this.openModal('m-limit');
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
    }
    const nearby = State.data.points.find(p =>
      p.type === c.type && p.destId === c.destId && Utils.distKm(p, c) * 1000 < 100
    );
    let announce;
    let trackedId;
    if (nearby) {
      const n = (nearby.confidence || 0) + 1;
      nearby.lat = +((nearby.lat * (n - 1) + c.lat) / n).toFixed(5);
      nearby.lng = +((nearby.lng * (n - 1) + c.lng) / n).toFixed(5);
      nearby.confidence = n;
      nearby.status = 'active';
      if (c.side) nearby.side = c.side;
      if (c.limit) { nearby.limit = c.limit; nearby.name = c.name; }
      Utils.toast(`${Utils.typeLabel(c.type)} merged (×${n})`, 'good');
      announce = Utils.typeLabel(c.type) + ' updated';
      trackedId = nearby.id;
      logEvent('CAPTURE', `${Utils.typeLabel(c.type)} merged (×${n}) @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)}`, 'ok');
    } else {
      // v22.101: route via State.addPointToActiveDest so the new id is
      // appended to dest.routePointRefs[] post-migration. Direct
      // State.data.points.push left captures invisible to activePoints().
      State.addPointToActiveDest(c);
      Utils.toast(`${Utils.typeLabel(c.type)} saved`, 'good');
      announce = Utils.typeLabel(c.type) + ' captured';
      trackedId = c.id;
      logEvent('CAPTURE', `${Utils.typeLabel(c.type)} @ ${c.lat.toFixed(4)},${c.lng.toFixed(4)}`, 'ok');
    }
    State.lastTripCaptureId = trackedId; // v22.10: track for double-tap recall
    State.pendingCapture = null;
    State.captureLocationOverride = null; // v22.39: clear map-tap override
    State.saveData();
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
    this.togglePEFields();
    this.openModal('m-edit');
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
    if (lim && p.type === 'speed_change') { p.limit = +lim; p.speedLimit = +lim; }
    else { delete p.limit; delete p.speedLimit; }
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
      `Delete "${name}"?` + (ptCount > 0 ? `\n\n${ptCount} captured points are tagged to this destination and will become orphans (still in storage, hidden from the map).` : ''),
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
    const pts = State.activePoints();
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

  syncSettings() {
    // v22.26: scope to settings buttons only — bare [data-theme] also matches <body>
    document.querySelectorAll('#theme-opts [data-theme]').forEach(b =>
      b.classList.toggle('active', b.dataset.theme === State.settings.theme));
    document.querySelectorAll('[data-sound]').forEach(b =>
      b.classList.toggle('active', b.dataset.sound === State.settings.sound));
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
  },

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
    UI.syncSettings();
    UI.renderMigrationStatus(); // v22.96: refresh migration status on open
    UI.openModal('m-settings');
  };
  // v22.96: data architecture migration wiring
  document.getElementById('btn-migrate-dry').onclick = () => UI.openMigrationDryRun();
  document.getElementById('btn-migrate-restore').onclick = () => UI.doMigrationRestore();
  document.getElementById('btn-do-migrate').onclick = () => UI.doMigration();
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
  document.getElementById('btn-fit-top').onclick = () => MapView.fitAll();
  document.getElementById('btn-recenter-top').onclick = () => MapView.recenter();
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
  document.getElementById('sign').onclick = () => UI.openLimitPicker('manual');

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
    if (!v || v < 10 || v > 250) { Utils.toast('Invalid limit', 'bad'); return; }
    if (State.limitPickerMode === 'manual') {
      State.manualLimit = v;
      UI.closeAllModals();
      UI.render();
      Utils.toast('Limit set to ' + v, 'good');
    } else if (State.pendingCapture) {
      State.pendingCapture.limit = v;
      State.pendingCapture.name = `Speed → ${v}`;
      UI.closeAllModals();
      UI.finalizeCapture();
    }
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

  document.getElementById('e-type').onchange = () => UI.togglePEFields();
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
    if (document.visibilityState === 'visible' && State.mode === 'gps') {
      GPS.requestWakeLock();
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
    RouteMemory.cleanupExpiredRoutes();
    UI.applyTheme();
    UI.applyHintsVisibility(); // v23.0.1: respect saved show/hide preference
    wire();
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

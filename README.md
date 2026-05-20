# X

**A local-first road observation intelligence system.**

X is not a navigation app. It is not a social platform. It is not a
Google Maps clone. It is a single-page PWA that records, scores, and
re-surfaces driver-captured road observations — speed limits, cameras,
hazards — so the driver's own accumulated knowledge of the road becomes
the alert system.

All data lives in the browser. There is no backend. There are no
accounts. There are no paid APIs.

---

## 1. Project Overview

- **Local-first**. State is held in `localStorage`. The app loads,
  runs, and alerts entirely offline once the page is cached. Optional
  GitHub backup is opt-in and uses a user-supplied fine-grained token.
- **Road-memory intelligence**. Every captured point is treated as an
  observation. Repeated observations of the same physical reality
  strengthen confidence in it; absence of re-observation weakens it.
- **Confidence-based alerts**. The decision to alert is not "is there
  a point within X metres" but "is there a trusted point ahead, on
  this road, in this direction, that has not yet been announced for
  this approach."
- **Offline resilience**. Map tiles, GPS, scoring, and audio all
  function without network. Network is used only for the optional
  OSRM routing fetch and the optional GitHub backup.
- **Repeated observation learning**. Captures within a small radius
  and matching direction merge into the existing point and increment
  its confidence rather than spawning a duplicate. Routes the driver
  actually completes are promoted to "confirmed" memory and suggested
  next time.

---

## 2. Core Philosophy

The core primitive is an **observation**, not a marker.

- First observation = **possible**.
- Second observation = **probable**.
- Third observation = **trusted**.

Two reliability invariants drive every design decision:

- **One false alert damages trust.**
- **One missed alert damages trust more.**

Driver trust is the single highest priority. Reliability,
accuracy, responsiveness, offline resilience, and low distraction
are valued above feature count. A feature that introduces noise or
ambiguity is a regression even if the code is correct.

---

## 3. System Architecture

X is intentionally small and explicit.

### Files

- `index.html` — shell + all modals. No build step. Loaded directly.
- `styles.css` — all visual rules. Dark theme + amber accent. Single
  stylesheet, no preprocessor.
- `js/app-core.js` — non-UI logic in named modules: `Utils`, `Logger`,
  `Speed`, `Migration`, `Corridor`, `RouteMemory`, `Validator`,
  `Storage`, `State`, `Audio`, `GPS`, `Alerts`, `Confirm`, `Backup`.
- `js/app-ui.js` — `MapView`, `UI`, wiring, boot.
- No bundler, no transpiler, no framework, no package.json, no
  node_modules.

### Persistence

- `localStorage` only. Keys are namespaced under `roadAlert.v22.*`.
  Keys are never renamed — renaming orphans existing user data.
- Optional GitHub backup writes a single JSON blob via the Contents
  API using a fine-grained token. Restore goes through the
  `Validator` pre-apply report and a user confirmation.

### GPS observation engine

- `navigator.geolocation.watchPosition` feeds `GPS.onTick`.
- Each tick updates `State.pos`, `State.accuracy`, `State.heading`,
  `State.speedMps`, rolling speed/heading history.
- Heading is preferred from the device compass
  (`DeviceOrientationEvent`) when available, falling back to GPS
  course-over-ground. Heading is treated as unreliable below 10 km/h.

### Confidence scoring

- `Speed.scoreSpeedPoint(user, point)` produces a 0–100 score by
  combining distance, ahead/behind direction, heading match with
  `captureBearing`, and road-type heuristics.
- Score ≥ 60 triggers an alert subject to per-point hysteresis
  (`Speed.shouldAlert` enforces a 30 s / 500 m cooldown per point).

### Route familiarity

- `RouteMemory` stores OSRM-fetched routes per destination. Entries
  carry `confirmed: boolean`.
- A route only becomes confirmed once the driver has actually reached
  the destination (`MapView._checkArrival`, 100 m radius).
- Only confirmed routes are auto-restored on a subsequent selection
  from the same origin (`ORIGIN_MATCH_KM`).

### Directional validation

- Every speed-change point records the heading at capture
  (`captureBearing`). On replay, the user's heading must align within
  ~45° for the point to participate in scoring or proximity fallback.
- Turning onto a side road clears the displayed limit because heading
  no longer matches.

### Stale data decay

- `RouteMemory` entries expire after 30 days and are pruned at boot.
- Speed-change points can be marked `no` and auto-retired after three
  negative confirmations.
- Audit + Disabled views let the driver curate the long tail.

### Offline-first behavior

- Tile fetches use MapLibre's HTTP cache; once loaded, the map keeps
  working through brief network drops.
- OSRM is best-effort. A failed fetch never blocks the rest of the
  app.
- Backup is the only feature that requires a working network and a
  user-configured token.

---

## 4. Operational Trust Model

The trust model is what separates X from a coordinate database.

- **Confidence scoring.** A point's influence is a function of
  distance, heading agreement, ahead/behind position, and
  road-type match — never raw proximity alone.
- **Repeated confirmations.** Re-capturing within a small radius and
  matching direction merges into the existing point and increments
  `confidence`. Three negative confirmations retire it.
- **Heading validation.** A point captured for a southbound carriage
  does not alert on a northbound approach. A point with no
  `captureBearing` (legacy data) is treated as neutral, not as a
  match.
- **GPS confidence filtering.** Off-route deviation checks are
  skipped when GPS accuracy is worse than ±30 m. The active
  re-route loop requires two consecutive off-route ticks plus a
  10 s cooldown.
- **Timestamp aging.** `createdAt` and `updatedAt` are preserved
  through merges (`oldest createdAt`, `newest updatedAt`) so the
  audit view shows the true history of each observation.
- **Stale observation decay.** Routes age out at 30 days; disabled
  points are visible only in the Disabled list, not the alert pool.
- **Route-context awareness.** When an active route exists, alert
  candidates are restricted to points inside the route corridor
  (`Corridor` helpers; full wiring deferred). Without a route, the
  global store is used directly.

---

## 5. Non-Negotiable Design Rules

The following are explicitly prohibited and must not be introduced,
even partially, without an architectural review.

- **No social features.** No comments, no upvotes, no shared
  observations, no leaderboards, no community feed.
- **No public sharing systems.** Backup is private to the
  user-supplied repo and token. Nothing is published.
- **No admin-heavy interfaces.** No multi-tab dashboards, no
  configuration trees, no role/permission UI.
- **No feature clutter.** Each screen earns its place by serving a
  driving moment, not by demonstrating capability.
- **No noisy dashboards.** No live charts, no animated counters, no
  decorative motion. The only motion is functional (route line,
  marker, alert pulse, audio).
- **No unnecessary modals.** A modal must own a discrete decision.
  Read-only information goes inline.
- **No analytics bloat.** No third-party SDKs, no ping endpoints,
  no telemetry, no fingerprinting.
- **No speculative abstractions.** No routing-provider interface, no
  storage-provider interface, no plugin system, no event bus until
  there are at least two concrete consumers.

Also out of scope: backend services, accounts, IndexedDB migration,
service worker, CSP/SRI tooling, Vite/Webpack, TypeScript, framework
adoption.

---

## 6. UI Philosophy

The UI is a cockpit, not a webpage.

- **Cockpit simplicity.** Every pixel is justified by a driving task.
  If a control is not used while driving or immediately before
  driving, it belongs in Settings, not on the main screen.
- **Low distraction.** Dark theme, amber accents, no decorative
  imagery. Motion only when it conveys state.
- **Dense but prioritized.** Speed, next-ahead point, and current
  limit are large and central. Captured-points rail, status line, and
  controls are secondary and visually quieter.
- **Single-screen operation.** The main screen never requires a
  scroll. Modals are reserved for capture, editing, settings, and
  audit. The map is always visible behind them when feasible.
- **Immediate visibility.** Alerts surface within one GPS tick of
  the triggering condition. No spinners on the alert path.
- **Fast interactions.** Capture is a long-press. Destination
  selection is one tap. Settings are deep but optional. No
  multi-step wizards.

---

## 7. Development Rules

These rules apply to human and AI contributors alike. They exist to
prevent drift and to keep the system understandable to a single
reader.

- **Inspect existing handlers before adding new ones.** Search for
  the event, the DOM id, and the data field. Most behavior already
  has a hook — extend it.
- **Extend existing logic instead of duplicating systems.** A new
  point type goes into `Utils.emoji` and `Utils.typeLabel`. A new
  alert rule goes into `Speed.scoreSpeedPoint`. Avoid creating
  parallel scoring engines, parallel storage layers, parallel route
  caches.
- **Avoid parallel state paths.** `State` is the single source of
  in-memory truth. `Storage` is the single persistence layer.
  `Logger` is the single event log. Introduce a new layer only when
  the existing one cannot model the requirement.
- **Avoid unnecessary refactors.** A rename, a file split, or an
  abstraction must close an active reliability or correctness
  problem. Style preferences are not justification.
- **Minimize dependencies.** No npm install. New runtime libraries
  must be loaded by CDN with a documented fallback and must pull
  their weight against the offline-first requirement.
- **Deterministic behavior preferred.** Sort before iterate when the
  result is persisted. Use stable ids, not array indexes. Avoid
  wall-clock comparisons inside scoring; prefer monotonic counters
  or explicit timestamps.
- **Bump the asset cache-bust on every commit that touches CSS or
  JS.** Stale cached assets are the single most common cause of
  apparent regressions on driver phones.
- **Never break saved data.** `localStorage` keys are append-only in
  practice. Migrations go through `Migration` with a dry-run, a
  backup, and a validation pass before the user is asked to commit.
- **Confirm destructive actions through `UI.confirm`.** Native
  `window.confirm` is silently blocked on iOS Safari and must not be
  used.

---

## 8. Versioning Rules

`APP_VERSION` in `js/app-core.js` is the single source of truth for
the application version. Every other surface must match it.

Surfaces that must stay in sync on every release:

- `APP_VERSION` constant in `js/app-core.js`.
- `<title>` in `index.html`.
- `<span class="version">` in the top bar of `index.html`.
- The README header / changelog entry, where applicable.
- The git commit message and, when used, the PR title.

The asset cache-bust query string (`?v=...` on `styles.css`,
`js/app-core.js`, `js/app-ui.js`) must be advanced on every commit
that modifies the CSS or JS, even when the user-facing version
number itself is not bumped. A build-suffix (`?v=22.104a`) is
acceptable for intra-version commits.

Boot log must read the version from `APP_VERSION` so the in-app
debug log and the visible UI never disagree.

---

## 9. Future Direction

The project evolves toward deeper road intelligence, not broader
feature coverage. Acceptable directions:

- **Confidence-based alerts.** Refining `Speed.scoreSpeedPoint`,
  adding road-class inference, integrating corridor filtering into
  the live alert path.
- **Route intelligence.** Smarter learned-route matching (origin
  clustering, time-of-day variants), arrival-confirmed promotion,
  graceful handling of partial drives.
- **Driver familiarity.** Tracking which roads the driver covers
  often so unfamiliar territory receives more conservative alerts
  than well-known commute paths.
- **Evidence accumulation.** Treating each tick on a known road as
  weak evidence about that road's speed regime; allowing
  observations to age, decay, and re-confirm without explicit user
  action.
- **Reliability over feature count.** Every change is evaluated
  against the two trust invariants in Section 2. A change that
  raises false-alert risk or miss risk must produce a proportionate
  reliability gain elsewhere, or it is not shipped.

Directions that are explicitly off the roadmap: social, sharing,
crowdsourcing across users, ad-supported tiers, cloud sync as the
primary persistence model, and any architecture that requires a
server to function.

---

## License

Personal project. No license granted. Do not redistribute.

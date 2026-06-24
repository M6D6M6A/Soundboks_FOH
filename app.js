(() => {
  "use strict";

  const UUIDS = {
    advertising: "f5c26570-64ec-4906-b998-6a7302879a2b",
    volumeService: "445b9ffb-348f-4e1b-a417-3559b8138390",
    volume: "7649b19f-c605-46e2-98f8-6c1808e0cfb4",
    teamUpService: "46c69d1b-7194-46f0-837c-ab7a6b94566f",
    teamUpMode: "37bffa18-7f5a-4c8d-8a2d-362866cedfad",
    teamUpToken: "64215c77-5e08-4d7e-a082-b99d8e6fe809",
    eqService: "3bbed7cf-287c-4333-9abf-2f0fbf161c79",
    eqState: "57a394fb-6d89-4105-8f07-bf730338a9b2",
    stereoRole: "7d0d651e-62ae-4ef2-a727-0e8f3e9b4dfb",
    secondaryStatus: "8d36814f-3741-4cb5-a018-ef4a2d8e24f1"
  };

  const LIMITS = [
    { name: "Home", minRaw: 0, maxRaw: 25 },
    { name: "Chill", minRaw: 0, maxRaw: 50 },
    { name: "Party", minRaw: 0, maxRaw: 255 }
  ];

  const EQ_PRESETS = ["dancefloor", "stage", "lounge", "custom"];
  const EQ_LABELS = {
    dancefloor: "Dancefloor",
    stage: "Stage",
    lounge: "Lounge",
    custom: "Custom"
  };
  const EQ_BANDS = ["63", "160", "400", "1k", "2.5k", "6.3k"];
  const ROLE_VALUES = ["M", "L", "R"];
  const TEAMUP_VALUES = ["solo", "host", "join"];
  const DEFAULT_EQ = { preset: "dancefloor", bands: [0, 0, 0, 0, 0, 0] };
  const DEFAULT_GROUPS = [
    {
      id: "front-pair",
      name: "Front Pair",
      speakerIds: [],
      requiresAllOnline: true,
      routingPreset: "left_right"
    }
  ];

  const state = {
    view: "dashboard",
    support: null,
    activeLimit: "Party",
    speakers: [],
    groups: structuredCloneSafe(DEFAULT_GROUPS),
    presets: [],
    diagnostics: [],
    clients: new Map(),
    writeTimers: new Map()
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  class SoundboksBleClient {
    constructor({ speakerId, device, onUpdate, onLog }) {
      this.speakerId = speakerId;
      this.device = device;
      this.server = null;
      this.characteristics = new Map();
      this.onUpdate = onUpdate;
      this.onLog = onLog;
    }

    async connect() {
      this.device.addEventListener("gattserverdisconnected", () => {
        this.onLog("disconnect", this.speakerId, "GATT server disconnected");
        this.onUpdate(this.speakerId, { connectionState: "disconnected" });
      });
      this.server = await this.device.gatt.connect();
      await this.cacheCharacteristics();
      await this.subscribe();
      return this.readState();
    }

    disconnect() {
      if (this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    }

    async cacheCharacteristics() {
      await this.cacheCharacteristic("volume", UUIDS.volumeService, UUIDS.volume);
      await this.cacheCharacteristic("teamUpMode", UUIDS.teamUpService, UUIDS.teamUpMode);
      await this.cacheCharacteristic("eqState", UUIDS.eqService, UUIDS.eqState);
      await this.cacheCharacteristic("stereoRole", UUIDS.eqService, UUIDS.stereoRole);
    }

    async cacheCharacteristic(key, serviceUuid, characteristicUuid) {
      const service = await this.server.getPrimaryService(serviceUuid);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      this.characteristics.set(key, characteristic);
      this.onLog("gatt", this.speakerId, `cached ${key}`);
    }

    async subscribe() {
      for (const [key, characteristic] of this.characteristics.entries()) {
        if (!characteristic.properties.notify && !characteristic.properties.indicate) continue;
        characteristic.addEventListener("characteristicvaluechanged", (event) => {
          const value = event.target.value;
          this.handleNotification(key, value);
        });
        try {
          await characteristic.startNotifications();
          this.onLog("notify", this.speakerId, `started ${key}`);
        } catch (error) {
          this.onLog("warn", this.speakerId, `notify ${key}: ${error.message}`);
        }
      }
    }

    async readState() {
      const next = {};
      next.rawVolume = await this.readVolume();
      next.teamUpMode = await this.readTeamUpMode();
      next.stereoRole = await this.readStereoRole();
      next.eq = await this.readEq();
      next.appLevel = appLevelFromRaw(next.rawVolume);
      this.onUpdate(this.speakerId, next);
      return next;
    }

    async readVolume() {
      const value = await this.characteristics.get("volume").readValue();
      const rawVolume = value.getUint8(0);
      this.onLog("read", this.speakerId, `volume ${rawVolume}`);
      return rawVolume;
    }

    async writeVolume(rawVolume) {
      const data = Uint8Array.of(clamp(rawVolume, 0, 255));
      await this.characteristics.get("volume").writeValue(data);
      this.onLog("write", this.speakerId, `volume ${data[0]}`);
    }

    async readTeamUpMode() {
      const value = await this.characteristics.get("teamUpMode").readValue();
      const mode = decodeText(value).trim();
      this.onLog("read", this.speakerId, `teamUp ${mode}`);
      return TEAMUP_VALUES.includes(mode) ? mode : "solo";
    }

    async writeTeamUpMode(mode) {
      if (!TEAMUP_VALUES.includes(mode)) throw new Error(`Invalid TeamUp mode: ${mode}`);
      await this.characteristics.get("teamUpMode").writeValue(new TextEncoder().encode(mode));
      this.onLog("write", this.speakerId, `teamUp ${mode}`);
    }

    async readStereoRole() {
      const value = await this.characteristics.get("stereoRole").readValue();
      const role = decodeStereoRole(value.getUint8(0));
      this.onLog("read", this.speakerId, `stereo ${role}`);
      return role;
    }

    async writeStereoRole(role) {
      await this.characteristics.get("stereoRole").writeValue(Uint8Array.of(encodeStereoRole(role)));
      this.onLog("write", this.speakerId, `stereo ${role}`);
    }

    async readEq() {
      const value = await this.characteristics.get("eqState").readValue();
      const eq = decodeEq(value);
      this.onLog("read", this.speakerId, `eq ${eq.preset} [${eq.bands.join(", ")}]`);
      return eq;
    }

    async writeEq(eq) {
      await this.characteristics.get("eqState").writeValue(encodeEq(eq));
      this.onLog("write", this.speakerId, `eq ${eq.preset} [${eq.bands.join(", ")}]`);
    }

    handleNotification(key, value) {
      if (key === "volume") {
        const rawVolume = value.getUint8(0);
        this.onUpdate(this.speakerId, { rawVolume, appLevel: appLevelFromRaw(rawVolume) });
        this.onLog("notification", this.speakerId, `volume ${rawVolume}`);
      }
      if (key === "teamUpMode") {
        const teamUpMode = decodeText(value).trim();
        this.onUpdate(this.speakerId, { teamUpMode });
        this.onLog("notification", this.speakerId, `teamUp ${teamUpMode}`);
      }
      if (key === "stereoRole") {
        const stereoRole = decodeStereoRole(value.getUint8(0));
        this.onUpdate(this.speakerId, { stereoRole });
        this.onLog("notification", this.speakerId, `stereo ${stereoRole}`);
      }
      if (key === "eqState") {
        const eq = decodeEq(value);
        this.onUpdate(this.speakerId, { eq });
        this.onLog("notification", this.speakerId, `eq ${eq.preset}`);
      }
    }
  }

  async function init() {
    state.support = detectSupport();
    bindEvents();
    await loadPresets();
    render();
    if (new URLSearchParams(location.search).get("demo") === "1") {
      loadDemoSetup();
    }

    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
      navigator.serviceWorker.register("sw.js?v=20260624-eq-logo").catch((error) => {
        logEvent("warn", "app", `service worker: ${error.message}`);
      });
    }

    logEvent("system", "app", "Soundboks_FOH initialized");
  }

  function bindEvents() {
    $("#scanButton").addEventListener("click", scanAndConnect);
    $("#demoButton").addEventListener("click", loadDemoSetup);

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action], button[data-view], button[data-limit]");
      if (!button) return;

      if (button.dataset.view) {
        setView(button.dataset.view);
        return;
      }

      if (button.dataset.limit) {
        state.activeLimit = button.dataset.limit;
        render();
        return;
      }

      const action = button.dataset.action;
      const speakerId = button.dataset.speakerId;
      try {
        await handleAction(action, speakerId, button.dataset);
      } catch (error) {
        logEvent("error", speakerId || "app", error.message);
        updateSpeaker(speakerId, { error: error.message });
      }
    });

    document.addEventListener("change", async (event) => {
      const target = event.target;
      const speakerId = target.dataset.speakerId;
      if (!speakerId) return;

      try {
        if (target.dataset.control === "volume") {
          await setVolume(speakerId, Number(target.value));
        }
        if (target.dataset.control === "teamup") {
          await setTeamUpMode(speakerId, target.value);
        }
        if (target.dataset.control === "band") {
          await setEqBand(speakerId, Number(target.dataset.band), Number(target.value));
        }
      } catch (error) {
        logEvent("error", speakerId, error.message);
      }
    });

    document.addEventListener("input", (event) => {
      const target = event.target;
      const speakerId = target.dataset.speakerId;
      if (!speakerId || target.dataset.control !== "volume") return;
      const rawVolume = clamp(Number(target.value), 0, 255);
      const speaker = getSpeaker(speakerId);
      if (!speaker) return;
      speaker.rawVolume = rawVolume;
      speaker.appLevel = appLevelFromRaw(rawVolume);
      updateVolumeDom(speakerId, rawVolume);
      scheduleWrite(`volume:${speakerId}`, () => setVolume(speakerId, rawVolume), 160);
    });
  }

  async function scanAndConnect() {
    if (!state.support.secureContext || !state.support.bluetooth) {
      render();
      logEvent("error", "app", "Web Bluetooth is not available in this browser/context");
      return;
    }

    setSessionState("scanning");

    let device;
    try {
      device = await requestSoundboksDevice(true);
    } catch (error) {
      logEvent("warn", "scan", `manufacturer filter failed: ${error.message}`);
      device = await requestSoundboksDevice(false);
    }

    const speakerId = device.id || createId("speaker");
    const existing = getSpeaker(speakerId);
    if (!existing) {
      state.speakers.push({
        id: speakerId,
        name: device.name || "SOUNDBOKS 4",
        teamId: extractTeamId(device.name),
        bluetoothDeviceId: device.id,
        connectionState: "connecting",
        rawVolume: 0,
        appLevel: "L0",
        teamUpMode: "solo",
        stereoRole: "M",
        eq: structuredCloneSafe(DEFAULT_EQ),
        lastSeenAt: Date.now()
      });
    } else {
      existing.connectionState = "connecting";
      existing.error = "";
    }
    render();

    const client = new SoundboksBleClient({
      speakerId,
      device,
      onUpdate: updateSpeaker,
      onLog: logEvent
    });

    state.clients.set(speakerId, client);
    await client.connect();
    updateSpeaker(speakerId, { connectionState: "connected", lastSeenAt: Date.now(), error: "" });
    setSessionState("connected");
  }

  function requestSoundboksDevice(useManufacturerFilter) {
    const filters = [
      { services: [UUIDS.advertising] },
      { namePrefix: "AppControl" },
      { namePrefix: "#" }
    ];
    if (useManufacturerFilter) {
      filters.push({ manufacturerData: [{ companyIdentifier: 2136 }] });
    }
    return navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [
        UUIDS.advertising,
        UUIDS.volumeService,
        UUIDS.teamUpService,
        UUIDS.eqService
      ]
    });
  }

  async function handleAction(action, speakerId, dataset) {
    if (action === "sync-all") return syncAll();
    if (action === "disconnect-all") return disconnectAll();
    if (action === "clear-log") return clearLog();
    if (action === "save-preset") return saveCurrentPreset();
    if (action === "delete-preset") return deletePreset(dataset.presetId);
    if (action === "apply-preset") return applyPreset(dataset.presetId);
    if (action === "group-route") return applyGroupRoute(dataset.groupId, dataset.route);
    if (action === "group-volume") return adjustGroupVolume(dataset.groupId, Number(dataset.delta));

    if (!speakerId) return;
    if (action === "disconnect") return disconnectSpeaker(speakerId);
    if (action === "read-state") return readSpeakerState(speakerId);
    if (action === "volume-step") return adjustVolume(speakerId, Number(dataset.delta));
    if (action === "volume-set") return setVolume(speakerId, Number(dataset.value));
    if (action === "role") return setStereoRole(speakerId, dataset.role);
    if (action === "eq-preset") return setEqPreset(speakerId, dataset.preset);
  }

  function loadDemoSetup() {
    const demoOne = {
      id: "demo-left",
      name: "AppControl #304327",
      teamId: "#304327",
      connectionState: "connected",
      demo: true,
      rawVolume: 74,
      appLevel: appLevelFromRaw(74),
      teamUpMode: "solo",
      stereoRole: "L",
      eq: { preset: "dancefloor", bands: [2, 1, 0, 2, 4, 3] },
      lastSeenAt: Date.now()
    };
    const demoTwo = {
      id: "demo-right",
      name: "AppControl #360355",
      teamId: "#360355",
      connectionState: "connected",
      demo: true,
      rawVolume: 70,
      appLevel: appLevelFromRaw(70),
      teamUpMode: "solo",
      stereoRole: "R",
      eq: { preset: "stage", bands: [-2, -1, 0, 1, 3, 4] },
      lastSeenAt: Date.now()
    };
    state.speakers = state.speakers.filter((speaker) => !speaker.demo);
    state.speakers.unshift(demoOne, demoTwo);
    state.groups = [
      {
        id: "front-pair",
        name: "Front Pair",
        speakerIds: ["demo-left", "demo-right"],
        requiresAllOnline: true,
        routingPreset: "left_right"
      }
    ];
    setSessionState("demo");
    logEvent("system", "demo", "loaded two virtual speakers");
    render();
  }

  async function syncAll() {
    const connected = state.speakers.filter((speaker) => isOnline(speaker));
    await Promise.allSettled(connected.map((speaker) => readSpeakerState(speaker.id)));
    render();
  }

  async function disconnectAll() {
    for (const speaker of state.speakers) {
      await disconnectSpeaker(speaker.id);
    }
  }

  async function disconnectSpeaker(speakerId) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    if (speaker.demo) {
      updateSpeaker(speakerId, { connectionState: "disconnected" });
      return;
    }
    const client = state.clients.get(speakerId);
    if (client) client.disconnect();
    state.clients.delete(speakerId);
    updateSpeaker(speakerId, { connectionState: "disconnected" });
  }

  async function readSpeakerState(speakerId) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    if (speaker.demo) {
      logEvent("read", speakerId, "demo state refreshed");
      updateSpeaker(speakerId, { lastSeenAt: Date.now() });
      return;
    }
    const client = requireClient(speakerId);
    await client.readState();
  }

  async function adjustVolume(speakerId, delta) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    await setVolume(speakerId, Number(speaker.rawVolume || 0) + delta);
  }

  async function setVolume(speakerId, value) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    const limit = getActiveLimit();
    const rawVolume = clamp(value, limit.minRaw, limit.maxRaw);
    speaker.rawVolume = rawVolume;
    speaker.appLevel = appLevelFromRaw(rawVolume);
    if (!speaker.demo) {
      await requireClient(speakerId).writeVolume(rawVolume);
    } else {
      logEvent("write", speakerId, `demo volume ${rawVolume}`);
    }
    render();
  }

  async function setTeamUpMode(speakerId, mode) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || !TEAMUP_VALUES.includes(mode)) return;
    speaker.teamUpMode = mode;
    if (!speaker.demo) {
      await requireClient(speakerId).writeTeamUpMode(mode);
    } else {
      logEvent("write", speakerId, `demo teamUp ${mode}`);
    }
    render();
  }

  async function setStereoRole(speakerId, role) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || !ROLE_VALUES.includes(role)) return;
    speaker.stereoRole = role;
    if (!speaker.demo) {
      await requireClient(speakerId).writeStereoRole(role);
    } else {
      logEvent("write", speakerId, `demo stereo ${role}`);
    }
    render();
  }

  async function setEqPreset(speakerId, preset) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || !EQ_PRESETS.includes(preset)) return;
    speaker.eq = speaker.eq || structuredCloneSafe(DEFAULT_EQ);
    speaker.eq.preset = preset;
    await writeEq(speakerId, speaker.eq);
  }

  async function setEqBand(speakerId, band, value) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || band < 0 || band > 5) return;
    speaker.eq = speaker.eq || structuredCloneSafe(DEFAULT_EQ);
    speaker.eq.bands[band] = clamp(value, -10, 10);
    speaker.eq.preset = "custom";
    await writeEq(speakerId, speaker.eq);
  }

  async function writeEq(speakerId, eq) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    if (!speaker.demo) {
      await requireClient(speakerId).writeEq(eq);
    } else {
      logEvent("write", speakerId, `demo eq ${eq.preset}`);
    }
    render();
  }

  async function applyGroupRoute(groupId, route) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group || !isGroupOnline(group)) return;
    const [first, second] = group.speakerIds;
    if (route === "mono_both") {
      await Promise.all([setStereoRole(first, "M"), setStereoRole(second, "M")]);
    }
    if (route === "left_right") {
      await Promise.all([setStereoRole(first, "L"), setStereoRole(second, "R")]);
    }
    if (route === "right_left") {
      await Promise.all([setStereoRole(first, "R"), setStereoRole(second, "L")]);
    }
    if (route === "swap_left") {
      const speakerA = getSpeaker(first);
      const speakerB = getSpeaker(second);
      await Promise.all([
        setStereoRole(first, speakerB?.stereoRole || "R"),
        setStereoRole(second, speakerA?.stereoRole || "L")
      ]);
    }
    group.routingPreset = route;
    render();
  }

  async function adjustGroupVolume(groupId, delta) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group || !isGroupOnline(group)) return;
    await Promise.all(group.speakerIds.map((speakerId) => adjustVolume(speakerId, delta)));
  }

  async function saveCurrentPreset() {
    if (!state.speakers.length) return;
    const name = window.prompt("Preset-Name", `Setup ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`);
    if (!name) return;
    const now = Date.now();
    const preset = {
      id: createId("preset"),
      name,
      speakerStates: Object.fromEntries(state.speakers.map((speaker) => [
        speaker.id,
        {
          name: speaker.name,
          teamId: speaker.teamId,
          rawVolume: speaker.rawVolume,
          teamUpMode: speaker.teamUpMode,
          stereoRole: speaker.stereoRole,
          eq: speaker.eq
        }
      ])),
      groups: structuredCloneSafe(state.groups),
      volumeLimit: getActiveLimit(),
      createdAt: now,
      updatedAt: now
    };
    await savePreset(preset);
    state.presets = await getPresets();
    logEvent("storage", "preset", `saved ${preset.name}`);
    render();
  }

  async function applyPreset(presetId) {
    const preset = state.presets.find((item) => item.id === presetId);
    if (!preset) return;
    if (preset.volumeLimit?.name) state.activeLimit = preset.volumeLimit.name;

    for (const speaker of state.speakers) {
      const desired = preset.speakerStates[speaker.id];
      if (!desired) continue;
      if (typeof desired.rawVolume === "number") await setVolume(speaker.id, desired.rawVolume);
      if (desired.teamUpMode) await setTeamUpMode(speaker.id, desired.teamUpMode);
      if (desired.stereoRole) await setStereoRole(speaker.id, desired.stereoRole);
      if (desired.eq) {
        speaker.eq = structuredCloneSafe(desired.eq);
        await writeEq(speaker.id, speaker.eq);
      }
    }
    logEvent("storage", "preset", `applied ${preset.name}`);
    render();
  }

  async function deletePreset(presetId) {
    await removePreset(presetId);
    state.presets = await getPresets();
    render();
  }

  function render() {
    renderSupport();
    renderTabs();
    renderLimits();
    renderStats();
    renderSpeakers();
    renderGroups();
    renderPresets();
    renderDiagnostics();
  }

  function renderSupport() {
    const support = state.support || detectSupport();
    const secureBadge = $("#secureBadge");
    const supportLabel = $("#supportLabel");
    const warning = $("#browserWarning");
    const scanButton = $("#scanButton");

    secureBadge.className = "status-pill";
    if (support.ready) {
      secureBadge.textContent = "ready";
      secureBadge.classList.add("ok");
      supportLabel.textContent = "Web Bluetooth bereit";
      warning.hidden = true;
      scanButton.disabled = false;
    } else {
      secureBadge.textContent = "blocked";
      secureBadge.classList.add("error");
      supportLabel.textContent = support.reason;
      warning.textContent = support.reason;
      warning.hidden = false;
      scanButton.disabled = true;
    }
  }

  function renderTabs() {
    $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === state.view));
    $$(".view").forEach((view) => view.classList.toggle("is-active", view.id === `${state.view}View`));
  }

  function renderLimits() {
    $("#limitGrid").innerHTML = LIMITS.map((limit) => `
      <button class="chip-button ${limit.name === state.activeLimit ? "is-active" : ""}" type="button" data-limit="${limit.name}">
        ${escapeHtml(limit.name)} ${limit.maxRaw}
      </button>
    `).join("");
    $("#activeLimitLabel").textContent = state.activeLimit;
  }

  function renderStats() {
    const online = state.speakers.filter(isOnline).length;
    $("#deviceCount").textContent = String(state.speakers.length);
    $("#onlineCount").textContent = String(online);
    $("#presetCount").textContent = String(state.presets.length);
    $("#sessionState").textContent = online ? "connected" : "idle";
    $("#sessionState").className = `status-pill ${online ? "ok" : ""}`;
  }

  function renderSpeakers() {
    const grid = $("#speakerGrid");
    if (!state.speakers.length) {
      grid.innerHTML = $("#emptyStateTemplate").innerHTML;
      return;
    }

    grid.innerHTML = state.speakers.map(renderSpeakerCard).join("");
  }

  function renderSpeakerCard(speaker) {
    const online = isOnline(speaker);
    const eq = speaker.eq || structuredCloneSafe(DEFAULT_EQ);
    const disabled = online ? "" : "disabled";
    const statusClass = online ? "ok" : speaker.connectionState === "error" ? "error" : "warn";
    const raw = Number(speaker.rawVolume || 0);
    const percent = Math.round((raw / 255) * 100);

    return `
      <article class="speaker-card" data-card-speaker="${escapeAttr(speaker.id)}">
        <div class="card-heading">
          <div class="speaker-title">
            <h2>${escapeHtml(speaker.name || "SOUNDBOKS 4")}</h2>
            <p>${escapeHtml(speaker.teamId || speaker.bluetoothDeviceId || speaker.id)}</p>
          </div>
          <span class="status-pill ${statusClass}">${escapeHtml(speaker.connectionState)}</span>
        </div>

        <div class="meter-wrap">
          <div class="meter-row">
            <strong data-volume-readout="${escapeAttr(speaker.id)}">${raw}</strong>
            <span class="level-badge" data-level-readout="${escapeAttr(speaker.id)}">${escapeHtml(appLevelFromRaw(raw))}</span>
          </div>
          <input class="range" type="range" min="0" max="255" value="${raw}" ${disabled}
            aria-label="Raw Volume ${escapeAttr(speaker.name || speaker.id)}"
            data-control="volume" data-speaker-id="${escapeAttr(speaker.id)}">
          <p class="muted">${percent}% raw output, begrenzt durch ${escapeHtml(state.activeLimit)}</p>
        </div>

        <div class="step-grid">
          ${stepButton(speaker.id, "min", 0, "set", disabled)}
          ${stepButton(speaker.id, "-10", -10, "step", disabled)}
          ${stepButton(speaker.id, "-1", -1, "step", disabled)}
          ${stepButton(speaker.id, "mid", 128, "set", disabled)}
          ${stepButton(speaker.id, "+1", 1, "step", disabled)}
          ${stepButton(speaker.id, "+10", 10, "step", disabled)}
          ${stepButton(speaker.id, "max", 255, "set", disabled)}
        </div>

        <div class="control-section">
          <span class="section-label">Stereo Role</span>
          <div class="segmented">
            ${ROLE_VALUES.map((role) => `
              <button class="role-button ${speaker.stereoRole === role ? "is-active" : ""}" type="button" ${disabled}
                data-action="role" data-role="${role}" data-speaker-id="${escapeAttr(speaker.id)}">${role}</button>
            `).join("")}
          </div>
        </div>

        <div class="control-section">
          <span class="section-label">TeamUp Mode</span>
          <div class="inline-row">
            <select ${disabled} data-control="teamup" data-speaker-id="${escapeAttr(speaker.id)}" aria-label="TeamUp Mode">
              ${TEAMUP_VALUES.map((mode) => `<option value="${mode}" ${speaker.teamUpMode === mode ? "selected" : ""}>${mode}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="control-section eq-panel">
          <div class="eq-header">
            <span class="section-label">EQ</span>
            <span class="eq-active">${EQ_LABELS[eq.preset]}</span>
          </div>
          <div class="segmented eq" aria-label="EQ Presets">
            ${EQ_PRESETS.map((preset) => `
              <button class="preset-button ${eq.preset === preset ? "is-active" : ""}" type="button" ${disabled}
                data-action="eq-preset" data-preset="${preset}" data-speaker-id="${escapeAttr(speaker.id)}">${EQ_LABELS[preset]}</button>
            `).join("")}
          </div>
          <div class="eq-curve" aria-hidden="true">
            ${eq.bands.map((value) => `<i style="height: ${44 + Number(value) * 3}px"></i>`).join("")}
          </div>
          <div class="band-grid">
            ${eq.bands.map((value, index) => {
              const numericValue = Number(value);
              return `
                <label class="band-control">
                  <span class="band-value">${numericValue > 0 ? "+" : ""}${numericValue}</span>
                  <input type="range" min="-10" max="10" value="${numericValue}" ${disabled}
                    data-control="band" data-band="${index}" data-speaker-id="${escapeAttr(speaker.id)}">
                  <span class="band-label">${EQ_BANDS[index]} Hz</span>
                </label>
              `;
            }).join("")}
          </div>
        </div>

        <div class="header-actions">
          <button class="ghost-action" type="button" data-action="read-state" data-speaker-id="${escapeAttr(speaker.id)}" ${disabled}>State lesen</button>
          <button class="ghost-action" type="button" data-action="disconnect" data-speaker-id="${escapeAttr(speaker.id)}">Trennen</button>
        </div>
        ${speaker.error ? `<div class="callout">${escapeHtml(speaker.error)}</div>` : ""}
      </article>
    `;
  }

  function stepButton(speakerId, label, value, mode, disabled) {
    const action = mode === "set" ? "volume-set" : "volume-step";
    const data = mode === "set" ? `data-value="${value}"` : `data-delta="${value}"`;
    return `<button class="step-button" type="button" ${disabled} data-action="${action}" ${data} data-speaker-id="${escapeAttr(speakerId)}">${label}</button>`;
  }

  function renderGroups() {
    const grid = $("#groupsGrid");
    const group = normalizeDefaultGroup();
    grid.innerHTML = state.groups.map((item) => renderGroupCard(item)).join("") || renderEmptyMessage("Keine Gruppen definiert.");
    if (!state.groups.length && group) render();
  }

  function renderGroupCard(group) {
    const online = isGroupOnline(group);
    const speakers = group.speakerIds.map(getSpeaker).filter(Boolean);
    const statusClass = online ? "ok" : "warn";
    return `
      <article class="group-card">
        <div class="card-heading">
          <div>
            <h2>${escapeHtml(group.name)}</h2>
            <p class="muted">${speakers.map((speaker) => escapeHtml(speaker.teamId || speaker.name)).join(" + ") || "Noch keine Speaker"}</p>
          </div>
          <span class="status-pill ${statusClass}">${online ? "online" : "waiting"}</span>
        </div>
        <p class="muted">Gruppenaktionen schreiben parallel auf alle enthaltenen Speaker. Open Protocol Fields bleiben unberuehrt.</p>
        <div class="group-actions">
          <button class="chip-button" type="button" ${online ? "" : "disabled"} data-action="group-route" data-group-id="${escapeAttr(group.id)}" data-route="mono_both">Mono beide</button>
          <button class="chip-button" type="button" ${online ? "" : "disabled"} data-action="group-route" data-group-id="${escapeAttr(group.id)}" data-route="left_right">L/R</button>
          <button class="chip-button" type="button" ${online ? "" : "disabled"} data-action="group-route" data-group-id="${escapeAttr(group.id)}" data-route="right_left">R/L</button>
          <button class="chip-button" type="button" ${online ? "" : "disabled"} data-action="group-route" data-group-id="${escapeAttr(group.id)}" data-route="swap_left">Left tauschen</button>
          <button class="chip-button" type="button" ${online ? "" : "disabled"} data-action="group-volume" data-group-id="${escapeAttr(group.id)}" data-delta="-1">Gruppe -1</button>
          <button class="chip-button" type="button" ${online ? "" : "disabled"} data-action="group-volume" data-group-id="${escapeAttr(group.id)}" data-delta="1">Gruppe +1</button>
        </div>
      </article>
    `;
  }

  function renderPresets() {
    const grid = $("#presetGrid");
    if (!state.presets.length) {
      grid.innerHTML = renderEmptyMessage("Noch keine lokalen Presets gespeichert.");
      return;
    }
    grid.innerHTML = state.presets.map((preset) => `
      <article class="preset-card">
        <h2>${escapeHtml(preset.name)}</h2>
        <p class="muted">${new Date(preset.updatedAt).toLocaleString("de-DE")} · ${Object.keys(preset.speakerStates).length} Speaker</p>
        <p>Limit: <strong>${escapeHtml(preset.volumeLimit?.name || "Custom")}</strong></p>
        <div class="preset-actions">
          <button class="primary-inline" type="button" data-action="apply-preset" data-preset-id="${escapeAttr(preset.id)}">Anwenden</button>
          <button class="ghost-action" type="button" data-action="delete-preset" data-preset-id="${escapeAttr(preset.id)}">Loeschen</button>
        </div>
      </article>
    `).join("");
  }

  function renderDiagnostics() {
    $("#diagnosticsLog").textContent = state.diagnostics.slice(-160).map((entry) => {
      return `${entry.time}  ${entry.type.padEnd(12)} ${entry.target.padEnd(14)} ${entry.message}`;
    }).join("\n");
  }

  function renderEmptyMessage(message) {
    return `
      <div class="empty-state">
        <div class="empty-visual" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
        <h2>${escapeHtml(message)}</h2>
        <p>Verbinde reale Speaker oder lade den Demo-Modus, um diese Ansicht zu testen.</p>
      </div>
    `;
  }

  function setView(view) {
    state.view = view;
    render();
  }

  function setSessionState(value) {
    $("#sessionState").textContent = value;
  }

  function updateSpeaker(speakerId, patch) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    Object.assign(speaker, patch, { lastSeenAt: Date.now() });
    if (typeof speaker.rawVolume === "number") {
      speaker.rawVolume = clamp(speaker.rawVolume, 0, 255);
      speaker.appLevel = appLevelFromRaw(speaker.rawVolume);
    }
    render();
  }

  function updateVolumeDom(speakerId, rawVolume) {
    const readout = document.querySelector(`[data-volume-readout="${cssEscape(speakerId)}"]`);
    const level = document.querySelector(`[data-level-readout="${cssEscape(speakerId)}"]`);
    if (readout) readout.textContent = String(rawVolume);
    if (level) level.textContent = appLevelFromRaw(rawVolume);
  }

  function scheduleWrite(key, fn, delay) {
    const current = state.writeTimers.get(key);
    if (current) window.clearTimeout(current);
    const next = window.setTimeout(() => {
      state.writeTimers.delete(key);
      fn().catch((error) => logEvent("error", key, error.message));
    }, delay);
    state.writeTimers.set(key, next);
  }

  function normalizeDefaultGroup() {
    if (!state.groups.length) {
      state.groups = structuredCloneSafe(DEFAULT_GROUPS);
    }
    const group = state.groups[0];
    if (group && group.speakerIds.length < 2) {
      group.speakerIds = state.speakers.filter(isOnline).slice(0, 2).map((speaker) => speaker.id);
    }
    return group;
  }

  function isGroupOnline(group) {
    return group.speakerIds.length >= 2 && group.speakerIds.every((speakerId) => isOnline(getSpeaker(speakerId)));
  }

  function isOnline(speaker) {
    return Boolean(speaker && speaker.connectionState === "connected");
  }

  function getSpeaker(speakerId) {
    return state.speakers.find((speaker) => speaker.id === speakerId);
  }

  function requireClient(speakerId) {
    const client = state.clients.get(speakerId);
    if (!client) throw new Error("Speaker ist nicht per BLE verbunden.");
    return client;
  }

  function getActiveLimit() {
    return LIMITS.find((limit) => limit.name === state.activeLimit) || LIMITS[LIMITS.length - 1];
  }

  function detectSupport() {
    const secureContext = window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const bluetooth = "bluetooth" in navigator;
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isiOS) {
      return { ready: false, secureContext, bluetooth, reason: "iOS/Safari unterstuetzt Web Bluetooth nicht." };
    }
    if (!secureContext) {
      return { ready: false, secureContext, bluetooth, reason: "Web Bluetooth braucht HTTPS oder localhost." };
    }
    if (!bluetooth) {
      return { ready: false, secureContext, bluetooth, reason: "Dieser Browser stellt navigator.bluetooth nicht bereit." };
    }
    return { ready: true, secureContext, bluetooth, reason: "ready" };
  }

  function appLevelFromRaw(raw) {
    const value = clamp(Number(raw), 0, 255);
    if (value === 0) return "L0";
    if (value <= 16) return "L1";
    if (value <= 44) return "L2";
    if (value <= 72) return "L3";
    if (value <= 100) return "L4";
    if (value <= 128) return "L5";
    if (value <= 156) return "L6";
    if (value <= 184) return "L7";
    if (value <= 212) return "L8";
    if (value <= 240) return "L9";
    if (value <= 254) return "L10";
    return "L11";
  }

  function decodeEq(value) {
    const bytes = Array.from(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    const preset = EQ_PRESETS[bytes[0]] || "dancefloor";
    const bands = bytes.slice(1, 7).map(decodeEqBand);
    while (bands.length < 6) bands.push(0);
    return { preset, bands };
  }

  function encodeEq(eq) {
    const presetIndex = EQ_PRESETS.indexOf(eq.preset);
    const bands = (eq.bands || DEFAULT_EQ.bands).slice(0, 6).map(encodeEqBand);
    return Uint8Array.of(presetIndex >= 0 ? presetIndex : 0, ...bands);
  }

  function decodeEqBand(raw) {
    if (raw === 0) return 0;
    return clamp(Math.round((raw - 51) / 5), -10, 10);
  }

  function encodeEqBand(value) {
    const band = clamp(Number(value), -10, 10);
    return band === 0 ? 0 : 51 + 5 * band;
  }

  function decodeStereoRole(raw) {
    if (raw === 1) return "L";
    if (raw === 2) return "R";
    return "M";
  }

  function encodeStereoRole(role) {
    if (role === "L") return 1;
    if (role === "R") return 2;
    return 0;
  }

  function decodeText(value) {
    return new TextDecoder().decode(value);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }

  function extractTeamId(name) {
    const match = String(name || "").match(/#\d+/);
    return match ? match[0] : "";
  }

  function createId(prefix) {
    if (window.crypto && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function logEvent(type, target, message) {
    state.diagnostics.push({
      type,
      target: String(target || "app").slice(0, 14),
      message: String(message || ""),
      time: new Date().toLocaleTimeString("de-DE", { hour12: false })
    });
    renderDiagnostics();
  }

  function clearLog() {
    state.diagnostics = [];
    renderDiagnostics();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function structuredCloneSafe(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  async function loadPresets() {
    try {
      state.presets = await getPresets();
    } catch (error) {
      logEvent("warn", "storage", error.message);
      state.presets = [];
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("soundboks-foh", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("presets")) {
          db.createObjectStore("presets", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getPresets() {
    if (!("indexedDB" in window)) return JSON.parse(localStorage.getItem("soundboks-foh-presets") || "[]");
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("presets", "readonly");
      const request = transaction.objectStore("presets").getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }

  async function savePreset(preset) {
    if (!("indexedDB" in window)) {
      const presets = JSON.parse(localStorage.getItem("soundboks-foh-presets") || "[]");
      presets.unshift(preset);
      localStorage.setItem("soundboks-foh-presets", JSON.stringify(presets));
      return;
    }
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("presets", "readwrite");
      transaction.objectStore("presets").put(preset);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function removePreset(presetId) {
    if (!("indexedDB" in window)) {
      const presets = JSON.parse(localStorage.getItem("soundboks-foh-presets") || "[]").filter((preset) => preset.id !== presetId);
      localStorage.setItem("soundboks-foh-presets", JSON.stringify(presets));
      return;
    }
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("presets", "readwrite");
      transaction.objectStore("presets").delete(presetId);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  init().catch((error) => {
    logEvent("fatal", "app", error.message);
    render();
  });
})();

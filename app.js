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
  const QUICK_EQ_PRESETS = ["stage", "dancefloor", "lounge"];
  const EQ_LABELS = {
    dancefloor: "Dancefloor",
    stage: "Stage",
    lounge: "Lounge",
    custom: "Custom"
  };
  const EQ_BANDS = ["63 Hz", "160 Hz", "400 Hz", "1 kHz", "2.5 kHz", "6.3 kHz"];
  const ROLE_VALUES = ["L", "M", "R"];
  const TEAMUP_VALUES = ["solo", "host", "join"];
  const TEAMUP_LABELS = { solo: "Solo", host: "Host", join: "Join" };
  const VIEW_IDS = ["dashboard", "groups", "diagnostics"];
  const CUSTOM_EQ_COOKIE = "soundboks_foh_custom_eqs_v1";
  const UI_STATE_STORAGE = "soundboks_foh_ui_state_v1";
  const MAX_LOCAL_CUSTOM_EQS = 10;
  const DEFAULT_PRESET_CATALOG_URL = "presets/defaults/catalog.json";
  const FALLBACK_DEFAULT_EQS = [
    {
      schemaVersion: 1,
      id: "default-flat",
      name: "Default Flat",
      deviceModel: "SOUNDBOKS 4",
      sourceDevice: "Soundboks_FOH Repository",
      bands: [0, 0, 0, 0, 0, 0],
      createdAt: 0,
      updatedAt: 0
    }
  ];
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
    defaultEqs: [],
    customEqs: [],
    diagnostics: [],
    clients: new Map(),
    writeTimers: new Map(),
    expandedCustomEq: new Set(),
    expandedGroupCustomEq: new Set(),
    selectedCustomEq: new Map(),
    groupScopes: new Map()
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
        this.onUpdate(this.speakerId, { rawVolume });
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
    loadCustomEqs();
    await loadDefaultEqs();
    loadUiState();
    const hashView = location.hash.slice(1);
    const requestedView = ["presets", "customEqs"].includes(hashView) ? "dashboard" : hashView;
    if (VIEW_IDS.includes(requestedView)) {
      state.view = requestedView;
    }
    render();
    if (new URLSearchParams(location.search).get("demo") === "1") {
      loadDemoSetup();
    }

    if (
      "serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ) {
      navigator.serviceWorker.register("sw.js?v=20260804-default-presets-7").catch((error) => {
        logEvent("warn", "app", `service worker: ${error.message}`);
      });
    }

    logEvent("system", "app", "Soundboks_FOH initialized");
  }

  function bindEvents() {
    $("#scanButton").addEventListener("click", scanAndConnect);
    $("#demoButton").addEventListener("click", loadDemoSetup);
    $(".tabbar").addEventListener("keydown", (event) => {
      const currentTab = event.target.closest(".tab");
      if (!currentTab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

      const tabs = $$(".tab");
      const currentIndex = tabs.indexOf(currentTab);
      let nextIndex = event.key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      nextIndex = (nextIndex + tabs.length) % tabs.length;

      event.preventDefault();
      setView(tabs[nextIndex].dataset.view);
      tabs[nextIndex].focus();
    });

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-view], button[data-action], button[data-limit]");
      if (!button) return;

      if (button.dataset.view) {
        event.preventDefault();
        setView(button.dataset.view);
        return;
      }

      if (button.dataset.limit) {
        state.activeLimit = button.dataset.limit;
        persistUiState();
        render();
        return;
      }

      const action = button.dataset.action;
      const speakerId = button.dataset.speakerId;
      try {
        await handleAction(action, speakerId, button.dataset);
      } catch (error) {
        const actionTarget = speakerId || button.dataset.groupId || "app";
        logEvent("error", actionTarget, error.message);
        if (speakerId) updateSpeaker(speakerId, { error: error.message });
      }
    });

    document.addEventListener("change", async (event) => {
      const target = event.target;
      const speakerId = target.dataset.speakerId;
      const groupId = target.dataset.groupId;
      if (!speakerId && !groupId) return;

      try {
        if (target.dataset.control === "volume") {
          await setVolume(speakerId, Number(target.value));
        }
        if (target.dataset.control === "band") {
          await setEqBand(speakerId, Number(target.dataset.band), Number(target.value));
        }
        if (target.dataset.control === "custom-eq-preset" && target.value) {
          await applyCustomEqToSpeakers(target.value, [speakerId]);
        }
        if (target.dataset.control === "group-volume") {
          await setGroupVolume(groupId, Number(target.value));
        }
        if (target.dataset.control === "group-band") {
          await setGroupEqBand(groupId, Number(target.dataset.band), Number(target.value));
        }
        if (target.dataset.control === "group-custom-eq-preset" && target.value) {
          await applyCustomEqToSpeakers(target.value, getGroupActionTargets(groupId).map((speaker) => speaker.id));
        }
      } catch (error) {
        logEvent("error", speakerId || groupId, error.message);
      }
    });

    document.addEventListener("input", (event) => {
      const target = event.target;
      const speakerId = target.dataset.speakerId;
      const groupId = target.dataset.groupId;

      if (speakerId && target.dataset.control === "volume") {
        const rawVolume = clamp(Number(target.value), 0, 255);
        const speaker = getSpeaker(speakerId);
        if (!speaker) return;
        speaker.rawVolume = rawVolume;
        target.style.setProperty("--fader-position", faderPosition(rawVolume, 0, 255, true));
        updateVolumeDom(speakerId, rawVolume);
        scheduleWrite(`volume:${speakerId}`, () => setVolume(speakerId, rawVolume), 160);
      }

      if (speakerId && target.dataset.control === "band") {
        const value = clamp(Number(target.value), -10, 10);
        const control = target.closest(".band-control");
        const valueLabel = control?.querySelector(".band-value");
        const curveBars = target.closest(".eq-panel")?.querySelectorAll(".eq-curve i");
        target.style.setProperty("--fader-position", faderPosition(value, -10, 10, true));
        if (valueLabel) valueLabel.textContent = `${value > 0 ? "+" : ""}${value}`;
        if (curveBars?.[Number(target.dataset.band)]) {
          curveBars[Number(target.dataset.band)].style.height = `${44 + value * 3}px`;
        }
      }

      if (groupId && target.dataset.control === "group-volume") {
        const rawVolume = clamp(Number(target.value), 0, 255);
        const group = getGroup(groupId);
        if (!group) return;
        getGroupSpeakers(group).forEach((speaker) => {
          speaker.rawVolume = rawVolume;
        });
        target.style.setProperty("--fader-position", faderPosition(rawVolume, 0, 255, true));
        updateGroupVolumeDom(groupId, rawVolume);
        scheduleWrite(`group-volume:${groupId}`, () => setGroupVolume(groupId, rawVolume), 160);
      }

      if (groupId && target.dataset.control === "group-band") {
        updateBandControlDom(target, Number(target.value));
      }
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
    if (action === "delete-custom-eq") return deleteCustomEq(dataset.customEqId);
    if (action === "group-scope") return setGroupScope(dataset.groupId, dataset.scope);
    if (action === "group-toggle-custom-eq") return toggleGroupCustomEq(dataset.groupId);
    if (action === "group-save-custom-eq") return saveCurrentGroupCustomEq(dataset.groupId);
    if (action === "group-eq-preset") return setGroupEqPreset(dataset.groupId, dataset.preset);
    if (action === "group-role") return setGroupRole(dataset.groupId, dataset.value);
    if (action === "group-teamup") return setGroupTeamUpMode(dataset.groupId, dataset.mode);
    if (action === "group-volume") return adjustGroupVolume(dataset.groupId, Number(dataset.delta));
    if (action === "group-volume-set") return setGroupVolume(dataset.groupId, Number(dataset.value));

    if (!speakerId) return;
    if (action === "save-custom-eq") return saveCurrentCustomEq(speakerId);
    if (action === "toggle-custom-eq") return toggleCustomEq(speakerId);
    if (action === "disconnect") return disconnectSpeaker(speakerId);
    if (action === "read-state") return readSpeakerState(speakerId);
    if (action === "volume-step") return adjustVolume(speakerId, Number(dataset.delta));
    if (action === "volume-set") return setVolume(speakerId, Number(dataset.value));
    if (action === "role") return setStereoRole(speakerId, dataset.role);
    if (action === "teamup") return setTeamUpMode(speakerId, dataset.mode);
    if (action === "eq-preset") return setEqPreset(speakerId, dataset.preset);
  }

  function toggleCustomEq(speakerId) {
    const expanded = !state.expandedCustomEq.has(speakerId);
    if (expanded) {
      state.expandedCustomEq.add(speakerId);
    } else {
      state.expandedCustomEq.delete(speakerId);
    }
    persistUiState();

    const card = document.querySelector(`[data-card-speaker="${cssEscape(speakerId)}"]`);
    const toggle = card?.querySelector('[data-action="toggle-custom-eq"]');
    const accordion = card?.querySelector(".custom-eq-accordion");
    if (!toggle || !accordion) {
      renderSpeakers();
      return;
    }

    card.classList.toggle("is-custom-eq-expanded", expanded);
    accordion.hidden = !expanded;
    accordion.setAttribute("aria-hidden", String(!expanded));
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", expanded ? "Custom EQ ausblenden" : "Custom EQ einblenden");
    toggle.title = expanded ? "Custom EQ ausblenden" : "Custom EQ einblenden";
  }

  function toggleGroupCustomEq(groupId) {
    const expanded = !state.expandedGroupCustomEq.has(groupId);
    if (expanded) {
      state.expandedGroupCustomEq.add(groupId);
    } else {
      state.expandedGroupCustomEq.delete(groupId);
    }
    persistUiState();
    renderGroups();
  }

  function loadDemoSetup() {
    const demoOne = {
      id: "demo-left",
      name: "AppControl #304327",
      teamId: "#304327",
      connectionState: "connected",
      demo: true,
      rawVolume: 74,
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

  async function setVolume(speakerId, value, shouldRender = true) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    const limit = getActiveLimit();
    const rawVolume = clamp(value, limit.minRaw, limit.maxRaw);
    speaker.rawVolume = rawVolume;
    if (!speaker.demo) {
      await requireClient(speakerId).writeVolume(rawVolume);
    } else {
      logEvent("write", speakerId, `demo volume ${rawVolume}`);
    }
    if (shouldRender) render();
  }

  async function setTeamUpMode(speakerId, mode, shouldRender = true) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || !TEAMUP_VALUES.includes(mode)) return;
    speaker.teamUpMode = mode;
    if (!speaker.demo) {
      await requireClient(speakerId).writeTeamUpMode(mode);
    } else {
      logEvent("write", speakerId, `demo teamUp ${mode}`);
    }
    if (shouldRender) render();
  }

  async function setStereoRole(speakerId, role, shouldRender = true) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || !ROLE_VALUES.includes(role)) return;
    speaker.stereoRole = role;
    if (!speaker.demo) {
      await requireClient(speakerId).writeStereoRole(role);
    } else {
      logEvent("write", speakerId, `demo stereo ${role}`);
    }
    if (shouldRender) render();
  }

  async function setEqPreset(speakerId, preset, shouldRender = true) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || !EQ_PRESETS.includes(preset)) return;
    const selectionChanged = state.selectedCustomEq.delete(speakerId);
    if (selectionChanged) persistUiState();
    speaker.eq = speaker.eq || structuredCloneSafe(DEFAULT_EQ);
    speaker.eq.preset = preset;
    await writeEq(speakerId, speaker.eq, shouldRender);
  }

  async function setEqBand(speakerId, band, value, shouldRender = true) {
    const speaker = getSpeaker(speakerId);
    if (!speaker || band < 0 || band > 5) return;
    const selectionChanged = state.selectedCustomEq.delete(speakerId);
    if (selectionChanged) persistUiState();
    speaker.eq = speaker.eq || structuredCloneSafe(DEFAULT_EQ);
    speaker.eq.bands[band] = clamp(value, -10, 10);
    speaker.eq.preset = "custom";
    await writeEq(speakerId, speaker.eq, shouldRender);
  }

  async function writeEq(speakerId, eq, shouldRender = true) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    if (!speaker.demo) {
      await requireClient(speakerId).writeEq(eq);
    } else {
      logEvent("write", speakerId, `demo eq ${eq.preset}`);
    }
    if (shouldRender) render();
  }

  async function applyGroupRoute(groupId, route) {
    const group = getGroup(groupId);
    if (!group || !isGroupOnline(group)) return;
    const [first, second] = group.speakerIds;
    if (route === "mono_both") {
      await Promise.all([setStereoRole(first, "M", false), setStereoRole(second, "M", false)]);
    }
    if (route === "left_right") {
      await Promise.all([setStereoRole(first, "L", false), setStereoRole(second, "R", false)]);
    }
    if (route === "right_left") {
      await Promise.all([setStereoRole(first, "R", false), setStereoRole(second, "L", false)]);
    }
    group.routingPreset = route;
    render();
  }

  async function adjustGroupVolume(groupId, delta) {
    const group = getGroup(groupId);
    if (!group || !isGroupOnline(group)) return;
    await setGroupVolume(groupId, groupRawVolume(group) + delta);
  }

  async function setGroupVolume(groupId, value) {
    const group = getGroup(groupId);
    if (!group || !isGroupOnline(group)) return;
    const limit = getActiveLimit();
    const rawVolume = clamp(value, limit.minRaw, limit.maxRaw);
    await Promise.all(group.speakerIds.map((speakerId) => setVolume(speakerId, rawVolume, false)));
    render();
  }

  async function setGroupEqPreset(groupId, preset) {
    if (!EQ_PRESETS.includes(preset)) return;
    const targets = getGroupActionTargets(groupId);
    if (!targets.length) return;
    await Promise.all(targets.map((speaker) => setEqPreset(speaker.id, preset, false)));
    render();
  }

  async function setGroupEqBand(groupId, band, value) {
    const targets = getGroupActionTargets(groupId);
    if (!targets.length || band < 0 || band >= EQ_BANDS.length) return;
    await Promise.all(targets.map((speaker) => setEqBand(speaker.id, band, value, false)));
    render();
  }

  async function setGroupRole(groupId, value) {
    const group = getGroup(groupId);
    if (!group || !isGroupOnline(group)) return;
    const scope = getGroupScope(group);
    if (scope === "group") {
      await applyGroupRoute(groupId, value);
      return;
    }
    if (!ROLE_VALUES.includes(value)) return;
    await setStereoRole(scope, value, false);
    render();
  }

  async function setGroupTeamUpMode(groupId, mode) {
    const group = getGroup(groupId);
    if (!group || !isGroupOnline(group) || !TEAMUP_VALUES.includes(mode)) return;
    const scope = getGroupScope(group);
    if (scope !== "group") {
      await setTeamUpMode(scope, mode, false);
      render();
      return;
    }

    if (mode === "host") {
      const [hostId, ...joinIds] = group.speakerIds;
      await Promise.all([
        setTeamUpMode(hostId, "host", false),
        ...joinIds.map((speakerId) => setTeamUpMode(speakerId, "join", false))
      ]);
    } else {
      await Promise.all(group.speakerIds.map((speakerId) => setTeamUpMode(speakerId, mode, false)));
    }
    render();
  }

  function setGroupScope(groupId, scope) {
    const group = getGroup(groupId);
    if (!group || (scope !== "group" && !group.speakerIds.includes(scope))) return;
    state.groupScopes.set(groupId, scope);
    persistUiState();
    renderGroups();
  }

  function saveCurrentCustomEq(speakerId) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    saveCustomEqFromSpeaker(speaker, speakerDisplayId(speaker), [speaker.id]);
  }

  function saveCurrentGroupCustomEq(groupId) {
    const group = getGroup(groupId);
    const targets = getGroupActionTargets(groupId);
    const source = targets[0];
    if (!group || !source) return;
    const scope = getGroupScope(group);
    const sourceLabel = scope === "group" ? group.name : speakerDisplayId(source);
    saveCustomEqFromSpeaker(source, sourceLabel, targets.map((speaker) => speaker.id));
  }

  function saveCustomEqFromSpeaker(speaker, sourceLabel, selectedSpeakerIds) {
    if (!speaker?.eq) return;
    const suggestedName = `${sourceLabel} EQ`;
    const requestedName = window.prompt("Custom-EQ-Name", suggestedName);
    const name = String(requestedName || "").trim().slice(0, 60);
    if (!name) return;

    const now = Date.now();
    const customEq = {
      schemaVersion: 1,
      id: createId("custom-eq"),
      name,
      deviceModel: "SOUNDBOKS 4",
      sourceDevice: sourceLabel,
      bands: normalizeCustomEqBands(speaker.eq.bands),
      createdAt: now,
      updatedAt: now
    };

    const next = [customEq, ...state.customEqs].slice(0, MAX_LOCAL_CUSTOM_EQS);
    persistCustomEqs(next);
    state.customEqs = next;
    selectedSpeakerIds.forEach((speakerId) => {
      const selectedSpeaker = getSpeaker(speakerId);
      if (sameEqBands(selectedSpeaker?.eq?.bands, customEq.bands)) {
        state.selectedCustomEq.set(speakerId, customEq.id);
      }
    });
    persistUiState();
    logEvent("storage", "custom-eq", `saved ${customEq.name}`);
    render();
  }

  async function applyCustomEqToSpeakers(customEqId, speakerIds) {
    const customEq = findCustomEq(customEqId);
    if (!customEq) return;
    const uniqueSpeakerIds = [...new Set(speakerIds.filter(Boolean))];
    const targets = uniqueSpeakerIds.map(getSpeaker).filter(isOnline);
    if (!targets.length) throw new Error("Kein verbundener Speaker fuer dieses Custom EQ ausgewaehlt.");

    await Promise.all(targets.map(async (speaker) => {
      speaker.eq = { preset: "custom", bands: [...customEq.bands] };
      state.selectedCustomEq.set(speaker.id, customEq.id);
      await writeEq(speaker.id, speaker.eq, false);
    }));
    persistUiState();
    logEvent("storage", "custom-eq", `applied ${customEq.name} to ${targets.length} speaker`);
    render();
  }

  function deleteCustomEq(customEqId) {
    const localCustomEq = state.customEqs.find((item) => item.id === customEqId);
    if (!localCustomEq) {
      const reason = state.defaultEqs.some((item) => item.id === customEqId)
        ? "repository preset is read-only"
        : "preset not found";
      logEvent("warn", "custom-eq", `delete blocked: ${reason}`);
      render();
      return;
    }
    const next = state.customEqs.filter((item) => item.id !== customEqId);
    persistCustomEqs(next);
    state.customEqs = next;
    for (const [speakerId, selectedId] of state.selectedCustomEq.entries()) {
      if (selectedId === customEqId) state.selectedCustomEq.delete(speakerId);
    }
    persistUiState();
    logEvent("storage", "custom-eq", `deleted ${customEqId}`);
    render();
  }

  function render() {
    renderSupport();
    renderTabs();
    renderLimits();
    renderStats();
    renderSpeakers();
    renderGroups();
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
    document.body.dataset.view = state.view;
    $$(".tab").forEach((tab) => {
      const active = tab.dataset.view === state.view;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    $$(".view").forEach((view) => {
      const active = view.id === `${state.view}View`;
      view.classList.toggle("is-active", active);
      view.setAttribute("aria-hidden", String(!active));
    });
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
    $("#customEqCount").textContent = String(customEqLibrary().length);
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

  function renderSpeakerCard(speaker, cardIndex) {
    const online = isOnline(speaker);
    const eq = speaker.eq || structuredCloneSafe(DEFAULT_EQ);
    const disabled = online ? "" : "disabled";
    const statusClass = online ? "ok" : speaker.connectionState === "error" ? "error" : "warn";
    const raw = Number(speaker.rawVolume || 0);
    const volumeSummary = formatVolumeSummary(raw);
    const level = levelNumberFromRaw(raw);
    const volumeFaderPosition = faderPosition(raw, 0, 255, true);
    const expanded = state.expandedCustomEq.has(speaker.id);
    const accordionId = `custom-eq-${cardIndex}`;
    const selectedCustomEqId = getSelectedCustomEqId([speaker]);
    const customEqActive = expanded || eq.preset === "custom" || Boolean(selectedCustomEqId);
    const stereoRole = ROLE_VALUES.includes(speaker.stereoRole) ? speaker.stereoRole : "M";
    const teamUpMode = TEAMUP_VALUES.includes(speaker.teamUpMode) ? speaker.teamUpMode : "solo";
    const speakerTitle = `${speakerDisplayId(speaker)} | ${stereoRole} | ${TEAMUP_LABELS[teamUpMode]} | ${EQ_LABELS[eq.preset] || EQ_LABELS.custom}`;

    return `
      <article class="speaker-card ${expanded ? "is-custom-eq-expanded" : ""}" data-card-speaker="${escapeAttr(speaker.id)}">
        <div class="card-heading speaker-panel speaker-card__title">
          <div class="speaker-title">
            <h2>${escapeHtml(speakerTitle)}</h2>
          </div>
          <span class="status-pill ${statusClass}">${escapeHtml(speaker.connectionState)}</span>
        </div>

        <section class="speaker-settings speaker-panel">
          <div class="speaker-control-deck">
            <div class="meter-wrap">
              <div class="fader-head">
                <span class="section-label">Level</span>
              </div>
              <div class="vertical-fader-slot">
                <input class="range range--vertical" type="range" min="0" max="255" value="${raw}" ${disabled}
                  style="--fader-position: ${volumeFaderPosition}"
                  aria-label="Raw Volume ${escapeAttr(speaker.name || speaker.id)}"
                  data-control="volume" data-speaker-id="${escapeAttr(speaker.id)}">
              </div>
              <p class="meter-caption">
                <span data-volume-summary="${escapeAttr(speaker.id)}">${volumeSummary}</span>
                <output class="meter-raw" data-raw-volume="${escapeAttr(speaker.id)}" aria-label="Raw volume ${raw} von 255">${raw} / 255</output>
                <span>Limit: ${escapeHtml(state.activeLimit)}</span>
              </p>
            </div>

            <div class="control-divider deck-divider" aria-hidden="true"></div>

            <div class="quick-actions-shell">
              <div class="mode-control-layout">
                <div class="mode-stack quick-stack quick-stack--system" role="group" aria-label="System and Custom actions">
                  <button class="mode-button quick-action-button protocol-unavailable" type="button" disabled
                    aria-label="Power off" title="Power-off BLE command not mapped">
                    <span class="power-icon" aria-hidden="true"></span>
                  </button>
                  <div class="custom-eq-combo ${customEqActive ? "is-active" : ""}">
                    <button class="custom-eq-toggle" type="button" ${disabled}
                      data-action="toggle-custom-eq" data-speaker-id="${escapeAttr(speaker.id)}"
                      aria-controls="${accordionId}" aria-expanded="${String(expanded)}"
                      aria-label="${expanded ? "Custom EQ ausblenden" : "Custom EQ einblenden"}"
                      title="${expanded ? "Custom EQ ausblenden" : "Custom EQ einblenden"}">
                      <span>Custom<br>EQ</span>
                    </button>
                    <select class="custom-eq-select" data-control="custom-eq-preset"
                      data-speaker-id="${escapeAttr(speaker.id)}" ${online && customEqLibrary().length ? "" : "disabled"}
                      aria-label="Gespeicherten Custom EQ waehlen" title="Gespeicherten Custom EQ waehlen">
                      ${customEqOptions(selectedCustomEqId)}
                    </select>
                  </div>
                </div>

                <div class="control-divider" aria-hidden="true"></div>

                <div class="mode-stack quick-stack quick-stack--eq" role="group" aria-label="Quick EQ Presets">
                  ${QUICK_EQ_PRESETS.map((preset) => `
                    <button class="mode-button quick-action-button ${eq.preset === preset ? "is-active" : ""}" type="button" ${disabled}
                      data-action="eq-preset" data-preset="${preset}" data-speaker-id="${escapeAttr(speaker.id)}"
                      aria-pressed="${String(eq.preset === preset)}"><span>${preset === "dancefloor" ? "Dance<wbr>floor" : EQ_LABELS[preset]}</span></button>
                  `).join("")}
                </div>

                <div class="control-divider" aria-hidden="true"></div>

                <div class="level-control-grid" role="group" aria-label="Volume controls">
                  ${stepButton(speaker.id, "min", 0, "set", disabled)}
                  ${stepButton(speaker.id, "mid", 128, "set", disabled)}
                  ${stepButton(speaker.id, "max", 255, "set", disabled)}
                  ${stepButton(speaker.id, "-1", -1, "step", disabled)}
                  <output class="level-badge" data-level-readout="${escapeAttr(speaker.id)}" aria-label="Level ${level}">${level}</output>
                  ${stepButton(speaker.id, "+1", 1, "step", disabled)}
                  ${stepButton(speaker.id, "-10", -10, "step", disabled)}
                  <button class="mode-button protocol-unavailable" type="button" disabled
                    aria-label="SKAA Pro" title="SKAA Pro BLE command not mapped"><span>SKAA<br>Pro</span></button>
                  ${stepButton(speaker.id, "+10", 10, "step", disabled)}
                </div>

                <div class="control-divider" aria-hidden="true"></div>

                <div class="mode-stack mode-stack--role" role="group" aria-label="Stereo Role">
                  ${ROLE_VALUES.map((role) => `
                    <button class="mode-button ${stereoRole === role ? "is-active" : ""}" type="button" ${disabled}
                      data-action="role" data-role="${role}" data-speaker-id="${escapeAttr(speaker.id)}"
                      aria-pressed="${String(stereoRole === role)}"><span>${role}</span></button>
                  `).join("")}
                </div>

                <div class="control-divider" aria-hidden="true"></div>

                <div class="mode-stack mode-stack--team" role="group" aria-label="TeamUp Mode">
                  ${TEAMUP_VALUES.map((mode) => `
                    <button class="mode-button ${teamUpMode === mode ? "is-active" : ""}" type="button" ${disabled}
                      data-action="teamup" data-mode="${mode}" data-speaker-id="${escapeAttr(speaker.id)}"
                      aria-pressed="${String(teamUpMode === mode)}"><span>${TEAMUP_LABELS[mode]}</span></button>
                  `).join("")}
                </div>
              </div>
            </div>
          </div>

          <div id="${accordionId}" class="custom-eq-accordion" ${expanded ? "" : "hidden"} aria-hidden="${String(!expanded)}">
            <div class="control-section eq-panel">
              <div class="eq-header">
                <span class="section-label">Custom EQ</span>
                <div class="eq-header-tools">
                  <span class="eq-active">${EQ_LABELS[eq.preset]}</span>
                  <button class="eq-save-action" type="button" data-action="save-custom-eq"
                    data-speaker-id="${escapeAttr(speaker.id)}">Lokal speichern</button>
                  ${deleteCustomEqButton(selectedCustomEqId)}
                </div>
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
                        style="--fader-position: ${faderPosition(numericValue, -10, 10, true)}"
                        aria-label="${EQ_BANDS[index]} ${numericValue}"
                        data-control="band" data-band="${index}" data-speaker-id="${escapeAttr(speaker.id)}">
                      <span class="band-label">${EQ_BANDS[index]}</span>
                    </label>
                  `;
                }).join("")}
              </div>
            </div>
          </div>

          <div class="header-actions speaker-actions">
            <button class="ghost-action" type="button" data-action="read-state" data-speaker-id="${escapeAttr(speaker.id)}" ${disabled}>Status lesen</button>
            <button class="ghost-action" type="button" data-action="disconnect" data-speaker-id="${escapeAttr(speaker.id)}">Trennen</button>
          </div>
          ${speaker.error ? `<div class="callout speaker-error">${escapeHtml(speaker.error)}</div>` : ""}
        </section>
      </article>
    `;
  }

  function stepButton(speakerId, label, value, mode, disabled) {
    const action = mode === "set" ? "volume-set" : "volume-step";
    const data = mode === "set" ? `data-value="${value}"` : `data-delta="${value}"`;
    return `<button class="step-button" type="button" ${disabled} data-action="${action}" ${data} data-speaker-id="${escapeAttr(speakerId)}"><span>${escapeHtml(label)}</span></button>`;
  }

  function renderGroups() {
    const grid = $("#groupsGrid");
    normalizeDefaultGroup();
    grid.innerHTML = state.groups.map(renderGroupControlCard).join("") || renderEmptyMessage("Keine Gruppen definiert.");
  }

  function renderGroupControlCard(group, cardIndex) {
    const online = isGroupOnline(group);
    const speakers = getGroupSpeakers(group);
    const disabled = online ? "" : "disabled";
    const scope = getGroupScope(group);
    const actionTargets = getGroupActionTargets(group.id);
    const referenceSpeaker = actionTargets[0] || speakers[0];
    const eq = referenceSpeaker?.eq || structuredCloneSafe(DEFAULT_EQ);
    const raw = groupRawVolume(group);
    const expanded = state.expandedGroupCustomEq.has(group.id);
    const selectedCustomEqId = getSelectedCustomEqId(actionTargets);
    const commonEqPreset = getCommonSpeakerValue(actionTargets, (speaker) => speaker.eq?.preset);
    const scopeLabel = scope === "group"
      ? "Gruppe"
      : speakerDisplayId(getSpeaker(scope) || { id: scope });
    const context = {
      group,
      online,
      speakers,
      disabled,
      scope,
      scopeLabel,
      actionTargets,
      eq,
      raw,
      expanded,
      selectedCustomEqId,
      commonEqPreset,
      accordionId: `group-custom-eq-${cardIndex}`
    };

    return `
      <article class="speaker-card group-control-card ${expanded ? "is-custom-eq-expanded" : ""}" data-card-group="${escapeAttr(group.id)}">
        <div class="card-heading speaker-panel speaker-card__title">
          <div class="speaker-title">
            <h2>${escapeHtml(group.name)} | ${escapeHtml(scopeLabel)}</h2>
            <p class="group-members">${speakers.map((speaker) => escapeHtml(speakerDisplayId(speaker))).join(" + ") || "Noch keine Speaker"}</p>
          </div>
          <span class="status-pill ${online ? "ok" : "warn"}">${online ? "online" : "waiting"}</span>
        </div>

        <section class="speaker-settings speaker-panel">
          <div class="group-scope-bar">
            <span class="section-label">Action Scope</span>
            <div class="group-scope-switch" role="group" aria-label="Gruppenaktionen anwenden auf">
              <button class="scope-button ${scope === "group" ? "is-active" : ""}" type="button"
                data-action="group-scope" data-group-id="${escapeAttr(group.id)}" data-scope="group"
                aria-pressed="${String(scope === "group")}">Gruppe</button>
              ${speakers.map((speaker, index) => `
                <button class="scope-button ${scope === speaker.id ? "is-active" : ""}" type="button"
                  data-action="group-scope" data-group-id="${escapeAttr(group.id)}" data-scope="${escapeAttr(speaker.id)}"
                  aria-pressed="${String(scope === speaker.id)}" title="${escapeAttr(speakerDisplayId(speaker))}">SB ${index + 1}</button>
              `).join("")}
            </div>
          </div>

          <div class="speaker-control-deck">
            <div class="meter-wrap">
              <div class="fader-head"><span class="section-label">Level</span></div>
              <div class="vertical-fader-slot">
                <input class="range range--vertical" type="range" min="0" max="255" value="${raw}" ${disabled}
                  style="--fader-position: ${faderPosition(raw, 0, 255, true)}"
                  aria-label="Gruppenlautstaerke ${escapeAttr(group.name)}"
                  data-control="group-volume" data-group-id="${escapeAttr(group.id)}">
              </div>
              <p class="meter-caption">
                <span data-group-volume-summary="${escapeAttr(group.id)}">${formatVolumeSummary(raw)}</span>
                <output class="meter-raw" data-group-raw-volume="${escapeAttr(group.id)}" aria-label="Raw volume ${raw} von 255">${raw} / 255</output>
                <span>Limit: ${escapeHtml(state.activeLimit)}</span>
              </p>
            </div>

            <div class="control-divider deck-divider" aria-hidden="true"></div>
            <div class="quick-actions-shell">${renderGroupQuickActions(context)}</div>
          </div>

          ${renderGroupEqEditor(context)}
        </section>
      </article>
    `;
  }

  function renderGroupQuickActions(context) {
    const {
      group,
      disabled,
      scope,
      actionTargets,
      expanded,
      selectedCustomEqId,
      commonEqPreset,
      accordionId
    } = context;
    const customEqActive = expanded || commonEqPreset === "custom" || Boolean(selectedCustomEqId);

    return `
      <div class="mode-control-layout">
        <div class="mode-stack quick-stack quick-stack--system" role="group" aria-label="System and Custom actions">
          <button class="mode-button quick-action-button protocol-unavailable" type="button" disabled
            aria-label="Power off" title="Power-off BLE command not mapped"><span class="power-icon" aria-hidden="true"></span></button>
          <div class="custom-eq-combo ${customEqActive ? "is-active" : ""}">
            <button class="custom-eq-toggle" type="button" ${disabled}
              data-action="group-toggle-custom-eq" data-group-id="${escapeAttr(group.id)}"
              aria-controls="${accordionId}" aria-expanded="${String(expanded)}"
              aria-label="${expanded ? "Custom EQ ausblenden" : "Custom EQ einblenden"}"
              title="${expanded ? "Custom EQ ausblenden" : "Custom EQ einblenden"}"><span>Custom<br>EQ</span></button>
            <select class="custom-eq-select" data-control="group-custom-eq-preset"
              data-group-id="${escapeAttr(group.id)}" ${context.online && customEqLibrary().length ? "" : "disabled"}
              aria-label="Gespeicherten Gruppen-EQ waehlen" title="Gespeicherten Gruppen-EQ waehlen">
              ${customEqOptions(selectedCustomEqId)}
            </select>
          </div>
        </div>

        <div class="control-divider" aria-hidden="true"></div>

        <div class="mode-stack quick-stack quick-stack--eq" role="group" aria-label="Quick EQ Presets">
          ${QUICK_EQ_PRESETS.map((preset) => {
            const active = actionTargets.length > 0 && actionTargets.every((speaker) => speaker.eq?.preset === preset);
            return `
              <button class="mode-button quick-action-button ${active ? "is-active" : ""}" type="button" ${disabled}
                data-action="group-eq-preset" data-preset="${preset}" data-group-id="${escapeAttr(group.id)}"
                aria-pressed="${String(active)}"><span>${preset === "dancefloor" ? "Dance<wbr>floor" : EQ_LABELS[preset]}</span></button>
            `;
          }).join("")}
        </div>

        <div class="control-divider" aria-hidden="true"></div>

        <div class="level-control-grid" role="group" aria-label="Gruppenlautstaerke">
          ${groupStepButton(group.id, "min", 0, "set", disabled)}
          ${groupStepButton(group.id, "mid", 128, "set", disabled)}
          ${groupStepButton(group.id, "max", 255, "set", disabled)}
          ${groupStepButton(group.id, "-1", -1, "step", disabled)}
          <output class="level-badge" data-group-level-readout="${escapeAttr(group.id)}" aria-label="Level ${levelNumberFromRaw(context.raw)}">${levelNumberFromRaw(context.raw)}</output>
          ${groupStepButton(group.id, "+1", 1, "step", disabled)}
          ${groupStepButton(group.id, "-10", -10, "step", disabled)}
          <button class="mode-button protocol-unavailable" type="button" disabled
            aria-label="SKAA Pro" title="SKAA Pro BLE command not mapped"><span>SKAA<br>Pro</span></button>
          ${groupStepButton(group.id, "+10", 10, "step", disabled)}
        </div>

        <div class="control-divider" aria-hidden="true"></div>

        <div class="mode-stack mode-stack--role" role="group" aria-label="Stereo Role">
          ${renderGroupRoleButtons(group, scope, disabled)}
        </div>

        <div class="control-divider" aria-hidden="true"></div>

        <div class="mode-stack mode-stack--team" role="group" aria-label="TeamUp Mode">
          ${TEAMUP_VALUES.map((mode) => {
            const active = isGroupTeamModeActive(group, scope, mode);
            return `
              <button class="mode-button ${active ? "is-active" : ""}" type="button" ${disabled}
                data-action="group-teamup" data-mode="${mode}" data-group-id="${escapeAttr(group.id)}"
                aria-pressed="${String(active)}"><span>${TEAMUP_LABELS[mode]}</span></button>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderGroupEqEditor(context) {
    const { group, disabled, scopeLabel, eq, expanded, selectedCustomEqId, commonEqPreset, accordionId } = context;
    return `
      <div id="${accordionId}" class="custom-eq-accordion" ${expanded ? "" : "hidden"} aria-hidden="${String(!expanded)}">
        <div class="control-section eq-panel">
          <div class="eq-header">
            <span class="section-label">Custom EQ / ${escapeHtml(scopeLabel)}</span>
            <div class="eq-header-tools">
              <span class="eq-active">${escapeHtml(commonEqPreset ? EQ_LABELS[commonEqPreset] || commonEqPreset : "Mixed")}</span>
              <button class="eq-save-action" type="button" data-action="group-save-custom-eq"
                data-group-id="${escapeAttr(group.id)}">Lokal speichern</button>
              ${deleteCustomEqButton(selectedCustomEqId)}
            </div>
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
                    style="--fader-position: ${faderPosition(numericValue, -10, 10, true)}"
                    aria-label="${EQ_BANDS[index]} ${numericValue}"
                    data-control="group-band" data-band="${index}" data-group-id="${escapeAttr(group.id)}">
                  <span class="band-label">${EQ_BANDS[index]}</span>
                </label>
              `;
            }).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function groupStepButton(groupId, label, value, mode, disabled) {
    const action = mode === "set" ? "group-volume-set" : "group-volume";
    const data = mode === "set" ? `data-value="${value}"` : `data-delta="${value}"`;
    return `<button class="step-button" type="button" ${disabled} data-action="${action}" ${data} data-group-id="${escapeAttr(groupId)}"><span>${escapeHtml(label)}</span></button>`;
  }

  function renderGroupRoleButtons(group, scope, disabled) {
    if (scope === "group") {
      const routes = [
        { value: "left_right", label: "L / R" },
        { value: "mono_both", label: "M / M" },
        { value: "right_left", label: "R / L" }
      ];
      return routes.map(({ value, label }) => {
        const active = isGroupRouteActive(group, value);
        return `<button class="mode-button ${active ? "is-active" : ""}" type="button" ${disabled}
          data-action="group-role" data-value="${value}" data-group-id="${escapeAttr(group.id)}"
          aria-pressed="${String(active)}"><span>${label}</span></button>`;
      }).join("");
    }

    const speaker = getSpeaker(scope);
    return ROLE_VALUES.map((role) => `
      <button class="mode-button ${speaker?.stereoRole === role ? "is-active" : ""}" type="button" ${disabled}
        data-action="group-role" data-value="${role}" data-group-id="${escapeAttr(group.id)}"
        aria-pressed="${String(speaker?.stereoRole === role)}"><span>${role}</span></button>
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
    if (!VIEW_IDS.includes(view)) return;
    state.view = view;
    persistUiState();
    render();
    history.replaceState(null, "", `${location.pathname}${location.search}#${view}`);
    window.requestAnimationFrame(() => {
      const target = $(".main-stage");
      if (!target) return;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const topOffset = window.innerWidth <= 760 ? 72 : 88;
      const top = target.getBoundingClientRect().top + window.scrollY - topOffset;
      window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : "smooth" });
    });
  }

  function setSessionState(value) {
    $("#sessionState").textContent = value;
  }

  function updateSpeaker(speakerId, patch) {
    const speaker = getSpeaker(speakerId);
    if (!speaker) return;
    let selectionChanged = false;
    if (patch.eq) {
      const selectedId = state.selectedCustomEq.get(speakerId);
      const selectedEq = findCustomEq(selectedId);
      if (!selectedEq || patch.eq.preset !== "custom" || !sameEqBands(patch.eq.bands, selectedEq.bands)) {
        selectionChanged = state.selectedCustomEq.delete(speakerId);
      }
    }
    Object.assign(speaker, patch, { lastSeenAt: Date.now() });
    if (typeof speaker.rawVolume === "number") {
      speaker.rawVolume = clamp(speaker.rawVolume, 0, 255);
    }
    if (selectionChanged) persistUiState();
    render();
  }

  function updateVolumeDom(speakerId, rawVolume) {
    const level = document.querySelector(`[data-level-readout="${cssEscape(speakerId)}"]`);
    const raw = document.querySelector(`[data-raw-volume="${cssEscape(speakerId)}"]`);
    const summary = document.querySelector(`[data-volume-summary="${cssEscape(speakerId)}"]`);
    if (level) {
      const levelNumber = levelNumberFromRaw(rawVolume);
      level.textContent = String(levelNumber);
      level.closest(".level-badge")?.setAttribute("aria-label", `Level ${levelNumber}`);
    }
    if (raw) {
      raw.textContent = `${rawVolume} / 255`;
      raw.setAttribute("aria-label", `Raw volume ${rawVolume} von 255`);
    }
    if (summary) summary.textContent = formatVolumeSummary(rawVolume);
  }

  function updateGroupVolumeDom(groupId, rawVolume) {
    const level = document.querySelector(`[data-group-level-readout="${cssEscape(groupId)}"]`);
    const raw = document.querySelector(`[data-group-raw-volume="${cssEscape(groupId)}"]`);
    const summary = document.querySelector(`[data-group-volume-summary="${cssEscape(groupId)}"]`);
    if (level) {
      const levelNumber = levelNumberFromRaw(rawVolume);
      level.textContent = String(levelNumber);
      level.setAttribute("aria-label", `Level ${levelNumber}`);
    }
    if (raw) {
      raw.textContent = `${rawVolume} / 255`;
      raw.setAttribute("aria-label", `Raw volume ${rawVolume} von 255`);
    }
    if (summary) summary.textContent = formatVolumeSummary(rawVolume);
  }

  function updateBandControlDom(target, rawValue) {
    const value = clamp(Number(rawValue), -10, 10);
    const control = target.closest(".band-control");
    const valueLabel = control?.querySelector(".band-value");
    const curveBars = target.closest(".eq-panel")?.querySelectorAll(".eq-curve i");
    target.style.setProperty("--fader-position", faderPosition(value, -10, 10, true));
    if (valueLabel) valueLabel.textContent = `${value > 0 ? "+" : ""}${value}`;
    if (curveBars?.[Number(target.dataset.band)]) {
      curveBars[Number(target.dataset.band)].style.height = `${44 + value * 3}px`;
    }
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

  function getGroup(groupId) {
    return state.groups.find((group) => group.id === groupId);
  }

  function getGroupSpeakers(group) {
    return (group?.speakerIds || []).map(getSpeaker).filter(Boolean);
  }

  function getGroupScope(group) {
    if (!group) return "group";
    const scope = state.groupScopes.get(group.id) || "group";
    if (scope === "group" || group.speakerIds.includes(scope)) return scope;
    if (group.speakerIds.length < 2) return scope;
    state.groupScopes.set(group.id, "group");
    persistUiState();
    return "group";
  }

  function getGroupActionTargets(groupId) {
    const group = getGroup(groupId);
    if (!group) return [];
    const scope = getGroupScope(group);
    if (scope === "group") return getGroupSpeakers(group).filter(isOnline);
    const speaker = getSpeaker(scope);
    return isOnline(speaker) ? [speaker] : [];
  }

  function groupRawVolume(group) {
    const speakers = getGroupSpeakers(group);
    if (!speakers.length) return 0;
    const total = speakers.reduce((sum, speaker) => sum + Number(speaker.rawVolume || 0), 0);
    return Math.round(total / speakers.length);
  }

  function getCommonSpeakerValue(speakers, selector) {
    if (!speakers.length) return "";
    const first = selector(speakers[0]);
    return speakers.every((speaker) => selector(speaker) === first) ? first : "";
  }

  function isGroupRouteActive(group, route) {
    const [first, second] = getGroupSpeakers(group);
    if (!first || !second) return false;
    if (route === "mono_both") return first.stereoRole === "M" && second.stereoRole === "M";
    if (route === "left_right") return first.stereoRole === "L" && second.stereoRole === "R";
    if (route === "right_left") return first.stereoRole === "R" && second.stereoRole === "L";
    return false;
  }

  function isGroupTeamModeActive(group, scope, mode) {
    if (scope !== "group") return getSpeaker(scope)?.teamUpMode === mode;
    const speakers = getGroupSpeakers(group);
    if (!speakers.length) return false;
    if (mode === "host") {
      return speakers[0].teamUpMode === "host" && speakers.slice(1).every((speaker) => speaker.teamUpMode === "join");
    }
    return speakers.every((speaker) => speaker.teamUpMode === mode);
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

  function formatVolumeSummary(rawVolume) {
    const raw = clamp(Number(rawVolume), 0, 255);
    const rawPercent = Math.round((raw / 255) * 100);
    const limit = getActiveLimit();
    if (limit.maxRaw >= 255) return `${rawPercent}% RAW`;
    const limitPercent = Math.round((raw / limit.maxRaw) * 100);
    return `${limitPercent}% LIMIT (${rawPercent}% RAW)`;
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

  function levelNumberFromRaw(raw) {
    const value = clamp(Number(raw), 0, 255);
    if (value === 0) return 0;
    if (value <= 16) return 1;
    if (value <= 44) return 2;
    if (value <= 72) return 3;
    if (value <= 100) return 4;
    if (value <= 128) return 5;
    if (value <= 156) return 6;
    if (value <= 184) return 7;
    if (value <= 212) return 8;
    if (value <= 240) return 9;
    if (value <= 254) return 10;
    return 11;
  }

  function faderPosition(value, min, max, reverse = false) {
    const ratio = (clamp(Number(value), min, max) - min) / (max - min);
    const position = reverse ? 1 - ratio : ratio;
    const percent = Number((position * 100).toFixed(4));
    const pixelOffset = Number(((0.5 - position) * 21).toFixed(3));
    const operator = pixelOffset < 0 ? "-" : "+";
    return `calc(${percent}% ${operator} ${Math.abs(pixelOffset)}px)`;
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

  function speakerDisplayId(speaker) {
    return speaker.teamId || extractTeamId(speaker.name) || speaker.bluetoothDeviceId || speaker.id || "SOUNDBOKS 4";
  }

  function customEqOptions(selectedId) {
    const library = customEqLibrary();
    const placeholder = library.length ? "Preset" : "Keine Presets";
    return [
      `<option value="">${placeholder}</option>`,
      state.defaultEqs.length ? `
        <optgroup label="Standardpresets">
          ${state.defaultEqs.map(customEqOption).join("")}
        </optgroup>
      ` : "",
      state.customEqs.length ? `
        <optgroup label="Eigene Presets">
          ${state.customEqs.map(customEqOption).join("")}
        </optgroup>
      ` : ""
    ].join("");

    function customEqOption(customEq) {
      return `<option value="${escapeAttr(customEq.id)}" ${customEq.id === selectedId ? "selected" : ""}>${escapeHtml(customEq.name)}</option>`;
    }
  }

  function deleteCustomEqButton(customEqId) {
    const local = isLocalCustomEq(customEqId);
    const label = local ? "Preset loeschen" : "Repository-Preset kann nicht geloescht werden";
    return `<button class="eq-delete-action" type="button" data-action="delete-custom-eq"
      data-custom-eq-id="${escapeAttr(customEqId)}" ${local ? "" : "disabled"}
      aria-label="${label}" title="${label}">Preset loeschen</button>`;
  }

  function customEqLibrary() {
    return [...state.defaultEqs, ...state.customEqs];
  }

  function findCustomEq(customEqId) {
    return customEqLibrary().find((item) => item.id === customEqId);
  }

  function isLocalCustomEq(customEqId) {
    return Boolean(customEqId) && state.customEqs.some((item) => item.id === customEqId);
  }

  function getSelectedCustomEqId(speakers) {
    if (!speakers.length) return "";
    const selectedIds = speakers.map((speaker) => state.selectedCustomEq.get(speaker.id) || "");
    const selectedId = selectedIds[0];
    if (!selectedId || !selectedIds.every((id) => id === selectedId)) return "";
    const customEq = findCustomEq(selectedId);
    if (!customEq) return "";
    return speakers.every((speaker) => sameEqBands(speaker.eq?.bands, customEq.bands))
      ? selectedId
      : "";
  }

  function sameEqBands(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === EQ_BANDS.length && right.length === EQ_BANDS.length &&
      left.every((value, index) => Number(value) === Number(right[index]));
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

  function loadUiState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(UI_STATE_STORAGE) || "null");
      if (!parsed || parsed.version !== 1) return;
      if (VIEW_IDS.includes(parsed.view)) state.view = parsed.view;
      if (LIMITS.some((limit) => limit.name === parsed.activeLimit)) state.activeLimit = parsed.activeLimit;
      state.expandedCustomEq = new Set(normalizeStoredIds(parsed.expandedCustomEq));
      state.expandedGroupCustomEq = new Set(normalizeStoredIds(parsed.expandedGroupCustomEq));
      state.selectedCustomEq = new Map(normalizeStoredEntries(parsed.selectedCustomEq)
        .filter(([, customEqId]) => Boolean(findCustomEq(customEqId))));
      state.groupScopes = new Map(normalizeStoredEntries(parsed.groupScopes));
    } catch (error) {
      logEvent("warn", "storage", `UI state: ${error.message}`);
    }
  }

  function persistUiState() {
    try {
      localStorage.setItem(UI_STATE_STORAGE, JSON.stringify({
        version: 1,
        view: state.view,
        activeLimit: state.activeLimit,
        expandedCustomEq: [...state.expandedCustomEq],
        expandedGroupCustomEq: [...state.expandedGroupCustomEq],
        selectedCustomEq: [...state.selectedCustomEq.entries()],
        groupScopes: [...state.groupScopes.entries()]
      }));
    } catch (error) {
      logEvent("warn", "storage", `UI state: ${error.message}`);
    }
  }

  function normalizeStoredIds(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string" && item.length <= 120).slice(0, 50);
  }

  function normalizeStoredEntries(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => Array.isArray(entry) && entry.length === 2 &&
      typeof entry[0] === "string" && entry[0].length <= 120 &&
      typeof entry[1] === "string" && entry[1].length <= 120).slice(0, 50);
  }

  async function loadDefaultEqs() {
    state.defaultEqs = FALLBACK_DEFAULT_EQS.map(normalizeRepositoryPreset).filter(Boolean);

    try {
      const catalogUrl = new URL(DEFAULT_PRESET_CATALOG_URL, document.baseURI);
      const catalog = await fetchPresetJson(catalogUrl);
      if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.presets)) {
        throw new Error("invalid catalog format");
      }

      const filenames = [...new Set(catalog.presets)].filter((filename) =>
        typeof filename === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(filename)
      );
      if (!filenames.length || filenames.length !== catalog.presets.length) {
        throw new Error("catalog contains invalid preset paths");
      }

      const records = await Promise.all(filenames.map((filename) =>
        fetchPresetJson(new URL(filename, catalogUrl))
      ));
      const presets = records.map(normalizeRepositoryPreset);
      if (presets.some((preset) => !preset)) {
        throw new Error("catalog contains an invalid preset");
      }
      if (new Set(presets.map((preset) => preset.id)).size !== presets.length) {
        throw new Error("catalog contains duplicate preset ids");
      }

      state.defaultEqs = presets;
      logEvent("preset", "repository", `loaded ${presets.length} default preset`);
    } catch (error) {
      logEvent("warn", "repository", `default presets: ${error.message}; fallback active`);
    }
  }

  async function fetchPresetJson(url) {
    const response = await fetch(url, {
      cache: "no-cache",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function normalizeRepositoryPreset(value) {
    const preset = normalizeCustomEqRecord(value);
    return preset ? { ...preset, origin: "repository", readOnly: true } : null;
  }

  function loadCustomEqs() {
    try {
      state.customEqs = readCustomEqCookie();
    } catch (error) {
      logEvent("warn", "storage", error.message);
      state.customEqs = [];
    }
  }

  function readCustomEqCookie() {
    const prefix = `${CUSTOM_EQ_COOKIE}=`;
    const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    if (!entry) return [];
    const parsed = JSON.parse(decodeURIComponent(entry.slice(prefix.length)));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeCustomEqRecord)
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_LOCAL_CUSTOM_EQS);
  }

  function persistCustomEqs(customEqs) {
    const normalized = customEqs
      .map(normalizeCustomEqRecord)
      .filter(Boolean)
      .slice(0, MAX_LOCAL_CUSTOM_EQS);
    const encoded = encodeURIComponent(JSON.stringify(normalized));
    if (`${CUSTOM_EQ_COOKIE}=${encoded}`.length > 3800) {
      throw new Error("Der lokale Custom-EQ-Cookie ist voll. Loesche zuerst ein Preset.");
    }

    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${CUSTOM_EQ_COOKIE}=${encoded}; Max-Age=31536000; Path=${customEqCookiePath()}; SameSite=Lax${secure}`;
    const persisted = document.cookie.split(";").some((part) => part.trim().startsWith(`${CUSTOM_EQ_COOKIE}=`));
    if (!persisted) throw new Error("Cookies sind blockiert; das Custom EQ konnte nicht gespeichert werden.");
  }

  function normalizeCustomEqRecord(value) {
    if (!value || typeof value !== "object") return null;
    const id = String(value.id || "").slice(0, 100);
    const name = String(value.name || "").trim().slice(0, 60);
    if (!id || !name || !Array.isArray(value.bands) || value.bands.length !== EQ_BANDS.length) return null;
    const createdAt = Number(value.createdAt);
    const updatedAt = Number(value.updatedAt);
    return {
      schemaVersion: 1,
      id,
      name,
      deviceModel: String(value.deviceModel || "SOUNDBOKS 4").slice(0, 40),
      sourceDevice: String(value.sourceDevice || "SOUNDBOKS 4").slice(0, 60),
      bands: normalizeCustomEqBands(value.bands),
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
    };
  }

  function normalizeCustomEqBands(values) {
    return EQ_BANDS.map((_, index) => {
      const value = Number(values?.[index]);
      return Math.round(clamp(Number.isFinite(value) ? value : 0, -10, 10));
    });
  }

  function customEqCookiePath() {
    const path = location.pathname || "/";
    if (path.endsWith("/")) return path;
    const directoryEnd = path.lastIndexOf("/") + 1;
    return path.slice(0, directoryEnd) || "/";
  }

  init().catch((error) => {
    logEvent("fatal", "app", error.message);
    render();
  });
})();

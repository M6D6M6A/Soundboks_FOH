# Soundboks_FOH Technical Spec

Diese Spezifikation wurde aus dem geteilten Projektchat extrahiert und mit aktuellem Web-Bluetooth-Support gegen Can I Use und Chrome-Dokumentation abgeglichen.

## Projektuebersicht

| Punkt | Inhalt |
| --- | --- |
| Projektname | `Soundboks_FOH` |
| Ziel | Lokale Web-App/PWA zur Steuerung von SOUNDBOKS 4 ueber Bluetooth Low Energy |
| Kernnutzen | Praezise FOH-taugliche Steuerung fuer einzelne Boxen, spaeter Gruppen und Setups |
| Zielgruppe | Eigene SOUNDBOKS-Setups, spaeter DJs, mobile PA, Outdoor/Rave, kleine Live-Setups |
| Ansatz | Web Bluetooth, direkte GATT-Kommunikation, lokale Speicherung, kein Cloud-Zwang |
| Abgrenzung | Kein iPhone/iOS-Websupport, keine Firmware-Modifikation, keine Account-/Lock-/Registration-Features |

## Confirmed BLE Surface

### Device Identification

| Feld | Wert | Status |
| --- | --- | --- |
| Manufacturer Data Company ID | `2136` | bestaetigt |
| Advertising Custom Service UUID | `f5c26570-64ec-4906-b998-6a7302879a2b` | bestaetigt |
| Beispiel Team IDs | `#304327`, `#360355` | beobachtet |
| Beispiel Namen | `AppControl #360355`, `#360355` | beobachtet |

### GATT Characteristics

| Funktion | Service UUID | Characteristic UUID | Typ | Status |
| --- | --- | --- | --- | --- |
| Volume | `445b9ffb-348f-4e1b-a417-3559b8138390` | `7649b19f-c605-46e2-98f8-6c1808e0cfb4` | `uint8` | Confirmed |
| TeamUp Mode | `46c69d1b-7194-46f0-837c-ab7a6b94566f` | `37bffa18-7f5a-4c8d-8a2d-362866cedfad` | ASCII string | Confirmed |
| EQ State | `3bbed7cf-287c-4333-9abf-2f0fbf161c79` | `57a394fb-6d89-4105-8f07-bf730338a9b2` | 7-byte struct | Confirmed |
| Stereo Role | `3bbed7cf-287c-4333-9abf-2f0fbf161c79` | `7d0d651e-62ae-4ef2-a727-0e8f3e9b4dfb` | `uint8 enum` | Confirmed |
| TeamUp Token | `46c69d1b-7194-46f0-837c-ab7a6b94566f` | `64215c77-5e08-4d7e-a082-b99d8e6fe809` | 8-byte opaque | Open |
| Secondary Status | `3bbed7cf-287c-4333-9abf-2f0fbf161c79` | `8d36814f-3741-4cb5-a018-ef4a2d8e24f1` | 6-byte struct | Open |

UUIDs sind kanonisch. BLE Handles nur fuer Debugging verwenden.

## Encoding

### Volume

Intern immer `rawVolume: 0..255` verwenden.

| App-Level | Raw Range |
| --- | --- |
| `L0` | `0` |
| `L1` | `1..16` |
| `L2` | `17..44` |
| `L3` | `45..72` |
| `L4` | `73..100` |
| `L5` | `101..128` |
| `L6` | `129..156` |
| `L7` | `157..184` |
| `L8` | `185..212` |
| `L9` | `213..240` |
| `L10` | `241..254` |
| `L11` | `255` |

### TeamUp Mode

ASCII-Werte:

- `solo`
- `host`
- `join`

### Stereo Role

| Raw | UI |
| --- | --- |
| `0x00` | `M` |
| `0x01` | `L` |
| `0x02` | `R` |

Nicht behaupten, wofuer `M` ausgeschrieben steht. Bis zur Verifikation nur als `M` anzeigen.

### EQ State

7-byte struct:

| Byte | Bedeutung |
| --- | --- |
| `0` | aktives Preset |
| `1` | Custom Band 1 |
| `2` | Custom Band 2 |
| `3` | Custom Band 3 |
| `4` | Custom Band 4 |
| `5` | Custom Band 5 |
| `6` | Custom Band 6 |

Preset Mapping:

| Byte 0 | Preset |
| --- | --- |
| `0x00` | Dancefloor |
| `0x01` | Stage |
| `0x02` | Lounge |
| `0x03` | Custom |

Band-Encoding:

- `0 => 0x00`
- sonst `raw = 51 + 5 * value`
- Wertebereich: `-10..10`

Beispiele:

| Band | Raw |
| --- | --- |
| `-10` | `0x01` |
| `-9` | `0x06` |
| `-4` | `0x1f` |
| `-3` | `0x24` |
| `-2` | `0x29` |
| `-1` | `0x2e` |
| `0` | `0x00` |
| `1` | `0x38` |
| `2` | `0x3d` |
| `3` | `0x42` |
| `4` | `0x47` |
| `5` | `0x4c` |
| `6` | `0x51` |
| `8` | `0x5b` |
| `10` | `0x65` |

Beim Wechsel weg von Custom aendert sich nur Byte 0. Die Custom-Baender 1..6 bleiben gespeichert.

## Open Protocol Fields

Diese Felder nicht fuer Core-MVP-Logik verwenden:

| Feld | UUID | Status |
| --- | --- | --- |
| Secondary Status | `8d36814f-3741-4cb5-a018-ef4a2d8e24f1` | 6 Byte, korreliert mit Topologie/TeamUp/Stereo Role, nicht vollstaendig dekodiert |
| TeamUp Token | `64215c77-5e08-4d7e-a082-b99d8e6fe809` | 8 Byte, oft null in Solo, non-zero auf Join-Seite bei TeamUp |
| Proprietary Transport | `f5c26570-64ec-4906-b998-6a7302879a2b` | echter Transportpfad, nicht formal dekodiert |

Nicht behaupten:

- `64215c77...` sei ein bestaetigtes SKAA-Pro-Flag.
- `M` bedeute sicher Mono, Main oder Master.
- Der proprietaere Transport sei vollstaendig verstanden.

### Proprietary Transport Notes

Service: `f5c26570-64ec-4906-b998-6a7302879a2b`

| Characteristic UUID | Handle | Properties |
| --- | --- | --- |
| `49535343-aca3-481c-91ec-d85e28a60318` | `0x0009` | write + notify |
| `49535343-1e4d-4bd9-ba61-23c647249616` | `0x000c` | notify only |
| `49535343-8841-43f4-a8d4-ecbe34729bb3` | `0x000f` | write only |

Beobachtete Command-Familien: `gdc`, `gu2`, `ski`.

## Platform Requirements

Web Bluetooth muss in einem Secure Context laufen. `navigator.bluetooth.requestDevice()` muss durch eine Nutzeraktion wie Klick oder Touch gestartet werden. Der Browser zeigt einen Device Chooser; der kann nicht vollautomatisch umgangen werden. Fuer Custom Services muessen `optionalServices` korrekt gesetzt werden.

Unterstuetzt:

- Android Chrome
- Desktop Chrome / Edge
- macOS Chrome
- ChromeOS Chrome
- Samsung Internet nach Test

Nicht unterstuetzt:

- iPhone / iOS Safari
- Safari Desktop
- Firefox

## Architecture

Empfohlener Stack:

- React
- TypeScript
- Vite
- PWA Setup
- Zustand fuer App-State
- IndexedDB fuer Setups und Presets
- kein Backend im MVP

Schichten:

```text
UI Components
  -> Application State / Commands
  -> Domain Models
  -> SoundboksBleClient
  -> WebBluetoothAdapter
  -> navigator.bluetooth
```

Suggested folders:

```text
src/
  ble/
    uuids.ts
    WebBluetoothAdapter.ts
    SoundboksBleClient.ts
    encoders.ts
    decoders.ts
  domain/
    Speaker.ts
    Group.ts
    Setup.ts
    Command.ts
  state/
    speakerStore.ts
    setupStore.ts
  ui/
    components/
    views/
  storage/
    indexedDb.ts
  diagnostics/
```

## Domain Models

```ts
type ConnectionState =
  | "idle"
  | "scanning"
  | "available"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "error"
  | "unsupported";

type TeamUpMode = "solo" | "host" | "join";
type StereoRole = "M" | "L" | "R";
type EqPreset = "dancefloor" | "stage" | "lounge" | "custom";

interface EqState {
  preset: EqPreset;
  bands: [number, number, number, number, number, number];
}

interface Speaker {
  id: string;
  teamId?: string;
  name?: string;
  bluetoothDeviceId?: string;
  connectionState: ConnectionState;
  rawVolume?: number;
  appLevel?: number;
  teamUpMode?: TeamUpMode;
  stereoRole?: StereoRole;
  eq?: EqState;
  lastSeenAt?: number;
  error?: string;
}

interface SpeakerGroup {
  id: string;
  name: string;
  speakerIds: string[];
  routingPreset?: RoutingPreset;
  requiresAllOnline: boolean;
}

type RoutingPreset = "mono_both" | "left_right" | "right_left" | "swap_left";

interface Setup {
  id: string;
  name: string;
  speakerStates: Record<string, Partial<Speaker>>;
  groups: SpeakerGroup[];
  volumeLimit?: VolumeLimit;
  createdAt: number;
  updatedAt: number;
}

interface VolumeLimit {
  name: "Home" | "Chill" | "Party" | string;
  minRaw: number;
  maxRaw: number;
}
```

## Definition of Done MVP

- App laeuft ueber HTTPS.
- Unsupported Browser zeigen eine klare Fehlermeldung.
- Eine SOUNDBOKS 4 kann gescannt, verbunden und getrennt werden.
- Volume Read/Write funktioniert.
- EQ Read/Write funktioniert.
- Stereo Role Read/Write funktioniert.
- TeamUp Mode Read/Write funktioniert.
- Notifications aktualisieren die UI.
- Lokale Presets bleiben nach Reload erhalten.
- Offene Protokollfelder werden nicht als bestaetigt gelabelt.

## Sources

- ChatGPT Share: https://chatgpt.com/share/6a3b220d-6710-83ed-afad-8ecf53d858c9
- Web Bluetooth support: https://caniuse.com/web-bluetooth
- Chrome Web Bluetooth docs: https://developer.chrome.com/docs/capabilities/bluetooth

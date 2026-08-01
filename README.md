# Soundboks_FOH

Soundboks_FOH ist eine lokale, responsive Web-App/PWA zur Steuerung von SOUNDBOKS 4 Lautsprechern ueber Web Bluetooth.

Ziel ist eine schnellere und praezisere FOH-taugliche Steuerung als in der offiziellen App: Raw-Volume, EQ, Stereo-Rollen, TeamUp-Modus, lokale Presets und spaeter Custom-Gruppen fuer mehrere Boxen.

## Zielplattformen

MVP-Ziel:

- Android Chrome
- Desktop Chrome / Edge auf Windows
- Chrome auf macOS
- optional Samsung Internet, wenn Web-Bluetooth-Tests stabil sind

Nicht im Web-MVP:

- iPhone / iOS
- Safari
- Firefox

Grund: Web Bluetooth ist laut aktuellem Supportstand in Safari/iOS und Firefox nicht verfuegbar. Chrome beschreibt Web Bluetooth als HTTPS-only API, die durch eine Nutzeraktion gestartet werden muss.

## Live-Demo

- App: <https://m6d6m6a.github.io/Soundboks_FOH/>
- Demo mit zwei virtuellen SB4: <https://m6d6m6a.github.io/Soundboks_FOH/?demo=1>

## Aktueller Funktionsumfang

Die aktuelle Version bietet:

- Browser-Support-Check fuer `navigator.bluetooth`
- Device Scan ueber SOUNDBOKS Advertising Service UUID und/oder Manufacturer Data
- Verbindung / Trennung
- Initiales Lesen von Volume, TeamUp Mode, Stereo Role und EQ State
- Notifications abonnieren, soweit verfuegbar
- Raw Volume `0..255` anzeigen und schreiben
- App-Level `L0..L11` aus Raw Volume ableiten
- Volume Slider plus Quick Buttons: `min`, `-10`, `-1`, `mid`, `+1`, `+10`, `max`
- EQ Presets: Dancefloor, Stage, Lounge, Custom
- sechs Custom-EQ-Baender `-10..10`
- Stereo Role `M`, `L`, `R`
- lokale Presets in IndexedDB
- Multi-Speaker Dashboard
- gemeinsame Gruppenlautstaerke und Stereo-Routing fuer ein Speaker-Paar
- Safety-Profile `Home 0-25`, `Chill 0-50`, `Party 0-255`
- Diagnoseansicht fuer BLE Reads, Writes und Notifications
- klare Zustaende fuer `idle`, `scanning`, `connecting`, `connected`, `disconnected`, `error`, `unsupported`

## Bedienoberflaeche

- Desktop: feste Session-Leiste und bis zu zwei Speaker nebeneinander
- Tablet: kompakte dreispaltige Session-Uebersicht
- Mobile: Bottom-Navigation, einspaltige Controls und Safe-Area-Unterstuetzung
- Monochromes, rasterbasiertes UI mit der Markenfarbe `#d95007`
- konturierte Oktagon-Fader mit transparenter Schienenluecke und radialem Level-Bedienfeld
- grosse Touch-Ziele, sichtbare Fokuszustaende und Reduced-Motion-Support

## Naechste technische Schritte

- reale Tests mit zwei SOUNDBOKS 4 und unterschiedlichen Firmware-Versionen
- frei editierbare Gruppen statt des vorbereiteten Front-Pair-Workflows
- detaillierter Setup Editor fuer Speaker-Zuordnung, EQ und Routing
- Reconnect- und Fehlerfaelle mit realer Hardware weiter haerten

## Grundregeln

- Keine Firmware-Modifikation.
- Keine Cloud-Abhaengigkeit im MVP.
- Keine offiziellen SOUNDBOKS-Assets, Logos oder Screenshots verwenden.
- Keine Account-, Lock/Unlock- oder Registration-Funktionen implementieren.
- UUIDs als stabile BLE-IDs verwenden, keine Handles.
- `Confirmed`, `Strongly supported` und `Open` sauber trennen.
- Offene Protokollfelder nicht mit erfundenen Namen versehen.

Siehe [docs/technical-spec.md](docs/technical-spec.md) fuer UUIDs, Encoding, Datenmodelle und Architektur.

## Lokal starten

```powershell
.\start-local.ps1
```

Dann oeffnen:

```text
http://127.0.0.1:5179/
```

Demo-Ansicht ohne echte Speaker:

```text
http://127.0.0.1:5179/?demo=1
```

# Soundboks_FOH Preset Library

This directory is the versioned source for built-in and shareable SOUNDBOKS 4 Custom EQ presets.

## Layout

- `schema.json` defines the accepted JSON format.
- `defaults/` contains the read-only presets shipped with the app.
- `defaults/catalog.json` explicitly lists every preset loaded by the static app.
- `community/` contains one reviewed preset per JSON file.
- Local presets remain in the browser cookie and are not uploaded automatically.

Repository defaults and local presets are separate libraries. Defaults can be selected and applied, but the app never writes them to cookies and never exposes a working delete action for them.

## Band order

Every `bands` array contains exactly six integer values from `-10` through `10` in this order:

1. 63 Hz
2. 160 Hz
3. 400 Hz
4. 1 kHz
5. 2.5 kHz
6. 6.3 kHz

## Contribution rules

- Use a lowercase, hyphenated filename and matching `id`.
- Validate the file against `../schema.json` before review.
- Describe the intended use without claiming unverified safety or hardware behavior.
- State an explicit license so presets can be redistributed by the app.
- Do not include volume, TeamUp, stereo-role, account, registration, or open-protocol data.

## Default preset rules

- Store one preset per JSON file in `defaults/`.
- Add every filename to `defaults/catalog.json`; browsers cannot enumerate a static directory.
- Treat an existing `id` as permanent because saved UI selections reference it.
- Keep repository defaults immutable in the app. Changes happen through reviewed Git commits only.

The future sharing flow should export this format and submit it for review before a file enters `community/`.

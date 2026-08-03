# Soundboks_FOH Community Presets

This directory is the versioned source for shareable SOUNDBOKS 4 Custom EQ presets.

## Layout

- `schema.json` defines the accepted JSON format.
- `community/` contains one reviewed preset per JSON file.
- Local presets remain in the browser cookie and are not uploaded automatically.

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

The future sharing flow should export this format and submit it for review before a file enters `community/`.

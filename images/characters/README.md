# Character portraits

Put one image per character here, named the way `imageUrl` in `characters.json` says:

- the first name the character is credited with, titles dropped ("Detective Quentin Lance" → `quentin_lance.jpg`)
- lowercase, accents removed, anything that isn't a letter or digit becomes `_`
- versions of the same person get their label: `barry_allen_earth_2.jpg`
- two characters with the same name get `_2`, `_3`… in order of first appearance

After each build, `report.json` (on the live site) lists every file still missing under `characters.images.missing`.

Square JPEGs around 256×256 work well; the app crops to a circle and keeps the top of the frame, where the face usually is. Characters without a file show their initials.

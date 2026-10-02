# GearGen

A small, self-contained involute spur gear designer and simulator for personal use.
It is an independent implementation built from standard gear formulas. There's
nothing to install, no build step, no account and no server.

## Running it

Open `index.html` in any modern browser (double-clicking it works). To serve it instead:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Your work is saved automatically in the browser's local storage. Use **Save .json** /
**Load .json** to keep designs as files.

## Features

- Involute spur gears: teeth, module, pressure angle (14.5° / 20° / 25°), backlash, bore
- Internal (ring) gears, for planetary-style layouts
- Gear trains: meshing gears, compound gears on the same axle, multiple independent drivers
- Live animation with correct speed ratios and directions; RPM and ratio shown for every gear
- Info per gear: pitch, tip, root and base diameters, circular pitch, centre distance, contact ratio
- Warnings for overlapping gears, ring and pinion tooth counts that are too close, and likely undercut
- Exports (in mm): the selected gear as **SVG** or **DXF** for laser cutting, CNC or CAD, and the whole layout as SVG

## Controls

| Action | How |
| --- | --- |
| Move a driver gear (and its whole train) | drag it; hold Shift to snap to 1 mm |
| Move a meshed gear around its parent | drag it |
| Pan / zoom | drag empty space / mouse wheel |
| Play / pause | <kbd>Space</kbd> |
| Delete selected (and the gears attached to it) | <kbd>Del</kbd> |
| Fit view | <kbd>F</kbd> |

## Notes and limitations

- Standard full-depth teeth (addendum 1·m, dedendum 1.25·m) with no profile shift. Undercut
  in low tooth counts is flagged but not modelled.
- Gears that mesh share the same module and pressure angle. Changing either on one gear
  updates every gear it meshes with.
- Positive RPM means clockwise on screen.

## Files

- `js/gear.js`: gear geometry (tooth profile, dimensions, SVG/DXF output)
- `js/app.js`: UI, kinematics, rendering
- `css/style.css`, `index.html`

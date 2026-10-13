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

- **Involute spur gears:** teeth, module, pressure angle (14.5° / 20° / 25°), backlash and clearance
- **Stronger small gears:** profile shift (with a one-click fix when undercut is likely) and root fillets. Centre distances and the working pressure angle adjust automatically for shifted pairs, and tips are shortened where needed so the root clearance is kept.
- **Internal (ring) gears** for planetary-style layouts, and **racks** that slide as their gear turns
- **Gear bodies:** round, keyway or D-flat bores, plus spoked cut-outs with adjustable hub, rim and spoke width
- **Gear trains:** meshing gears, compound gears on the same axle, multiple independent drivers
- **Live animation** with correct speed ratios and directions. Every gear shows its RPM; racks show their linear speed.
- **Per-part details:** pitch, tip, root and base diameters, circular pitch, centre distance, contact ratio
- **Warnings:** overlapping gears, ring and pinion tooth counts that are too close, spokes that don't fit
- **Undo / redo** for every change
- **Measuring tool:** distance, Δx/Δy and angle between any two points, snapping to part centres
- **Position lock:** stops a part being dragged or deleted by accident
- **Exports** (all in mm):
  - the selected part as **SVG** or **DXF** for laser cutting, CNC or CAD
  - the selected part as **STL** (extruded to its thickness) for 3D printing
  - the whole layout as SVG
- **True-scale printing:** print the selected part or the whole layout at 1:1, with a 50 mm scale bar to check against. Choose "Save as PDF" in the print dialog for a PDF.

## Controls

| Action | How |
| --- | --- |
| Move a driver gear (and its whole train) | drag it; hold Shift to snap to 1 mm |
| Move a meshed gear or rack around its parent | drag it |
| Pan / zoom | drag empty space / mouse wheel |
| Measure | <kbd>M</kbd> or the 📏 button, then drag; hold Shift for 15° steps; <kbd>Esc</kbd> to finish |
| Lock a part in place | tick **Lock position** in the sidebar |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> (or <kbd>Ctrl</kbd>+<kbd>Y</kbd>) |
| Play / pause | <kbd>Space</kbd> |
| Delete selected (and the parts attached to it) | <kbd>Del</kbd> |
| Fit view | <kbd>F</kbd> |

Hover over any setting in the sidebar for a short explanation.

## Notes and limitations

- Standard full-depth teeth (addendum 1·m). The clearance is adjustable and defaults to 0.25·m.
- A locked part can still move if you change the size of a gear it meshes with, because its
  position is defined relative to that gear.
- Profile shift applies to external gears. Ring gears and racks are unshifted.
- Undercut in low tooth counts is flagged, with a suggested shift, but not drawn.
- Racks mesh with external gears and can't drive other parts. A finite rack can't slide forever, so in
  the animation it jumps back by whole teeth to stay on its gear.
- Racks aren't included in the overlap check.
- Parts that mesh share the same module and pressure angle. Changing either on one part updates
  everything it meshes with.
- Positive RPM means clockwise on screen.

## Tests

```sh
npm test        # or: node --test
```

Needs Node 18 or newer and nothing else. The tests turn meshing pairs through several teeth and
check that the teeth never overlap and that the play between them matches the backlash. The pairs
include plain gears, profile-shifted gears, ring gears and racks. Other tests cover centre
distances, tip shortening, speed ratios, spoke and bore geometry, and that STL files are
watertight with the right volume.

## Files

- `js/gear.js`: geometry (tooth profiles, racks, bores, spokes, mesh maths, SVG/DXF/STL output)
- `js/app.js`: UI, kinematics, rendering, undo/redo, printing
- `test/geometry.test.js`: geometry and meshing tests
- `js/vendor/earcut.js`: polygon triangulation used for STL export ([earcut](https://github.com/mapbox/earcut), ISC licence)
- `css/style.css`, `index.html`

# neo-finder

Client-side viewer for engine-controller flash dumps. Open a binary, and it finds
the map tables structurally, then draws an annotated 2D view of the calibration
area with the regions named.

Nothing is uploaded. There is no backend — the file is read in the browser with
`FileReader`, everything runs locally, and the Network tab will show you that.

## Running it

No build step and no dependencies. Either:

- open `index.html` directly from disk, or
- serve the folder over HTTP and visit it, or
- push to GitHub Pages from `main`, root or `/docs`

The scan runs in a Web Worker created from a Blob URL, which is why it works from
`file://` as well as over HTTP. If Worker construction is blocked the scan falls
back to the main thread automatically.

Open a file with the button, or drag one anywhere onto the page.

## What it does

- Finds map tables and reports address, dimensions, axis addresses, data address
  and byte length for each
- Names the regions it recognises, with a confidence level and a note
- Draws the WinOLS-style 2D view: value envelope per address, bands for
  recognised tables, callout labels placed so they cannot collide
- **Zoom** in and out to trade address span per row against detail
- Responsive down to a phone: plot geometry, fonts, tick density and label
  stacking are all derived from the available width. Below a readable minimum the
  strip container scrolls sideways rather than squashing the plot, and the page
  itself never scrolls horizontally
- Hover for the address, the word value, and which part of a table you are in
  (header / X axis / Y axis / data)
- Click any band to open the table as a heatmapped grid with scaled axes
- Detects word size and endianness by trying each variant and keeping whichever
  covers the most bytes — silently, with no control to get wrong
- Exports the map list as CSV and the whole view as PNG

Read-only throughout. No writing, no checksum correction, no OBD or bench
flashing. This is not a replacement for a commercial editor.

## How the recognition works

Two separate mechanisms, and only the first is exact.

### 1. Finding region boundaries — a structural predicate

Bosch EDC16-family calibration data uses a **self-describing container**:

```
+0x00  u16 nx            X-axis point count
+0x02  u16 ny            Y-axis point count (1 = 2D curve)
+0x04  u16[nx]           X axis, strictly increasing
       u16[ny]           Y axis, strictly increasing
       u16[nx*ny]        data, X-major: value(ix,iy) = data[ix*ny + iy]

total = 4 + 2*nx + 2*ny + w*nx*ny        (w = 1 or 2 data bytes)
```

Every even offset is tested against it: two plausible counts, two axes of exactly
those lengths that must both be monotonic, and a total length that fits. The
load-bearing property is arithmetic self-consistency — random bytes do not
produce counts whose implied axes come out sorted.

Two filters then do most of the work:

- **Chaining** — walk forward by `len` and check whether another valid header
  lands exactly there. Real maps are packed contiguously and form long chains;
  coincidental hits almost never have a valid successor.
- **Greedy non-overlap by coverage** — chains sorted by total bytes covered,
  longest accepted first, overlapping ones dropped.

Measured specificity, same scanner over equal-sized slices of a 2 MiB EDC16C39
dump:

| Region | Raw header hits | Accepted maps |
|---|---|---|
| Calibration `0x1B0000–0x1F1FFF` | 536 | 463 |
| Program code `0x040000–0x082000` | 0 | 0 |
| Program code `0x0A0000–0x0E2000` | 0 | 0 |
| Boot + data `0x000000–0x042000` | 7 | 1 |

Zero false positives across 528 KB of PowerPC code. Because the predicate is
this specific, the app scans the **whole file** and needs no prior knowledge of
the layout. Scanning all four container variants over 2 MiB takes about 80 ms.

The single spurious hit in the boot region is an isolated chain of length one.
Chain length is shown per table, and a length of 1 is flagged, so that class of
false positive is visible rather than silent.

X-major storage order (rather than row-major) was confirmed on every non-square
map by second-difference smoothness — the transpose visibly shears the rows.

### 2. Naming the regions — a rule pack

Naming lives in `DEFAULT_RULES` at the top of `neo.js`, deliberately kept as data
rather than logic. Recognition is universal; naming is per-ECU-family.

**Axis kinds** classify each axis by fingerprint:

| Fingerprint | Reading |
|---|---|
| round steps ending 2800–8000, starting under 1300 | engine speed, raw = rpm |
| ends at `8192`, contains `819`, `1638`, `4096` | pedal, `8192 = 100 %` |
| starts under 700, ends 2500–12000 | injection quantity, raw/100 = mg/stroke |
| starts 2200–2750, ends 2850–3900 | coolant temperature, raw/10 − 273.1 = °C |

Each kind carries a **role** of `x`, `y` or `any`, and this turned out to matter
more than the value ranges. An injection-quantity axis of 400…5000 is
indistinguishable from an engine-speed axis by value alone, so without roles the
speed fingerprint swallows load axes and every boost map comes out unnamed. In
this container the X axis is the speed axis and the Y axis is the load axis;
pedal and coolant have fingerprints distinctive enough to match in either
position.

**Map rules** then match on those axis kinds plus value range and **trend** — the
mean of the top third of an axis against the bottom third. Trend is what
separates a boost map from a timing map when their raw ranges overlap: boost
rises with load, timing falls with speed. First match wins, so rule order is the
disambiguation mechanism.

Each candidate is checked against physics before the name sticks: rail pressure
must rise with both speed and load, boost must sit at ambient below ~1000 rpm, a
quantity request must be zero at zero pedal.

**Addresses, dimensions, axes and values are exact. The names are not.** No
DAMOS or A2L is embedded in these files, so labels are a reading of the numbers.
Rules carry a confidence level, shown in the detail panel alongside a note. The
loose ones — `Duty / position` in particular — will over-match; tighten their
ranges in `DEFAULT_RULES`.

## Known limits

- **A large part of the calibration area is invisible to the predicate.** Bare 2D
  curves and scalars carry no `nx`/`ny` header. On the reference dump the
  container accounts for about 61 % of the calibration area; the rest shows as
  unbanded. Reaching it needs the code side — finding the `lis`/`ori` pairs that
  build those addresses.
- **The self-describing container is the exception, not the rule.** EDC15, EDC17,
  Marelli MJD and Delphi DCM keep axes elsewhere and reference them only from
  code. For those this degrades to a candidate finder and needs human
  confirmation.
- Deeply stacked callouts on tightly packed regions make a tall label lane. The
  placement is collision-free by construction, not by tuning, so it grows rather
  than overlapping.

## Deliberately not in the UI

These were built and then removed to keep the interface minimal. Recorded here so
the reasoning is not lost:

- **Compare two dumps** — highlighted only the tables whose bytes differed, down
  to the individual cell. The most useful thing that is now missing; worth
  restoring if "what did this tuner change" comes up.
- **Checksum report** — located protected-block descriptors by their magic,
  `FADECAFE CAFEAFFE` preceded by `[type][start][end]`, and reported each
  range's 32-bit word sum. On the reference EDC16C39 dump this found **8**
  descriptors whose declared ranges all sum to exactly `0xD01FE500`, including
  three that hand analysis had missed. That shared constant is the invariant: any
  edit inside a block must be compensated so its sum returns to it.
- **Naming-rule editor** — the rule pack as editable JSON in a modal, persisted
  to `localStorage` with import/export. Rules now live in `neo.js`.
- **Format override** — a selector to force a container variant. Detection still
  runs; only the control is gone, so a wrong manual choice is impossible.
- **Synthetic sample** — generated a dump in memory that exercised the whole
  pipeline without a real read. Was the demo and the test fixture.

## Possible next steps

- [ ] Heuristic mode for formats without a header: monotonic runs as candidate
      axes plus adjacent rectangular blocks of smooth data
- [ ] Follow `lis`/`ori` address construction to reach headerless curves
- [ ] Rule packs per ECU family

## Do not commit binaries

Flash dumps are OEM code and often customer data. `.gitignore` excludes the
common extensions; keep it that way.

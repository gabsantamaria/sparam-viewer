# S-Param Studio

A self-contained S-parameter viewer and N-port merge tool. One HTML file, no
build step, no dependencies — open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8613
```

## Features

- **Import** Touchstone files (`.s1p` … `.s8p`, v1 incl. noise blocks, minimal
  v2), drag-drop or picker; multi-file comparison with **color = S-parameter,
  line style = file**.
- **Plot modes**: XY vs frequency (dB / linear / phase / unwrapped / Re / Im)
  and a full **Smith chart** (constant-R/X grid, Γ and Z readouts, freq window).
- **Dual y-axes**: each trace-matrix cell cycles off → Left → Right axis.
- **Figure tools**: live hover readouts (snap to real samples, never
  interpolated), pinned markers with Δ, rubber-band zoom, manual ranges, grid
  and legend toggles, dark or white (publication) background.
- **Export**: copy/save PNG at 900 dpi (DPI written into the file) and fully
  vector PDF.
- **Merge s2p → sNp**: assemble an N-port network from pairwise 2-port
  measurements taken with idle ports matched; redundant diagonals averaged
  with a consistency report; the in-app ⓘ button explains the math.
- **Circuit window** (⏚ on each Smith design list): the list as a schematic
  (series/shunt R, L, C and TEM lines, port 1 → load), every value defined at
  a design frequency f₀ (a reactance becomes the L or C that has it at f₀, a
  line scales θ with f). The load is the list's start point fitted as a
  series/parallel RC or RL, editable. S11 / S21 / S22 vs frequency in dB,
  phase or Smith, port 2 referenced to the load (power waves, scikit-rf
  `s_def='power'`) or to Z₀. Downloads: the network `.s2p` (both ports at Z₀),
  the as-plotted `.s2p` (per-frequency port impedances), a scikit-rf script
  that rebuilds and plots the same circuit, and the schematic as SVG. The JS
  engine matches scikit-rf 2.0.1 to ~1e-15.

## Data integrity

Nothing is ever interpolated, resampled, or decimated. Downloads re-parse
bit-identical to what is plotted. Ambiguous or malformed files are refused
with named reasons, never guessed at.
A file whose `! Port Impedance` lines differ from its option-line `R` (an
export that was not renormalized) is refused rather than read at `R`.

## Tests

```bash
node test.mjs
```

runs the parser/math test suite against the exact code shipped in
`index.html` (sliced from its `//<<PURE_START>>` block) and regenerates the
`fixtures/` directory.

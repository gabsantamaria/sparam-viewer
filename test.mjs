// Data-integrity test suite for S-Param Studio.
// Runs the EXACT parser/math shipped in index.html (sliced out of the file),
// against fixtures generated here with independent arithmetic.
//   node sparam-viewer/test.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const m = html.match(/\/\/<<PURE_START>>([\s\S]*?)\/\/<<PURE_END>>/);
if (!m) throw new Error('PURE block markers not found in index.html');
const SNP = new Function('module', m[1] + '\nreturn SNP;')({ exports: {} });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.error('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function approx(a, b, tol) {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= (tol ?? 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));
}

// ---------- reference network (independent arithmetic) ----------
// 2-port, deliberately NON-reciprocal (S12 != S21) and asymmetric (S11 != S22)
// so any index/order slip is loudly visible.
function refNet(fHz) {
  const t = fHz / 1e9;
  return {
    s11: [0.3 * Math.cos(t), 0.3 * Math.sin(t)],
    s21: [0.9 * Math.cos(0.5 * t + 1), 0.9 * Math.sin(0.5 * t + 1)],
    s12: [0.5 * Math.cos(0.8 * t - 2), 0.5 * Math.sin(0.8 * t - 2)],
    s22: [0.1 * Math.cos(2 * t + 0.3), 0.1 * Math.sin(2 * t + 0.3)],
  };
}
const FREQS = [];      // 201 points, 1..10 GHz
for (let k = 0; k < 201; k++) FREQS.push(1e9 + (10e9 - 1e9) * k / 200);

function pairStr(c, fmt) {
  if (fmt === 'RI') return c[0] + ' ' + c[1];                     // exact decimal round-trip
  const mag = Math.hypot(c[0], c[1]), ang = Math.atan2(c[1], c[0]) * 180 / Math.PI;
  if (fmt === 'MA') return mag.toPrecision(17) + ' ' + ang.toPrecision(17);
  return (20 * Math.log10(mag)).toPrecision(17) + ' ' + ang.toPrecision(17);
}
function gen2p(fmt, unit) {
  const mult = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9 }[unit.toUpperCase()];
  const lines = ['! generated fixture ' + fmt + ' ' + unit, '# ' + unit + ' S ' + fmt + ' R 50'];
  for (const f of FREQS) {
    const n = refNet(f);
    // Touchstone v1 2-port order: S11 S21 S12 S22
    lines.push([f / mult, pairStr(n.s11, fmt), pairStr(n.s21, fmt), pairStr(n.s12, fmt), pairStr(n.s22, fmt)].join(' '));
  }
  return lines.join('\n') + '\n';
}

const fixDir = join(dir, 'fixtures');
mkdirSync(fixDir, { recursive: true });

// ---------- 1. RI/GHz: exact round-trip ----------
{
  const txt = gen2p('RI', 'GHz');
  writeFileSync(join(fixDir, 'ref_ri_ghz.s2p'), txt);
  const p = SNP.parseTouchstone('ref_ri_ghz.s2p', txt);
  check('RI parse ok', p.ok, p.error);
  check('RI 2-port', p.nPorts === 2);
  check('RI 201 points', p.points === 201);
  check('RI z0=50', p.z0 === 50);
  // freq: f/1e9 then *1e9 can round-trip inexactly; allow 1 ULP there but S must be EXACT
  let freqOk = true, sExact = true;
  for (let k = 0; k < FREQS.length; k++) {
    if (!approx(p.freqHz[k], FREQS[k], 1e-14)) freqOk = false;
    const n = refNet(FREQS[k]);
    for (const [key, c] of [['1,1', n.s11], ['2,1', n.s21], ['1,2', n.s12], ['2,2', n.s22]])
      if (p.S[key].re[k] !== c[0] || p.S[key].im[k] !== c[1]) sExact = false;
  }
  check('RI frequencies round-trip (≤1 ulp)', freqOk);
  check('RI S-values BIT-EXACT round-trip', sExact);
  check('RI ordering: S21 differs from S12', Math.abs(p.S['2,1'].re[0] - p.S['1,2'].re[0]) > 0.1);
}

// ---------- 2. MA + DB + MHz: format/unit equivalence ----------
{
  const tMA = gen2p('MA', 'GHz');
  const tDB = gen2p('DB', 'MHz');
  writeFileSync(join(fixDir, 'ref_ma_ghz.s2p'), tMA);
  writeFileSync(join(fixDir, 'ref_db_mhz.s2p'), tDB);
  const a = SNP.parseTouchstone('ref_ma_ghz.s2p', tMA);
  const b = SNP.parseTouchstone('ref_db_mhz.s2p', tDB);
  check('MA parse ok', a.ok, a.error);
  check('DB parse ok', b.ok, b.error);
  let worst = 0;
  for (let k = 0; k < FREQS.length; k++) {
    if (!approx(a.freqHz[k], b.freqHz[k], 1e-12)) worst = Infinity;
    const n = refNet(FREQS[k]);
    for (const [key, c] of [['1,1', n.s11], ['2,1', n.s21], ['1,2', n.s12], ['2,2', n.s22]]) {
      worst = Math.max(worst,
        Math.abs(a.S[key].re[k] - c[0]), Math.abs(a.S[key].im[k] - c[1]),
        Math.abs(b.S[key].re[k] - c[0]), Math.abs(b.S[key].im[k] - c[1]));
    }
  }
  check('MA/DB/unit equivalence vs reference (worst |Δ| < 1e-12)', worst < 1e-12, 'worst=' + worst);
}

// ---------- 3. 3-port with wrapped lines (v1 row-major) ----------
{
  const lines = ['# GHz S RI R 50'];
  const f3 = [1, 2, 3];
  const val = (fi, i, j) => [fi + i * 10 + j, -(fi + i + j / 10)];   // unique per (f,i,j)
  for (const f of f3) {
    // v1 style: one line per matrix row
    for (let i = 1; i <= 3; i++) {
      const parts = i === 1 ? [String(f)] : [''];
      for (let j = 1; j <= 3; j++) { const v = val(f, i, j); parts.push(v[0] + ' ' + v[1]); }
      lines.push(parts.join(' ').trim());
    }
  }
  const txt = lines.join('\n') + '\n';
  writeFileSync(join(fixDir, 'ref_3port.s3p'), txt);
  const p = SNP.parseTouchstone('ref_3port.s3p', txt);
  check('3-port parse ok', p.ok, p.error);
  check('3-port count', p.nPorts === 3 && p.points === 3);
  let ok = true;
  for (let k = 0; k < 3; k++)
    for (let i = 1; i <= 3; i++)
      for (let j = 1; j <= 3; j++) {
        const v = val(f3[k], i, j), s = p.S[i + ',' + j];
        if (s.re[k] !== v[0] || s.im[k] !== v[1]) ok = false;
      }
  check('3-port row-major mapping exact', ok);
}

// ---------- 4. Noise-parameter block ignored ----------
{
  const base = gen2p('RI', 'GHz');
  const noisy = base + [
    '! noise parameters (freq NFmin GammaOptMag GammaOptAng Rn/Z0)',
    '2 0.5 0.4 65 0.3',
    '4 0.6 0.35 60 0.28',
    '6 0.7 0.3 55 0.25',
  ].join('\n') + '\n';
  writeFileSync(join(fixDir, 'ref_noise.s2p'), noisy);
  const p = SNP.parseTouchstone('ref_noise.s2p', noisy);
  check('noise parse ok', p.ok, p.error);
  check('noise: S points unchanged', p.points === 201);
  check('noise: warning emitted', p.warnings.some(w => /Noise-parameter block \(3 points\)/.test(w)), JSON.stringify(p.warnings));
  const clean = SNP.parseTouchstone('x.s2p', base);
  let same = true;
  for (let k = 0; k < 201; k++)
    if (p.S['2,1'].re[k] !== clean.S['2,1'].re[k] || p.S['2,1'].im[k] !== clean.S['2,1'].im[k]) same = false;
  check('noise: S data identical to clean file', same);
}

// ---------- 5. Touchstone v2 with 12_21 order ----------
{
  const lines = ['[Version] 2.0', '# GHz S RI R 50', '[Number of Ports] 2',
    '[Two-Port Data Order] 12_21', '[Network Data]'];
  for (const f of [1, 2]) {
    const n = refNet(f * 1e9);
    // 12_21 => S11 S12 S21 S22
    lines.push([f, pairStr(n.s11, 'RI'), pairStr(n.s12, 'RI'), pairStr(n.s21, 'RI'), pairStr(n.s22, 'RI')].join(' '));
  }
  lines.push('[End]');
  const txt = lines.join('\n') + '\n';
  writeFileSync(join(fixDir, 'ref_v2.s2p'), txt);
  const p = SNP.parseTouchstone('ref_v2.s2p', txt);
  check('v2 parse ok', p.ok, p.error);
  const n = refNet(1e9);
  check('v2 12_21: S21 mapped correctly', p.S['2,1'].re[0] === n.s21[0] && p.S['2,1'].im[0] === n.s21[1]);
  check('v2 12_21: S12 mapped correctly', p.S['1,2'].re[0] === n.s12[0] && p.S['1,2'].im[0] === n.s12[1]);
}

// ---------- 6. rejections + inference ----------
{
  const y = SNP.parseTouchstone('x.s2p', '# GHz Y RI R 50\n1 1 0 0 0 0 0 1 0\n');
  check('Y-params rejected', !y.ok && /Y-parameters/.test(y.error), y.error);
  const bad = SNP.parseTouchstone('x.s2p', '# GHz S RI R 50\n1 2 3 four 5 6 7 8 9\n');
  check('non-numeric token rejected', !bad.ok, bad.error);
  const noext = SNP.parseTouchstone('mystery.snp', gen2p('RI', 'GHz'));
  check('port inference from .snp', noext.ok && noext.nPorts === 2 &&
    noext.warnings.some(w => /inferred/.test(w)), noext.ok ? noext.warnings.join(';') : noext.error);
  const empty = SNP.parseTouchstone('e.s2p', '! nothing here\n# GHz S RI R 50\n');
  check('empty data rejected', !empty.ok);
  const noOpt = SNP.parseTouchstone('n.s1p', '5 0.5 30\n6 0.4 40\n');   // default MA GHz
  check('missing option line -> MA/GHz defaults + warning', noOpt.ok &&
    noOpt.warnings.some(w => /assuming GHz S MA/.test(w)) &&
    approx(noOpt.S['1,1'].re[0], 0.5 * Math.cos(30 * Math.PI / 180), 1e-15) &&
    approx(noOpt.freqHz[0], 5e9, 1e-15));
}

// ---------- 7. derived quantities ----------
{
  const s = { re: new Float64Array([1, 0, -0.5, 3e-6]), im: new Float64Array([0, 1, -0.5, -4e-6]) };
  const db = SNP.traceValues(s, 'db');
  check('dB of 1 = 0', db[0] === 0);
  check('dB of j = 0', approx(db[1], 0, 1e-12));
  check('dB of 0.7071∠225°', approx(db[2], 20 * Math.log10(Math.SQRT1_2 / 1), 1e-12), db[2]);
  check('dB of 5e-6 = ' + (20 * Math.log10(5e-6)).toFixed(2), approx(db[3], 20 * Math.log10(5e-6), 1e-12));
  const dg = SNP.traceValues(s, 'deg');
  check('phase 0/90/-135', dg[0] === 0 && approx(dg[1], 90, 1e-12) && approx(dg[2], -135, 1e-12));
  const mg = SNP.traceValues(s, 'mag');
  check('mag hypot', approx(mg[2], Math.SQRT1_2, 1e-12) && approx(mg[3], 5e-6, 1e-12));
  check('re/im passthrough', SNP.traceValues(s, 're')[2] === -0.5 && SNP.traceValues(s, 'im')[3] === -4e-6);
  // zero magnitude -> NaN gap in dB, not -Infinity
  const z = SNP.traceValues({ re: new Float64Array([0]), im: new Float64Array([0]) }, 'db');
  check('dB of 0 is NaN (plot gap)', Number.isNaN(z[0]));

  // unwrap: a steadily rotating phasor (delay line) must unwrap to a straight line
  const N = 400, re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < N; k++) { const ph = -k * 0.31; re[k] = Math.cos(ph); im[k] = Math.sin(ph); }
  const uw = SNP.traceValues({ re, im }, 'degU');
  let lin = true;
  for (let k = 0; k < N; k++) if (!approx(uw[k], -k * 0.31 * 180 / Math.PI, 1e-9)) lin = false;
  check('unwrapped phase of uniform delay is linear over ' + N + ' pts (~' + Math.round(0.31 * (N - 1) / (2 * Math.PI)) + ' wraps)', lin);
}

// ---------- 8. plot math ----------
{
  const a = new Float64Array([1, 2, 4, 8, 16]);
  check('nearestIdx below', SNP.nearestIdx(a, 0) === 0);
  check('nearestIdx above', SNP.nearestIdx(a, 99) === 4);
  check('nearestIdx mid ties low', SNP.nearestIdx(a, 3) === 1);
  check('nearestIdx snaps', SNP.nearestIdx(a, 7.9) === 3 && SNP.nearestIdx(a, 5) === 2);
  const t = SNP.ticks(0.9e9, 10.1e9, 6);
  check('ticks inside range', t.every(v => v >= 0.9e9 - 1 && v <= 10.1e9 + 1));
  check('ticks reasonable count', t.length >= 4 && t.length <= 12, String(t.length));
  const t2 = SNP.ticks(-63.2, -12.8, 6);
  check('negative-range ticks', t2.length >= 4 && t2[0] >= -63.2 && t2[t2.length - 1] <= -12.8, JSON.stringify(t2));
  check('freq units', SNP.freqUnitFor(5e9).name === 'GHz' && SNP.freqUnitFor(3e6).name === 'MHz' && SNP.freqUnitFor(12).name === 'Hz');
  check('fmtNum', SNP.fmtNum(-3.14159265) === '-3.1416' && SNP.fmtNum(0) === '0' && SNP.fmtNum(NaN) === '—');
}

// ---------- 9. full round-trip: parse -> serialize -> reparse, bit-exact ----------
{
  const p1 = SNP.parseTouchstone('ref_ri_ghz.s2p', gen2p('RI', 'GHz'));
  const order = ['1,1', '2,1', '1,2', '2,2'];
  const lines = ['# Hz S RI R 50'];
  for (let k = 0; k < p1.points; k++)
    lines.push([p1.freqHz[k], ...order.flatMap(key => [p1.S[key].re[k], p1.S[key].im[k]])].join(' '));
  const p2 = SNP.parseTouchstone('rt.s2p', lines.join('\n') + '\n');
  let exact = p2.ok && p2.points === p1.points;
  for (let k = 0; exact && k < p1.points; k++) {
    if (p2.freqHz[k] !== p1.freqHz[k]) exact = false;
    for (const key of order)
      if (p2.S[key].re[k] !== p1.S[key].re[k] || p2.S[key].im[k] !== p1.S[key].im[k]) exact = false;
  }
  check('parse->serialize->reparse BIT-EXACT', exact);
}

// ---------- 10. 4-port fixture for browser test ----------
{
  const lines = ['# GHz S RI R 50'];
  for (const f of [1, 5, 10]) {
    for (let i = 1; i <= 4; i++) {
      const parts = i === 1 ? [String(f)] : ['  '];
      for (let j = 1; j <= 4; j++) parts.push((0.01 * (i * 10 + j) + f / 100) + ' ' + (-0.001 * (i + j)));
      lines.push(parts.join(' ').trim());
    }
  }
  const txt = lines.join('\n') + '\n';
  writeFileSync(join(fixDir, 'ref_4port.s4p'), txt);
  const p = SNP.parseTouchstone('ref_4port.s4p', txt);
  check('4-port parse', p.ok && p.nPorts === 4 && p.points === 3 && Object.keys(p.S).length === 16);
  check('4-port S34 value', p.S['3,4'].re[1] === 0.01 * 34 + 0.05);
}

// ---------- 11. merge pairwise s2p -> s3p (bit-exact vs the true 3-port) ----------
// non-reciprocal AND asymmetric model so any transpose / port-map slip is loud
function S3(i, j, fHz) {
  const t = fHz / 1e9;
  const mag = [[0.20, 0.60, 0.30], [0.55, 0.15, 0.40], [0.35, 0.45, 0.10]][i - 1][j - 1];
  const ph = (i + 2 * j) * 0.7 + (0.1 * i + 0.05 * j) * t;
  return [mag * Math.cos(ph), mag * Math.sin(ph)];
}
const F3 = [];
for (let k = 0; k < 51; k++) F3.push(1e9 + 9e9 * k / 50);
function genPair(a, b, opts = {}) {
  // file port1 -> network port a, port2 -> network port b; idle port matched
  const lines = ['# Hz S RI R ' + (opts.z0 ?? 50)];
  for (const f of (opts.freqs ?? F3)) {
    const saa = S3(a, a, f), sba = S3(b, a, f), sab = S3(a, b, f), sbb = S3(b, b, f);
    if (opts.perturb11) { saa[0] += opts.perturb11; }
    // v1 order: S11 S21 S12 S22
    lines.push([f, saa[0], saa[1], sba[0], sba[1], sab[0], sab[1], sbb[0], sbb[1]].join(' '));
  }
  return lines.join('\n') + '\n';
}
function parsePair(name, txt) { const p = SNP.parseTouchstone(name, txt); if (!p.ok) throw new Error(p.error); return p; }
{
  const t12 = genPair(1, 2), t13 = genPair(1, 3), t23 = genPair(2, 3);
  writeFileSync(join(fixDir, 'dut_12.s2p'), t12);
  writeFileSync(join(fixDir, 'dut_13.s2p'), t13);
  writeFileSync(join(fixDir, 'dut_23.s2p'), t23);
  const r = SNP.mergeSnp([
    { net: parsePair('dut_12.s2p', t12), a: 1, b: 2, label: 'dut_12' },
    { net: parsePair('dut_13.s2p', t13), a: 1, b: 3, label: 'dut_13' },
    { net: parsePair('dut_23.s2p', t23), a: 2, b: 3, label: 'dut_23' },
  ]);
  check('merge ok', r.ok, r.error);
  check('merge N=3 auto', r.nPorts === 3 && r.points === 51);
  let exact = true;
  for (let k = 0; k < 51; k++)
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
      const v = S3(i, j, F3[k]), s = r.S[i + ',' + j];
      if (s.re[k] !== v[0] || s.im[k] !== v[1]) exact = false;   // avg of identical values is exact
    }
  check('merged 3-port BIT-EXACT vs true S-matrix', exact);
  check('merge consistency present, zero spread', r.consistency && r.consistency.worst.maxDev === 0,
    r.consistency && String(r.consistency.worst.maxDev));
  check('merge no warnings on complete set', r.warnings.length === 0, r.warnings.join(';'));

  // serialize -> reparse round trip, bit exact, correct extension semantics
  const txt = SNP.serializeTouchstone(r, { comments: ['merged test'] });
  const back = SNP.parseTouchstone('merged.s3p', txt);
  let rt = back.ok && back.nPorts === 3 && back.points === 51;
  for (let k = 0; rt && k < 51; k++) {
    if (back.freqHz[k] !== r.freqHz[k]) rt = false;
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
      const key = i + ',' + j;
      if (back.S[key].re[k] !== r.S[key].re[k] || back.S[key].im[k] !== r.S[key].im[k]) rt = false;
    }
  }
  check('merged serialize->reparse BIT-EXACT', rt);
}
// ---------- 12. permuted port map: file measured (3,1) ----------
{
  const t31 = genPair(3, 1);
  const r = SNP.mergeSnp([
    { net: parsePair('dut_12.s2p', genPair(1, 2)), a: 1, b: 2, label: 'p12' },
    { net: parsePair('dut_31.s2p', t31), a: 3, b: 1, label: 'p31' },   // reversed order pair
    { net: parsePair('dut_23.s2p', genPair(2, 3)), a: 2, b: 3, label: 'p23' },
  ]);
  check('reversed-pair merge ok', r.ok, r.error);
  const v13 = S3(1, 3, F3[7]), v31 = S3(3, 1, F3[7]);
  check('reversed pair: S13 correct', r.S['1,3'].re[7] === v13[0] && r.S['1,3'].im[7] === v13[1]);
  check('reversed pair: S31 correct', r.S['3,1'].re[7] === v31[0] && r.S['3,1'].im[7] === v31[1]);
}
// ---------- 13. diagonal disagreement -> average + consistency spread ----------
{
  const r = SNP.mergeSnp([
    { net: parsePair('a.s2p', genPair(1, 2)), a: 1, b: 2, label: 'a' },
    { net: parsePair('b.s2p', genPair(1, 3, { perturb11: 0.01 })), a: 1, b: 3, label: 'b' },
  ]);
  check('perturbed merge ok', r.ok, r.error);
  const v = S3(1, 1, F3[0]);
  check('S11 averaged (+0.005)', approx(r.S['1,1'].re[0], v[0] + 0.005, 1e-12), r.S['1,1'].re[0] - v[0]);
  check('consistency spread = 0.005 on S11', r.consistency && r.consistency.worst.key === '1,1'
    && approx(r.consistency.worst.maxDev, 0.005, 1e-9), r.consistency && String(r.consistency.worst.maxDev));
  check('missing pair (2,3) zero + warned',
    r.S['2,3'].re[10] === 0 && r.S['3,2'].im[10] === 0
    && r.warnings.some(w => /Not measured.*S23.*S32/.test(w)), r.warnings.join(';'));
}
// ---------- 14. merge refusals ----------
{
  const shifted = genPair(2, 3, { freqs: F3.map(f => f + 1e6) });
  const r1 = SNP.mergeSnp([
    { net: parsePair('a.s2p', genPair(1, 2)), a: 1, b: 2, label: 'a' },
    { net: parsePair('b.s2p', shifted), a: 2, b: 3, label: 'b' },
  ]);
  check('grid mismatch refused, names no-interpolation rule', !r1.ok && /never interpolates/.test(r1.error), r1.error);
  const r2 = SNP.mergeSnp([
    { net: parsePair('a.s2p', genPair(1, 2)), a: 1, b: 2, label: 'a' },
    { net: parsePair('b.s2p', genPair(2, 3, { z0: 75 })), a: 2, b: 3, label: 'b' },
  ]);
  check('z0 mismatch refused', !r2.ok && /impedance mismatch/.test(r2.error), r2.error);
  const r3 = SNP.mergeSnp([{ net: parsePair('a.s2p', genPair(1, 2)), a: 2, b: 2, label: 'a' }]);
  check('a==b refused', !r3.ok && /must differ/.test(r3.error), r3.error);
  const r4 = SNP.mergeSnp([{ net: parsePair('a.s2p', genPair(1, 2)), a: 1, b: 3, label: 'a' }], 2);
  check('N smaller than highest port refused', !r4.ok, r4.error);
  const one = SNP.parseTouchstone('x.s1p', '# GHz S RI R 50\n1 0.5 0\n');
  const r5 = SNP.mergeSnp([{ net: one, a: 1, b: 2, label: 'x' }]);
  check('non-2-port entry refused', !r5.ok && /not a 2-port/.test(r5.error), r5.error);
}
// ---------- 15. serializer: 2-port v1 order + 5-port row wrapping ----------
{
  // 2-port: serializer must emit v1 order (S11 S21 S12 S22) so reparse is identity
  const p = SNP.parseTouchstone('ref.s2p', gen2p('RI', 'GHz'));
  const back = SNP.parseTouchstone('rt.s2p', SNP.serializeTouchstone(p));
  let ok = back.ok;
  for (let k = 0; ok && k < p.points; k += 20)
    for (const key of ['1,1', '2,1', '1,2', '2,2'])
      if (back.S[key].re[k] !== p.S[key].re[k] || back.S[key].im[k] !== p.S[key].im[k]) ok = false;
  check('serializer 2-port v1 order round-trip', ok);

  // 5-port: rows wrap at 4 complex pairs per line (spec) and reparse bit-exact
  const N5 = 5, M5 = 4, freqHz = new Float64Array(M5), S = {};
  for (let k = 0; k < M5; k++) freqHz[k] = (k + 1) * 1e9;
  for (let i = 1; i <= N5; i++) for (let j = 1; j <= N5; j++) {
    const re = new Float64Array(M5), im = new Float64Array(M5);
    for (let k = 0; k < M5; k++) { re[k] = Math.sin(i * 3 + j * 7 + k); im[k] = Math.cos(i - j + 2 * k); }
    S[i + ',' + j] = { re, im };
  }
  const txt = SNP.serializeTouchstone({ nPorts: N5, z0: 50, freqHz, S });
  const maxPairs = Math.max(...txt.split('\n').filter(l => l && l[0] !== '#' && l[0] !== '!')
    .map(l => { const n = l.trim().split(/\s+/).length; return Math.floor(n / 2); }));
  check('5-port lines wrap at <=4 complex pairs', maxPairs <= 4, String(maxPairs));
  const b5 = SNP.parseTouchstone('m.s5p', txt);
  let ok5 = b5.ok && b5.nPorts === 5 && b5.points === M5;
  for (let k = 0; ok5 && k < M5; k++)
    for (let i = 1; i <= N5; i++) for (let j = 1; j <= N5; j++) {
      const key = i + ',' + j;
      if (b5.S[key].re[k] !== S[key].re[k] || b5.S[key].im[k] !== S[key].im[k]) ok5 = false;
    }
  check('5-port wrapped serialize->reparse BIT-EXACT', ok5);
}

// ---------- 16. inference ambiguity is REFUSED, never guessed ----------
{
  // a 1-port with points % 3 == 0 fits BOTH n=1 and n=2 (stride 9 lands on true
  // frequencies) — the old code picked n=2 and plotted garbage
  const mk = (pts) => {
    const lines = ['# GHz S RI R 50'];
    for (let k = 0; k < pts; k++) lines.push((1 + k * 0.05) + ' ' + (0.5 - k * 1e-4) + ' 0.1');
    return lines.join('\n') + '\n';
  };
  const amb = SNP.parseTouchstone('mystery1port.snp', mk(201));
  check('ambiguous .snp shape refused', !amb.ok && /Ambiguous.*1-port and 2-port/.test(amb.error), amb.error);
  const ok1 = SNP.parseTouchstone('mystery1port.s1p', mk(201));
  check('same bytes named .s1p parse correctly', ok1.ok && ok1.nPorts === 1 && ok1.points === 201);
  const uni = SNP.parseTouchstone('four.snp', mk(4));   // 12 tokens: only n=1 fits
  check('unambiguous shape still inferred (n=1)', uni.ok && uni.nPorts === 1 &&
    uni.warnings.some(w => /inferred/.test(w)), uni.ok ? '' : uni.error);
}
// ---------- 17. duplicate segment-boundary frequency is KEPT, not truncated ----------
{
  const rows = [1, 2, 3, 3, 4, 5].map(f => f + ' 0.1 0 0.9 0 0.5 0 0.1 0');
  const p = SNP.parseTouchstone('seg.s2p', '# GHz S RI R 50\n' + rows.join('\n') + '\n');
  check('duplicate boundary point kept (6/6 points)', p.ok && p.points === 6, p.ok ? String(p.points) : p.error);
  check('duplicate warned, not silently', p.warnings.some(w => /duplicate frequency/.test(w)), p.warnings.join(';'));
  check('dup freq values intact', p.freqHz[2] === 3e9 && p.freqHz[3] === 3e9);
}
// ---------- 18. descending sweep refused with a named reason ----------
{
  const rows = [10, 9, 8, 7, 6, 5].map(f => f + ' 0.1 0 0.9 0 0.5 0 0.1 0');
  const p = SNP.parseTouchstone('desc.s2p', '# GHz S RI R 50\n' + rows.join('\n') + '\n');
  check('descending sweep refused (never 1-point silent)', !p.ok && /descending sweep/.test(p.error), p.ok ? 'ok!' : p.error);
}
// ---------- 19. mid-sweep decrease: loud KEPT ONLY, and no fake noise-block claims ----------
{
  const rows = [1, 2, 3, 4, 5, 2.5, 2.6, 2.7].map(f => f + ' 0.1 0 0.9 0 0.5 0 0.1 0');
  const p = SNP.parseTouchstone('cut.s2p', '# GHz S RI R 50\n' + rows.join('\n') + '\n');
  check('mid-decrease keeps prefix', p.ok && p.points === 5, p.ok ? String(p.points) : p.error);
  check('KEPT ONLY warning with counts', p.warnings.some(w => /KEPT ONLY 5 of ~8/.test(w)), p.warnings.join(';'));
  // decrease with leftover divisible by 5 but NOT noise-shaped (stride-5 not increasing)
  const rows2 = [1, 2, 3, 4, 5, 4.5, 4.6, 4.7, 4.8, 4.9].map(f => f + ' 0.1 0 0.9 0 0.5 0 0.1 0');
  const p2 = SNP.parseTouchstone('cut2.s2p', '# GHz S RI R 50\n' + rows2.join('\n') + '\n');
  check('S-shaped leftover never called a noise block', p2.ok &&
    !p2.warnings.some(w => /Noise-parameter/.test(w)) &&
    p2.warnings.some(w => /KEPT ONLY/.test(w)), p2.warnings.join(';'));
  // genuine noise block (5-col rows, increasing freqs) still classified — from test 4's fixture
  const base = gen2p('RI', 'GHz');
  const noisy = base + '2 0.5 0.4 65 0.3\n4 0.6 0.35 60 0.28\n6 0.7 0.3 55 0.25\n';
  const p3 = SNP.parseTouchstone('n.s2p', noisy);
  check('genuine noise block still recognized', p3.ok && p3.points === 201 &&
    p3.warnings.some(w => /Noise-parameter block \(3 points\)/.test(w)), p3.warnings.join(';'));
}
// ---------- 20. v2 [Reference]: continuation lines, per-port lists ----------
{
  const v2 = ['[Version] 2.0', '# GHz S RI R 50', '[Number of Ports] 1', '[Reference]', '75',
    '[Network Data]', '1 0.5 0', '2 0.4 0', '[End]'].join('\n') + '\n';
  const p = SNP.parseTouchstone('r.s1p', v2);
  check('[Reference] continuation line read (z0=75, not 0)', p.ok && p.z0 === 75, p.ok ? String(p.z0) : p.error);
  const v2b = ['[Version] 2.0', '# GHz S RI R 50', '[Number of Ports] 2', '[Two-Port Data Order] 21_12',
    '[Reference] 50 75', '[Network Data]', '1 .1 0 .9 0 .5 0 .1 0', '[End]'].join('\n') + '\n';
  const pb = SNP.parseTouchstone('r.s2p', v2b);
  check('per-port [Reference] takes first + WARNS', pb.ok && pb.z0 === 50 &&
    pb.warnings.some(w => /per-port|impedances/.test(w)), pb.ok ? pb.warnings.join(';') : pb.error);
  const v2c = v2.replace('[Reference]\n75\n', '');
  const pc = SNP.parseTouchstone('r.s1p', v2c);
  check('no [Reference] -> option-line R stands', pc.ok && pc.z0 === 50);
}
// ---------- 21. ticks: denormal spans return [] fast instead of looping to OOM ----------
{
  const t0 = Date.now();
  const t = SNP.ticks(5e-324, 4e-323, 6);
  check('denormal-span ticks returns empty, fast', Array.isArray(t) && t.length === 0 && Date.now() - t0 < 200);
  const t2 = SNP.ticks(-1e308, 1e308, 6);
  check('huge-span ticks all finite', t2.every(isFinite), JSON.stringify(t2));
  check('normal ticks unaffected', SNP.ticks(0, 10, 6).length >= 4);
}
// ---------- 22. merge: N capped at 16 ----------
{
  const net = parsePair('a.s2p', genPair(1, 2));
  const r = SNP.mergeSnp([{ net, a: 1, b: 23, label: 'typo' }]);
  check('N>16 refused naming the typo pattern', !r.ok && /16 ports/.test(r.error), r.error);
  const r2 = SNP.mergeSnp([{ net, a: 1, b: 2, label: 'x' }], 17);
  check('explicit N=17 refused', !r2.ok && /16 ports/.test(r2.error), r2.error);
}
// ---------- 23. .s0p extension ignored -> data-shape inference ----------
{
  const p = SNP.parseTouchstone('junk.s0p', '# GHz S RI R 50\n1 0.5 0\n2 0.4 0\n3 0.3 0\n4 0.2 0\n');
  check('.s0p: extension ignored, 1-port inferred', p.ok && p.nPorts === 1 && p.points === 4 &&
    p.warnings.some(w => /s0p/.test(w)) && p.warnings.some(w => /inferred/.test(w)),
    p.ok ? p.warnings.join(';') : p.error);
}
// ---------- 24. serializer: missing S keys warn through the channel ----------
{
  const warnings = [];
  const txt = SNP.serializeTouchstone({ nPorts: 2, z0: 50,
    freqHz: new Float64Array([1e9]), S: { '1,1': { re: new Float64Array([0.5]), im: new Float64Array([0.1]) } } },
    { warnings });
  check('missing-key serialization warns', warnings.length === 1 && /absent from the S map/.test(warnings[0]), warnings.join(';'));
  check('missing keys written as 0', /0 0 0 0 0 0$/.test(txt.trim().split('\n').pop()));
}
// ---------- 25. v2 [Matrix Format] Lower/Upper refused (mutation-audit survivor) ----------
{
  const v2 = ['[Version] 2.0', '# GHz S RI R 50', '[Number of Ports] 2', '[Two-Port Data Order] 21_12',
    '[Matrix Format] Lower', '[Network Data]', '1 .1 0 .9 0 .5 0 .1 0', '[End]'].join('\n') + '\n';
  const p = SNP.parseTouchstone('lower.s2p', v2);
  check('[Matrix Format] Lower refused', !p.ok && /Matrix Format/i.test(p.error), p.ok ? 'ok!' : p.error);
}
// ---------- 26. merge: port labels past 9 are unambiguous ----------
{
  const r = SNP.mergeSnp([{ net: parsePair('a.s2p', genPair(1, 2)), a: 1, b: 11, label: 'wide' }]);
  check('merge to port 11 ok (N=11)', r.ok && r.nPorts === 11, r.ok ? '' : r.error);
  check('missing-pair labels use S(i,j) past port 9',
    r.ok && r.warnings.some(w => /S\(10,11\)/.test(w) && !/S1011/.test(w)), r.ok ? r.warnings.join(';').slice(0, 200) : '');
}

// ---------- 27. Smith-chart math: Gamma -> Z, exact ----------
{
  const z = (re, im, z0) => SNP.gammaToZ(re, im, z0);
  const m = z(0, 0, 50);
  check('Gamma=0 -> Z0 (matched)', approx(m.r, 50, 1e-15) && approx(m.x, 0, 1e-15));
  const h = z(0.5, 0, 50);
  check('Gamma=+0.5 -> 3*Z0', approx(h.r, 150, 1e-12) && approx(h.x, 0, 1e-12));
  const l = z(-0.5, 0, 50);
  check('Gamma=-0.5 -> Z0/3', approx(l.r, 50 / 3, 1e-12) && approx(l.x, 0, 1e-12));
  const j = z(0, 1, 50);
  check('Gamma=+j -> pure +jZ0 (inductive short)', approx(j.r, 0, 1e-9) && approx(j.x, 50, 1e-12), JSON.stringify(j));
  check('Gamma=1 (open) -> null, never Infinity', z(1, 0, 50) === null);
  const z75 = z(0.2, -0.1, 75);
  // independent complex arithmetic: (1+G)/(1-G) * z0
  const dRe = 0.8, dIm = 0.1, den = dRe * dRe + dIm * dIm;
  const expR = 75 * (1.2 * dRe + (-0.1) * dIm) / den, expX = 75 * ((-0.1) * dRe - 1.2 * dIm) / den;
  check('Gamma complex @ 75 ohm matches direct arithmetic', approx(z75.r, expR, 1e-12) && approx(z75.x, expX, 1e-12));
}
// ---------- 28. Smith grid geometry ----------
{
  const g = SNP.smithGridGeometry();
  const r1 = g.circles.find(c => c.v === 1);
  check('constant-r=1 circle at (0.5,0) rad 0.5', r1 && r1.cx === 0.5 && r1.cy === 0 && r1.rad === 0.5);
  const r02 = g.circles.find(c => c.v === 0.2);
  check('constant-r=0.2 circle', r02 && approx(r02.cx, 1 / 6, 1e-15) && approx(r02.rad, 5 / 6, 1e-15));
  const x1 = g.arcs.find(a => a.v === 1), xm1 = g.arcs.find(a => a.v === -1);
  check('constant-x=+1/-1 arcs at (1,±1) rad 1', x1 && x1.cx === 1 && x1.cy === 1 && x1.rad === 1
    && xm1 && xm1.cy === -1 && xm1.rad === 1);
  const p = SNP.smithXLabelPoint(1);
  check('x=1 meets unit circle at (0,1)', approx(p.re, 0, 1e-15) && approx(p.im, 1, 1e-15));
  const pm = SNP.smithXLabelPoint(-0.5);
  check('x=-0.5 label point on |G|=1', approx(Math.hypot(pm.re, pm.im), 1, 1e-12) && pm.im < 0);
  check('grid families complete', g.circles.length === 5 && g.arcs.length === 10);
}

// ---------- 29. complex parser ----------
{
  const P = SNP.parseComplex;
  check('cx: 1+j2', JSON.stringify(P('1+j2')) === '{"re":1,"im":2}');
  check('cx: 1 - j 0.5 (spaces)', JSON.stringify(P('1 - j 0.5')) === '{"re":1,"im":-0.5}');
  check('cx: bare j / -j', P('j').im === 1 && P('-j').im === -1 && P('j').re === 0);
  check('cx: trailing j form 2-3j', JSON.stringify(P('2-3j')) === '{"re":2,"im":-3}');
  check('cx: pure real 25', JSON.stringify(P('25')) === '{"re":25,"im":0}');
  check('cx: exponents .5e1+j.25', P('.5e1+j.25').re === 5 && P('.5e1+j.25').im === 0.25);
  check('cx: i accepted as j', P('1+i2').im === 2);
  check('cx: rejects garbage', P('abc') === null && P('') === null && P('1+2') === null && P('j1j2') === null && P('1+j2+3') === null);
}
// ---------- 30. smith design engine: physics ----------
{
  const S = (steps, z0) => SNP.smithSolve(steps, z0 ?? 50);
  const st = (o) => ({ q: 'z', norm: true, value: '', z0line: 50, eleDeg: 0, swr: false, z0new: 50, ...o });

  // normalized start 1+j2 @ 50 ohm -> 50+j100 absolute
  let r = S([st({ kind: 'start', value: '1+j2' })]);
  check('start: z=1+j2 norm@50 -> 50+j100 abs', r[0].ok && approx(r[0].zAbs.re, 50, 1e-12) && approx(r[0].zAbs.im, 100, 1e-12));
  // absolute entry
  r = S([st({ kind: 'start', value: '25-j10', norm: false })]);
  check('start: absolute 25-j10', r[0].zAbs.re === 25 && r[0].zAbs.im === -10);
  // admittance start: y=0.5 norm -> Y=0.01 S -> Z=100
  r = S([st({ kind: 'start', q: 'y', value: '0.5' })]);
  check('start via Y: y=0.5 norm -> 100 ohm', approx(r[0].zAbs.re, 100, 1e-12) && approx(r[0].zAbs.im, 0, 1e-12));

  // series pure reactance: r constant along the WHOLE path (constant-resistance circle)
  r = S([st({ kind: 'start', value: '0.5+j0' }), st({ kind: 'series', value: 'j2' })]);
  let rOk = r[1].ok && r[1].pathAbs.length > 90;
  for (const p of r[1].pathAbs) if (!approx(p[0], 25, 1e-9)) rOk = false;   // Re(Z)=25 ohm everywhere
  check('series jX: path holds constant resistance', rOk);
  check('series jX: endpoint 25+j100', approx(r[1].zAbs.im, 100, 1e-12));

  // shunt pure susceptance: conductance constant along the path (constant-G circle)
  r = S([st({ kind: 'start', value: '1+j0' }), st({ kind: 'shunt', q: 'y', value: 'j1' })]);
  let gOk = r[1].ok;
  for (const p of r[1].pathAbs) {
    const d = p[0] * p[0] + p[1] * p[1];
    if (!approx(p[0] / d, 1 / 50, 1e-9)) gOk = false;     // Re(Y)=1/50 S everywhere
  }
  check('shunt jB: path holds constant conductance', gOk);
  check('shunt jB endpoint: z = 1/(1+j1) norm = 25-j25 abs', approx(r[1].zAbs.re, 25, 1e-9) && approx(r[1].zAbs.im, -25, 1e-9));

  // quarter-wave same-Z0 line inverts the normalized impedance: zL=2 -> zin=0.5
  r = S([st({ kind: 'start', value: '2' }), st({ kind: 'line', z0line: 50, eleDeg: 90 })]);
  check('lambda/4 line inverts: 100 ohm -> 25 ohm', r[1].ok && approx(r[1].zAbs.re, 25, 1e-9) && approx(r[1].zAbs.im, 0, 1e-9));

  // classic quarter-wave transformer: 100 ohm through Z0=sqrt(50*100) -> 50 ohm
  r = S([st({ kind: 'start', value: '100', norm: false }), st({ kind: 'line', z0line: Math.sqrt(5000), eleDeg: 90 })]);
  check('QW transformer 100 -> 50 via 70.71', approx(r[1].zAbs.re, 50, 1e-9) && approx(r[1].zAbs.im, 0, 1e-9));

  // the line path is constant |gamma| in ITS OWN frame (constant SWR), and the
  // full SWR circle closes on itself
  r = S([st({ kind: 'start', value: '2+j1' }), st({ kind: 'line', z0line: 75, eleDeg: 130, swr: true })]);
  const gOfLine = (p) => { const d = (p[0] + 75) * (p[0] + 75) + p[1] * p[1]; return Math.hypot((p[0] - 75) * (p[0] + 75) + p[1] * p[1], p[1] * (p[0] + 75) - p[1] * (p[0] - 75)) / d; };
  const mags = r[1].pathAbs.map(gOfLine);
  check('line path: |gamma| constant in the line frame', r[1].ok && mags.every(m => approx(m, mags[0], 1e-9)));
  const c0 = r[1].circleAbs[0], cN = r[1].circleAbs[r[1].circleAbs.length - 1];
  check('SWR circle closes', Math.hypot(c0[0] - cN[0], c0[1] - cN[1]) < 1e-6);

  // renormalization: z0After changes, and NORMALIZED entries after it use the new z0
  r = S([st({ kind: 'start', value: '1' }), st({ kind: 'renorm', z0new: 100 }), st({ kind: 'series', value: 'j1' })]);
  check('renorm: z0After propagates', r[1].z0After === 100 && r[2].z0After === 100);
  check('renorm: later norm entries use the NEW z0 (j1 -> +j100 ohm)', approx(r[2].zAbs.im, 100, 1e-12));

  // error paths are named, never silent
  r = S([st({ kind: 'series', value: 'j1' })]);
  check('series before start refused', !r[0].ok && /start point/.test(r[0].err));
  r = S([st({ kind: 'start', value: '???' })]);
  check('bad value named in the error', !r[0].ok && /cannot read/.test(r[0].err));
  r = S([st({ kind: 'start', value: '0+j1' }), st({ kind: 'shunt', q: 'y', value: 'j1' })]);   // z=j -> y=-j; +j1 cancels
  check('shunt cancelling to an open is refused loudly', !r[1].ok && /open/.test(r[1].err));
}
// ---------- 31. renormalization map + Y grid + Q circles ----------
{
  const g = SNP.remapGamma(0, 0, 50, 100);            // 50 ohm point on a 100 ohm chart
  check('remap: 50-ohm match on 100-ohm chart -> -1/3', approx(g.re, -1 / 3, 1e-12) && approx(g.im, 0, 1e-12));
  const rt = SNP.remapGamma(g.re, g.im, 100, 50);
  check('remap round-trip is exact', approx(rt.re, 0, 1e-12) && approx(rt.im, 0, 1e-12));
  check('remap identity when z0 equal', SNP.remapGamma(0.3, -0.2, 50, 50).re === 0.3);

  const yg = SNP.smithYGridGeometry();
  const g1 = yg.circles.find(c => c.v === 1);
  check('Y grid: g=1 circle mirrored to (-0.5,0)', g1.cx === -0.5 && g1.rad === 0.5);
  const b1 = yg.arcs.find(a => a.v === 1);
  check('Y grid: b=+1 arc at (-1,-1)', b1 && b1.cx === -1 && b1.cy === -1);

  // Q circles: z=1+j1 lies on Q=1; z=2+j4 lies on Q=2 (checked in the gamma plane)
  const onQ = (zre, zim, Q) => {
    const G = SNP.gammaOfZ(zre * 50, zim * 50, 50);
    const qs = SNP.qCircleGeometry(Q);
    return qs.some(c => approx(Math.hypot(G.re - c.cx, G.im - c.cy), c.rad, 1e-9));
  };
  check('Q=1 circle passes z=1+j1', onQ(1, 1, 1));
  check('Q=2 circle passes z=2+j4', onQ(2, 4, 2));
  check('Q circles pass (+-1, 0)', (() => { const c = SNP.qCircleGeometry(3)[0]; return approx(Math.hypot(1 - c.cx, 0 - c.cy), c.rad, 1e-12); })());
}

// ---------- 32. review-hardening regressions ----------
{
  const P = SNP.parseComplex;
  check('cx: glued 2j3 rejected (was j23)', P('2j3') === null && P('0.5j2') === null);
  check('cx: "1 2" rejected (was 12)', P('1 2') === null);
  check('cx: unsigned second term rejected', P('5 j2') === null && P('1 j2') === null);
  check('cx: legit spaced/trailing forms still parse', P('1 - j 0.5').im === -0.5 && P('1+2j').im === 2 && P('2j').im === 2);

  const st = (o) => ({ q: 'z', norm: true, value: '', z0line: 50, eleDeg: 0, swr: false, z0new: 50, ...o });
  // a failed step BLOCKS later transforms (the error message is now true)…
  let r = SNP.smithSolve([st({ kind: 'start', value: '1' }), st({ kind: 'shunt', value: '0' }),
                          st({ kind: 'series', value: 'j1' })], 50);
  check('failed step blocks the chain', !r[1].ok && !r[2].ok && /blocked by failed step 2/.test(r[2].err));
  // …and a fresh start point re-roots it
  r = SNP.smithSolve([st({ kind: 'start', value: '1' }), st({ kind: 'shunt', value: '0' }),
                      st({ kind: 'start', value: '2' }), st({ kind: 'series', value: 'j1' })], 50);
  check('a new start point re-roots after a failure', r[2].ok && r[3].ok && approx(r[3].zAbs.im, 50, 1e-12));

  // multi-revolution line: samples scale with electrical length
  r = SNP.smithSolve([st({ kind: 'start', value: '2+j1' }), st({ kind: 'line', z0line: 50, eleDeg: 720 })], 50);
  check('720-degree line is densely sampled', r[1].ok && r[1].pathAbs.length > 1000, r[1].pathAbs && String(r[1].pathAbs.length));
  check('720-degree line returns to start (2 full revolutions)',
    approx(r[1].zAbs.re, 100, 1e-9) && approx(r[1].zAbs.im, 50, 1e-9));

  // the Z = -z0 pole is a null, never the open point
  check('gammaOfZ null at Z=-z0 (not Γ=+1)', SNP.gammaOfZ(-50, 0, 50) === null);
}

// ---------- 33. caret-place stepping (the value-field tuner) ----------
{
  const S = SNP.stepComplexAt;
  const eq = (got, val, car, name) => check(name, got && got.value === val && got.caret === car,
    got ? got.value + ' @' + got.caret : 'null');

  eq(S('1.25', 4, 1), '1.26', 4, 'step: last decimal up');
  eq(S('1.25', 4, -1), '1.24', 4, 'step: last decimal down');
  eq(S('1.25', 3, 1), '1.35', 3, 'step: tenths place (caret mid-token)');
  eq(S('1.25', 1, 1), '2.25', 1, 'step: ones place');
  eq(S('1.25', 2, 1), '1.35', 3, 'step: caret right after the dot steps the first fraction digit');
  eq(S('25', 1, 1), '35', 1, 'step: integer tens place');
  eq(S('25', 0, 1), '35', 1, 'step: caret at start uses the first digit');
  eq(S('9.9', 3, 1), '10.0', 4, 'carry widens the token and the caret follows the place');
  eq(S('10.0', 4, -1), '9.9', 3, 'borrow narrows the token');
  eq(S('0.1', 3, -1), '0.0', 3, 'step down to zero');
  eq(S('0.0', 3, -1), '-0.1', 4, 'crossing zero adds a leading minus');
  eq(S('-0.1', 4, 1), '0.0', 3, 'crossing back removes it');

  // complex forms: the imaginary part steps independently, signs flip in place
  eq(S('1+j2', 4, 1), '1+j3', 4, 'imag part up');
  eq(S('1+j1', 4, -1), '1+j0', 4, 'imag to zero keeps the + slot');
  eq(S('1+j0', 4, -1), '1-j1', 4, 'imag crossing zero flips + to -');
  eq(S('1-j1', 4, 1), '1+j0', 4, 'and back');
  eq(S('1+j2', 1, -1), '0+j2', 1, 'real part steps without touching the imag');
  eq(S('-j0.5', 5, 1), '-j0.4', 5, 'negative pure-imaginary steps toward zero');
  eq(S('-j0.4', 5, 1, 'x'), '-j0.3', 5, 'again');
  const z = S('-j0.1', 5, 1);
  check('pure-imag crossing zero drops the leading minus', z && z.value === 'j0.0', z && z.value);
  eq(S('2j', 1, 1), '3j', 1, 'trailing-j form steps its number');

  // caret in dead space snaps to the nearest number
  const d = S('1+j2', 2, 1);   // caret on the '+' -> nearest digit is the '1'
  check('caret on an operator steps the adjacent number', d && (d.value === '2+j2' || d.value === '1+j3'), d && d.value);
  check('no numbers -> null', S('abc', 1, 1) === null && S('', 0, 1) === null);

  // repeated stepping at a held caret is stable (the sweep gesture)
  let st = { value: '1.00', caret: 3 };
  for (let k = 0; k < 15; k++) st = S(st.value, st.caret, 1);
  check('15 presses at the tenths place: 1.00 -> 2.50', st.value === '2.50', st.value);
}

// ---------- 34. design bundles: sanitizer + legacy migration ----------
{
  const SS = SNP.sanSmith;
  // legacy single-chain shape migrates losslessly into chains[0]
  const leg = SS({ z0: 75, showYGrid: true, qList: [2], cursor: 1,
    steps: [{ kind: 'start', value: '1+j2' }, { kind: 'series', value: 'j1', color: '#123abc' }] });
  check('legacy migrates to chains[0]', leg.chains.length === 1 && leg.chains[0].steps.length === 2
    && leg.chains[0].cursor === 1 && leg.chains[0].steps[0].value === '1+j2'
    && leg.chains[0].steps[1].color === '#123abc' && leg.z0 === 75 && leg.qList[0] === 2);
  // chains shape round-trips through its own sanitizer (persistence path)
  const multi = SS({ chains: [
    { name: 'match A', steps: [{ kind: 'start', value: '1' }], cursor: 0 },
    { name: 'match B', hide: true, steps: [{ kind: 'start', value: '2' }, { kind: 'line' }], cursor: 5 },
  ], active: 1 });
  check('chains round-trip with names/hide/active', multi.chains.length === 2
    && multi.chains[0].name === 'match A' && multi.chains[1].hide === true && multi.active === 1);
  check('per-chain cursor clamps to its own length', multi.chains[1].cursor === 1);
  const again = SS(multi);
  check('sanitizer idempotent on chains', JSON.stringify(again) === JSON.stringify(multi));
  // caps: 16 chains, 64 steps each
  const big = SS({ chains: Array.from({ length: 25 }, (_, i) => ({ name: 'c' + i, steps: [] })) });
  check('chain count capped at 16', big.chains.length === 16);
  const deep = SS({ chains: [{ steps: Array.from({ length: 99 }, () => ({ kind: 'start', value: '1' })) }] });
  check('steps per chain capped at 64', deep.chains[0].steps.length === 64);
  // empty input -> one empty chain, never zero
  const e = SS(null);
  check('empty config yields one empty chain', e.chains.length === 1 && e.chains[0].steps.length === 0 && e.chains[0].cursor === null);
  check('active clamps into range', SS({ chains: [{ steps: [] }], active: 9 }).active === 0);
}

// ---------- 35. grid toggles: wiring (source-level, the call sites) ----------
// The Smith Z grid and the header "grid" box are ONE per-tab flag shown twice.
// A helper can be right while a renderer keeps its own copy of the bug, so these
// assert the CALL SITES: both checkboxes exist, both write state.grid, each
// cross-syncs the other, and the Z circles/arcs are gated on that same flag.
{
  const has = (re, what) => check(what, re.test(html), 'not found in index.html');
  has(/id="smZGrid"[^>]*>\s*Z grid|<input type="checkbox" id="smZGrid">\s*Z grid/, 'Smith panel has a "Z grid" checkbox');
  has(/id="smYGrid"[^>]*>\s*Y grid|<input type="checkbox" id="smYGrid">\s*Y grid/, 'Smith panel still has the "Y grid" checkbox');
  // the panel box drives the same flag the header box does, and syncs it back
  has(/\$\('smZGrid'\)\.addEventListener\('change',\(\)=>\{[\s\S]{0,200}?state\.grid=\$\('smZGrid'\)\.checked/,
      'the Z-grid checkbox writes state.grid');
  has(/\$\('smZGrid'\)\.addEventListener\('change',\(\)=>\{[\s\S]{0,200}?\$\('gridChk'\)\.checked=state\.grid/,
      'the Z-grid checkbox re-checks the header box');
  has(/\$\('gridChk'\)\.addEventListener\('change',\(\)=>\{[\s\S]{0,220}?\$\('smZGrid'\)\.checked=state\.grid/,
      'the header box re-checks the Z-grid checkbox');
  // both toggles must survive a refresh: they are project state
  has(/\$\('gridChk'\)\.addEventListener\('change',\(\)=>\{[\s\S]{0,220}?scheduleAutosave\(\)/,
      'toggling the grid schedules an autosave');
  has(/renderSmithPanel[\s\S]{0,600}?\$\('smZGrid'\)\.checked=state\.grid/,
      'the panel re-syncs the Z-grid box from state on every render');
  // the render gate: constant-r circles come from smithGridGeometry under state.grid
  const rs = html.slice(html.indexOf('function renderSmith('));
  check('renderSmith gates smithGridGeometry on state.grid',
    /if \(state\.grid\)\{?\s*\n?\s*const geo=SNP\.smithGridGeometry\(\)/.test(rs));
  check('renderSmith gates the Y grid on sm.showYGrid',
    /if \(sm\.showYGrid\)\{?\s*\n?\s*const yg=SNP\.smithYGridGeometry\(\)/.test(rs));
  // ...and the r/x TICK NUMBERS with it — a gridless chart wearing impedance
  // numerals is exactly the half-done state this feature is about
  check('renderSmith gates the r/x number labels on state.grid',
    /if \(state\.grid\)\{?\s*\n?\s*for \(const rv of \[0\.2,0\.5,1,2,5\]\)/.test(rs));
  // gridless = the complex plane stays: unit circle + real axis are NOT gated.
  // Measure the PREFIX before the first conditional — an indexOf('if (state.grid)')
  // over the whole block silently re-latches onto a later gate when an earlier one
  // is deleted, so the check would keep passing over the regression it exists for.
  const axesHead = rs.slice(rs.indexOf("let a='<circle"), rs.indexOf('if (', rs.indexOf("let a='<circle")));
  check('the unit circle + real axis are drawn unconditionally (the complex plane)',
    (axesHead.match(/stroke="var\(--axis\)"/g) || []).length === 2, axesHead.slice(0, 80));
  // the in-plot note names only the grids actually drawn — and says nothing when neither is
  check('the grid-label note is built from both flags',
    /if \(state\.grid\) gl\.push\('z\/Z0'\)/.test(rs) && /if \(sm\.showYGrid\) gl\.push\('y\/Y0'\)/.test(rs));
  check('the note omits the "grid labels" clause when neither grid is drawn',
    /gl\.length\?\s*'grid labels: '/.test(rs));
}

// ---------- 36. smith hover readout: every quantity of a point on the chart ----------
{
  const R = SNP.smithReadout;
  // independent complex division for the oracle
  const cdiv = (a, b, c, d) => { const den = c * c + d * d; return [(a * c + b * d) / den, (b * c - a * d) / den]; };

  const m = R(0, 0, 50);
  check('matched point: z = Z0, y = 1/Z0, SWR 1, Q 0',
    m.zn.r === 1 && m.zn.x === 0 && m.z.r === 50 && m.z.x === 0
    && approx(m.yn.g, 1) && approx(m.y.g, 0.02) && m.swr === 1 && m.q === 0);
  check('matched point: |G| = 0 is infinite return loss', m.db === -Infinity && m.mag === 0);

  const h = R(0.5, 0, 50);
  check('G=0.5: z = 3, Z = 150, y = 1/3, SWR = 3',
    approx(h.zn.r, 3) && approx(h.z.r, 150) && approx(h.yn.g, 1 / 3)
    && approx(h.y.g, 1 / 150) && approx(h.swr, 3));
  check('G=0.5: return loss is -db = 6.0206 dB', approx(-h.db, 6.020599913279624, 1e-9));

  // G = j sits ON the unit circle: z = j (pure reactance) -> R = 0, Q infinite, SWR infinite
  const j = R(0, 1, 50);
  check('G=j: z = j1 exactly', Math.abs(j.zn.r) < 1e-12 && approx(j.zn.x, 1) && approx(j.z.x, 50));
  check('G=j: Q is infinite (no resistance), SWR is infinite', j.q === Infinity && j.swr === Infinity);

  const op = R(1, 0, 50);
  check('OPEN (G=+1): z is null, y is exactly 0',
    op.zn === null && op.z === null && op.yn.g === 0 && op.yn.b === 0 && op.y.g === 0);
  const sh = R(-1, 0, 50);
  check('SHORT (G=-1): z is exactly 0, y is null',
    sh.zn.r === 0 && sh.zn.x === 0 && sh.yn === null && sh.y === null && sh.q === 0);

  const act = R(1.5, 0, 50);
  check('|G|>1 (negative resistance): no Q, SWR infinite, gain in dB',
    act.q === null && act.zn.r < 0 && act.swr === Infinity && act.db > 0);

  // fuzz against independent arithmetic + the invariants that tie the four quantities
  let worst = 0, bad = null;
  for (let k = 0; k < 400; k++) {
    const ang = k * 0.9173, rad = 0.02 + (k % 97) / 100;
    const re = rad * Math.cos(ang), im = rad * Math.sin(ang), z0 = 20 + (k % 7) * 15;
    const r = R(re, im, z0);
    const [zr, zx] = cdiv(1 + re, im, 1 - re, -im);
    const [yg, yb] = cdiv(1 - re, -im, 1 + re, im);
    const d = Math.max(Math.abs(r.zn.r - zr), Math.abs(r.zn.x - zx),
      Math.abs(r.yn.g - yg), Math.abs(r.yn.b - yb),
      Math.abs(r.z.r - zr * z0), Math.abs(r.z.x - zx * z0),
      Math.abs(r.y.g - yg / z0), Math.abs(r.y.b - yb / z0));
    // y*z = 1: the two halves are one Mobius, so they can never disagree
    const pr = r.zn.r * r.yn.g - r.zn.x * r.yn.b, pi2 = r.zn.r * r.yn.b + r.zn.x * r.yn.g;
    const dd = Math.max(d, Math.abs(pr - 1), Math.abs(pi2));
    if (dd > worst) { worst = dd; bad = { re, im, z0 }; }
  }
  check('400 points match independent complex arithmetic and y*z = 1', worst < 1e-10,
    'worst ' + worst + ' at ' + JSON.stringify(bad));

  // A LOSSLESS point is THE Smith-chart case (a short, an open, any stub): the complex
  // division leaves R = +-1e-15 there, and reporting that is a negative resistance, a
  // random Q and an SWR of 1.8e16 -- noise with five significant digits on it.
  {
    let worstR = 0, qBad = 0, swrBad = 0;
    for (let deg = 0; deg < 360; deg += 1) {
      const a = deg * Math.PI / 180, r = R(Math.cos(a), Math.sin(a), 50);
      if (r.zn === null) continue;                       // deg 0 is the open: no z at all
      worstR = Math.max(worstR, Math.abs(r.zn.r));
      if (r.q !== (r.zn.x === 0 ? 0 : Infinity)) qBad++;
      if (r.swr !== Infinity) swrBad++;
    }
    check('every point on the unit circle reads R = 0 exactly', worstR === 0, 'worst |R| ' + worstR);
    check('...with the infinite Q and SWR that go with it', qBad === 0 && swrBad === 0,
      'q wrong on ' + qBad + ', swr wrong on ' + swrBad);
  }
  // ...and the floor must not eat a resistance a measurement could actually resolve
  const negR = R(...(g => [g.re, g.im])(SNP.gammaOfZ(-0.001, 50, 50)), 50);
  check('a REAL negative resistance (-1 mOhm) is not rounded away', approx(negR.zn.r, -0.00002) && negR.q === null);
  const hiQ = R(...(g => [g.re, g.im])(SNP.gammaOfZ(0.0001, 50, 50)), 50);
  check('a Q of 500000 survives the floor exactly', approx(hiQ.q, 5e5, 1e-6));

  // the vocabulary the UI builds its chips from
  check('hover vocabulary is the 9 documented quantities',
    JSON.stringify(SNP.SMITH_HOVER_KEYS) === JSON.stringify(['gpolar', 'gri', 'rl', 'swr', 'zn', 'z', 'yn', 'y', 'q']));
  const d0 = SNP.sanSmith(null).hover;
  check('an old project with no hover map gets the defaults, not an empty tooltip',
    d0.gpolar === true && d0.gri === true && d0.zn === true && d0.z === true
    && d0.yn === false && d0.y === false && d0.swr === false && d0.rl === false && d0.q === false);
  const d1 = SNP.sanSmith({ hover: { zn: 1, gpolar: 0, bogus: true } }).hover;
  check('an explicit hover map is coerced to booleans, unknown keys dropped',
    d1.zn === true && d1.gpolar === false && !('bogus' in d1)
    && Object.keys(d1).length === SNP.SMITH_HOVER_KEYS.length);
  check('a key the map does not mention keeps its default', d1.gri === true && d1.z === true);
  const dPart = SNP.sanSmith({ hover: { zn: false, bogus: 1 } }).hover;
  check('a quantity this version adds reaches an older project as its DEFAULT, not as false',
    dPart.zn === false && dPart.gpolar === true && dPart.gri === true && dPart.z === true
    && dPart.q === false);
  const sm1 = SNP.sanSmith({ hover: { y: true, q: true } });
  check('hover survives the sanitizer round trip', JSON.stringify(SNP.sanSmith(sm1)) === JSON.stringify(sm1));
}

// ---------- 37. smith hover: wiring (source-level, the call sites) ----------
{
  const has = (re, what) => check(what, re.test(html), 'not found in index.html');
  const sh = html.slice(html.indexOf('function smithHover(ev,mx,my){'), html.indexOf('function clearHover(){'));
  // the hit test is against the DRAWN CURVE, not only its vertices — hovering between two
  // samples is the common case on a Smith locus and used to find nothing
  // pin the CALL SITES, both of them: a helper can be present while a loop keeps
  // measuring to its vertices (which is exactly the bug this replaced)
  check('the trace loop measures to the polyline SEGMENTS',
    /const sn=segNear\(pX,pY,cX,cY,mx,my\);/.test(sh));
  check('the design loop measures to the polyline SEGMENTS',
    /const sn=segNear\(a\[0\],a\[1\],b\[0\],b\[1\],mx,my\);/.test(sh));
  check('the readout still snaps to a real sample', /sn\.t<0\.5\? q-1 : q/.test(sh));
  check('the hit radius is a screen-px constant', /const R=HOVER_PX/.test(sh) && /const HOVER_PX=\d+;/.test(html));
  // 36 px is what the old VERTEX test used: measuring to the CURVE at the same radius can
  // only gain reach on a sparse locus, so no hover that worked before stops working
  check('the hit radius is not narrower than the vertex test it replaced',
    +(/const HOVER_PX=(\d+);/.exec(html)||[])[1] >= 36);
  // the readout snaps to a sample that may sit off-plot: the marker is clipped like every
  // other drawn layer, so it is never painted outside the frame
  check('the hover marker is clipped to the plot rect',
    /<g id="hoverG" clip-path="url\(#clip\)"><\/g>/.test(html));
  // the design overlay is hit-tested against what the RENDERER recorded while drawing it,
  // so a hidden / cursor-limited / failed step can never be reported
  check('smithHover reads the renderer-recorded design geometry', /P\.dpick/.test(sh));
  check('renderSmith fills P.dpick as it draws', /P\.dpick=dpick;/.test(html) && /pathD\(rec\.pathAbs, hit\)/.test(html));
  check('a pen-up starts a new hover subpath (no segment across a pole)',
    /if \(!q\)\{ pen=false; sub=null; continue; \}/.test(html));
  // only a measured sample can be pinned: a design point has no file, key or sample index
  has(/if \(hoverFocus && hoverFocus\.kind!=='design'\)\{/, 'the click-to-pin path excludes design hits');
  // a design-only session has no traces and still has something to read out
  check('onHover no longer requires a loaded trace', /function onHover\(ev\)\{\s*\n\s*if \(!P\)\{ return; \}/.test(html));
  // the tooltip rows come from the ONE pure readout, through the persisted setting
  check('the tooltip is built from SNP.smithReadout and the hover setting',
    /const rd=SNP\.smithReadout\(best\.re, best\.im, P\.z0c\);/.test(sh) && /const hov=state\.smith\.hover;/.test(sh));
  check('impedance-like rows are withheld on a transmission trace',
    /smithTipRows\(rd, hov, pp\[0\]===pp\[1\]\)/.test(sh)
    && /reflection traces only/.test(html));
  // the settings chips: one per vocabulary entry, writing the per-tab smith state
  has(/id="smHoverRow"/, 'the Smith panel has a hover-readout row');
  has(/SNP\.SMITH_HOVER_KEYS\.map\(k=>/, 'the chips are generated from the PURE vocabulary');
  has(/const k=b\.dataset\.hov, hv=state\.smith\.hover;[\s\S]{0,220}?scheduleAutosave\(\)/,
    'toggling a chip writes state.smith.hover and persists it');
  check('renderSmithPanel re-syncs the chips from state', /renderHoverChips\(sm\);/.test(html));
  // the chip label/tooltip maps are a SECOND copy of the vocabulary: a key missing from
  // either renders an "undefined" chip, so they are pinned against the PURE list
  // each slice is bounded to its OWN literal: an unbounded one finds the key in the
  // other map and passes over a chip that would render "undefined"
  const litAfter = (name) => {
    const a0 = html.indexOf(name);
    return html.slice(a0, html.indexOf('};', a0));
  };
  const labLit = litAfter('const HOVER_LABEL='), titLit = litAfter('const HOVER_TITLE=');
  for (const k of SNP.SMITH_HOVER_KEYS){
    check('chip "' + k + '" has a label and a tooltip',
      new RegExp('[{,]\\s*' + k + ":'").test(labLit)
      && new RegExp('[{,]\\s*\\n?\\s*' + k + ":'").test(titLit));
  }
}

// ---------- 38. the hover tooltip and the hit math, RUN (not grepped) ----------
// Section 37 pins that smithTipRows is CALLED. That is not enough: measured, every one of
// these single-token mutations left the suite green — `if (hov.gpolar)` -> `if (true)` (the
// whole setting dead), `if (zOk){` -> `if (true){` (impedance rows on a transmission trace),
// the mS scale dropped (siemens printed under an mS label), the return-loss sign flipped,
// the open/short labels swapped, and `if (sn.d2<=R2)` widened 20x. Both helpers are DOM-free,
// so they are LIFTED out of the shipped file the same way the PURE block is — the exact code
// that ships is the code under test, never a twin.
{
  const lift = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));
  const UI = new Function('SNP',
    lift('function segNear(', '// the quantity rows')
    + lift('function smithTipRows(', 'function smithHover(')
    + '\nreturn { segNear, smithTipRows };')(SNP);
  const { segNear, smithTipRows } = UI;
  const ALL = {}, NONE = {};
  for (const k of SNP.SMITH_HOVER_KEYS) { ALL[k] = true; NONE[k] = false; }
  const rows = h => (h.match(/<div class="trow"/g) || []).length;
  const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  // Z = 30 - j40 at 50 ohm  ->  y = 1/z = 0.012 + j0.016 S = 12 + j16 mS
  const rd = SNP.smithReadout(...(g => [g.re, g.im])(SNP.gammaOfZ(30, -40, 50)), 50);
  check('every quantity switched ON prints exactly its 9 rows', rows(smithTipRows(rd, ALL, true)) === 9);
  check('every quantity switched OFF prints nothing at all', smithTipRows(rd, NONE, true) === '');
  for (const k of SNP.SMITH_HOVER_KEYS) {
    const one = { ...NONE, [k]: true };
    check('the "' + k + '" chip controls exactly one row', rows(smithTipRows(rd, one, true)) === 1);
  }
  const all = text(smithTipRows(rd, ALL, true));
  check('the Z row is the absolute impedance in ohms', /Z 30 \+ j\(-40\) Ω/.test(all), all);
  check('the z row is normalized by the chart Z0', /z = Z\/Z₀ 0\.6 \+ j\(-0\.8\)/.test(all), all);
  check('the Y row is MILLIsiemens, not siemens', /Y 12 \+ j\(16\) mS/.test(all), all);
  check('the y row is normalized admittance', /y = Y\/Y₀ 0\.6 \+ j\(0\.8\)/.test(all), all);
  check('return loss is POSITIVE for a passive reflection', /return loss 6\.0206 dB/.test(all), all);
  check('SWR reads the standing-wave ratio', /SWR 3 /.test(all), all);
  check('Q is |X|/R of the normalized impedance', /Q = \|X\|\/R 1\.333/.test(all), all);

  // a TRANSMISSION trace: every impedance-like quantity is meaningless there
  const tx = text(smithTipRows(rd, ALL, false));
  const txRows = tx.slice(0, tx.indexOf('reflection traces only') + 1 || undefined);
  check('a transmission trace is given no impedance-like row',
    !/z = |Z 30|y = |Y 12|SWR |Q = /.test(txRows.replace(/z · Z · y · Y · SWR · Q:.*/, '')), tx);
  check('...and is told why, rather than silently given less', /reflection traces only/.test(tx), tx);
  check('...and its dB row reads |S|, with the opposite sign of return loss',
    /\|S\| -6\.0206 dB/.test(tx), tx);
  check('the note is withheld when no impedance-like quantity was asked for',
    !/reflection traces only/.test(smithTipRows(rd, { ...NONE, gpolar: true }, false)));

  // the two poles must not swap: an OPEN has no impedance, a SHORT has no admittance
  const op = text(smithTipRows(SNP.smithReadout(1, 0, 50), ALL, true));
  check('an OPEN says open on z and Z', (op.match(/open \(Γ→1\)/g) || []).length === 2, op);
  check('...and still reports its exactly-zero admittance', /Y 0 \+ j\(0\) mS/.test(op), op);
  const sc = text(smithTipRows(SNP.smithReadout(-1, 0, 50), ALL, true));
  check('a SHORT says short on y and Y', (sc.match(/short \(Γ→−1\)/g) || []).length === 2, sc);
  check('...and still reports its exactly-zero impedance', /Z 0 \+ j\(0\) Ω/.test(sc), sc);
  // one glyph may not mean two things
  const react = text(smithTipRows(SNP.smithReadout(0, 1, 50), { ...NONE, q: true }, true));
  check('a pure reactance reads an infinite Q', /Q = \|X\|\/R ∞/.test(react), react);
  const act = text(smithTipRows(SNP.smithReadout(1.5, 0, 50), { ...NONE, q: true }, true));
  check('an ACTIVE device says its R is negative, not a bare dash', /none \(negative R\)/.test(act), act);

  // segNear: the hit radius IS this function's answer
  const d = (a, b, c, e, x, y) => Math.sqrt(segNear(a, b, c, e, x, y).d2);
  check('a point beside the middle of a segment measures the PERPENDICULAR distance',
    approx(d(0, 0, 100, 0, 50, 7), 7) && approx(segNear(0, 0, 100, 0, 50, 7).t, 0.5));
  check('past an end, the distance is to the ENDPOINT (t clamps)',
    approx(d(0, 0, 100, 0, -30, 40), 50) && segNear(0, 0, 100, 0, -30, 40).t === 0
    && approx(d(0, 0, 100, 0, 140, 30), 50) && segNear(0, 0, 100, 0, 140, 30).t === 1);
  check('the nearest point lies ON the segment', (() => {
    const s2 = segNear(10, 10, 60, 90, 70, 20);
    return s2.t >= 0 && s2.t <= 1 && approx(s2.x, 10 + s2.t * 50) && approx(s2.y, 10 + s2.t * 80);
  })());
  check('a zero-length segment degrades to the point distance',
    approx(d(5, 5, 5, 5, 5, 12), 7) && segNear(5, 5, 5, 5, 5, 12).t === 0);
  check('a diagonal segment measures the true perpendicular, not a bbox',
    approx(d(0, 0, 100, 100, 50, 0), 50 / Math.SQRT2));
}

// ---------- 39. where the hover ring is DRAWN ----------
{
  const sh = html.slice(html.indexOf('function smithHover(ev,mx,my){'), html.indexOf('function clearHover(){'));
  // the ring marks the SAMPLE (best.X/best.Y), never the cursor's point on the curve —
  // that is the whole claim of "snaps to real data samples"
  check('the ring is drawn at the snapped sample',
    /<circle cx="'\+best\.X\+'" cy="'\+best\.Y\+'" r="6"/.test(sh));
  // ...and the connector runs FROM the point on the curve TO it, so the snap is visible
  check('the connector runs from the curve point to the sample',
    /x1="'\+best\.hx\+'" y1="'\+best\.hy\+'" x2="'\+best\.X\+'" y2="'\+best\.Y\+'"/.test(sh));
  check('the connector is drawn only when the snap actually moved the marker',
    /if \(Math\.hypot\(best\.hx-best\.X, best\.hy-best\.Y\)>6\)/.test(sh));
  // nearest wins, over BOTH sources: the comparison is strict-less on squared distance
  check('the nearest candidate wins', /const take=c=>\{ if \(!best \|\| c\.d2<best\.d2\) best=c; \};/.test(sh));
  check('both the trace loop and the design loop go through it',
    (sh.match(/take\(\{/g) || []).length === 4);
  check('the marker takes the colour of what it marks',
    /const col= best\.kind==='trace'\? best\.t\.color : best\.h\.st\.color;/.test(sh));
}

// ---------- 40. the r=1 / g=1 match circles ----------
{
  const u = SNP.smithUnityCircles();
  // LIFTED from the grids, not re-derived: the highlight must land ON the line it
  // highlights, at every zoom, for ever
  const zr1 = SNP.smithGridGeometry().circles.find(c => c.v === 1);
  const yg1 = SNP.smithYGridGeometry().circles.find(c => c.v === 1);
  check('r=1 IS the impedance grid\'s own r=1 circle',
    u.r1.cx === zr1.cx && u.r1.cy === zr1.cy && u.r1.rad === zr1.rad);
  check('g=1 IS the admittance grid\'s own g=1 circle',
    u.g1.cx === yg1.cx && u.g1.cy === yg1.cy && u.g1.rad === yg1.rad);
  check('g=1 is the mirror of r=1 (the replica)',
    u.g1.cx === -u.r1.cx && u.g1.cy === u.r1.cy && u.g1.rad === u.r1.rad);
  check('the classic geometry: centre ±0.5, radius 0.5',
    u.r1.cx === 0.5 && u.r1.cy === 0 && u.r1.rad === 0.5);

  // the three points that make these circles the ones an L-match is built on
  const on = (c, re, im) => approx(Math.hypot(re - c.cx, im - c.cy), c.rad, 1e-12);
  check('both pass through Γ=0 — the match itself', on(u.r1, 0, 0) && on(u.g1, 0, 0));
  check('r=1 touches the unit circle at Γ=+1 (an open)', on(u.r1, 1, 0));
  check('g=1 touches it at Γ=-1 (a short)', on(u.g1, -1, 0));
  // every point of r=1 really has unit normalized resistance (and g=1 unit conductance)
  let worstR = 0, worstG = 0;
  for (let k = 0; k < 64; k++) {
    const t = k / 64 * 2 * Math.PI;
    const pr = SNP.smithReadout(u.r1.cx + u.r1.rad * Math.cos(t), u.r1.cy + u.r1.rad * Math.sin(t), 50);
    if (pr.zn) worstR = Math.max(worstR, Math.abs(pr.zn.r - 1));
    const pg = SNP.smithReadout(u.g1.cx + u.g1.rad * Math.cos(t), u.g1.cy + u.g1.rad * Math.sin(t), 50);
    if (pg.yn) worstG = Math.max(worstG, Math.abs(pg.yn.g - 1));
  }
  check('every point of the r=1 circle reads r = 1', worstR < 1e-9, 'worst ' + worstR);
  check('every point of the g=1 circle reads g = 1', worstG < 1e-9, 'worst ' + worstG);
  check('each circle carries its own label', u.r1.label === 'r = 1' && u.g1.label === 'g = 1');

  // the toggles are project state, off by default
  const d = SNP.sanSmith(null);
  check('the highlights are off until asked for', d.hlR1 === false && d.hlG1 === false);
  const on2 = SNP.sanSmith({ hlR1: 1, hlG1: 0 });
  check('they are coerced to booleans and round-trip', on2.hlR1 === true && on2.hlG1 === false
    && JSON.stringify(SNP.sanSmith(on2)) === JSON.stringify(on2));
}

// ---------- 41. the match circles: wiring ----------
{
  const rs = html.slice(html.indexOf('function renderSmith('));
  // drawn from the PURE geometry, and INDEPENDENT of either grid toggle: the clearest
  // figure is these two circles alone on a bare complex plane
  check('the circles come from SNP.smithUnityCircles', /const unity=SNP\.smithUnityCircles\(\);/.test(rs));
  check('r=1 is gated on its OWN flag, not on the Z grid', /if \(sm\.hlR1\) hlPairs\.push\(\[unity\.r1/.test(rs));
  check('g=1 is gated on its OWN flag, not on the Y grid', /if \(sm\.hlG1\) hlPairs\.push\(\[unity\.g1/.test(rs));
  const hlBlock = rs.slice(rs.indexOf('const unity=SNP.smithUnityCircles'), rs.indexOf('for (const Q of sm.qList)'));
  check('the highlight is not nested inside a grid branch', !/state\.grid|showYGrid/.test(hlBlock), hlBlock);
  check('it is drawn wider than a grid line', /stroke-width="1\.9"/.test(rs));
  check('each circle is labelled on the chart', /\+c\.label\+/.test(rs));
  // the toggles: panel, sync, persistence
  check('the panel has both checkboxes', /id="smHlR1"/.test(html) && /id="smHlG1"/.test(html));
  check('the panel re-syncs them from state',
    /\$\('smHlR1'\)\.checked=sm\.hlR1;/.test(html) && /\$\('smHlG1'\)\.checked=sm\.hlG1;/.test(html));
  for (const k of ['hlR1','hlG1'])
    check('toggling ' + k + ' redraws and persists',
      new RegExp("state\\.smith\\." + k + "=\\$\\('sm" + (k==='hlR1'?'HlR1':'HlG1') + "'\\)\\.checked; renderPlot\\(\\); scheduleAutosave\\(\\)").test(html));
}

// ---------- 42. the circuit window: a design list as a circuit + S-parameters ----------
{
  const st = (o) => ({ q: 'z', norm: true, value: '', z0line: 50, eleDeg: 45, swr: false, z0new: 50, color: '#e11d48', op: 1, hide: false, hl: false, ...o });
  // L-match 100 ohm -> 50: shunt y = +j0.5 then series z = +j1 (normalised) at f0
  const lm = [st({ kind: 'start', value: '2' }), st({ kind: 'shunt', q: 'y', value: 'j0.5' }), st({ kind: 'series', value: 'j1' })];
  const r = SNP.circuitSolve(lm, 50, { f0: 1e9, n: 21, fStart: 0.5e9, fStop: 1.5e9 });
  check('circuit: L-match solves', r.ok, r.error);
  const ci = r.circuit;
  check('circuit: elements run port 1 -> load', ci.elements.map(e => e.type).join(',') === 'series,shunt');
  check('circuit: series j50 at 1 GHz is L = 50/w0', approx(ci.elements[0].L, 50 / (2 * Math.PI * 1e9), 1e-12));
  check('circuit: shunt +j0.01 S at 1 GHz is C = 0.01/w0', approx(ci.elements[1].C, 0.01 / (2 * Math.PI * 1e9), 1e-12));
  check('circuit: the fitted load is a 100 ohm resistor', r.load.topo === 'R' && r.load.R === 100);
  check('circuit: Z_in(f0) is the chart\'s last point', r.f0Check && r.f0Check.ok, JSON.stringify(r.f0Check));
  const k0 = SNP.nearestIdx(r.freqHz, 1e9);
  const S = r.res.S;
  check('circuit: matched at f0 -> |S11| ~ 0', Math.hypot(S['1,1'].re[k0], S['1,1'].im[k0]) < 1e-12);
  check('circuit: matched at f0 -> |S21| = 1', approx(Math.hypot(S['2,1'].re[k0], S['2,1'].im[k0]), 1, 1e-12));
  let lossless = true, recip = true;
  for (let k = 0; k < r.freqHz.length; k++) {
    const a = S['1,1'].re[k] ** 2 + S['1,1'].im[k] ** 2 + S['2,1'].re[k] ** 2 + S['2,1'].im[k] ** 2;
    if (!approx(a, 1, 1e-12)) lossless = false;
    if (!approx(S['1,2'].re[k], S['2,1'].re[k], 1e-12) || !approx(S['1,2'].im[k], S['2,1'].im[k], 1e-12)) recip = false;
  }
  check('circuit: lossless network -> |S11|^2 + |S21|^2 = 1 at every point', lossless);
  check('circuit: reciprocal network -> S12 = S21', recip);
  // Z_in(f0) == chart endpoint for random chains (norm/abs, z/y, lines, renorm)
  let rnd = 12345; const R = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  let bad = 0, tried = 0;
  for (let t = 0; t < 150; t++) {
    const steps = [st({ kind: 'start', value: (0.2 + 3 * R()).toFixed(3) + (R() < 0.5 ? '-j' : '+j') + (2 * R()).toFixed(3) })];
    const n = 1 + Math.floor(R() * 5);
    for (let i = 0; i < n; i++) {
      const u = R();
      if (u < 0.3) steps.push(st({ kind: 'series', q: R() < 0.5 ? 'z' : 'y', norm: R() < 0.7, value: (R() < 0.3 ? (R() * 0.5).toFixed(2) : '') + (R() < 0.5 ? '-j' : '+j') + (0.1 + R()).toFixed(3) }));
      else if (u < 0.6) steps.push(st({ kind: 'shunt', q: R() < 0.5 ? 'z' : 'y', norm: R() < 0.7, value: (R() < 0.3 ? (R() * 0.5).toFixed(2) : '') + (R() < 0.5 ? '-j' : '+j') + (0.1 + R()).toFixed(3) }));
      else if (u < 0.9) steps.push(st({ kind: 'line', z0line: 20 + 80 * R(), eleDeg: 5 + 170 * R() }));
      else steps.push(st({ kind: 'renorm', z0new: 25 + 75 * R() }));
    }
    const res = SNP.circuitSolve(steps, 50, { f0: 3e9, n: 5 });
    if (!res.ok || !res.f0Check) continue;
    tried++; if (!res.f0Check.ok) bad++;
  }
  check('circuit: Z_in(f0) equals the chart endpoint on random chains', tried > 80 && bad === 0, tried + ' tried, ' + bad + ' bad');
  // load fits reproduce the start point exactly, per topology
  for (const [topo, z] of [['sRC', { re: 30, im: -40 }], ['pRC', { re: 30, im: -40 }], ['sRL', { re: 30, im: 40 }], ['pRL', { re: 30, im: 40 }]]) {
    const ld = SNP.circLoadFromZ(z, 2e9, topo); const zz = SNP.circLoadZ(ld, 2e9);
    check('circuit: ' + topo + ' fit reproduces the start point', !ld.err && approx(zz.re, z.re, 1e-12) && approx(zz.im, z.im, 1e-12));
  }
  check('circuit: a capacitive point refuses series RL', !!SNP.circLoadFromZ({ re: 30, im: -40 }, 2e9, 'sRL').err);
  check('circuit: no start point is refused', !SNP.circuitSolve([st({ kind: 'series', value: 'j1' })], 50, {}).ok);
  // port 2 at a load that absorbs nothing: S21/S22 undefined, S11 defined
  const nr = SNP.circuitSolve([st({ kind: 'start', value: '-j1' }), st({ kind: 'series', value: 'j0.5' })], 50, { f0: 1e9, n: 3 });
  check('circuit: Re Z_L = 0 -> S21 undefined, S11 defined', nr.ok && isNaN(nr.res.S['2,1'].re[1]) && isFinite(nr.res.S['1,1'].re[1]));
  // the network .s2p (both ports at Z0) round-trips bit-exactly through our own parser
  const net = SNP.circuitSparams(r.circuit, r.load, r.z1, r.freqHz, 'z0');
  const txt = SNP.serializeTouchstone({ nPorts: 2, z0: r.z1, freqHz: r.freqHz, S: net.S });
  const back = SNP.parseTouchstone('n.s2p', txt);
  let exact = back.ok;
  for (const key of ['1,1', '2,1', '1,2', '2,2']) for (let k = 0; k < r.freqHz.length; k++)
    if (back.S[key].re[k] !== net.S[key].re[k] || back.S[key].im[k] !== net.S[key].im[k]) exact = false;
  check('circuit: network .s2p round-trips bit-exactly', exact);
  // the as-plotted file (per-frequency port impedances) is REFUSED on import, never mislabelled
  const n = r.freqHz.length;
  const p1 = { re: new Float64Array(n).fill(50), im: new Float64Array(n) };
  const asPlot = SNP.serializeTouchstonePortZ(r.freqHz, r.res.S, [p1, { re: new Float64Array(n).fill(100), im: new Float64Array(n) }], []);
  const ap = SNP.parseTouchstone('a.s2p', asPlot);
  check('parser: per-port impedances that differ are refused', !ap.ok && /renormaliz/i.test(ap.error), ap.error);
  // schematic: well-formed, escaped, inline-styled text
  const model = { name: 'a<b>&"c', f0Hz: 1e9, z1: 50, elements: r.circuit.elements, load: r.load, loadStep: 0, ref2: 'load' };
  const sv = SNP.circuitSchematicSvg(model).svg;
  check('schematic: list name is escaped', sv.includes('a&lt;b&gt;&amp;&quot;c') && !sv.includes('a<b>'));
  check('schematic: text is styled inline (beats a host svg text rule)', /<text [^>]*style="font-size:/.test(sv) && !/<text [^>]*\sfill="/.test(sv));
}

// ---------- 43. parser: "! Port Impedance" lines ----------
{
  const body = (z) => '# GHz S RI R 50\n1 0.1 0 0.9 0 0.9 0 0.1 0\n! Port Impedance ' + z + '\n2 0.1 0 0.9 0 0.9 0 0.1 0\n! Port Impedance ' + z + '\n';
  const ok = SNP.parseTouchstone('x.s2p', body('50 0 50 0'));
  check('parser: AEDT renormalized export (Port Impedance = R) still loads', ok.ok && ok.z0 === 50, ok.error);
  const no = SNP.parseTouchstone('x.s2p', body('48.2 -0.3 50 0'));
  check('parser: a non-renormalized export is refused', !no.ok && /48\.2/.test(no.error), no.error);
  const bad = SNP.parseTouchstone('x.s2p', body('50 0 50'));
  check('parser: an unreadable Port Impedance line is refused', !bad.ok);
  const rn = SNP.parseTouchstone('x.s2p', '# GHz S RI R\n1 0.1 0 0.9 0 0.9 0 0.1 0\n! Port Impedance 75 0 75 0\n');
  check('parser: "R" with no value takes the agreeing Port Impedance', rn.ok && rn.z0 === 75 && rn.warnings.some(w => /no value/.test(w)), rn.error);
  const rw = SNP.parseTouchstone('x.s2p', '# GHz S RI R\n1 0.1 0 0.9 0 0.9 0 0.1 0\n');
  check('parser: "R" with no value and no Port Impedance warns', rw.ok && rw.z0 === 50 && rw.warnings.some(w => /no value/.test(w)));
  // wiring: the button, its handler, the saved settings
  check('wiring: every list header has the circuit button', /data-ccirc="'\+ci\+'"/.test(html));
  check('wiring: the button opens the circuit window', /\[data-ccirc\]'\)\.forEach\(b=>b\.onclick=\(\)=>openCircuitDialog\(\+b\.dataset\.ccirc\)\)/.test(html));
  const kept = SNP.sanSmith({ chains: [{ name: 'a', steps: [], circ: { f0: 2.5e9, fmt: 'smith', ref2: 'z0' } }] }).chains[0].circ;
  check('wiring: the list keeps its circuit settings', kept && kept.f0 === 2.5e9 && kept.fmt === 'smith' && kept.ref2 === 'z0');
  check('wiring: a list that never opened the window carries no settings', !('circ' in SNP.sanSmith({ chains: [{ name: 'a', steps: [] }] }).chains[0]));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? '\n' + failures.join('\n') : ''));
process.exit(fail ? 1 : 0);

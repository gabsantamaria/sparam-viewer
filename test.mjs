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

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? '\n' + failures.join('\n') : ''));
process.exit(fail ? 1 : 0);

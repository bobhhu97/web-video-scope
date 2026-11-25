
import { describe, expect, it } from 'vitest';
import { legalBands, axisToUnit, tickValues, unitSuffix, unitToAxis } from '../src/core/scale/units';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };

describe('axisToUnit', () => {
  it('IRE: legal black is 0 and legal white is 100', () => {
    expect(axisToUnit(16 / 255, 'ire', L8)).toBeCloseTo(0, 6);
    expect(axisToUnit(235 / 255, 'ire', L8)).toBeCloseTo(100, 6);
  });
  it('IRE: full range black/white are 0/100', () => {
    expect(axisToUnit(0, 'ire', F8)).toBeCloseTo(0, 6);
    expect(axisToUnit(1, 'ire', F8)).toBeCloseTo(100, 6);
  });
  it('IRE: signal above legal white reads as super-white', () => {
    expect(axisToUnit(1, 'ire', L8)).toBeCloseTo(109.13, 1);
  });
  it('code8 / code10 are pure relabels of the axis', () => {
    expect(axisToUnit(0.5, 'code8', L8)).toBeCloseTo(127.5, 6);
    expect(axisToUnit(0.5, 'code10', L8)).toBeCloseTo(511.5, 6);
  });
  it('mV is 700mV at legal white', () => {
    expect(axisToUnit(235 / 255, 'mv', L8)).toBeCloseTo(700, 4);
    expect(axisToUnit(16 / 255, 'mv', L8)).toBeCloseTo(0, 4);
  });
  it('nits follows PQ (axis equals the PQ signal)', () => {
    expect(axisToUnit(0, 'nits', L8)).toBeCloseTo(0, 6);
    expect(axisToUnit(1, 'nits', L8)).toBeCloseTo(10000, 1);
    expect(axisToUnit(0.5081, 'nits', L8)).toBeCloseTo(100, 0);
  });
});

describe('unitToAxis', () => {
  it('inverts IRE', () => {
    expect(unitToAxis(50, 'ire', L8)).toBeCloseTo((16 + 0.5 * 219) / 255, 6);
  });
  it('inverts code10', () => {
    expect(unitToAxis(511.5, 'code10', L8)).toBeCloseTo(0.5, 6);
  });
  it('inverts nits', () => {
    expect(unitToAxis(10000, 'nits', L8)).toBeCloseTo(1, 3);
  });
});

describe('tickValues', () => {
  it('IRE ticks 0..100 by 10 land inside the legal band', () => {
    const t = tickValues('ire', L8);
    expect(t.length).toBe(11);
    expect(t[0]).toBeCloseTo(16 / 255, 6);
    expect(t[10]).toBeCloseTo(235 / 255, 6);
  });
  it('IRE ticks for full range span the axis', () => {
    const t = tickValues('ire', F8);
    expect(t[0]).toBeCloseTo(0, 6);
    expect(t[10]).toBeCloseTo(1, 6);
  });
  it('code8 ticks include the legal boundaries', () => {
    const nums = tickValues('code8', L8).map((a) => Math.round(axisToUnit(a, 'code8', L8)));
    expect(nums).toContain(16);
    expect(nums).toContain(235);
  });
  it('nits ticks are ascending and within the axis', () => {
    const t = tickValues('nits', L8);
    expect(t.length).toBeGreaterThan(5);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    expect(t[t.length - 1]!).toBeLessThanOrEqual(1);
  });
});

describe('legalBands', () => {
  it('exposes footroom and headroom as axis bands', () => {
    const b = legalBands(L8);
    expect(b.footroom[0]).toBeCloseTo(0, 6);
    expect(b.footroom[1]).toBeCloseTo(16 / 255, 6);
    expect(b.headroom[0]).toBeCloseTo(235 / 255, 6);
    expect(b.headroom[1]).toBeCloseTo(1, 6);
  });
  it('is empty for full range', () => {
    expect(legalBands(F8).footroom).toEqual([0, 0]);
    expect(legalBands(F8).headroom).toEqual([0, 0]);
  });
});

describe('unitSuffix', () => {
  it('names each unit', () => {
    expect(unitSuffix('ire')).toBe('IRE');
    expect(unitSuffix('mv')).toBe('mV');
    expect(unitSuffix('nits')).toBe('nits');
  });
});

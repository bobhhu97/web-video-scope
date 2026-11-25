import { describe, expect, it } from 'vitest';
import { describeSample, formatSample } from '../src/ui/probe';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };

describe('describeSample', () => {
  it('mid-grey stays neutral and lands mid-axis in full range', () => {
    const s = describeSample([128, 128, 128], 0, 0, 'bt709', F8);
    expect(s.cb).toBeCloseTo(0, 6);
    expect(s.cr).toBeCloseTo(0, 6);
    expect(s.luma).toBeCloseTo(128 / 255, 3);
    expect(s.axisY).toBeCloseTo(128 / 255, 3);
    expect(s.axisCb).toBeCloseTo(0.5, 6);
  });

  it('limited range pushes legal black up the axis, not to zero', () => {
    const s = describeSample([0, 0, 0], 0, 0, 'bt709', L8);
    expect(s.code[0]).toBeCloseTo(16, 6);
    expect(s.axisY).toBeCloseTo(16 / 255, 6);
  });

  it('white maps to legal white in limited range', () => {
    const s = describeSample([255, 255, 255], 0, 0, 'bt709', L8);
    expect(s.code[0]).toBeCloseTo(235, 6);
    expect(s.axisY).toBeCloseTo(235 / 255, 6);
  });

  it('red is chroma-positive in Cr and negative in Cb', () => {
    const s = describeSample([255, 0, 0], 0, 0, 'bt709', F8);
    expect(s.cr).toBeGreaterThan(0);
    expect(s.cb).toBeLessThan(0);
  });

  it('reports the source coordinates', () => {
    const s = describeSample([10, 20, 30], 1234, 567, 'bt709', F8);
    expect(s.x).toBe(1234);
    expect(s.y).toBe(567);
  });
});

describe('formatSample', () => {
  it('includes the unit, code values and coordinates', () => {
    const s = describeSample([255, 255, 255], 5, 6, 'bt709', L8);
    const text = formatSample(s, 'ire', L8);
    expect(text).toContain('Y 100 IRE');
    expect(text).toContain('code 235,235,235');
    expect(text).toContain('(5,6)');
  });

  it('switching unit changes the label but not the code values', () => {
    const s = describeSample([255, 255, 255], 0, 0, 'bt709', L8);
    expect(formatSample(s, 'ire', L8)).toContain('code 235');
    expect(formatSample(s, 'code8', L8)).toContain('code 235');
  });
});

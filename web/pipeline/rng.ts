/**
 * Deterministic PRNG for reproducible synthetic data generation.
 *
 * Node has no seedable random built in (unlike numpy's default_rng(seed)).
 * mulberry32 is a small, fast, well-distributed PRNG suitable for this use —
 * exact numeric parity with the Python version's numpy output isn't the
 * goal (different algorithms), just internal determinism and a similar
 * qualitative noise character.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }

  /** Standard normal via Box-Muller, scaled to N(mean, std). */
  normal(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * std;
  }

  /**
   * Exponential(scale): mean-`scale`, heavily right-skewed toward zero.
   * Stands in for the Python version's rng.gamma(shape=0.3, scale=2.0) —
   * shape<1 gamma sampling needs a rejection-method implementation for
   * little qualitative benefit here; both distributions produce "mostly
   * near-zero with occasional larger bursts," which is what the baseline
   * rainfall noise model actually needs.
   */
  exponential(scale = 1): number {
    return -Math.log(1 - this.next()) * scale;
  }
}

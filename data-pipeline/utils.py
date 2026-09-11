"""Shared helpers for the synthetic sensor-data generators."""

from math import radians, sin, cos, asin, sqrt

import numpy as np
import pandas as pd


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(a))


def time_grid(start, end, step_minutes):
    return pd.date_range(start=start, end=end, freq=f"{step_minutes}min")


def ar1_series(n, mean, phi, sigma, rng, x0=None):
    """Slowly-varying mean-reverting noise, used for things like soil moisture."""
    x = np.empty(n)
    x[0] = mean if x0 is None else x0
    for i in range(1, n):
        x[i] = mean + phi * (x[i - 1] - mean) + rng.normal(0, sigma)
    return x


def gaussian_bump(t_seconds, center_seconds, width_seconds, peak):
    return peak * np.exp(-0.5 * ((t_seconds - center_seconds) / width_seconds) ** 2)


def rise_and_recede(t_hours, onset_hours, rise_hours, peak, decay_tau_hours):
    """Fast rise to `peak` starting at onset_hours, then exponential recession.

    Used for river/lake water-level surges: sharp hydrograph rise, slow decay.
    """
    out = np.zeros_like(t_hours, dtype=float)
    dt = t_hours - onset_hours
    rising = (dt >= 0) & (dt < rise_hours)
    receding = dt >= rise_hours
    out[rising] = peak * (dt[rising] / rise_hours)
    out[receding] = peak * np.exp(-(dt[receding] - rise_hours) / decay_tau_hours)
    return out


def damped_sine_burst(n_samples, sample_rate_hz, amplitude, freq_hz, decay_per_s, rng, noise=0.03):
    """A short seismic-wavelet-like burst: oscillation under an exponential envelope."""
    t = np.arange(n_samples) / sample_rate_hz
    envelope = amplitude * np.exp(-decay_per_s * t)
    wave = envelope * np.sin(2 * np.pi * freq_hz * t + rng.uniform(0, 2 * np.pi))
    wave += rng.normal(0, noise * max(amplitude, 1e-6), n_samples)
    return np.abs(wave)


def resample_uniform(df, timestamp_col, value_cols, agg_map, start, end, step_minutes):
    """Resample an irregular/mixed-resolution series onto a uniform grid for UI playback."""
    idx = time_grid(start, end, step_minutes)
    indexed = df.set_index(timestamp_col)
    out = {"timestamp": idx}
    for col in value_cols:
        agg = agg_map.get(col, "max")
        s = indexed[col].resample(f"{step_minutes}min").agg(agg)
        out[col] = s.reindex(idx).ffill().values
    return pd.DataFrame(out)

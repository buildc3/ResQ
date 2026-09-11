import numpy as np


def sigmoid(x, k=1.0):
    return 1.0 / (1.0 + np.exp(-k * x))


def rolling_z(series, window, min_periods, shift=1, min_std=None):
    """Z-score of each point against its own trailing baseline (no look-ahead).

    min_std floors the denominator to a sensor-appropriate noise level, so a
    quiet/low-variance baseline (e.g. a dry spell with near-zero rainfall
    variance) doesn't make a merely-moderate reading look like an extreme
    anomaly just because nothing happened for a while beforehand.
    """
    baseline = series.shift(shift)
    mean = baseline.rolling(window, min_periods=min_periods).mean()
    std = baseline.rolling(window, min_periods=min_periods).std().replace(0, np.nan)
    if min_std is not None:
        std = std.clip(lower=min_std)
    z = (series - mean) / std
    return z.fillna(0.0)

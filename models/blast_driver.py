"""LODESTONE driver for NLR BLAST-Lite (battery degradation / lifetime).

Contract with adapters/python.mjs:
    stdin  <- JSON parameters
    stdout -> exactly one JSON object as the final line

Why this matters for the workspace: recycling feedstock volumes depend on when
batteries actually retire. BLAST-Lite gives a physics-based answer per chemistry
rather than the flat assumption behind card F-5, and lets the LFP-vs-NMC
retirement difference be quantified instead of asserted.
"""
import json
import os
import sys

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "BLAST-Lite")
sys.path.insert(0, REPO)

import numpy as np  # noqa: E402


def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(0)


def main():
    try:
        p = json.load(sys.stdin)
    except Exception as e:
        fail(f"Could not parse parameters as JSON: {e}")

    try:
        from blast import models
    except Exception as e:
        fail(
            "BLAST-Lite could not be imported. Recreate the environment with: "
            "cd lodestone/models && python3 -m venv --system-site-packages blast-venv "
            f"&& ./blast-venv/bin/pip install h5pyd geopy   (import error: {e})"
        )

    available = list(models.available_models())
    name = str(p.get("cellModel", "Nmc622_Gr_DENSO50Ah_Battery")).strip()
    if name not in available:
        fail(f"Unknown cell model '{name}'. Available: {', '.join(available)}")

    try:
        years = float(p.get("years", 15))
        temperature_c = float(p.get("temperatureC", 25))
        soc_min = float(p.get("socMin", 0.2))
        soc_max = float(p.get("socMax", 0.9))
        cycles_per_day = float(p.get("cyclesPerDay", 1))
        eol = float(p.get("eolCapacity", 0.8))
    except (TypeError, ValueError) as e:
        fail(f"Numeric parameter could not be read: {e}")

    if not (0 <= soc_min < soc_max <= 1):
        fail(f"SOC window must satisfy 0 <= socMin < socMax <= 1 (got {soc_min}, {soc_max}).")
    if cycles_per_day <= 0 or years <= 0:
        fail("cyclesPerDay and years must both be greater than zero.")

    # One representative year at hourly resolution: a triangular charge/discharge
    # cycle repeated `cycles_per_day` times a day, at constant temperature. The
    # package then repeats this year until a stopping threshold is reached.
    hours = 365 * 24
    t_s = np.arange(hours, dtype=float) * 3600.0
    period_h = 24.0 / cycles_per_day
    phase = np.mod(np.arange(hours, dtype=float), period_h) / period_h
    tri = 1.0 - np.abs(2.0 * phase - 1.0)          # 0 -> 1 -> 0
    soc = soc_min + (soc_max - soc_min) * tri
    temp = np.full(hours, temperature_c, dtype=float)

    cell = getattr(models, name)()
    try:
        cell.simulate_battery_life(
            {"Time_s": t_s, "SOC": soc, "Temperature_C": temp},
            threshold_time=years,
        )
    except Exception as e:
        fail(f"Simulation failed: {type(e).__name__}: {e}")

    q = np.asarray(cell.outputs["q"], dtype=float)          # relative capacity
    t_days = np.asarray(cell.stressors["t_days"], dtype=float)
    efc = np.asarray(cell.stressors["efc"], dtype=float)
    yrs = t_days / 365.25

    # Years until capacity first crosses the end-of-life threshold.
    below = np.nonzero(q <= eol)[0]
    if below.size:
        i = below[0]
        if i > 0:                                            # linear interpolation
            y0, y1, q0, q1 = yrs[i - 1], yrs[i], q[i - 1], q[i]
            eol_years = y0 + (q0 - eol) * (y1 - y0) / (q0 - q1) if q0 != q1 else y1
        else:
            eol_years = yrs[i]
        eol_str = f"{eol_years:.2f}"
        reached = True
    else:
        eol_str = f"not reached within {yrs[-1]:.1f} y"
        reached = False

    rows = [
        {"Output": "Cell model", "Value": name},
        {"Output": f"Years to {eol*100:.0f}% capacity", "Value": eol_str},
        {"Output": "Capacity remaining at end of simulation (%)", "Value": f"{q[-1]*100:.2f}"},
        {"Output": "Simulated duration (years)", "Value": f"{yrs[-1]:.2f}"},
        {"Output": "Equivalent full cycles accumulated", "Value": f"{efc[-1]:.1f}"},
        {"Output": "Cycles per day", "Value": f"{cycles_per_day:g}"},
        {"Output": "SOC window", "Value": f"{soc_min:.2f}–{soc_max:.2f}"},
        {"Output": "Temperature (deg C)", "Value": f"{temperature_c:g}"},
    ]
    summary = (
        f"{name} cycled {cycles_per_day:g}x/day over a {soc_min:.2f}-{soc_max:.2f} SOC window at "
        f"{temperature_c:g} C reaches {eol*100:.0f}% capacity after "
        + (f"{eol_str} years" if reached else f"more than {yrs[-1]:.1f} years")
        + f"; {q[-1]*100:.1f}% capacity and {efc[-1]:.0f} equivalent full cycles at end of simulation."
    )

    print(json.dumps({
        "columns": ["Output", "Value"],
        "rows": rows,
        "summary": summary,
        "extraction": "exact",
        "endpoint": f"BLAST-Lite {name} (NLR, local Python)",
    }))


if __name__ == "__main__":
    main()

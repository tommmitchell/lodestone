# Local model workbooks

**Nothing in this directory is committed except this README and the driver
scripts.** The models below are third-party and either not ours to redistribute
or machine-specific. Obtain each from its publisher, save it here under the
filename in `../model-bindings.mjs`, and correct the input/output cell
references to match your copy.

| Model | Where | How it is gated |
|---|---|---|
| EverBatt | https://www.anl.gov/amd/everbatt | Register & Download form |
| BatPaC (v5.1; manual documents v5.0) | https://www.anl.gov/cse/electrochemical-chemical-TEA | No public download — email request to `ahmeds@anl.gov`. The free version assumes stiff pouch cells; BatPaC-Cylindrical is collaboration-only |
| R&D GREET | https://greet.anl.gov/ | Email-registration form before download. Ships as Excel, so the existing `xlsx` adapter applies |
| LIBRA | NREL | Stella Architect runtime required; no scriptable headless interface |

## Use a macro-free .xlsx copy

Argonne ships these as `.xlsm`. Excel's macro-security prompt is deliberately
outside programmatic control — `display alerts false` does NOT suppress it — so
an `.xlsm` will interrupt every automated run with a dialog.

Fix: open the workbook once and **File -> Save As -> Excel Workbook (.xlsx)**
into this folder, then point the binding at the `.xlsx`. A `.xlsx` cannot carry
macros, so the prompt can never fire.

Safe for EverBatt: its outputs are spreadsheet formulas, not macros. The
macro-free copy was verified to reproduce the macro-enabled original exactly
(collection cost, and pyro/hydro energy, identical to 9 dp).

Alternative permanent fix, if you prefer keeping .xlsm:
Excel -> Preferences -> Security & Privacy -> Macro Security ->
"Disable all macros without notification". (Excel's default already disables
macros; the default merely *asks* whether to re-enable, so this is the more
restrictive option, not a weaker one.)

## Note
The adapter closes workbooks without saving. Close a workbook in Excel before
running it from LODESTONE, or unsaved edits will be discarded.

## BLAST-Lite (open source — no registration)

NREL's battery degradation model. It is **not** committed to this repository —
it is NREL's own BSD-3-licensed project with its own LICENSE and NOTICE, so
vendoring it here would republish their code under ours. Clone it yourself:

    cd lodestone/models
    git clone --depth 1 https://github.com/NREL/BLAST-Lite.git

It is then driven by `blast_driver.py` through the generic `python` adapter.

Its `__init__` chain imports `h5pyd`/`geopy` (NREL cloud climate data) even when
unused, so it runs from an isolated venv rather than your main Python env:

    cd lodestone/models
    python3 -m venv --system-site-packages blast-venv
    ./blast-venv/bin/pip install h5pyd geopy

`--system-site-packages` reuses the numpy/pandas/scipy you already have.
The MATLAB port was removed (132 MB -> 25 MB); the Python package is what we drive.

### Writing a driver for another Python model
The `python` adapter is generic — the contract is just:

    stdin  <- JSON parameters
    stdout -> exactly one JSON object: {columns, rows, summary, extraction, endpoint}

Validate inputs in the driver and print `{"error": "..."}` to refuse a run;
that message is shown to the user verbatim.

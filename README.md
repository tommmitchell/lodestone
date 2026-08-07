# LODESTONE — local deployment with live assistant

The LODESTONE evidence workbench (P1 prototype) plus the **live LLM assistant** the
published-artifact version cannot run: grounded Q&A, card proposals, and red-team
mode (spec FR-A1 / FR-A3 / FR-A5), implemented with **Claude Sonnet 5**
(`claude-sonnet-5`, default for Q&A) and **Claude Opus 5** (`claude-opus-5`,
default for red-team). A model picker in the Analyst view overrides the default
per request.

## Run it

```sh
cd lodestone
npm install                     # first time only
cp .env.example .env            # then put your API key in .env
npm start                       # → http://localhost:8787
```

Open http://localhost:8787 and go to **Analyst tools**. Without a key the UI
still works fully; assistant calls return a clear credentials error.

### Configuration (.env)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MY_ANTHROPIC_KEY` | yes | — | API key from platform.claude.com → Settings → API keys |
| `LODESTONE_DAILY_LIMIT_USD` | no | `2` | Hard cap on assistant spend per calendar day (UTC). Calls are refused at the cap. |
| `COMTRADE_API_KEY` | no | — | UN Comtrade subscription key (free tier). Enables the Comtrade model runner. |
| `PORT` | no | `8787` | Server port |

A real environment variable (e.g. `export MY_ANTHROPIC_KEY=...` in your shell)
takes precedence over `.env`. `.env` and the spend ledger (`.spend.json`) are
gitignored.

### Cost bounding

Every reply shows an estimated cost and the running daily total (standard
rates: Sonnet 5 $3/$15 per MTok, Opus 5 $5/$25; cache reads ~0.1×, cache
writes ~1.25× input rate). Spend is tracked in `.spend.json` and calls are
blocked once the daily cap is reached — the error message says how to raise it.
For belt-and-braces, also set a monthly spend limit on the account itself at
platform.claude.com → Billing → Spend limits.

## How the assistant works

- The browser sends the current workspace (cards, sources, model runs, decision
  criteria) plus your question to the local server; **your API key stays on the
  server** and never reaches the page.
- The server calls the Claude API with a structured-output JSON schema, so every
  reply is a machine-readable object: `answer` (with inline citations to card
  IDs like `[F-1]` and source IDs like `(s5)`), `evidence_gaps`, and 0–4
  `proposals`.
- Proposed cards appear with **Accept / Edit / Reject** buttons — nothing enters
  the evidence board without your action (the spec's human-in-the-loop
  principle). Accepted cards are marked `origin: assistant-proposed`.
- Citations in proposals are validated against the workspace; references to
  nonexistent sources are dropped client-side.
- The stable system prompt is cached (`cache_control: ephemeral`), so repeated
  questions reuse the cached prefix; the token meter under each reply shows
  input/output/cached counts.

## Notes

- Workspace data lives in the **browser's localStorage** (per origin — the
  localhost app and the published artifact have separate stores; move data
  between them with Settings → Export/Import JSON).
- Refusals (`stop_reason: "refusal"`) are surfaced as a plain message, not an
  error.
- Rough cost: a Q&A turn against the seeded workspace is ~6–10K input tokens
  (mostly cached after the first call) and ≤8K output. Sonnet 5: $3/M in,
  $15/M out; Opus 5: $5/M in, $25/M out.
- `PORT=xxxx npm start` to change the port.

## Which models LODESTONE can actually run

Of the 12 registered models, only those with a callable, documented interface
can be executed by the app. The **Models & runs** view shows one card per model
with an honest badge:

**9 of the 12 registered models are runnable in-app.**

| Badge | Meaning | Models |
|---|---|---|
| ▶ **LODESTONE can run this** | One click, no credential | IEA Critical Minerals (m7), IEA Global EV (m8), USGS Mineral Commodity Summaries (m9), USAspending (m10), FAST-41 Permitting Dashboard (m12) |
| ▶ **Runs, with local setup** | Runnable once a prerequisite is in place | IRA Mineral Price Simulator (m1, needs Chrome), EverBatt (m2, needs your workbook + Excel), BLAST-Lite (m5, needs the venv), UN Comtrade (m11, needs `COMTRADE_API_KEY`) |
| **Manual capture** | No callable interface. You run it; LODESTONE records parameters, outputs and provenance | BatPaC (m3) and GREET (m6) — both gated behind an email request or registration form; LIBRA (m4) — Stella has no scriptable runtime |

Capability is verified empirically rather than assumed, and the app probes
`/api/capabilities` at start-up so a badge reflects what is actually available
on *this* machine. Some findings were surprising: the IEA data explorers call a
completely open JSON API (`api.iea.org`) — the sign-in prompts on iea.org govern
report PDFs, not the data; the FAST-41 dashboard publishes a Socrata endpoint
linked only as the word "HERE"; and USGS has no query API at all, so the runner
discovers the newest annual ScienceBase data release, downloads its commodity
CSV once per session and queries it in memory.

### Empty results are explained, never left bare

Several of these APIs answer a bad request with `HTTP 200` and an empty array,
which reads exactly like a real "no data" answer. Each runner therefore
diagnoses its own empty results:

* **Comtrade** — HS 854810 was abolished in the HS2022 revision (battery scrap
  moved to heading 8549), so a pre-2022 code silently returns nothing for a
  recent year. The runner says so, and flags that the chemistry-sorted lines
  854913/854914 are barely populated.
* **IEA** — distinguishes a value that is not in the vocabulary at all (naming
  the term and listing valid values) from a set of individually valid values
  whose *combination* is simply not published. Telling an analyst to check their
  spelling when nothing is misspelled sends them hunting for a mistake that
  isn't there.
* **USGS** — offers a near-match for a misspelled commodity, and otherwise
  reports which filter did the excluding. Its `Value` column carries survey
  codes (`W` withheld, `NA`, `E` estimated, `-` zero) which are passed through
  verbatim with a legend: a withheld figure is **not** a zero and must never be
  summed as one.

Runs executed in-app are recorded with `runner: "LODESTONE (automatic)"`, the
exact endpoint, and the elapsed time, then can be promoted to library sources
and cited from cards like any other evidence.

**In the published artifact these badges read "Runs only in the local
deployment"** — the page probes `/api/capabilities` at start-up and reports what
is actually available rather than what is theoretically possible.

## Running web models and spreadsheets (general adapters)

Two generic adapters let LODESTONE drive models it has no bespoke code for.
**Adding a model is a data change, not a code change:** add an entry to
`model-bindings.mjs` describing where its inputs and outputs are. The run form
in the UI is generated from that binding, so no client change is needed either.

### `adapter: "browser"` — any interactive web app
Drives the page in headless **system Chrome** (via `puppeteer-core`, so there is
no 300 MB browser download). Sets inputs through `Shiny.setInputValue` or plain
DOM events, waits until the outputs stop changing, and captures them.

```js
m1: {
  adapter: "browser", url: "https://…", framework: "shiny",
  inputs:  { mineralCreditPct: { id: "CM_slider", kind: "number" } },
  outputs: [{ id: "comparePlot_LFP", label: "LFP cost & incentives", type: "image" }],
}
```

Two things learned from the IRA simulator and baked into the adapter: Shiny
keeps **hidden-tab outputs permanently marked `recalculating`**, so the settle
check is scoped to the outputs the binding requests rather than the whole page
(a global check waits out the timeout every time); and `setInputValue` updates
the server but **not** the visible widget, so the recorded parameter set — not
the DOM — is the authoritative record of what was run.

### `adapter: "xlsx"` — any workbook
Writes inputs, recalculates, reads outputs.

* **With Microsoft Excel (macOS):** driven via AppleScript, so formulas and
  macros behave exactly as the model author intended. Every written cell is
  **read back and compared**; if a write did not land, the run is **refused**
  rather than returning numbers that would be labelled exact but be wrong.
  First use raises a macOS automation-permission prompt.
* **Without Excel:** SheetJS reads cached values only, and changing an input is
  refused rather than silently returning a stale number.

Registration-walled workbooks (EverBatt, BatPaC) are not redistributable — save
your copy under `models/` and correct the cell references in the binding.

### Provenance: `extraction`
Every run records how trustworthy its numbers are, and the UI shows a matching
banner:

| `extraction` | Meaning |
|---|---|
| `exact`    | Recalculated by the model's own engine — citable as model output |
| `cached`   | Read from a workbook without recalculation |
| `artifact` | **Charts only.** The tool has no data export, so any figure read off the plot is an *estimate* — record it at *probable* confidence at best, never *established* |

That last row is why the LLM is deliberately kept out of the execution path:
Opus 5 translates a question into parameters and interprets the resulting
chart, but it never "runs" the model, because a language model asked to run a
simulator will produce fluent, plausible, fabricated numbers.

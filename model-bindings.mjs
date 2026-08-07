// MODEL BINDINGS — the only file you edit to make a new model runnable.
//
// Each entry is data, not code: it names an adapter and describes where the
// inputs and outputs live. The adapters (adapters/*.mjs) are generic and are
// reused across every model of that kind.
//
//   adapter: "http"     hand-written fetch (public JSON APIs)
//   adapter: "browser"  any interactive web app  (adapters/browser.mjs)
//   adapter: "xlsx"     any workbook             (adapters/xlsx.mjs)
//
// `params` is the shared parameter spec: the UI renders its form from this, so
// a new model needs no client-side change either.

export const BINDINGS = {
  /* ------------------------------------------------------------------ *
   * m1 — IRA Mineral Price Effects Simulator (Shiny, Cheng et al.,
   * Nature Energy 2024). Input IDs were read off the live app; the
   * outputs are ggplot images, so this run yields charts, not numbers.
   * ------------------------------------------------------------------ */
  m1: {
    adapter: "browser",
    label: "IRA Mineral Price Effects Simulator",
    url: "https://acheng98.shinyapps.io/IRAMineralPriceEffectsSim/",
    framework: "shiny",
    readySelector: ".shiny-plot-output img",
    settleMs: 1800,
    timeoutMs: 90000,
    note:
      "Charts only — this tool has no data download, so figures read from the plots are estimates, never exact model output.",
    inputs: {
      scenario:          { id: "USScen",           kind: "select" },
      credit45X_mineral: { id: "45XCM",            kind: "checkbox" },
      credit45X_eam:     { id: "45XEAM",           kind: "checkbox" },
      credit45X_cell:    { id: "45XCell",          kind: "checkbox" },
      credit45X_module:  { id: "45XMod",           kind: "checkbox" },
      credit30D_mineral: { id: "30DCrit",          kind: "checkbox" },
      credit30D_comp:    { id: "30DComp",          kind: "checkbox" },
      credit45W_lease:   { id: "45WLease",         kind: "checkbox" },
      mineralCreditPct:  { id: "CM_slider",        kind: "number" },
      eamCreditPct:      { id: "EAM_slider",       kind: "number" },
      incrementalPrice:  { id: "incrementalPrice", kind: "number" },
      chinaMaterialPct:  { id: "materialPct",      kind: "number" },
      chinaLaborPct:     { id: "laborPct",         kind: "number" },
      lithiumPrice:      { id: "lithiumPrice",     kind: "number" },
      cobaltPrice:       { id: "cobaltPrice",      kind: "number" },
      nickelPrice:       { id: "nickelPrice",      kind: "number" },
      showLFP:           { id: "lfpGraph",         kind: "checkbox" },
      showNMC:           { id: "nmcGraph",         kind: "checkbox" },
      showNCA:           { id: "ncaGraph",         kind: "checkbox" },
    },
    outputs: [
      { id: "comparePlot_LFP", label: "LFP — cost of production and incentives, per kWh", type: "image" },
      { id: "comparePlot_NCA", label: "NCA — cost of production and incentives, per kWh", type: "image" },
    ],
    params: [
      { name: "credit45X_mineral", label: "45X critical-mineral processing credit (true/false)", value: "false" },
      { name: "credit45X_eam",     label: "45X electroactive-materials credit (true/false)",     value: "true" },
      { name: "credit45X_cell",    label: "45X battery-cell credit (true/false)",                value: "true" },
      { name: "credit45X_module",  label: "45X battery-module credit (true/false)",              value: "true" },
      { name: "credit30D_mineral", label: "30D critical-minerals purchase credit (true/false)",  value: "false" },
      { name: "credit30D_comp",    label: "30D battery-component purchase credit (true/false)",  value: "false" },
      { name: "mineralCreditPct",  label: "Mineral processing credit (% of production cost)",    value: "10" },
      { name: "lithiumPrice",      label: "Lithium price (USD/kg)",                              value: "26.78" },
      { name: "showLFP",           label: "Show LFP chart (true/false)",                         value: "true" },
      { name: "showNCA",           label: "Show NCA chart (true/false)",                         value: "true" },
    ],
  },

  /* ------------------------------------------------------------------ *
   * m2 — EverBatt (Argonne, Excel). Registration-walled, so the user
   * supplies the workbook. Cell references below are PLACEHOLDERS: open
   * your copy, find the real input/output cells, and correct them here.
   * ------------------------------------------------------------------ */
  /* Cell references below were read from the workbook itself, not guessed:
     - EverBatt uses a Selected / Default / User-defined column pattern where
       column E is a FORMULA (=IF(ISNUMBER(G8),G8,F8)); the writable cell is G.
     - Dropdown values must match the workbook's own named ranges exactly
       (Chemistry, Locations, Select_Battery, Select_Type on the Input sheet).
     - Output row 36 labels the process columns: J = Pyro, K = Hydro. Row 37 is
       cost per kg of feedstock, which is the figure comparable to card F-4.  */
  m2: {
    adapter: "xlsx",
    label: "EverBatt",
    file: "models/EverBatt.xlsx",
    note:
      "Argonne's closed-loop recycling techno-economics model. Recalculated in Excel, so the figures are exact model output rather than estimates. Uses a macro-free .xlsx copy: Excel's macro-security prompt cannot be suppressed programmatically, and the results are formula-driven — verified identical to the original .xlsm to 9 decimal places.",
    inputs: {
      feedstockChemistry: { sheet: "Input", cell: "C28" },  // Chemistry list
      feedstockType:      { sheet: "Input", cell: "D28" },  // Select_Type list
      feedstockTonnage:   { sheet: "Input", cell: "F28" },  // tonne/yr
      batteryRecycled:    { sheet: "Input", cell: "E15" },  // Select_Battery
      recyclingLocation:  { sheet: "Input", cell: "E33" },  // Locations
    },
    // Verified against the live workbook: row 37 col C is the collection cost;
    // the pyro/hydro energy results are rows 39-42 in columns J and K
    // (row 36 labels them). J37/K37 — the pyro/hydro COST cells — stay blank
    // until further plant-level inputs are supplied, so they are not read here
    // rather than reported as zero.
    outputs: [
      { label: "Collection & transport cost ($/kg feedstock)",            sheet: "Output", cell: "C37" },
      { label: "Total energy — pyrometallurgical (MJ/kg feedstock)",      sheet: "Output", cell: "J39" },
      { label: "Total energy — hydrometallurgical (MJ/kg feedstock)",     sheet: "Output", cell: "K39" },
      { label: "Fossil fuels — pyrometallurgical (MJ/kg)",                sheet: "Output", cell: "J40" },
      { label: "Fossil fuels — hydrometallurgical (MJ/kg)",               sheet: "Output", cell: "K40" },
      { label: "Collection & transport energy (MJ/kg)",                   sheet: "Output", cell: "C39" },
    ],
    params: [
      { name: "feedstockChemistry", label: "Feedstock chemistry — LCO | NMC(111) | NMC(532) | NMC(622) | NMC(811) | NCA | LMO | LFP", value: "NMC(622)" },
      { name: "feedstockType",      label: "Feedstock type — End-of-life battery: pack | … : module | … : cell | Manufacturing scrap: rejected cells | Manufacturing scrap: electrode | Black mass", value: "End-of-life battery: pack" },
      { name: "feedstockTonnage",   label: "Feedstock tonnage (tonne/yr)", value: "10000" },
      { name: "batteryRecycled",    label: "Battery collected & recycled — Cell | Pack", value: "Pack" },
      { name: "recyclingLocation",  label: "Location — U.S. | California | Korea | China", value: "U.S." },
    ],
  },

  /* ------------------------------------------------------------------ *
   * m5 — BLAST-Lite (NLR, Python, open source). Freely downloadable, so
   * LODESTONE ships the driver and fetches nothing at run time. Answers
   * when batteries actually retire, per chemistry — the feedstock timing
   * that card F-5's recycled-content ceiling rests on.
   * ------------------------------------------------------------------ */
  m5: {
    adapter: "python",
    label: "BLAST-Lite",
    script: "models/blast_driver.py",
    python: "models/blast-venv/bin/python",
    cwd: "models",
    timeoutMs: 600000,
    note:
      "Open-source NLR degradation model, run locally. Physics-based retirement timing by chemistry — exact model output, not an estimate.",
    inputs: {},   // the driver validates its own parameters
    outputs: [],  // output shape is defined by the driver
    params: [
      { name: "cellModel",     label: "Cell model — Lfp_Gr_250AhPrismatic | Nmc622_Gr_DENSO50Ah_Battery | Nmc811_GrSi_LGM50_5Ah_Battery | Nca_Gr_Panasonic3Ah_Battery | Lmo_Gr_NissanLeaf66Ah_2ndLife_Battery", value: "Nmc622_Gr_DENSO50Ah_Battery" },
      { name: "years",         label: "Simulate up to (years)",               value: "15" },
      { name: "temperatureC",  label: "Ambient temperature (deg C)",          value: "25" },
      { name: "socMin",        label: "Minimum state of charge (0-1)",        value: "0.2" },
      { name: "socMax",        label: "Maximum state of charge (0-1)",        value: "0.9" },
      { name: "cyclesPerDay",  label: "Cycles per day",                       value: "1" },
      { name: "eolCapacity",   label: "End-of-life capacity threshold (0-1)", value: "0.8" },
    ],
  },
};

export function bindingFor(id) { return BINDINGS[id] || null; }

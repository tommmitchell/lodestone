// Generic spreadsheet adapter (spec Tier 3: locally executed models).
//
// Drives ANY workbook from a declarative binding — EverBatt, BatPaC, the Dunn
// supplementary tables, anything with stable input/output cells.
//
// Binding shape:
//   {
//     adapter: "xlsx",
//     file:    "models/EverBatt.xlsx",         // relative to the lodestone dir
//     inputs:  { paramName: {sheet, cell} },
//     outputs: [ {label, sheet, cell} | {label, sheet, range:"A1:D20"} ],
//   }
//
// Two execution modes, detected at runtime:
//
//   "recalc"    Microsoft Excel drives the real calculation engine via
//               AppleScript: write inputs → recalculate → read outputs →
//               close without saving. Values are EXACT, formulas and macros
//               behave as the model author intended. macOS + Excel only, and
//               the first run raises a macOS automation-permission prompt.
//
//   "read-only" SheetJS parses the workbook and returns the values CACHED in
//               the file. No recalculation, so writing inputs is refused
//               rather than silently returning stale numbers.
//
// Unlike the browser adapter this yields real numbers, so extraction is
// "exact" in recalc mode.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as XLSX from "xlsx";

const execFileP = promisify(execFile);

export function excelAvailable() {
  return process.platform === "darwin" && fs.existsSync("/Applications/Microsoft Excel.app");
}
export function workbookPath(baseDir, binding) {
  if (!binding.file) return null;
  return path.isAbsolute(binding.file) ? binding.file : path.join(baseDir, binding.file);
}
export function workbookPresent(baseDir, binding) {
  const p = workbookPath(baseDir, binding);
  return !!p && fs.existsSync(p);
}
export function xlsxMode(baseDir, binding) {
  if (!workbookPresent(baseDir, binding)) return "missing-file";
  return excelAvailable() ? "recalc" : "read-only";
}

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/* ---------- Mode 1: real recalculation through Microsoft Excel ---------- */
async function runViaExcel(file, binding, params) {
  const writes = [];
  for (const [name, spec] of Object.entries(binding.inputs || {})) {
    if (!(name in params)) continue;
    const raw = params[name];
    const num = Number(raw);
    const value = raw !== "" && !Number.isNaN(num) ? String(num) : `"${esc(raw)}"`;
    writes.push(`set value of cell "${esc(spec.cell)}" of worksheet "${esc(spec.sheet)}" of wb to ${value}`);
  }
  // Read each target into a text list. `value of cell` can come back as a
  // nested list, so unwrap before coercing — coercing the list directly
  // concatenates its items into a meaningless number.
  const reads = (binding.outputs || []).map((o) => {
    const ref = o.range
      ? `range "${esc(o.range)}" of worksheet "${esc(o.sheet)}" of wb`
      : `cell "${esc(o.cell)}" of worksheet "${esc(o.sheet)}" of wb`;
    return `
  set v to value of ${ref}
  repeat while (class of v is list)
    if (count of v) is 0 then
      set v to ""
    else
      set v to item 1 of v
    end if
  end repeat
  set end of out to (v as text)`;
  });

  // Read the input cells back after writing them. If a write did not land —
  // wrong sheet name, protected cell, a modal Excel dialog, a workbook that
  // opened read-only — the run is REFUSED rather than returning numbers that
  // would be labelled "exact model output". Silent wrongness is the one
  // outcome a provenance tool must never produce.
  const verifyRefs = Object.entries(binding.inputs || {})
    .filter(([name]) => name in params)
    .map(([name, spec]) => ({ name, ref: `cell "${esc(spec.cell)}" of worksheet "${esc(spec.sheet)}" of wb` }));
  const verifies = verifyRefs.map((v) => `
  set vv to value of ${v.ref}
  repeat while (class of vv is list)
    if (count of vv) is 0 then
      set vv to ""
    else
      set vv to item 1 of vv
    end if
  end repeat
  set end of chk to (vv as text)`);

  const script = `
set out to {}
set chk to {}
tell application "Microsoft Excel"
  activate
  set display alerts to false
  open POSIX file "${esc(file)}"
  set wb to active workbook
  ${writes.join("\n  ")}
  calculate
  delay 0.3
  ${verifies.join("\n")}
  ${reads.join("\n")}
  close wb saving no
  set display alerts to true
end tell
set AppleScript's text item delimiters to "\\n===\\n"
return ((chk as string) & "\\n@@@\\n" & (out as string))
`;
  // Excel is deliberately left running between calls: quitting it made the
  // next run race against a cold relaunch.
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const [chkBlock = "", outBlock = ""] = stdout.split("\n@@@\n");
  const readback = chkBlock.split("\n===\n").map((v) => v.trim());

  const mismatches = [];
  verifyRefs.forEach((v, i) => {
    const wanted = String(params[v.name]);
    const got = readback[i] ?? "";
    const wn = Number(wanted), gn = Number(got);
    const ok = (!Number.isNaN(wn) && !Number.isNaN(gn))
      ? Math.abs(wn - gn) <= Math.max(1e-9, Math.abs(wn) * 1e-9)
      : wanted.trim() === got.trim();
    if (!ok) mismatches.push(`${v.name}: wrote "${wanted}", cell reads "${got}"`);
  });
  if (mismatches.length) {
    const e = new Error(
      "Excel did not accept the input values, so the run was refused rather than reporting numbers that would look exact but be wrong. " +
      `Readback mismatch — ${mismatches.join("; ")}. ` +
      "Usual causes: the sheet or cell reference in model-bindings.mjs does not match this workbook, the cell is protected or formula-driven, the workbook opened read-only, or Excel is showing a dialog. Open the workbook once by hand, dismiss any prompt, and correct the cell references."
    );
    e.userFacing = true;
    throw e;
  }

  const parts = outBlock.split("\n===\n");
  return (binding.outputs || []).map((o, i) => ({ label: o.label, value: (parts[i] ?? "").trim() }));
}

/* ---------- Mode 2: read cached values with SheetJS (no recalculation) --- */
function runViaSheetJS(file, binding, params) {
  if (Object.keys(params || {}).some((k) => (binding.inputs || {})[k] !== undefined && params[k] !== "")) {
    const e = new Error(
      "This workbook can only be read, not recalculated: Microsoft Excel was not found on this machine. " +
      "Changing inputs would return stale cached values, so the run was refused. Install Excel (macOS) to enable write-and-recalculate, or read the stored scenario without changing inputs."
    );
    e.userFacing = true;
    throw e;
  }
  const wb = XLSX.readFile(file, { cellFormula: false });
  return (binding.outputs || []).map((o) => {
    const ws = wb.Sheets[o.sheet];
    if (!ws) return { label: o.label, value: "(sheet not found)" };
    if (o.range) {
      const rows = XLSX.utils.sheet_to_json(ws, { range: o.range, header: 1, defval: "" });
      return { label: o.label, value: JSON.stringify(rows).slice(0, 4000) };
    }
    const cell = ws[o.cell];
    return { label: o.label, value: cell ? String(cell.v ?? "") : "(empty)" };
  });
}

export async function runXlsx(binding, params, { baseDir }) {
  const file = workbookPath(baseDir, binding);
  if (!file || !fs.existsSync(file)) {
    const e = new Error(
      `Workbook not found at ${binding.file}. These models are registration-walled, so LODESTONE cannot fetch them for you: ` +
      `download it from the publisher and save it to lodestone/${binding.file}.`
    );
    e.userFacing = true;
    throw e;
  }
  const mode = excelAvailable() ? "recalc" : "read-only";
  const started = Date.now();
  const results = mode === "recalc"
    ? await runViaExcel(file, binding, params || {})
    : runViaSheetJS(file, binding, params || {});

  return {
    columns: ["Output", "Value"],
    rows: results.map((r) => ({ Output: r.label, Value: r.value })),
    summary:
      mode === "recalc"
        ? `Recalculated ${path.basename(file)} in Microsoft Excel with ${Object.keys(params || {}).length} input(s); read ${results.length} output cell(s). Values are exact model output.`
        : `Read ${results.length} cached value(s) from ${path.basename(file)} without recalculation (Excel not available).`,
    extraction: mode === "recalc" ? "exact" : "cached",
    endpoint: `${mode === "recalc" ? "Excel recalc" : "SheetJS read"} · ${path.basename(file)}`,
    ms: Date.now() - started,
  };
}

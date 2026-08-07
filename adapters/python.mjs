// Generic Python adapter (spec Tier 3: locally executed models).
//
// Runs ANY Python model from a declarative binding. The contract is deliberately
// tiny so that wrapping a new model means writing a short driver script, not
// touching this file:
//
//   stdin   <- JSON object of parameters
//   stdout  -> JSON object: { columns, rows, summary, extraction?, endpoint? }
//   stderr  -> diagnostics (surfaced only when the run fails)
//
// Binding shape:
//   {
//     adapter: "python",
//     script:  "models/blast_driver.py",   // relative to the lodestone dir
//     python:  "models/blast-venv/bin/python",  // optional; defaults to python3
//     cwd:     "models",                   // optional
//     timeoutMs: 600000,
//   }
//
// Unlike the browser adapter this returns real numbers, so `extraction` is
// "exact" unless the driver says otherwise.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function resolvePython(baseDir, binding) {
  if (binding.python) {
    const p = path.isAbsolute(binding.python) ? binding.python : path.join(baseDir, binding.python);
    if (fs.existsSync(p)) return p;
    return null; // an explicitly requested interpreter that is missing is an error, not a fallback
  }
  for (const c of ["/usr/bin/python3", "/usr/local/bin/python3", "python3"]) {
    if (c === "python3" || fs.existsSync(c)) return c;
  }
  return null;
}
export function scriptPath(baseDir, binding) {
  if (!binding.script) return null;
  return path.isAbsolute(binding.script) ? binding.script : path.join(baseDir, binding.script);
}
export function pythonReady(baseDir, binding) {
  return !!resolvePython(baseDir, binding) && fs.existsSync(scriptPath(baseDir, binding) || "");
}

export async function runPython(binding, params, { baseDir }) {
  const py = resolvePython(baseDir, binding);
  const script = scriptPath(baseDir, binding);
  if (!py) {
    const e = new Error(
      `Python interpreter not found${binding.python ? ` at ${binding.python}` : ""}. ` +
      `Create it with:  cd lodestone/models && python3 -m venv --system-site-packages blast-venv && ./blast-venv/bin/pip install h5pyd geopy`
    );
    e.userFacing = true; throw e;
  }
  if (!script || !fs.existsSync(script)) {
    const e = new Error(`Driver script not found at ${binding.script}.`);
    e.userFacing = true; throw e;
  }

  const started = Date.now();
  const cwd = binding.cwd ? path.join(baseDir, binding.cwd) : baseDir;
  const proc = spawn(py, [script], { cwd, stdio: ["pipe", "pipe", "pipe"] });

  let out = "", err = "";
  proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { err += d; });
  proc.stdin.end(JSON.stringify(params || {}));

  const timeoutMs = binding.timeoutMs ?? 600000;
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`Timed out after ${timeoutMs} ms`)); }, timeoutMs);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (c) => { clearTimeout(timer); resolve(c); });
  });

  if (code !== 0) {
    // Surface the driver's own message: a model that refuses bad inputs should
    // say why, exactly as the spreadsheet adapter does on a readback mismatch.
    const tail = err.trim().split("\n").slice(-6).join(" | ").slice(0, 600);
    const e = new Error(`The model exited with code ${code}. ${tail || "(no stderr)"}`);
    e.userFacing = true; throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop() || "{}");
  } catch {
    const e = new Error(
      "The driver did not emit valid JSON on stdout. A Python driver must print exactly one JSON object " +
      `as its last line. First 300 chars of output: ${out.slice(0, 300)}`
    );
    e.userFacing = true; throw e;
  }
  if (parsed.error) { const e = new Error(parsed.error); e.userFacing = true; throw e; }

  return {
    columns: parsed.columns,
    rows: parsed.rows,
    summary: parsed.summary || `Ran ${path.basename(script)}.`,
    extraction: parsed.extraction || "exact",
    endpoint: parsed.endpoint || `${path.basename(py)} ${path.basename(script)}`,
    ms: Date.now() - started,
  };
}

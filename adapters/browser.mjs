// Generic browser adapter (spec Tier 2: agent-operated web tools).
//
// Drives ANY interactive web model from a declarative binding — no per-model
// code. Uses the system Chrome via puppeteer-core rather than downloading a
// bundled browser.
//
// Binding shape:
//   {
//     adapter: "browser",
//     url:      "https://…",
//     framework:"shiny" | "dom",       // how inputs are written
//     inputs:   { paramName: {id, kind: "checkbox"|"number"|"text"|"select"} },
//     outputs:  [ {id, label, type:"image"} ],   // elements to capture
//     settleMs: 1200,                  // quiet period after recalculation
//     timeoutMs: 45000,
//   }
//
// Returns the shared run contract. Because these tools render charts rather
// than tables, `extraction` is "artifact": the run yields images, and any
// NUMBER derived from them must be labelled as estimated, never as exact
// model output.
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
export function browserAvailable() { return !!findChrome(); }

// Written into the page. Framework-specific input setting lives here so the
// binding stays declarative.
function pageSetInputs(inputs, params, framework) {
  const applied = [];
  for (const [name, spec] of Object.entries(inputs)) {
    if (!(name in params)) continue;
    let value = params[name];
    if (spec.kind === "checkbox") {
      value = value === true || value === "true" || value === "on" || value === 1 || value === "1";
    } else if (spec.kind === "number") {
      value = Number(value);
      if (Number.isNaN(value)) continue;
    }
    if (framework === "shiny" && window.Shiny && window.Shiny.setInputValue) {
      // Authoritative for the server-side computation. Note the visible widget
      // does NOT follow this, so the parameter record — not the DOM — is truth.
      window.Shiny.setInputValue(spec.id, value, { priority: "event" });
      applied.push({ name, id: spec.id, value });
    } else {
      const el = document.getElementById(spec.id);
      if (!el) continue;
      if (spec.kind === "checkbox") el.checked = value;
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      applied.push({ name, id: spec.id, value });
    }
  }
  return applied;
}

// Settled = nothing marked recalculating/busy AND every captured output has
// stopped changing. Works for Shiny (.recalculating) and degrades to
// image-stability elsewhere.
function pageIsSettled(outputIds) {
  // Scope "busy" to the outputs this binding actually captures. A global
  // .recalculating check hangs forever on apps that keep hidden-tab outputs
  // permanently marked busy (Shiny does exactly this for unrendered tabs).
  const busy = outputIds.filter((id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    return el.classList.contains("recalculating") || !!el.closest(".recalculating");
  }).length;
  const sig = outputIds.map((id) => {
    const host = document.getElementById(id);
    const img = host && host.querySelector("img");
    return img ? img.src.length : (host ? (host.innerText || "").length : 0);
  }).join(",");
  return { busy, sig };
}

function pageReadOutputs(outputs) {
  return outputs.map((o) => {
    const host = document.getElementById(o.id);
    if (!host) return { id: o.id, label: o.label, missing: true };
    const img = host.querySelector("img");
    if (img && img.src.startsWith("data:image")) {
      return { id: o.id, label: o.label, type: "image", dataUri: img.src };
    }
    const text = (host.innerText || "").trim();
    return { id: o.id, label: o.label, type: text ? "text" : "empty", text: text.slice(0, 4000) };
  });
}

// Hosted apps (shinyapps.io free tier especially) drop and reconnect their
// websocket, which detaches the frame mid-evaluation. That is transient, so
// retry once before surfacing it.
export async function runBrowser(binding, params, opts = {}) {
  try {
    return await runBrowserOnce(binding, params, opts);
  } catch (e) {
    if (/detached|Target closed|Session closed|Navigating frame/i.test(e.message || "")) {
      await new Promise((r) => setTimeout(r, 2500));
      return await runBrowserOnce(binding, params, opts);
    }
    throw e;
  }
}

async function runBrowserOnce(binding, params, opts = {}) {
  const exe = findChrome();
  if (!exe) {
    const e = new Error("No Chrome/Chromium found. Install Google Chrome, or set CHROME_PATH in lodestone/.env to its executable.");
    e.userFacing = true;
    throw e;
  }
  const timeoutMs = binding.timeoutMs ?? 60000;
  const settleMs = binding.settleMs ?? 1500;
  const outputIds = (binding.outputs || []).map((o) => o.id);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: binding.viewport?.width ?? 1400, height: binding.viewport?.height ?? 1000 });
    await page.goto(binding.url, { waitUntil: "networkidle2", timeout: timeoutMs });

    // Wait for the app to finish its first render before touching inputs.
    if (binding.readySelector) await page.waitForSelector(binding.readySelector, { timeout: timeoutMs });
    await settle(page, outputIds, settleMs, timeoutMs);

    const applied = await page.evaluate(pageSetInputs, binding.inputs || {}, params || {}, binding.framework || "dom");
    await new Promise((r) => setTimeout(r, 400));           // let the change register
    await settle(page, outputIds, settleMs, timeoutMs);      // then wait for recompute

    const captured = await page.evaluate(pageReadOutputs, binding.outputs || []);
    const artifacts = captured
      .filter((c) => c.type === "image" && c.dataUri)
      .map((c) => ({ type: "image", label: c.label, id: c.id, dataUri: c.dataUri, bytes: c.dataUri.length }));
    const texts = captured.filter((c) => c.type === "text");

    return {
      summary:
        `Ran ${binding.label || binding.url} with ${applied.length} parameter(s) applied; captured ` +
        `${artifacts.length} chart(s)${texts.length ? ` and ${texts.length} text output(s)` : ""}.`,
      // Charts, not numbers: callers must treat any figure read from these as
      // an estimate. See extraction below.
      extraction: artifacts.length && !texts.length ? "artifact" : "mixed",
      appliedParams: applied,
      artifacts,
      columns: texts.length ? ["Output", "Text"] : undefined,
      rows: texts.length ? texts.map((t) => ({ Output: t.label, Text: t.text })) : undefined,
      endpoint: binding.url,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function settle(page, outputIds, settleMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null, stableSince = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(pageIsSettled, outputIds);
    const key = `${state.busy}|${state.sig}`;
    if (state.busy === 0 && key === last) {
      if (stableSince && Date.now() - stableSince >= settleMs) return true;
      if (!stableSince) stableSince = Date.now();
    } else {
      stableSince = null;
    }
    last = key;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false; // fall through and capture whatever is there
}

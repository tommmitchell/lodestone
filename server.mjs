// LODESTONE local server — serves the workbench UI and proxies assistant
// requests to the Claude API. Credentials never reach the browser.
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { BINDINGS, bindingFor } from "./model-bindings.mjs";
import { runBrowser, browserAvailable } from "./adapters/browser.mjs";
import { runXlsx, xlsxMode, excelAvailable, workbookPresent } from "./adapters/xlsx.mjs";
import { runPython, pythonReady, resolvePython } from "./adapters/python.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load lodestone/.env (KEY=VALUE lines) so credentials live with the project
// rather than the shell profile. Real environment variables take precedence.
try {
  for (const line of readFileSync(path.join(here, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 8787;

// ---- Cost bounding (Option 2) ----
// Standard first-party rates, USD per million tokens. Cache reads bill ~0.1x
// input rate; 5-minute-TTL cache writes ~1.25x. Estimates are conservative
// (Sonnet 5 intro pricing may bill lower than estimated here).
const PRICES = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
};
const DAILY_LIMIT_USD = Number(process.env.LODESTONE_DAILY_LIMIT_USD ?? "2");
const LEDGER_PATH = path.join(here, ".spend.json");

let ledger = {};
try { ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8")); } catch {}
const todayKey = () => new Date().toISOString().slice(0, 10);
const todaySpend = () => ledger[todayKey()] ?? 0;
async function addSpend(usd) {
  ledger[todayKey()] = todaySpend() + usd;
  try { await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 1)); } catch (e) { console.error("spend ledger write failed:", e.message); }
}
function estimateCost(model, u) {
  const key = Object.keys(PRICES).find((k) => String(model).startsWith(k));
  const p = PRICES[key] ?? PRICES["claude-opus-5"];
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_read_input_tokens ?? 0) * p.input * 0.1 +
      (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (u.output_tokens ?? 0) * p.output) / 1e6
  );
}

const MODELS = new Set(["claude-opus-5", "claude-sonnet-5"]);
const MODE_DEFAULT_MODEL = { qa: "claude-sonnet-5", redteam: "claude-opus-5" };

// Auth comes exclusively from MY_ANTHROPIC_KEY (env or lodestone/.env).
// Passing null when unset prevents the SDK's default ANTHROPIC_API_KEY fallback.
const client = new Anthropic({ apiKey: process.env.MY_ANTHROPIC_KEY ?? null });

// Structured-output schema: every assistant reply is a cited answer plus zero
// or more proposed cards for human review (FR-A1/A3/A5).
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "The answer, in plain prose. Cite evidence inline using card IDs in square brackets like [F-1] and source IDs in parentheses like (s5). If the workspace evidence is insufficient, say so explicitly.",
    },
    evidence_gaps: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific gaps: claims that could not be grounded in the workspace, or sources that should be ingested.",
    },
    proposals: {
      type: "array",
      description:
        "Candidate evidence cards (0-4). Propose only claims that are grounded in workspace sources and not already on the board.",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "fact",
              "opportunity",
              "tradeoff",
              "open_question",
              "risk",
              "assumption",
              "recommendation",
            ],
          },
          statement: { type: "string", description: "One sentence, <= 280 chars." },
          detail: { type: "string", description: "Caveats and context. May be empty." },
          confidence: {
            type: "string",
            enum: ["established", "probable", "contested", "unverified"],
          },
          tags: { type: "array", items: { type: "string" } },
          citations: {
            type: "array",
            description:
              "Workspace source IDs supporting the statement. Use ONLY IDs that exist in the workspace (e.g. s5). Empty for open questions.",
            items: {
              type: "object",
              properties: {
                sourceId: { type: "string" },
                locator: { type: "string" },
              },
              required: ["sourceId", "locator"],
              additionalProperties: false,
            },
          },
        },
        required: ["type", "statement", "detail", "confidence", "tags", "citations"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "evidence_gaps", "proposals"],
  additionalProperties: false,
};

const COMMON_RULES = `You are the analyst assistant inside LODESTONE, an evidence workbench used by NSF program staff to decide whether and what to fund in battery/critical-materials recycling research.

Core rules — these implement the tool's provenance principles:
1. GROUNDING. Base every claim on the workspace evidence provided (cards, sources, model runs). Cite inline: card IDs in square brackets [F-1], source IDs in parentheses (s5). Do not import outside knowledge silently — if you draw on general knowledge beyond the workspace, label that sentence "(beyond workspace evidence)".
2. HONESTY ABOUT GAPS. If the workspace cannot answer the question, say so plainly and list what is missing in evidence_gaps. Never fabricate numbers, sources, or locators.
3. PROPOSALS ARE SUGGESTIONS. Propose cards sparingly (0-4), only for claims that are (a) grounded in a workspace source, (b) not already on the board, and (c) decision-relevant. A human must accept them; write statements they can accept verbatim.
4. CONFIDENCE DISCIPLINE. "established" needs multiple independent sources; single-source claims are at most "probable"; disagreements are "contested"; anything ungrounded is "unverified".
5. Citations in proposals must use source IDs that exist in the workspace. Never invent IDs.`;

const MODE_INSTRUCTIONS = {
  qa: `Mode: grounded Q&A (FR-A1). Answer the user's question from the workspace evidence. Where cards conflict (linked conflicts-with), present both sides and say what would resolve the disagreement. Keep answers focused — a decision-maker is reading.`,
  redteam: `Mode: red-team (FR-A5). Adversarially challenge the workspace evidence relevant to the user's prompt (or, if no focus is given, the strongest-looking claims on the board). Find: the weakest citations, single-source facts treated as established, alternative interpretations of the same data, and assumptions that could invalidate recommendations. Be specific about which card each attack targets. Express your strongest attacks as proposed risk or open_question cards so they can be captured on the board. Do not soften findings.`,
};

function serializeWorkspace(ws) {
  // Compact projection of the workspace for grounding. The browser sends its
  // full state; we strip UI fields and cap sizes defensively.
  const s = (v, n) => String(v ?? "").slice(0, n);
  return JSON.stringify({
    workspace: {
      title: s(ws?.ws?.title, 200),
      question: s(ws?.ws?.question, 500),
      criteria: (ws?.ws?.criteria ?? []).slice(0, 12).map((c) => s(c, 200)),
    },
    cards: (ws?.cards ?? []).slice(0, 300).map((c) => ({
      id: s(c.id, 20),
      type: s(c.type, 20),
      statement: s(c.statement, 600),
      detail: s(c.detail, 800),
      confidence: s(c.confidence, 20),
      status: s(c.status, 20),
      tags: (c.tags ?? []).slice(0, 10).map((t) => s(t, 40)),
      citations: (c.citations ?? []).slice(0, 10).map((x) => ({
        sourceId: s(x.sourceId, 20),
        locator: s(x.locator, 100),
      })),
      links: (c.links ?? []).slice(0, 10).map((l) => ({ to: s(l.to, 20), rel: s(l.rel, 20) })),
    })),
    sources: (ws?.sources ?? []).slice(0, 300).map((src) => ({
      id: s(src.id, 20),
      kind: s(src.kind, 30),
      title: s(src.title, 300),
      author: s(src.author, 200),
      date: s(src.date, 20),
      access: s(src.access, 20),
      notes: s(src.notes, 600),
    })),
    model_runs: (ws?.runs ?? []).slice(0, 50).map((r) => ({
      id: s(r.id, 20),
      name: s(r.name, 200),
      params: s(r.params, 600),
      outputs: s(r.outputs, 1000),
      notes: s(r.notes, 600),
      date: s(r.date, 20),
    })),
  });
}

async function handleAssistant(body) {
  const mode = body.mode === "redteam" ? "redteam" : "qa";
  let model = typeof body.model === "string" ? body.model : "auto";
  if (!MODELS.has(model)) model = MODE_DEFAULT_MODEL[mode];

  const question = String(body.question ?? "").slice(0, 4000).trim();
  if (!question && mode === "qa") {
    return { status: 400, json: { error: "Question is required." } };
  }

  if (todaySpend() >= DAILY_LIMIT_USD) {
    return {
      status: 429,
      json: {
        error: `Daily assistant spend limit reached ($${todaySpend().toFixed(2)} of $${DAILY_LIMIT_USD.toFixed(2)}). Raise LODESTONE_DAILY_LIMIT_USD in lodestone/.env and restart the server, or wait until tomorrow.`,
      },
    };
  }

  const messages = [];
  for (const turn of (body.history ?? []).slice(-6)) {
    const q = String(turn.q ?? "").slice(0, 4000);
    const a = String(turn.a ?? "").slice(0, 8000);
    if (q && a) {
      messages.push({ role: "user", content: q });
      messages.push({ role: "assistant", content: a });
    }
  }
  messages.push({
    role: "user",
    content: question || "Red-team the current evidence board.",
  });

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    // Stable instructions first (cached); volatile workspace snapshot after.
    system: [
      {
        type: "text",
        text: `${COMMON_RULES}\n\n${MODE_INSTRUCTIONS[mode]}`,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: `Current workspace evidence:\n${serializeWorkspace(body.workspace)}` },
    ],
    output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    messages,
  });

  if (response.stop_reason === "refusal") {
    return {
      status: 200,
      json: {
        answer:
          "The model declined this request (safety classifiers). Rephrase the question or narrow its scope.",
        evidence_gaps: [],
        proposals: [],
        model: response.model,
      },
    };
  }

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { answer: text || "(empty response)", evidence_gaps: [], proposals: [] };
  }
  const requestUsd = estimateCost(response.model, response.usage);
  await addSpend(requestUsd);
  return {
    status: 200,
    json: {
      ...parsed,
      model: response.model,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      },
      cost: {
        request_usd: requestUsd,
        today_usd: todaySpend(),
        daily_limit_usd: DAILY_LIMIT_USD,
      },
    },
  };
}

function assistantError(e) {
  // Missing credentials surface as a plain Error at request-build time.
  if (e instanceof Anthropic.AuthenticationError ||
      /could not resolve authentication/i.test(e?.message ?? "")) {
    return {
      status: 401,
      json: {
        error:
          "No valid Anthropic credentials. Set MY_ANTHROPIC_KEY in lodestone/.env (or in the environment you run `npm start` from), then restart the server.",
      },
    };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { status: 429, json: { error: "Rate limited by the Claude API — wait a moment and retry." } };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { status: 502, json: { error: "Could not reach the Claude API — check your network connection." } };
  }
  if (e instanceof Anthropic.APIError) {
    return { status: e.status ?? 500, json: { error: `Claude API error: ${e.message}` } };
  }
  console.error(e);
  return { status: 500, json: { error: "Internal server error." } };
}

/* ============================================================================
   MODEL RUNNERS (FR-M5 dataset connectors).
   Only models with a callable, documented interface live here. Everything else
   in the registry is Excel, a proprietary runtime, or a JS app with no API —
   those stay guided-manual capture rather than getting a fake "run" button.
   ========================================================================= */

// Comtrade's free tier populates reporterCode/partnerCode but leaves every
// matching *Desc field null, so rows come back as bare M49 numbers. The area
// reference file is public (no subscription key) and static, so fetch it once
// per process and reuse it. A failure here degrades names to "area <code>"
// rather than failing the run.
let comtradeAreasP = null;
function comtradeAreas() {
  if (!comtradeAreasP) {
    comtradeAreasP = (async () => {
      const r = await fetch("https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.results || j.data || []);
      const map = {};
      for (const a of list) {
        const code = String(a.PartnerCode ?? a.partnerCode ?? a.id ?? "").trim();
        const name = String(a.PartnerDesc ?? a.partnerDesc ?? a.text ?? "").trim();
        if (code && name) map[code] = name;
      }
      return map;
    })().catch(() => ({}));
  }
  return comtradeAreasP;
}

/* The IEA data explorers are React front-ends over an open JSON API: no key,
   no token, no Referer check. The "create a free account" prompts on iea.org
   govern report PDFs, not this data. Verified against the live API 2026-08-07. */
async function ieaFetch(path, params) {
  const url = new URL(`https://api.iea.org/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || String(v).trim() === "") continue;
    url.searchParams.set(k, String(v).trim());
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`IEA API returned HTTP ${res.status} for /${path}`);
  const json = await res.json();
  return { rows: Array.isArray(json) ? json : [], url: url.toString() };
}
// Valid values for a dimension, used to explain an empty result rather than
// leaving the analyst to guess which term was misspelled.
async function ieaList(path, qs) {
  try { return (await ieaFetch(`${path}/list/${qs.dim}`, qs.extra || {})).rows; }
  catch { return []; }
}
/* An empty result has two very different causes and the analyst needs to know
   which: a value that is not in the vocabulary at all (a typo), or a set of
   individually valid values whose combination is simply not published. Saying
   "check your spelling" when nothing is misspelled sends them hunting for a
   mistake that is not there. */
async function ieaDiagnose(path, supplied, dims, note) {
  const lists = await Promise.all(dims.map((d) => ieaList(path, { dim: d })));
  const unknown = [];
  dims.forEach((d, i) => {
    const v = supplied[d];
    if (!v || !lists[i].length) return;
    if (!lists[i].some((x) => String(x).toLowerCase() === String(v).toLowerCase())) {
      unknown.push(`"${v}" is not a recognised ${d} — valid values are: ${lists[i].join(", ")}.`);
    }
  });
  if (unknown.length) return " NO DATA RETURNED — " + unknown.join(" ");
  return " NO DATA RETURNED — every value supplied is individually valid, so this combination has no"
    + " published data; nothing is misspelled." + (note ? " " + note : "");
}
// float32 round-trip noise (120.84200286865234) is an artefact of the wire
// format, not model precision. Six significant figures keeps every real digit.
const tidy = (v) => (typeof v === "number" && isFinite(v) ? Number(v.toPrecision(6)) : v);

/* ---------------------------------------------------------------------------
   USGS Mineral Commodity Summaries. There is no query API — the data is an
   annual ScienceBase release with a CSV attached — so the runner discovers the
   newest release, downloads it once per process, and queries it in memory.
   ------------------------------------------------------------------------ */

// RFC 4180: fields may be quoted, quoted fields may contain commas and
// newlines, and an embedded quote is written doubled. The MCS file uses all
// three, so a split(",") would silently corrupt the Notes and Value columns.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// USGS publishes the file with U+FFFD where an em- or en-dash belongs — the
// corruption is in the released file, not in our decoding, so it is normalised
// to a plain hyphen rather than guessed at.
const deMojibake = (s) => String(s == null ? "" : s).replace(/�/g, "-").trim();

// Survey codes in the Value column. These are NOT numbers and must never be
// coerced to zero: "W" hides a real quantity, "-" asserts an actual zero, and
// conflating them would invent data that USGS deliberately withheld.
const MCS_CODES = {
  "W": "withheld to avoid disclosing company proprietary data",
  "NA": "not available",
  "-": "zero",
  "E": "estimated",
  "s": "less than half the unit shown",
  "XX": "not applicable",
};

let mcsCache = null;
async function usgsMcs() {
  if (mcsCache) return mcsCache;
  mcsCache = (async () => {
    const sb = async (u) => {
      const r = await fetch(u, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`ScienceBase returned HTTP ${r.status}`);
      return r.json();
    };
    // 1. Find the newest annual parent release. Matching the title pattern
    //    exactly avoids picking up the ~90 per-commodity child releases that
    //    share the same search terms.
    const hits = await sb("https://www.sciencebase.gov/catalog/items?q="
      + encodeURIComponent("Mineral Commodity Summaries Data Release")
      + "&format=json&max=50&fields=title");
    const releases = (hits.items || [])
      .map((i) => ({ id: i.id, title: i.title || "", year: Number((/^Mineral Commodity Summaries (\d{4}) Data Release$/.exec(i.title || "") || [])[1]) }))
      .filter((i) => i.year)
      .sort((a, b) => b.year - a.year);
    if (!releases.length) {
      throw new Error("Could not find a Mineral Commodity Summaries annual data release on ScienceBase. "
        + "USGS restructures this release each February; the discovery step needs updating rather than "
        + "silently falling back to a stale year.");
    }
    const rel = releases[0];
    // 2. The commodity table lives on a child item, not the parent.
    const kids = await sb(`https://www.sciencebase.gov/catalog/items?parentId=${rel.id}&format=json&max=50&fields=title,files`);
    let file = null;
    for (const kid of (kids.items || [])) {
      const f = (kid.files || []).find((x) => /Commodities_Data\.csv$/i.test(x.name || ""));
      if (f) { file = f; break; }
    }
    if (!file) {
      const parent = await sb(`https://www.sciencebase.gov/catalog/item/${rel.id}?format=json`);
      file = (parent.files || []).find((x) => /Commodities_Data\.csv$/i.test(x.name || "")) || null;
    }
    if (!file) {
      throw new Error(`Found the ${rel.year} release (${rel.id}) but no *_Commodities_Data.csv within it. `
        + "The release layout has changed and the runner needs updating.");
    }
    // 3. Download and parse once.
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Could not download ${file.name}: HTTP ${res.status}`);
    const grid = parseCsv(await res.text());
    const header = (grid.shift() || []).map((h) => deMojibake(h));
    const rows = grid.filter((r) => r.length > 1).map((r) => {
      const o = {};
      header.forEach((h, i) => { o[h] = deMojibake(r[i]); });
      return o;
    });
    return { year: rel.year, itemId: rel.id, fileName: file.name, fileUrl: file.url, rows,
             landing: `https://www.sciencebase.gov/catalog/item/${rel.id}` };
  })().catch((e) => { mcsCache = null; throw e; });
  return mcsCache;
}

const RUNNERS = {
  // USAspending: free public REST, no credential. Verified against the live API.
  async m10(p) {
    // USAspending rejects award-type codes from different groups in one query,
    // so the award type is a single choice rather than a union.
    const GROUPS = {
      grants: ["02", "03", "04", "05"],
      contracts: ["A", "B", "C", "D"],
      loans: ["07", "08"],
    };
    const group = GROUPS[String(p.awardType || "grants").toLowerCase()] || GROUPS.grants;
    const filters = {
      keywords: [String(p.keywords || "battery recycling").slice(0, 200)],
      award_type_codes: group,
      time_period: [{ start_date: String(p.from || "2022-01-01"), end_date: String(p.to || "2026-08-01") }],
    };
    const limit = Math.min(Math.max(Number(p.limit) || 10, 1), 50);
    const res = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filters,
        // "Description" carries the project title, usually followed by a blank
        // line and the abstract — so the title is the first paragraph.
        fields: ["Award ID", "Description", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date"],
        limit, sort: "Award Amount", order: "desc",
      }),
    });
    if (!res.ok) throw new Error(`USAspending returned HTTP ${res.status}`);
    const json = await res.json();
    const title = (desc) => {
      if (!desc) return "—";
      let t = String(desc).split(/\n\s*\n/)[0];
      t = t.replace(/^\s*(PROJECT\s+(ENTITLED|TITLE)\s*:\s*)/i, "").replace(/\s+/g, " ").trim();
      return t.length > 180 ? t.slice(0, 177).trimEnd() + "…" : (t || "—");
    };
    const rows = (json.results || []).map((x) => ({
      "Award ID": x["Award ID"],
      "Title": title(x["Description"]),
      "Recipient": x["Recipient Name"],
      "Amount (USD)": x["Award Amount"],
      "Agency": x["Awarding Agency"],
      "Start": x["Start Date"],
    }));
    const total = rows.reduce((s, r) => s + (Number(r["Amount (USD)"]) || 0), 0);
    return {
      columns: ["Award ID", "Title", "Recipient", "Amount (USD)", "Agency", "Start"],
      rows,
      summary: `${rows.length} federal ${String(p.awardType || "grants").toLowerCase()} matching "${filters.keywords[0]}" with start dates between ${filters.time_period[0].start_date} and ${filters.time_period[0].end_date}. Obligations across the returned rows total $${total.toLocaleString("en-US", { maximumFractionDigits: 0 })}. Sorted by amount, descending.`,
      endpoint: "POST https://api.usaspending.gov/api/v2/search/spending_by_award/",
    };
  },

  // UN Comtrade: same shape, but the free tier requires a subscription key.
  // The free tier also returns every *Desc field as null, so country and
  // commodity names have to be resolved from the keyless reference files.
  async m11(p) {
    const key = process.env.COMTRADE_API_KEY;
    if (!key) {
      const e = new Error("No UN Comtrade key. Register for the free tier at comtradeplus.un.org, add COMTRADE_API_KEY to lodestone/.env, and restart the server.");
      e.userFacing = true;
      throw e;
    }
    const url = new URL("https://comtradeapi.un.org/data/v1/get/C/A/HS");
    url.searchParams.set("reporterCode", String(p.reporter || "842"));
    url.searchParams.set("period", String(p.period || "2023"));
    url.searchParams.set("cmdCode", String(p.cmdCode || "854913"));
    url.searchParams.set("flowCode", String(p.flow || "M"));
    const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": key } });
    if (!res.ok) throw new Error(`UN Comtrade returned HTTP ${res.status}${res.status === 401 ? " — the key was rejected" : ""}`);
    const json = await res.json();
    const areas = await comtradeAreas();
    const areaName = (code) => {
      const c = String(code ?? "").trim();
      if (c === "" || c === "null") return "";
      if (c === "0") return "World (all partners)";
      return areas[c] || `area ${c}`;
    };
    // Partner 0 is the all-partners aggregate, so it belongs at the top rather
    // than in the value ranking with the individual partners it sums over.
    const raw = (json.data || []).slice();
    raw.sort((a, b) => {
      if (String(a.partnerCode) === "0") return -1;
      if (String(b.partnerCode) === "0") return 1;
      return (Number(b.primaryValue) || 0) - (Number(a.primaryValue) || 0);
    });
    const rows = raw.slice(0, 50).map((x) => ({
      "Reporter": x.reporterDesc || areaName(x.reporterCode),
      "Partner": x.partnerDesc || areaName(x.partnerCode),
      "Year": x.period,
      "HS code": x.cmdCode,
      "Value (USD)": x.primaryValue,
      "Net weight (kg)": x.netWgt,
    }));
    // A zero-row result is a real outcome, not a silent success: say so, and
    // name the most common cause. HS2022 abolished 854810 and moved battery
    // scrap to heading 8549, so pre-2022 codes return nothing for recent years.
    const code = String(p.cmdCode || "854913");
    const year = Number(p.period || "2023");
    const direction = String(p.flow || "M") === "X" ? "exports" : "imports";
    const reporterName = areaName(p.reporter || "842");
    let summary = `${rows.length} Comtrade record(s): ${reporterName} ${direction} of HS ${code}, ${year}.`;
    const world = raw.find((x) => String(x.partnerCode) === "0");
    if (world) {
      const partners = rows.length - 1;
      summary += ` Reported total across all partners: $${Number(world.primaryValue || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
        + `${world.netWgt ? ` over ${Number(world.netWgt).toLocaleString("en-US")} kg` : ""}`
        + `, from ${partners} named partner${partners === 1 ? "" : "s"}. The World row is that aggregate, not an extra partner.`;
    }
    if (rows.length === 0) {
      const hints = [];
      if (/^8548/.test(code) && year >= 2022)
        hints.push(`HS ${code} was abolished in the HS2022 revision — battery waste and scrap moved to heading 8549 (854913 sorted by chemistry, 854914 unsorted, 854911 lead-acid). Use one of those for ${year}.`);
      if (/^8549/.test(code) && year < 2022)
        hints.push(`HS ${code} only exists from HS2022 onward; for ${year} the battery-scrap code was 854810.`);
      hints.push("Not every reporter files every subheading in every year, so an empty result can also mean the country simply did not report that line.");
      summary += " NO DATA RETURNED — " + hints.join(" ");
    }
    // Neither classification vintage cleanly measures lithium black mass, and
    // the failure modes point opposite ways: the new codes undercount because
    // filing coverage is still thin, the old one overcounts because it pools
    // lead-acid in. Say so on every run rather than letting a number stand bare.
    if (/^8549(13|14)/.test(code))
      summary += ` CAVEAT: these are the chemistry-sorted lines that lithium-ion black mass would use, and they are barely populated. US 2023 exports under 854913 and 854914 total about $264k, against $452M under 854911 (lead-acid) and $120M under the residual 854919. Lead-acid filing is continuous across the HS2022 change, so a small figure here reflects filing practice rather than an absence of trade. Cross-check 854919 and USITC DataWeb's finer Schedule B suffixes before treating this as a volume estimate.`;
    else if (/^8549/.test(code))
      summary += ` CAVEAT: heading 8549 was introduced in the HS2022 revision, so this line has no pre-2022 history and is not directly comparable to the 854810 series it replaced.`;
    if (/^8548/.test(code) && rows.length)
      summary += ` CAVEAT: HS 854810 pooled all battery waste and scrap, and US flows under it were dominated by spent lead-acid batteries (chiefly to Mexico), not lithium black mass. Do not read it as a lithium-recycling figure.`;
    return {
      columns: ["Reporter", "Partner", "Year", "HS code", "Value (USD)", "Net weight (kg)"],
      rows,
      summary,
      endpoint: url.toString(),
    };
  },

  // IEA Critical Minerals Data Explorer — demand and supply projections.
  async m7(p) {
    const q = {
      material: p.material || "Lithium",
      category: p.category || "Material demand",
      case: p.case || "Base Case",
      flow: p.flow || "IDLE",
      scenario: p.scenario, product: p.product, region: p.region,
    };
    const { rows: data, url } = await ieaFetch("minerals", q);
    data.sort((a, b) => (Number(a.year) - Number(b.year))
      || String(a.scenario).localeCompare(String(b.scenario))
      || String(a.product).localeCompare(String(b.product)));
    const rows = data.slice(0, 300).map((x) => ({
      "Year": x.year, "Scenario": x.scenario, "Region": x.region, "Product": x.product,
      "Material": x.material, "Flow": x.flow, "Value": tidy(x.value), "Unit": x.unit,
    }));
    let summary = `${rows.length} IEA record(s): ${q.material}, ${q.category}, flow ${q.flow}, case "${q.case}"`
      + `${q.scenario ? `, ${q.scenario}` : ""}${q.product ? `, ${q.product}` : ""}${q.region ? `, ${q.region}` : ""}.`;
    if (data[0] && data[0].mcm) summary += ` Dataset vintage ${data[0].mcm}.`;
    if (data.length > rows.length) summary += ` Showing the first ${rows.length} of ${data.length} records.`;
    // The API answers an unrecognised dimension value with HTTP 200 and an
    // empty array, so an empty result must name the valid values or it reads
    // as "no such trade" rather than "you misspelled a term".
    if (!rows.length) {
      summary += await ieaDiagnose("minerals", q,
        ["material", "category", "case", "flow", "scenario", "product", "region"],
        "Flow IDLE pairs with Material demand, while Mining and Refining pair with Material supply, and"
        + " region is only populated for Material supply — a mismatched pair is the usual cause.");
    }
    return {
      columns: ["Year", "Scenario", "Region", "Product", "Material", "Flow", "Value", "Unit"],
      rows, summary, endpoint: url,
    };
  },

  // IEA Global EV Data Explorer — the demand denominator for feedstock work.
  async m8(p) {
    const q = {
      parameter: p.parameter || "EV sales share",
      mode: p.mode || "Cars",
      powertrain: p.powertrain || "EV",
      region: p.region || "USA",
      category: p.category, year: p.year,
    };
    const { rows: data, url } = await ieaFetch("evs", q);
    data.sort((a, b) => (Number(a.year) - Number(b.year))
      || String(a.category).localeCompare(String(b.category)));
    const rows = data.slice(0, 300).map((x) => ({
      "Year": x.year, "Region": x.region, "Category": x.category, "Parameter": x.parameter,
      "Mode": x.mode, "Powertrain": x.powertrain, "Value": tidy(x.value), "Unit": x.unit,
    }));
    let summary = `${rows.length} IEA record(s): ${q.parameter}, ${q.mode}, ${q.powertrain}, ${q.region}`
      + `${q.category ? `, ${q.category}` : ""}${q.year ? `, ${q.year}` : ""}.`;
    const cats = [...new Set(data.map((x) => x.category).filter(Boolean))];
    if (cats.length > 1) summary += ` Spans ${cats.join(" and ")} — historical and projected values are in the same table, so filter by Category before quoting a trend.`;
    if (data.length > rows.length) summary += ` Showing the first ${rows.length} of ${data.length} records.`;
    if (!rows.length) {
      summary += await ieaDiagnose("evs", q,
        ["parameter", "mode", "powertrain", "region", "category"],
        "Not every parameter is published for every mode and powertrain — charging-point parameters pair"
        + " with mode EVSE, and the price series pair with the car-size modes rather than with Cars.");
    }
    return {
      columns: ["Year", "Region", "Category", "Parameter", "Mode", "Powertrain", "Value", "Unit"],
      rows, summary, endpoint: url,
    };
  },

  // FAST-41 Permitting Dashboard. The dashboard links its Socrata data portal
  // only as the word "HERE"; the SODA endpoint needs no app token.
  async m12(p) {
    const DATASETS = {
      "vcxp-6qfw": {
        label: "FAST-41 Covered Projects",
        columns: ["Project", "Sector", "State", "Lead agency", "Status"],
        map: (x) => ({
          "Project": x.project_title, "Sector": x.project_sector_type,
          "State": x.project_field_location_state,
          "Lead agency": x.project_field_project_lead_agency,
          "Status": x.project_field_project_status,
        }),
      },
      "mjka-7nez": {
        label: "FAST-41 Covered and Transparency Projects, with permitting milestones",
        columns: ["Project", "Sector", "State", "Status", "Action", "Milestone", "Target", "Complete", "Est. cost (USD)"],
        map: (x) => ({
          "Project": x.project_title, "Sector": x.project_sector_type,
          "State": x.project_field_location_state, "Status": x.project_field_project_status,
          "Action": x.action_type, "Milestone": x.action_milestone_name,
          "Target": (x.action_milestone_completion_target || "").slice(0, 10),
          "Complete": x.action_milestone_complete,
          "Est. cost (USD)": x.total_estimated_project_cost,
        }),
      },
    };
    const id = DATASETS[p.dataset] ? p.dataset : "vcxp-6qfw";
    const ds = DATASETS[id];
    const url = new URL(`https://data.permits.performance.gov/resource/${id}.json`);
    // SoQL string literals are single-quoted; doubling embedded quotes is the
    // documented escape and keeps a project name with an apostrophe from
    // breaking the clause.
    const lit = (s) => String(s).replace(/'/g, "''");
    const where = [];
    if (p.sector) where.push(`upper(project_sector_type) like upper('%${lit(p.sector)}%')`);
    if (p.state)  where.push(`upper(project_field_location_state) = upper('${lit(p.state)}')`);
    if (p.status) where.push(`upper(project_field_project_status) = upper('${lit(p.status)}')`);
    if (where.length) url.searchParams.set("$where", where.join(" AND "));
    const limit = Math.min(Math.max(Number(p.limit) || 25, 1), 200);
    url.searchParams.set("$limit", String(limit));
    url.searchParams.set("$order", "project_title");
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Permitting Dashboard returned HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const data = await res.json();
    const rows = data.map(ds.map);
    const filters = [p.sector && `sector like "${p.sector}"`, p.state && `state ${p.state}`, p.status && `status ${p.status}`]
      .filter(Boolean).join(", ");
    let summary = `${rows.length} record(s) from ${ds.label}${filters ? ` — filtered on ${filters}` : " — no filter"}.`;
    if (rows.length === limit) summary += ` The row cap of ${limit} was reached, so there may be more; raise the limit to see them.`;
    if (!rows.length) {
      const vocab = async (field) => {
        try {
          const u = new URL(`https://data.permits.performance.gov/resource/${id}.json`);
          u.searchParams.set("$select", `${field}, count(*) AS n`);
          u.searchParams.set("$group", field);
          u.searchParams.set("$order", "n DESC");
          u.searchParams.set("$limit", "12");
          const r = await fetch(u, { headers: { accept: "application/json" } });
          return r.ok ? (await r.json()).map((x) => `${x[field]} (${x.n})`) : [];
        } catch { return []; }
      };
      const [sectors, statuses] = await Promise.all([vocab("project_sector_type"), vocab("project_field_project_status")]);
      summary += " NO DATA RETURNED — the filters matched nothing."
        + ` Sectors present: ${sectors.join("; ")}.`
        + ` Statuses present: ${statuses.join("; ")}.`
        + " Sector matches on a substring, so \"Mining\" works but a full official label is not required.";
    }
    return { columns: ds.columns, rows, summary, endpoint: url.toString() };
  },

  // USGS Mineral Commodity Summaries — mining, refining and import-reliance
  // ground truth, refreshed every February.
  async m9(p) {
    const mcs = await usgsMcs();
    const has = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
    const commodity = String(p.commodity || "Lithium").trim();
    const statistic = String(p.statistic || "").trim();
    const country   = String(p.country || "").trim();
    const year      = String(p.year || "").trim();

    let hits = mcs.rows;
    if (commodity) hits = hits.filter((r) => has(r["Commodity"], commodity));
    const afterCommodity = hits.length;
    if (statistic) hits = hits.filter((r) => has(r["Statistics"], statistic) || has(r["Statistics_detail"], statistic));
    if (country)   hits = hits.filter((r) => has(r["Country"], country));
    if (year)      hits = hits.filter((r) => String(r["Year"]) === year);

    hits.sort((a, b) => String(a["Commodity"]).localeCompare(String(b["Commodity"]))
      || String(a["Statistics"]).localeCompare(String(b["Statistics"]))
      || String(a["Country"]).localeCompare(String(b["Country"]))
      || String(a["Year"]).localeCompare(String(b["Year"])));

    const limit = Math.min(Math.max(Number(p.limit) || 60, 1), 500);
    const shown = hits.slice(0, limit);
    const rows = shown.map((r) => ({
      "Commodity": r["Commodity"], "Country": r["Country"],
      "Statistic": r["Statistics"], "Detail": r["Statistics_detail"],
      "Year": r["Year"], "Value": r["Value"], "Unit": r["Unit"],
      "Note": (r["Notes"] || "").slice(0, 160),
    }));

    let summary = `${hits.length} USGS record(s) from Mineral Commodity Summaries ${mcs.year}`
      + ` — ${commodity || "all commodities"}`
      + `${statistic ? `, statistic matching "${statistic}"` : ""}`
      + `${country ? `, ${country}` : ""}${year ? `, ${year}` : ""}.`;
    if (hits.length > shown.length) summary += ` Showing the first ${shown.length}; raise the limit to see the rest.`;

    // Only explain the codes that actually appear, and never fold them into
    // the numbers: a withheld value is not a zero.
    const seen = [...new Set(shown.map((r) => r["Value"]).filter((v) => MCS_CODES[v]))];
    if (seen.length) {
      summary += " Non-numeric Value entries are USGS survey codes, not zeroes: "
        + seen.map((c) => `"${c}" = ${MCS_CODES[c]}`).join("; ") + ".";
    }
    if (!hits.length) {
      const commodities = [...new Set(mcs.rows.map((r) => r["Commodity"]))].sort();
      if (!afterCommodity) {
        const near = commodities.filter((c) => has(c, commodity.slice(0, 4)));
        summary += ` NO DATA RETURNED — no commodity matches "${commodity}".`
          + (near.length ? ` Did you mean: ${near.join(", ")}?` : "")
          + ` The release covers ${commodities.length} commodities; note that graphite is listed as "Graphite (Natural)" and rare earths as "Rare Earths" and "Rare Earths (Heavy)".`;
      } else {
        const stats = [...new Set(mcs.rows.filter((r) => has(r["Commodity"], commodity)).map((r) => r["Statistics"]))].sort();
        const countries = [...new Set(mcs.rows.filter((r) => has(r["Commodity"], commodity)).map((r) => r["Country"]))].sort();
        const years = [...new Set(mcs.rows.filter((r) => has(r["Commodity"], commodity)).map((r) => r["Year"]))].sort();
        summary += ` NO DATA RETURNED — "${commodity}" matched ${afterCommodity} row(s), so the commodity is fine and one of the other filters excluded everything.`
          + ` Statistics available for it: ${stats.join(", ")}.`
          + ` Countries: ${countries.slice(0, 25).join(", ")}${countries.length > 25 ? ", …" : ""}.`
          + ` Years: ${years.join(", ")}.`;
      }
    }
    return {
      columns: ["Commodity", "Country", "Statistic", "Detail", "Year", "Value", "Unit", "Note"],
      rows, summary,
      endpoint: `${mcs.landing} → ${mcs.fileName}`,
    };
  },
};

/* ---------------------------------------------------------------------------
   GENERIC DISPATCH. A model is runnable if it has either a hand-written HTTP
   runner or a declarative binding whose adapter is available on this machine.
   Adding a web model or a workbook means adding an entry to
   model-bindings.mjs — no code here changes.
   ------------------------------------------------------------------------ */
const ADAPTERS = {
  browser: (b, p) => runBrowser(b, p, { baseDir: here }),
  xlsx:    (b, p) => runXlsx(b, p,   { baseDir: here }),
  python:  (b, p) => runPython(b, p, { baseDir: here }),
};

function runnableModelIds() {
  return [...new Set([...Object.keys(RUNNERS), ...Object.keys(BINDINGS)])];
}

// Per-model readiness plus a human-readable reason when it is not ready, so
// the UI can explain precisely what is missing rather than just greying out.
function runnerReadiness() {
  const out = {};
  const reason = {};
  out.m10 = true;
  out.m11 = !!process.env.COMTRADE_API_KEY;
  if (!out.m11) reason.m11 = "Add COMTRADE_API_KEY to lodestone/.env";
  // Open APIs, no credential of any kind.
  out.m7 = true;
  out.m8 = true;
  out.m9 = true;
  out.m12 = true;
  for (const [id, b] of Object.entries(BINDINGS)) {
    if (b.adapter === "browser") {
      out[id] = browserAvailable();
      if (!out[id]) reason[id] = "Install Google Chrome, or set CHROME_PATH in lodestone/.env";
    } else if (b.adapter === "python") {
      out[id] = pythonReady(here, b);
      if (!out[id]) reason[id] = resolvePython(here, b)
        ? `Driver script missing at ${b.script}`
        : "Create the venv: cd lodestone/models && python3 -m venv --system-site-packages blast-venv && ./blast-venv/bin/pip install h5pyd geopy";
    } else if (b.adapter === "xlsx") {
      const present = workbookPresent(here, b);
      out[id] = present;
      if (!present) reason[id] = `Save the workbook to lodestone/${b.file}`;
      else if (!excelAvailable()) reason[id] = "Read-only: Microsoft Excel not found, so inputs cannot be recalculated";
    }
  }
  return { ready: out, reason };
}

// Parameter specs are served to the browser so the run form is generated from
// the binding — one source of truth for every model.
function paramSpecs() {
  const specs = {};
  for (const [id, b] of Object.entries(BINDINGS)) if (b.params) specs[id] = b.params;
  return specs;
}
function adapterModes() {
  const modes = {};
  for (const [id, b] of Object.entries(BINDINGS)) {
    modes[id] = b.adapter === "xlsx" ? xlsxMode(here, b) : b.adapter;
  }
  return modes;
}

async function executeModel(modelId, params) {
  if (RUNNERS[modelId]) return await RUNNERS[modelId](params || {});
  const binding = bindingFor(modelId);
  if (!binding) return null;
  const adapter = ADAPTERS[binding.adapter];
  if (!adapter) return null;
  return await adapter(binding, params || {});
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/assistant") {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4_000_000) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Request too large." }));
        return;
      }
    }
    let result;
    try {
      const body = JSON.parse(raw || "{}");
      result = await handleAssistant(body);
    } catch (e) {
      result = e instanceof SyntaxError
        ? { status: 400, json: { error: "Invalid JSON body." } }
        : assistantError(e);
    }
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.json));
    return;
  }

  // Lets the page discover what this deployment can actually do. The published
  // artifact gets no response at all, so its UI honestly reports "local only".
  if (req.method === "GET" && url.pathname === "/api/capabilities") {
    res.writeHead(200, { "content-type": "application/json" });
    const r = runnerReadiness();
    res.end(JSON.stringify({
      assistant: true,
      run: runnableModelIds(),
      ready: r.ready,
      reason: r.reason,
      params: paramSpecs(),
      adapters: adapterModes(),
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) { raw += chunk; if (raw.length > 200_000) break; }
    try {
      const { modelId, params } = JSON.parse(raw || "{}");
      const started = Date.now();
      const result = await executeModel(modelId, params);
      if (!result) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "This model has no execution adapter — record the run manually instead." }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...result, ms: Date.now() - started }));
    } catch (e) {
      const msg = e && (e.userFacing ? e.message : `Run failed: ${e.message}`);
      res.writeHead(e && e.userFacing ? 400 : 502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: msg || "Run failed." }));
    }
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = path.normalize(path.join(PUBLIC_DIR, file));
    if (!resolved.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let content = await readFile(resolved);
      if (resolved.endsWith("index.html")) {
        // Inject the assistant module without modifying the shared app file.
        content = Buffer.concat([content, Buffer.from('\n<script src="./assistant.js"></script>\n')]);
      }
      res.writeHead(200, { "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`LODESTONE running at http://localhost:${PORT}`);
  console.log(`Assistant models: claude-sonnet-5 (Q&A default), claude-opus-5 (red-team default)`);
  console.log(`Adapters — browser: ${browserAvailable() ? "ready (system Chrome)" : "no Chrome found"}; excel: ${excelAvailable() ? "ready" : "not found (workbooks read-only)"}; python: ${pythonReady(here, BINDINGS.m5 || {}) ? "ready (BLAST-Lite venv)" : "venv not set up"}`);
  console.log(`Daily spend limit: $${DAILY_LIMIT_USD.toFixed(2)} (spent today: $${todaySpend().toFixed(2)})`);
  if (!process.env.MY_ANTHROPIC_KEY) {
    console.log(
      "Note: MY_ANTHROPIC_KEY is not set (env or lodestone/.env). The UI will work; assistant calls will return a credentials error until it is set.",
    );
  }
});

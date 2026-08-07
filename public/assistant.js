"use strict";
/* LODESTONE assistant module (local deployment only).
   Loaded after the main app script; extends the Analyst view with a live
   LLM assistant (FR-A1 grounded Q&A, FR-A3 card proposals, FR-A5 red-team)
   backed by claude-sonnet-5 and claude-opus-5 via the local server proxy.
   Proposals never enter the board without explicit human acceptance. */

let aChat = [];   // {role:'user'|'assistant', text, mode?, model?, gaps?, proposals?, error?}
let aBusy = false;

const A_MODES = { qa: "Grounded Q&A", redteam: "Red-team" };

/* Turn the model's inline citations into real references — but only where the
   ID actually resolves. A hallucinated [F-99] renders as a broken reference
   rather than a confident-looking link, which makes the citation style double
   as a grounding check. Uses replacer FUNCTIONS: replacement strings would
   expand "$1"-style sequences inside the model's own prose. */
function linkifyRefs(text) {
  let out = esc(String(text == null ? "" : text));
  out = out.replace(/\[([A-Z]{1,3}-\d+)\]/g, (m, id) =>
    card(id) ? cardRef(id) : `<span class="ref ref-broken" data-tipmissing="${esc(id)}" tabindex="0">${esc(id)} ⚠</span>`);
  out = out.replace(/\((s\d+)\)/g, (m, sid) =>
    source(sid) ? sourceRef(sid) : `<span class="ref ref-broken" data-tipmissing="${esc(sid)}" tabindex="0">${esc(sid)} ⚠</span>`);
  return out;
}

function aPanelHTML() {
  const msgs = aChat.map((m, i) => {
    if (m.role === "user") {
      return `<div class="hit" style="border-left-color:var(--ink-3);background:var(--paper);"><span class="where">You · ${esc(A_MODES[m.mode] || "")}</span><br>${esc(m.text)}</div>`;
    }
    const props = (m.proposals || []).map((p, j) => {
      const cites = (p.citations || [])
        .map((c) => (source(c.sourceId) ? sourceRef(c.sourceId, { locator: c.locator }) : null))
        .filter(Boolean).join(" · ");
      const state = p._state;
      return `<div style="border:1px dashed var(--cobalt); border-radius:7px; padding:0.55rem 0.7rem; margin-top:0.5rem; ${state === "rejected" ? "opacity:0.45;" : ""}">
        <span class="ctype ${esc(p.type)}" style="margin-right:0.4rem;">${TYPES[p.type] ? TYPES[p.type].label : esc(p.type)}</span>
        <span class="conf-note">proposed · ${esc(p.confidence)}${cites ? ` · ${cites}` : ""}</span>
        <div style="font-size:0.82rem; margin-top:0.3rem;">${esc(p.statement)}</div>
        ${p.detail ? `<div style="font-size:0.74rem; color:var(--ink-2); margin-top:0.2rem;">${esc(p.detail)}</div>` : ""}
        <div style="display:flex; gap:0.4rem; margin-top:0.45rem;">
          ${state ? `<span class="conf-note">${esc(state)}${state === "accepted" && p._cardId ? " as " + cardRef(p._cardId) : ""}</span>` :
            `<button class="btn small primary" data-action="aAccept" data-i="${i}" data-j="${j}">Accept</button>
             <button class="btn small" data-action="aEditProp" data-i="${i}" data-j="${j}">Edit…</button>
             <button class="btn small danger" data-action="aRejectProp" data-i="${i}" data-j="${j}">Reject</button>`}
        </div>
      </div>`;
    }).join("");
    const gaps = (m.gaps || []).length
      ? `<div style="font-size:0.72rem; color:var(--copper); margin-top:0.4rem;"><b>Evidence gaps:</b> ${m.gaps.map(linkifyRefs).join(" · ")}</div>`
      : "";
    const cost = m.cost
      ? ` · ~$${m.cost.request_usd.toFixed(3)} (today: $${m.cost.today_usd.toFixed(2)} of $${m.cost.daily_limit_usd.toFixed(2)} cap)`
      : "";
    const meta = m.error ? "" :
      `<div style="font-size:0.66rem; color:var(--ink-3); margin-top:0.4rem;">${esc(m.model || "")}${m.usage ? ` · ${m.usage.input_tokens} in / ${m.usage.output_tokens} out${m.usage.cache_read_input_tokens ? ` · ${m.usage.cache_read_input_tokens} cached` : ""}` : ""}${esc(cost)}</div>`;
    return `<div class="hit" ${m.error ? 'style="border-left-color:var(--danger);background:var(--danger-soft);"' : ""}><span class="where">Assistant</span><br><div style="white-space:pre-wrap;">${linkifyRefs(m.text)}</div>${gaps}${props}${meta}</div>`;
  }).join("");

  return `<div class="panel" id="assistant-panel">
    <h3>Assistant — live (Claude Opus 5 / Sonnet 5)</h3>
    <p class="hint">Grounded in this workspace's cards, sources, and runs; citations reference card and source IDs. Proposed cards require your acceptance (FR-A1/A3/A5). Q&amp;A defaults to Sonnet 5, red-team to Opus 5.</p>
    <div id="aMsgs">${msgs || `<div class="empty">Ask a question (e.g. "What share of US lithium demand could recycling meet in 2035, and how solid is that number?") or run a red-team pass.</div>`}</div>
    ${aBusy ? `<div class="hit"><span class="where">Assistant</span><br><i>Thinking…</i></div>` : ""}
    <div style="display:flex; gap:0.5rem; margin-top:0.7rem; flex-wrap:wrap;">
      <select id="aMode" aria-label="Assistant mode">
        <option value="qa">Grounded Q&amp;A</option>
        <option value="redteam">Red-team</option>
      </select>
      <select id="aModel" aria-label="Model">
        <option value="auto">Model: auto</option>
        <option value="claude-sonnet-5">claude-sonnet-5</option>
        <option value="claude-opus-5">claude-opus-5</option>
      </select>
      <input type="text" id="aInput" style="flex:1; min-width:12rem;" placeholder="Ask about the evidence, or give the red-team a focus…" aria-label="Assistant input" ${aBusy ? "disabled" : ""}>
      <button class="btn primary" data-action="aSend" ${aBusy ? "disabled" : ""}>Send</button>
      <button class="btn" data-action="aClear" ${aBusy ? "disabled" : ""}>Clear</button>
    </div>
  </div>`;
}

// Extend the Analyst view: swap the "backend required" notice for the live
// panel, keep all deterministic audits below it.
const _baseViewAnalyst = viewAnalyst;
viewAnalyst = function () {
  const base = _baseViewAnalyst().replace(/<div class="notice">[\s\S]*?<\/div>/, "");
  // Replacer FUNCTION, not a replacement string: the panel contains user/model
  // text where "$1", "$&" etc. would otherwise be expanded as replace patterns.
  return base.replace(
    /<div class="view-head">[\s\S]*?<\/div>/,
    (head) => `${head}\n${aPanelHTML()}`
  );
};

async function aSend() {
  if (aBusy) return;
  const input = document.getElementById("aInput");
  const mode = document.getElementById("aMode").value;
  const model = document.getElementById("aModel").value;
  const q = (input.value || "").trim();
  if (!q && mode === "qa") { toast("Type a question first"); return; }

  const history = [];
  for (let k = 0; k < aChat.length - 1; k++) {
    if (aChat[k].role === "user" && aChat[k + 1].role === "assistant" && !aChat[k + 1].error) {
      history.push({ q: aChat[k].text, a: aChat[k + 1].text });
    }
  }

  aChat.push({ role: "user", text: q || "(red-team the current board)", mode });
  aBusy = true;
  render();

  try {
    const resp = await fetch("/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode, model, question: q, history,
        workspace: { ws: db.ws, cards: db.cards.filter(c => c.status !== "deprecated"), sources: db.sources, runs: db.runs },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      aChat.push({ role: "assistant", text: data.error || `Request failed (${resp.status})`, error: true });
    } else {
      // Drop proposal citations that reference nonexistent sources (rule 5 backstop).
      const proposals = (data.proposals || []).map(p => ({
        ...p,
        citations: (p.citations || []).filter(c => source(c.sourceId)),
      }));
      aChat.push({
        role: "assistant", text: data.answer || "(no answer)",
        gaps: data.evidence_gaps || [], proposals,
        model: data.model, usage: data.usage, cost: data.cost,
      });
    }
  } catch (e) {
    aChat.push({ role: "assistant", text: "Could not reach the local server — is `npm start` still running?", error: true });
  }
  aBusy = false;
  render();
  const el = document.getElementById("aInput");
  if (el) el.focus();
}

function proposalToDraft(p) {
  return {
    id: null,
    type: TYPES[p.type] ? p.type : "fact",
    statement: String(p.statement || "").slice(0, 600),
    detail: String(p.detail || ""),
    tags: (p.tags || []).map(t => String(t).toLowerCase().slice(0, 40)).slice(0, 8),
    confidence: CONF.includes(p.confidence) ? p.confidence : "unverified",
    status: "active",
    citations: (p.citations || []).filter(c => source(c.sourceId))
      .map(c => ({ sourceId: c.sourceId, locator: String(c.locator || "").slice(0, 100) })),
    links: [], criteria: [], owner: "",
    origin: "assistant-proposed",
  };
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  if (a === "aSend") { aSend(); }
  else if (a === "aClear") { aChat = []; render(); }
  else if (a === "aAccept" || a === "aEditProp" || a === "aRejectProp") {
    const m = aChat[+el.dataset.i];
    const p = m && (m.proposals || [])[+el.dataset.j];
    if (!p) return;
    if (a === "aRejectProp") { p._state = "rejected"; render(); }
    else if (a === "aAccept") {
      const c = proposalToDraft(p);
      c.id = uid(TYPES[c.type].prefix);
      c.created = today(); c.updated = today();
      db.cards.push(c); save();
      p._state = "accepted"; p._cardId = c.id;
      render(); toast(`Accepted as ${c.id}`);
    } else {
      p._state = "edited";
      draft = proposalToDraft(p);
      renderCardForm();
    }
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.id === "aInput") aSend();
});

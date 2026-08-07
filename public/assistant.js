"use strict";
/* LODESTONE assistant v2 — P1 + P2 (local deployment only).

   Design principle 7, interface parity: the assistant can see anything the
   user can see and do anything the user can do, through the SAME action
   layer the interface uses. P1 delivered reads and model execution; P2 adds
   mutations behind changesets — parity governs capability, principle 2
   governs commitment.

   Architecture (spec section 2.1): the workspace lives in this browser's
   localStorage, so the server cannot see it and tools cannot execute there.
   The browser therefore owns the conversation and the tool loop; the server
   makes exactly one Claude call per round-trip and stays stateless. */

let aChat = [];      // {role:'user'|'assistant', text, log?, error?, model?, usage?, cost?}
let aBusy = false;
let aOpen = true;
let aCtx = null;     // context chip: {kind:'card'|'model', id}
let aConv = [];      // raw Claude-format messages (the real conversation)

/* ============================================================================
   THE ACTIONS REGISTRY — parity made structural.
   One entry per capability. Tool schemas are GENERATED from this table, so a
   capability cannot exist for the user and silently not exist for the
   assistant. P1 registers reads and model execution; every entry here is
   something the user can already do through the interface.
   ========================================================================= */
const CAP = 60;   // list cap; results say so rather than silently truncating

function cap(list, mapFn) {
  const total = list.length;
  const items = list.slice(0, CAP).map(mapFn);
  return total > CAP ? { items, truncated: true, total, showing: items.length } : { items, total };
}
function cardBrief(c) {
  return { id: c.id, type: c.type, statement: c.statement, confidence: effConfidence(c),
           status: c.status, tags: c.tags, sources: c.citations.length };
}
function cardFull(c) {
  return {
    id: c.id, type: c.type, statement: c.statement, detail: c.detail,
    confidence: effConfidence(c), declared_confidence: c.confidence, status: c.status,
    tags: c.tags, criteria: (c.criteria || []).map(i => db.ws.criteria[i]).filter(Boolean),
    citations: c.citations.map(x => {
      const s = source(x.sourceId);
      return { sourceId: x.sourceId, locator: x.locator, title: s ? s.title : null, resolves: !!s };
    }),
    links: c.links.map(l => ({ rel: l.rel, to: l.to, resolves: !!card(l.to) })),
    created: c.created, updated: c.updated,
    createdBy: c.createdBy || c.origin || null, updatedBy: c.updatedBy || null,
  };
}

/* ============================================================================
   P2 — CHANGESETS. Commitment governance, distinct from capability.

   Parity says the assistant may act; principle 2 says durable change is the
   user's to commit. So mutations execute through the SAME validation the
   interface uses, but accumulate into a changeset: named, atomic, reviewable
   per-operation, revertible.

   In `staged` mode ops apply to db immediately but are flagged pending, so
   the assistant can see its own work and the user watches edits land live —
   then Accept clears the flags or Reject runs the inverses. In `apply` mode
   ops land unflagged and the journal keeps inverses for Revert. Either way
   the inverse is computed at execution time, when the prior state is known.
   ========================================================================= */
let aChangeset = null;    // the changeset being built by the current turn

function newChangeset(task) {
  return { id: uid("cs"), task: task || "assistant edits", actor: (assistantActor() || {}).id || null,
           created: today(), status: "staged", approvedBy: null, ops: [] };
}
function pendingOps() { return aChangeset && aChangeset.status === "staged" ? aChangeset.ops.filter(o => o.status === "pending") : []; }
function isPending(kind, id) { return pendingOps().some(o => o.targets && o.targets[kind] === id); }
function pendingLink(fromId, toId) {
  return pendingOps().some(o => o.action === "link_cards" && o.targets.from === fromId && o.targets.to === toId);
}

// Record an op with its inverse, computed now while the prior state is known.
function recordOp(action, params, targets, inverse, describe) {
  if (!aChangeset) aChangeset = newChangeset();
  const staged = (db.settings.approvalMode || "staged") === "staged";
  aChangeset.ops.push({ action, params, targets, inverse, describe,
                        status: staged ? "pending" : "applied" });
  save();
}

function applyInverse(op) {
  const inv = op.inverse;
  if (!inv) return false;
  if (inv.kind === "removeCard") { const i = db.cards.findIndex(c => c.id === inv.id); if (i >= 0) db.cards.splice(i, 1); return true; }
  if (inv.kind === "removeSource") { const i = db.sources.findIndex(s => s.id === inv.id); if (i >= 0) db.sources.splice(i, 1); return true; }
  if (inv.kind === "restoreCard") { const i = db.cards.findIndex(c => c.id === inv.card.id); if (i >= 0) db.cards[i] = JSON.parse(JSON.stringify(inv.card)); return true; }
  if (inv.kind === "restoreSource") { const i = db.sources.findIndex(s => s.id === inv.source.id); if (i >= 0) db.sources[i] = JSON.parse(JSON.stringify(inv.source)); return true; }
  if (inv.kind === "removeLink") { const c = card(inv.from); if (c) c.links = c.links.filter(l => !(l.to === inv.to && l.rel === inv.rel)); return true; }
  if (inv.kind === "restoreLink") { const c = card(inv.from); if (c && !c.links.some(l => l.to === inv.link.to && l.rel === inv.link.rel)) c.links.push({ ...inv.link }); return true; }
  if (inv.kind === "removeList") { const i = db.lists.findIndex(l => l.id === inv.id); if (i >= 0) db.lists.splice(i, 1); return true; }
  if (inv.kind === "removeFromList") { const l = db.lists.find(x => x.id === inv.listId); if (l) l.items = l.items.filter(i => i.sourceId !== inv.sourceId); return true; }
  if (inv.kind === "restoreToList") { const l = db.lists.find(x => x.id === inv.listId); if (l) l.items.splice(inv.index, 0, inv.item); return true; }
  if (inv.kind === "reorderList") { const l = db.lists.find(x => x.id === inv.listId); if (l) { const [it] = l.items.splice(inv.from, 1); l.items.splice(inv.to, 0, it); } return true; }
  if (inv.kind === "removeCite") { const c = card(inv.cardId); if (c) { const i = c.citations.findIndex(x => x.sourceId === inv.sourceId && x.locator === inv.locator); if (i >= 0) c.citations.splice(i, 1); } return true; }
  return false;
}

// Accept/reject/revert. Per-operation, because a justification changeset may
// contain four good links and one bad card.
function csAccept(indices) {
  if (!aChangeset) return;
  const take = indices || aChangeset.ops.map((_, i) => i);
  let n = 0;
  take.forEach(i => { const o = aChangeset.ops[i]; if (o && o.status === "pending") { o.status = "accepted"; n++; } });
  // Anything still pending after a partial accept is rejected — leaving ops in
  // limbo would make the board's state unreadable.
  aChangeset.ops.forEach(o => { if (o.status === "pending") { applyInverse(o); o.status = "rejected"; } });
  aChangeset.status = "applied";
  aChangeset.approvedBy = actorId();
  if (!db.journal) db.journal = [];
  db.journal.unshift(aChangeset);
  db.journal = db.journal.slice(0, 50);
  aChangeset = null;
  save(); render();
  toast(`${n} change${n === 1 ? "" : "s"} accepted`);
}
function csReject() {
  if (!aChangeset) return;
  // Reverse order: later ops may depend on earlier ones.
  for (let i = aChangeset.ops.length - 1; i >= 0; i--) {
    const o = aChangeset.ops[i];
    if (o.status === "pending" || o.status === "applied") { applyInverse(o); o.status = "rejected"; }
  }
  aChangeset.status = "reverted";
  if (!db.journal) db.journal = [];
  db.journal.unshift(aChangeset);
  db.journal = db.journal.slice(0, 50);
  aChangeset = null;
  save(); render();
  toast("Changes rejected and undone");
}

/* Mutation helper: validate exactly as the interface does, then record. */
function mutOK(v, msg) { return v ? null : { error: msg }; }

/* ============================================================================
   P3 — PARITY AUDIT. Principle 7 says a capability withheld from the assistant
   must be a documented exception rather than an accident. This makes that
   checkable: every interface action is classified, and anything that mutates
   the workspace without an assistant equivalent is reported as a real gap.
   The audit is deliberately capable of failing — an audit that cannot fail
   would be decoration.
   ========================================================================= */
const PARITY_MAP = {
  // interface action  ->  assistant action it corresponds to
  newCard: "create_card", saveCard: "create_card/update_card", editCard: "update_card",
  deprecateCard: "deprecate_card", addLinkFromTrace: "link_cards",
  draftAddLink: "link_cards", draftRmLink: "unlink_cards",
  draftAddCite: "cite", draftRmCite: "cite",
  newSource: "add_source", saveSource: "add_source", editSource: "update_source",
  newList: "create_list", listAdd: "add_to_list", listRemove: "remove_from_list",
  listMove: "reorder_list",
  promoteRun: "promote_run", runNow: "run_model", doRun: "run_model",
  runSearch: "list_cards/list_sources", trace: "get_justification",
  sourceDetail: "get_source", navaudit: "run_audit", viewRun: "get_run",
  gotoRun: "get_run", recordRun: "run_model",

  // navigation, filtering, dialogs and rendering: no state to mutate, and the
  // assistant reads directly rather than "navigating"
  nav: "ui-only", navtype: "ui-only", ftype: "ui-only", ftag: "ui-only",
  closeDlg: "ui-only", traceBack: "ui-only", traceCrumb: "ui-only",
  showOnBoard: "ui-only", briefToggle: "ui-only", briefAll: "ui-only",
  briefNone: "ui-only", genBrief: "ui-only",
  aSend: "ui-only", aClear: "ui-only", aToggle: "ui-only", aCtxClear: "ui-only",
  aJustify: "ui-only", aConclude: "ui-only", csGoto: "ui-only",

  // documented exceptions (spec section 1.2) — withheld on purpose
  dlJson: "exception:export", dlMemo: "exception:export", dlBiblio: "exception:export",
  resetSeed: "exception:destructive", saveWs: "exception:governance",
  saveAsst: "exception:governance",
  csAcceptAll: "exception:governance", csAcceptSel: "exception:governance",
  csReject: "exception:governance",

  // Deletion. LODESTONE's own idiom for cards is deprecate-not-delete — there
  // is no delete-card action at all — because losing evidence is not the same
  // kind of act as adding it. The assistant may create and deprecate; removing
  // material outright stays the user's.
  delSource: "exception:destructive", delRun: "exception:destructive",
  delList: "exception:destructive",

  // Manual run capture is a human transcription act: "I ran this elsewhere,
  // here is what it returned". Letting a model hand-write a run record it did
  // not execute is precisely the fabrication run_model exists to prevent.
  saveRun: "exception:fabrication-risk",
};

// The audit must see every action the interface can render, not merely those
// on screen when it runs — actions living in dialogs or other views would
// otherwise be invisible and the audit would pass vacuously. The client reads
// its own source to enumerate them.
let uiActionSet = null;
async function scanUiActions() {
  try {
    const files = ["index.html", "assistant.js"];
    const found = new Set();
    for (const f of files) {
      const r = await fetch(f, { cache: "no-store" });
      if (!r.ok) continue;
      const txt = await r.text();
      for (const m of txt.matchAll(/data-action="([a-zA-Z]+)"/g)) found.add(m[1]);
    }
    if (found.size) uiActionSet = found;
  } catch (e) { /* fall back to the DOM scan */ }
  if (view === "analyst") render();
}

function parityAudit() {
  const declared = new Set();
  if (uiActionSet) uiActionSet.forEach(a => declared.add(a));
  else document.querySelectorAll("[data-action]").forEach(el => declared.add(el.dataset.action));
  Object.keys(PARITY_MAP).forEach(k => declared.add(k));

  const covered = [], uiOnly = [], exceptions = [], gaps = [];
  for (const act of [...declared].sort()) {
    const m = PARITY_MAP[act];
    if (!m) gaps.push({ action: act, why: "No entry in PARITY_MAP — classify it, or give the assistant an equivalent action." });
    else if (m === "ui-only") uiOnly.push(act);
    else if (String(m).startsWith("exception:")) exceptions.push({ action: act, reason: String(m).split(":")[1] });
    else {
      const names = String(m).split("/");
      const missing = names.filter(n => !ACTIONS[n]);
      if (missing.length) gaps.push({ action: act, why: `Maps to ${missing.join(", ")}, which is not in the ACTIONS registry.` });
      else covered.push({ action: act, via: m });
    }
  }
  // The reverse direction: assistant capability the interface cannot reach.
  const mapped = new Set(Object.values(PARITY_MAP).flatMap(v => String(v).split("/")));
  const assistantOnly = Object.keys(ACTIONS).filter(a => !mapped.has(a));
  return { covered, uiOnly, exceptions, gaps, assistantOnly,
           pass: gaps.length === 0, total: declared.size,
           complete: !!uiActionSet };
}

const ACTIONS = {
  get_workspace: {
    kind: "read",
    desc: "The decision question this workspace exists to answer, its title, and its decision criteria. Read this first when the task concerns the workspace as a whole.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ title: db.ws.title, question: db.ws.question, criteria: db.ws.criteria,
                  counts: { cards: db.cards.length, sources: db.sources.length, runs: db.runs.length } }),
  },

  list_cards: {
    kind: "read",
    desc: "List evidence cards, optionally filtered. Returns brief records; call get_card for full detail including links and citations.",
    schema: { type: "object", properties: {
      type: { type: "string", enum: Object.keys(TYPES), description: "Card type" },
      tag: { type: "string", description: "Exact tag match" },
      q: { type: "string", description: "Free-text search over statement, detail and tags" },
      status: { type: "string", enum: ["active", "investigating", "answered", "deprecated"] },
      include_deprecated: { type: "boolean", description: "Default false" },
    }, additionalProperties: false },
    run: (p) => {
      const q = (p.q || "").toLowerCase();
      let list = db.cards.filter(c => {
        if (!p.include_deprecated && !p.status && c.status === "deprecated") return false;
        if (p.status && c.status !== p.status) return false;
        if (p.type && c.type !== p.type) return false;
        if (p.tag && !c.tags.includes(p.tag)) return false;
        if (q && !(c.statement + " " + c.detail + " " + c.tags.join(" ")).toLowerCase().includes(q)) return false;
        return true;
      });
      return cap(list, cardBrief);
    },
  },

  get_card: {
    kind: "read",
    desc: "Full detail for one card: statement, detail, confidence, tags, criteria, citations with locators, and outgoing links.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: (p) => {
      const c = card(p.id);
      if (!c) return { error: `No card ${p.id} in this workspace.` };
      return cardFull(c);
    },
  },

  get_justification: {
    kind: "read",
    desc: "The justification for a card: what supports it, what conflicts with it, and the inverse trace (which cards depend on it — i.e. what breaks if this card is wrong). This is the same data the Justification panel renders for the user.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: (p) => {
      const c = card(p.id);
      if (!c) return { error: `No card ${p.id} in this workspace.` };
      const out = { card: cardFull(c), supported_by: [], conflicts_with: [], depended_on_by: [], informed_by: [] };
      for (const l of c.links) {
        const t = card(l.to); if (!t) continue;
        const rec = { ...cardBrief(t), rel: l.rel };
        if (l.rel === "conflicts-with") out.conflicts_with.push(rec); else out.supported_by.push(rec);
      }
      // Inverse trace: who points AT this card.
      for (const o of db.cards) {
        for (const l of (o.links || [])) {
          if (l.to !== c.id) continue;
          const rec = { ...cardBrief(o), rel: l.rel };
          if (l.rel === "conflicts-with") out.conflicts_with.push(rec);
          else if (l.rel === "depends-on") out.depended_on_by.push(rec);
          else out.informed_by.push(rec);
        }
      }
      return out;
    },
  },

  list_sources: {
    kind: "read",
    desc: "List reading-library sources, optionally filtered by free text or access level.",
    schema: { type: "object", properties: {
      q: { type: "string" },
      access: { type: "string", enum: ["open", "registration", "paywall"] },
      kind: { type: "string", description: "e.g. report, paper, dataset, news, filing" },
    }, additionalProperties: false },
    run: (p) => {
      const q = (p.q || "").toLowerCase();
      const list = db.sources.filter(s => {
        if (p.access && s.access !== p.access) return false;
        if (p.kind && s.kind !== p.kind) return false;
        if (q && !((s.title + " " + s.author + " " + s.notes).toLowerCase().includes(q))) return false;
        return true;
      });
      return cap(list, s => ({ id: s.id, kind: s.kind, title: s.title, author: s.author,
                               date: s.date, access: s.access, cited_by: citingCards(s.id).length }));
    },
  },

  get_source: {
    kind: "read",
    desc: "Full detail for one source, including its notes, URL, and which cards cite it.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: (p) => {
      const s = source(p.id);
      if (!s) return { error: `No source ${p.id} in this workspace.` };
      return { ...s, cited_by: citingCards(s.id).map(c => c.id),
               possibly_superseded: staleSources().some(x => x.id === s.id) };
    },
  },

  list_models: {
    kind: "read",
    desc: "The model registry: every registered external model, whether LODESTONE can run it right now on this machine, why not if it cannot, and the exact parameters run_model accepts.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ items: db.models.map(m => {
      const spec = modelRun(m.id);
      return { id: m.id, name: m.name, publisher: m.pub, what: m.what,
               runnable_now: modelRunnableNow(m.id),
               why_not: modelRunnableNow(m.id) ? null : (modelReason(m.id) || "Not runnable in this deployment"),
               parameters: (spec.params || []).map(x => ({ name: x.name, description: x.label, default: x.value })) };
    }) }),
  },

  list_runs: {
    kind: "read",
    desc: "Recorded model runs, newest first, with their parameters and output summaries.",
    schema: { type: "object", properties: { modelId: { type: "string" } }, additionalProperties: false },
    run: (p) => {
      const list = db.runs.filter(r => !p.modelId || r.modelId === p.modelId).slice().reverse();
      return cap(list, r => ({ id: r.id, modelId: r.modelId, name: r.name, params: r.params,
                               outputs: String(r.outputs || "").slice(0, 700), date: r.date, runner: r.runner }));
    },
  },

  get_run: {
    kind: "read",
    desc: "One recorded run in full, including its result table.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: (p) => {
      const r = db.runs.find(x => x.id === p.id);
      if (!r) return { error: `No run ${p.id}.` };
      const res = r.result || {};
      return { id: r.id, modelId: r.modelId, params: r.params, summary: res.summary || r.outputs,
               endpoint: res.endpoint, extraction: res.extraction, date: r.date,
               columns: res.columns, rows: (res.rows || []).slice(0, 40) };
    },
  },

  run_audit: {
    kind: "read",
    desc: "Run a deterministic audit over the board. These are computed in code, not judged by a model, so their answers are exact.",
    schema: { type: "object", properties: { which: { type: "string",
      enum: ["uncited", "single_source", "conflicts", "stale_sources", "criteria_gaps", "broken_refs"] } },
      required: ["which"], additionalProperties: false },
    run: (p) => {
      if (p.which === "uncited") return { items: needsSourcing().map(cardBrief) };
      if (p.which === "single_source") return { items: singleSource().map(cardBrief) };
      if (p.which === "stale_sources") return { items: staleSources().map(s => ({ id: s.id, title: s.title, date: s.date, notes: s.notes })) };
      if (p.which === "broken_refs") {
        const g = graphHealth();
        // Summarize: graphHealth returns whole card objects, which would flood
        // the tool result with detail the model can fetch on demand.
        return { orphans: g.orphans.map(cardBrief), unjustified: g.unjustified.map(cardBrief),
                 inert_assumptions: g.inert.map(cardBrief),
                 dangling_links: db.cards.flatMap(c => (c.links || [])
                   .filter(l => !card(l.to)).map(l => ({ from: c.id, to: l.to, rel: l.rel }))),
                 dangling_citations: db.cards.flatMap(c => (c.citations || [])
                   .filter(x => !source(x.sourceId)).map(x => ({ card: c.id, sourceId: x.sourceId }))) };
      }
      if (p.which === "conflicts") {
        return { items: openConflicts().map(pair => (Array.isArray(pair)
          ? { a: cardBrief(pair[0]), b: cardBrief(pair[1]) }
          : cardBrief(pair))) };
      }
      // criteria_gaps: which decision criteria no active card claims to bear on
      return { items: db.ws.criteria.map((label, i) => ({
        index: i, criterion: label,
        supporting_cards: db.cards.filter(c => c.status !== "deprecated" && (c.criteria || []).includes(i)).map(c => c.id),
      })).filter(x => x.supporting_cards.length === 0) };
    },
  },

  list_actors: {
    kind: "read",
    desc: "The actor registry: who can make edits in this workspace, human or LLM, and the canonical name each edit is credited to.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ items: actors(), active_human: (activeActor() || {}).id, you: (assistantActor() || {}).id }),
  },

  /* ---- mutations (P2). Each validates as the interface does, stamps the
     acting actor, and records an inverse so the change is revertible. ---- */

  create_card: {
    kind: "mutate",
    desc: "Create a new evidence card. Statement must be one sentence a reader could accept verbatim. Cite sources that genuinely support it — citations are validated and an unknown source id is refused.",
    schema: { type: "object", properties: {
      type: { type: "string", enum: Object.keys(TYPES) },
      statement: { type: "string" },
      detail: { type: "string", description: "Caveats, method, what would change this" },
      confidence: { type: "string", enum: CONF },
      tags: { type: "array", items: { type: "string" } },
      citations: { type: "array", items: { type: "object", properties: {
        sourceId: { type: "string" }, locator: { type: "string", description: "page, table, or query" } },
        required: ["sourceId"], additionalProperties: false } },
      links: { type: "array", items: { type: "object", properties: {
        to: { type: "string" }, rel: { type: "string", enum: RELS } },
        required: ["to", "rel"], additionalProperties: false } },
    }, required: ["type", "statement", "confidence"], additionalProperties: false },
    run: (p) => {
      if (!TYPES[p.type]) return { error: `Unknown card type "${p.type}".` };
      if (!String(p.statement || "").trim()) return { error: "statement is required." };
      if (!CONF.includes(p.confidence)) return { error: `confidence must be one of: ${CONF.join(", ")}.` };
      const badCite = (p.citations || []).find(c => !source(c.sourceId));
      if (badCite) return { error: `No source ${badCite.sourceId} in this workspace — add_source first, or cite an existing one. Never cite an id that does not exist.` };
      const badLink = (p.links || []).find(l => !card(l.to));
      if (badLink) return { error: `No card ${badLink.to} to link to.` };
      const c = {
        id: uid(TYPES[p.type].prefix), type: p.type,
        statement: String(p.statement).slice(0, 600), detail: String(p.detail || ""),
        tags: (p.tags || []).map(t => String(t).toLowerCase().slice(0, 40)).slice(0, 8),
        confidence: p.confidence, status: "active",
        citations: (p.citations || []).map(c2 => ({ sourceId: c2.sourceId, locator: String(c2.locator || "").slice(0, 140) })),
        links: (p.links || []).map(l => ({ to: l.to, rel: l.rel })),
        criteria: [], owner: "", origin: "assistant",
        created: today(), updated: today(),
        createdBy: (assistantActor() || {}).id, updatedBy: (assistantActor() || {}).id,
      };
      db.cards.push(c);
      recordOp("create_card", p, { card: c.id }, { kind: "removeCard", id: c.id },
               `Create ${c.id} (${TYPES[c.type].label}) — “${c.statement.slice(0, 70)}${c.statement.length > 70 ? "…" : ""}”`);
      return { created: c.id, note: "Pending your user's review if approval mode is staged." };
    },
  },

  update_card: {
    kind: "mutate",
    desc: "Change fields on an existing card. Only the fields you pass are changed.",
    schema: { type: "object", properties: {
      id: { type: "string" },
      statement: { type: "string" }, detail: { type: "string" },
      confidence: { type: "string", enum: CONF },
      tags: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["active", "investigating", "answered"] },
      reason: { type: "string", description: "Why this change — shown to the user in review" },
    }, required: ["id"], additionalProperties: false },
    run: (p) => {
      const c = card(p.id);
      if (!c) return { error: `No card ${p.id}.` };
      const before = JSON.parse(JSON.stringify(c));
      const changed = [];
      if (p.statement !== undefined) { c.statement = String(p.statement).slice(0, 600); changed.push("statement"); }
      if (p.detail !== undefined) { c.detail = String(p.detail); changed.push("detail"); }
      if (p.confidence !== undefined) { c.confidence = p.confidence; changed.push(`confidence → ${p.confidence}`); }
      if (p.tags !== undefined) { c.tags = p.tags.map(t => String(t).toLowerCase().slice(0, 40)).slice(0, 8); changed.push("tags"); }
      if (p.status !== undefined) { c.status = p.status; changed.push(`status → ${p.status}`); }
      if (!changed.length) return { error: "Nothing to change — pass at least one field." };
      c.updated = today(); c.updatedBy = (assistantActor() || {}).id;
      recordOp("update_card", p, { card: c.id }, { kind: "restoreCard", card: before },
               `Update ${c.id}: ${changed.join(", ")}${p.reason ? ` — ${p.reason}` : ""}`);
      return { updated: c.id, changed };
    },
  },

  deprecate_card: {
    kind: "mutate",
    desc: "Deprecate a card — kept for the record but excluded from views and briefs. Use when a claim is superseded rather than merely weak.",
    schema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"], additionalProperties: false },
    run: (p) => {
      const c = card(p.id);
      if (!c) return { error: `No card ${p.id}.` };
      const before = JSON.parse(JSON.stringify(c));
      c.status = "deprecated";
      c.detail = (c.detail ? c.detail + "\n\n" : "") + `Deprecated: ${p.reason}`;
      c.updated = today(); c.updatedBy = (assistantActor() || {}).id;
      recordOp("deprecate_card", p, { card: c.id }, { kind: "restoreCard", card: before },
               `Deprecate ${c.id} — ${p.reason}`);
      return { deprecated: c.id };
    },
  },

  link_cards: {
    kind: "mutate",
    desc: "Create a typed link between two cards. Use conflicts-with when evidence genuinely disagrees — divergence is content, not noise, and must be recorded rather than smoothed over.",
    schema: { type: "object", properties: {
      from: { type: "string" }, to: { type: "string" },
      rel: { type: "string", enum: RELS },
    }, required: ["from", "to", "rel"], additionalProperties: false },
    run: (p) => {
      const a = card(p.from), b2 = card(p.to);
      if (!a) return { error: `No card ${p.from}.` };
      if (!b2) return { error: `No card ${p.to}.` };
      if (p.from === p.to) return { error: "A card cannot link to itself." };
      if (!RELS.includes(p.rel)) return { error: `rel must be one of: ${RELS.join(", ")}.` };
      if (a.links.some(l => l.to === p.to && l.rel === p.rel)) return { error: `${p.from} already ${p.rel} ${p.to}.` };
      a.links.push({ to: p.to, rel: p.rel });
      a.updated = today(); a.updatedBy = (assistantActor() || {}).id;
      recordOp("link_cards", p, { card: p.from, from: p.from, to: p.to },
               { kind: "removeLink", from: p.from, to: p.to, rel: p.rel },
               `Link ${p.from} —${p.rel}→ ${p.to}`);
      return { linked: `${p.from} ${p.rel} ${p.to}` };
    },
  },

  unlink_cards: {
    kind: "mutate",
    desc: "Remove a link between two cards.",
    schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, rel: { type: "string" } },
      required: ["from", "to"], additionalProperties: false },
    run: (p) => {
      const a = card(p.from);
      if (!a) return { error: `No card ${p.from}.` };
      const i = a.links.findIndex(l => l.to === p.to && (!p.rel || l.rel === p.rel));
      if (i < 0) return { error: `No link from ${p.from} to ${p.to}.` };
      const [gone] = a.links.splice(i, 1);
      a.updated = today(); a.updatedBy = (assistantActor() || {}).id;
      recordOp("unlink_cards", p, { card: p.from },
               { kind: "restoreLink", from: p.from, link: gone },
               `Unlink ${p.from} —${gone.rel}→ ${p.to}`);
      return { unlinked: `${p.from} ${gone.rel} ${p.to}` };
    },
  },

  cite: {
    kind: "mutate",
    desc: "Attach a citation to a card, with a locator naming the page, table, or query. Locator-level citation is what makes a claim re-derivable, so always give one.",
    schema: { type: "object", properties: {
      cardId: { type: "string" }, sourceId: { type: "string" },
      locator: { type: "string", description: "e.g. 'Table 3', 'p. 12', or the exact model query" },
    }, required: ["cardId", "sourceId", "locator"], additionalProperties: false },
    run: (p) => {
      const c = card(p.cardId);
      if (!c) return { error: `No card ${p.cardId}.` };
      if (!source(p.sourceId)) return { error: `No source ${p.sourceId} in this workspace.` };
      if (c.citations.some(x => x.sourceId === p.sourceId && x.locator === p.locator)) return { error: "That citation is already on the card." };
      c.citations.push({ sourceId: p.sourceId, locator: String(p.locator).slice(0, 140) });
      c.updated = today(); c.updatedBy = (assistantActor() || {}).id;
      recordOp("cite", p, { card: p.cardId },
               { kind: "removeCite", cardId: p.cardId, sourceId: p.sourceId, locator: String(p.locator).slice(0, 140) },
               `Cite ${p.cardId} → ${p.sourceId} (${p.locator})`);
      return { cited: `${p.cardId} → ${p.sourceId}` };
    },
  },

  add_source: {
    kind: "mutate",
    desc: "Add a source to the reading library. Only add a source you can name accurately — never invent bibliographic detail.",
    schema: { type: "object", properties: {
      kind: { type: "string", description: "report, paper, dataset, news, filing, model run" },
      title: { type: "string" }, author: { type: "string" }, date: { type: "string" },
      url: { type: "string" }, access: { type: "string", enum: ["open", "registration", "paywall"] },
      notes: { type: "string" },
    }, required: ["kind", "title"], additionalProperties: false },
    run: (p) => {
      const s = { id: uid("s"), kind: p.kind, title: p.title, author: p.author || "",
                  date: p.date || "", url: p.url || "", access: p.access || "open",
                  notes: p.notes || "", addedAt: today(),
                  createdBy: (assistantActor() || {}).id };
      db.sources.push(s);
      recordOp("add_source", p, { source: s.id }, { kind: "removeSource", id: s.id },
               `Add source ${s.id} — “${String(s.title).slice(0, 60)}”`);
      return { created: s.id };
    },
  },

  create_list: {
    kind: "mutate",
    desc: "Create a reading list — an ordered, annotated subset of the library for a purpose (e.g. 'core techno-economics, read before the panel').",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
    run: (p) => {
      const title = String(p.title || "").trim();
      if (!title) return { error: "title is required." };
      const l = { id: uid("rl"), title, items: [], createdBy: (assistantActor() || {}).id };
      db.lists.push(l);
      recordOp("create_list", p, { list: l.id }, { kind: "removeList", id: l.id }, `Create reading list “${title}”`);
      return { created: l.id };
    },
  },

  add_to_list: {
    kind: "mutate",
    desc: "Add a source to a reading list, with a note saying why it is worth reading.",
    schema: { type: "object", properties: {
      listId: { type: "string" }, sourceId: { type: "string" },
      note: { type: "string", description: "Why this one matters, for the reader" },
    }, required: ["listId", "sourceId"], additionalProperties: false },
    run: (p) => {
      const l = db.lists.find(x => x.id === p.listId);
      if (!l) return { error: `No reading list ${p.listId}.` };
      if (!source(p.sourceId)) return { error: `No source ${p.sourceId}.` };
      if (l.items.some(i => i.sourceId === p.sourceId)) return { error: `${p.sourceId} is already on that list.` };
      l.items.push({ sourceId: p.sourceId, note: String(p.note || "") });
      recordOp("add_to_list", p, { list: l.id }, { kind: "removeFromList", listId: l.id, sourceId: p.sourceId },
               `Add ${p.sourceId} to “${l.title}”`);
      return { added: p.sourceId, list: l.id };
    },
  },

  remove_from_list: {
    kind: "mutate",
    desc: "Remove a source from a reading list. The source stays in the library.",
    schema: { type: "object", properties: { listId: { type: "string" }, sourceId: { type: "string" } },
      required: ["listId", "sourceId"], additionalProperties: false },
    run: (p) => {
      const l = db.lists.find(x => x.id === p.listId);
      if (!l) return { error: `No reading list ${p.listId}.` };
      const i = l.items.findIndex(x => x.sourceId === p.sourceId);
      if (i < 0) return { error: `${p.sourceId} is not on that list.` };
      const [gone] = l.items.splice(i, 1);
      recordOp("remove_from_list", p, { list: l.id }, { kind: "restoreToList", listId: l.id, index: i, item: gone },
               `Remove ${p.sourceId} from “${l.title}”`);
      return { removed: p.sourceId };
    },
  },

  reorder_list: {
    kind: "mutate",
    desc: "Move a source up or down a reading list. Order carries meaning — it is the reading sequence.",
    schema: { type: "object", properties: {
      listId: { type: "string" }, sourceId: { type: "string" },
      direction: { type: "string", enum: ["up", "down"] },
    }, required: ["listId", "sourceId", "direction"], additionalProperties: false },
    run: (p) => {
      const l = db.lists.find(x => x.id === p.listId);
      if (!l) return { error: `No reading list ${p.listId}.` };
      const i = l.items.findIndex(x => x.sourceId === p.sourceId);
      if (i < 0) return { error: `${p.sourceId} is not on that list.` };
      const j = p.direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= l.items.length) return { error: `${p.sourceId} is already at that end of the list.` };
      const [it] = l.items.splice(i, 1); l.items.splice(j, 0, it);
      recordOp("reorder_list", p, { list: l.id }, { kind: "reorderList", listId: l.id, from: j, to: i },
               `Move ${p.sourceId} ${p.direction} in “${l.title}”`);
      return { moved: p.sourceId, position: j };
    },
  },

  update_source: {
    kind: "mutate",
    desc: "Correct or extend a library source's metadata or notes. Only the fields you pass are changed.",
    schema: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" }, author: { type: "string" },
      date: { type: "string" }, url: { type: "string" },
      access: { type: "string", enum: ["open", "registration", "paywall"] },
      notes: { type: "string" }, reason: { type: "string" },
    }, required: ["id"], additionalProperties: false },
    run: (p) => {
      const s2 = source(p.id);
      if (!s2) return { error: `No source ${p.id}.` };
      const before = JSON.parse(JSON.stringify(s2));
      const changed = [];
      for (const f of ["title", "author", "date", "url", "access", "notes"]) {
        if (p[f] !== undefined) { s2[f] = String(p[f]); changed.push(f); }
      }
      if (!changed.length) return { error: "Nothing to change — pass at least one field." };
      s2.updatedBy = (assistantActor() || {}).id;
      recordOp("update_source", p, { source: s2.id }, { kind: "restoreSource", source: before },
               `Update source ${s2.id}: ${changed.join(", ")}${p.reason ? ` — ${p.reason}` : ""}`);
      return { updated: s2.id, changed };
    },
  },

  promote_run: {
    kind: "mutate",
    desc: "Promote a recorded model run to a citable library source, so cards can cite the run itself.",
    schema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false },
    run: (p) => {
      const r = db.runs.find(x => x.id === p.runId);
      if (!r) return { error: `No run ${p.runId}.` };
      if (r.sourceId) return { error: `Run ${p.runId} is already in the library as ${r.sourceId}.` };
      const m = db.models.find(x => x.id === r.modelId);
      const s = { id: uid("s"), kind: "model run", title: `Model run: ${r.name}`,
                  author: "Workspace model run", date: r.date, url: m ? m.url : "", access: "open",
                  notes: `Params: ${r.params} | Outputs: ${String(r.outputs || "").slice(0, 600)}`,
                  addedAt: today(), createdBy: (assistantActor() || {}).id };
      db.sources.push(s); r.sourceId = s.id;
      recordOp("promote_run", p, { source: s.id }, { kind: "removeSource", id: s.id },
               `Promote run ${p.runId} to source ${s.id}`);
      return { created: s.id, note: "Now citable with the cite action." };
    },
  },

  run_model: {
    kind: "run",
    desc: "Execute a registered model and record the run, exactly as the user's 'Run it here' button does. Call list_models first for the model's id and parameter names. The run is recorded with full provenance and becomes citable.",
    schema: { type: "object", properties: {
      modelId: { type: "string", description: "e.g. m9" },
      params: { type: "object", description: "Parameter name/value pairs; omitted parameters take their defaults", additionalProperties: { type: "string" } },
    }, required: ["modelId"], additionalProperties: false },
    run: async (p) => {
      const m = db.models.find(x => x.id === p.modelId);
      if (!m) return { error: `No model ${p.modelId} in the registry. Call list_models for valid ids.` };
      if (!modelRunnableNow(p.modelId)) {
        return { error: `${m.name} cannot be run here: ${modelReason(p.modelId) || "not runnable in this deployment"}.` };
      }
      const spec = modelRun(p.modelId);
      const params = {};
      (spec.params || []).forEach(x => { params[x.name] = x.value; });   // defaults first
      for (const [k, v] of Object.entries(p.params || {})) params[k] = String(v);
      const resp = await fetch("api/run", { method: "POST", headers: { "content-type": "application/json" },
                                            body: JSON.stringify({ modelId: p.modelId, params }) });
      const data = await resp.json();
      if (!resp.ok) return { error: data.error || `Run failed (${resp.status})` };
      // Record it exactly as doRun() does, so an assistant run is
      // indistinguishable from a user run in the evidence record.
      const run = {
        id: uid("run"), modelId: p.modelId,
        name: `${m.name} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        params: Object.entries(params).map(([k, v]) => `${k}=${v}`).join("; "),
        outputs: `${data.summary} ${runHighlights(data)}`.trim(),
        notes: `Executed by LODESTONE against ${data.endpoint} in ${data.ms} ms.`,
        date: today(), runner: `LODESTONE (assistant: ${(assistantActor() || {}).name || "LLM"})`,
        createdBy: (assistantActor() || {}).id || null, sourceId: null,
        result: { columns: data.columns, rows: data.rows, summary: data.summary, endpoint: data.endpoint,
                  ms: data.ms, artifacts: data.artifacts, extraction: data.extraction, appliedParams: data.appliedParams },
      };
      db.runs.push(run); save();
      return { run_id: run.id, summary: data.summary, endpoint: data.endpoint,
               extraction: data.extraction, columns: data.columns,
               rows: (data.rows || []).slice(0, 40),
               note: "Recorded in the workspace and citable. Report the summary to the user, including any caveat it carries." };
    },
  },
};

// Tool schemas are GENERATED from the registry — never hand-maintained, so
// they cannot drift out of sync with what the actions actually do.
function toolSchemas() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    name, description: a.desc, input_schema: a.schema,
  }));
}

async function execAction(name, input) {
  const a = ACTIONS[name];
  if (!a) return { error: `No such action: ${name}` };
  try { return await a.run(input || {}); }
  catch (e) { return { error: `Action ${name} failed: ${e && e.message ? e.message : e}` }; }
}

/* ============================================================================
   THE LOOP. One Claude call per round-trip; tools execute here, in the
   browser, against the live workspace.
   ========================================================================= */
function logLine(name, input, result) {
  const args = Object.entries(input || {})
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  let note = "";
  if (result && result.error) note = "error";
  else if (result && Array.isArray(result.items)) note = `${result.items.length}${result.truncated ? ` of ${result.total}` : ""} result${result.items.length === 1 ? "" : "s"}`;
  else if (result && result.rows) note = `${result.rows.length} rows`;
  else if (result && result.run_id) note = result.run_id;
  return { name, args, note, bad: !!(result && result.error) };
}

async function aSend(prepared, task) {
  if (aBusy) return;
  const input = document.getElementById("aInput");
  const q = prepared || (input ? (input.value || "").trim() : "");
  if (!q) { toast("Type a request first"); return; }

  const who = assistantActor();
  const model = (who && who.model) || "claude-sonnet-5";
  // A named task may need more rounds than a chat turn; the user's setting is
  // the floor, not a ceiling the task cannot ask past.
  const userRounds = Math.max(1, Math.min(16, (db.settings && db.settings.maxToolRounds) || 12));
  const maxRounds = task ? Math.min(16, Math.max(userRounds, 14)) : userRounds;

  // Context chip: the assistant knows what the user is looking at, so
  // "justify this card" needs no ID typed.
  let userText = q;
  if (aCtx && aCtx.kind === "card" && card(aCtx.id)) userText = `[The user is currently looking at card ${aCtx.id}.]\n${q}`;
  else if (aCtx && aCtx.kind === "model") userText = `[The user is currently looking at model ${aCtx.id}.]\n${q}`;

  // A turn owns one changeset. Any earlier un-reviewed one is committed to the
  // journal first rather than being silently extended by unrelated work.
  if (aChangeset && aChangeset.ops.length) csAccept([]);
  aChangeset = newChangeset(q.slice(0, 60));

  aConv.push({ role: "user", content: userText });
  aChat.push({ role: "user", text: q });
  const entry = { role: "assistant", text: "", log: [] };
  aChat.push(entry);
  aBusy = true;
  if (input) input.value = "";
  render();

  try {
    for (let round = 0; round < maxRounds; round++) {
      const resp = await fetch("api/assistant", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: aConv, tools: toolSchemas(), model, task }),
      });
      const data = await resp.json();
      if (!resp.ok) { entry.text = data.error || `Request failed (${resp.status})`; entry.error = true; break; }

      entry.model = data.model; entry.usage = data.usage; entry.cost = data.cost;
      const content = data.content || [];
      const toolUses = content.filter(b => b.type === "tool_use");
      const says = content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (says) entry.text = entry.text ? entry.text + "\n" + says : says;

      if (!toolUses.length) break;                    // plain end_turn

      aConv.push({ role: "assistant", content });
      const results = [];
      for (const u of toolUses) {
        const out = await execAction(u.name, u.input);
        entry.log.push(logLine(u.name, u.input, out));
        render();                                     // live activity log
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 60000),
                       ...(out && out.error ? { is_error: true } : {}) });
      }
      aConv.push({ role: "user", content: results });

      if (round === maxRounds - 1) {
        const done = (aChangeset && aChangeset.ops.length) || 0;
        entry.text += (entry.text ? "\n\n" : "") +
          `_(Stopped at the ${maxRounds}-round tool cap. ${done ? `${done} change${done === 1 ? "" : "s"} were made and are listed below for review.` : "No changes were made."} Raise the cap in Settings, or narrow the request.)_`;
      }
    }
    if (!entry.text) entry.text = "(no answer)";
  } catch (e) {
    entry.text = (e instanceof TypeError && /fetch|network/i.test(String(e.message)))
      ? "Could not reach the local server — is `npm start` still running?"
      : `The assistant failed: ${e && e.message ? e.message : e}`;
    entry.error = true;
  }
  aBusy = false;
  if (aChangeset && !aChangeset.ops.length) aChangeset = null;   // nothing to review
  render();
  const el = document.getElementById("aInput");
  if (el) el.focus();
}

/* ---------------- Changeset drawer ----------------
   Reviewed where it lives: pending entities render in place in the workspace,
   and this drawer is the index into them. Clicking an op navigates to it. */
function csDrawerHTML() {
  if (!aChangeset || !aChangeset.ops.length) return "";
  const staged = aChangeset.ops.some(o => o.status === "pending");
  const rows = aChangeset.ops.map((o, i) => `
    <div class="csop" data-action="csGoto" data-i="${i}" title="Show this change in the workspace">
      ${staged ? `<input type="checkbox" class="csbox" data-i="${i}" checked onclick="event.stopPropagation()">` : ""}
      <span>${esc(o.describe)}</span>
    </div>`).join("");
  return `<div class="csdrawer">
    <div class="cshead"><b>${esc(aChangeset.ops.length)} change${aChangeset.ops.length === 1 ? "" : "s"}</b>
      <span class="conf-note">by ${actorRef(aChangeset.actor)} · ${esc(aChangeset.task)}</span></div>
    ${rows}
    ${staged ? `<div class="csbtns">
      <button class="btn small primary" data-action="csAcceptAll">Accept all</button>
      <button class="btn small" data-action="csAcceptSel">Accept selected</button>
      <button class="btn small danger" data-action="csReject">Reject</button>
    </div>` : `<div class="conf-note" style="padding:0.35rem 0.5rem;">Applied directly (approval mode: apply). Revert from the journal.</div>`}
  </div>`;
}


/* ---------------- Named task: Justify this card ----------------
   A prepared prompt over the same tools, not a special code path. It asks for
   the same standard of work a careful human editor would apply — and imposes
   no obligation the interface does not impose on a person (spec section 8). */
const JUSTIFY_TASK = `The user wants a card justified. Work as a careful editor would:

BUDGET FIRST: you have a limited number of tool rounds (typically 8-12) and each round can carry several calls. Spend AT MOST HALF of them reading. The deliverable is edits, not a survey — a thorough read that produces no edges is a failed task. Batch your reads: issue several calls in one round rather than one at a time.

1. Read the card and its justification first (get_card, get_justification) so you know what is claimed, what already supports it, and what depends on it. Then read only the handful of sources and cards most likely to bear on it - stop reading as soon as you have enough to act.
2. Survey the library and the board for material that bears on it - list_sources and list_cards filtered by its tags and key terms. Read promising sources with get_source.
3. Strengthen the record with real edges, not assertions:
   - cite the card to sources that genuinely support it, always with a locator (page, table, or query);
   - link_cards ... supports from an existing card that backs it up;
   - if a necessary supporting claim is in a source but not yet on the board, create_card (a fact, with its citation) and then link it.
4. Record conflicts you encounter rather than suppressing them - divergence is content. Use link_cards with conflicts-with, or create an open_question or tradeoff card where the disagreement is substantive. You are NOT required to hunt for counter-evidence beyond what this work surfaces; the user runs red-team mode when they want an adversarial pass.
5. If what you found shows the support is thinner than the card's stated confidence, update_card to lower it and say why. Confidence discipline binds every editor: "established" needs multiple independent sources, a single source is at most "probable".
6. Never invent a source, an id, or a locator. If the library cannot support the card, say so plainly - that is a finding, not a failure.

Then reply with a short account of the case: what supports the card, anything that cuts against it, and how solid it now is. The deliverable is the improved graph; your text is the summary of it.`;


/* ---------------- Named task: Form and justify a conclusion ----------------
   The workspace exists to answer a decision question; this turns the board
   into an answer to it. Same tools, same norms — the honesty demanded here
   (do not claim a criterion you cannot support) is the confidence discipline
   every editor is already under, not an extra burden on the assistant. */
const CONCLUDE_TASK = `The user wants a conclusion formed and justified for this workspace's decision question.

BUDGET FIRST: you have a limited number of tool rounds. Spend at most half reading. Batch several calls per round. The deliverable is a recommendation card with its justification graph — an analysis that produces no card is a failed task.

1. get_workspace. The decision question and the decision criteria are the frame; everything else serves them.
2. Survey the board against that frame: list_cards for the recommendations, opportunities, tradeoffs and risks already present, and run_audit criteria_gaps to see which criteria nothing yet supports. Read the strongest cards with get_card, including contested ones and both sides of any conflict pair.
3. Form the conclusion as a recommendation card (create_card, type "recommendation"): one sentence a decision-maker could act on, with the reasoning in detail. Set confidence honestly under the usual rule - "established" needs multiple independent sources, a single source is at most "probable", an active disagreement is "contested".
4. Justify it with real edges, not prose: link_cards ... depends-on from the recommendation to the facts and opportunities it actually rests on; cite sources with locators where the recommendation itself makes a factual claim.
5. Handle what cuts against it. Risks and conflicting evidence you encountered get conflicts-with or informs links. Where a gap would change the conclusion if resolved, create_card an open_question and link it depends-on.
6. Do not claim a decision criterion you cannot support. If a criterion has no evidence behind it, say so in your answer rather than quietly including it.
7. Never invent an id, a source, or a locator.

Then reply with: the conclusion, the confidence you gave it and why, what would change it, and which criteria it does not yet meet.`;

/* ---------------- Panel ---------------- */
// Models occasionally emit tool-call syntax as prose (observed: a terminal
// tool folding all its parameters into the first one as pseudo-XML). Strip
// those artefacts rather than showing them to the analyst as content.
function stripToolArtifacts(t) {
  return String(t == null ? "" : t)
    .replace(/<\/?(?:answer|parameter|function_calls|invoke)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function linkifyRefs(text) {
  let out = esc(stripToolArtifacts(text));
  // Replacer FUNCTIONS, not strings: "$1"-style sequences occur in model prose
  // (e.g. dollar figures) and would otherwise be expanded as replace patterns.
  out = out.replace(/\[([A-Z]{1,3}-\d+)\]/g, (m, id) =>
    card(id) ? cardRef(id) : `<span class="ref ref-broken" data-tipmissing="${esc(id)}" tabindex="0">${esc(id)} ⚠</span>`);
  out = out.replace(/\((s\d+)\)/g, (m, sid) =>
    source(sid) ? sourceRef(sid) : `<span class="ref ref-broken" data-tipmissing="${esc(sid)}" tabindex="0">${esc(sid)} ⚠</span>`);
  return out;
}

function aMsgHTML(m) {
  if (m.role === "user") return `<div class="amsg user"><span class="who">You</span><div>${esc(m.text)}</div></div>`;
  const log = (m.log || []).length
    ? `<div class="alog">${m.log.map(l => `<div class="${l.bad ? "bad" : "ok"}">→ ${esc(l.name)}${l.args ? " " + esc(l.args) : ""}${l.note ? ` · ${esc(l.note)}` : ""}</div>`).join("")}</div>` : "";
  const gaps = (m.gaps || []).length
    ? `<div style="font-size:0.72rem;color:var(--copper);margin-top:0.35rem;"><b>Evidence gaps:</b> ${m.gaps.map(linkifyRefs).join(" · ")}</div>` : "";
  const cost = m.cost ? ` · ~$${m.cost.request_usd.toFixed(3)} (today $${m.cost.today_usd.toFixed(2)} of $${m.cost.daily_limit_usd.toFixed(2)})` : "";
  const meta = m.error ? "" : `<div style="font-size:0.64rem;color:var(--ink-3);margin-top:0.3rem;">${esc(m.model || "")}${m.usage ? ` · ${m.usage.input_tokens} in / ${m.usage.output_tokens} out${m.usage.cache_read_input_tokens ? ` · ${m.usage.cache_read_input_tokens} cached` : ""}` : ""}${esc(cost)}</div>`;
  return `<div class="amsg ${m.error ? "err" : "bot"}"><span class="who">${esc((assistantActor() || {}).name || "Assistant")}</span>
    ${log}<div style="white-space:pre-wrap;">${linkifyRefs(m.text)}</div>${gaps}${meta}</div>`;
}

function renderAssistant() {
  const rail = document.getElementById("arail");
  const layout = document.getElementById("layout");
  if (!rail || !layout) return;
  layout.classList.add("with-assistant");
  rail.hidden = false;

  if (!aOpen) {
    rail.innerHTML = `<div class="arail-head"><button class="btn small just" data-action="aToggle">◀ Assistant</button></div>`;
    layout.classList.remove("with-assistant");
    rail.style.cssText = "position:static;height:auto;border-left:none;";
    return;
  }
  rail.style.cssText = "";

  const who = assistantActor() || {};
  // Say plainly when the assistant cannot run, rather than offering an input
  // that will fail on send.
  const noKey = serverCaps && serverCaps.assistant === false;
  const ctxChip = aCtx && (aCtx.kind === "card" ? card(aCtx.id) : db.models.find(m => m.id === aCtx.id))
    ? `<span class="achip">context: ${esc(aCtx.id)} <button class="btn small" data-action="aCtxClear" style="padding:0 0.25rem;">×</button></span>` : "";

  rail.innerHTML = `
    <div class="arail-head">
      <b style="font-size:0.85rem;">Assistant</b>
      <span class="achip llm">${esc(who.name || "—")}</span>
      ${ctxChip}
      <span style="flex:1"></span>
      <button class="btn small" data-action="aClear" ${aBusy ? "disabled" : ""}>Clear</button>
      <button class="btn small" data-action="aToggle">▶</button>
    </div>
    <div class="arail-body" id="aBody">
      ${aChat.length ? aChat.map(aMsgHTML).join("") : `<div class="empty" style="font-size:0.8rem;">
        Ask about the evidence, or tell the assistant to do something. It can read every card, source, run and audit,
        and can run any model you can run.<br><br>
        <span class="conf-note">Try: “search for conflicts with F-14” · “run the USGS model with year set to 2026” · “which criteria have no supporting cards?”</span></div>`}
      ${aBusy ? `<div class="amsg bot"><span class="who">${esc(who.name || "Assistant")}</span><div><i>Working…</i></div></div>` : ""}
    </div>
    ${csDrawerHTML()}
    <div class="arail-foot">
      ${noKey ? `<div class="notice" style="margin:0 0 0.45rem;font-size:0.72rem;">No <code>MY_ANTHROPIC_KEY</code> on the server, so the assistant cannot run. Set it in <code>lodestone/.env</code> and restart. Everything else in LODESTONE works without it.</div>` : ""}
      <textarea id="aInput" placeholder="Ask, or instruct… (Enter to send, Shift+Enter for a new line)" ${aBusy ? "disabled" : ""}></textarea>
      <div style="display:flex;gap:0.4rem;margin-top:0.4rem;align-items:center;">
        <button class="btn primary small" data-action="aSend" ${aBusy ? "disabled" : ""}>Send</button>
        <span class="conf-note" style="font-size:0.66rem;">Reads, model runs and edits. Edits are staged for your review.</span>
      </div>
    </div>`;

  const body = document.getElementById("aBody");
  if (body) body.scrollTop = body.scrollHeight;
}

/* Context: opening a card's justification sets the chip, so the user can say
   "justify this" without typing an ID. */
const _baseOpenTrace = typeof openTrace === "function" ? openTrace : null;
if (_baseOpenTrace) {
  openTrace = function (id) { aCtx = { kind: "card", id }; _baseOpenTrace(id); renderAssistant(); };
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  if (a === "aSend") aSend();
  else if (a === "aClear") { aChat = []; aConv = []; render(); }
  else if (a === "aToggle") { aOpen = !aOpen; render(); }
  else if (a === "aCtxClear") { aCtx = null; renderAssistant(); }
  else if (a === "csAcceptAll") csAccept(null);
  else if (a === "csAcceptSel") {
    const sel = [...document.querySelectorAll(".csbox")].filter(x => x.checked).map(x => +x.dataset.i);
    csAccept(sel);
  }
  else if (a === "csReject") csReject();
  else if (a === "csGoto") {
    const op = aChangeset && aChangeset.ops[+el.dataset.i];
    if (!op) return;
    const cid = op.targets && (op.targets.card || op.targets.from);
    const sid = op.targets && op.targets.source;
    if (cid) { view = "board"; filters = { type: "all", q: "", tag: "" }; render();
               const node = document.querySelector(`[data-cid="${cid}"]`);
               if (node) { node.scrollIntoView({ block: "center", behavior: "smooth" }); node.classList.add("flash"); setTimeout(() => node.classList.remove("flash"), 1400); } }
    else if (sid) { view = "library"; render(); }
  }
  else if (a === "aConclude") {
    aOpen = true; render();
    aSend("Form and justify a conclusion for this workspace's decision question.", CONCLUDE_TASK);
  }
  else if (a === "aJustify") {
    aCtx = { kind: "card", id: el.dataset.id }; aOpen = true; render();
    aSend(`Justify card ${el.dataset.id}.`, JUSTIFY_TASK);
  }
  else if (a === "aAskCard") { aCtx = { kind: "card", id: el.dataset.id }; aOpen = true; render(); aSend(`Justify card ${el.dataset.id}: what supports it, what conflicts with it, and how solid is it?`); }
});

document.addEventListener("keydown", (ev) => {
  if (ev.target && ev.target.id === "aInput" && ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault(); aSend();
  }
});

/* This file is appended after the main script has already run its first
   render, so renderAssistant did not exist yet at that point. Re-render now
   that it does — this is what brings up the rail and the per-card ⚡ Ask
   buttons on load. */
scanUiActions();
render();

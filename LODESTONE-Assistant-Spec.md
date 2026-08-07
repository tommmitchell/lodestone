# LODESTONE Assistant v2 — Specification

**The agentic assistant panel: full workspace parity for the LLM**

Version 0.3 · August 2026 · Companion to *LODESTONE — Specification and
Implementation Status v0.2*. This document specifies the incorporation of an
LLM into LODESTONE as a first-class operator of the workbench, replacing the
current single-shot Q&A module. It is written against the working prototype:
file and function names refer to real code.

v0.2 incorporates the accepted design decisions: in-situ changeset
presentation with a clickable drawer, live rendering of assistant edits as
they happen, removal of any editorial mandate beyond what binds human
editors, and the actor registry for universal edit attribution.

---

## 1. The Parity Principle

> **Design principle 7 — Interface parity.** The assistant can *see* anything
> the user can see through the interface, and *do* anything the user can do
> through the interface. Capability is granted by the same action layer the
> interface itself uses, so parity is structural, not aspirational: a feature
> added to the UI becomes available to the assistant by construction, and a
> capability withheld from the assistant is a *documented exception*, not an
> accident of plumbing.

Parity cuts both ways. The assistant gains the user's full reach — and gains
**no editorial obligations beyond those that bind a human editor**. Task
recipes (§8, §9) may describe good practice, but they impose no requirement
on the assistant that the interface does not impose on a person. The
countervailing tool for one-sidedness is red-team mode, invoked when the
user chooses.

### 1.1 Reconciliation with principle 2 (human in the loop)

Principle 2 says: *the assistant proposes; only a user accepts anything
durable*. Parity says: *the assistant can do anything the user can do*. These
conflict only if "do" is read as "do silently." The reconciliation:

- **Parity governs capability. Principle 2 governs commitment.**
- Every assistant action executes through the same handlers as a user click,
  but durable mutations land inside a **changeset** (§6) — a named, atomic,
  reviewable, revertible unit. Whether a changeset applies immediately
  (revertible) or waits staged for approval is a **user setting**, not a
  property of the assistant.
- Reads and model runs are not durable mutations. They execute directly, in
  both modes. A model run *record* is durable but append-only and deletable,
  so it is treated like a read with a receipt, exactly as when the user
  clicks **Run it here**.

### 1.2 Documented exceptions to parity

The assistant may **not**, regardless of mode:

| Exception | Reason |
|---|---|
| Edit assistant governance settings (actor/model configuration, approval mode, iteration cap, daily budget) | Self-modification of its own limits is privilege escalation, not parity |
| Import/replace the whole workspace, reset to seed | Single action destroying all state; requires the user's own click |
| Delete a changeset journal entry | The journal is the audit record *of* the assistant; it must not be able to erase its own trail |
| Trigger downloads/exports to disk | Harmless but pointless for the LLM; excluded to keep the tool surface clean. The assistant *composes* a brief; the user clicks export |

Everything else — every card, source, list, link, run, view, filter, audit —
is in scope.

---

## 2. Architecture

### 2.1 The constraint that shapes everything

Workspace state lives in **browser localStorage**; the server is stateless and
holds only credentials. Therefore tools cannot execute on the server — the
server cannot see the workspace. The agentic loop is **browser-mediated**:

```
┌─────────── browser ────────────┐        ┌────────── server ──────────┐
│ panel UI                       │        │                            │
│ conversation array (messages)  │──POST──▶ /api/assistant             │
│                                │        │   → Claude API (tools=[…]) │
│ ACTIONS registry ◀─────────────│◀─tool──│   stop_reason: tool_use    │
│   executes locally against db  │  calls │                            │
│   (model runs via /api/run)    │──POST──▶ appends tool_result,       │
│                                │  loop  │   calls Claude again       │
│ renders final reply + changeset│◀───────│   stop_reason: end_turn    │
└────────────────────────────────┘        └────────────────────────────┘
```

- The **browser owns the conversation**: an array of Claude-format messages
  (user, assistant incl. `tool_use` blocks, `tool_result` blocks). Each
  round-trip sends the whole conversation; the server makes exactly one
  Claude call per request and returns the raw assistant message. The server
  stays stateless and the API key never reaches the page (unchanged).
- When the reply contains `tool_use` blocks, the browser executes each
  against the **ACTIONS registry** (§2.2), appends `tool_result` blocks, and
  POSTs again. Loop until `end_turn`, error, or the round cap (§10).
- Model runs are the one tool class that re-enters the server (`/api/run`),
  because adapters (Excel, headless Chrome, credentialed APIs) live there.
  The browser calls `/api/run` exactly as the **Run it here** button does —
  same validation, same recording, same provenance grading.

This design means the assistant sees the *live* workspace (not a stale
serialization), including edits the user makes mid-conversation.

### 2.2 The ACTIONS registry — parity made structural

Today the UI dispatches ~40 `data-action` handlers through a click listener,
and functions like `card()`, `save()`, `uid()` implement them. The registry
refactor extracts this into one table that both the UI and the assistant call:

```js
const ACTIONS = {
  // ---- reads (assistant: direct; UI: implicit in rendering) ----
  get_workspace:   { run: () => ({title: db.ws.title, question: db.ws.question, criteria: db.ws.criteria}), kind: "read" },
  list_cards:      { params: {type: "?", tag: "?", q: "?", status: "?"}, run: filteredCards, kind: "read" },
  get_card:        { params: {id: "!"}, run: cardDetail, kind: "read" },      // incl. links, citations, inverse trace
  get_justification:{ params: {id: "!"}, run: justificationData, kind: "read" }, // same data the panel renders
  list_sources:    { …, kind: "read" },
  get_source:      { …, kind: "read" },
  list_models:     { run: modelsWithCaps, kind: "read" },                     // incl. runnability + reasons + param specs
  list_runs:       { …, kind: "read" },
  get_run:         { params: {id: "!"}, run: runDetail, kind: "read" },
  run_audit:       { params: {which: "uncited|single_source|criteria_gaps|broken_refs|conflicts"}, kind: "read" },
  list_actors:     { run: () => db.actors, kind: "read" },                    // §7

  // ---- acts (assistant: via changeset; UI: direct) ----
  create_card:     { params: {type,statement,detail,confidence,tags,citations,links}, kind: "mutate" },
  update_card:     { params: {id, patch}, kind: "mutate" },
  deprecate_card:  { params: {id, reason}, kind: "mutate" },
  link_cards:      { params: {from, to, rel}, kind: "mutate" },
  unlink_cards:    { params: {from, to}, kind: "mutate" },
  add_source:      { params: {kind,title,author,date,url,access,notes}, kind: "mutate" },
  update_source:   { params: {id, patch}, kind: "mutate" },
  cite:            { params: {cardId, sourceId, locator}, kind: "mutate" },
  create_list:     { …, kind: "mutate" }, add_to_list: { … }, remove_from_list: { … },
  promote_run:     { params: {runId}, kind: "mutate" },                       // run → citable source

  // ---- model execution (assistant: direct; goes through /api/run) ----
  run_model:       { params: {modelId, params}, kind: "run" },
};
```

Rules:

1. **One implementation per action.** The UI's click handlers become thin
   wrappers over registry entries. If a handler exists that has no registry
   entry (or vice versa), the parity audit (§11) fails the build.
2. **Tool schemas are generated from the registry** — name, description,
   JSON-schema parameters — and sent to the Claude API as `tools`. No
   hand-maintained duplicate list.
3. Every `mutate` action validates its inputs exactly as the UI does (IDs
   must exist, `rel` must be one of RELS, citations must reference real
   sources) and **records the acting actor** (§7) on the entity and in the
   journal — for human and LLM actors alike.

### 2.3 What replaces the current single-shot design

`REPLY_SCHEMA` (forced structured output) and `serializeWorkspace()` (full
workspace in the prompt) are **retired**. The assistant reads the workspace
through tools instead — cheaper on tokens for large workspaces, always
current, and the same access path the user has. The final assistant message
remains structured (§5.3) so the panel can render citations, gaps, and the
changeset summary deterministically. `linkifyRefs()` and its citation
validation survive unchanged: model prose is still only linkified for IDs
that actually exist.

---

## 3. Settings & data

A new **Settings** section (in the existing Settings/data area alongside
Export/Import) with persisted `db.settings`:

| Setting | Values | Default | Meaning |
|---|---|---|---|
| `activeActor` | an actor id from `db.actors` | first human actor | Who is credited with edits made through the UI right now (§7) |
| `assistantActor` | an LLM actor id | first LLM actor | Which LLM actor the panel drives; its configuration names the model |
| `approvalMode` | `staged` \| `apply` | `staged` | `staged`: changesets wait for Accept. `apply`: changesets apply immediately, revertible from the journal |
| `maxToolRounds` | 1–16 | 8 | Hard cap on Claude calls per user request |
| `dailyLimitUsd` | read-only display | server value | Shown, not editable here (server-owned; exception §1.2) |

Actor management (add/rename human and LLM actors, set an LLM actor's model)
lives here too. The server keeps `LODESTONE_DAILY_LIMIT_USD` authority; the
panel shows spend after every turn as today.

---

## 4. The panel

The three-pane layout from the main specification becomes real:

- **Right rail, persistent across all views** (board, library, models,
  brief), collapsible. The current "Analyst tools" view retires; its chat
  moves here. On narrow screens the rail overlays rather than squeezes.
- **Context chips.** The panel knows what the user is looking at. Opening a
  card's justification, selecting a model, or filtering the board sets a
  context chip ("F-6", "m9") that is passed as a hint in the user turn —
  so "justify this card" needs no ID typed.
- **Action affordances on entities** (parity in the other direction): each
  card gains a "⚡ Justify with assistant" action; the workspace header
  gains "⚡ Form a conclusion". These are shortcuts that open the panel with
  a prepared task prompt (§8, §9) — the same text the user could type.
- **Live activity log.** While the loop runs, each tool call renders as a
  line ("→ list_cards type=fact tag=lfp · 12 results", "→ run_model m9
  {commodity: Lithium, year: 2026} · 8 rows") so the user watches the
  assistant work with the same visibility they would have watching a
  colleague drive the UI. This is the parity principle applied to
  *observability*.
- **Live edit rendering.** Mutations appear in the workspace *as the
  assistant performs them*, not at review time. In `staged` mode the
  interface renders from the shadow state (§6), so each pending op appears
  in place — pending-styled — the moment it executes, synchronized with its
  activity-log line. Review is simply the moment the accumulation stops; by
  then the user has already watched the changeset build. The workspace is
  not locked during a turn: the user can keep editing, and ops that go
  stale surface at apply time (§6) rather than clobbering the user's work.

---

## 5. Conversation contract

### 5.1 System prompt

Extends the current `COMMON_RULES` (grounding, honesty about gaps, confidence
discipline, no invented IDs) with:

- Tool-use guidance: read before writing; never assert workspace content
  without having read it this conversation; prefer several small reads over
  asking the user.
- Mutation discipline: all mutations belong to the current task; unrelated
  "tidying" is prohibited. Statements written to cards must be defensible
  from citations attached in the same changeset.
- The parity exceptions (§1.2), stated plainly so the model does not attempt
  them.

### 5.2 Tool results

Tool results are JSON, compact, and **truthful about truncation**: list reads
over N items return the first N with `"truncated": true, "total": …` so the
model knows to narrow, mirroring how runners already report row caps.

### 5.3 Final message

> **Revised in v0.3 after live testing.** A terminal `finish` tool with two
> parameters proved unsafe: the model folded *both* into the first as
> pseudo-XML, so the answer text reaching the analyst contained a literal
> `</answer><parameter name="evidence_gaps">`. The turn now simply ends with
> prose on `end_turn`, and a sanitiser strips tool-syntax artifacts. Structured
> output returns in P2 carried by the **changeset**, which is data the system
> owns rather than a tool the model must remember to call correctly. The shape
> below is therefore the P2 target, not the P1 behaviour:

```json
{
  "answer": "prose with [F-6] and (s8) citations",
  "evidence_gaps": ["…"],
  "changeset_note": "one line describing what the changeset does, empty if none"
}
```

Proposals-as-data disappear: instead of describing cards it *would* create,
the assistant creates them in the changeset, where they are reviewed with
full fidelity (real diffs, real links) rather than as chat bubbles.

---

## 6. Changesets — commitment governance

A changeset is the unit of durable change:

```js
{ id, turnId, actor,                       // the LLM actor that made it (§7)
  task: "justify F-6", created,
  status: "staged"|"applied"|"reverted",
  approvedBy: null | actorId,              // the human actor who accepted
  ops: [ {action: "link_cards", params: {…}, inverse: {…}, status: "pending"|"accepted"|"rejected"|"stale"}, … ] }
```

- Mutations executed by the assistant during a turn accumulate into one
  changeset. In `staged` mode, ops run against a **shadow copy** of `db` (so
  later reads in the same turn see them — the assistant must be able to see
  its own work) and land only on Accept. In `apply` mode they run against
  `db` directly and the journal stores computed inverses.

### 6.1 Presentation: in place, plus a drawer

The changeset is reviewed **where it lives, in the interface itself** — not
in a separate diff view:

- **In-situ pending rendering.** Entities touched by pending ops render in
  their normal locations with a distinct *pending* treatment: tinted
  background, dashed border, and an actor chip naming who made the change —
  visually distinct from both the confidence dots and the conflict red. New
  links appear pending-styled in link lists and in the justification panel.
  Deprecations render struck-through.
- **Edits show before and after in place.** A card statement is short, so
  an edited card shows the new text with the previous text collapsed
  beneath it in strikethrough — a toggle, not a side-by-side diff.
- **The changeset drawer** docks at the bottom of the assistant rail: task
  name, actor, and one line per op. Clicking an op navigates to the right
  view and flash-scrolls to the entity. Each op carries a checkbox.
- **Per-op acceptance: Accept all · Accept selected · Reject** (staged) /
  **Revert** (applied). Per-op matters because a justification changeset
  may contain four good links and one bad card.
- **Staleness.** Ops re-validate at apply time against the then-current
  workspace. An op whose target the user edited or deleted mid-turn is
  marked `stale` in the drawer ("card changed since staged") and is
  excluded from Accept-all rather than silently overwriting the user's
  work.

The journal (last 50 changesets) lives in `db.journal`, is exported with the
workspace, and satisfies the audit-trail direction of NFR-3: every change is
attributable to an actor, a task, and a turn.

---

## 7. Actors and attribution

Every edit is credited to whoever made it — human or LLM — through a
first-class registry that is the canonical source of names for provenance.

```js
db.actors = [
  { id: "user1", kind: "human", name: "Tom Mitchell" },
  { id: "user2", kind: "human", name: "…" },
  { id: "LLM3",  kind: "llm",   name: "Workbench assistant", model: "claude-sonnet-5" },
  { id: "LLM4",  kind: "llm",   name: "Red team",            model: "claude-opus-5"  },
]
```

- **An LLM actor is a named configuration, not a bare model string** — a
  role plus a model. This is how two LLM actors with different models
  coexist (Q&A on Sonnet, red-team on Opus), and it replaces the panel's
  bare model picker with an actor picker.
- **Attribution fields.** Entities carry `createdBy` and `updatedBy` (actor
  ids); changesets carry `actor` and `approvedBy` (§6). These supersede the
  ad-hoc `origin`/`owner` fields; migration maps `origin: "seed"` to a
  system actor `seed`, and existing assistant-proposed cards to the LLM
  actor.
- **One renderer per entity extends to actors**: an `actorRef()` renderer
  displays every attribution chip, so renames propagate everywhere and a
  reference to a deleted actor renders as a visible warning, exactly like
  cards and sources.
- **Universal journaling comes almost free.** Once every mutation — the
  user's included — flows through the ACTIONS registry (§2.2), recording
  `{action, params, actor, when}` for human edits is one line. "Each edit
  credited to whoever makes it" then holds for everyone, not only the
  assistant, and the NFR-3 audit-trail gap starts closing as a side effect.
- **Honest caveat: attribution, not identity.** The prototype has no
  authentication; the active human actor is chosen in Settings and taken on
  trust. That is sufficient for a single-browser prototype, and the
  registry is the hook that real identity (SSO, NFR-2) would attach to
  later.

---

## 8. Named task: **Justify this card**

Invocation: card action button, or free text ("create a justification for
F-6"). Not a special code path — a prepared prompt over the same tools; the
task text ships in the system prompt as a recipe:

1. `get_card F-6` and `get_justification F-6` — what is claimed, what
   support already exists, what the inverse trace is.
2. Survey: `list_sources`, `list_cards` filtered by the card's tags and
   terms; `run_audit conflicts` for anything already marked contradictory.
3. Build the case: for each genuinely supporting source, `cite` with a
   locator; for each supporting card, `link_cards … supports`. If a
   necessary supporting claim exists in a source but not as a card,
   `create_card` (fact) with citations, then link it.
4. Conflicts **encountered** along the way are recorded, not suppressed —
   principle 5 (divergence is content), which binds human editors equally.
   A justification built while ignoring an existing `conflicts-with` link
   would be false. There is **no mandate** to hunt for counter-evidence
   beyond this: the assistant is under the same editorial norms as a human
   editor, no more (§1). The user invokes red-team mode when they want an
   adversarial pass.
5. If the evidence gathered shows support thinner than the card's
   confidence grade, `update_card` to lower confidence — with the reasoning
   in the answer. (This is the existing confidence-discipline rule, which
   already binds all editors.)
6. Finish: answer summarizes the case; changeset carries the new
   links/cards/citations. The card's justification panel now *shows* the
   result — the deliverable is the improved graph, not the chat text.

Acceptance: after Accept, `get_justification F-6` returns at least one new
supporting edge with a locator-level citation, any pre-existing conflict
links remain visible in the panel, and no reference points at an ID that
does not exist.

## 9. Named task: **Form and justify a conclusion**

Invocation: workspace header button, or "form and justify a conclusion for
the question at hand."

1. `get_workspace` — the decision question and criteria are the frame.
2. Survey the board per criterion (`list_cards`, `run_audit
   criteria_gaps`); read the strongest evidence on the question, including
   deprecated/contested cards and conflict pairs.
3. Draft a conclusion as a **recommendation card** (or `decision` if the
   user says so): statement ≤280 chars, detail carrying the reasoning,
   `depends-on` links to the opportunities/facts it rests on, criteria
   indices set honestly — a criterion with no supporting evidence is *not*
   claimed.
4. Justify it (task §8 applied to the new card). Conflicts and risks
   encountered get `conflicts-with`/`informs` links; gaps that would change
   the conclusion become open_question cards linked `depends-on`.
5. Finish: answer states the conclusion, its confidence, what would change
   it, and which criteria it fails; changeset carries the card and its
   justification graph.

Acceptance: the recommendation exists with supporting links and
locator-level citations, `run_audit criteria_gaps` reports no criterion
silently claimed, and every gap named in the answer appears as a linked
open_question card.

## 10. Cost & safety

- **Round cap** `maxToolRounds` (default 8; tasks §8/§9 may need the upper
  range). On hitting the cap the assistant must finish with what it has and
  say the cap was hit.
- **Budget**: existing per-day ledger applies per Claude call; the loop
  aborts cleanly mid-task if the cap trips, leaving the changeset staged.
- **Prompt caching**: system prompt + tool schemas are stable and cached;
  the growing conversation is the only uncached tail.
- **Tool-input validation** is the same as UI validation; a failed op
  returns a structured error as the tool result (the model can correct),
  never a thrown exception.
- **Injection surface**: tool results contain workspace text (sources,
  notes). Today that text is user-authored; when web ingest arrives, source
  content becomes untrusted — flagged now as the constraint that tool
  results must then be wrapped as data, not instructions.

## 11. Parity enforcement (deterministic, not aspirational)

- **Audit**: a health check enumerates UI `data-action` handlers and
  registry entries; any handler without a registry entry (or exception tag)
  fails. Runs with the existing link-health audit.
- **Tests**: the three canonical utterances are acceptance tests against a
  seeded workspace: *"create a justification for F-6"* (→ changeset with
  supports-links + citations), *"search for conflicts with F-14"* (→ read
  path: relevant cards/sources surfaced, no mutation), *"run the USGS model
  with year set to 2026"* (→ `/api/run` m9 with `{year: "2026"}`, real rows
  in the reply, run recorded).

## 12. Phasing

| Phase | Delivers | Proves |
|---|---|---|
| **P1** ✅ **delivered** | ACTIONS registry (13 actions: reads + `run_model`), browser-mediated loop, persistent panel with activity log, **actor registry** + Settings (actors, approval mode, rounds) | Verified live: "search for conflicts with F-14", "run the USGS model with year 2026", "which criteria have no supporting cards?" |
| **P2** | Mutation actions + changesets (in-situ pending rendering, drawer, per-op accept) + journal + approval modes live; **Justify this card** | "create a justification for F-6" end-to-end |
| **P3** | **Form and justify a conclusion**; parity audit in the health check; universal journaling of human edits; retire Analyst-tools view | The full principle, enforced |

The actor registry sits in P1 because mutations in P2 need it to exist
first. Each phase leaves the app working; P1 alone is a strict improvement
on the current assistant.

# LODESTONE External Changesets — Specification

**Letting any assistant outside the app propose incremental edits to a workspace**

Version 0.2 · August 2026 · Companion to *LODESTONE Assistant v2*.

---

## 1. The problem

The in-app assistant edits a workspace through the ACTIONS registry, and every
edit lands in a reviewable changeset. An assistant working *outside* the app —
Claude Code in a terminal, Opus or GPT-Sol in a chat window — has no such
route. Today the only handover is a whole-workspace export/import, which is
fine for initial population and useless for "add these six cards to the board
I already have".

What is needed is a file that expresses **incremental edits**, that any model
can write without knowing anything about LODESTONE's internals, and that the
app can validate and stage for review exactly like an in-app changeset.

## 2. The key decision: operations are registry actions

An external changeset is a list of operations, and **each operation is a call
to an existing ACTIONS registry entry** — the same entries the interface and
the in-app assistant use.

This is the whole design. It means an imported changeset gets, for free:

- the same validation (unknown ids refused, `rel` checked against RELS,
  citations checked against real sources, web pages required to carry a url
  and an excerpt);
- the same inverse computation, so every operation is revertible;
- the same review surface — in-situ PENDING rendering, the drawer, per-operation
  Accept / Reject;
- the same journal entry, attributed and dated.

Nothing new has to be trusted. An external changeset is not a second way to
mutate a workspace; it is a *transport* for the only way.

## 3. File format

```jsonc
{
  "lodestone": "changeset",
  "formatVersion": 1,

  "author": {
    "name": "Claude Opus 5 (external)",
    "kind": "external-llm",
    "model": "claude-opus-5"          // or "gpt-sol", or "human"
  },

  "target": {                          // which board this is meant for
    "workspaceId": "w1",               // optional; from the briefing
    "title": "Florida Flu Prediction, FY2029",
    "question": "Should NSF fund influenza forecasting focused on Florida?",
    "fingerprint": "c32-s24-r3"        // cards-sources-runs at briefing time
  },

  "note": "First research pass: state surveillance sources and what they support",

  "ops": [
    { "action": "add_source",
      "as": "$flDoh",
      "params": {
        "kind": "web page",
        "title": "Influenza Surveillance — Florida Department of Health",
        "author": "Florida Department of Health, Bureau of Epidemiology",
        "url": "https://www.floridahealth.gov/…/influenza-surveillance/",
        "accessed": "2026-08-08",
        "excerpt": "ILINet providers report the number of patient visits each week…",
        "access": "open",
        "notes": "Weekly Florida Flu Review archive; PDFs rather than CSVs"
      } },

    { "action": "create_card",
      "as": "$ilinetFact",
      "params": {
        "type": "fact",
        "statement": "Florida's state ILI signal comes from an ILINet sentinel provider network reporting weekly visit counts by age band.",
        "detail": "Reports are published as weekly PDFs, not machine-readable series.",
        "confidence": "probable",
        "tags": ["surveillance", "data-availability"],
        "citations": [ { "sourceId": "$flDoh", "locator": "Surveillance methods" } ]
      } },

    { "action": "link_cards",
      "params": { "from": "$ilinetFact", "to": "OQ-2", "rel": "answers" } },

    { "action": "update_card",
      "params": { "id": "F-7", "confidence": "contested",
                  "reason": "A second source disagrees on the reporting lag" } }
  ]
}
```

### 3.1 Reference labels — the one genuinely new mechanism

An external author cannot know the ids a workspace will assign. So:

- `"as": "$label"` on an operation names whatever it creates.
- Any later parameter may use `"$label"` wherever an id is expected.
- **Existing** entities are referenced by their real ids (`F-7`, `s3`, `OQ-2`),
  which the author learns from the briefing (§4).

The importer keeps a symbol table, resolving `$labels` to real ids as
operations execute. Labels are local to one file and never persisted.

Rules, chosen so a malformed file fails loudly rather than half-applying:

- a `$label` used before it is defined is a **fatal** validation error;
- a real id that does not exist in the target workspace is **fatal**;
- a `$label` defined but never used is a warning, not an error;
- `$` is reserved as the first character of an id and rejected elsewhere.

## 4. The briefing — what makes this provider-agnostic

An external model needs three things, and the app should hand them over in one
file rather than expecting anyone to describe LODESTONE from memory.

**Settings & data → Export briefing for an external assistant** produces a
markdown file containing:

1. **The workspace**: title, decision question, criteria, and its fingerprint.
2. **What is already there**: every card as `id · type · confidence ·
   statement`, every source as `id · kind · title · url`, reading lists, and
   which models are present. Enough to reference existing material and to
   avoid proposing duplicates.
3. **What may be done**: the ACTIONS registry's mutation entries, rendered as
   their names, descriptions and JSON Schemas — generated from the registry,
   so the briefing cannot drift from what the app will accept.
4. **The changeset format**: §3 above, with one worked example.
5. **The house rules**, stated plainly because they are the point of the tool:
   confidence discipline, locator-level citations, web pages need url +
   accessed + excerpt, record conflicts rather than resolving them silently,
   never invent an id or a source.

That file is provider-neutral by construction — plain markdown and JSON
Schema, no Anthropic or OpenAI concepts anywhere. Paste it to Opus, to
GPT-Sol, to Claude Code, or hand it to a research assistant who is a person;
they return a changeset JSON, you import it.

## 5. Import

`Settings & data → Import changeset (.json)`, and a drag target on the board.

1. **Parse and identify.** Wrong `lodestone`/`formatVersion` → refuse with the
   reason.
2. **Check the target.** If `target.workspaceId` names a different workspace
   than the open one, ask before continuing and name both. If the fingerprint
   has moved on, warn: the board has changed since the briefing, so ids may
   have shifted meaning — proceed, but read carefully.
3. **Dry run.** Resolve every reference and validate every operation through
   its registry entry *without applying anything*. Produce a report: N ready,
   M rejected, each rejection naming its operation and reason.
4. **Apply as one changeset** if the dry run is clean, or apply only the valid
   subset if the user chooses that after seeing the report.
5. **Honour the user's approval mode.** In *staged* mode the changeset lands
   in the drawer with in-situ PENDING rendering and per-operation Accept /
   Reject. In *apply immediately* mode it applies, and is revertible from the
   journal.

   > **Revised in v0.2.** The first draft made external changesets always
   > stage, on the reasoning that nobody watched the file being written. That
   > was wrong on its own terms: this specification already holds that
   > approval mode is *a user setting, not a property of the assistant*, and
   > making it a property of the transport instead is the same paternalism
   > wearing a different hat. Autonomous population — let it run, read the
   > result, keep it or delete the workspace — is a legitimate workflow and is
   > much of the point of the external route. Nothing about a file skips
   > validation: every operation still executes through its registry entry.
   >
   > Two things carry the safety that staging was standing in for, and both
   > are properties of the *result*, not of who is allowed to act:
   >
   > - **The dry run still runs in both modes** (step 3). Apply-immediately
   >   means "do not ask me to approve each edit", not "apply edits that do
   >   not validate". A file that fails validation is reported, never
   >   half-applied.
   > - **Revert must actually work.** An applied changeset is only safely
   >   reversible if the journal can undo it. That is the real precondition
   >   for apply-immediately, and it is a precondition the implementation does
   >   not currently meet (§10).

## 6. Attribution

The `author` block becomes an actor: `ext:claude-opus-5`, `ext:gpt-sol`,
`ext:claude-code`, registered on first import so nothing dangles. Every card
and source it creates carries that `createdBy`, and the journal entry records
the author, the note, the file name, and which human accepted it.

An external contribution must be **distinguishable from an in-app one** in the
record. The journal marks it `via: "external changeset"`. A funding rationale
that was half-written by a model in someone's chat window should say so.

## 7. Initial population is the same thing

A workspace-shaped export is just a changeset whose target is empty. Rather
than keeping two import paths, "populate a new workspace" becomes: create the
workspace, then import a changeset against it. One format, one review surface,
one journal entry — and the first pass gets the same per-operation scrutiny as
every later one.

## 8. What this does not do

- **No deletions.** Consistent with the existing exception: an external file
  may add, link, cite and amend, but not delete sources, runs or lists. The
  tool's idiom is deprecate-not-delete, and `deprecate_card` is available.
- **No governance.** Settings, actors, budgets, workspace lifecycle and model
  registry membership are not addressable. Same reasoning as in-app parity.
- **No run fabrication.** `run_model` is not an importable operation: a run
  record must come from a run that actually executed. An external author that
  wants model output asks the user to run it.
- **No merge resolution.** If the board moved under the file, the user is told
  and decides. Silent three-way merge of an evidence graph is a worse failure
  than an honest refusal.

## 10. Prerequisite: revert from the journal

The drawer already tells the user *"Applied directly (approval mode: apply).
Revert from the journal"*, and `recordOp` already stores an inverse for every
operation, and `csAccept` already writes the finished changeset into
`db.journal`. **Nothing consumes any of it.** There is no revert.

That is a promise the interface makes and does not keep, and it matters more
once external changesets can apply immediately: without it, an autonomous pass
against an *existing* workspace is a one-way door, and the only undo is
deleting the workspace — fine for a scratch board, not fine for one with a
month of curation in it.

Required before apply-immediately is honest:

- **Revert on a journal entry.** Apply each operation's inverse in reverse
  order, then record the reversal as its own journal entry rather than
  deleting history.
- **Refuse rather than half-undo.** If the workspace has moved on such that an
  inverse no longer applies cleanly — the card was edited again, the source
  already deleted — say so per operation and revert only what still applies,
  reporting the rest. A partial revert the user knows about beats a silent one.
- **Per-operation revert**, for the same reason acceptance is per-operation: a
  pass of forty edits usually contains a few worth keeping.

## 9. Phasing

| Phase | Delivers |
|---|---|
| **X0** | **Revert from the journal** — the prerequisite above. Small, and independently useful for in-app changesets |
| **X1** | Format, validator with dry-run report, import honouring approval mode, external actors |
| **X2** | Briefing export generated from the live registry and workspace |
| **X3** | Fingerprint/staleness warnings, partial-apply from the dry-run report, drag-and-drop import |

X1 alone is enough for the intended workflow: export a briefing by hand,
paste, receive a changeset, import it, review it.

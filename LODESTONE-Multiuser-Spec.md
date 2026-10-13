# LODESTONE Multi-User — Design Plan

**Several people editing one workspace, seeing each other's work as it happens**

Version 0.1 · August 2026 · Companion to *LODESTONE Assistant v2* and
*External Changesets*.

---

## 1. The asset we already have

Multi-user sync is, at bottom, the problem of replicating *changes* rather than
*documents*. LODESTONE already expresses every change as a discrete, validated,
reversible operation:

- every mutation goes through one **ACTIONS registry** entry;
- each records an **inverse**, computed when the prior state is known;
- each is attributed to an **actor**;
- they group into **changesets** with a task and a note;
- the **journal** already keeps a durable record of them.

That is an operation log in all but name. It was built for review and
provenance, but it is exactly the primitive collaborative editing needs. The
plan below is mostly a matter of moving where that log lives and who gets to
see it.

The thing we lack is equally clear: **truth lives in `localStorage`**, which is
per-browser by construction. Everything else follows from moving it.

## 2. The decision that shapes everything: operations, not documents

Three ways to synchronise state, and the choice is not close for this tool.

| Approach | How it merges | Why not / why |
|---|---|---|
| **Document sync** (last write wins) | Whole workspace overwritten by whoever saved last | Loses work silently. Unusable. |
| **CRDT** (Yjs, Automerge) | Mechanical, automatic, no server logic | Powerful and wrong here. A CRDT *resolves* conflicts by rule. This tool's fifth principle is that **divergence is content, not noise** — when two analysts disagree about a claim, the disagreement is the finding, and a library that silently reconciles them destroys exactly what the workspace exists to capture. |
| **Operation log + broadcast** | Server orders operations; clients apply in order; genuine conflicts are surfaced to a person | Fits what we already have, keeps *why* alongside *what*, and lets a conflict become a `conflicts-with` link instead of a merge artefact. **Recommended.** |

So: the server holds an append-only, ordered log of operations per workspace.
Clients send operations and receive them. The workspace is the fold of its log.

## 3. Architecture

```
   Browser A                    Server                     Browser B
   ─────────                    ──────                     ─────────
   ACTIONS (local, optimistic)
        │  POST /api/ops  ──────▶ validate, assign seq,
        │                         append to log, persist
        │  ◀── {seq, applied}         │
        │                             ├── SSE ──▶ apply op, render
        │  ◀────────── SSE ───────────┘
   apply confirmed seq
```

**Truth moves to the server.** A workspace becomes rows in a store — SQLite is
ample; this is tens of thousands of small records, not a web-scale problem —
holding the entity tables plus the operation log. `localStorage` is demoted to
a cache and an offline buffer.

**Live updates by SSE, not WebSockets.** The traffic is one-way in the
interesting direction: clients already POST operations over ordinary HTTP, and
only need a push channel back. `EventSource` reconnects on its own and carries
a last-event-id, which gives resumption after a dropped connection for free.
No new dependency.

**Sequence numbers, not timestamps.** Clocks disagree; a monotonic per-workspace
sequence does not. A client tracks the highest sequence it has applied, and on
reconnect asks for everything after it.

## 4. Concurrency: refuse and surface, do not merge

Every entity carries a revision counter. An operation declares the revision it
was composed against.

- **Disjoint operations** — different cards, or additive operations on the same
  card such as `cite` and `link_cards` — commute and simply apply. This is the
  overwhelming majority of real editing.
- **Genuinely conflicting operations** — two `update_card` calls on the same
  statement — are detected by a stale revision. The second is **rejected, not
  merged**, and its author is shown what changed underneath them, with the
  choice to reapply, amend, or record the disagreement.

That last option is the one that matters and the one a CRDT cannot offer: when
two analysts disagree about what a card should say, the right outcome is often
*two cards and a `conflicts-with` link*, not one reconciled sentence.

Operations that are idempotent by nature already refuse duplicates — linking
the same pair twice, citing the same source and locator twice — so replay is
safe.

## 5. What happens to changesets

Changesets survive intact and gain a role.

- A changeset becomes **visible to everyone as pending**, tagged with its
  actor. Two people should not unknowingly research the same gap.
- **Only the changeset's owner, or a user with the editor role, may accept it.**
  Acceptance is the moment operations become part of the shared board.
- In `apply` mode operations are live immediately, as now, and the journal
  keeps the inverses.
- The in-situ pending rendering already distinguishes proposed from committed;
  it now also needs to say *whose*.

This is the human-in-the-loop principle scaling to a group: the assistant
proposes, and a *named person* accepts.

## 6. Identity

The actor registry becomes the seam. Today an actor is declared in Settings and
taken on trust, which is honest for a single-browser prototype and untenable
the moment two people share a board — "who accepted this recommendation" has to
mean something.

- Phase 3 introduces real accounts: sign-in, a session, and actors that map to
  authenticated users. LLM actors continue to exist alongside human ones.
- Roles, matching FR-G1: **owner** (settings, membership, deletion), **editor**
  (propose and accept), **commenter**, **viewer**.
- The governance exceptions already documented — budgets, workspace lifecycle,
  approval mode — become owner-only rather than merely not-the-assistant's.
- NFR-2's SSO is a later substitution of the identity provider, not a redesign.

## 7. The parts that get harder, stated plainly

**Rendering.** `render()` rebuilds a whole view's `innerHTML`. Applying a remote
operation mid-edit would destroy an open card form or a half-typed assistant
prompt. Remote operations must therefore patch what has changed and leave
in-progress editing alone — the first real front-end work in the plan, and the
one most likely to be underestimated.

**Model runs.** The Excel adapter drives a single application instance and
cannot run twice at once; the browser adapter is merely expensive. Runs become a
**server-side queue** with a visible position, not a free-for-all.

**Cost.** One shared daily cap across several people is a race. Spend needs
per-user accounting, per-user caps, and a workspace cap above them.

**The assistant.** Its reads must see committed shared state, and its mutations
enter the log like anyone's. Its conversation stays private to the user who ran
it; only the changeset is shared.

**Per-user artefacts.** `briefings/latest.md` is currently global — with two
users it hands one person's board to the other's assistant. Briefings, backups
and conversation logs all become per-user or per-workspace paths.

**The published artifact.** The static, serverless build has no server to sync
with. It stays single-user and local; the collaborative deployment is a
separate target rather than a replacement.

## 8. Phasing

Each phase leaves a working application, and the risky part comes last.

| Phase | Delivers | Why this order |
|---|---|---|
| **M1 — Server storage** | Workspaces move to SQLite behind the same ACTIONS calls; `localStorage` becomes a cache. Still one user, no visible change. | Decouples the storage move from the concurrency problem. If this is wrong, it is wrong in isolation. |
| **M2 — Operation log + SSE** | Operations persist to a log; a second browser on the same workspace sees changes appear. Still one identity. | Proves replication and incremental rendering with nobody to conflict with. |
| **M3 — Identity and roles** | Accounts, sessions, actors bound to real users, owner/editor/commenter/viewer. | Attribution becomes meaningful before concurrent editing makes it matter. |
| **M4 — Concurrency** | Revision checks, conflict surfacing, shared pending changesets, per-user cost accounting, run queue. | Everything it depends on is already in place and observable. |
| **M5 — Presence** | Who is looking at what; optional. | Genuinely optional. This is not a text editor and cursors are not the point. |

M1 and M2 together already satisfy the stated goal for a single analyst working
across two machines. M3 and M4 are what make it safe for two people.

## 9. What we should not build

- **A CRDT for the evidence graph.** Silent reconciliation is the wrong answer
  for a tool whose purpose is to make disagreement explicit.
- **Operational transform for card text.** Two people typing the same sentence
  simultaneously is not the real workflow; two people working different corners
  of an argument is. Entity-level revisions are enough.
- **Syncing assistant conversations.** They are per-user working notes. The
  changeset is the shared artefact.
- **Real-time cursors before M4.** Presence is a nicety; correct attribution
  and honest conflicts are the requirement.

## 10. Before any of this

The server currently binds to every interface with **no authentication at all**,
so anyone on the same network can already list and download backups — which are
whole workspaces — trigger model runs against the API keys, and spend the daily
budget. That is tolerable for a single-user local tool bound to loopback. It is
not a foundation to put multiple users on.

**Binding to `127.0.0.1` is a one-line change and should happen regardless of
this plan.** Authentication (M3) is the prerequisite for exposing the server to
anything wider.

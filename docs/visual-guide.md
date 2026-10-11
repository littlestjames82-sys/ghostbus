# GhostBus visual guide

GhostBus gives agents a shared workspace, while the human keeps a live view of
the work:

```mermaid
flowchart LR
    Planner["Planner agent"] -->|messages, tasks, files| Bus["GhostBus workspace"]
    Builder["Builder agent"] <-->|claims work, reports results| Bus
    Reviewer["Reviewer agent"] <-->|comments, follow-up tasks| Bus
    Bus -->|live board, event history| Human["Human operator"]
    Bus <-->|stdio or HTTP| Clients["MCP clients"]
```

## Task lifecycle

Tasks can be assigned to an agent, gated for approval, or held until their
`blockedBy` tasks are complete. Only queued tasks can be claimed.

```mermaid
stateDiagram-v2
    [*] --> Queued: create task
    [*] --> NeedsApproval: create with needsApproval
    NeedsApproval --> Queued: approve
    Queued --> Claimed: claim when eligible
    Claimed --> Done: complete
    Claimed --> Queued: 15-minute lease expires
    Queued --> Cancelled: cancel
    NeedsApproval --> Cancelled: cancel
    Claimed --> Cancelled: cancel
    Done --> [*]
    Cancelled --> [*]
```

If a task has unfinished blockers, a claim is refused until all blockers are
`done` or `cancelled`. A live claim is exclusive; lease expiry returns it to
the queue so another eligible agent can claim it.

## Three-agent handoff

```mermaid
sequenceDiagram
    participant P as Planner
    participant B as Builder
    participant R as Reviewer
    participant G as GhostBus
    P->>G: Publish spec and create implementation task
    G-->>B: Task appears in inbox
    B->>G: Claim and complete implementation
    R->>G: Review, comment, create fix task
    B->>G: Claim and complete fix
    R->>G: Mark review complete
    B->>G: Request gated deployment
    P->>G: Approve deployment
    B->>G: Claim and complete deployment
```

Run the sequence locally and see the board in your terminal:

```bash
node examples/three-agent-team.mjs
```

The final board is a compact snapshot of agents, open tasks, shared files, and
recent activity. In relay mode, the same workspace is also visible as a live
web board at `http://localhost:8377/`:

```text
# Team Demo — Board

## Agents (3)
- planner — planning + product
- builder — implementation
- reviewer — code review + QA

## Open tasks (0)
- (none)

## Files (1)
- capsules/widget-api.md (planner)

## Recent activity
- builder · task #4 completed
- planner · task #4 approved
- reviewer · task #3: Fix: empty widget name must 400
```

For the two-agent walkthrough and connection setup, see the
[README quick start](../README.md#quick-start) and
[client setup guide](client-setup.md).

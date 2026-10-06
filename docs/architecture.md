# Logic, effects and orchestration

First-party application and tooling code follows three responsibilities:

| Role | Responsibility | Dependencies |
| --- | --- | --- |
| Logic | Validate, parse, calculate, select or format a result from explicit inputs. | Other logic and static data. |
| Effects | Read/write files, storage, DOM, network or native APIs; obtain time/randomness; schedule work; print output. | Logic and other effects. |
| Orchestration | Own lifecycle/state and order calls to logic and effects, including failures and cleanup. | Any role. |

Pure functions do not mutate their inputs, retained instances or caller-visible shared state. Local scratch objects inside a calculation are fine. A mutable controller, store, state machine, cache or job queue belongs to orchestration even when its effects are injected. Embedded immutable native catalogs may be initialized once when only scalar queries escape. A function accepting a query callback requires that query to be read-only. Clock values, generated identifiers and observed state enter logic as arguments.

The separation follows existing domain owners rather than three giant application folders. `*-logic.ts`, `*-policy.ts`, `*_logic.rs`, and the tooling policy modules contain extracted decisions. Effect adapters describe their operation, such as map reads, storage or scheduling. Existing public modules and command/script entrypoints compose those owners and retain compatibility exports. Runtime consumers of a pure function import its logic owner directly; a compatibility facade can also expose stateful orchestration.

Examples:

```text
profile store      → profile document/collection logic → storage effects
map loader        → HTTP/timeout effects → map document logic
controller        → admission/encoding logic → transport
current form save → document/revision logic → private file transaction
release command   → version/publication policy → filesystem/GitHub effects
catalog main      → source reads → build_catalog(inputs) → write/print
```

Keep effect ordering visible. A persistence failure must not commit a new in-memory collection. A send failure must retain unresolved receipts. Update continuation removes and syncs a one-shot checkpoint before validating/exposing it. Native commands retain view authorization, maintenance admission and lock ownership. Extracting a condition must not eagerly evaluate a previously short-circuited stateful query.

## Domain values and external data

An external number or string is evidence to validate, not a domain value merely because a type annotation names it. Keep raw wire, JSON and editable form DTOs separate from admitted domain models. At the existing admission point, the owning parser checks structure, field-specific bounds and relationships, then produces distinct validated identities, quantities, units and revision channels. Pure decisions consume those models; orchestration retains lifecycle ownership; effects serialize their values using the unchanged external representation.

Use private-field Rust newtypes with typed constructor errors and no unchecked construction path. Deriving `Deserialize`, `Generic` or `LabelledGeneric` for a scalar can bypass its constructor even when its field is private. Deserialize raw DTOs and convert at the existing validation stage, or use explicitly validated deserialization. Frunk may assemble or transform already validated components. An aggregate with relationships between fields still needs a checked constructor; individually valid components do not establish those relationships.

TypeScript and checked Bun JavaScript use opaque or branded primitives and readonly domain records. Put nominal assertions in the small owning constructors/parsers, after their runtime checks. Callers use those owners, rather than asserting that a primitive has a domain type. A readonly view over a mutable external alias is insufficient: retain owned data or detach it at admission, including nested arrays. Mutable UI drafts and state owners remain separate from readonly policy inputs.

Related fields need an aggregate admission proof as well as scalar brands. TypeScript object spreads retain public symbol markers, allowing an edited copy to appear admitted. Settings and available resource evidence instead use erased private declaration fields: edited copies lose admission and must pass through their owner again. These declarations add no runtime class, prototype or JSON field.

Arithmetic returns an ordinary primitive. Revalidate results that could violate a brand, including quantity subtraction, revision increments and unit conversion overflow, before changing owned state or dispatching an effect. Distinguish revision channels and use explicit seconds/milliseconds conversions. Preserve signed protocol timing and zero/negative wire sentinels in their actual owners; a general domain constructor does not replace narrower schema bounds or admit a sentinel as an identity.

Keep primitives for binary offsets, opcodes, flags, search indexes and scratch arithmetic, platform handles, display text and unvalidated drafts. A wrapper must protect an actual domain distinction or construction invariant. Compile-time tests should call real domain consumers with incompatible values; runtime tests cover malformed input, alias mutation, boundary values, arithmetic, unchanged serialization and failure ordering. These checks enforce selected compile-time contracts and exercise runtime admission contracts; they do not establish the safety of deliberate unchecked casts or arbitrary reflective construction.

### Ownership and audit scope

The domain audit covers the production owners in `architecture.json`, including native entrypoints, browser/Bun code, release scripts, Python generators and root configuration. Generated catalogs, vendored sources and external schemas keep their upstream representation. The useful distinction is an admitted value reaching a consumer, rather than the number of primitive fields replaced.

| Family | Protected boundary and consumers |
| --- | --- |
| Gameplay | Item versus bag identities in inventory and receipts; learned skills; actor lifetime identities; admitted disposition rules and supply goals; revision channels; admitted form/run settings; explicit configuration time units; available versus unavailable resource evidence. |
| Frontend and persistence | Profile identities/names/timestamps, form revisions, login slots, close capabilities, update correlation, registry documents and readonly map/recovery projections. Editable drafts are detached from admitted settings. |
| Native admission | Checked credential components, form metadata, command/run admission, recovery thresholds, continuation ownership and close lifecycle. Raw serde records retain the existing schema; private aggregates retain admission through their consumer. |
| Native update and geometry | Stable candidate versions and verified archive ownership; requested view extents are distinct from valid clipped extents, which may be smaller than one pixel. |
| Bun release and CI | Source versus tag-object identity, distinct digest purposes, workflow/job/artifact identity, typed release planning/provenance and closed platform/process outcomes. Runtime constructors and checked JSDoc connect policy outputs to effects. |
| Python catalogs and packaging | Frozen scene/grid/position/portal records, recovery/refine rules and asset/archive evidence at parsing and calculation boundaries. Validate grid dimensions once per used map. |

Several apparently similar values intentionally have different policies. Actor zero is valid, while item/bag zero and offline protocol sentinels are not admitted IDs. Learned skill IDs have a wider range than byte-sized actions. An absent form map is allowed before Start. A respawn identity may carry an unknown self incarnation of zero. Signed wire timing is not a positive duration. Native credentials and update accounts have stronger validation than the existing browser login form.

Compatibility adapters also retain historical loose inputs. Engagement observation worlds are correlation strings, while manual requests additionally require the existing UUID syntax. Game-status session observations are not verified continuation identities. Continuation account mode is checked using its existing string coercion but retained as an unknown raw value; it is not falsely declared a canonical mode. The frontend forwards a native updater reservation as an opaque payload and preserves its existing cleanup condition. Narrowing these contracts belongs to a separately specified behavior change.

Ordinary primitives remain in binary/ELF/FFI decoding, navigation search and per-cell probes, scratch counters, uninterpreted telemetry, authoring/display values and declarative external configuration. Typed records already distinguish benchmark measurements by field; branding each local sample or loop index adds no useful boundary. Native `Instant`, `Duration`, platform handles and archive-library records retain their existing types and lifetime rules.

Verification combines the normal compiler gates with negative examples at actual consumers, Rust constructor/serde/Frunk bypass checks, runtime boundary and alias tests, and existing composed regression suites. Offline packet, routing and catalog comparisons provide bounded behavior/performance evidence; they do not establish live gameplay, deployed updates or external catalog regeneration.

## Unary functions and composition

Prefer a named input record for decisions with several related arguments, especially booleans. For repeated evaluation against the same context, bind that context once and return a unary function that can be passed directly to `map`, `filter` or `every`:

```ts
import { map } from 'remeda';

const evaluate = actorPredicateEvaluator(snapshot);
const results = map(conditions, evaluate);
```

The observation belongs to one synchronous decision pass. Treat it as read-only and bind a new evaluator when the snapshot changes; do not retain an evaluator across ticks as a cache. Returned traces and actions remain detached from their inputs. Static predicates, such as feature flags, can be composed once at module initialization. Release discovery similarly binds the expected source revision before filtering workflow runs.

Use currying when an earlier argument is reused or the resulting unary function fits a higher-order operation. Keep simple positional functions and language-native iterators when an extra closure adds no useful composition. Preserve short-circuiting, diagnostic precedence and effect timing: read stateful evidence in orchestration only after its admission checks pass.

## Functional libraries

Remeda is the shared composition library for first-party TypeScript and Bun tooling. Use named imports for pure transformations and reusable predicates, with data-last functions when binding configuration for a pipeline. The architecture policy records the allowed operations; randomness, timers and retained-state helpers belong to effect or orchestration modules. Namespace imports and unrestricted re-exports are rejected in logic.

Remeda can fuse adjacent lazy transformations. Use fused pipelines for dense collections and pure unary callbacks. Preserve intermediate arrays when a callback depends on its index or array, and keep ordered validation separate when evaluating later values would change the first error. Effectful callbacks remain in explicit orchestration. Object transformations must preserve validated key constraints and output detachment.

Frunk is the shared composition library for native Rust logic. Use its typed transformations and validation combinators where they remove repeated domain assembly or validation. Independent pure checks may accumulate internally; public errors and precedence remain part of the existing contract. Keep dependent admission, bounded decoding, locks, file transactions and transport lifetimes sequential. Rust closures bind context for unary evaluation without a separate currying layer.

These libraries apply across application and tooling domains. Data-only schemas, scalar arithmetic, byte codecs, performance-sensitive search loops and effect adapters retain their language-native implementation when no library composition is involved. A dependency import in every file is not an architectural requirement. Generated and vendored code stays with its owning generator or upstream source.

## Applying the seven levels

Use the levels to choose an abstraction that earns its place in the domain. The existing architecture supplies functions, immutable calculations and higher-order composition; further refactors should make valid states and execution contracts clearer.

| Level | Application in this project |
| --- | --- |
| 1. Functions and immutability | Explicit observations enter pure decisions; orchestration owns state changes and effect ordering. |
| 2. Higher-order functions | Context-bound unary evaluators and Remeda transformations compose repeated decisions. |
| 3. Algebraic data types | Rust enums and TypeScript discriminated unions represent mutually exclusive lifecycle states and outcomes. |
| 4. Typed errors and effects | Rust `Result`/`Option` and tagged failure causes retain machine-readable meaning; adapters preserve existing public errors. |
| 5. Abstract execution | Small domain traits and capability interfaces have production and deterministic test implementations. |
| 6. Composition | Frunk accumulates independent validation. Condition-state monoids combine bounded traces with explicit identity and priority rules. |
| 7. Programs and interpreters | The native replacement program runs against its effect trait; route generators run through synchronous and cooperative interpreters. |

Keep diagnostic text as a projection of a typed cause. Receipt retirement must depend on whether the server rejected an action, rather than on the spelling of its display message. Tagged outcomes distinguish successful `undefined` results from arbitrary thrown values; cleanup preserves an already established failure.

An effect interface describes the operations available to a domain program. Its interpreter performs those operations; the program still belongs to orchestration. Pure transition functions return the next state or a request for an effect, with generated tokens supplied by the caller. Keep locks and resource lifetime with their existing owner across the entire operation, including rollback and cleanup.

Composition has laws and domain-specific priorities. Both condition folds use `matched` as the identity and associative combination. Automation and attack strategies give `unavailable` priority; routine selection gives `unmatched` priority. Evaluate the same diagnostic traces before folding, and retain existing short-circuit evaluation where it is part of the contract.

Use higher-level encodings when multiple real interpreters or repeated traversals benefit. The replacement trait is a domain-specific, final-style program, and planning generators are suspended computations. These do not require a general Free-monad runtime or higher-kinded type emulation. Add recursion schemes only for an existing recursive model whose repeated traversals become simpler; runtime conditions remain bounded flat lists with the current wire schema.

## Enforcement and proof

`architecture.json` records a role for every first-party JavaScript, TypeScript, Python and Rust production source under `src`, `src-tauri/src`, `scripts` and `tools`, plus root configuration and the native build entrypoint. Tests, generated output, static data and vendored upstream code have separate ownership and are excluded from the role inventory. Code beside static data remains covered. New production source must be classified; removed source must be removed from the inventory.

`bun scripts/architecture.mjs` checks the inventory, JavaScript/TypeScript runtime dependencies and ambient effects, Python logic imports/effects, and Rust logic effect references. `bun run check` runs its regression suite with the other script checks. Erased TypeScript imports do not create runtime dependencies. Deterministic hashing and parsing are logic; source acquisition and printing are effects.

This guard establishes dependency and ambient-effect constraints, not mathematical purity. It cannot prove that an injected callback is read-only or that a value is never mutated through an alias. Review those contracts and test unchanged inputs, repeated outputs, ordering, cancellation and failure paths. Native module dependencies and transaction ownership also require source review. Existing integration tests remain the proof for composed behavior; local checks do not establish hosted packaging or live game behavior.

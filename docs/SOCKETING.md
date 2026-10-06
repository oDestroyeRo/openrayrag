# One-card socketing

Inventory & skills → **Socket one card · irreversible** is a manual operation. Stop other actions, select a currently observed unequipped target and regular card, request the preview, then explicitly click **Consume 1 card and socket permanently**. The preview shows the bag, refine level, all four existing slots, first free slot and protected card reserve. There is no automatic equipment change, replacement, unsocketing, retry, routine or profile replay.

Permissions come from Rebuild `4099e2c000c3c550516760b9c1241595aac9aceb`: `ItemsWeapons.csv`, `ItemsEquipment.csv`, `ItemsCards.csv`, `ItemType.cs`, `CsvItem.cs`, `DataLoader.cs` and `PacketSocketEquipment.cs`. The generated catalog records each exact Git-blob hash and the published item-file hash; ID, code, name, class, uniqueness and slot capacity must match. Weapon compatibility uses `Weapon=16`, including two-handed weapons; armor uses the owning equipment mask. Headgear uses `Headgear=7`, separately from its published worn-position bits.

Only non-crafted unique weapons/armor with complete observed raw identity, supported capacity 1–4 and a first zero slot are available. Every equipment alias and selected ammo are protected. Existing nonzero slots must be verified compatible cards, and unsupported data outside the capacity blocks the target. One regular card must remain above the currently visible recovery/ammo/escape and per-item keep reserves. Preview and commit both carry a strictly validated `policy: AutomationSettings`; this does not start a field run or require selected monsters. The controller detaches only the computed protected floors and binds them to the preview. UI edits retire the preview; commit independently verifies the same relevant policy against fresh stock. The public UI receives bounded candidates and a purpose-specific preview; raw GUIDs and the controller's private inventory proof are not published.

`socketPreview` accepts positive int32 `targetBagId`, `cardBagId` and the visible protection `policy`; `socket` additionally requires the current private preview's opaque token. The controller rechecks identity, map/socket/world incarnation, inventory/equipment revisions, full metadata and reserves immediately before dispatch. The separate manual transport writes opcode 63 followed by target bag and source bag as two int32 values. Generic actions, routines, workflows, supply and saved settings do not accept a socket request.

The receipt is captured before the write. **Pending** is one transmitted attempt, including a possibly successful write that throws. **Confirmed** requires the exact source decrement by one and exact same target bag/item/GUID/count/refine/flags with only the expected first-free slot changed. Every other inventory row and equipment alias must remain identical. Both event orders work; repeated evidence and target mutations do not dispatch again. Opcode 50 has no sequence/transaction ID, so an extra raw decrement is conservatively treated as an additional stock change and cannot establish the original exact result.

Stop, timeout, manual input, death and context changes retain the unresolved receipt as **Uncertain**. After Stop or timeout, late exact evidence in the original actor/socket/map context can confirm it without resuming. Trusted input in the official game document immediately retires unsent memo and socket previews, even while automation is idle. For a sent socket request that input makes sparse results ambiguous: no late card/target pair may release ownership or infer success. A fresh full inventory on the original character can restore known state as **Reconciled**, including initialization received before the own spawn; its staged readback is bound to that announced session/lifetime and both inventory/equipment revisions. It does not infer the prior result. The exact previously sent target-layout/card attempt remains blocked for this page, and no receipt, token or reservation is saved in profiles. A new page cannot replay queued commands; origin/build/socket and page-generation gates remain in the bridge. Generic rejection messages cannot prove rollback.

Local evidence uses public metadata and synthetic source-shaped packets only. No live socketing or resource-changing verification is authorized. Published-source compatibility does not establish deployed socket behavior.

Regenerate deterministically:

```sh
python3 scripts/catalogs/build-socket-catalog.py SOURCE_REPO ITEMS_JSON src/data/socket-catalog.json
```

`SOURCE_REPO` must contain the fixed pin; its checkout HEAD is ignored. `ITEMS_JSON` is the public generated item catalog. Unknown source entries remain unavailable; identity mismatches fail generation.

## Integrated verification · 2026-10-02

`npm run check` passed 1,457 TypeScript tests and 44 Rust tests, with the existing Keychain integration test ignored, plus frontend/bridge build, typechecking and Clippy. Formatting and diff checks passed. The 1,499-item catalog regenerated byte-identically; all nine default routing benchmark outcomes and search counts were unchanged. Independent source/economic and controller/native/UI reviews cleared the final integration, including failed-admission preview invalidation, current visible reserves, memo exclusion, actor zero, manual-input uncertainty and staged full-inventory reconciliation.

`npm run app:build` and strict ad-hoc signature verification passed for the ARM64 app. Binary SHA-256: `1c4b11c0faef2294eb352412f25953d47636dc489c79abe08deb90a5ace98b4d`. Native inspection encountered an active user character session, which was left intact; the offline socket-panel check remains unrun. No card was consumed and no deployed socket receipt was tested. No remote CI is configured, and the app is not notarized.

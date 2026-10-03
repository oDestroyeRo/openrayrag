# Run dashboard design QA

final result: passed

Reviewed 2026-10-03 for issue #97. The user selected Product Design option 2, the Run dashboard. This is the existing production client, with its original forms, controllers and command admission.

## Evidence and comparison

- Source visual truth: [selected option 2](docs/design/run-dashboard/selected-option-2.png), original 1402 × 1122 pixels.
- Normalized target: [1100 × 880 source capture](docs/design/run-dashboard/selected-option-2-normalized.jpg). The original was rendered as one image at 1100 × 880 CSS pixels, then captured at devicePixelRatio 1. The small aspect difference is under 0.1%.
- Final implementation: [desktop](docs/design/run-dashboard/desktop.jpg), 1100 × 880 CSS/pixel dimensions, density 1, Run selected, dark theme, synthetic connected/running character, idle controller task and Nearby selected.
- Additional states: [minimum window and unresolved refine](docs/design/run-dashboard/minimum-held.jpg), 820 × 750 at density 1; [stale observations](docs/design/run-dashboard/stale.jpg), 1100 × 880 at density 1.
- Preview: `http://127.0.0.1:4183/?scenario=running&view=app`. This temporary local harness loads the actual application entry with blocked native/account/network/update backends. It is not live gameplay proof.

The normalized target and final desktop screenshot were opened together in the same comparison input. The original source and implementation were also compared together. Full-size text, bars, navigation, buttons and map legends were readable in those inputs; no extra magnified crop was necessary. An independent visual reviewer found no P0/P1/P2 differences after corrections.

Source content is illustrative. The application retains real fixture/controller observations: no active attack is invented, recovery remains OFF, counters remain zero, and command requests do not become confirmations. The existing log provides Time/Event data, so no artificial Outcome column was added. The map remains a functional collision canvas; it is not a mockup background.

## Iterations and resolved findings

1. **P1: stale idle task in the running headline.** The first capture showed RUNNING beside “Ready. Choose your targets…”. Only active controller task labels now contribute to the headline and Activity summary. Stale connected observations produce “Waiting for fresh game status”, including a pending combat task. Full owner reasons and death-limit waiting remain intact.
2. **P2: major regions below the default window.** The initial map repeated idle instructions and pushed Nearby and session details below 880 pixels. Compact monitor spacing, grouped Map details & coordinates, hidden idle placeholders, and denser inspector spacing fix this. Meaningful requests, errors and observed receipts remain outside the disclosure. Final measurements: monitor y66/h79; Activity y298/h492; map y236/h434; inspector y686/h152; connection details y806/h45. All fit the default viewport without horizontal overflow.
3. **P2: hidden manual feedback.** Map/attack feedback initially lived in collapsed coordinate details. Submitted feedback and observed bounded-command results are now always visible when present.
4. **P2: disconnected tooltips retained earlier identity.** Disconnect now resets character and location titles together with displayed values; an actual-main UI regression checks this.

Each correction was followed by affected tests and a revised browser capture or interaction check. The final desktop capture retains the same viewport, page, theme and synthetic run state as the earlier comparisons.

## Fidelity and usability surfaces

| Surface | Result |
| --- | --- |
| Fonts and typography | Native system sans-serif with 28px run headline, 14px primary copy/actions and 12px supporting metadata. Weight and hierarchy match the selected compact design. Times use a non-wrapping 24-hour format. Long character/map text retains its full accessible text and tooltip. |
| Spacing and layout | Horizontal navigation, persistent monitor and run controls, 60/40 Activity/map split, 16–18px card rhythm and compact setup strip. Nearby and connection access are visible at the default size. The minimum window wraps the resource strip and scrolls content while preserving Stop and the full hold reason. |
| Colors and tokens | Navy canvas #030b1e, panel #0c172e, border #2f3e5a, green run/navigation emphasis and red Stop #fd6768 follow the selected direction. Existing semantic warning/focus colors remain distinct from state labels. |
| Image quality and assets | Original selected target preserved. Collision canvas uses existing map data and scales without substituting illustrative actors. Official pinned Tabler SVG assets supply consistent outline controls; no generated art or handcrafted icon substitutes. |
| Copy and content | Labels are Run/Setup/Tools/Settings. Setup uses the current form without starting a run. Unknown resources stay dashes. Full uncertainty reasons remain visible. Live data differences from the mock are intentional. |
| Accessibility and interaction | Text-named actions, decorative icons hidden from assistive technology, focus-visible outlines, skip link, ARIA tab relationships, retained mounted controls, and keyboard Arrow/Home navigation verified. Action buttons retain appropriate hit areas; disabled action admission is unchanged. Reduced-motion styling remains present. |

## Local interaction proof

- Start/Stop use the existing callbacks; Stop retains Warp/refine uncertainty and keeps manual controls locked.
- Edit setup and page/inspector navigation send no game commands. Coordinates, selected observed item, profile draft and account mode/slot survive navigation.
- Manual walk and item requests reach the blocked mock boundary and show an unconfirmed/blocked outcome, never a successful transaction.
- Deaths 2 with cap 1 remain WAITING; recovery OFF is preserved.
- During a sender-free mock updater reservation, Edit setup and inspector navigation stay enabled while Start/Stop and action inputs are disabled. Finally restores controls after rejection without a nonce, native lease or install. The harness reservation was extended from 2 to 10 seconds only to observe this interaction.
- Disconnect clears observed resources, allows explicit mode switching and retains empty credentials. No account was used.
- Final build/typecheck, 3,242 TypeScript tests, 108 Rust tests and Clippy passed. The local ARM64 app packaged and passed strict ad-hoc signature verification without launch/install.

## Remaining limits and optional polish

Live account acceptance, actual gameplay, native window appearance and an installed updater/restart were not exercised in this UI task. Browser fixtures and packaged integrity are separate proof surfaces. Optional P3: a compact authoritative connection indicator beside Account could expose session state without opening its disclosure; current run status and session details already use existing observations.

export type ClientPage = 'session' | 'bot' | 'manual' | 'settings';
export type BotSection = 'combat' | 'recovery' | 'travel' | 'inventory' | 'workflows';

export interface ClientShell {
  readonly main: HTMLElement;
  readonly sections: Record<BotSection | 'profiles', HTMLElement>;
  readonly manualTools: HTMLElement;
  readonly sessionDetails: HTMLElement;
  showPage(page: ClientPage): void;
  showBotSection(section: BotSection): void;
  refreshManualIndex(): void;
}

const pages: readonly ClientPage[] = ['session', 'bot', 'manual', 'settings'];
const botSections: readonly BotSection[] = ['combat', 'recovery', 'travel', 'inventory', 'workflows'];

function icon(paths: string): string {
  return `<svg class="client-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const sessionIcon = icon('<path d="M3 12h4l3-8 4 16 3-8h4"/>');
const botIcon = icon('<rect x="5" y="7" width="14" height="13" rx="3"/><path d="M12 3v4M2 11v5m20-5v5M9 16h6"/><path d="M9 11h.01M15 11h.01"/>');
const toolsIcon = icon('<path d="m14 6 4 4M3 21l7-7m4-11a6 6 0 0 0-7 7l7 7a6 6 0 0 0 7-7l-4 4-7-7 4-4Z"/>');
const settingsIcon = icon('<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>');
const openIcon = icon('<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>');

/** Mount once before binding the existing controller callbacks and feature forms. */
export function mountClientShell(root: HTMLElement): ClientShell {
  root.innerHTML = `
    <main class="client-shell">
      <a class="client-skip-link" href="#client-page-session-title">Skip to page content</a>
      <header class="client-toolbar">
        <div class="client-toolbar-heading">
          <div class="client-brand"><h1>rayrag</h1><span>Companion</span><small id="client-version">macOS · preview</small></div>
          <div class="client-session-identity"><strong id="character">No character connected</strong><span id="status" class="pill">OFFLINE</span></div>
          <p id="location">Connect an account to load your character.</p>
        </div>
        <div class="actions run-controls">
          <button id="start" type="button" class="primary" disabled>${icon('<path d="m8 5 11 7-11 7V5Z"/>')}Start bot</button>
          <button id="stop" type="button" class="client-stop" disabled>${icon('<rect x="6" y="6" width="12" height="12" rx="1"/>')}Stop</button>
          <button id="disconnect" type="button" class="secondary" title="Closes the connection; cannot undo server actions" disabled>Disconnect</button>
          <button id="open" type="button" class="secondary">Connect account ${openIcon}</button>
        </div>
        <div id="notice" class="notice" role="status" aria-live="polite">Connect an account and select a character. The bot starts only when you choose Start.</div>
        <p id="config-help" class="hint" role="status" aria-live="polite"></p>
        <div class="console-character-bar" aria-label="Character monitor">
          <div class="health"><div><span>HP</span><b id="hp-text">— / —</b></div><div class="health-track"><i id="hp-bar"></i></div></div>
          <div class="health"><div><span>SP</span><b id="sp-text">— / —</b></div><div class="health-track client-sp-track"><i id="sp-bar"></i></div></div>
          <dl class="console-character-stats"><div><dt>Base / job level</dt><dd id="console-levels">— / —</dd></div><div><dt>Weight</dt><dd id="console-weight">— / —</dd></div><div><dt>Zeny</dt><dd id="console-zeny">—</dd></div><div><dt>Deaths / cap</dt><dd><span id="death-count">—</span> / <span id="death-cap">—</span></dd></div></dl>
          <p id="console-experience" class="console-experience">Base EXP — · Job EXP —</p>
        </div>
      </header>

      <nav class="client-page-nav" role="tablist" aria-label="Companion pages">
        <button id="client-tab-session" type="button" role="tab" data-client-page-nav="session" aria-controls="client-page-session" aria-selected="true">${sessionIcon}Console</button>
        <button id="client-tab-bot" type="button" role="tab" data-client-page-nav="bot" aria-controls="client-page-bot" aria-selected="false" tabindex="-1">${botIcon}Bot</button>
        <button id="client-tab-manual" type="button" role="tab" data-client-page-nav="manual" aria-controls="client-page-manual" aria-selected="false" tabindex="-1">${toolsIcon}Manual tools</button>
        <button id="client-tab-settings" type="button" role="tab" data-client-page-nav="settings" aria-controls="client-page-settings" aria-selected="false" tabindex="-1">${settingsIcon}Settings</button>
      </nav>

      <div class="client-pages">
        <section id="client-page-session" class="client-page" role="tabpanel" aria-labelledby="client-tab-session">
          <div class="client-page-heading console-heading"><div><h2 id="client-page-session-title" tabindex="-1">Bot console</h2><p>Your field, inventory and action history in one workspace.</p></div><p id="console-lock" class="hint">Connect a verified character to use manual controls.</p></div>
          <div class="bot-console-grid">
            <section class="panel activity console-map" aria-labelledby="client-field-title">
              <div class="panel-title"><h3 id="client-field-title">Current field</h3><span id="map-label">WAITING</span></div>
              <div class="radar-wrap"><canvas id="radar" width="400" height="400" aria-label="Collision map. Click verified walkable ground to walk once; keyboard coordinates are below."></canvas><div class="radar-label"><span class="legend-dot you"></span>You <span class="legend-dot mob"></span>Monster <span class="legend-dot drop"></span>Loot</div></div>
              <p id="navigation-info" class="navigation-info">Enter a supported map to inspect walkability.</p>
              <div class="map-legend"><span class="terrain-key"></span>Blocked <span class="walkable-key"></span>Walkable <span class="portal-key"></span>Portal exclusion <span class="route-key"></span>Route</div>
              <form id="console-walk-form" class="console-walk"><label for="console-walk-x">X<input id="console-walk-x" type="number" min="0" max="511" step="1" value="0" required /></label><label for="console-walk-y">Y<input id="console-walk-y" type="number" min="0" max="511" step="1" value="0" required /></label><button id="console-walk" type="submit" class="secondary" disabled>Walk once</button></form>
              <p id="console-action" class="hint" role="status" aria-live="polite">Stop the bot before a manual action. Clicks never change your bot settings.</p>
              <p id="console-target-result" class="hint">No bounded command observed.</p>
            </section>
            <section class="panel console-nearby" aria-labelledby="console-nearby-title">
              <div class="panel-title"><h3 id="console-nearby-title">Nearby</h3><span id="nearby">0</span></div>
              <h4>Monsters</h4><div id="monster-list" class="monster-list">No monsters in sight.</div>
              <h4>Ground items</h4><div id="console-drops" class="console-list">No drops observed.</div>
              <button id="console-loot-settings" type="button" class="text-button">Configure bot pickup</button>
              <p class="hint">Pickups use the bot's loot policy and confirmed receipts.</p>
            </section>
            <section class="panel console-inventory" aria-labelledby="console-inventory-title">
              <div class="panel-title"><h3 id="console-inventory-title">Inventory</h3><span id="console-stock-count">Not observed</span></div>
              <label for="console-item">Observed item<select id="console-item" disabled><option value="">Choose an item</option></select></label>
              <p id="console-item-info" class="hint">Inventory appears after a verified character connects.</p>
              <button id="console-use-item" type="button" class="secondary" disabled>Use one item</button>
              <button id="console-item-tools" type="button" class="text-button">Skills, equipment & targeted items</button>
              <p id="console-item-result" class="hint" role="status" aria-live="polite">No item request sent.</p>
              <p id="console-latest-action" class="hint">No controller action receipt observed.</p>
              <div class="console-run-metrics"><div><strong id="attacks">0</strong><span>Engaged</span></div><div><strong id="kills">0</strong><span>Defeated</span></div><div><strong id="looted">0</strong><span>Pickups confirmed</span></div></div>
              <p id="session-details" class="session-details">Session time and task state appear after connection.</p>
            </section>
          </div>
          <section class="panel console-activity" aria-labelledby="client-activity-title"><div class="panel-title"><h3 id="client-activity-title">Activity</h3><span id="target-label">No active target</span></div><ol id="log" class="log"><li class="empty">Session activity will appear here.</li></ol></section>
          <div id="client-session-details" class="client-session-details"></div>
        </section>

        <section id="client-page-bot" class="client-page" role="tabpanel" aria-labelledby="client-tab-bot" hidden>
          <div class="client-page-heading"><h2 id="client-page-bot-title" tabindex="-1">Bot</h2><p>Set up combat, recovery and field routines before starting.</p></div>
          <nav class="client-bot-nav" role="tablist" aria-label="Bot sections">
            <button id="client-bot-tab-combat" type="button" role="tab" data-client-bot-nav="combat" aria-controls="client-bot-combat" aria-selected="true">Combat</button>
            <button id="client-bot-tab-recovery" type="button" role="tab" data-client-bot-nav="recovery" aria-controls="client-bot-recovery" aria-selected="false" tabindex="-1">Recovery</button>
            <button id="client-bot-tab-travel" type="button" role="tab" data-client-bot-nav="travel" aria-controls="client-bot-travel" aria-selected="false" tabindex="-1">Travel</button>
            <button id="client-bot-tab-inventory" type="button" role="tab" data-client-bot-nav="inventory" aria-controls="client-bot-inventory" aria-selected="false" tabindex="-1">Inventory & skills</button>
            <button id="client-bot-tab-workflows" type="button" role="tab" data-client-bot-nav="workflows" aria-controls="client-bot-workflows" aria-selected="false" tabindex="-1">Limits & hours</button>
          </nav>
          <section id="client-bot-combat" class="panel settings feature-panel" data-section="combat" role="tabpanel" aria-labelledby="client-bot-tab-combat">
            <div class="panel-title"><h3 id="client-bot-combat-title" tabindex="-1">Combat</h3></div>
            <fieldset class="map-targets"><legend>Target monsters</legend>
              <div id="target-map" class="target-map">Enter a map to choose monsters</div>
              <div class="target-tools"><span id="target-count">0 selected</span><div><button id="select-targets" type="button" class="text-button" disabled>Select eligible</button><button id="clear-targets" type="button" class="text-button" disabled>Clear</button></div></div>
              <div id="targets" class="target-options"><p class="target-empty">Map monsters will appear after you enter the field.</p></div>
              <p id="target-source" class="hint">Choose what to attack. Up to one level above you.</p>
            </fieldset>
            <div class="field-row"><label for="radius">Monster scan radius</label><output id="radius-value">12 cells</output></div><input id="radius" type="range" min="1" max="20" value="12" />
            <label class="toggle-row" for="loot"><div>Collect loot<small>Use Pickup scope below to choose own drops or all nearby drops</small></div><input id="loot" type="checkbox" checked role="switch" /></label>
            <p class="footnote">The bot waits through low HP, map changes and connection loss. Stop cancels the run; manual console actions require a stopped bot.</p>
          </section>
          <section id="client-bot-recovery" class="panel settings feature-panel" data-section="recovery" role="tabpanel" aria-labelledby="client-bot-tab-recovery" hidden>
            <div class="panel-title"><h3 id="client-bot-recovery-title" tabindex="-1">Recovery</h3></div>
            <div class="field-row"><label for="min-hp">Wait below HP</label><output id="hp-value">45%</output></div><input id="min-hp" type="range" min="20" max="95" value="45" />
          </section>
          <section id="client-bot-travel" class="panel settings feature-panel" data-section="travel" role="tabpanel" aria-labelledby="client-bot-tab-travel" hidden>
            <div class="panel-title"><h3 id="client-bot-travel-title" tabindex="-1">Travel</h3></div>
            <div class="routing-field"><label for="random-walk">Find monsters <code>route_randomWalk</code></label><select id="random-walk"><option value="0">Off · approach visible targets only</option><option value="2">2 · Search the current map</option></select><p class="hint">Search connected walkable ground and avoid portal areas.</p></div>
            <details class="routing-settings"><summary>OpenKore routing settings</summary>
              <div class="routing-grid">
                <label>Steps per walk <code>route_step</code><input id="route-step" type="number" min="1" max="20" value="10" /></label>
                <label>Search route seconds <code>route_randomWalk_maxRouteTime</code><input id="route-time" type="number" min="1" max="600" value="75" /></label>
                <label>Attack path cells <code>attackRouteMaxPathDistance</code><input id="attack-distance" type="number" min="1" max="200" value="20" /></label>
                <label>Approach seconds <code>attackMaxRouteTime</code><input id="attack-time" type="number" min="1" max="60" value="4" /></label>
              </div>
              <label class="toggle-row">Avoid walls <code>route_avoidWalls</code><input id="avoid-walls" type="checkbox" checked /></label>
              <p id="attack-range" class="hint">Normal attack: conservative 1 cell until equipment is verified.</p>
            </details>
          </section>
          <section id="client-bot-inventory" class="panel settings feature-panel" data-section="inventory" role="tabpanel" aria-labelledby="client-bot-tab-inventory" hidden><div class="panel-title"><h3 id="client-bot-inventory-title" tabindex="-1">Inventory & skills</h3></div></section>
          <section id="client-bot-workflows" class="panel settings feature-panel" data-section="workflows" role="tabpanel" aria-labelledby="client-bot-tab-workflows" hidden><div class="panel-title"><h3 id="client-bot-workflows-title" tabindex="-1">Limits & hours</h3></div></section>
        </section>

        <section id="client-page-manual" class="client-page" role="tabpanel" aria-labelledby="client-tab-manual" hidden>
          <div class="client-page-heading"><h2 id="client-page-manual-title" tabindex="-1">Manual tools</h2><p>Choose a tool group, review its inputs, then send an action.</p></div>
          <section id="client-manual-tools" class="panel feature-panel">
            <p class="hint">Tool groups stay mounted while you navigate. Availability follows the current session and automation state.</p>
            <nav id="client-manual-index" class="client-manual-index" aria-label="Tool groups" hidden></nav>
          </section>
        </section>

        <section id="client-page-settings" class="client-page" role="tabpanel" aria-labelledby="client-tab-settings" hidden>
          <div class="client-page-heading"><h2 id="client-page-settings-title" tabindex="-1">Settings</h2><p>Account, saved profiles and client updates.</p></div>
          <details id="signin-panel" class="signin panel" open>
            <summary>Account & character <span id="saved-account">Session only</span></summary>
            <form id="signin-form" autocomplete="off">
              <div class="signin-fields">
                <label for="username">Username<input id="username" type="text" maxlength="64" autocomplete="off" spellcheck="false" required /></label>
                <label for="password">Password<input id="password" type="password" maxlength="256" autocomplete="off" /></label>
                <label for="connection-mode">Connection<select id="connection-mode"><option value="botOnly">Bot only · no game client</option><option value="gameClient">With game client</option></select></label>
                <label for="character-slot">Character<select id="character-slot"><option value="0">Slot 1</option><option value="1">Slot 2</option><option value="2">Slot 3</option></select></label>
              </div>
              <div class="signin-options">
                <label><input id="remember-login" type="checkbox" /> Save login on this Mac</label>
                <label><input id="auto-login" type="checkbox" disabled /> Sign in when app opens</label>
                <label><input id="auto-reconnect" type="checkbox" disabled /> Reconnect after connection loss · this session</label>
                <button id="forget-login" type="button" class="text-button" hidden>Forget local saved login</button>
              </div>
              <p class="hint">Bot only uses the companion map and controls. With game client opens the official game window. Disconnect before switching modes.</p>
              <p class="hint">Saved credentials use a local file with user-only access. The app does not encrypt them.</p>
              <p id="reconnect-help" class="hint">A running bot reconnects with this session login and resumes when your character is ready.</p>
              <div class="signin-actions"><p id="login-help" class="hint">Select an existing slot. Sign-in enters the field with combat stopped.</p><button id="signin" type="submit" class="primary">Sign in & enter</button></div>
            </form>
          </details>
          <section id="client-profiles" class="panel settings feature-panel" data-section="profiles" aria-labelledby="client-profiles-title"><div class="panel-title"><h3 id="client-profiles-title">Profiles</h3></div></section>
          <section class="panel" aria-labelledby="client-updates-title"><div class="panel-title"><h3 id="client-updates-title">Client updates</h3></div><p id="update-status" class="hint">Signed updates install automatically when every game and login action is stopped.</p><a id="update-download" href="https://github.com/oDestroyeRo/openrayrag/releases/latest" target="_blank" rel="noreferrer">Download release manually</a></section>
        </section>
      </div>
      <footer><span>Session stays on this Mac</span><span>Passwords stay in memory unless you save locally</span></footer>
    </main>`;

  function required<T extends HTMLElement>(selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Client shell mount missing: ${selector}`);
    return element;
  }

  const main = required<HTMLElement>('main');
  const toolbar = required<HTMLElement>('.client-toolbar');
  const pagePanels = Object.fromEntries(pages.map(page => [page, required<HTMLElement>(`#client-page-${page}`)])) as Record<ClientPage, HTMLElement>;
  const pageButtons = Object.fromEntries(pages.map(page => [page, required<HTMLButtonElement>(`#client-tab-${page}`)])) as Record<ClientPage, HTMLButtonElement>;
  const sections = Object.fromEntries(botSections.map(section => [section, required<HTMLElement>(`#client-bot-${section}`)])) as Record<BotSection | 'profiles', HTMLElement>;
  sections.profiles = required<HTMLElement>('#client-profiles');
  const sectionButtons = Object.fromEntries(botSections.map(section => [section, required<HTMLButtonElement>(`#client-bot-tab-${section}`)])) as Record<BotSection, HTMLButtonElement>;
  const skipLink = required<HTMLAnchorElement>('.client-skip-link');
  const manualTools = required<HTMLElement>('#client-manual-tools');
  const manualIndex = required<HTMLElement>('#client-manual-index');

  function syncToolbarOffset(): void {
    main.style.setProperty('--client-toolbar-offset', `${Math.ceil(toolbar.getBoundingClientRect().height) + 16}px`);
  }

  function focusContent(target: HTMLElement): void {
    syncToolbarOffset();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  syncToolbarOffset();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(syncToolbarOffset);
    observer.observe(toolbar);
  }

  function selectPage(page: ClientPage, focus: boolean): void {
    for (const key of pages) {
      const selected = key === page;
      pagePanels[key].hidden = !selected;
      pageButtons[key].setAttribute('aria-selected', String(selected));
      pageButtons[key].tabIndex = selected ? 0 : -1;
      pageButtons[key].classList.toggle('selected', selected);
    }
    skipLink.href = `#client-page-${page}-title`;
    if (focus) focusContent(required<HTMLElement>(`#client-page-${page}-title`));
  }

  function selectBotSection(section: BotSection, focus: boolean): void {
    for (const key of botSections) {
      const selected = key === section;
      sections[key].hidden = !selected;
      sectionButtons[key].setAttribute('aria-selected', String(selected));
      sectionButtons[key].tabIndex = selected ? 0 : -1;
      sectionButtons[key].classList.toggle('selected', selected);
    }
    if (focus && !pagePanels.bot.hidden) focusContent(required<HTMLElement>(`#client-bot-${section}-title`));
  }

  function bindTabs<Key extends string>(keys: readonly Key[], buttons: Record<Key, HTMLButtonElement>, select: (key: Key, focus: boolean) => void): void {
    for (const key of keys) {
      const button = buttons[key];
      button.addEventListener('click', () => select(key, true));
      button.addEventListener('keydown', event => {
        const index = keys.indexOf(key);
        let next: Key | undefined;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = keys[(index + 1) % keys.length];
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = keys[(index + keys.length - 1) % keys.length];
        if (event.key === 'Home') next = keys[0];
        if (event.key === 'End') next = keys[keys.length - 1];
        if (!next) return;
        event.preventDefault();
        select(next, false);
        buttons[next].focus();
      });
    }
  }

  bindTabs(pages, pageButtons, selectPage);
  bindTabs(botSections, sectionButtons, selectBotSection);
  selectPage('session', false);
  selectBotSection('combat', false);

  return {
    main, sections, manualTools,
    sessionDetails: required<HTMLElement>('#client-session-details'),
    showPage: page => selectPage(page, true),
    showBotSection: section => selectBotSection(section, true),
    refreshManualIndex() {
      manualIndex.replaceChildren();
      for (const group of manualTools.querySelectorAll<HTMLElement>('details.manual-group, section.manual-refine, section.warp-panel, details.warp-panel')) {
        const expandable = group.tagName === 'DETAILS';
        const heading = group.querySelector<HTMLElement>(expandable ? 'summary' : 'h2, h3, h4');
        const title = heading?.textContent?.trim();
        if (!heading || !title) continue;
        if (!expandable) heading.tabIndex = -1;
        const button = root.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = title;
        if (group.id) button.setAttribute('aria-controls', group.id);
        button.addEventListener('click', () => {
          selectPage('manual', false);
          if (expandable) (group as HTMLDetailsElement).open = true;
          for (let parent = group.parentElement; parent && parent !== manualTools; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
          }
          focusContent(heading);
        });
        manualIndex.append(button);
      }
      manualIndex.hidden = !manualIndex.childElementCount;
    },
  };
}

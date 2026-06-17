// ============================================================
// UI — DOM chrome: title screen with splash text, loading bar,
// combat status, proximity room status, pause/options/controls
// menus and the F3 debug readout.
// ============================================================

import { BLOCKS, PALETTE } from './blocks.js';

const SPLASHES = [
  'Talk close. Fight closer.',
  'Spatially aware!',
  'Video chat with edge.',
  'Face to face duels.',
  'Walk away to leave the call.',
  'Slash fast, stab sure.',
  'Keep your camera on.',
  'Every room is a ring.',
  'Voice falls off with distance.',
  'No lobby required.',
];

const TIPS = [
  'Tip: Walk up to someone to start talking',
  'Tip: Voices get quieter with distance',
  'Tip: Left click slashes quickly',
  'Tip: Right click stabs harder',
  'Tip: Hold CTRL (or double-tap W) to sprint',
  'Tip: Text chat still works with T or ENTER',
  'Tip: Screen share still appears beside your avatar',
  'Tip: Step away when the conversation is over',
];

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.$ = (id) => document.getElementById(id);

    this.screens = {
      title: this.$('title-screen'),
      loading: this.$('loading-screen'),
      pause: this.$('pause-menu'),
      options: this.$('options-menu'),
      controls: this.$('controls-menu'),
      picker: this.$('picker'),
      hud: this.$('hud'),
    };

    this.iconUrls = new Map();
    this.controlsReturn = 'title';

    this.$('splash-text').textContent = SPLASHES[(Math.random() * SPLASHES.length) | 0];
    this.$('loading-tip').textContent = TIPS[(Math.random() * TIPS.length) | 0];

    this._wireMenus();
    this._buildHotbar();
  }

  // ----------------------------------------------------------
  // Screens
  // ----------------------------------------------------------

  show(name) {
    this.screens[name].classList.remove('hidden');
    // the self-view lives outside the HUD (it must stay clickable over
    // the pause menu) but follows its visibility
    if (name === 'hud') this.$('self-view').classList.remove('hidden');
  }

  hide(name) {
    this.screens[name].classList.add('hidden');
    if (name === 'hud') this.$('self-view').classList.add('hidden');
  }
  hideAllMenus() {
    for (const k of ['title', 'loading', 'pause', 'options', 'controls', 'picker']) this.hide(k);
  }

  _wireMenus() {
    const click = (id, fn) => this.$(id).addEventListener('click', () => { this.h.onUiClick?.(); fn(); });

    click('btn-play', () => this.h.onPlay());
    click('btn-title-controls', () => { this.controlsReturn = 'title'; this.hide('title'); this.show('controls'); });
    this.$('btn-reconnect').addEventListener('click', () => window.location.reload());
    this.$('picker-close').addEventListener('click', () => this.h.onClosePicker?.());

    click('btn-resume', () => this.h.onResume());
    click('btn-quit', () => this.h.onQuit());
    click('btn-options', () => { this.hide('pause'); this.syncOptions(); this.show('options'); });
    click('btn-controls', () => { this.controlsReturn = 'pause'; this.hide('pause'); this.show('controls'); });
    click('btn-options-done', () => { this.hide('options'); this.show('pause'); });
    click('btn-controls-done', () => { this.hide('controls'); this.show(this.controlsReturn); });

    // option sliders
    const slider = (id, valId, key, fmt = (v) => v) => {
      this.$(id).addEventListener('input', (e) => {
        const v = Number(e.target.value);
        this.$(valId).textContent = fmt(v);
        this.h.onSetting(key, v);
      });
    };
    slider('opt-render', 'val-render', 'render');
    slider('opt-fov', 'val-fov', 'fov');
    slider('opt-sens', 'val-sens', 'sens');
    slider('opt-vol', 'val-vol', 'vol');

    const toggle = (id, key, label) => {
      this.$(id).addEventListener('click', () => {
        const s = this.h.getSettings();
        const v = !s[key];
        this.h.onSetting(key, v);
        this.$(id).textContent = `${label}: ${v ? 'ON' : 'OFF'}`;
        this.h.onUiClick?.();
      });
    };
    toggle('opt-bob', 'bob', 'View Bobbing');
    toggle('opt-clouds', 'clouds', 'Clouds');
    toggle('opt-music', 'music', 'Music');
    toggle('opt-smooth', 'smooth', 'Smooth Lighting');
  }

  syncOptions() {
    const s = this.h.getSettings();
    this.$('opt-render').value = s.render; this.$('val-render').textContent = s.render;
    this.$('opt-fov').value = s.fov; this.$('val-fov').textContent = s.fov;
    this.$('opt-sens').value = s.sens; this.$('val-sens').textContent = s.sens;
    this.$('opt-vol').value = s.vol; this.$('val-vol').textContent = s.vol;
    this.$('opt-bob').textContent = `View Bobbing: ${s.bob ? 'ON' : 'OFF'}`;
    this.$('opt-clouds').textContent = `Clouds: ${s.clouds ? 'ON' : 'OFF'}`;
    this.$('opt-music').textContent = `Music: ${s.music ? 'ON' : 'OFF'}`;
    this.$('opt-smooth').textContent = `Smooth Lighting: ${s.smooth ? 'ON' : 'OFF'}`;
  }

  // ----------------------------------------------------------
  // Join screen / multiplayer status
  // ----------------------------------------------------------

  getJoinName() { return this.$('name-input').value.trim(); }
  getJoinRoom() { return this.$('room-input').value.trim(); }
  setJoinRoom(room) { this.$('room-input').value = room; }

  setJoinStatus(text, isError = false) {
    const el = this.$('join-status');
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  setCamStatus(text) {
    this.$('join-cam-status').textContent = text;
  }

  setRoomInfo(text) {
    this.$('room-info').textContent = text;
  }

  setRoomStatus(text) {
    this.$('room-status').textContent = text;
  }

  showDisconnected() {
    this.$('disconnect-modal').classList.remove('hidden');
  }

  setLoadingProgress(frac) {
    this.$('loading-fill').style.width = `${Math.round(frac * 100)}%`;
  }

  // ----------------------------------------------------------
  // Hotbar
  // ----------------------------------------------------------

  _buildHotbar() {
    const bar = this.$('hotbar');
    this.slotEls = [];
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const num = document.createElement('span');
      num.className = 'slot-num';
      num.textContent = String(i + 1);
      const img = document.createElement('img');
      img.draggable = false;
      slot.appendChild(num);
      slot.appendChild(img);
      // tappable on touch devices (the hotbar is click-through on desktop)
      slot.addEventListener('click', () => this.h.onHotbarSelect(i));
      bar.appendChild(slot);
      this.slotEls.push(slot);
    }
  }

  setIcons(iconUrls) {
    this.iconUrls = iconUrls;
    this._buildPicker();
  }

  updateHotbar(hotbar, selected) {
    hotbar.forEach((id, i) => {
      const img = this.slotEls[i].querySelector('img');
      const url = this.iconUrls.get(id);
      if (url && img.src !== url) img.src = url;
      this.slotEls[i].classList.toggle('selected', i === selected);
    });
    if (this.pickerSlotEls) {
      hotbar.forEach((id, i) => {
        const img = this.pickerSlotEls[i].querySelector('img');
        const url = this.iconUrls.get(id);
        if (url && img.src !== url) img.src = url;
      });
    }
  }

  showToast(text) {
    const el = this.$('item-name');
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1400);
  }

  updateCombatHud(state, snapshot = {}) {
    const root = this.$('combat-hud');
    if (!root || !state?.me) return;
    const me = state.me;
    const hp = Math.max(0, Math.round(me.hp ?? 0));
    const hpFrac = Math.max(0, Math.min(1, hp / 100));

    this.$('combat-health-value').textContent = String(hp);
    this.$('combat-health-fill').style.width = `${Math.round(hpFrac * 100)}%`;
    this.$('combat-health-fill').classList.toggle('critical', hp <= 34);
    this.$('combat-score').textContent = `${me.kills || 0} / ${me.deaths || 0}`;
    this.$('combat-state').textContent = me.alive === false ? 'Respawning' : 'Knife ready';

    const slash = Math.round((snapshot.slashReady ?? 1) * 100);
    const stab = Math.round((snapshot.stabReady ?? 1) * 100);
    this.$('slash-cooldown').style.width = `${slash}%`;
    this.$('stab-cooldown').style.width = `${stab}%`;
    this.$('slash-label').textContent = slash >= 100 ? 'Slash' : `Slash ${slash}%`;
    this.$('stab-label').textContent = stab >= 100 ? 'Stab' : `Stab ${stab}%`;
    this.$('hit-marker').classList.toggle('active', Boolean(snapshot.hitMarker));

    const feed = this.$('combat-feed');
    feed.innerHTML = '';
    for (const entry of state.feed.slice(0, 4)) {
      const row = document.createElement('div');
      row.className = `feed-row ${entry.type}`;
      if (entry.type === 'death') {
        row.textContent = entry.attackerId === me.id ? 'You eliminated a player' :
          entry.victimId === me.id ? 'You were eliminated' : 'Elimination nearby';
      } else if (entry.type === 'hit') {
        row.textContent = entry.attackerId === me.id ? `${entry.kind}: ${entry.damage}` :
          entry.victimId === me.id ? `Hit taken: ${entry.damage}` : 'Hit nearby';
      } else {
        row.textContent = entry.id === me.id ? 'Respawned' : 'Player respawned';
      }
      feed.appendChild(row);
    }
  }

  // ----------------------------------------------------------
  // Picker
  // ----------------------------------------------------------

  _buildPicker() {
    const grid = this.$('picker-grid');
    grid.innerHTML = '';
    for (const id of PALETTE) {
      const cell = document.createElement('div');
      cell.className = 'picker-cell';
      cell.dataset.name = BLOCKS[id].name;
      const img = document.createElement('img');
      img.draggable = false;
      const url = this.iconUrls.get(id);
      if (url) img.src = url;
      cell.appendChild(img);
      cell.addEventListener('click', () => this.h.onPickBlock(id));
      grid.appendChild(cell);
    }

    const bar = this.$('picker-hotbar');
    bar.innerHTML = '';
    this.pickerSlotEls = [];
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const num = document.createElement('span');
      num.className = 'slot-num';
      num.textContent = String(i + 1);
      const img = document.createElement('img');
      img.draggable = false;
      slot.appendChild(num);
      slot.appendChild(img);
      slot.addEventListener('click', () => this.h.onHotbarSelect(i));
      bar.appendChild(slot);
      this.pickerSlotEls.push(slot);
    }
  }

  setPickerSelected(selected) {
    this.pickerSlotEls?.forEach((el, i) => el.classList.toggle('selected', i === selected));
  }

  // ----------------------------------------------------------
  // Misc HUD
  // ----------------------------------------------------------

  setUnderwater(on) {
    this.$('underwater-overlay').style.opacity = on ? '1' : '0';
  }

  flashDamage() {
    const el = this.$('damage-vignette');
    el.style.opacity = '1';
    clearTimeout(this._dmgTimer);
    this._dmgTimer = setTimeout(() => { el.style.opacity = '0'; }, 220);
  }

  setDebug(visible, text = '') {
    const el = this.$('debug');
    el.classList.toggle('hidden', !visible);
    if (visible) el.textContent = text;
  }

  showWebglError() {
    this.$('webgl-error').classList.remove('hidden');
  }
}

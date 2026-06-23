// ============================================================
// TouchControls — mobile / tablet input for the voxel world:
// a virtual joystick (move), drag-anywhere-to-look, and round
// on-screen buttons for jump/sneak/mine/place plus menu, chat
// and the block picker. Only instantiated when the device's
// primary pointer is coarse; desktop never sees this UI.
// Mining and placing act on the crosshair in the screen center,
// like Minecraft PE's classic control scheme.
// ============================================================

export const isTouchDevice = () =>
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  ('ontouchstart' in window && navigator.maxTouchPoints > 0);

const STICK_RADIUS = 46; // px of nub travel

export class TouchControls {
  /**
   * @param {object} h handlers: onLook(dx,dy), onMenu(), onChat(), onPicker()
   */
  constructor(h) {
    this.h = h;

    // polled by the game every frame
    this.moveX = 0;       // -1..1 strafe
    this.moveY = 0;       // -1..1 forward(-) / back(+)
    this.jump = false;
    this.sneak = false;
    this.mine = false;
    this.place = false;

    this._stickId = null; // touch identifier owning the joystick
    this._lookId = null;  // touch identifier owning the camera
    this._lookX = 0;
    this._lookY = 0;

    this._build();
    this._bind();
  }

  _button(id, label, hold, onTap) {
    const b = document.createElement('div');
    b.id = id;
    b.className = 'touch-btn touch-only';
    b.textContent = label;
    document.body.appendChild(b);
    b.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (hold) this[hold] = true;
      b.classList.add('active');
      if (onTap) onTap();
    }, { passive: false });
    const release = (e) => {
      e.preventDefault();
      if (hold) this[hold] = false;
      b.classList.remove('active');
    };
    b.addEventListener('touchend', release, { passive: false });
    b.addEventListener('touchcancel', release, { passive: false });
    return b;
  }

  _build() {
    // joystick
    this.stick = document.createElement('div');
    this.stick.id = 'touch-stick';
    this.stick.className = 'touch-only';
    this.nub = document.createElement('div');
    this.nub.id = 'touch-nub';
    this.stick.appendChild(this.nub);
    document.body.appendChild(this.stick);

    // action cluster (bottom right)
    this._button('touch-jump', '⤒', 'jump');
    this._button('touch-sneak', '⤓', 'sneak');
    this._button('touch-mine', '⛏', 'mine');
    this._button('touch-place', '▣', 'place');

    // top bar (taps)
    this._button('touch-menu', '☰', null, () => this.h.onMenu?.());
    this._button('touch-chat', '💬', null, () => this.h.onChat?.());
    this._button('touch-picker', '▦', null, () => this.h.onPicker?.());
  }

  _bind() {
    // ---- joystick ----
    this.stick.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._stickId !== null) return;
      const t = e.changedTouches[0];
      this._stickId = t.identifier;
      this._stickMove(t);
    }, { passive: false });

    this.stick.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this._stickId) this._stickMove(t);
      }
    }, { passive: false });

    const stickEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._stickId) {
          this._stickId = null;
          this.moveX = 0;
          this.moveY = 0;
          this.nub.style.transform = 'translate(0px, 0px)';
        }
      }
    };
    this.stick.addEventListener('touchend', stickEnd);
    this.stick.addEventListener('touchcancel', stickEnd);

    // ---- look (drag on the game canvas; UI elements eat their own touches) ----
    const canvas = document.getElementById('game');
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this._lookId !== null) return;
      const t = e.changedTouches[0];
      this._lookId = t.identifier;
      this._lookX = t.clientX;
      this._lookY = t.clientY;
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this._lookId) continue;
        this.h.onLook?.(t.clientX - this._lookX, t.clientY - this._lookY);
        this._lookX = t.clientX;
        this._lookY = t.clientY;
      }
    }, { passive: false });

    const lookEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._lookId) this._lookId = null;
      }
    };
    canvas.addEventListener('touchend', lookEnd);
    canvas.addEventListener('touchcancel', lookEnd);
  }

  _stickMove(t) {
    const r = this.stick.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2);
    let dy = t.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    this.nub.style.transform = `translate(${dx}px, ${dy}px)`;
    this.moveX = dx / STICK_RADIUS;
    this.moveY = dy / STICK_RADIUS;
  }

  /** Joystick pushed (almost) all the way forward → sprint. */
  wantsSprint() {
    return this.moveY < -0.88;
  }
}

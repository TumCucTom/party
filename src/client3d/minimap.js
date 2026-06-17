// ============================================================
// Minimap — top-down radar in the HUD corner so you can find
// people. Arena mode draws the tactical floor plan; legacy mode
// can still sample loaded terrain. Live markers sit on top: a
// white arrow for you, a colored dot per player.
// ============================================================

import { B } from './blocks.js';
import { WORLD_H } from './worldgen.js';

const RANGE = 80;          // blocks from center to edge
const TERRAIN_REFRESH = 0.5;

// approximate top-down colors per block id (fallback shades by height)
const TOP_COLORS = {
  [B.GRASS]: [105, 168, 80],
  [B.DIRT]: [134, 96, 67],
  [B.STONE]: [127, 127, 127],
  [B.COBBLE]: [110, 110, 110],
  [B.BEDROCK]: [60, 60, 60],
  [B.SAND]: [218, 207, 160],
  [B.GRAVEL]: [136, 126, 126],
  [B.LOG]: [102, 81, 50],
  [B.PLANKS]: [157, 128, 79],
  [B.LEAVES]: [60, 120, 40],
  [B.GLASS]: [200, 220, 230],
  [B.WATER]: [52, 92, 180],
  [B.SANDSTONE]: [206, 195, 150],
  [B.SNOW_GRASS]: [235, 240, 245],
  [B.SNOW_BLOCK]: [240, 245, 250],
  [B.ICE]: [150, 190, 235],
  [B.CACTUS]: [88, 128, 64],
  [B.SPRUCE_LOG]: [70, 52, 30],
  [B.SPRUCE_LEAVES]: [42, 84, 42],
  [B.BRICKS]: [150, 84, 70],
  [B.STONEBRICK]: [122, 122, 122],
  [B.BOOKSHELF]: [157, 128, 79],
  [B.OBSIDIAN]: [24, 18, 38],
  [B.TNT]: [180, 56, 44],
  [B.PUMPKIN]: [198, 118, 36],
  [B.COAL_ORE]: [115, 115, 115],
  [B.IRON_ORE]: [135, 125, 115],
  [B.GOLD_ORE]: [140, 130, 100],
  [B.DIAMOND_ORE]: [120, 135, 135],
  [B.REDSTONE_ORE]: [130, 110, 110],
};

function hueFromId(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 8) % 360;
}

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = canvas.width;
    this.world = null;
    this.arenaPlan = null;

    // terrain layer cache
    this.terrain = document.createElement('canvas');
    this.terrain.width = this.terrain.height = this.size;
    this.tctx = this.terrain.getContext('2d');
    this.refreshT = 0;
    this._lastCx = Infinity;
    this._lastCz = Infinity;
  }

  setWorld(world) {
    this.world = world;
    this.refreshT = 0;
  }

  setArenaPlan(plan) {
    this.arenaPlan = plan;
    this.refreshT = 0;
  }

  update(dt, player, avatars) {
    if (!this.world) return;
    this.refreshT -= dt;
    const px = player.pos.x, pz = player.pos.z;
    if (this.refreshT <= 0 || Math.abs(px - this._lastCx) > 4 || Math.abs(pz - this._lastCz) > 4) {
      this.refreshT = TERRAIN_REFRESH;
      this._lastCx = px;
      this._lastCz = pz;
      if (this.arenaPlan) this.drawArenaTerrain(px, pz);
      else this.drawTerrain(px, pz);
    }
    this.draw(player, avatars);
  }

  drawArenaTerrain(px, pz) {
    const s = this.size;
    const half = s / 2;
    const g = this.tctx;
    const plan = this.arenaPlan;
    const mapX = (x) => half + ((x - px) / RANGE) * half;
    const mapZ = (z) => half + ((z - pz) / RANGE) * half;
    const rect = (x0, z0, x1, z1) => {
      const x = mapX(x0), y = mapZ(z0);
      return [x, y, mapX(x1) - x, mapZ(z1) - y];
    };

    g.clearRect(0, 0, s, s);
    g.fillStyle = '#15181a';
    g.fillRect(0, 0, s, s);

    const [fx, fz, fw, fh] = rect(plan.bounds.minX, plan.bounds.minZ, plan.bounds.maxX, plan.bounds.maxZ);
    g.fillStyle = '#596160';
    g.fillRect(fx, fz, fw, fh);

    g.strokeStyle = '#d9a441';
    g.lineWidth = 1.4;
    g.strokeRect(fx, fz, fw, fh);

    g.strokeStyle = 'rgba(217,164,65,0.55)';
    g.lineWidth = 1;
    for (const xOff of [-12, 0, 12]) {
      g.beginPath();
      g.moveTo(mapX(plan.center.x + xOff), mapZ(plan.bounds.minZ + 5));
      g.lineTo(mapX(plan.center.x + xOff), mapZ(plan.bounds.maxZ - 5));
      g.stroke();
    }

    for (const p of plan.props) {
      const [x, , z] = p.position;
      const [w, , d] = p.size;
      g.save();
      g.translate(mapX(x), mapZ(z));
      g.rotate(-(p.rotation || 0));
      g.fillStyle = p.kind === 'target' ? '#d9d1b4' : p.material === 'gunmetal_panel' ? '#24292d' : '#2f2a1f';
      g.strokeStyle = p.kind === 'barrier' ? '#d9a441' : '#101315';
      const mw = (w / RANGE) * half;
      const md = (d / RANGE) * half;
      g.fillRect(-mw / 2, -md / 2, mw, md);
      g.strokeRect(-mw / 2, -md / 2, mw, md);
      g.restore();
    }
  }

  drawTerrain(px, pz) {
    const s = this.size;
    const g = this.tctx;
    const img = g.createImageData(s, s);
    const data = img.data;
    const step = (RANGE * 2) / s;
    for (let yPix = 0; yPix < s; yPix++) {
      const wz = Math.floor(pz - RANGE + yPix * step);
      for (let xPix = 0; xPix < s; xPix++) {
        const wx = Math.floor(px - RANGE + xPix * step);
        const o = (yPix * s + xPix) * 4;
        if (!this.world.isLoaded(wx, wz)) {
          data[o] = 14; data[o + 1] = 14; data[o + 2] = 20; data[o + 3] = 255;
          continue;
        }
        const h = this.world.surfaceHeight(wx, wz);
        let id = this.world.getBlock(wx, h, wz);
        // water doesn't block skylight, so a submerged column's heightmap
        // points at the floor — the cell right above is water then
        if (h + 1 < WORLD_H && this.world.getBlock(wx, h + 1, wz) === B.WATER) id = B.WATER;
        const c = TOP_COLORS[id] || [120, 110, 100];
        const shade = 0.55 + 0.45 * Math.min(1, h / 90); // higher = brighter
        data[o] = c[0] * shade;
        data[o + 1] = c[1] * shade;
        data[o + 2] = c[2] * shade;
        data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  draw(player, avatars) {
    const s = this.size;
    const g = this.ctx;
    const half = s / 2;
    g.clearRect(0, 0, s, s);
    g.drawImage(this.terrain, 0, 0);

    // other players: colored dots (clamped to the edge when out of range)
    for (const a of avatars.map.values()) {
      const dx = a.group.position.x - player.pos.x;
      const dz = a.group.position.z - player.pos.z;
      let mx = (dx / RANGE) * half;
      let mz = (dz / RANGE) * half;
      const d = Math.hypot(mx, mz);
      const out = d > half - 7;
      if (out) { mx = (mx / d) * (half - 7); mz = (mz / d) * (half - 7); }
      const hue = hueFromId(a.id);
      g.beginPath();
      g.arc(half + mx, half + mz, out ? 3.5 : 5, 0, Math.PI * 2);
      g.fillStyle = `hsl(${hue}, 70%, 60%)`;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = '#000';
      g.stroke();
      if (!out) {
        g.font = 'bold 9px monospace';
        g.textAlign = 'center';
        g.fillStyle = '#fff';
        g.fillText((a.name || '?')[0].toUpperCase(), half + mx, half + mz + 3);
      }
    }

    // me: white arrow pointing where I look (engine yaw 0 faces -z = up)
    g.save();
    g.translate(half, half);
    g.rotate(-player.yaw);
    g.beginPath();
    g.moveTo(0, -7);
    g.lineTo(5, 6);
    g.lineTo(0, 3);
    g.lineTo(-5, 6);
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = '#000';
    g.stroke();
    g.restore();

    // north marker
    g.font = 'bold 11px monospace';
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.strokeText('N', half, 11);
    g.fillText('N', half, 11);
  }
}

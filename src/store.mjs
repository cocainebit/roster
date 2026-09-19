import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// A hire outlives the process that took it: the money was taken before the work ran, so a restart
// must not lose either the obligation or the delivered artifact. Written whole and renamed into
// place, so a crash mid-write leaves the previous state rather than half of this one.
export class HallStore {
  constructor({ path }) { this.path = path; }

  #read() {
    if (!this.path || !existsSync(this.path)) return { hires: [], listings: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      return {
        hires: Array.isArray(parsed.hires) ? parsed.hires : [],
        listings: Array.isArray(parsed.listings) ? parsed.listings : [],
      };
    } catch {
      // A corrupt file must not stop the service starting. Losing the record of a paid hire is bad;
      // refusing to boot means nobody can read any hire at all, which is worse.
      return { hires: [], listings: [] };
    }
  }

  loadAll() { return this.#read(); }

  #write(state) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...state }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  saveHires(hires) { this.#write({ ...this.#read(), hires }); }
  saveListings(listings) { this.#write({ ...this.#read(), listings }); }
}

export class NullStore {
  loadAll() { return { hires: [], listings: [] }; }
  saveHires() {}
  saveListings() {}
}

/**
 * Menu navigation (MM-1 … MM-3): every "Back" button has to leave the screen it sits on.
 *
 * The report was "Select World, then Back does nothing". `show()` recorded the screen it had just
 * shown as the return target, and `worlds` counted as a root screen — so the worlds screen's own
 * return target was the worlds screen, and Back re-opened what was already open: no visible change,
 * no error, a dead button. The rule is expressed as a pure function (`backTarget`) so it can be
 * checked without building the whole menu DOM.
 */
import { describe, expect, it } from 'vitest';
import { backTarget, type ScreenName } from '../src/ui/menus.js';

const PANELS: ScreenName[] = ['pause', 'death', 'inventory', 'chest', 'milestones'];

describe('menu back navigation (MM-1)', () => {
  it('Back from the world list returns to the main menu it was opened from', () => {
    // boot → main → "Select World" → worlds; the return target recorded on the way in is 'main'
    expect(backTarget('worlds', 'main', false)).toBe('main');
  });

  it('a screen is never its own back target', () => {
    // This is the exact old state: worlds asking for a screen that is already showing.
    expect(backTarget('worlds', 'worlds', false)).toBe('main');
    expect(backTarget('settings', 'settings', false)).toBe('main');
    expect(backTarget('help', 'help', false)).toBe('main');
  });

  it('Settings opened from the pause menu returns to the pause menu, not to the main menu', () => {
    expect(backTarget('settings', 'pause', true)).toBe('pause');
    // ...but the same screen reached from the main menu (no world loaded) returns there
    expect(backTarget('settings', 'main', false)).toBe('main');
  });

  it('Help and About return to whoever opened them', () => {
    expect(backTarget('help', 'main', false)).toBe('main');
    expect(backTarget('about', 'pause', true)).toBe('pause');
  });

  it('a quit world leaves no panel to go back to', () => {
    // "Save & quit" ends on the world list with the game detached; the in-game panels are gone, so
    // a stale return target must not try to show one.
    for (const stale of PANELS) {
      expect(backTarget('worlds', stale, false)).toBe('main');
    }
    // while a live game keeps its own panels reachable
    expect(backTarget('milestones', 'inventory', true)).toBe('inventory');
  });
});

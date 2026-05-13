/* Shared 20×20 pixel-creature engine.
   Each animation file defines PRESET = { name, category, description, frames }
   where each frame is { hold: ms, frame: 20x20 grid | null (= base) }.
   Values: 0 empty, 1 body, 2 eye. */

(function () {
  const BODY = 1, EYE = 2;

  // Base idle creature (from reference image)
  const CREATURE = [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,1,2,1,1,1,1,1,2,1,1,0,0,0,0],
    [0,0,0,1,1,1,1,2,1,1,1,1,1,2,1,1,1,1,0,0],
    [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1,0,1,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,0,0,0,1,0,0,1,0,0,0,1,0,0,1,0,0,0,0],
    [0,0,0,0,0,1,0,0,1,0,0,0,1,0,0,1,0,0,0,0],
    [0,0,0,0,0,1,0,0,1,0,0,0,1,0,0,1,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ];

  // Parse shorthand: '#' body, 'X' eye, '.' empty
  function parseFrame(rows) {
    return rows.map(row => {
      const cells = row.split('').map(ch => ch === '#' ? BODY : ch === 'X' ? EYE : 0);
      while (cells.length < 20) cells.push(0);
      return cells.slice(0, 20);
    });
  }

  // Shift base creature by (dr, dc)
  function shift(base, dr, dc) {
    const out = Array.from({length: 20}, () => new Array(20).fill(0));
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < 20 && nc >= 0 && nc < 20) {
          out[nr][nc] = base[r][c];
        }
      }
    }
    return out;
  }

  // Apply sparse patch to base → new grid
  function patch(base, ops) {
    const out = base.map(r => r.slice());
    for (const [r, c, v] of ops) {
      if (r >= 0 && r < 20 && c >= 0 && c < 20) out[r][c] = v;
    }
    return out;
  }

  // Build a renderer into a host element.
  // Returns { play, pause, setPreset, setSpeed, setColor, destroy, el }
  function mount(host, opts = {}) {
    const {
      preset,            // { name, frames }
      color = '#CD7F6A',
      bg = '#0f0f0f',
      gridLines = true,
      cellStroke = true,
      speed = 1,
      autoplay = true,
      showCoords = false,
    } = opts;

    host.innerHTML = '';
    host.style.position = 'relative';
    host.style.width = '100%';
    host.style.aspectRatio = '1 / 1';
    host.style.background = bg;
    host.style.display = 'grid';
    host.style.gridTemplateColumns = 'repeat(20, 1fr)';
    host.style.gridTemplateRows = 'repeat(20, 1fr)';
    if (gridLines) {
      host.style.backgroundImage =
        'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px),' +
        'linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)';
      host.style.backgroundSize = 'calc(100%/20) 100%, 100% calc(100%/20)';
    }

    const cellEls = [];
    for (let r = 0; r < 20; r++) {
      cellEls.push([]);
      for (let c = 0; c < 20; c++) {
        const d = document.createElement('div');
        d.style.position = 'relative';
        host.appendChild(d);
        cellEls[r].push(d);
      }
    }

    let _color = color;
    let _stroke = cellStroke;
    function paint(frame) {
      for (let r = 0; r < 20; r++) {
        for (let c = 0; c < 20; c++) {
          const v = frame[r][c];
          const el = cellEls[r][c];
          if (v === BODY) {
            el.style.background = _color;
            el.style.boxShadow = _stroke ? 'inset 0 0 0 1px rgba(0,0,0,0.35)' : 'none';
          } else if (v === EYE) {
            el.style.background = '#0f0f0f';
            el.style.boxShadow = 'none';
          } else {
            el.style.background = 'transparent';
            el.style.boxShadow = 'none';
          }
        }
      }
    }

    let _preset = preset;
    let _speed = speed;
    let _playing = autoplay;
    let frameIdx = 0;
    let startAt = performance.now();
    let raf = 0;

    function current() { return _preset.frames[frameIdx]; }
    function render() {
      const f = current();
      paint(f.frame ? f.frame : CREATURE);
    }
    function tick(now) {
      if (_playing && _preset.frames.length > 1) {
        const elapsed = (now - startAt) * _speed;
        if (elapsed >= current().hold) {
          frameIdx = (frameIdx + 1) % _preset.frames.length;
          startAt = now;
          render();
        }
      }
      raf = requestAnimationFrame(tick);
    }
    render();
    raf = requestAnimationFrame(tick);

    return {
      el: host,
      play()  { _playing = true;  startAt = performance.now(); },
      pause() { _playing = false; },
      toggle() { _playing = !_playing; startAt = performance.now(); return _playing; },
      isPlaying() { return _playing; },
      setPreset(p) { _preset = p; frameIdx = 0; startAt = performance.now(); render(); },
      setSpeed(s) { _speed = s; },
      setColor(c) { _color = c; render(); },
      setStroke(b) { _stroke = b; render(); },
      destroy() { cancelAnimationFrame(raf); host.innerHTML = ''; },
    };
  }

  // Wrap mount to also listen for parent speed messages, so any
  // preview embedded in the library auto-syncs to the slider.
  const originalMount = mount;
  function mountWithSync(host, opts) {
    const api = originalMount(host, opts);
    window.__api = api;
    window.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d && d.type === '__set_speed' && typeof d.speed === 'number') {
        api.setSpeed(d.speed);
      }
    });
    return api;
  }

  window.PixelEngine = {
    BODY, EYE, CREATURE, parseFrame, shift, patch,
    mount: mountWithSync,
  };
})();

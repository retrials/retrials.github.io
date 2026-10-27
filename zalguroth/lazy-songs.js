/* HTTP song assets are fetched outside native call stacks: no Asyncify or
 * blocking XHR. Native selection polls request(), which never blocks a frame. */
(function () {
  'use strict';
  function key(value) {
    const parts = [];
    const path = String(value).replace(/\\/g, '/').replace(/^\/?game\//, '');
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return '/' + parts.join('/').toLowerCase();
  }
  window.OpenITGCreateSongLoader = function (manifest) {
    if (!manifest || manifest.version !== 2 || !manifest.songs) throw new Error('Expected v6 preview catalogue (manifest version 2). Repackage your assets.');
    const songs = new Map();
    const files = new Map();
    for (const [directory, record] of Object.entries(manifest.songs)) {
      if (!directory.startsWith('/Songs/') || directory.split('/').includes('..') || !Array.isArray(record.files)) {
        throw new Error('Invalid song directory in manifest.');
      }
      if (songs.has(key(directory))) throw new Error('Case-insensitive duplicate song directory.');
      for (const entry of record.files) {
        if (!entry.path.startsWith(directory) || entry.path.split('/').includes('..') ||
            !/^song-assets\/blobs\/[a-f0-9]{64}$/.test(entry.url) ||
            !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new Error('Invalid song asset in manifest.');
        }
        if (files.has(key(entry.path))) throw new Error('Case-insensitive duplicate asset path.');
        files.set(key(entry.path), entry);
      }
      for (const entry of record.menuFiles || []) {
        if (!entry.path.startsWith(directory) || entry.path.split('/').includes('..') || files.has(key(entry.path))) throw new Error('Invalid/duplicate menu asset.');
        files.set(key(entry.path), entry);
      }
      songs.set(key(directory), { ...record, directory, hydrated: false, state: 'idle' });
    }
    let FS = null;
    let active = null;
    let controller = null;
    let timer = null;
    let generation = 0;
    let currentNotice = '';
    let phase = 'menu catalogue ready';
    function notice(message, error = false) {
      if (message === currentNotice) return;
      currentNotice = message;
      window.dispatchEvent(new CustomEvent('openitg-song-download', { detail: { message, error } }));
    }
    function cancel() {
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      if (controller) controller.abort();
      controller = null;
      if (active && active.state === 'loading') active.state = 'idle';
    }
    async function load(record, token) {
      if (!FS) throw new Error('Song filesystem is not ready.');
      const abort = new AbortController();
      controller = abort;
      const downloaded = new Array(record.files.length);
      let cursor = 0, completed = 0;
      async function worker() {
        while (cursor < record.files.length) {
          const index = cursor++;
          const entry = record.files[index];
          const response = await fetch(entry.url, { signal: abort.signal });
          if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength !== entry.size) throw new Error(`Incomplete download: ${entry.path}`);
          const digest = await crypto.subtle.digest('SHA-256', buffer);
          const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
          if (hex !== entry.sha256) throw new Error(`Download checksum mismatch: ${entry.path}`);
          if (token !== generation) return;
          downloaded[index] = new Uint8Array(buffer);
          notice(`Loading selected song: ${++completed}/${record.files.length} files…`);
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(3, record.files.length) }, worker));
        if (token !== generation) return;
        // Commit in one JS task, then mark ready. Native code never sees a song
        // as playable while any of its files are still awaiting a response.
        record.files.forEach((entry, index) => {
          const path = '/game' + entry.path;
          FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
          FS.writeFile(path, downloaded[index]);
        });
        record.state = 'ready';
        phase = 'full files verified; awaiting native chart hydration';
        controller = null;
        notice('');
      } catch (error) {
        abort.abort();
        if (token !== generation) return;
        record.state = 'error';
        phase = 'download failed: ' + error.message;
        controller = null;
        notice('Song download failed: ' + error.message + ' — choose Retry or select another song.', true);
      }
    }
    const api = {
      enabled: songs.size > 0,
      bindFS(fs) { FS = fs; },
      managed(directory) { return songs.has(key(directory)); },
      ready(directory) { const record = songs.get(key(directory)); return !record || (record.state === 'ready' && record.hydrated); },
      song(directory) { return songs.get(key(directory)); },
      file(path) { return files.get(key(path)); },
      request(directory) {
        const record = songs.get(key(directory));
        if (record !== active) {
          cancel();
          active = record || null;
          if (!record || record.state === 'ready') notice('');
        }
        if (!record || record.state === 'ready') return 1;
        if (record.state === 'error') return -1;
        if (record.state === 'idle') {
          record.state = 'loading';
          const token = generation;
          phase = 'confirmed: downloading ' + record.directory;
          notice('Downloading full song…');
          // Only native MenuStart calls request(): highlighting never does.
          timer = setTimeout(() => {
            timer = null;
            load(record, token).catch(error => {
              if (token === generation) { record.state = 'error'; phase = 'download failed: ' + error.message; notice(error.message, true); }
            });
          }, 0);
        }
        return 0;
      },
      verify(directory) {
        const record = songs.get(key(directory));
        if (!record) return true;
        if (record.state !== 'ready' || !FS) return false;
        try {
          return record.files.every(entry => FS.stat('/game' + entry.path).size === entry.size);
        } catch (_) { return false; }
      },
      markHydrated(directory) {
        const record = songs.get(key(directory));
        if (record && api.verify(directory)) {
          record.hydrated = true;
          phase = 'full chart hydrated in-place: ' + record.directory;
          return true;
        }
        return false;
      },
      setError(directory, message) {
        const record = songs.get(key(directory));
        if (record) { record.state = 'error'; record.hydrated = false; }
        phase = 'native preparation failed: ' + message;
        notice(message + ' — Retry or choose another song.', true);
      },
      diagnostics() {
        return { phase, active: active && active.directory,
          songs: [...songs.values()].filter(s => s.state !== 'idle').map(s => ({ directory: s.directory,
            state: s.state, hydrated: s.hydrated, files: s.files.map(f => {
              let actualSize = null;
              try { actualSize = FS.stat('/game' + f.path).size; } catch (_) {}
              return { path: f.path, expectedSize: f.size, actualSize };
            }) })) };
      },
      retry() {
        if (active && active.state === 'error') {
          active.state = 'idle';
          const directory = [...songs.entries()].find(([, record]) => record === active)[0];
          return api.request(directory);
        }
      }
    };
    return api;
  };
})();

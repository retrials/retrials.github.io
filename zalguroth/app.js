(() => {
  'use strict';

  const canvas = document.getElementById('canvas');
  const launchButton = document.getElementById('launch-button');
  const logElement = document.getElementById('engine-log');
  const logLines = [];
  let launching = false;
  let lastDependencyCount = -1;
  let preparedModule = null;
  let started = false;
  let failed = false;

  function appendLog(text) {
    String(text).split('\n').forEach((line) => {
      if (line.trim()) logLines.push(line);
    });
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
    logElement.textContent = logLines.join('\n');
    logElement.scrollTop = logElement.scrollHeight;
  }

  window.OpenITGDiagnosticReport = function () {
    const report = { time: new Date().toISOString(), browser: navigator.userAgent,
      recentOutput: logLines.slice(),
      songLoader: window.OpenITGSongs ? window.OpenITGSongs.diagnostics() : null,
      controls: window.OpenITGControls ? window.OpenITGControls.diagnostics() : null,
      localLibrary: window.OpenITGUploads ? window.OpenITGUploads.diagnostics() : null,
      nativeLogs: [] };
    const fs = window.OpenITGFS;
    if (fs) {
      for (const path of ['/persistent/log.txt', '/persistent/info.txt', '/persistent/Data/log.txt',
                          '/persistent/Data/info.txt', '/game/log.txt', '/game/info.txt', '/game/Data/log.txt', '/game/Data/info.txt', '/log.txt', '/info.txt']) {
        try {
          const bytes = fs.readFile(path);
          report.nativeLogs.push({ path, text: new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 24000))) });
        } catch (_) {}
      }
    }
    return report;
  };

  function focusGame() {
    canvas.focus({ preventScroll: true });
  }

  function fatal(message) {
    if (window.OpenITGControls) window.OpenITGControls.stop();
    failed = true;
    launching = false;
    launchButton.hidden = false;
    launchButton.disabled = true;
    launchButton.textContent = 'Engine unavailable';
    logElement.hidden = false;
    appendLog('FATAL: ' + message);
    if (window.OpenITGDiagnosticReport) {
      const report = window.OpenITGDiagnosticReport();
      console.error('OpenITG diagnostic report:', report);
      if (report.nativeLogs.length) appendLog(report.nativeLogs.map(log => log.path + '\n' + log.text).join('\n'));
    }
  }

  function checkCompatibility() {
    if (!window.WebAssembly) {
      fatal('This browser does not support WebAssembly. Use a current browser with WebAssembly and WebGL.');
      return false;
    }
    return true;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not download ' + src));
      document.head.appendChild(script);
    });
  }

  async function downloadFile(name) {
    const response = await fetch(name);
    if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    if (!data.byteLength) throw new Error(`${name} is empty.`);
    appendLog(`Downloaded ${name} (${(data.byteLength / 1048576).toFixed(1)} MiB).`);
    return data;
  }

  async function prepare() {
    if (!checkCompatibility()) return;
    if (document.getElementById('settings-panel') && (!window.OpenITGInputCore || !window.OpenITGUploads || !window.OpenITGControls || !window.fflate)) {
      fatal('Missing v7 browser support files. Upload controls-core.js, uploads.js, settings.js and vendor/fflate.js with index.html.');
      return;
    }
    launching = true;
    launchButton.disabled = true;
    launchButton.hidden = false;
    launchButton.textContent = 'Downloading game data…';
    logElement.hidden = false;
    appendLog('Downloading the base/menu package and WebAssembly before initializing the engine…');

    try {
      // Do not instantiate the engine until BOTH downloads have completed.
      // Supplying these buffers also prevents Emscripten downloading them again.
      const [dataPackage, wasmBinary, songManifest] = await Promise.all([
        downloadFile('openitg.data'),
        downloadFile('openitg.wasm'),
        fetch('song-assets/manifest.json').then(response => {
          if (!response.ok) throw new Error(`song-assets/manifest.json: HTTP ${response.status}. Repackage and upload song-assets/.`);
          return response.json();
        }),
        Promise.all([loadScript('openitg.js'), loadScript('lazy-songs.js')])
      ]);
      if (failed) return;
      if (typeof OpenITGModule !== 'function') {
        throw new Error('openitg.js did not expose the OpenITGModule factory.');
      }
      window.OpenITGSongs = window.OpenITGCreateSongLoader(songManifest);
      launchButton.textContent = 'Preparing downloaded files…';
      let packageBuffer = dataPackage;
      const module = await OpenITGModule({
        canvas,
        noInitialRun: true,
        keyboardListeningElement: canvas,
        wasmBinary,
        getPreloadedPackage(_name, expectedSize) {
          if (!packageBuffer) throw new Error('The game data package was already consumed.');
          if (expectedSize && packageBuffer.byteLength !== expectedSize) {
            throw new Error('Game data size mismatch. Upload matching openitg.js, openitg.wasm and openitg.data files.');
          }
          const result = packageBuffer;
          packageBuffer = null;
          return result;
        },
        print: appendLog,
        printErr: appendLog,
        setStatus(text) {
          if (text) appendLog(text);
        },
        monitorRunDependencies(left) {
          if (left !== lastDependencyCount) {
            lastDependencyCount = left;
            appendLog(left > 0
              ? `Preparing engine data (${left} operations remaining)…`
              : 'Current preparation dependencies complete; waiting for runtime readiness…');
          }
        },
        onRuntimeInitialized() {
          appendLog('Runtime initialized. Native main() has NOT been started.');
        },
        onAbort(reason) {
          fatal('The native engine aborted: ' + String(reason || 'unknown error'));
        },
        onExit(code) {
          appendLog('OpenITG exited with code ' + code + '. Reload to restart.');
        }
      });
      if (failed) return;
      if (typeof module.callMain !== 'function') {
        throw new Error('This engine build does not export callMain. Rebuild with the updated Makefile.');
      }
      // The modularized factory resolves after preRun dependencies, including
      // package extraction and IndexedDB restoration. A transient dependency
      // count of zero alone is NOT a readiness signal.
      window.OpenITGSongs.bindFS(window.OpenITGFS);
      preparedModule = module;
      window.OpenITGModuleInstance = module;
      launching = false;
      launchButton.textContent = 'Start OpenITG';
      launchButton.disabled = false;
      appendLog('Base/menu data is ready. Click Start OpenITG to play; hosted full songs load on confirmation.');
    } catch (error) {
      fatal(error && error.message ? error.message : String(error));
    }
  }

  function launch() {
    if (!preparedModule || started || failed) return;
    if (window.OpenITGUploads && window.OpenITGUploads.busy) { appendLog('Wait for the local song import to finish, then click Start.'); return; }
    started = true;
    launching = true;
    launchButton.disabled = true;
    launchButton.hidden = true;
    appendLog('Starting native main() with the downloaded game data…');
    focusGame();
    try {
      // Remain inside the user gesture for SDL/Web Audio startup.
      if (window.OpenITGControls) window.OpenITGControls.starting();
      preparedModule.callMain([]);
    } catch (error) {
      fatal(error && error.message ? error.message : String(error));
    }
  }

  window.addEventListener('openitg-native-fatal', (event) => fatal(event.detail.message));

  // Failures after native main() has returned are outside launch()'s catch.
  // Surface them instead of leaving a frozen canvas with the log hidden.
  window.addEventListener('error', (event) => {
    if (launching || window.OpenITGModuleInstance) {
      fatal((event.error && event.error.stack) || event.message || 'An asynchronous engine error occurred.');
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (launching || window.OpenITGModuleInstance) {
      const reason = event.reason;
      fatal(reason && (reason.stack || reason.message) ? (reason.stack || reason.message) : String(reason));
    }
  });
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    fatal('WebGL context lost. Reload the page to restart the engine.');
  });

  const downloadNotice = document.createElement('div');
  downloadNotice.id = 'song-download-notice';
  downloadNotice.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100;background:#151b29;color:white;padding:14px 20px;border:1px solid #64748b;border-radius:8px;font:14px sans-serif;max-width:85vw';
  downloadNotice.hidden = true;
  const downloadText = document.createElement('span');
  const retryDownload = document.createElement('button');
  retryDownload.textContent = 'Retry';
  retryDownload.style.marginLeft = '12px';
  retryDownload.addEventListener('click', () => {
    if (window.OpenITGSongs) window.OpenITGSongs.retry();
    focusGame();
  });
  downloadNotice.appendChild(downloadText);
  downloadNotice.appendChild(retryDownload);
  document.body.appendChild(downloadNotice);
  window.addEventListener('openitg-song-download', (event) => {
    downloadText.textContent = event.detail.message;
    retryDownload.hidden = !event.detail.error;
    downloadNotice.hidden = !event.detail.message;
    if (event.detail.error) appendLog(event.detail.message);
  });

  const diagnosticsButton = document.createElement('button');
  diagnosticsButton.id = 'diagnostics-button';
  diagnosticsButton.textContent = 'Download diagnostics';
  diagnosticsButton.style.cssText = 'position:fixed;right:12px;top:12px;z-index:110;font:12px sans-serif';
  diagnosticsButton.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(window.OpenITGDiagnosticReport(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'openitg-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const diagnosticsSlot = document.getElementById('diagnostics-slot');
  if (diagnosticsSlot) { diagnosticsButton.style.cssText = ''; diagnosticsSlot.appendChild(diagnosticsButton); }
  else document.body.appendChild(diagnosticsButton);

  launchButton.addEventListener('click', launch);
  canvas.addEventListener('click', focusGame);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  document.addEventListener('keydown', (event) => {
    if (document.activeElement === canvas && (event.key.startsWith('Arrow') || event.code === 'Space')) {
      event.preventDefault();
    }
  });

  window.addEventListener('openitg-game-ready', () => {
    launching = false;
    launchButton.hidden = true;
    logElement.hidden = true;
    if (!document.getElementById('settings-panel') || !document.getElementById('settings-panel').open) focusGame();
  });

  window.addEventListener('openitg-storage', (event) => {
    if (event.detail && event.detail.isError) appendLog('STORAGE: ' + event.detail.message);
  });

  prepare();
})();
